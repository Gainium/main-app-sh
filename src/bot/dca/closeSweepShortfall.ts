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
