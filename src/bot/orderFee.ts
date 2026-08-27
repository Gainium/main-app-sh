import type { CommonOrder, Order } from '../../types'

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
