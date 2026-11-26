import type { AccountFill } from '../../../types'
import { isForcedCloseFillType } from './venueCloseEvidence'

/**
 * Spec `279`. A venue's partial liquidation of a futures position, booked
 * on the deals that held it.
 *
 * Kraken Futures liquidates a position in chunks: one venue order per chunk,
 * a few seconds apart, none carrying our client order id. When it stops before
 * the position is gone, the deals have lost part of their base while their
 * books still hold it, and every take profit, average and P&L is computed off
 * units the account no longer has. These functions decide WHAT to book; the
 * engine books it through its own reduce-funds fill path, so the quantity
 * lives in an order row that `updateDealBalances`, the averages, the take
 * profit and the close all read.
 *
 * Pure, so the rules are pinned by `partialLiquidation.spec.ts`.
 */

/** One venue liquidation order (a chunk), all its fills summed. */
export type LiquidationChunk = {
  /** The venue's order id of the chunk. */
  orderId: string
  qty: number
  /** Volume-weighted price of its fills. */
  price: number
  /** Time of its last fill. */
  time: number
}

/** Client order id prefix of a booked partial-liquidation row. */
export const LIQUIDATION_ROW_PREFIX = 'LIQ-'

export const isPartialLiquidationRow = (o: {
  clientOrderId?: string
}): boolean => `${o.clientOrderId ?? ''}`.startsWith(LIQUIDATION_ROW_PREFIX)

/**
 * The client order id (also its `reduceFundsId`, the booking's idempotency
 * key) of the row that books `chunkIds` on `dealId`. Deterministic, so the
 * same chunks reported twice — by the stream and by the fills sweep, or after
 * a restart — map to the same row, which `orders.clientOrderId` keeps unique.
 */
export const partialLiquidationRowId = (
  dealId: string,
  chunkIds: string[],
): string => {
  const first = [...chunkIds].sort()[0] ?? ''
  return `${LIQUIDATION_ROW_PREFIX}${`${dealId}`.slice(-10)}-${first
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 16)}`
}

/**
 * The venue order ids already booked by partial-liquidation rows. A row's
 * `orderId` lists the chunks it stands for, comma separated.
 */
export const bookedLiquidationChunkIds = (
  rows: { clientOrderId?: string; orderId?: string | number }[],
): Set<string> =>
  new Set(
    rows
      .filter(isPartialLiquidationRow)
      .flatMap((r) => `${r.orderId ?? ''}`.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )

/**
 * The forced-close chunks among the venue's account fills: on `symbol`, on the
 * closing side, at or after `sinceMs`, tagged as a liquidation (or bankruptcy /
 * ADL unwind) by the venue. Fills are grouped by their venue order id.
 */
export const liquidationChunksFromFills = (
  fills: AccountFill[],
  {
    symbol,
    closeSide,
    sinceMs,
  }: { symbol: string; closeSide: 'BUY' | 'SELL'; sinceMs: number },
): LiquidationChunk[] => {
  const byOrder = new Map<string, LiquidationChunk & { cost: number }>()
  for (const f of fills) {
    const qty = +f.quantity
    const price = +f.price
    if (
      f.symbol !== symbol ||
      f.side !== closeSide ||
      !(+f.timestamp >= sinceMs) ||
      !isForcedCloseFillType(f.fillType) ||
      !(qty > 0) ||
      !(price > 0)
    ) {
      continue
    }
    const id = `${f.orderId || f.fillId || ''}`
    if (!id) {
      continue
    }
    const c = byOrder.get(id) ?? {
      orderId: id,
      qty: 0,
      price: 0,
      time: 0,
      cost: 0,
    }
    c.qty += qty
    c.cost += qty * price
    c.time = Math.max(c.time, +f.timestamp)
    byOrder.set(id, c)
  }
  return [...byOrder.values()]
    .map(({ cost, ...c }) => ({ ...c, price: cost / c.qty }))
    .sort((a, b) => a.time - b.time)
}

/** An open deal of the bot on the liquidated symbol. */
export type LiquidationDeal = {
  dealId: string
  createTime: number
  /** Base the deal's books hold (positive, either direction). */
  position: number
}

export type PartialLiquidationPlan =
  | {
      kind: 'book'
      /** Base booked in total, at most the chunks' sum. */
      qty: number
      /** Volume-weighted price of the chunks. */
      price: number
      chunkIds: string[]
      time: number
      /** Newest deal first. `closes`: the deal's whole position went. */
      allocations: { dealId: string; qty: number; closes: boolean }[]
    }
  | { kind: 'skip'; reason: string }

const floorToStep = (n: number, step: number) =>
  step > 0 ? Math.floor(n / step + 1e-9) * step : n

/**
 * What to book for a partial liquidation the venue has finished.
 *
 * `held` is the position the venue still holds on the symbol for this side.
 * The booking is capped at `books − held`: the books can never be taken below
 * what the venue holds. That cap is also what makes a second report of the
 * same chunks harmless (the books already agree with the venue), and what
 * keeps a bot that shares a one-way position with another bot from booking
 * the other bot's share — its own books are then below the venue's position
 * and nothing is booked.
 *
 * Allocated newest deal first: on a one-way position the venue reduces one
 * shared position, and the most recently opened exposure is the first to go
 * — the same order a close of the shared position is attributed in. A deal
 * opened after the last chunk had nothing liquidated.
 */
export const planPartialLiquidation = ({
  chunks,
  deals,
  held,
  step,
}: {
  chunks: LiquidationChunk[]
  deals: LiquidationDeal[]
  held: number
  step: number
}): PartialLiquidationPlan => {
  const usable = chunks.filter((c) => c.qty > 0 && c.price > 0)
  if (!usable.length) {
    return { kind: 'skip', reason: 'no liquidation fills to book' }
  }
  const time = Math.max(...usable.map((c) => c.time))
  const eligible = deals
    .filter((d) => d.position > 0 && !(d.createTime > time))
    .sort((a, b) => b.createTime - a.createTime)
  const books = eligible.reduce((a, d) => a + d.position, 0)
  const liquidated = usable.reduce((a, c) => a + c.qty, 0)
  if (!(held >= 0) || !Number.isFinite(held)) {
    return { kind: 'skip', reason: 'venue position unknown' }
  }
  const qty = floorToStep(Math.min(liquidated, books - held), step)
  if (!(qty > 0)) {
    return {
      kind: 'skip',
      reason: `the deals already hold no more than the venue (${books} vs ${held})`,
    }
  }
  const price =
    usable.reduce((a, c) => a + c.qty * c.price, 0) / liquidated
  const allocations: { dealId: string; qty: number; closes: boolean }[] = []
  let left = qty
  for (const d of eligible) {
    if (!(left > 0)) {
      break
    }
    const take = Math.min(left, d.position)
    const closes = d.position - take < (step > 0 ? step / 2 : 1e-12)
    allocations.push({
      dealId: d.dealId,
      qty: closes ? d.position : floorToStep(take, step) || take,
      closes,
    })
    left -= take
  }
  return {
    kind: 'book',
    qty,
    price,
    chunkIds: usable.map((c) => c.orderId),
    time,
    allocations,
  }
}
