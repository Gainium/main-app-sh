import { BotStatusEnum, DCADealStatusEnum } from '../../../types'

/**
 * Putting back a take-profit that someone other than this bot cancelled.
 *
 * `processCanceledOrder` used to return on a take-profit cancel that carried no
 * fills, so a deal whose resting take-profit was cancelled on the venue — by
 * the account owner, or by the venue itself — sat with a live position and no
 * exit until the worker next restarted. The restart path (`checkOrders`) was
 * the only code that ever re-placed it. These rules let the cancel callback do
 * the same thing, without ever fighting a cancel the engine made itself.
 * Spec `095`.
 */

/** How long after the cancel report the deal is looked at again. */
export const canceledTpRestoreDelayMs = 15_000
/** Re-arms allowed while a reconcile holds the book (spec 095 §4.5). */
export const canceledTpRestoreMaxDeferrals = 20

/**
 * Does this cancel report open a restore? Only for a take-profit that went off
 * the book with NOTHING filled (a fill is the partial-take-profit path's) and
 * that this bot did not ask to cancel. Spec 095 §4.1, §4.2.
 */
export const isUnattributedUnfilledTpCancel = (input: {
  executedQty: string | number | null | undefined
  ownCancel: boolean
  dealId?: string | null
}) => {
  if (!input.dealId || input.ownCancel) {
    return false
  }
  const executed = Number(input.executedQty)
  return isFinite(executed) && executed <= 0
}

export type CanceledTpRestoreInputs = {
  /** `shouldProceed()` — false in a dry run. */
  proceed: boolean
  botStatus: BotStatusEnum | string | null | undefined
  /** `undefined` when the deal is no longer held by this worker. */
  dealStatus: DCADealStatusEnum | string | null | undefined
  /** `closeBySl || closeByTp` — a close is in flight in this worker. */
  closing: boolean
  /** `isDealForTPLevelCheck` — the deal closes by MARKET, not a resting TP. */
  marketClose: boolean
  /** `blockCheck || serviceRestart` — a reconcile owns the book right now. */
  reconcileRunning: boolean
  /** NEW / PARTIALLY_FILLED take-profits this worker holds for the deal. */
  restingTp: number
  /** Take-profits the deal's plan still wants on the book. */
  plannedTp: number
}

export type CanceledTpRestoreDecision =
  | { action: 'place' }
  | { action: 'defer'; reason: string }
  | { action: 'skip'; reason: string }

/** What the restore does once it holds the deal lock. Spec 095 §4.4, §4.5. */
export const decideCanceledTpRestore = (
  i: CanceledTpRestoreInputs,
): CanceledTpRestoreDecision => {
  if (!i.proceed) {
    return { action: 'skip', reason: 'bot may not trade' }
  }
  if (
    i.botStatus === BotStatusEnum.closed ||
    i.botStatus === BotStatusEnum.archive
  ) {
    return { action: 'skip', reason: `bot is ${i.botStatus}` }
  }
  // `open` only: a deal in `start` has no filled entry to protect, and the
  // restart path's broader "not closed or cancelled" is not needed here.
  if (i.dealStatus !== DCADealStatusEnum.open) {
    return { action: 'skip', reason: `deal is ${i.dealStatus ?? 'gone'}` }
  }
  if (i.closing) {
    return { action: 'skip', reason: 'deal is closing' }
  }
  if (i.marketClose) {
    return { action: 'skip', reason: 'deal closes by market' }
  }
  if (i.reconcileRunning) {
    return { action: 'defer', reason: 'orders check in progress' }
  }
  if (i.restingTp > 0) {
    return { action: 'skip', reason: 'a take-profit is resting' }
  }
  if (i.plannedTp <= 0) {
    return { action: 'skip', reason: 'no take-profit planned' }
  }
  return { action: 'place' }
}
