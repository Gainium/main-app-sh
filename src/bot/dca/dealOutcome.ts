/**
 * How a deal ended, in the words the user reads.
 *
 * A deal can stop being tracked in two very different ways, and for a long time
 * both were reported with the same sentence:
 *
 *  - **Closed.** A closing order went to the venue; the position is gone and
 *    the P&L is final.
 *  - **Cancelled while still holding volume.** No closing order was ever sent.
 *    The position stays on the exchange, unmanaged, with no take profit and no
 *    stop loss. This is the ordinary outcome of stopping a bot whose
 *    `stopType` is `leave`.
 *
 * The second case was written to the event log as `Deal closed, profit: 0$`. A
 * user who read that correctly concluded the deal was finished; it was not. A
 * 125 XRP Kraken futures short abandoned that way on 2026-08-18 went unwatched
 * for three days and was liquidated by the venue on 08-21.
 *
 * These are pure so the wording is pinned by `dealOutcome.spec.ts` — the whole
 * defect was a sentence, and a sentence is exactly the kind of thing that gets
 * "tidied" back into being wrong.
 */
import { DCADealStatusEnum } from '../../../types'

export type DealOutcome = {
  _id: string
  status: DCADealStatusEnum
  size?: number
  profit: { totalUsd: number }
  symbol: { symbol: string; baseAsset: string }
}

/**
 * Volume the deal still holds on the exchange, or 0.
 *
 * The discriminator between "the deal finished" and "we walked away from an
 * open position" — deliberately keyed off what is actually left rather than off
 * the close type, so any future path that abandons a position is caught too.
 * Absent/NaN/negative all collapse to 0: only a real, positive size is a
 * position worth warning about.
 */
export const dealLeftOpenSize = (size?: number): number => {
  const abs = Math.abs(+(size ?? 0))
  return Number.isFinite(abs) && abs > 0 ? abs : 0
}

const unmanaged =
  'This bot no longer manages it - no take profit and no stop loss will be applied. Close it on the exchange if you do not want to keep it.'

/** Deal-event text: names the outcome, not the code path that produced it. */
export const dealCloseEventDescription = (deal: DealOutcome): string => {
  if (deal.status !== DCADealStatusEnum.canceled) {
    return `Deal closed, id: ${deal._id}, profit: ${deal.profit.totalUsd}$`
  }
  const left = dealLeftOpenSize(deal.size)
  if (!left) {
    return `Deal cancelled, id: ${deal._id}`
  }
  return `Deal cancelled, id: ${deal._id}, position left open on the exchange: ${left} ${deal.symbol.baseAsset}. ${unmanaged}`
}

/**
 * Bot-message text for the explicit `leave` path, which returns before the deal
 * event is written and so otherwise records nothing at all.
 *
 * Carries "was left open on the exchange", which `errorDict` maps to the
 * `Position left open` subType — keep the phrase if you reword this.
 */
export const leftOpenPositionMessage = (deal: DealOutcome): string =>
  `Deal ${deal._id} was left open on the exchange: ${dealLeftOpenSize(
    deal.size,
  )} ${deal.symbol.baseAsset} on ${deal.symbol.symbol}. ${unmanaged}`

/**
 * What to do about a close request that found no deal in the worker's map.
 *
 * The dispatch path answers the caller `ok` before the engine has looked at
 * anything, so by the time we get here the user has already been told the close
 * succeeded. Two very different situations arrive at the same branch:
 *
 *  - the deal really is finished, and this is a duplicate request — the common
 *    case, and nothing worth telling anyone about;
 *  - the database still holds the deal as live, so the request was accepted,
 *    dropped, and never actioned. That is the one the user has to hear about:
 *    they will otherwise act on a position they believe is closed.
 *
 * The live set is the COMPLEMENT of `{closed, canceled}` rather than a list of
 * live statuses on purpose — it is the same predicate the dispatcher itself uses
 * to admit the request (`status: {$nin: [closed, canceled]}`), so the two cannot
 * drift apart, and a status added later is treated as live rather than silently
 * unreportable.
 *
 * Gated on the trigger because only `manual` and `api` have a caller who was
 * answered `ok`. Every other trigger is the engine calling itself, where there
 * is nobody to inform and a report would be pure noise — one deal stuck in a
 * retry loop accounts for the overwhelming majority of these warnings.
 */
export type MissingDealCloseVerdict = 'silent' | 'report'

/** Triggers that come from a caller who was answered `ok`. */
const dispatchedTriggers: readonly string[] = ['manual', 'api']

export const verdictForMissingDealOnClose = (
  status: DCADealStatusEnum | undefined | null,
  closeTrigger?: string,
): MissingDealCloseVerdict => {
  if (!status) {
    return 'silent'
  }
  const terminal =
    status === DCADealStatusEnum.closed || status === DCADealStatusEnum.canceled
  if (terminal) {
    return 'silent'
  }
  return closeTrigger && dispatchedTriggers.includes(closeTrigger)
    ? 'report'
    : 'silent'
}

/**
 * Bot-message text for a close request the engine never actioned.
 *
 * Deliberately tells the user the deal is STILL OPEN and what to do about it:
 * the whole harm of this defect is someone treating an open position as closed.
 * Avoids the phrase "was left open on the exchange" — `errorDict` maps that to
 * the `Position left open` subType, and this is a different condition.
 */
export const unactionedCloseMessage = (
  dealId: string,
  symbol: string,
): string =>
  `Close request for deal ${dealId} on ${symbol} could not be applied - the deal is still open and the bot is no longer tracking it. Please retry closing it, and check the position on the exchange.`
