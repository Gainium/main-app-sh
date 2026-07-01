import logger from '../../utils/logger'
import { decrypt } from '../../utils/crypto'
import {
  ExchangeInUser,
  MessageTypeEnum,
  StatusEnum,
  UserSchema,
  ExchangeEnum,
} from '../../../types'
import { isPaper } from '../../utils'
import { resetPaperData } from '../../graphql/handlers/paper'
import {
  balanceDb,
  botEventDb,
  feeDb,
  orderDb,
  paperHedgeDb,
  paperLeverageDb,
  paperOrderDb,
  paperPositionDb,
  paperTradesDb,
  paperUserDb,
  paperWalletsDb,
  rateDb,
  snapshotDb,
  userDb as _userDb,
  userProfitByHourDb,
} from '../dbInit'
import DB from '../'

const removeOldRates = async () => {
  await rateDb
    .deleteManyData({
      created: {
        $lt: new Date(+new Date() - 30 * 24 * 60 * 60 * 1000),
      },
    })
    .then((res) => logger.debug(`Delete old rates ${res.reason}`))
}

const removeOldBotWarnings = async () => {
  await botEventDb
    .deleteManyData({
      type: MessageTypeEnum.warning,
      created: { $lt: new Date(+new Date() - 14 * 24 * 60 * 60 * 1000) },
    })
    .then((res) => logger.debug(`Delete old bot warnings ${res.reason}`))
}

const getUserExchanges = async <T extends UserSchema = UserSchema>(
  paper = false,
  userDb: DB<T> = _userDb as unknown as DB<T>,
) => {
  const users = await userDb.readData(
    { exchanges: { $not: { $size: 0 } } },
    { _id: 1, username: 1, exchanges: 1 },
    {},
    true,
  )
  if (users.status === StatusEnum.notok) {
    logger.error(`Cannot get real users ${users.reason}`)
    return []
  }
  const exchanges: ExchangeInUser[] = []
  for (const u of users.data.result) {
    u.exchanges.forEach((e) => {
      if ((paper && isPaper(e.provider)) || !paper) {
        exchanges.push({ ...e, key: decrypt(e.key) })
      }
    })
  }
  return exchanges
}

const clearNotUsedPaperData = async (_getUserExchanges = getUserExchanges) => {
  logger.debug('Clear not used paper data')

  const exchanges: ExchangeInUser[] = await _getUserExchanges(true)

  const notUsedPaperAccounts = await paperUserDb.readData(
    { key: { $nin: exchanges.map((e) => e.key) } },
    {},
    {},
    true,
    true,
  )
  if (notUsedPaperAccounts.status === StatusEnum.notok) {
    return logger.debug(`Cannot get paper users ${notUsedPaperAccounts.reason}`)
  }
  logger.debug(
    `Found ${notUsedPaperAccounts.data.count} not used paper accounts`,
  )
  const userIds = notUsedPaperAccounts.data.result.map((u) => u._id)
  await paperPositionDb
    .deleteManyData({ user: { $in: userIds } })
    .then((res) => logger.debug(`Delete futures ${res.reason}`))
  await paperHedgeDb
    .deleteManyData({ user: { $in: userIds } })
    .then((res) => logger.debug(`Delete hedge ${res.reason}`))
  await paperLeverageDb
    .deleteManyData({ user: { $in: userIds } })
    .then((res) => logger.debug(`Delete leverage ${res.reason}`))
  const ordersToDelete = await paperOrderDb.readData(
    { user: { $in: userIds } },
    { _id: 1 },
    {},
    true,
    true,
  )
  if (ordersToDelete.status === StatusEnum.notok) {
    return logger.debug(`Cannot get orders to delete ${ordersToDelete.reason}`)
  }
  logger.debug(`Found ${ordersToDelete.data.count} orders to delete`)
  const orderIds = ordersToDelete.data.result.map((o) => o._id)
  await paperTradesDb
    .deleteManyData({ order: { $in: orderIds } })
    .then((res) => logger.debug(`Delete trades ${res.reason}`))
  await paperOrderDb
    .deleteManyData({ user: { $in: userIds } })
    .then((res) => logger.debug(`Delete orders ${res.reason}`))
  await paperWalletsDb
    .deleteManyData({ user: { $in: userIds } })
    .then((res) => logger.debug(`Delete wallets ${res.reason}`))
  await paperUserDb
    .deleteManyData({ _id: { $in: userIds } })
    .then((res) => logger.debug(`Delete users ${res.reason}`))
  await userProfitByHourDb
    .deleteManyData({ userId: { $in: userIds } })
    .then((res) => logger.debug(`Delete user profit by hour ${res.reason}`))
}

const clearPaperOldOrders = async () => {
  logger.debug('Clear paper canceled paper orders')
  await paperOrderDb
    .deleteManyData({
      updatedAt: { $lt: new Date(+new Date() - 30 * 24 * 60 * 60 * 1000) },
      status: { $in: ['CANCELED', 'EXPIRED'] },
    })
    .then((res) => logger.debug(`Delete paper CANCELED orders ${res.reason}`))
  await paperOrderDb
    .deleteManyData({
      updatedAt: { $lt: new Date(+new Date() - 60 * 24 * 60 * 60 * 1000) },
      status: 'FILLED',
    })
    .then((res) => logger.debug(`Delete paper FILLED orders ${res.reason}`))
}

const clearRealOldCanceledOrders = async () => {
  logger.debug('Clear real canceled paper orders')
  await orderDb
    .deleteManyData({
      updated: { $lt: new Date(+new Date() - 30 * 24 * 60 * 60 * 1000) },
      exchange: { $ne: ExchangeEnum.bybit },
      status: { $in: ['CANCELED', 'EXPIRED'] },
    })
    .then((res) =>
      logger.debug(`Delete real not bybit CANCELED orders ${res.reason}`),
    )
  await orderDb
    .deleteManyData({
      updated: { $lt: new Date(+new Date() - 30 * 24 * 60 * 60 * 1000) },
      exchange: { $eq: ExchangeEnum.bybit },
      executedQty: {
        $in: [
          '0',
          '0.0',
          '0.00',
          '0.000',
          '0.0000',
          '0.00000',
          '0.000000',
          '0.0000000',
          '0.00000000',
        ],
      },
      status: 'CANCELED',
    })
    .then((res) =>
      logger.debug(`Delete real bybit CANCELED orders ${res.reason}`),
    )
}

const clearBalances = async (_getUserExchanges = getUserExchanges) => {
  logger.debug(`Start clean balances`)
  const exchanges: ExchangeInUser[] = await _getUserExchanges()
  if (exchanges.length) {
    await balanceDb
      .deleteManyData({
        exchangeUUID: { $nin: exchanges.map((e) => e.uuid) },
      })
      .then((res) => logger.debug(`Delete balances ${res.reason}`))
  }
}

const clearOldUserPaperData = async <T extends UserSchema = UserSchema>(
  userDb: DB<T> = _userDb as unknown as DB<T>,
  _clearNotUsedPaperData = clearNotUsedPaperData,
) => {
  logger.debug('Clear old user paper data')
  const users = await userDb.readData(
    {
      exchanges: { $not: { $size: 0 } },
      $or: [
        { last_active: { $exists: false } },
        {
          last_active: {
            $lt: new Date(+new Date() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      ],
      username: { $ne: 'hello@gainium.io' },
    },
    {},
    {},
    true,
    true,
  )
  if (users.status === StatusEnum.notok) {
    return logger.error(`Cannot get real users ${users.reason}`)
  }
  const filter = users.data.result.filter(
    (u) => u.exchanges.filter((e) => isPaper(e.provider)).length,
  )
  logger.debug(`Found ${filter.length} users with old paper`)
  for (const u of filter) {
    await resetPaperData(u).then((res) =>
      logger.debug(`Reset paper for user ${u._id} ${u.username} ${res.reason}`),
    )
  }
  await _clearNotUsedPaperData()
}

const cleanNotUsedUserFee = async (_getUserExchanges = getUserExchanges) => {
  logger.debug('Clean not used fee start')
  const exchanges = await _getUserExchanges()

  await feeDb
    .deleteManyData({
      exchangeUUID: { $nin: exchanges.map((e) => e.uuid) },
    })
    .then((res) => {
      logger.debug(`Clean not used fee ${res.reason}`)
    })

  logger.debug('Clean not used fee end')
}

const clearOldSnapshots = async () => {
  logger.debug('Clean old snapshots ')

  await snapshotDb
    .deleteManyData({
      created: { $lt: new Date(+new Date() - 90 * 24 * 60 * 60 * 1000) },
    })
    .then((res) => {
      logger.debug(`Clean old snapshots ${res.reason}`)
    })

  logger.debug('Clean old snapshots end')
}

const clearBotEvents = async () => {
  logger.debug('Clean old bot events ')

  await botEventDb
    .deleteManyData({
      created: { $lt: new Date(+new Date() - 30 * 24 * 60 * 60 * 1000) },
    })
    .then((res) => {
      logger.debug(`Clean old bot events ${res.reason}`)
    })

  logger.debug('Clean old bot events end')
}

const utils = {
  clearNotUsedPaperData,
  clearPaperOldOrders,
  clearRealOldCanceledOrders,
  clearBalances,
  clearOldUserPaperData,
  cleanNotUsedUserFee,
  clearOldSnapshots,
  removeOldBotWarnings,
  removeOldRates,
  clearBotEvents,
  getUserExchanges,
}

export default utils
