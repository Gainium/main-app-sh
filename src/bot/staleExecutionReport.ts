/**
 * A user-stream execution report that is older than the row it would overwrite.
 *
 * Spec `090`. The stream delivers one report per state change of an order, and
 * an order's state only moves forward: the venue acknowledges it (`NEW`), then
 * executes it (`PARTIALLY_FILLED`), then ends it. The delivery order is not
 * guaranteed — production has a `NEW` arriving 10 ms AFTER the
 * `PARTIALLY_FILLED` it precedes, carrying the venue's own earlier timestamp —
 * and `convertExecutionReportToOrder` merges whatever it is handed onto the row
 * it holds. The acknowledgement therefore rewound a part-filled base entry to
 * `status: 'NEW', executedQty: '0'`, which is the state every guard written for
 * a part-filled entry then read: `shouldSettlePartialBaseEntry` (specs `038` /
 * `048`) declines a `NEW` row, and `checkBaseOrder` falls through to the arm
 * that cancels the entry and places a second base order on top of a position
 * the account is already holding.
 *
 * This is the temporal half of a rule the bot already states twice:
 * `fillEvidence.ts` — what the venue did not state cannot overwrite what we
 * know — and `settledBaseEntryFill` (spec `059`) — an order's executed quantity
 * never decreases, so a report of less than we already read is an absence of
 * information, not a correction.
 *
 * Pure: no venue, no DB, no bot.
 */

/** The parts of an order row this reads. Matches `Order` structurally. */
export type DatedOrderState = {
  status?: string | null
  /** Epoch ms. `-1` on rows written from a REST response — see below. */
  updateTime?: number | null
}

/**
 * A timestamp that can actually order two reports.
 *
 * `null` for anything unusable, and `-1` is the one that matters: a row
 * written from a cancel/REST response rather than a stream event carries it,
 * and production holds such rows (specs `048` §4.1, `059`). A row that cannot
 * be dated disables the rule rather than being guessed at.
 */
const datedAt = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null

/**
 * Whether applying `report` to `held` would move the order BACKWARDS.
 *
 * Both conditions are required, and each is doing distinct work:
 *
 * 1. **The report is dated strictly earlier than the row.** Equal timestamps
 *    are not a rewind — several venues stamp every report of an order with the
 *    same order time, and those must keep landing exactly as they do today.
 * 2. **It is an acknowledgement for a row that is past being acknowledged.** A
 *    venue never un-fills an order back to `NEW`, so this shape is stale by
 *    construction and there is no legitimate reading of it.
 *
 * Deliberately NOT included: a report that merely states a smaller
 * `executedQty`. The same monotonicity argument applies to it, but so does
 * spec `088` — after a settle tops a base entry back up, the venue's own cancel
 * report legitimately states LESS than the merged row holds, and `088` routes
 * exactly that report through `fillPartiallyFilledOrder`'s post-mutex re-read.
 * Widening this predicate to quantity would take that report away from it.
 * Spec `090` §4.1.
 */
export function executionReportRewindsOrder(
  held: DatedOrderState | null | undefined,
  report: DatedOrderState | null | undefined,
): boolean {
  const heldAt = datedAt(held?.updateTime)
  const reportAt = datedAt(report?.updateTime)
  if (heldAt === null || reportAt === null || reportAt >= heldAt) {
    return false
  }
  return report?.status === 'NEW' && !!held?.status && held.status !== 'NEW'
}
