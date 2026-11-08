import { BotType, MessageTypeEnum } from '../../types'
import { userActionRefused } from './utils'

/**
 * A bot message for the user that bypasses the error pipeline: no subType
 * classification, no re-raise backoff, no log-policy grouping and no error
 * status. One row per call, shown and emitted at once.
 *
 * Shared by `MainBot.reportUserRefusal` (the bot is loaded) and the bot worker
 * (the bot is NOT loaded, so there is no instance to report through).
 */
export interface UserNotice {
  userId: string
  /** The id the dashboard lists the message under (a hedge leg's parent). */
  botId: string
  botType: BotType
  botName?: string
  message: string
  type?: MessageTypeEnum
  symbol?: string
  exchange?: string
  paperContext?: boolean
  terminal?: boolean
  subType?: string
}

export const userNoticeRow = (n: UserNotice, time: number) => ({
  userId: n.userId,
  botId: n.botId,
  botType: n.botType,
  botName: n.botName,
  subType: n.subType ?? userActionRefused,
  type: n.type ?? MessageTypeEnum.warning,
  message: n.message,
  fullMessage: n.message,
  time,
  firstTime: time,
  symbol: n.symbol,
  exchange: n.exchange,
  showUser: true,
  isDeleted: false,
  paperContext: !!n.paperContext,
  terminal: !!n.terminal,
  created: new Date(),
  updated: new Date(),
})

/** Payload of the `bot message` emit (wire name `bot sends message`). */
export const userNoticePayload = (
  n: UserNotice,
  _id: string,
  time: number,
) => ({
  botName: n.botName,
  _id,
  type: n.type ?? MessageTypeEnum.warning,
  message: n.message,
  time,
  terminal: !!n.terminal,
  symbol: n.symbol,
  exchange: n.exchange,
  subType: n.subType ?? userActionRefused,
})

// ---------------------------------------------------------------------------
// Texts. Plain sentences the user can act on; no internal method names.
// Avoid the phrases `errorDict` keys off ("was left open on the exchange",
// "still open") so these never get re-classified as a different condition.
// ---------------------------------------------------------------------------

const detail = (err: string) => (err ? ` (${err.trim()})` : '')

export const startFailedMessage = (err: string) =>
  `The bot did not finish starting${detail(err)}. Check the bot and its deals; if it is not working, stop it and start it again.`

export const stopFailedMessage = (err: string) =>
  `The bot did not finish stopping${detail(err)}. Some deals or orders may not have been closed - check them on the exchange and stop the bot again.`

export const exchangeInfoMissingStopMessage = (pairs: string[]) =>
  `The bot was stopped: the exchange did not return trading rules for ${pairs.join(', ')}, so it cannot trade ${pairs.length > 1 ? 'these pairs' : 'this pair'}. The pair may be delisted or temporarily unavailable - start the bot again later.`

export const exchangeInfoMissingPairRemovedMessage = (pair: string) =>
  `${pair} was removed from the bot's pairs: the exchange did not return trading rules for it. The pair may be delisted or temporarily unavailable.`

export const closeRefusedForStatusMessage = (
  dealId: string,
  symbol: string,
  status: string,
) =>
  `Deal ${dealId} on ${symbol} was not closed: it is in status "${status}", which cannot be closed by a market or limit order. Use Cancel to remove the deal.`

export const botNotLoadedMessage =
  'Your last action on this bot was not applied: the bot is not loaded on the server right now. Please try again in a minute; if it keeps happening, contact support.'

export const manualNewDealMaxDealsMessage = (symbol: string) =>
  `New deal on ${symbol} was not opened: the maximum number of open deals (for the bot or for this pair) is reached.`

export const manualNewDealNotOpenedMessage = (symbol: string, why: string) =>
  `New deal on ${symbol} was not opened: ${why}.`

export const manualEntryNotAddedMessage = (symbol: string, why: string) =>
  `Entry on the ${symbol} position was not added: ${why}.`

export const stoppingNoticeMessage = (deals: number) =>
  `Stopping the bot: closing ${deals} deal${deals === 1 ? '' : 's'} first. The bot shows as closed once they are done.`

/** How many order ids {@link closeCancelRefusedMessage} lists before "and N more". */
export const closeCancelRefusedListCap = 40

/**
 * A grid close whose cancels the exchange refused because the API key may not
 * cancel orders. Names the exchange's own order ids, which is what the user
 * needs to find and cancel them there. Spec `232`.
 */
export const closeCancelRefusedMessage = (orderIds: string[], err: string) => {
  const shown = orderIds.slice(0, closeCancelRefusedListCap)
  const more = orderIds.length - shown.length
  const n = orderIds.length
  return `The bot was closed, but ${n} of its order${n === 1 ? '' : 's'} could not be cancelled and ${n === 1 ? 'remains' : 'remain'} on the exchange: the API key is not allowed to cancel orders${detail(err)}. Cancel ${n === 1 ? 'it' : 'them'} on the exchange, and give the key permission to cancel and query orders before starting a bot with it again. Order ids: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
}
