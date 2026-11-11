/**
 * Recognising a MARKET order that has in fact filled. Spec `235`.
 *
 * Pure — no I/O. `executedQty` / `origQty` arrive as STRINGS; comparing them
 * directly is lexicographic (`'99' > '310'`), so both are coerced to numbers
 * and anything non-numeric answers `false`.
 */

/** The fields of an order these predicates read. */
export type MarketFillOrder = {
  type?: string | null
  status?: string | null
  executedQty?: string | number | null
  origQty?: string | number | null
  orderId?: string | number | null
}

/**
 * A MARKET order the venue reports `PARTIALLY_FILLED` while it has executed
 * its whole requested size. A market order has no resting remainder, so once
 * nothing is left to execute it is filled, whatever the report's status word
 * says — and no further report is owed for it, so waiting for one leaves a
 * deal in `start` until something unrelated asks the venue (spec 235 §1.2).
 *
 * Callers run it on figures in the row's own unit (base). Coin-margined
 * figures are converted through a price and are approximate, so callers skip
 * those accounts.
 */
export function isFullyExecutedMarketPartial(order: MarketFillOrder): boolean {
  if (order.type !== 'MARKET' || order.status !== 'PARTIALLY_FILLED') {
    return false
  }
  const executed = Number(order.executedQty)
  const requested = Number(order.origQty)
  return (
    Number.isFinite(executed) &&
    Number.isFinite(requested) &&
    requested > 0 &&
    executed >= requested
  )
}

/** How long after a MARKET entry's placement answer its row is re-checked. */
export const marketEntryRecheckDelayMs = 45_000

/** Re-checks per entry before the reconnect/sweep paths are left to it. */
export const marketEntryRecheckMaxAttempts = 3

/**
 * Whether a Combo MARKET base entry should be re-checked on the venue: the
 * venue accepted it (it has a real exchange id), our row is still live
 * (`NEW` / `PARTIALLY_FILLED`) and its deal is still waiting in `start`.
 * Spec 235 §4.3.
 */
export function marketEntryNeedsRecheck(input: {
  order: MarketFillOrder
  dealStatus: string | undefined
}): boolean {
  const { order, dealStatus } = input
  const orderId = `${order.orderId ?? ''}`
  return (
    order.type === 'MARKET' &&
    (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') &&
    orderId !== '' &&
    orderId !== '-1' &&
    dealStatus === 'start'
  )
}
