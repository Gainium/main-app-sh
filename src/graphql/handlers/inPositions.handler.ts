/**
 * `botDashboardStats { inPositionsUsd inPositionsCount inPositionsUnpriced }`
 * (main-app spec 019 §4). Resolved only when a client selects one of these
 * fields, so existing `botDashboardStats` callers pay nothing.
 *
 * USD prices come from the portfolio's own pricing path
 * (`priceBalancesUsd`), never from adding quote amounts across currencies.
 */
import {
  BotType,
  BotStatusEnum,
  DCADealStatusEnum,
  DCATypeEnum,
  StatusEnum,
} from '../../../types'
import { botDb, comboDealsDb, dcaDealsDb } from '../../db/dbInit'
import logger from '../../utils/logger'
import { priceBalancesUsd } from '../../utils/user'
import {
  Exposure,
  InPositionsResult,
  dealExposure,
  groupExposures,
  gridExposure,
  sumInPositions,
} from '../../bot/inPositions'

const ACTIVE_DEAL_STATUSES = [
  DCADealStatusEnum.open,
  DCADealStatusEnum.start,
  DCADealStatusEnum.error,
]

const dealProjection = {
  strategy: 1,
  exchange: 1,
  exchangeUUID: 1,
  symbol: 1,
  'settings.futures': 1,
  'settings.coinm': 1,
  'usage.current': 1,
}

const gridProjection = {
  exchange: 1,
  exchangeUUID: 1,
  symbol: 1,
  'settings.futures': 1,
  'settings.coinm': 1,
  position: 1,
  currentBalances: 1,
}

/** Mongo filter for the deals a bot type's dashboard counts (mirrors dealDashboardStats). */
export const inPositionsDealFilter = (
  userId: string,
  type: BotType,
  paperContext: boolean,
  terminal?: boolean,
) => {
  const hedge = type === BotType.hedgeCombo || type === BotType.hedgeDca
  const filter: Record<string, unknown> = {
    userId,
    isDeleted: { $ne: true },
    paperContext: paperContext ? { $eq: true } : { $ne: true },
    status: { $in: ACTIVE_DEAL_STATUSES },
    $or: hedge
      ? [{ parentBotId: { $ne: null } }]
      : [{ parentBotId: { $exists: false } }, { parentBotId: { $eq: null } }],
  }
  if (type !== BotType.combo && type !== BotType.hedgeCombo) {
    filter.type = terminal
      ? { $eq: DCATypeEnum.terminal }
      : { $nin: [DCATypeEnum.terminal] }
  }
  return filter
}

export const priceExposures = async (
  exposures: (Exposure | null)[],
  pricer: typeof priceBalancesUsd = priceBalancesUsd,
): Promise<InPositionsResult> => {
  const groups = [
    ...groupExposures(exposures.filter((e): e is Exposure => !!e)).values(),
  ]
  const usdPerUnit = new Map<string, number>()
  if (groups.length) {
    try {
      const priced = await pricer(
        groups.map((g) => ({
          asset: g.asset,
          free: g.amount,
          locked: 0,
          exchange: g.exchange,
          exchangeUUID: g.exchangeUUID,
        })),
      )
      for (const [key, value] of priced) {
        usdPerUnit.set(key, value.price)
      }
    } catch (e) {
      logger.error(`inPositions | usd valuation error: ${e}`)
    }
  }
  return sumInPositions(exposures, usdPerUnit)
}

export const getInPositions = async (
  userId: string,
  type: BotType,
  paperContext: boolean,
  terminal?: boolean,
): Promise<InPositionsResult | null> => {
  if (type === BotType.grid) {
    const bots = await botDb.readData(
      {
        userId,
        isDeleted: { $ne: true },
        paperContext: paperContext ? { $eq: true } : { $ne: true },
        status: {
          $in: [
            BotStatusEnum.open,
            BotStatusEnum.range,
            BotStatusEnum.error,
            BotStatusEnum.monitoring,
          ],
        },
      } as never,
      gridProjection as never,
      {},
      true,
    )
    if (bots.status !== StatusEnum.ok) return null
    return priceExposures(bots.data.result.map((b) => gridExposure(b as never)))
  }
  const db = (
    type === BotType.combo || type === BotType.hedgeCombo
      ? comboDealsDb
      : dcaDealsDb
  ) as typeof dcaDealsDb
  const deals = await db.readData(
    inPositionsDealFilter(userId, type, paperContext, terminal) as never,
    dealProjection as never,
    {},
    true,
  )
  if (deals.status !== StatusEnum.ok) return null
  return priceExposures(deals.data.result.map((d) => dealExposure(d as never)))
}
