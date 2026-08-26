/**
 * How much base a DCA deal's BASE order contributes to the take-profit size.
 *
 * `getTPOrder` sizes the close as `sum(entry fills) + baseOrderQty`. The base
 * order is added separately because its row is the one that most often is not
 * in the order map: a base order that partially fills and is then CANCELED is a
 * terminal row that `loadOrders` used to filter out, so after a worker restart
 * `findBaseOrderByDeal` had nothing to find.
 *
 * What it fell back to was the NOMINAL size — `baseOrderSize` converted through
 * the current price. That is a guess, and it was wrong in both directions:
 *
 *  - A Coinbase AIOZ deal's base order executed 345.3 of 1790.1 before being
 *    cancelled. The nominal re-derivation put 1788.4 back, and the deal rested a
 *    take-profit for 5147.9 (1788.4 + 3366 of safety fills) against 3711.30
 *    actually held. The venue rejected it, which leaves the deal with NO
 *    take-profit at all.
 *  - Sized before the order map was populated, the same fallback produced the
 *    nominal ALONE: 1786.1 against the same 3711.30.
 *
 * The deal's own books already know the answer. `deal.size` is the position it
 * still holds and the closed quantity is separately tracked, so whatever those
 * two account for beyond the counted safety fills IS the base order — exactly,
 * with no reference to settings. The nominal survives only for its original
 * case: a deal that holds nothing yet because its opening order has not landed.
 *
 * Pure so `baseOrderQty.spec.ts` can pin it against the real prod numbers.
 */

/** Where the resolved quantity came from. Reported so callers can log it. */
export type BaseOrderQtySource =
  /** The base order's own row — `executedQty`, else `origQty`. */
  | 'order'
  /** Derived from the deal's position: the volume the fills do not explain. */
  | 'deal'
  /** The deal has traded and holds nothing unaccounted for: contributes 0. */
  | 'accounted'
  /** Nothing held and nothing filled: the settings-derived stopgap. */
  | 'nominal'

/**
 * Gross entry volume a deal is known to have taken on.
 *
 * `deal.size` is NET of everything already closed, while the take-profit sum is
 * expressed GROSS (`add` subtracts the closed quantity again further down), so
 * the closed quantity has to be added back. `add` as `getTPOrder` builds it is
 * negative and already folds in `pendingReduceFunds`, which is QUEUED and not
 * yet executed — that part is still in the position, so it must not be counted
 * as closed.
 */
export function grossEntryVolume(
  dealSize: number,
  add: number,
  pendingReduceFundsBase: number,
): number {
  return Math.abs(dealSize) - add - pendingReduceFundsBase
}

export function resolveBaseOrderQty({
  boFromOrder,
  filledQty,
  dealSize,
  grossEntry,
  floor = (n: number) => n,
}: {
  /** `executedQty` (else `origQty`) of the base order row, or 0 if there is none. */
  boFromOrder: number
  /** Gross base already counted from this deal's entry fills, base order excluded. */
  filledQty: number
  /** `|deal.size|` — the position the deal still holds. */
  dealSize: number
  /** Result of {@link grossEntryVolume}. */
  grossEntry: number
  /** Round DOWN to the pair's base precision, so a sub-step residue reads as 0. */
  floor?: (n: number) => number
}): { qty: number; source: BaseOrderQtySource } {
  if (boFromOrder > 0) {
    return { qty: boFromOrder, source: 'order' }
  }
  const fromDeal = floor(Math.max(0, grossEntry - filledQty))
  if (fromDeal > 0) {
    return { qty: fromDeal, source: 'deal' }
  }
  if (filledQty > 0 || Math.abs(dealSize) > 0) {
    // Every unit the deal holds is already accounted for by the fills. Adding a
    // nominal base order on top would over-state the position — which is the
    // rejection above.
    return { qty: 0, source: 'accounted' }
  }
  // The caller supplies the settings-derived stopgap for this case; deriving it
  // needs a live USD rate for `usd`-sized bots, so it stays out of here and is
  // only computed when this branch is actually reached.
  return { qty: 0, source: 'nominal' }
}
