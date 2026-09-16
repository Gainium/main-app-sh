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
 * The same stranding has a second, worse shape: the VENUE ends the order while
 * it is part filled, so the row goes straight to `CANCELED`/`EXPIRED` carrying
 * its executed quantity. `checkBaseOrder` cannot even be the one to notice,
 * because its timers are armed only for a LIMIT entry — a MARKET entry arms
 * nothing, and for it the order queue's cancel callback is the engine's whole
 * knowledge of the order.
 *
 * Specs `specs/038…` and `specs/048…`.
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
  /**
   * What the venue reports as executed on the row, as the engine holds it.
   *
   * Only consulted for a TERMINAL status — a `PARTIALLY_FILLED` row states a
   * fill by being that status, and spec 038 deliberately does not ask how much.
   */
  executedQty?: string | number | null
  /**
   * When the venue last touched the row.
   *
   * Only consulted for a TERMINAL status, and for the reason
   * `processCanceledOrder` already applies it to a cancelled take-profit: a
   * cancel row written from a REST response rather than a stream event can
   * carry a bogus `executedQty` alongside `updateTime: -1`, and production
   * holds such rows. Opening a deal on an invented fill is worse — and
   * silently so — than the stranding this settles. Spec 048 §4.1.
   */
  updateTime?: number | null
}

/** Statuses after which the venue will never move the order again. */
const terminalStatuses = new Set(['CANCELED', 'EXPIRED'])

/**
 * A terminal row that nonetheless holds a position: the venue ended the order
 * and told us, in the same message, how much of it had already executed.
 *
 * No upper bound on the quantity. The cancelled-take-profit rule declines at
 * `executedQty >= origQty` because a full execution is the `FILLED` path's to
 * close; here the equivalent guard is the deal's own status (below), and
 * refusing a fully-executed-but-only-reported-as-cancelled entry would leave
 * exactly the stranding this exists to remove. Spec 048 §4.1.
 */
function terminalEntryHoldsAFill(
  orderStatus: OrderStatusType | string | null | undefined,
  executedQty: string | number | null | undefined,
  updateTime: number | null | undefined,
): boolean {
  if (!orderStatus || !terminalStatuses.has(`${orderStatus}`)) {
    return false
  }
  const executed = +(executedQty ?? 0)
  if (!isFinite(executed) || executed <= 0) {
    return false
  }
  return typeof updateTime === 'number' && updateTime > 0
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
  const { orderStatus, dealStatus, hasPendingCheck, executedQty, updateTime } =
    args
  if (
    orderStatus !== 'PARTIALLY_FILLED' &&
    !terminalEntryHoldsAFill(orderStatus, executedQty, updateTime)
  ) {
    return false
  }
  // Re-opening a deal that is already open, or reviving a terminal one, would
  // be far worse than the stranding this fixes.
  if (dealStatus !== DCADealStatusEnum.start) {
    return false
  }
  return !hasPendingCheck
}

/** The `dealStart` rows a deal has, as the restore path reads them. */
export type RestoreBaseEntryRow = {
  status: OrderStatusType | string | null | undefined
  executedQty?: string | number | null
  updateTime?: number | null
}

/**
 * Which of a `start` deal's `dealStart` rows the restore path should act on.
 *
 * The read this replaces filtered `CANCELED` out in the query, which made a
 * base order the venue had cancelled after a partial fill invisible: the deal
 * fell through to "never started" and the entry was RE-PLACED, buying on top of
 * a position the account was already holding. Production shows that happening
 * twice on consecutive worker starts for one deal.
 *
 * Strictly additive to that behaviour — whenever the old query returned a row,
 * this returns the same one. A cancelled row is used only when nothing else is
 * there AND it carries an executed quantity; a cancelled row with no fill is
 * still ignored, so a deal whose entry was cancelled outright still re-places
 * it and no venue round trip is added for it. Spec 048 §4.2.
 */
export function pickRestoreBaseEntry<T extends RestoreBaseEntryRow>(
  rows: T[] | null | undefined,
): T | undefined {
  const notCanceled = (rows ?? []).find((r) => r.status !== 'CANCELED')
  if (notCanceled) {
    return notCanceled
  }
  return (rows ?? []).find((r) =>
    terminalEntryHoldsAFill(r.status, r.executedQty, r.updateTime),
  )
}
