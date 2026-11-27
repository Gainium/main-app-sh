/**
 * Spec `267`. A spot LONG deal's close: the take profit sold part of the
 * position and the market sweep of the rest was refused by the venue for lack
 * of coins. Which of two different situations is it?
 *
 * - `locked`: the account still holds at least the remainder, but other open
 *   orders (another bot on the same pair, a manual order) have it locked. The
 *   coins are there; closing the deal now would leave them unmanaged. Keep the
 *   deal open and keep closing the rest by limit.
 * - `unsold`: the account does not hold the remainder any more (or the read
 *   failed, so that cannot be shown). Close the deal as before (spec 157 §1.5)
 *   but say how much went unsold and stamp it on the deal.
 *
 * Pure: the caller reads the venue balance (`free` + `locked` of the base
 * asset, read AFTER the take-profit fill) and passes it in.
 */
export type CloseSweepShortfall =
  | { kind: 'locked'; held: number; locked: number }
  | { kind: 'unsold'; held?: number }

export const classifyCloseSweepShortfall = (
  remainder: number,
  balance?: { free?: number; locked?: number } | null,
): CloseSweepShortfall => {
  const free = Number(balance?.free)
  const locked = Number(balance?.locked)
  if (!balance || !Number.isFinite(free) || !Number.isFinite(locked)) {
    return { kind: 'unsold' }
  }
  const held = free + locked
  if (remainder > 0 && held >= remainder) {
    return { kind: 'locked', held, locked }
  }
  return { kind: 'unsold', held }
}

const fmt = (n: number) => `${+n.toPrecision(10)}`

export const lockedRemainderMessage = (p: {
  dealId: string
  symbol: string
  baseAsset: string
  sold: number
  remainder: number
  locked: number
}) =>
  `Deal ${p.dealId} (${p.symbol}): the take profit sold ${fmt(p.sold)} ${
    p.baseAsset
  }, but the remaining ${fmt(p.remainder)} ${
    p.baseAsset
  } could not be sold because ${fmt(p.locked)} ${
    p.baseAsset
  } of this account is held by other open orders on the exchange. The deal stays open and keeps closing the rest by limit.`

export const unsoldRemainderMessage = (p: {
  dealId: string
  symbol: string
  baseAsset: string
  sold: number
  unsold: number
}) =>
  `Deal ${p.dealId} (${p.symbol}) closed short: the take profit sold ${fmt(
    p.sold,
  )} of ${fmt(p.sold + p.unsold)} ${p.baseAsset}, ${fmt(p.unsold)} ${
    p.baseAsset
  } unsold. The exchange refused the sale of the rest for insufficient balance; those coins are not in this deal's profit as quote and no bot manages them.`

/**
 * Spec `293`. A close the venue refused for part of the position can leave a
 * deal open with a FILLED take-profit (spec 157 limit-only, spec 211, spec 267
 * `locked`): that fill is booked as a partial take profit in `tpHistory`, and
 * the rest is closed by limit. On a restart, `restoreWork` used to read any
 * FILLED take-profit as "the deal is done" and close it again, which re-ran the
 * refused sweep and closed the deal short.
 *
 * True only when every FILLED take-profit is already booked in `tpHistory` for
 * at least its executed quantity AND the deal still holds more than the venue
 * minimum after those fills. A take-profit that sold the whole position is
 * never written to `tpHistory` before the close, so it is never skipped here.
 * A lost or unreadable ledger returns false (close as before).
 */
export const filledTpAlreadyBookedAsPartial = (p: {
  filledTps: { clientOrderId: string; executedQty: string | number }[]
  tpHistory?: { id?: string | null; qty: number }[] | null
  isLong: boolean
  ledger?: { base?: number; quote?: number } | null
  initialBase: number
  queuedBase: number
  minAmount: number
}): boolean => {
  const history = p.tpHistory ?? []
  if (!p.filledTps.length) return false
  const booked = p.filledTps.every((tp) => {
    const h = history.find((e) => e.id === tp.clientOrderId)
    return !!h && +h.qty >= +tp.executedQty
  })
  if (!booked) return false
  const base = Number(p.ledger?.base)
  const quote = Number(p.ledger?.quote)
  if (!Number.isFinite(base) || !Number.isFinite(quote)) return false
  if (base === 0 && quote === 0) return false
  const sold = history.reduce((acc, e) => acc + (+e.qty || 0), 0)
  const remaining = p.isLong
    ? base + p.queuedBase - sold
    : p.initialBase - (base + p.queuedBase + sold)
  return Number.isFinite(remaining) && remaining > p.minAmount
}

/**
 * Spec `293`. What the quote-profit formula of a spot LONG close wrongly books
 * for `unsoldBase` coins the venue refused to sell: it values the deal's base
 * delta at the close price, i.e. as if those coins sold there. They did not —
 * they stay in the account at the deal's average cost. Taking out
 * `unsold × (price − avgPrice)` leaves the profit the sold coins realised.
 * Capped at the base delta the formula actually counted.
 */
export const unsoldBaseProfit = (
  unsoldBase: number | undefined,
  baseDelta: number,
  price: number,
  avgPrice: number,
): number => {
  if (unsoldBase === undefined) return 0
  const q = Math.min(+unsoldBase, +baseDelta)
  const v = q * (+price - +avgPrice)
  return q > 0 && Number.isFinite(v) ? v : 0
}
