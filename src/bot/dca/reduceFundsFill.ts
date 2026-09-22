/**
 * Booking a reduce-funds fill into the deal's own books, as ONE move.
 *
 * Two fields describe the same withdrawal from opposite ends:
 *
 *  - `deal.reduceFunds` lists the executed withdrawals. It is appended the
 *    instant the reduce order's fill is handled.
 *  - `deal.size` is the live position, and is therefore NET of those
 *    withdrawals — the premise {@link grossEntryVolume} is built on, which
 *    reconstructs the deal's gross entry volume as `|size| + reduceFunds`.
 *
 * `deal.size` is refreshed from the deal's usage a moment later
 * (`updateUsage`), so between the append and that refresh the SAME quantity
 * sits in both terms and the gross entry volume reads high by exactly the
 * withdrawal. Observed live: a deal that had entered 60.3 and withdrawn 25.63
 * reported an entry volume of 85.93, one millisecond after the withdrawal's
 * fill, and went quiet once the refresh landed.
 *
 * That window is where a take-profit gets sized. Sized there, the close is
 * built for the position the deal held BEFORE the withdrawal — on a one-way
 * account, a close that would not merely close the deal but flip it.
 *
 * So the two fields move together: the withdrawal goes into `reduceFunds` and
 * out of `size` in the same step, leaving `|size| + reduceFunds` — the gross
 * entry volume — exactly as it was. The later refresh recomputes `size` from
 * usage and assigns it, so this is not a decrement that can be applied twice.
 */

export type ReduceFundsEntry = { price: number; qty: number }

/**
 * `size` with the withdrawal taken out, and `reduceFunds` with it added.
 *
 * The sign of `size` is the position's direction (negative on a short) and is
 * preserved; only its magnitude shrinks, and never past zero — a withdrawal
 * larger than the recorded position means the position was already stale, and
 * booking a negative magnitude would turn a short into a long.
 */
export function bookReduceFundsFill(
  deal: { size?: number; reduceFunds?: ReduceFundsEntry[] },
  fill: ReduceFundsEntry,
): { size: number; reduceFunds: ReduceFundsEntry[] } {
  const reduceFunds = [...(deal.reduceFunds ?? []), fill]
  const size = Number(deal.size) || 0
  const qty = Number(fill.qty) || 0
  if (!Number.isFinite(qty) || qty <= 0) {
    return { size, reduceFunds }
  }
  const sign = size < 0 ? -1 : 1
  return { size: sign * Math.max(0, Math.abs(size) - qty), reduceFunds }
}

/** `|size| + executed reduce-funds` — the invariant this module preserves. */
export const grossEntryOf = (deal: {
  size?: number
  reduceFunds?: ReduceFundsEntry[]
}): number =>
  Math.abs(Number(deal.size) || 0) +
  (deal.reduceFunds ?? []).reduce((acc, v) => acc + (Number(v.qty) || 0), 0)
