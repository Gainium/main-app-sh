import { BotStatusEnum } from '../../types'

/**
 * A bot stopped with "leave open deals" keeps running for those deals but
 * opens no new one. A manual "+ New deal" on it is refused with this message
 * rather than dropped silently.
 */
export const stoppedBotNewDealMessage =
  'Bot is stopped, a new deal cannot be opened. Start the bot to open a new deal'

export const isStoppedForNewDeals = (
  status?: BotStatusEnum | string | null,
  previousStatus?: BotStatusEnum | string | null,
) =>
  status === BotStatusEnum.closed ||
  (status === BotStatusEnum.error && previousStatus === BotStatusEnum.closed)
