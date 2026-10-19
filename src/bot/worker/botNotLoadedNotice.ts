import { BotType, StatusEnum, liveupdate } from '../../../types'
import {
  botDb,
  botMessageDb,
  comboBotDb,
  dcaBotDb,
  hedgeComboBotDb,
  hedgeDCABotDb,
} from '../../db/dbInit'
import RedisClient from '../../db/redis'
import logger from '../../utils/logger'
import { v4 } from 'uuid'
import {
  UserNotice,
  botNotLoadedMessage,
  userNoticePayload,
  userNoticeRow,
} from '../userNotice'

/**
 * Methods the parent dispatches on a user's behalf (dashboard, API). When the
 * worker does not hold the bot, these are answered with a bot message; anything
 * else (stats, reloads, internal sweeps, webhook signals) only logs, as before.
 */
export const userInitiatedBotMethods: ReadonlySet<string> = new Set([
  'setStatus',
  'closeDealById',
  'closeAllDeals',
  'openNewDealMan',
  'addDealFunds',
  'reduceDealFunds',
  'addFundsForAllDeals',
  'reduceFundsInAllDeals',
  'updateDealSettings',
  'resetDealSettings',
  'cancelPendingAddFundsDealOrder',
  'cancelTerminalDealOrder',
  'buyBaseEntryRemainder',
  'executeNextDcaLevel',
  'restartDeal',
  'mergeDeals',
  'adoptDeals',
  'enableSinglePosition',
])

type BotRow = {
  userId?: string
  exchange?: string
  paperContext?: boolean
  settings?: { name?: string }
}

export type BotNotLoadedDeps = {
  readBot: (botType: BotType, botId: string) => Promise<BotRow | null>
  createMessage: (
    row: ReturnType<typeof userNoticeRow>,
  ) => Promise<{ status: StatusEnum; data?: { _id: unknown } | null }>
  publish: (channel: string, msg: string) => Promise<unknown>
}

const dbByType = (botType: BotType) => {
  switch (botType) {
    case BotType.grid:
      return botDb
    case BotType.dca:
      return dcaBotDb
    case BotType.combo:
      return comboBotDb
    case BotType.hedgeCombo:
      return hedgeComboBotDb
    case BotType.hedgeDca:
      return hedgeDCABotDb
    default:
      return null
  }
}

export const defaultBotNotLoadedDeps: BotNotLoadedDeps = {
  readBot: async (botType, botId) => {
    const db = dbByType(botType) as unknown as {
      readData: (f: unknown, p: unknown) => Promise<any>
    } | null
    if (!db) {
      return null
    }
    const read = await db.readData(
      { _id: botId },
      { userId: 1, 'settings.name': 1, exchange: 1, paperContext: 1 },
    )
    return read?.status === StatusEnum.ok ? (read.data?.result ?? null) : null
  },
  createMessage: (row) => botMessageDb.createData(row as any) as Promise<any>,
  publish: async (channel, msg) =>
    (await RedisClient.getInstance()).publish(channel, msg),
}

/**
 * The parent routed a user's action to a worker that does not hold the bot, so
 * the action was dropped after the API had already answered "scheduled". There
 * is no bot instance to report through, so write the message the way
 * `MainBot.reportUserRefusal` does. Best effort: a failure only loses the
 * notice, never the worker.
 */
export const reportBotNotLoaded = async (
  botId: string,
  botType: BotType,
  deps: BotNotLoadedDeps = defaultBotNotLoadedDeps,
) => {
  try {
    const bot = await deps.readBot(botType, botId)
    if (!bot?.userId) {
      return
    }
    const time = Date.now()
    const notice: UserNotice = {
      userId: `${bot.userId}`,
      botId,
      botType,
      botName: bot.settings?.name,
      message: botNotLoadedMessage,
      exchange: bot.exchange,
      paperContext: !!bot.paperContext,
    }
    const saved = await deps.createMessage(userNoticeRow(notice, time))
    const _id =
      saved?.status === StatusEnum.ok && saved.data ? `${saved.data._id}` : v4()
    await deps.publish(
      `${liveupdate}${notice.userId}`,
      JSON.stringify({
        event: 'bot sends message',
        data: {
          botId,
          data: userNoticePayload(notice, _id, time),
          botType,
          paperContext: !!bot.paperContext,
        },
      }),
    )
  } catch (e) {
    logger.warn(
      `Cannot report bot not loaded ${botId}: ${(e as Error)?.message ?? e}`,
    )
  }
}
