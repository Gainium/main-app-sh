import type { AccountFill } from '../../../types'

/**
 * What the venue's own account history says closed a deal's position, when the
 * bot did not close it.
 *
 * Two ways a futures position disappears under a deal: the venue liquidates
 * it (or force-closes it by auto-deleveraging), or the user closes it by hand
 * on the exchange. Neither is an order the bot placed. Until now a deal in that
 * state was either left open (spec `143`: "close this deal manually") or booked
 * closed with only the profit it had already realised. A liquidated deal then
 * booked roughly zero instead of its loss, and the bot's accumulated profit,
 * which the "stop after X profit or loss" condition reads, was overstated by
 * the whole liquidation.
 *
 * The venue's account fills (`getAccountFills`, newest first) record the closing
 * executions. These functions pick the ones that closed this deal and price
 * the close from them. Pure, so the selection rule is pinned by its spec.
 */

/**
 * A forced close: liquidation in any spelling, or a bankruptcy/ADL unwind.
 * Bitget's `tradeSide` spells a liquidation `burst_close_long`,
 * `burst_sell_single` and the like, and an auto-deleverage `…_adl_close_…`.
 */
export const isForcedCloseFillType = (fillType?: string): boolean => {
  const t = `${fillType ?? ''}`.toLowerCase()
  return (
    t.includes('liquidation') ||
    t === 'unwindbankrupt' ||
    t === 'unwindcounterparty' ||
    t.startsWith('burst_') ||
    t.includes('_adl_')
  )
}

/**
 * A fill the bot did not place: no client order id (the venue's own orders and
 * hand trades carry none; every order the bot sends carries one), unless the
 * venue says it came in over the API — Bitget fills carry no client order id
 * at all, and there `source: 'API'` is a bot's order (or another tool's, which
 * the bot cannot price either).
 */
const notPlacedByBot = (f: AccountFill): boolean =>
  !`${f.clientOrderId ?? ''}` && `${f.source ?? ''}`.toUpperCase() !== 'API'

export type VenueCloseEvidence = {
  /** Volume-weighted price of the closing fills. */
  price: number
  /** Base quantity those fills closed. */
  qty: number
  /** True when any of them was a venue liquidation / forced close. */
  liquidation: boolean
  fills: number
  /**
   * Quote fee of the closing fills, for the part of them counted, when the
   * venue reported one on every fill used; `undefined` otherwise.
   */
  fee?: number
}

/**
 * The fills that closed a deal's position, priced.
 *
 * Counted: fills on the deal's symbol, on its closing side, at or after the
 * deal opened, that the bot did not place — a forced-close `fillType`, or no
 * client order id at all (the venue's own orders and hand trades carry none;
 * every order the bot sends carries one). Walked newest first and stopped once
 * they cover the deal's size, so an older unrelated trade is not averaged in.
 *
 * Returns `undefined` unless the fills cover at least 99% of `dealQty`: a
 * partial picture would price the whole deal off a fraction of its close, and
 * the caller must then fall back to what it did before rather than book a
 * made-up figure.
 */
export const venueCloseEvidence = (
  fills: AccountFill[],
  {
    symbol,
    closeSide,
    sinceMs,
    dealQty,
  }: {
    symbol: string
    closeSide: 'BUY' | 'SELL'
    sinceMs: number
    dealQty: number
  },
): VenueCloseEvidence | undefined => {
  if (!(dealQty > 0)) {
    return undefined
  }
  const candidates = fills
    .filter(
      (f) =>
        f.symbol === symbol &&
        f.side === closeSide &&
        +f.timestamp >= sinceMs &&
        (isForcedCloseFillType(f.fillType) || notPlacedByBot(f)) &&
        +f.quantity > 0 &&
        +f.price > 0,
    )
    .sort((a, b) => +b.timestamp - +a.timestamp)
  let qty = 0
  let cost = 0
  let liquidation = false
  let used = 0
  let fee: number | undefined = 0
  for (const f of candidates) {
    if (qty >= dealQty * 0.999) {
      break
    }
    const take = Math.min(+f.quantity, dealQty - qty)
    qty += take
    cost += take * +f.price
    liquidation = liquidation || isForcedCloseFillType(f.fillType)
    const fillFee = f.fee === undefined ? NaN : +f.fee
    fee =
      fee !== undefined && Number.isFinite(fillFee)
        ? fee + (Math.abs(fillFee) * take) / +f.quantity
        : undefined
    used++
  }
  if (qty < dealQty * 0.99) {
    return undefined
  }
  return {
    price: cost / qty,
    qty,
    liquidation,
    fills: used,
    ...(fee !== undefined ? { fee } : {}),
  }
}
