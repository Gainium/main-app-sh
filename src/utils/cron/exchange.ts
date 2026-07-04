import ExchangeChooser from '../../exchange/exchangeChooser'
import logger from '../../utils/logger'
import { brokerCodesDb, pairDb, rateDb } from '../../db/dbInit'
import RedisClient from '../../db/redis'
import { isPaper } from '../../exchange/paper/utils'
import utils from '../user'

import {
  ExchangeEnum,
  type ClearPairsSchema,
  type AssetClass,
  StatusEnum,
  OKXSource,
} from '../../../types'
import { classifyAssetClass } from '../assetClass'
import { Kraken } from 'node-kraken-api'
import axios from 'axios'

const providers = [
  ExchangeEnum.binance,
  ExchangeEnum.kucoin,
  ExchangeEnum.bybit,
  ExchangeEnum.binanceUS,
  ExchangeEnum.paperBinance,
  ExchangeEnum.paperKucoin,
  ExchangeEnum.paperBybit,
  ExchangeEnum.binanceCoinm,
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.paperBinanceCoinm,
  ExchangeEnum.paperBinanceUsdm,
  ExchangeEnum.bybitCoinm,
  ExchangeEnum.bybitUsdm,
  ExchangeEnum.paperBybitCoinm,
  ExchangeEnum.paperBybitUsdm,
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
  ExchangeEnum.paperBitgetUsdm,
  ExchangeEnum.bitgetCoinm,
  ExchangeEnum.paperBitgetCoinm,
  ExchangeEnum.hyperliquid,
  ExchangeEnum.paperHyperliquid,
  ExchangeEnum.hyperliquidLinear,
  ExchangeEnum.paperHyperliquidLinear,
  ExchangeEnum.kraken,
  ExchangeEnum.paperKraken,
  ExchangeEnum.krakenUsdm,
  ExchangeEnum.paperKrakenUsdm,
]

export const updateExchangeInfo = async (ec = ExchangeChooser) => {
  const updateBotMap: Map<ExchangeEnum, ClearPairsSchema[]> = new Map()
  const deleteBotMap: Map<ExchangeEnum, string[]> = new Map()
  for (const provider of providers) {
    const choose = ec.chooseExchangeFactory(provider)
    if (choose) {
      const exchange = choose('', '')
      const exchangeInfo = await exchange.getAllExchangeInfo()
      if (exchangeInfo.status === 'OK' && exchangeInfo.data.length > 1) {
        const updateMap: Map<string, ClearPairsSchema> = new Map()
        const createMap: Omit<ClearPairsSchema, '_id'>[] = []
        const deleteSet: Set<string> = new Set()
        const allDbPairs = await pairDb.readData(
          { exchange: provider },
          undefined,
          {},
          true,
          true,
        )
        // Paper exchanges proxy exchange-info through paper-trading, which does
        // not carry the connector's `assetClass`. Mirror the class from the
        // already-synced real twin (paperBitget → bitget) so paper pairs are
        // classified identically. Real twins precede their paper copy in
        // `providers`, so the lookup is populated by the time we reach paper.
        let paperRealMap: Map<string, AssetClass | undefined> | undefined
        if (isPaper(provider)) {
          const realName = provider.replace(/^paper/, '')
          const realExchange = (realName.charAt(0).toLowerCase() +
            realName.slice(1)) as ExchangeEnum
          const realPairs = await pairDb.readData<ClearPairsSchema>(
            { exchange: realExchange },
            { pair: 1, assetCategory: 1 },
            {},
            true,
            true,
          )
          if (realPairs.status === StatusEnum.ok) {
            paperRealMap = new Map(
              realPairs.data.result.map((p) => [p.pair, p.assetCategory]),
            )
          }
        }
        if (allDbPairs.status === StatusEnum.ok) {
          for (const info of exchangeInfo.data) {
            const getPair = allDbPairs.data.result.find(
              (p) => p.pair === info.pair,
            )
            // Asset class comes from the exchange's authoritative signal
            // (connector); paper twins inherit it from their real exchange.
            const assetCategory = classifyAssetClass({
              exchange: provider,
              pair: info.pair,
              baseAsset: info.baseAsset.name,
              quoteAsset: info.quoteAsset.name,
              connectorAssetClass: paperRealMap
                ? paperRealMap.get(info.pair)
                : info.assetClass,
            })
            if (getPair) {
              if (
                getPair.wsCode !== info.wsCode ||
                // Treat an assetCategory change as an update so existing pairs
                // get backfilled on the next cron run.
                getPair.assetCategory !== assetCategory ||
                getPair.code !== info.code ||
                getPair.baseAsset.name !== info.baseAsset.name ||
                getPair.baseAsset.minAmount !== info.baseAsset.minAmount ||
                getPair.baseAsset.step !== info.baseAsset.step ||
                getPair.baseAsset.maxAmount !== info.baseAsset.maxAmount ||
                getPair.baseAsset.maxMarketAmount !==
                  info.baseAsset.maxMarketAmount ||
                getPair.quoteAsset.minAmount !== info.quoteAsset.minAmount ||
                getPair.quoteAsset.name !== info.quoteAsset.name ||
                getPair.quoteAsset.precision !== info.quoteAsset.precision ||
                getPair.maxOrders !== info.maxOrders ||
                getPair.priceAssetPrecision !== info.priceAssetPrecision ||
                getPair.priceMultiplier?.decimals !==
                  info.priceMultiplier?.decimals ||
                getPair.priceMultiplier?.down !== info.priceMultiplier?.down ||
                getPair.priceMultiplier?.up !== info.priceMultiplier?.up ||
                getPair.baseAsset.multiplier !== info.baseAsset.multiplier ||
                (typeof getPair.crossAvailable === 'undefined' &&
                  typeof info.crossAvailable !== 'undefined') ||
                (typeof getPair.crossAvailable !== 'undefined' &&
                  typeof info.crossAvailable === 'undefined') ||
                getPair.crossAvailable !== info.crossAvailable
              ) {
                const _id = getPair._id.toString()
                updateMap.set(_id, {
                  ...info,
                  exchange: provider,
                  assetCategory,
                  _id,
                })
              }
            }
            if (!getPair) {
              createMap.push({
                ...info,
                exchange: provider,
                assetCategory,
              })
            }
          }
          for (const old of allDbPairs.data.result) {
            const find = exchangeInfo.data.find((p) => p.pair === old.pair)
            if (!find) {
              deleteSet.add(old._id.toString())
            }
          }
          for (const [_id, data] of updateMap) {
            await pairDb
              .updateData({ _id: _id }, { $set: { ...data } })
              .then((res) => {
                if (res.status === StatusEnum.ok) {
                  logger.debug(
                    `Pairs update | ${data.pair}@${data.exchange} updated`,
                  )
                }
                if (res.status === StatusEnum.notok) {
                  logger.error(
                    `Pairs update | ${data.pair}@${data.exchange} error, reason: ${res.reason}`,
                  )
                }
              })
          }

          if (updateMap.size) {
            for (const u of updateMap.values()) {
              updateBotMap.set(
                u.exchange,
                (updateBotMap.get(u.exchange) ?? []).concat(u),
              )
            }
          }
          for (const data of createMap) {
            await pairDb.createData({ ...data }).then((res) => {
              if (res.status === StatusEnum.ok) {
                logger.debug(
                  `Pairs update | ${data.pair}@${data.exchange} created`,
                )
              }
              if (res.status === StatusEnum.notok) {
                logger.error(
                  `Pairs update | ${data.pair}@${data.exchange} error, reason: ${res.reason}`,
                )
              }
            })
          }
          if (deleteSet.size !== 0) {
            deleteBotMap.set(provider, [...deleteSet])
            await pairDb
              .deleteManyData({ _id: { $in: Array.from(deleteSet) } })
              .then((res) => {
                if (res.status === StatusEnum.ok) {
                  logger.debug(`Pairs update | ${res.reason}`)
                }
                if (res.status === StatusEnum.notok) {
                  logger.error(
                    `Pairs update | Delete data error | reason: ${res.reason}`,
                  )
                }
              })
          }
        } else {
          logger.error(
            `Pairs update | Cannot get all pairs: ${allDbPairs.reason}`,
          )
        }
      } else {
        logger.error(
          `Pairs update | ${provider} error: ${
            exchangeInfo.reason ??
            `array length ${exchangeInfo.data?.length ?? 0}`
          }`,
        )
      }
    }
  }
  for (const [k, v] of updateBotMap.entries()) {
    if (!isPaper(k)) {
      const redis = await RedisClient.getInstance()
      redis?.publish(
        'updateexchangeInfo',
        JSON.stringify({ exchange: k, pairs: v.map((p) => p.pair) }),
      )
    }
  }
  for (const [k, v] of deleteBotMap.entries()) {
    if (!isPaper(k)) {
      const redis = await RedisClient.getInstance()
      redis?.publish(
        'updateexchangeInfo',
        JSON.stringify({ exchange: k, deletePairs: v }),
      )
    }
  }
}

/**
 * Refresh the OKX Europe (`okxSource=my`) authoritative SPOT pair universe.
 *
 * OKX Europe (eea.okx.com) accounts can only trade USDC/EUR spot, but the public
 * instruments feed the global pairs cron uses advertises the USDT set they cannot
 * touch. So we fetch the *account-scoped* list (authenticated) and reconcile it
 * into the shared `pairs` collection tagged `source: 'my'`, distinct from the
 * global OKX docs (which carry no `source`). The EU universe is account-agnostic
 * — identical for every EU user — so the first account to connect refreshes it
 * for all of them. Unauthenticated / non-OKX callers can't reach this path.
 *
 * Phase 1 = spot only; X-Perp futures (instType FUTURES) are handled separately.
 */
export async function updateOkxEuPairs(auth: {
  key: string
  secret: string
  passphrase?: string
}): Promise<void> {
  const factory = ExchangeChooser.chooseExchangeFactory(ExchangeEnum.okx)
  if (!factory) return
  const exchange = factory(
    auth.key,
    auth.secret,
    auth.passphrase,
    undefined,
    undefined,
    OKXSource.my,
  )
  const info = await exchange.getAccountSpotExchangeInfo()
  if (info.status !== StatusEnum.ok) {
    logger.error(`OKX-EU pairs | fetch failed: ${info.reason}`)
    return
  }
  if (!info.data.length) {
    // Never wipe the shared list off an empty/error response.
    logger.error('OKX-EU pairs | empty instrument list; skipping reconcile')
    return
  }
  const existing = await pairDb.readData<ClearPairsSchema>(
    { exchange: ExchangeEnum.okx, source: OKXSource.my },
    undefined,
    {},
    true,
    true,
  )
  if (existing.status !== StatusEnum.ok) {
    logger.error(`OKX-EU pairs | read failed: ${existing.reason}`)
    return
  }
  const dbByPair = new Map(existing.data.result.map((p) => [p.pair, p]))
  const seen = new Set<string>()
  let created = 0
  let updated = 0
  for (const item of info.data) {
    seen.add(item.pair)
    const assetCategory = classifyAssetClass({
      exchange: ExchangeEnum.okx,
      pair: item.pair,
      baseAsset: item.baseAsset.name,
      quoteAsset: item.quoteAsset.name,
      connectorAssetClass: item.assetClass,
    })
    const doc = {
      ...item,
      exchange: ExchangeEnum.okx,
      source: OKXSource.my,
      assetCategory,
    }
    const found = dbByPair.get(item.pair)
    if (!found) {
      await pairDb.createData({ ...doc })
      created++
      continue
    }
    // Only write when a tracked field actually changed — the EU set is stable,
    // so most reconciles are no-ops.
    const changed =
      found.wsCode !== item.wsCode ||
      found.code !== item.code ||
      found.assetCategory !== assetCategory ||
      found.baseAsset.name !== item.baseAsset.name ||
      found.baseAsset.minAmount !== item.baseAsset.minAmount ||
      found.baseAsset.step !== item.baseAsset.step ||
      found.baseAsset.maxAmount !== item.baseAsset.maxAmount ||
      found.quoteAsset.name !== item.quoteAsset.name ||
      found.quoteAsset.minAmount !== item.quoteAsset.minAmount ||
      found.priceAssetPrecision !== item.priceAssetPrecision
    if (changed) {
      const _id = found._id.toString()
      await pairDb.updateData({ _id }, { $set: { ...doc, _id } })
      updated++
    }
  }
  const stale = existing.data.result
    .filter((p) => !seen.has(p.pair))
    .map((p) => p._id.toString())
  if (stale.length) {
    await pairDb.deleteManyData({ _id: { $in: stale } })
  }
  const redis = await RedisClient.getInstance()
  redis?.publish(
    'updateexchangeInfo',
    JSON.stringify({
      exchange: ExchangeEnum.okx,
      pairs: info.data.map((p) => p.pair),
    }),
  )
  logger.debug(
    `OKX-EU pairs | reconciled ${info.data.length} (${created} new, ${updated} changed, ${stale.length} removed)`,
  )
}

const getRate = async () => {
  const exchangeKraken = new Kraken()
  const ticker = await exchangeKraken
    .ticker({ pair: 'USDTUSD' })
    .then((res) => ({ status: 'OK', result: res }))
    .catch((e: Error) => ({
      status: 'NOTOK',
      result: e.message,
    }))
  if (
    ticker.status === 'OK' &&
    ticker.result &&
    typeof ticker.result !== 'string' &&
    ticker.result.USDTZUSD &&
    ticker.result.USDTZUSD.c
  ) {
    return {
      status: 'OK',
      usdRate: parseFloat(ticker.result.USDTZUSD.c[0]),
      reason: null,
    }
  }
  return { status: 'NOTOK', usdRate: 0, reason: ticker.result }
}

const updateRate = async (): Promise<number> => {
  const rate = await getRate()
  if (rate.status === StatusEnum.ok) {
    return rate.usdRate
  } else {
    logger.error(`Get USD Rate reason: ${rate.reason}`)
    const newRes = await updateRate()
    return newRes
  }
}

export const saveRate = async () => {
  const usdRate = await updateRate()
  rateDb
    .createData({ usdRate })
    .then((r) =>
      r.status === StatusEnum.notok
        ? logger.error(`Save USD rate reason: ${r.reason}`)
        : null,
    )
}

const updateBrokerCodes = async () => {
  await axios
    .get<{ exchange: ExchangeEnum; zone?: string; code: string }[]>(
      'https://api.gainium.io/broker-codes?v=2',
    )
    .then(async (res) => {
      if (res.data?.length) {
        for (const item of res.data) {
          await brokerCodesDb
            .updateData(
              { exchange: item.exchange, zone: item.zone },
              { exchange: item.exchange, zone: item.zone, code: item.code },
              false,
              true,
              true,
            )
            .then((r) => {
              logger.debug(
                `updateBrokerCodes | ${item.exchange}${item.zone ? `@${item.zone}` : ''} code updated: ${item.code}, result: ${r.status}`,
              )
            })
        }
      }
    })
    .catch((e) => logger.error(`updateBrokerCodes | Error: ${e.message}`))
}

export const exchangeFullUpdate = () =>
  updateBrokerCodes()
    .then(() => updateExchangeInfo())
    .then(() => utils.updateUserFee())
