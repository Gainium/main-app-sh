import type { CommonOrder, ExecutionReport, Order } from '../../types'
import { ExchangeEnum } from '../../types'

/**
 * Turning the fee a venue reported into the base/quote split a deal books.
 *
 * `deal.feePaid` and `deal.commission` have always been COMPUTED — every
 * filled order's `qty * price * storedFeeRate`, never an observation. That is
 * only ever as good as the stored rate, and a stored rate can silently stop
 * matching what the venue charges, at which point every deal that account ever
 * closed carries a cost that is simply wrong. The connectors now report the
 * fee the venue actually took; this module decides, per order, whether that
 * observation can be booked and what it means in terms of the pair.
 *
 * The rule that governs everything here:
 *
 *   **An order whose fee we cannot resolve keeps the ESTIMATE. It is never
 *   booked as zero.**
 *
 * A zero would be a claim — "this fill was free" — and a wrong one, replacing
 * a roughly-right number with a definitely-wrong one. There are three ways an
 * order fails to resolve, and all three fall back rather than zero out:
 *
 *   1. The venue reported no fee at all (paper trading before core 1.3.8, an
 *      order with no fills, Binance futures, a venue lookup that predates this
 *      change).
 *   2. The venue charged in an asset that is NEITHER side of the pair — an
 *      account paying fees in BNB, BGB or KCS. The amount is real and is kept
 *      on the order, but converting it into base or quote needs an FX rate at
 *      the fill's timestamp that we do not have here, and inventing one would
 *      be the same kind of assumption the stored rate turned out to be.
 *   3. The fee was split across several currencies (`feeBreakdown`) and not
 *      all of them are sides of the pair.
 */

export type FeeSplit = { base: number; quote: number }

/**
 * The observed fee expressed on ONE side of the pair — the side the caller's
 * existing estimate would have used.
 *
 * The grid/combo transaction path is built on an invariant the estimate
 * happens to satisfy: for a buy the fee lives in `comBase` and `comQuote` is
 * 0, for a sell the other way round. Four separate conversions downstream
 * (`comBase = comQuote / price` and friends) and several `comQuote === 0 ? …`
 * guards all read that shape. An observed fee does NOT satisfy it — Kraken
 * charges base on a sell, Coinbase charges quote on both sides — so writing
 * the venue's split in directly would leave the opposite field at 0 and let
 * the next conversion overwrite the real fee with zero.
 *
 * Converting here keeps the magnitude, which is the thing that was wrong, and
 * leaves the shape alone. Returns `null` when there is nothing to convert, so
 * the caller falls back to its estimate rather than to a zero.
 */
export function observedFeeOnSide(
  split: FeeSplit | null,
  side: 'base' | 'quote',
  price: number,
): number | null {
  if (!split || !price || !Number.isFinite(price)) {
    return null
  }
  const total =
    side === 'base'
      ? split.base + split.quote / price
      : split.quote + split.base * price
  return Number.isFinite(total) && total > 0 ? total : null
}

/** Just the fee-bearing fields, for copying between order shapes. */
export function observedFeeOf(o: Partial<CommonOrder>): {
  feePaid?: string
  feeSide?: 'base' | 'quote'
  feeAsset?: string
  feeBreakdown?: { asset: string; amount: string }[]
} {
  const out: ReturnType<typeof observedFeeOf> = {}
  if (o?.feePaid) out.feePaid = o.feePaid
  if (o?.feeSide) out.feeSide = o.feeSide
  if (o?.feeAsset) out.feeAsset = o.feeAsset
  if (o?.feeBreakdown?.length) out.feeBreakdown = o.feeBreakdown
  return out
}

/** True when the venue told us anything at all about this order's fee. */
export function hasObservedFee(o: Partial<Order>): boolean {
  return Boolean(+(o?.feePaid ?? 0) > 0 || o?.feeBreakdown?.length)
}

/**
 * The observed fee for one order, split into the pair's base and quote legs.
 *
 * Returns `null` — meaning "fall back to the estimate for this order" — rather
 * than a zeroed split, so that a caller cannot accidentally book an
 * unresolvable fee as free. `null` and `{base: 0, quote: 0}` are very
 * different statements and only the first one is honest here.
 */
export function observedFeeSplit(
  order: Partial<Order>,
  baseAsset?: string,
  quoteAsset?: string,
): FeeSplit | null {
  if (!order) {
    return null
  }
  const base = `${baseAsset ?? order.baseAsset ?? ''}`.toUpperCase()
  const quote = `${quoteAsset ?? order.quoteAsset ?? ''}`.toUpperCase()

  const legs: { asset?: string; side?: 'base' | 'quote'; amount: number }[] = []
  if (order.feeBreakdown?.length) {
    for (const leg of order.feeBreakdown) {
      legs.push({
        asset: `${leg?.asset ?? ''}`.toUpperCase(),
        amount: +leg?.amount,
      })
    }
  } else {
    const amount = +(order.feePaid ?? 0)
    if (!(amount > 0)) {
      return null
    }
    legs.push({
      amount,
      side: order.feeSide,
      asset: `${order.feeAsset ?? ''}`.toUpperCase(),
    })
  }

  const split: FeeSplit = { base: 0, quote: 0 }
  for (const leg of legs) {
    if (!Number.isFinite(leg.amount) || leg.amount <= 0) {
      continue
    }
    // A side named by the venue is the strongest answer — it needs no ticker
    // comparison and so cannot be defeated by a symbol whose assets we hold
    // under a different spelling.
    if (leg.side === 'base' || leg.side === 'quote') {
      split[leg.side] += leg.amount
      continue
    }
    if (leg.asset && leg.asset === base) {
      split.base += leg.amount
      continue
    }
    if (leg.asset && leg.asset === quote) {
      split.quote += leg.amount
      continue
    }
    // A third asset, or a ticker we cannot match against the pair. The whole
    // order falls back rather than booking a partial cost that would look like
    // a complete one.
    return null
  }
  if (split.base <= 0 && split.quote <= 0) {
    return null
  }
  return split
}

/**
 * Fold one user-stream trade's commission into an order's observed fee.
 *
 * The stream is the only fee source Binance has for an order that rests and
 * fills later, and websocket-connector has always forwarded it — `commission`
 * (`n`) and `commissionAsset` (`N`) — straight into main-app, where it was
 * discarded. It is reported PER TRADE, so a partially filled order emits
 * several reports, each carrying its own slice, and they have to be summed.
 *
 * Summing is the dangerous part, so it is made idempotent rather than merely
 * careful. Venue trade ids increase monotonically per symbol, so `feeTradeId`
 * is kept as a high-water mark and a report at or below it is ignored: a
 * duplicated or replayed event — after a stream reconnect, or a restart that
 * refills the order queue — cannot inflate the fee, while a genuinely new
 * trade always counts. A report with no trade id is ignored for the same
 * reason: without an id there is no way to tell a new trade from a repeat, and
 * over-counting a fee is worse than falling back to the estimate.
 *
 * Returns the fields to merge onto the order, or `{}` when there is nothing
 * new to add.
 */
export function accrueStreamFee(
  order: Partial<Order>,
  msg: {
    commission?: string | number
    commissionAsset?: string | null
    tradeId?: number | string
  },
): { feePaid?: string; feeAsset?: string; feeTradeId?: number } {
  const amount = Number(msg?.commission)
  if (!Number.isFinite(amount) || amount <= 0) {
    return {}
  }
  const asset = `${msg?.commissionAsset ?? ''}`.trim().toUpperCase()
  if (!asset) {
    return {}
  }
  const tradeId = Number(msg?.tradeId)
  if (!Number.isFinite(tradeId) || tradeId <= 0) {
    return {}
  }
  const seen = Number(order?.feeTradeId)
  if (Number.isFinite(seen) && tradeId <= seen) {
    return {}
  }
  // A second fee asset on the same order (a BNB balance running out mid-fill)
  // would need `feeBreakdown`, which the stream path does not build: the
  // running total and the new slice are different currencies and cannot be
  // added. Keep the accumulated total and let the order-poll path, which sees
  // the venue's own complete answer, supersede it.
  const priorAsset = `${order?.feeAsset ?? ''}`.toUpperCase()
  const prior = +(order?.feePaid ?? 0)
  if (prior > 0 && priorAsset && priorAsset !== asset) {
    return {}
  }
  return {
    feePaid: `${(prior > 0 ? prior : 0) + amount}`,
    feeAsset: asset,
    feeTradeId: tradeId,
  }
}

/**
 * The venues whose placement answer lists per-trade `fills[]` under the SAME
 * trade ids the user stream reports as `executionReport.t` — Binance spot's
 * FULL response. Only there can an answer's fills and the stream's reports be
 * recognised as the same trades.
 */
const FILL_TRADE_ID_VENUES = new Set<string>([
  ExchangeEnum.binance,
  ExchangeEnum.binanceUS,
])

/**
 * The highest venue trade id among an answer's fills, or `null` unless EVERY
 * fill names a real one (a positive integer).
 *
 * Older connectors and Binance's SOR allocations (`-1`) carry a synthetic
 * `${orderId}-${index}` or no usable id at all. Such an id says nothing about
 * where the stream's trade ids stand, so one of them anywhere in the list
 * means the fills cannot be lined up against the stream, and the caller keeps
 * its previous behaviour.
 */
export function fillsTradeIdMark(
  fills?: { tradeId?: string | number | null }[] | null,
): number | null {
  if (!fills?.length) {
    return null
  }
  let mark = 0
  for (const fill of fills) {
    const raw = fill?.tradeId
    const id =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^[1-9]\d*$/.test(raw)
          ? Number(raw)
          : NaN
    if (!Number.isSafeInteger(id) || id <= 0) {
      return null
    }
    mark = Math.max(mark, id)
  }
  return mark
}

/** The fee fields `feeAfterAnswerFills` decides, every key present. */
export type AnswerFeeFields = {
  feePaid: string | undefined
  feeAsset: string | undefined
  feeSide: 'base' | 'quote' | undefined
  feeBreakdown: { asset: string; amount: string }[] | undefined
  feePaidUsd: string | undefined
  feeTradeId: number
}

/**
 * The fee an order carries once a venue answer with per-trade fills is merged
 * over the row the engine holds, counting every trade exactly once.
 *
 * The answer's `feePaid` is the sum of its fills: the venue's own statement of
 * every trade the order had made by then. The user stream reports the same
 * trades again, one by one, and `accrueStreamFee` adds each report whose trade
 * id is above `feeTradeId`. So whichever source arrives first, the mark has to
 * cover what has been counted:
 *
 * - The held row's mark is at or below the answer's highest fill (nothing
 *   counted yet, or the stream counted some of the answer's own trades): every
 *   trade the stream counted is in the fills, since trade ids grow and the
 *   fills list all the order's trades up to the highest. The answer's total
 *   replaces the held one and the mark moves up to the highest fill, so the
 *   stream reports of those trades still to come add nothing.
 * - The held row's mark is beyond the answer's highest fill: the stream has
 *   already counted a trade the answer does not know about, and with it, the
 *   stream being delivered in order, the earlier ones. The held fee stands.
 *
 * Returns `null` — the caller keeps its previous merge exactly — for any other
 * venue, an answer without a fee, or fills without real trade ids.
 */
export function feeAfterAnswerFills(
  exchange: string | undefined,
  held: Partial<Order> | null | undefined,
  answer: Partial<CommonOrder> | null | undefined,
): AnswerFeeFields | null {
  if (!exchange || !FILL_TRADE_ID_VENUES.has(exchange)) {
    return null
  }
  if (!answer || !hasObservedFee(answer)) {
    return null
  }
  const mark = fillsTradeIdMark(answer.fills)
  if (mark === null) {
    return null
  }
  const seen = Number(held?.feeTradeId)
  const source =
    held && Number.isFinite(seen) && seen > mark && hasObservedFee(held)
      ? held
      : answer
  return {
    feePaid: source.feePaid,
    feeAsset: source.feeAsset,
    feeSide: source.feeSide,
    feeBreakdown: source.feeBreakdown,
    feePaidUsd: source.feePaidUsd,
    feeTradeId: source === held ? seen : mark,
  }
}

/**
 * The order-level fee fields every venue but Binance reports as running
 * totals on the live stream (`websocket-connector-sh` spec 003 §2.1) —
 * `feePaid`/`feeAsset`/`feeBreakdown`/`feePaidUsd`, plus `feeSide`, which
 * only paper-trading sets (paper-trading spec 003) and real venues never do.
 *
 * ASSIGNED, not accumulated, unlike Binance's per-trade `commission` that
 * `accrueStreamFee` handles instead. Absent means "not observed" — never a
 * claim the fee was zero — so a field is only copied when the message
 * actually carries it.
 */
export function streamFeeFields(msg: ExecutionReport): {
  feePaid?: string
  feeAsset?: string
  feeBreakdown?: { asset: string; amount: string }[]
  feePaidUsd?: string
  feeSide?: 'base' | 'quote'
} {
  const out: ReturnType<typeof streamFeeFields> = {}
  if ('feePaid' in msg && msg.feePaid !== undefined) {
    out.feePaid = msg.feePaid
  }
  if ('feeAsset' in msg && msg.feeAsset !== undefined) {
    out.feeAsset = msg.feeAsset
  }
  if ('feeBreakdown' in msg && msg.feeBreakdown?.length) {
    out.feeBreakdown = msg.feeBreakdown
  }
  if ('feePaidUsd' in msg && msg.feePaidUsd !== undefined) {
    out.feePaidUsd = msg.feePaidUsd
  }
  if ('feeSide' in msg && msg.feeSide !== undefined) {
    out.feeSide = msg.feeSide
  }
  return out
}
