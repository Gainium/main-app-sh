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
 * The deal's own books already know the answer. `deal.size` is the volume the
 * deal entered — gross of what it has since sold, which is tracked separately
 * ({@link grossEntryVolume}) — so whatever it accounts for beyond the counted
 * safety fills IS the base order: exactly, with no reference to settings. The
 * nominal survives only for its original case: a deal that holds nothing yet
 * because its opening order has not landed.
 *
 * Pure so `baseOrderQty.spec.ts` can pin it against the real prod numbers.
 */

/** Where the resolved quantity came from. Reported so callers can log it. */
export type BaseOrderQtySource =
  /** The base order's own row — `executedQty`, else `origQty`. */
  | 'order'
  /** Derived from the deal's position: the volume the fills do not explain. */
  | 'deal'
  /**
   * The base order's row WAS found, and the deal still holds more base than it
   * and the counted fills explain — so entry rows are missing from the order
   * map and the position wins. Distinct from `deal` only so the caller's log
   * line can say which happened; the quantity is derived identically.
   */
  | 'position'
  /** The deal has traded and holds nothing unaccounted for: contributes 0. */
  | 'accounted'
  /** Nothing held and nothing filled: the settings-derived stopgap. */
  | 'nominal'

/**
 * Gross entry volume a deal is known to have taken on.
 *
 * `deal.size` is already GROSS of every partial take-profit: on B3-USDC deal
 * `6a90e161…` the base order executed 204177 and the nine safety orders 785282,
 * and `deal.size` reads 989458.9999999998 — the sum, to the unit — while the
 * 54103 the deal had already sold sits in `tpHistory` and nowhere else. That
 * holds fleet-wide: on 2026-09-08, 20 of the 21 open deals carrying a partial
 * `tpHistory` had `|deal.size|` equal to their summed entry fills exactly, and
 * `tpCoverageReconcile.trackedPosition` (spec `013`) already reads it that way.
 * So the closed quantity must NOT be added back here — `getTPOrder`'s `add`
 * term subtracts it once, downstream, and that is the only time it should be
 * counted.
 *
 * `reduceFunds` is the opposite case and is why this is not simply
 * `Math.abs(dealSize)`: an EXECUTED reduce-funds withdrawal does leave
 * `deal.size` (DOGEUSDT `size 4141` against 9073 entered and 4932 withdrawn),
 * so it has to come back to reach the entry volume. A QUEUED one has not
 * happened yet, is still in the position, and is already included — pass only
 * the executed ones.
 *
 * This used to take `getTPOrder`'s `add` and negate it, which bundled all three
 * quantities together and got two of the three wrong. Adding the take-profit
 * closes back over-stated the base order's contribution by exactly what had
 * been sold, and once spec `017` started COMPARING that against the base-order
 * row the over-statement became live for every deal with a partial take-profit:
 * `6a90e161…` rested three take-profits for 988153 against the 935356 it held,
 * and all three were cancelled. Spec `026`, issue #717.
 */
export function grossEntryVolume(
  dealSize: number,
  reduceFundsBase: number,
): number {
  return Math.abs(dealSize) + reduceFundsBase
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
  /** `|deal.size|` — the volume the deal entered, gross of what it has sold. */
  dealSize: number
  /** Result of {@link grossEntryVolume}. */
  grossEntry: number
  /** Round DOWN to the pair's base precision, so a sub-step residue reads as 0. */
  floor?: (n: number) => number
}): { qty: number; source: BaseOrderQtySource } {
  const fromDeal = floor(Math.max(0, grossEntry - filledQty))
  if (boFromOrder > 0) {
    // The row was found — but the order map is a cache, and the SAFETY-order
    // rows can be missing from it just as the base order's can (it is rebuilt
    // per worker restart, from a Redis snapshot whose staleness is documented
    // at `main.ts:4017`, or from a DB query that has repeatedly turned out to
    // exclude rows it needed). When they are, `filledQty` collapses and
    // `getTPOrder` sizes the close at the base order alone: AIXBTUSDT
    // `6a301c7ca999bdafb2ad8055` armed a 510 take-profit while both rows were
    // known, it EXPIRED, and the replacement rests at 250 — the base order, to
    // the unit — leaving 260 of the 510 with nothing covering it. 61 open deals
    // across 8 users were in that state on 2026-09-08, 92% of the position
    // uncovered on average. Issue #702, spec `017`.
    //
    // So keep asking the deal's own books, which are persisted and do not
    // depend on what this process happens to hold in RAM. Compared through
    // `floor` on both sides so the float noise `deal.size` carries from summing
    // fills (`452.20000000000005`) cannot look like a missing order.
    //
    // One-way on purpose: this can only ever RAISE the contribution to the
    // position, never lower it below the row. An over-stated close is rejected
    // by the venue and leaves the deal with NO take-profit at all — the AIOZ
    // failure this module was written for — and across 8,740 live deals holding
    // a resting take-profit `deal.size` and the entry rows agree within 0.5% on
    // 8,704, so on a complete order map this branch is inert.
    if (fromDeal > floor(boFromOrder)) {
      return { qty: fromDeal, source: 'position' }
    }
    return { qty: boFromOrder, source: 'order' }
  }
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
