import ExchangeChooser from '../exchange/exchangeChooser'
import { paperExchanges } from '../exchange/paper/utils'
import {
  Prices,
  SnapshotSchema,
  UserDataStreamEvent,
  ExchangeInUser,
  ClearUserSchema,
  FreeAsset,
  ResetAccountTypeEnum,
  ResetLogEntry,
  DCADealStatusEnum,
  BaseReturn,
} from '../../types'
import {
  BotStatusEnum,
  BotType,
  CloseDCATypeEnum,
  CloseGRIDTypeEnum,
  ExchangeEnum,
  liveupdate,
  rabbitUsersStreamKey,
  serviceLogRedis,
  StatusEnum,
} from '../../types'
import type { Socket } from 'socket.io-client'
import utils from '.'
import { decrypt } from './crypto'
import logger from './logger'
import {
  botEventDb,
  botMessageDb,
  botProfitChartDb,
  comboBotDb,
  comboDealsDb,
  comboProfitDb,
  comboTransactionsDb,
  dcaDealsDb,
  hedgeComboBotDb,
  globalVarsDb,
  minigridDb,
  orderDb,
  paperHedgeDb,
  paperLeverageDb,
  paperOrderDb,
  paperPositionDb,
  paperUserDb,
  paperWalletsDb,
  transactionDb,
  userProfitByHourDb,
  hedgeDCABotDb,
  userDb,
  balanceDb,
  feeDb,
  rateDb,
  snapshotDb,
  botDb,
  dcaBotDb,
  snapshotPerExchangeDb,
  pairDb,
} from '../db/dbInit'
import { balanceAssetToPairBase } from './assetClass'
import type { PairsSchema } from '../../types'
import RedisClient from '../db/redis'
import Rabbit from '../db/rabbit'
import type { ErrorResponse, MessageResponse } from '../db/crud'
import BotService from '../bot'
import { updateRelatedBotsInVar } from '../bot/utils'
import ColdClient, { isColdStoreEnabled } from '../archive/coldClient'
import SnapshotClient from '../archive/snapshotClient'
import axios from 'axios'

const { getTimezoneOffset, findUSDRate } = utils

/**
 * `locked` on a balance doc means "amount reserved by open orders/positions" and
 * must never be negative. Some authoritative sources can nonetheless emit a
 * negative value: Binance futures `ACCOUNT_UPDATE` computes
 * `walletBalance - crossWalletBalance` (negative when unrealized PnL is positive),
 * and the exchange-connector's Hyperliquid futures balance returns
 * `accountValue - withdrawable` (negative on margin-deficit / total-vs-per-asset
 * mismatch). Writing those verbatim leaves a garbage negative `locked` in the
 * `balances` collection, so the displayed "available" reads wrong. Clamp at the
 * write boundary so the collection can never store a negative locked amount.
 */
const normalizeLocked = (locked: number): number =>
  Number.isFinite(locked) && locked > 0 ? locked : 0

const streams: { stream: Socket; uuid: string }[] = []

const streamsSet: Set<string> = new Set()

const coinsbaseTimer: Map<string, NodeJS.Timeout> = new Map()

const coinbaseTimeout = 10 * 60 * 1000

const hyperliquidTimer: Map<string, NodeJS.Timeout> = new Map()

const hyperliquidTimeout = 10 * 60 * 1000

const bitgetTimer: Map<string, NodeJS.Timeout> = new Map()

const bitgetTimeout = 2 * 60 * 1000

const balanceMsg: (UserDataStreamEvent & {
  userId: string
  e: ExchangeInUser
})[] = []

let lockBalance = false

const rabbitClient = new Rabbit()

type UserFilter = Record<string, unknown>
let userListFilter: <T extends UserFilter>(filter: T) => T = (f) => f

/**
 * Lets the parent package narrow which users core treats as "eligible"
 * (e.g. exclude pending-delete users). Core stays delete-agnostic.
 */
export const setUserListFilter = (
  fn: <T extends UserFilter>(filter: T) => T,
) => {
  userListFilter = fn
}

const processBalanceUpdate = async () => {
  const next = async () => {
    lockBalance = false
    balanceMsg.shift()
    await processBalanceUpdate()
  }
  if (!lockBalance && balanceMsg.length > 0) {
    lockBalance = true
    const [msg] = balanceMsg
    if (
      msg.eventType !== 'outboundAccountPosition' &&
      msg.eventType !== 'balanceUpdate' &&
      msg.eventType !== 'ACCOUNT_UPDATE'
    ) {
      next()
      return
    }
    const { userId, e } = msg
    /** Check exchange in user account */
    const user = await userDb.readData(
      userListFilter({
        exchanges: { $elemMatch: { uuid: e.uuid } },
      }),
    )
    if (user.status === StatusEnum.notok) {
      logger.warn(`Get user in update balance: ${user.reason}`)
    } else {
      if (!user.data.result) {
        logger.warn(
          `Balance update message | Exchange not found in user account ${e.uuid}@${userId}`,
        )
      } else {
        const ex = user.data.result.exchanges.find(
          (ue) => ue.uuid === e.uuid && !ue.linkedTo,
        )
        if (!ex) {
          next()
          return ex
        }
        const redis = await RedisClient.getInstance()
        if (msg.eventType === 'outboundAccountPosition') {
          const data = msg.balances.map((b) => ({
            ...b,
            exchange: e.provider,
            exchangeUUID: e.uuid,
            paperContext: paperExchanges.includes(e.provider),
          }))

          redis?.publish(
            `${liveupdate}${userId}`,
            JSON.stringify({ data: { data }, event: 'balance' }),
          )

          for (const d of msg.balances) {
            const getPair = await balanceDb.countData({
              asset: d.asset,
              userId,
              exchange: e.provider,
              exchangeUUID: e.uuid,
              paperContext: paperExchanges.includes(e.provider),
            })
            if (getPair.status === 'OK' && getPair.data.result === 0) {
              balanceDb.updateData(
                { exchangeUUID: e.uuid, asset: d.asset, userId },
                {
                  ...d,
                  free: parseFloat(d.free),
                  locked: normalizeLocked(parseFloat(d.locked)),
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                false,
                true,
                true,
              )
            } else {
              balanceDb.updateData(
                {
                  asset: d.asset,
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                {
                  $set: {
                    ...d,
                    free: parseFloat(d.free),
                    locked: normalizeLocked(parseFloat(d.locked)),
                  },
                },
                false,
                true,
              )
            }
          }
        }
        if (msg.eventType === 'balanceUpdate') {
          const getBalance = await balanceDb.readData({
            asset: msg.asset,
            userId,
            exchange: e.provider,
            exchangeUUID: e.uuid,
            paperContext: paperExchanges.includes(e.provider),
          })
          if (getBalance.status === 'OK') {
            const result = getBalance.data.result
            const free = (result?.free || 0) + parseFloat(msg.balanceDelta)
            balanceDb
              .updateData(
                {
                  asset: msg.asset,
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                {
                  $set: {
                    free,
                  },
                },
                false,
                true,
              )
              .then(() => {
                const data = [
                  {
                    asset: msg.asset,
                    free,
                    locked: result?.locked || 0,
                    exchange: e.provider,
                    exchangeUUID: e.uuid,
                    paperContext: paperExchanges.includes(e.provider),
                  },
                ]

                redis?.publish(
                  `${liveupdate}${userId}`,
                  JSON.stringify({ data: { data }, event: 'balance' }),
                )
              })
          }
        }
        if (msg.eventType === 'ACCOUNT_UPDATE') {
          const balances = msg.balances
          for (const b of balances) {
            const free = parseFloat(b.crossWalletBalance)
            const locked = normalizeLocked(
              parseFloat(b.walletBalance) - parseFloat(b.crossWalletBalance),
            )
            const getPair = await balanceDb.countData({
              asset: b.asset,
              userId,
              exchange: e.provider,
              exchangeUUID: e.uuid,
              paperContext: paperExchanges.includes(e.provider),
            })
            if (getPair.status === 'OK' && getPair.data.result === 0) {
              balanceDb.updateData(
                { exchangeUUID: e.uuid, asset: b.asset, userId },
                {
                  asset: b.asset,
                  free,
                  locked,
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                false,
                true,
                true,
              )
            } else {
              balanceDb
                .updateData(
                  {
                    asset: b.asset,
                    userId,
                    exchange: e.provider,
                    exchangeUUID: e.uuid,
                    paperContext: paperExchanges.includes(e.provider),
                  },
                  {
                    $set: {
                      free,
                      locked,
                    },
                  },
                  false,
                  true,
                )
                .then(() => {
                  const data = [
                    {
                      asset: b.asset,
                      free,
                      locked,
                      exchange: e.provider,
                      exchangeUUID: e.uuid,
                      paperContext: paperExchanges.includes(e.provider),
                    },
                  ]

                  redis?.publish(
                    `${liveupdate}${userId}`,
                    JSON.stringify({ data: { data }, event: 'balance' }),
                  )
                })
            }
          }
        }
      }
    }

    await next()
  }
}

const updateUserBalance = async (
  user: ClearUserSchema,
  uuid?: string,
  paperContext?: boolean,
  ec = ExchangeChooser,
) => {
  const userId = user._id.toString()
  const filter: Record<string, unknown> = { userId }
  if (uuid) {
    filter.exchangeUUID = uuid
  }
  const userBalances = await balanceDb.readData(
    filter,
    undefined,
    {},
    true,
    true,
  )
  for (const e of user.exchanges
    .filter((ue) =>
      paperContext === undefined
        ? true
        : paperContext
          ? paperExchanges.includes(ue.provider)
          : !paperExchanges.includes(ue.provider),
    )
    .filter((ue) => !ue.linkedTo)) {
    if ((uuid && uuid === e.uuid) || !uuid) {
      const exchange = ec.chooseExchangeFactory(e.provider)

      if (exchange) {
        const provider = exchange(
          e.key,
          e.secret,
          e.passphrase,
          undefined,
          e.keysType,
          e.okxSource,
          e.bybitHost,
        )
        const balances = await provider.getBalance()
        if (balances.status === 'OK' && userBalances.status === StatusEnum.ok) {
          const balancesMap: Map<string, FreeAsset[0]> = new Map()
          for (const b of balances.data) {
            balancesMap.set(b.asset, {
              ...b,
              locked: normalizeLocked(b.locked),
            })
          }
          for (const b of balancesMap.values()) {
            const getPair = userBalances.data.result.find(
              (rb) => rb.asset === b.asset && rb.exchangeUUID === e.uuid,
            )
            if (!getPair) {
              await balanceDb.updateData(
                { exchangeUUID: e.uuid, asset: b.asset, userId },
                {
                  ...b,
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                false,
                true,
                true,
              )
            } else if (
              getPair &&
              (getPair.free !== b.free || getPair.locked !== b.locked)
            ) {
              await balanceDb.updateData(
                {
                  asset: b.asset,
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                { $set: { free: b.free, locked: b.locked } },
                false,
                true,
              )
            }
          }
          for (const ub of userBalances.data.result) {
            if (
              !balances.data.map((b) => b.asset).includes(ub.asset) &&
              (ub.free > 0 || ub.locked > 0)
            ) {
              await balanceDb.updateData(
                {
                  asset: ub.asset,
                  userId,
                  exchange: e.provider,
                  exchangeUUID: e.uuid,
                  paperContext: paperExchanges.includes(e.provider),
                },
                { $set: { free: 0, locked: 0 } },
                false,
                true,
              )
            }
          }
        }
      }
    }
  }
}

const setCoinbaseTimer = async (
  user: ClearUserSchema,
  uuid: string,
  ec = ExchangeChooser,
) => {
  const key = `${uuid}`
  const get = coinsbaseTimer.get(key)
  if (get) {
    clearInterval(get)
  }
  logger.debug(`Coinbase timer set for ${uuid}`)
  coinsbaseTimer.set(
    key,
    setInterval(
      () => (
        logger.debug(`Coinbase timer trigger for ${uuid}`),
        updateUserBalance(user, uuid, undefined, ec)
      ),
      coinbaseTimeout,
    ),
  )
}

const setHyperliquidTimer = async (
  user: ClearUserSchema,
  uuid: string,
  ec = ExchangeChooser,
) => {
  const key = `${uuid}`
  const get = hyperliquidTimer.get(key)
  if (get) {
    clearInterval(get)
  }
  logger.debug(`Hyperliquid timer set for ${uuid}`)
  hyperliquidTimer.set(
    key,
    setInterval(
      () => (
        logger.debug(`Hyperliquid timer trigger for ${uuid}`),
        updateUserBalance(user, uuid, undefined, ec)
      ),
      hyperliquidTimeout,
    ),
  )
}

const setBitgetTimer = async (
  user: ClearUserSchema,
  uuid: string,
  ec = ExchangeChooser,
) => {
  const key = `${uuid}`
  const get = bitgetTimer.get(key)
  if (get) {
    clearInterval(get)
  }
  logger.debug(`Bitget timer set for ${uuid}`)
  bitgetTimer.set(
    key,
    setInterval(
      () => (
        logger.debug(`Bitget timer trigger for ${uuid}`),
        updateUserBalance(user, uuid, undefined, ec)
      ),
      bitgetTimeout,
    ),
  )
}

const connectUserBalance = async (
  id?: string,
  uuid?: string,
  ec = ExchangeChooser,
) => {
  const users = await userDb.readData(
    userListFilter(
      id
        ? { _id: id }
        : {
            last_active: {
              $gt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
            },
          },
    ),
    undefined,
    {},
    true,
    true,
  )
  if (users.status === 'OK' && users.data.count > 0) {
    if (uuid || id) {
      await Promise.all(
        users.data.result.map((u) => updateUserBalance(u, uuid, undefined, ec)),
      )
    }
    for (const u of users.data.result) {
      const userId = u._id.toString()
      for (const e of u.exchanges.filter((ue) => !ue.linkedTo)) {
        if (e.provider === ExchangeEnum.coinbase) {
          setCoinbaseTimer(u, e.uuid, ec)
          continue
        }
        if (
          e.provider === ExchangeEnum.hyperliquid ||
          e.provider === ExchangeEnum.hyperliquidLinear
        ) {
          setHyperliquidTimer(u, e.uuid, ec)
          continue
        }
        if (
          e.provider === ExchangeEnum.bitget ||
          e.provider === ExchangeEnum.bitgetUsdm ||
          e.provider === ExchangeEnum.bitgetCoinm
        ) {
          setBitgetTimer(u, e.uuid, ec)
          continue
        }
        const find = streams.find((s) => s.uuid === e.uuid)
        if (find) {
          disconnectUserBalance(find.uuid)
        }

        if (streamsSet.has(e.uuid)) {
          disconnectUserBalance(e.uuid)
        }

        const data = {
          key: decrypt(e.key),
          secret: decrypt(e.secret),
          passphrase: e.passphrase ? decrypt(e.passphrase) : '',
          provider: e.provider,
          keysType: e.keysType,
          okxSource: e.okxSource,
          bybitHost: e.bybitHost,
        }
        const redisClient = await RedisClient.getInstance(true, 'app')

        const connect = () =>
          rabbitClient?.send(rabbitUsersStreamKey, {
            event: 'open stream',
            data: { userId, api: data },
            uuid: e.uuid,
          })
        connect()
        redisClient?.subscribe(serviceLogRedis, async (msg: string) => {
          const service = JSON.parse(msg)?.restart
          if (service === 'userStream') {
            const currentUser = await userDb.readData({ _id: userId })
            if (
              currentUser.status === StatusEnum.ok &&
              currentUser.data.result?.exchanges.some(
                (ex) => ex.uuid === e.uuid,
              )
            ) {
              connect()
            }
          }
        })
        streamsSet.add(e.uuid)
        redisClient?.subscribe(`userStreamInfo${e.uuid}`, (msg) =>
          logger.debug('socket connect on start | ', msg),
        )

        if (redisClient) {
          redisClient.subscribe(e.uuid, async (msg) => {
            balanceMsg.push({ ...JSON.parse(msg), userId, e })
            await processBalanceUpdate()
          })
        }
      }
    }
  }
}

const disconnectUserBalance = async (uuid: string) => {
  const getTimer = coinsbaseTimer.get(uuid)
  if (getTimer) {
    clearInterval(getTimer)
    coinsbaseTimer.delete(uuid)
  }

  const getTimerHyperliquid = hyperliquidTimer.get(uuid)
  if (getTimerHyperliquid) {
    clearInterval(getTimerHyperliquid)
    hyperliquidTimer.delete(uuid)
  }

  const getTimerBitget = bitgetTimer.get(uuid)
  if (getTimerBitget) {
    clearInterval(getTimerBitget)
    bitgetTimer.delete(uuid)
  }

  if (streamsSet.has(uuid)) {
    rabbitClient?.send(rabbitUsersStreamKey, {
      event: 'close stream',
      uuid,
    })
  }
  streamsSet.delete(uuid)
  const redisClient = await RedisClient.getInstance(true, 'app')

  redisClient?.unsubscribe(`userStreamInfo${uuid}`)
  redisClient?.unsubscribe(uuid)
  return
}

const updateUserFee = async (
  id?: string,
  uuid?: string,
  log = true,
  ec = ExchangeChooser,
) => {
  const users = await userDb.readData(
    userListFilter(id ? { _id: id } : {}),
    undefined,
    {},
    true,
  )
  if (users.status === 'OK') {
    const redis = await RedisClient.getInstance()
    for (const u of users.data.result) {
      for (const e of u.exchanges) {
        const exchange = ec.chooseExchangeFactory(e.provider)
        if (((uuid && e.uuid === uuid) || !uuid) && exchange) {
          const provider = exchange(
            e.key,
            e.secret,
            e.passphrase,
            undefined,
            e.keysType,
            e.okxSource,
            e.bybitHost,
            e.subaccount,
            e.affiliate,
          )
          const userId = u._id.toString()
          const fees = await provider.getAllUserFees()
          const localFees = await feeDb.readData(
            { userId, exchangeUUID: e.uuid },
            undefined,
            undefined,
            true,
          )
          if (fees.status === 'OK' && localFees.status === 'OK') {
            for (const f of fees.data) {
              const getPair = localFees.data.result.find(
                (lf) => lf.pair === f.pair,
              )
              if (!getPair) {
                feeDb
                  .createData({
                    ...f,
                    userId,
                    exchange: e.provider,
                    exchangeUUID: e.uuid,
                  })
                  .then((r) => {
                    if (r.status === 'OK') {
                      if (log) {
                        logger.debug(
                          `Fee ${f.pair} for user ${userId} created | ${e.provider} | ${e.uuid}`,
                        )
                      }
                    } else {
                      logger.error(
                        `Fee ${f.pair} for user ${userId} error | reason ${r.reason} | ${e.provider} | ${e.uuid}`,
                      )
                    }
                  })
              } else if (
                getPair.maker !== f.maker ||
                getPair.taker !== f.taker
              ) {
                logger.debug(
                  `Fee different ${f.pair}@${userId}@${e.provider}@${e.uuid} old: ${getPair.maker} (maker), ${getPair.taker} (taker), new: ${f.maker} (maker), ${f.taker} (taker)`,
                )
                feeDb
                  .updateData(
                    { pair: f.pair, userId, exchangeUUID: e.uuid },
                    { $set: { ...f, exchangeUUID: e.uuid, userId } },
                    false,
                    true,
                  )
                  .then((r) => {
                    if (r.status === 'OK') {
                      logger.debug(
                        `Fee ${f.pair} for user ${userId} updated | ${e.provider} | ${e.uuid}`,
                      )
                      redis?.publish(
                        'updateuserFee',
                        JSON.stringify({
                          uuid: e.uuid,
                          userId,
                          pair: f.pair,
                        }),
                      )
                    } else {
                      logger.error(
                        `Fee ${f.pair} for user ${userId} error | reason ${r.reason} | ${e.provider} | ${e.uuid}`,
                      )
                    }
                  })
              }
            }
            const deleted = localFees.data.result
              .filter((lf) => !fees.data.map((f) => f.pair).includes(lf.pair))
              .map((d) => d.pair)
            if (deleted.length > 0) {
              feeDb
                .deleteManyData({
                  pair: { $in: deleted },
                  userId,
                  exchangeUUID: e.uuid,
                })
                .then((r) => {
                  if (r.status === 'OK') {
                    logger.debug(
                      `Fee Delete ${r.reason} | ${userId} | ${e.provider} | ${e.uuid}`,
                    )
                  } else {
                    logger.error(
                      `Fee Delete error ${r.reason} | ${userId} | ${e.provider} | ${e.uuid}`,
                    )
                  }
                })
            }
          } else {
            logger.error(
              `Fee Update error, remote ${fees.reason}, local ${localFees.reason}`,
            )
          }
        }
      }
    }
  } else {
    logger.error(`Fee Update error, cannot get users ${users.reason}`)
  }
}

const exchanges = [
  ExchangeEnum.binance,
  ExchangeEnum.kucoin,
  ExchangeEnum.binanceUS,
  ExchangeEnum.bybit,
  ExchangeEnum.paperBinance,
  ExchangeEnum.paperBybit,
  ExchangeEnum.paperKucoin,
  ExchangeEnum.binanceCoinm,
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.paperBinanceCoinm,
  ExchangeEnum.paperBinanceUsdm,
  ExchangeEnum.bybitCoinm,
  ExchangeEnum.bybitUsdm,
  ExchangeEnum.paperBybitUsdm,
  ExchangeEnum.paperBybitCoinm,
  ExchangeEnum.okx,
  ExchangeEnum.okxInverse,
  ExchangeEnum.okxLinear,
  ExchangeEnum.paperOkx,
  ExchangeEnum.paperOkxInverse,
  ExchangeEnum.paperOkxLinear,
  ExchangeEnum.coinbase,
  ExchangeEnum.paperCoinbase,
  ExchangeEnum.kucoinInverse,
  ExchangeEnum.kucoinLinear,
  ExchangeEnum.paperKucoinInverse,
  ExchangeEnum.paperKucoinLinear,
  ExchangeEnum.bitget,
  ExchangeEnum.paperBitget,
  ExchangeEnum.bitgetUsdm,
  ExchangeEnum.bitgetCoinm,
  ExchangeEnum.paperBitgetUsdm,
  ExchangeEnum.paperBitgetCoinm,
  ExchangeEnum.mexc,
  ExchangeEnum.paperMexc,
  ExchangeEnum.hyperliquid,
  ExchangeEnum.hyperliquidLinear,
  ExchangeEnum.paperHyperliquid,
  ExchangeEnum.paperHyperliquidLinear,
  ExchangeEnum.kraken,
  ExchangeEnum.paperKraken,
  ExchangeEnum.krakenUsdm,
  ExchangeEnum.paperKrakenUsdm,
]

export interface PricedBalanceInput {
  asset: string
  free: number
  locked: number
  /** ExchangeEnum value from the balance doc (`balancesSchema.exchange`). */
  exchange: string
  exchangeUUID?: string
}

/**
 * Value a set of balances in USD using the SAME authoritative path the portfolio
 * snapshot cron uses ({@link userSnapshots}): the connector's Redis-cached
 * `getAllPrices` rate table + the USDT→USD rate, then a per-exchange tokenized-
 * stock fallback off the `pairs` collection (`assetCategory` = stock/etf) priced
 * by the venue's live `latestPrice` ticker. Asset class comes from the exchange's
 * own signal — never from symbol-name heuristics (see `assetClass.ts`), so this
 * covers Kraken xStocks (`PGx.T`), Bybit-spot xstocks (`AAPLX`), etc. uniformly.
 *
 * Returns a map keyed by `${exchangeUUID}:${asset}` → `{ price, usdValue }`.
 * `getAllPrices` is a Redis read on a warm cache, so this is cheap enough to call
 * per request. Kept standalone (not wired into the cron) to bound blast radius.
 */
export const priceBalancesUsd = async (
  balances: PricedBalanceInput[],
  ec = ExchangeChooser,
): Promise<Map<string, { price: number; usdValue: number }>> => {
  const out = new Map<string, { price: number; usdValue: number }>()
  if (!balances.length) return out

  // 1) Crypto rate table — cached `getAllPrices` for the exchanges present here.
  let rates: Prices = []
  const exchangesPresent = [
    ...new Set(balances.map((b) => b.exchange).filter(Boolean)),
  ]
  for (const e of exchangesPresent) {
    const factory = ec.chooseExchangeFactory(e as ExchangeEnum)
    if (!factory) continue
    try {
      const prices = await factory('', '').getAllPrices()
      if (prices.status === StatusEnum.ok) {
        rates = [...rates, ...prices.data.map((p) => ({ ...p, exchange: e }))]
      } else {
        logger.error(`priceBalancesUsd | getAllPrices ${e}: ${prices.reason}`)
      }
    } catch (e2) {
      logger.error(`priceBalancesUsd | getAllPrices ${e} failed: ${e2}`)
    }
  }
  const usdRequest = await rateDb.readData({}, undefined, {
    limit: 1,
    sort: { created: -1 },
  })
  if (usdRequest.status === StatusEnum.ok) {
    const price = usdRequest.data.result?.usdRate ?? 1
    rates = [...rates, { pair: 'USDTZUSD', price, exchange: 'all' }]
  }

  // 2) Tokenized-stock fallback map (venue-agnostic; keyed off `pairs`).
  const stockPairMap = new Map<string, string>() // `${exchange}:${BASE}` → pair
  const stockPairs = await pairDb.readData<
    Pick<PairsSchema, 'exchange' | 'pair'> & { baseAsset: { name: string } }
  >(
    { assetCategory: { $in: ['stock', 'etf'] } },
    { exchange: 1, pair: 1, 'baseAsset.name': 1 },
    {},
    true,
  )
  if (stockPairs.status === StatusEnum.ok) {
    for (const p of stockPairs.data.result) {
      if (p.exchange && p.pair && p.baseAsset?.name) {
        stockPairMap.set(
          `${p.exchange}:${p.baseAsset.name.toUpperCase()}`,
          p.pair,
        )
      }
    }
  }
  const stockPriceCache = new Map<string, number>()
  const stockPriceProviders = new Map<
    string,
    ReturnType<ReturnType<typeof ec.chooseExchangeFactory>>
  >()
  const stockUsdRate = async (
    asset: string,
    exchange: string,
  ): Promise<number> => {
    const base = balanceAssetToPairBase(asset, exchange).toUpperCase()
    const pair = stockPairMap.get(`${exchange}:${base}`)
    if (!pair) return 0
    const cacheKey = `${exchange}:${pair}`
    const cached = stockPriceCache.get(cacheKey)
    if (cached !== undefined) return cached
    let provider = stockPriceProviders.get(exchange)
    if (!provider) {
      const factory = ec.chooseExchangeFactory(exchange as ExchangeEnum)
      if (!factory) {
        stockPriceCache.set(cacheKey, 0)
        return 0
      }
      provider = factory('', '')
      stockPriceProviders.set(exchange, provider)
    }
    try {
      const res = await provider.latestPrice(pair, true)
      const price =
        res.status === StatusEnum.ok && typeof res.data === 'number'
          ? res.data
          : 0
      stockPriceCache.set(cacheKey, price)
      return price
    } catch (e) {
      logger.error(`priceBalancesUsd | stock price ${exchange} ${pair}: ${e}`)
      stockPriceCache.set(cacheKey, 0)
      return 0
    }
  }

  // 3) Value each balance: crypto rate first, tokenized-stock fallback second.
  for (const b of balances) {
    const amount = (b.free || 0) + (b.locked || 0)
    if (!amount) continue
    let usdRate = findUSDRate(b.asset, rates, b.exchange)
    if (!usdRate) usdRate = await stockUsdRate(b.asset, b.exchange)
    const price = usdRate || 0
    out.set(`${b.exchangeUUID ?? ''}:${b.asset}`, {
      price,
      usdValue: amount * price,
    })
  }
  return out
}

const userSnapshots = async (
  id?: string,
  paperContext?: boolean,
  onlyOneCycle?: boolean,
  skipBalance?: boolean,
  ec = ExchangeChooser,
) => {
  let rates: Prices = []
  const users = await userDb.readData(
    userListFilter(id ? { _id: id } : {}),
    undefined,
    {},
    true,
  )
  if (users.status === 'OK') {
    const userExchangeSet: Set<string> = new Set()
    for (const u of users.data.result) {
      for (const e of u.exchanges) {
        userExchangeSet.add(e.provider)
      }
    }
    for (const e of exchanges) {
      const provider = ec.chooseExchangeFactory(e)
      if (
        userExchangeSet.has(e) &&
        provider &&
        (paperContext
          ? paperExchanges.includes(e)
          : !paperExchanges.includes(e))
      ) {
        const exchange = provider('', '')
        const prices = await exchange.getAllPrices()
        if (prices.status === StatusEnum.ok) {
          rates = [...rates, ...prices.data.map((p) => ({ ...p, exchange: e }))]
        } else {
          logger.error(`Snapshot | Cannot get price ${e} ${prices.reason}`)
        }
      }
    }
    const usdRequest = await rateDb.readData({}, undefined, {
      limit: 1,
      sort: { created: -1 },
    })
    if (usdRequest.status === StatusEnum.ok) {
      const price = usdRequest.data.result?.usdRate ?? 1
      rates = [...rates, { pair: 'USDTZUSD', price, exchange: 'all' }]
    } else {
      logger.error(`Snapshot | Cannot get user rates ${usdRequest.reason}`)
    }
    if (!skipBalance) {
      await Promise.all(
        users.data.result.map((u) =>
          updateUserBalance(u, undefined, !!paperContext, ec),
        ),
      )
    }
    logger.debug(`Snapshot | Found ${users.data.result.length} users`)

    // Tokenized-stock holdings (Kraken xStocks, Bybit spot xstocks, Hyperliquid
    // spot RWA) are NOT in the bulk `getAllPrices` rate table, so `findUSDRate`
    // returns 0 and they'd be dropped from the snapshot → $0.00 in the portfolio
    // UI. Price them venue-agnostically off the `pairs` collection: a holding
    // whose (exchange, pair-base) matches a stock/etf pair is valued via that
    // exchange's live `latestPrice` ticker (same source deal P&L uses). Preload
    // the stock/etf pairs once and cache each pair's price for the whole run.
    const stockPairMap = new Map<string, string>() // `${exchange}:${BASE}` → pair
    const stockPairs = await pairDb.readData<
      Pick<PairsSchema, 'exchange' | 'pair'> & { baseAsset: { name: string } }
    >(
      { assetCategory: { $in: ['stock', 'etf'] } },
      { exchange: 1, pair: 1, 'baseAsset.name': 1 },
      {},
      true,
    )
    if (stockPairs.status === StatusEnum.ok) {
      for (const p of stockPairs.data.result) {
        if (p.exchange && p.pair && p.baseAsset?.name) {
          stockPairMap.set(
            `${p.exchange}:${p.baseAsset.name.toUpperCase()}`,
            p.pair,
          )
        }
      }
    } else {
      logger.error(`Snapshot | Cannot read stock pairs ${stockPairs.reason}`)
    }
    const stockPriceCache = new Map<string, number>() // `${exchange}:${pair}` → usd
    const stockPriceProviders = new Map<
      string,
      ReturnType<ReturnType<typeof ec.chooseExchangeFactory>>
    >()
    const stockUsdRate = async (
      asset: string,
      exchange: string,
    ): Promise<number> => {
      const base = balanceAssetToPairBase(asset, exchange).toUpperCase()
      const pair = stockPairMap.get(`${exchange}:${base}`)
      if (!pair) return 0
      const cacheKey = `${exchange}:${pair}`
      const cached = stockPriceCache.get(cacheKey)
      if (cached !== undefined) return cached
      let provider = stockPriceProviders.get(exchange)
      if (!provider) {
        const factory = ec.chooseExchangeFactory(exchange as ExchangeEnum)
        if (!factory) {
          stockPriceCache.set(cacheKey, 0)
          return 0
        }
        provider = factory('', '')
        stockPriceProviders.set(exchange, provider)
      }
      try {
        const res = await provider.latestPrice(pair, true)
        const price =
          res.status === StatusEnum.ok && typeof res.data === 'number'
            ? res.data
            : 0
        stockPriceCache.set(cacheKey, price)
        return price
      } catch (e) {
        logger.error(`Snapshot | stock price ${exchange} ${pair} failed: ${e}`)
        stockPriceCache.set(cacheKey, 0)
        return 0
      }
    }

    for (const u of users.data.result) {
      let totalUsd = 0
      let assets: SnapshotSchema['assets'] = []
      const userId = u._id.toString()
      let exchangesTotal: SnapshotSchema['exchangesTotal'] = []
      const timezone = u.timezone
      const balances = await balanceDb.readData(
        { userId, paperContext: paperContext ? { $eq: true } : { $ne: true } },
        undefined,
        {},
        true,
      )
      if (balances.status === 'OK') {
        logger.debug(
          `Snapshot | User ${u.username} found ${balances.data.result.length} balances`,
        )
        const userExchanges = u.exchanges.map((e) => e.uuid)
        for (const b of balances.data.result.filter((b) =>
          userExchanges.includes(b.exchangeUUID),
        )) {
          const { asset } = b
          const { free, locked } = b
          const amount = free + locked
          if (amount !== 0) {
            let usdRate = findUSDRate(asset, rates, b.exchange)
            // Tokenized stocks aren't in the bulk rate table — fall back to the
            // exchange's live ticker keyed by the holding's tradeable pair.
            if (!usdRate) {
              usdRate = await stockUsdRate(asset, b.exchange)
            }
            const amountUsd = amount * usdRate
            if (amountUsd) {
              const find = assets.find((a) => a.name === asset)
              if (find) {
                find.amount += amount
                find.amountUsd += amountUsd
                find.exchanges = find.exchanges || []
                find.exchanges.push({
                  uuid: b.exchangeUUID,
                  amount,
                  amountUsd,
                })
                assets = [...assets.filter((a) => a.name !== asset), find]
              } else {
                assets.push({
                  name: asset,
                  amount,
                  amountUsd,
                  exchanges: [{ uuid: b.exchangeUUID, amount, amountUsd }],
                })
              }
              const findExchange = exchangesTotal.find(
                (e) => e.uuid === b.exchangeUUID,
              )
              if (findExchange) {
                findExchange.totalUsd += amountUsd
                exchangesTotal = [
                  ...exchangesTotal.filter((e) => e.uuid !== b.exchangeUUID),
                  findExchange,
                ]
              } else {
                exchangesTotal.push({
                  uuid: b.exchangeUUID,
                  totalUsd: amountUsd,
                })
              }
              totalUsd += amountUsd
            }
          }
        }
      } else {
        logger.error(`Snapshot | Cannot get balances ${balances.reason}`)
      }
      const utcDate = new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime()
      let updateTime = utcDate - getTimezoneOffset(timezone)
      if (isNaN(updateTime)) {
        updateTime = utcDate
      }
      const document = {
        userId,
        updateTime,
        totalUsd,
        assets,
        exchangesTotal,
      }

      const currentSnapshot = await snapshotDb.readData({
        updateTime,
        userId,
        paperContext: paperContext ? { $eq: true } : { $ne: true },
      })
      for (const e of exchangesTotal) {
        const currentDoc = await snapshotPerExchangeDb.readData({
          updateTime,
          userId,
          paperContext: paperContext ? { $eq: true } : { $ne: true },
          uuid: e.uuid,
        })
        if (currentDoc.status === 'OK' && currentDoc.data.result) {
          const data = await snapshotPerExchangeDb.updateData(
            { _id: currentDoc.data.result._id.toString() },
            {
              $set: {
                totalUsd: e.totalUsd,
              },
            },
          )
          if (data.status === 'OK') {
            logger.debug(
              `Snapshot per exchange | ${u.username} ${userId} ${e.uuid} updated`,
            )
          } else {
            logger.error(
              `Snapshot per exchange | ${u.username} ${userId} ${e.uuid} error ${data.reason}`,
            )
          }
        } else {
          const data = await snapshotPerExchangeDb.createData({
            userId,
            updateTime,
            totalUsd: e.totalUsd,
            paperContext: paperContext ? true : false,
            uuid: e.uuid,
          })
          if (data.status === 'OK') {
            logger.debug(
              `Snapshot per exchange | ${u.username} ${userId} ${e.uuid} saved`,
            )
          } else {
            logger.error(
              `Snapshot per exchange | ${u.username} ${userId} ${e.uuid} error ${data.reason}`,
            )
          }
        }
        // Dual-write the per-exchange point to the cloud ClickHouse mirror
        // (fire-and-forget, no-op unless SNAPSHOT_CH_ENABLED). Mongo above is
        // the source of truth; a dropped mirror write is only a long-history gap.
        SnapshotClient.getInstance().pushSnapshotPerExchange({
          userId,
          updateTime,
          uuid: e.uuid,
          totalUsd: e.totalUsd,
          paperContext: !!paperContext,
          updated: +new Date(),
        })
      }
      if (currentSnapshot.status === 'OK' && currentSnapshot.data.result) {
        const data = await snapshotDb.updateData(
          { _id: currentSnapshot.data.result._id.toString() },
          {
            $set: {
              ...document,
              paperContext,
            },
          },
        )
        if (data.status === 'OK') {
          logger.debug(`Snapshot | ${u.username} ${userId} updated`)
        } else {
          logger.error(
            `Snapshot | ${u.username} ${userId} error ${data.reason}`,
          )
        }
      } else {
        const data = await snapshotDb.createData({
          ...document,
          paperContext,
        })
        if (data.status === 'OK') {
          logger.debug(`Snapshot | ${u.username} ${userId} saved`)
        } else {
          logger.error(
            `Snapshot | ${u.username} ${userId} error ${data.reason}`,
          )
        }
      }
      // Dual-write the portfolio point to the cloud ClickHouse mirror
      // (fire-and-forget, no-op unless SNAPSHOT_CH_ENABLED). `raw` keeps the
      // full doc losslessly for future use; the chart reads only updateTime+totalUsd.
      SnapshotClient.getInstance().pushSnapshot({
        userId,
        updateTime,
        totalUsd,
        paperContext: !!paperContext,
        updated: +new Date(),
        raw: JSON.stringify({ ...document, paperContext }),
      })
    }
  } else {
    logger.error(`Snapshot | Cannot get users ${users.reason}`)
  }
  if (!paperContext && !onlyOneCycle) {
    userSnapshots(id, true, undefined, undefined, ec)
  }
}

const checkTokens = async () => {
  const removeTokens = await userDb.updateManyData(
    {},
    { $pull: { tokens: { expiredAt: { $lte: new Date() } } } },
  )
  if (removeTokens.status !== StatusEnum.ok) {
    logger.error(removeTokens.reason)
  }
}

export const updateUserSteps = async (
  userId: string,
  field: keyof ClearUserSchema['onboardingSteps'],
) => {
  await userDb.updateData(
    { _id: userId },
    { $set: { [`onboardingSteps.${field}`]: true } },
  )
}

const processing = new Set<string>()

export const resetUser = async (
  userId: string,
  type: ResetAccountTypeEnum,
  cb?: (
    userId: string,
    type: ResetAccountTypeEnum,
  ) => Promise<BaseReturn<string>>,
): Promise<ResetLogEntry[]> => {
  const prefix = `Reset user ${userId} ${type}`
  const log: ResetLogEntry[] = []
  const push = (entry: Omit<ResetLogEntry, 'at'>) => {
    log.push({ ...entry, at: new Date() })
  }
  if (!userId) {
    logger.error(`${prefix} | UserId is empty`)
    push({ step: 'precondition', status: 'error', reason: 'userId is empty' })
    return log
  }
  try {
    if (processing.has(userId)) {
      logger.debug(`${prefix} | Already in progress`)
      push({
        step: 'precondition',
        status: 'skipped',
        reason: 'already in progress',
      })
      return log
    }
    processing.add(userId)
    userId = userId.toString()
    logger.debug(`${prefix} | Start`)
    const userRequest = await userDb.readData({ _id: userId })
    if (userRequest.status === StatusEnum.notok) {
      logger.error(`${prefix} | Cannot read user ${userRequest.reason}`)
      push({ step: 'readUser', status: 'error', reason: userRequest.reason })
      processing.delete(userId)
      return log
    }
    if (!userRequest.data.result) {
      logger.error(`${prefix} | Cannot find user`)
      push({ step: 'readUser', status: 'error', reason: 'user not found' })
      processing.delete(userId)
      return log
    }
    const user = userRequest.data.result
    const isPaper = type === ResetAccountTypeEnum.paper
    const isLive = type === ResetAccountTypeEnum.live
    const isAll = type === ResetAccountTypeEnum.whole
    const isSoftLive = type === ResetAccountTypeEnum.softLive
    const Bot = BotService.getInstance()
    const paperFilter: Record<string, unknown> = {}
    if (isPaper) {
      paperFilter.paperContext = { $eq: true }
    }
    if (isLive || isSoftLive) {
      paperFilter.paperContext = { $ne: true }
    }
    const userWithPaperFilter = { userId, ...paperFilter }
    const bots =
      (await botDb.readData(userWithPaperFilter, {}, {}, true)).data?.result ??
      []
    const dcaBots =
      (await dcaBotDb.readData(userWithPaperFilter, {}, {}, true)).data
        ?.result ?? []
    const comboBots =
      (await comboBotDb.readData(userWithPaperFilter, {}, {}, true)).data
        ?.result ?? []
    logger.debug(
      `${prefix} | Found ${bots.length} bots, ${dcaBots.length} dca bots, ${comboBots.length} combo bots`,
    )
    const botIds = [...bots, ...dcaBots, ...comboBots].map((b) =>
      b._id.toString(),
    )
    const dcaBotsWithDeals = dcaBots.filter(
      (b) =>
        (b.status === BotStatusEnum.closed ||
          (b.status === BotStatusEnum.error &&
            b.previousStatus === BotStatusEnum.closed)) &&
        b.deals.active > 0,
    )
    const comboBotsWithDeals = comboBots.filter(
      (b) =>
        (b.status === BotStatusEnum.closed ||
          (b.status === BotStatusEnum.error &&
            b.previousStatus === BotStatusEnum.closed)) &&
        b.deals.active > 0,
    )
    if (dcaBotsWithDeals.length) {
      logger.debug(
        `${prefix} | Found ${dcaBotsWithDeals.length} dca bots with deals`,
      )
      const deals =
        (
          await dcaDealsDb.readData(
            {
              botId: { $in: dcaBotsWithDeals.map((b) => `${b._id}`) },
              status: {
                $in: [DCADealStatusEnum.open, DCADealStatusEnum.start],
              },
              ...paperFilter,
            },
            {},
            {},
            true,
          )
        )?.data?.result ?? []
      logger.debug(`${prefix} | Found ${deals.length} dca deals`)
      for (const d of deals) {
        await Bot.closeDCADeal(
          userId,
          d.botId,
          `${d._id}`,
          CloseDCATypeEnum.cancel,
          undefined,
          d.paperContext,
        )
      }
      logger.debug(`${prefix} | DCA deals closed`)
    }
    if (comboBotsWithDeals.length) {
      logger.debug(
        `${prefix} | Found ${comboBotsWithDeals.length} combo bots with deals`,
      )
      const deals =
        (
          await comboDealsDb.readData(
            {
              botId: { $in: comboBotsWithDeals.map((b) => `${b._id}`) },
              status: {
                $in: [DCADealStatusEnum.open, DCADealStatusEnum.start],
              },
              ...paperFilter,
            },
            {},
            {},
            true,
          )
        )?.data?.result ?? []
      logger.debug(`${prefix} | Found ${deals.length} combo deals`)
      for (const d of deals) {
        await Bot.closeComboDeal(
          userId,
          d.botId,
          `${d._id}`,
          CloseDCATypeEnum.cancel,
          undefined,
          d.paperContext,
        )
      }
      logger.debug(`${prefix} | Combo deals closed`)
    }
    const activeBots = bots.filter(
      (b) =>
        b.status === BotStatusEnum.open ||
        b.status === BotStatusEnum.range ||
        b.status === BotStatusEnum.error,
    )
    if (activeBots.length) {
      logger.debug(
        `${prefix} | Found ${activeBots.length} active bots, closing`,
      )
      for (const b of activeBots) {
        await Bot.changeStatus(
          userId,
          {
            status: BotStatusEnum.closed,
            id: b._id.toString(),
            cancelPartiallyFilled: true,
            type: BotType.grid,
            closeGridType: CloseGRIDTypeEnum.cancel,
          },
          !!b.paperContext,
        )
      }
      logger.debug(`${prefix} | Bots closed`)
    }

    const activeDCABots = dcaBots.filter(
      (b) =>
        b.status === BotStatusEnum.open ||
        b.status === BotStatusEnum.range ||
        b.status === BotStatusEnum.error,
    )
    if (activeDCABots.length) {
      logger.debug(
        `${prefix} | Found ${activeDCABots.length} active dca bots, closing`,
      )
      for (const b of activeDCABots) {
        await Bot.changeStatus(
          userId,
          {
            status: BotStatusEnum.closed,
            id: b.parentBotId || b._id.toString(),
            cancelPartiallyFilled: true,
            type: b.parentBotId ? BotType.hedgeDca : BotType.dca,
            closeType: CloseDCATypeEnum.cancel,
          },
          !!b.paperContext,
        )
      }
      logger.debug(`${prefix} | Bots closed`)
    }

    const activeComboBots = comboBots.filter(
      (b) =>
        b.status === BotStatusEnum.open ||
        b.status === BotStatusEnum.range ||
        b.status === BotStatusEnum.error,
    )
    if (activeComboBots.length) {
      logger.debug(
        `${prefix} | Found ${activeComboBots.length} active combo bots, closing`,
      )
      for (const b of activeComboBots) {
        await Bot.changeStatus(
          userId,
          {
            status: BotStatusEnum.closed,
            id: b.parentBotId || b._id.toString(),
            cancelPartiallyFilled: true,
            type: b.parentBotId ? BotType.hedgeCombo : BotType.combo,
            closeType: CloseDCATypeEnum.cancel,
          },
          !!b.paperContext,
        )
      }
      logger.debug(`${prefix} | Bots closed`)
    }

    const requests: {
      fn: Promise<ErrorResponse | MessageResponse>
      name: string
    }[] = []
    /** General */
    if (!isSoftLive) {
      if (isAll) {
        requests.push({ fn: feeDb.deleteManyData({ userId }), name: 'feeDb' })
      }
      if (isPaper) {
        requests.push({
          fn: feeDb.deleteManyData({
            userId,
            exchange: { $in: paperExchanges },
          }),
          name: 'feeDb',
        })
      }
      if (isLive) {
        requests.push({
          fn: feeDb.deleteManyData({
            userId,
            exchange: { $nin: paperExchanges },
          }),
          name: 'feeDb',
        })
      }
      requests.push({
        fn: balanceDb.deleteManyData(userWithPaperFilter),
        name: 'balanceDb',
      })
      requests.push({
        fn: snapshotDb.deleteManyData(userWithPaperFilter),
        name: 'snapshotDb',
      })
      // Purge the cloud ClickHouse snapshot mirror for the same scope (no-op
      // unless SNAPSHOT_CH_ENABLED). Scoped by paperContext for paper/live-only
      // resets; a whole-account reset (isAll) purges every context.
      requests.push({
        fn: SnapshotClient.getInstance()
          .snapshotDeleteByUser(
            userId,
            isPaper ? true : isLive || isSoftLive ? false : undefined,
          )
          .then(
            (r) =>
              ({
                status: StatusEnum.ok,
                reason: r?.ok ? 'purged' : (r?.error ?? 'skipped'),
                data: null,
              }) as MessageResponse,
          ),
        name: 'snapshotCh',
      })
      requests.push({
        fn: botEventDb.deleteManyData({ botId: { $in: botIds } }),
        name: 'botEventDb',
      })
      requests.push({
        fn: botMessageDb.deleteManyData(userWithPaperFilter),
        name: 'botMessageDb',
      })
      if (isAll) {
        requests.push({
          fn: botProfitChartDb.deleteManyData({ userId }),
          name: 'botProfitChartDb',
        })
      }
      if (isPaper || isLive) {
        requests.push({
          fn: botProfitChartDb.deleteManyData({
            userId,
            botId: { $in: botIds },
          }),
          name: 'botProfitChartDb',
        })
      }
      requests.push({
        fn: userProfitByHourDb.deleteManyData(userWithPaperFilter),
        name: 'userProfitByHourDb',
      })
      requests.push({
        fn: orderDb.deleteManyData(userWithPaperFilter),
        name: 'orderDb',
      })
      /** Bots */
      requests.push({
        fn: hedgeComboBotDb.deleteManyData(userWithPaperFilter),
        name: 'hedgeComboBotDb',
      })
      requests.push({
        fn: hedgeDCABotDb.deleteManyData(userWithPaperFilter),
        name: 'hedgeDCABotDb',
      })
      requests.push({
        fn: botDb.deleteManyData(userWithPaperFilter),
        name: 'botDb',
      })
      requests.push({
        fn: transactionDb.deleteManyData(userWithPaperFilter),
        name: 'transactionDb',
      })
      requests.push({
        fn: dcaBotDb.deleteManyData(userWithPaperFilter),
        name: 'dcaBotDb',
      })
      requests.push({
        fn: dcaDealsDb.deleteManyData(userWithPaperFilter),
        name: 'dcaDealsDb',
      })
      requests.push({
        fn: comboBotDb.deleteManyData(userWithPaperFilter),
        name: 'comboBotDb',
      })
      requests.push({
        fn: comboDealsDb.deleteManyData(userWithPaperFilter),
        name: 'comboDealsDb',
      })
      requests.push({
        fn: minigridDb.deleteManyData({
          botId: { $in: botIds },
          ...userWithPaperFilter,
        }),
        name: 'minigridDb',
      })
      requests.push({
        fn: comboProfitDb.deleteManyData(userWithPaperFilter),
        name: 'comboProfitDb',
      })
      requests.push({
        fn: comboTransactionsDb.deleteManyData(userWithPaperFilter),
        name: 'comboTransactionsDb',
      })
      /** Paper */
      if (isAll || isPaper) {
        const userPaperExchanges = user.exchanges
          .filter((e) => paperExchanges.includes(e.provider))
          .map((e) => decrypt(e.key))
        const paperUsers =
          (
            await paperUserDb.readData(
              {
                key: { $in: userPaperExchanges },
              },
              {},
              {},
              true,
            )
          )?.data?.result ?? []
        if (paperUsers.length) {
          logger.debug(`${prefix} | Found ${paperUsers.length} paper users`)
          const paperIds = paperUsers.map((p) => p._id)
          requests.push({
            fn: paperPositionDb.deleteManyData({
              user: { $in: paperIds },
            }),
            name: 'paperPositionDb',
          })
          requests.push({
            fn: paperHedgeDb.deleteManyData({
              user: { $in: paperIds },
            }),
            name: 'paperHedgeDb',
          })
          requests.push({
            fn: paperLeverageDb.deleteManyData({
              user: { $in: paperIds },
            }),
            name: 'paperLeverageDb',
          })

          requests.push({
            fn: paperOrderDb.deleteManyData({
              user: { $in: paperIds },
            }),
            name: 'paperOrderDb',
          })
          requests.push({
            fn: paperWalletsDb.deleteManyData({
              user: { $in: paperIds },
            }),
            name: 'paperWalletsDb',
          })
          requests.push({
            fn: paperUserDb.deleteManyData({
              _id: { $in: paperIds },
            }),
            name: 'paperUserDb',
          })
        }
      }

      await Promise.all(
        requests.map((r) =>
          r.fn.then((res) => {
            if (res.status === StatusEnum.ok) {
              logger.debug(`${prefix} | ${r.name} ${res.reason}`)
              push({
                step: 'deleteMany',
                collection: r.name,
                status: 'ok',
                reason: res.reason,
              })
            } else {
              logger.error(`${prefix} | ${r.name} delete error ${res.reason}`)
              push({
                step: 'deleteMany',
                collection: r.name,
                status: 'error',
                reason: res.reason,
              })
            }
          }),
        ),
      )
      // Cold-store mirror: the Mongo deletes above removed this user's bots +
      // their orders/transactions. Any COLD-archived bot among them keeps its
      // history in ClickHouse (the Mongo deleteMany hit nothing for it), so purge
      // those CH rows too. Only for real-data resets (live/whole) — a paper reset
      // touches no cold data, and softLive deletes nothing. Idempotent + non-fatal
      // (no-op for non-cold bots; the orphan sweep reconciles any miss). This is
      // the shared chokepoint for the automatic inactive hard-reset, the
      // settings-driven live/whole reset, and account deletion.
      if (isColdStoreEnabled() && (isLive || isAll) && botIds.length) {
        const purged = await ColdClient.getInstance().coldDelete(botIds)
        if (!purged?.ok) {
          logger.warn(
            `${prefix} | Cold-store purge failed for ${botIds.length} bot(s) — orphan sweep will reconcile`,
          )
        }
        push({
          step: 'coldStorePurge',
          status: purged?.ok ? 'ok' : 'error',
          reason: `${botIds.length} bot(s)`,
        })
      }
      const exchangesToDelete = (
        isAll
          ? user.exchanges
          : user.exchanges.filter((e) =>
              isPaper
                ? paperExchanges.includes(e.provider)
                : !paperExchanges.includes(e.provider),
            )
      ).map((e) => e.uuid)
      for (const uuid of exchangesToDelete) {
        disconnectUserBalance(uuid)
        await snapshotPerExchangeDb.deleteManyData({
          userId,
          uuid,
        })
      }
      const userUpdate = await userDb.updateData(
        { _id: userId },
        {
          $set: {
            exchanges: isAll
              ? []
              : user.exchanges.filter((e) =>
                  isPaper
                    ? !paperExchanges.includes(e.provider)
                    : paperExchanges.includes(e.provider),
                ),
          },
        },
      )
      if (userUpdate.status === StatusEnum.ok) {
        logger.debug(`${prefix} | User updated`)
        push({ step: 'updateUserExchanges', status: 'ok' })
      } else {
        logger.error(`${prefix} | User update error ${userUpdate.reason}`)
        push({
          step: 'updateUserExchanges',
          status: 'error',
          reason: userUpdate.reason,
        })
      }

      logger.debug(`${prefix} | User updated. Checking global vars`)
      const vars = await globalVarsDb.readData({ userId }, {}, {}, true)
      logger.debug(
        `${prefix} | Found ${vars.data?.result?.length ?? 0} global vars`,
      )
      await updateRelatedBotsInVar(
        (vars.data?.result ?? []).map((v) => `${v._id}`),
      )
    }
    if (cb) {
      const cbResult = await cb(userId, type)
      if (cbResult.status === StatusEnum.ok) {
        logger.debug(`${prefix} | Callback executed successfully`)
        push({ step: 'callback', status: 'ok' })
      } else {
        logger.error(`${prefix} | Callback error ${cbResult.reason}`)
        push({ step: 'callback', status: 'error', reason: cbResult.reason })
      }
    }
    processing.delete(userId)
    logger.debug(`${prefix} | End`)
    push({ step: 'end', status: 'ok' })
    return log
  } catch (e) {
    logger.error(`${prefix} | Error ${e}`)
    push({ step: 'exception', status: 'error', reason: `${e}` })
    processing.delete(userId)
    return log
  }
}

export const checkLicenseKey = async (
  licenseKey?: string,
  register?: boolean,
) => {
  const defaultResponse = { valid: false, isPremium: false }
  let lk = licenseKey
  let u: ClearUserSchema | undefined
  if (!lk) {
    const user = await userDb.readData()
    if (user.status === StatusEnum.notok) {
      logger.error(`checkLicenseKey | Cannot get user ${user.reason}`)
      return defaultResponse
    }
    if (!user.data.result || !user.data.result.licenseKey) {
      return defaultResponse
    }
    u = user.data.result
    lk = u.licenseKey
  }
  try {
    const getLicenseStatus = await axios
      .get<{ valid: boolean; isPremium: boolean }>(
        'https://api.gainium.io/license',
        {
          params: {
            key: lk,
            register,
          },
        },
      )
      .then(async (res) => {
        if (!res.data.valid && !licenseKey && u) {
          logger.error(`checkLicenseKey | License key is not valid.`)
          await userDb.updateData({ _id: u._id }, { $set: { licenseKey: '' } })
        }
        return res.data
      })
      .catch((e) => {
        logger.error(`checkLicenseKey | Cannot get license status ${e}`)
        return { valid: false, isPremium: false }
      })
    return getLicenseStatus
  } catch (e) {
    logger.error(`checkLicenseKey | Error ${e}`)
    return defaultResponse
  }
}

export default {
  connectUserBalance,
  updateUserFee,
  userSnapshots,
  disconnectUserBalance,
  checkTokens,
  resetUser,
}
