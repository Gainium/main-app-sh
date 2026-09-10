import { DCADealStatusEnum, OrderStatusType } from '../../../types'

/**
 * A base order that stopped part-filled.
 *
 * `startDeal` — the only thing that gives a deal an average price, a cost, a
 * usage figure, a take-profit and a stop-loss — is reached exclusively from
 * `processFilledOrder`, so only a base order the engine holds as `FILLED` ever
 * opens a deal. A base order left `PARTIALLY_FILLED` therefore keeps its deal
 * in `start` indefinitely, even though the venue has already executed part of
 * it and the account is holding that position untracked.
 *
 * `checkBaseOrder` is the engine's answer to "the entry did not complete in
 * time", and both of its branches act only when the order is neither `FILLED`
 * nor `PARTIALLY_FILLED`. The enter-market branch is the LAST check a deal
 * gets — it clears the reposition timer on the way in and is itself the timer
 * that fired — so a partial fill seen there ends the deal's life as a thing
 * anything will look at again. There is no periodic sweep for `start` deals;
 * the bot's restore path is the only other visitor, and it runs once per start.
 *
 * Spec `specs/038…`.
 */
export type PartialBaseEntryInputs = {
  /** Status of the deal's `dealStart` row, as the engine currently holds it. */
  orderStatus: OrderStatusType | string | null | undefined
  /** The deal's own status. */
  dealStatus: DCADealStatusEnum | string | null | undefined
  /**
   * Whether a further check is still scheduled for this deal.
   *
   * This is the whole reason the decision is not simply "is it partly filled".
   * While the enter-market check is still armed, a partial fill is allowed to
   * go on filling — cancelling it at the reposition timer's 10 s would end
   * entries that were about to complete, and would change repositioning for
   * every bot. The engine expresses "a check is still coming" as the presence
   * of timer state for the deal in this process: `dealTimersMap` holds an entry
   * from the moment `placeBaseOrder` arms anything, and holds nothing at all
   * for a deal the process has not placed a base order for — which is exactly
   * the restore path's situation after a bot start.
   */
  hasPendingCheck: boolean
}

/**
 * Whether a part-filled base order should be settled now: remainder cancelled,
 * deal opened on the quantity the venue actually executed.
 *
 * Deliberately NOT consulted:
 *
 * - the order's TYPE. A LIMIT entry stops part-filled with a live remainder on
 *   the book; a MARKET entry on a thin spot book stops part-filled with nothing
 *   resting at all. Both strand the deal identically, and the cancel handles
 *   both — a remainder that is already gone comes back through the venue's
 *   unknown-order path, which reports what really happened.
 * - how MUCH filled. Any executed quantity is a position the account holds, and
 *   the deal is the only thing that would ever close it.
 */
export function shouldSettlePartialBaseEntry(
  args: PartialBaseEntryInputs,
): boolean {
  const { orderStatus, dealStatus, hasPendingCheck } = args
  if (orderStatus !== 'PARTIALLY_FILLED') {
    return false
  }
  // Re-opening a deal that is already open, or reviving a terminal one, would
  // be far worse than the stranding this fixes.
  if (dealStatus !== DCADealStatusEnum.start) {
    return false
  }
  return !hasPendingCheck
}
