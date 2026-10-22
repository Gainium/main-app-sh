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

/**
 * Whether applying `report` to `held` would make a filled order live again.
 *
 * Spec `114`. The sibling of the rule above for the one shape it leaves open by
 * design: a report carrying the SAME timestamp. Kraken delivers a
 * `PARTIALLY_FILLED` for the full quantity a millisecond after the `FILLED`,
 * both stamped with one order time. Applied, it puts the order back into the
 * live-status index; on a combo grid that is a level `isOrderExistInDeal`
 * reports as resting, so its counter order is never placed while the ladder
 * believes it was.
 *
 * No timestamp condition: a venue never un-fills an order, so the status pair
 * alone is stale by construction — and it is the write `updateOrderOnDb`
 * already refuses to make in Mongo. `CANCELED`/`EXPIRED` over `FILLED` is a
 * different question (specs `028`, `088`) and is left alone.
 */
export function executionReportUnfillsOrder(
  held: DatedOrderState | null | undefined,
  report: DatedOrderState | null | undefined,
): boolean {
  return (
    held?.status === 'FILLED' &&
    (report?.status === 'NEW' || report?.status === 'PARTIALLY_FILLED')
  )
}

/** The execution figures of an order row. Matches `Order` structurally. */
export type ExecutedOrderState = {
  executedQty?: string | null
  cummulativeQuoteQty?: string | null
  price?: string | null
  feePaid?: string | null
  feeAsset?: string | null
  feeTradeId?: number | null
  feeBreakdown?: { asset: string; amount: string }[] | null
  feePaidUsd?: string | null
}

/**
 * The held row's execution figures, when the venue's answer to a placement
 * states LESS executed than the engine already holds; `null` otherwise.
 *
 * Spec `193`. The quantity half of the rule `sendOrderToExchange` already
 * applies to status. A limit entry that trades against several resting orders
 * the moment it reaches the book is answered `PARTIALLY_FILLED` with that
 * part; when the answer is slower than the user stream, the engine already
 * holds the streamed `FILLED` row. The merge kept that status and took the
 * answer's quantities, so the engine held a `FILLED` row for the part-fill,
 * every ledger that recomputes from the order map booked the fraction, and
 * the Redis order snapshot carried it across restarts. An order's executed
 * quantity never decreases (see `settledBaseEntryFill`, spec `059`), so an
 * answer stating less than the held row is older, not a correction.
 *
 * Both rows must be in the same units — compare after the venue's figures
 * are converted. Unparseable figures on either side return `null`: the merge
 * stays as it was. Pure.
 */
export function heldExecutionAheadOfAnswer(
  held: ExecutedOrderState | null | undefined,
  answer: ExecutedOrderState | null | undefined,
): ExecutedOrderState | null {
  const heldQty = Number(held?.executedQty)
  const answerQty = Number(answer?.executedQty)
  if (
    !held ||
    !Number.isFinite(heldQty) ||
    !Number.isFinite(answerQty) ||
    heldQty <= 0 ||
    answerQty >= heldQty
  ) {
    return null
  }
  // Only what the held row states: an absent figure must not blank the
  // answer's. A fee the held row does not state is "not observed", not zero,
  // so the answer's own is kept then — at least a lower bound.
  const keys: (keyof ExecutedOrderState)[] = [
    'executedQty',
    'cummulativeQuoteQty',
    'price',
    ...(held.feePaid !== undefined && held.feePaid !== null
      ? ([
          'feePaid',
          'feeAsset',
          'feeTradeId',
          'feeBreakdown',
          'feePaidUsd',
        ] as const)
      : []),
  ]
  const kept: ExecutedOrderState = {}
  for (const key of keys) {
    if (held[key] !== undefined && held[key] !== null) {
      ;(kept as Record<string, unknown>)[key] = held[key]
    }
  }
  return kept
}
