import ExchangeChooser from '../../exchange/exchangeChooser'
import logger from '../../utils/logger'
import { encrypt } from '../crypto'
import { brokerCodesDb, pairDb, rateDb } from '../../db/dbInit'
import RedisClient from '../../db/redis'
import { isPaper } from '../../exchange/paper/utils'
import utils from '../user'

import {
  ExchangeEnum,
  type ClearPairsSchema,
  type AssetClass,
  type ExchangeInfo,
  type RateSchema,
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
        // not carry the connector's `assetClass` or `isCanonical`. Mirror both
        // from the already-synced real twin (paperHyperliquid → hyperliquid) so
        // paper pairs classify and filter identically. Real twins precede their
        // paper copy in `providers`, so the lookup is populated by the time we
        // reach paper.
        let paperRealMap:
          | Map<string, { assetCategory?: AssetClass; isCanonical?: boolean }>
          | undefined
        if (isPaper(provider)) {
          const realName = provider.replace(/^paper/, '')
          const realExchange = (realName.charAt(0).toLowerCase() +
            realName.slice(1)) as ExchangeEnum
          const realPairs = await pairDb.readData<ClearPairsSchema>(
            { exchange: realExchange },
            { pair: 1, assetCategory: 1, isCanonical: 1 },
            {},
            true,
            true,
          )
          if (realPairs.status === StatusEnum.ok) {
            paperRealMap = new Map(
              realPairs.data.result.map((p) => [
                p.pair,
                { assetCategory: p.assetCategory, isCanonical: p.isCanonical },
              ]),
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
                ? paperRealMap.get(info.pair)?.assetCategory
                : info.assetClass,
            })
            // Canonical/curated-listing flag (HL spot only). Paper twins have
            // no signal of their own, so mirror the real twin; otherwise take
            // the connector's value (undefined for every non-HL exchange =>
            // treated as canonical by the picker).
            const isCanonical = paperRealMap
              ? paperRealMap.get(info.pair)?.isCanonical
              : info.isCanonical
            if (getPair) {
              if (
                getPair.wsCode !== info.wsCode ||
                // Treat an assetCategory change as an update so existing pairs
                // get backfilled on the next cron run.
                getPair.assetCategory !== assetCategory ||
                // Same for the canonical flag (undefined -> bool backfills on
                // first run; then only rewrites when it actually changes).
                getPair.isCanonical !== isCanonical ||
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
                  isCanonical,
                  _id,
                })
              }
            }
            if (!getPair) {
              createMap.push({
                ...info,
                exchange: provider,
                assetCategory,
                isCanonical,
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
/**
 * Reconcile an OKX Europe (`source: 'my'`) instrument list into the shared `pairs`
 * collection under `exchange`, writing only changed rows and pruning stale ones.
 * Shared by the SPOT and X-Perp refreshers, and used for both the real exchange id
 * (okx / okxLinear) and its paper twin (paperOkx / paperOkxLinear) so EU accounts
 * see their real universe in live and paper alike. Never wipes on an empty list.
 */
async function reconcileEuPairs(
  exchange: ExchangeEnum,
  data: (ExchangeInfo & { pair: string })[],
  approx = false,
): Promise<void> {
  if (!data.length) {
    logger.error(
      `OKX-EU pairs | ${exchange} empty instrument list; skipping reconcile`,
    )
    return
  }
  const existing = await pairDb.readData<ClearPairsSchema>(
    { exchange, source: OKXSource.my },
    undefined,
    {},
    true,
    true,
  )
  if (existing.status !== StatusEnum.ok) {
    logger.error(`OKX-EU pairs | ${exchange} read failed: ${existing.reason}`)
    return
  }
  const dbByPair = new Map(existing.data.result.map((p) => [p.pair, p]))
  const seen = new Set<string>()
  let created = 0
  let updated = 0
  for (const item of data) {
    seen.add(item.pair)
    const assetCategory = classifyAssetClass({
      exchange,
      pair: item.pair,
      baseAsset: item.baseAsset.name,
      quoteAsset: item.quoteAsset.name,
      connectorAssetClass: item.assetClass,
    })
    const doc = {
      ...item,
      exchange,
      source: OKXSource.my,
      assetCategory,
      approx,
    }
    const found = dbByPair.get(item.pair)
    if (!found) {
      await pairDb.createData({ ...doc })
      created++
      continue
    }
    // Only write when a tracked field actually changed — the EU set is stable,
    // so most reconciles are no-ops. `multiplier` matters for X-Perps (contract
    // size); it's undefined for spot so this stays a no-op there.
    const changed =
      found.wsCode !== item.wsCode ||
      found.code !== item.code ||
      found.assetCategory !== assetCategory ||
      Boolean(found.approx) !== approx ||
      found.baseAsset.name !== item.baseAsset.name ||
      found.baseAsset.minAmount !== item.baseAsset.minAmount ||
      found.baseAsset.step !== item.baseAsset.step ||
      found.baseAsset.maxAmount !== item.baseAsset.maxAmount ||
      found.baseAsset.multiplier !== item.baseAsset.multiplier ||
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
  // Live bots subscribe on the real ids only; paper twins need no broadcast.
  if (!isPaper(exchange)) {
    const redis = await RedisClient.getInstance()
    redis?.publish(
      'updateexchangeInfo',
      JSON.stringify({ exchange, pairs: data.map((p) => p.pair) }),
    )
  }
  logger.debug(
    `OKX-EU pairs | ${exchange} reconciled ${data.length} (${created} new, ${updated} changed, ${stale.length} removed)`,
  )
}

/**
 * Refresh the OKX Europe (`okxSource=my`) authoritative SPOT pair universe
 * (USDC/EUR) for both the real (`okx`) and paper (`paperOkx`) ids. Account-scoped
 * and account-agnostic — any connected EU account refreshes it for every EU user.
 */
export async function updateOkxEuPairs(auth: {
  key: string
  secret: string
  passphrase?: string
}): Promise<void> {
  const factory = ExchangeChooser.chooseExchangeFactory(ExchangeEnum.okx)
  if (!factory) return
  // `Exchange`'s constructor (via AbstractExchange) unconditionally decrypts
  // key/secret/passphrase, since every other caller passes them straight out
  // of the DB (encrypted at rest). `auth` here is the raw plaintext addExchange
  // input, never encrypted — decrypting it as-if it were ciphertext silently
  // corrupts it (CryptoJS decrypt of a non-ciphertext string), most visibly
  // emptying the passphrase, which the connector then rejects with
  // "Private endpoints require api and secret ... in the REST client
  // constructor". Encrypt here first so the constructor's decrypt round-trips
  // correctly — mirrors what the real-account creation path above already
  // does (`encrypt(key), encrypt(secret), passphrase ? encrypt(passphrase) : ''`).
  const exchange = factory(
    encrypt(auth.key),
    encrypt(auth.secret),
    auth.passphrase ? encrypt(auth.passphrase) : '',
    undefined,
    undefined,
    OKXSource.my,
  )
  const info = await exchange.getAccountSpotExchangeInfo()
  if (info.status !== StatusEnum.ok) {
    logger.error(`OKX-EU pairs | spot fetch failed: ${info.reason}`)
    return
  }
  await reconcileEuPairs(ExchangeEnum.okx, info.data)
  await reconcileEuPairs(ExchangeEnum.paperOkx, info.data)
}

/**
 * Keyless best-effort stand-in for `updateOkxEuPairs`, for instances where no
 * real my.okx.com account has ever connected (paper-only self-hosters). OKX's
 * public spot instrument list is identical globally and via eea.okx.com (no
 * region filtering in public market data — verified 2026-07), so the true
 * EU-tradeable set can't be read off it directly. But filtering that public
 * list to `quoteCcy ∈ {EUR, USDC}` and `baseCcy !== 'USDT'` (USDT itself isn't
 * offered on the EU venue, so e.g. `USDT-EUR` must also be excluded) was
 * verified 2026-07 against a real connected EU account's authoritative
 * `/account/instruments` response: **exact match, all 528 pairs, zero
 * discrepancies either direction**. Never overwrites real data — skips
 * entirely if any non-approximated (`approx` absent/false) row already exists
 * for `okx`, so a real account connecting later always wins and stays won.
 */
export async function updateOkxEuSpotApproxPairs(): Promise<void> {
  const existingReal = await pairDb.readData<ClearPairsSchema>(
    { exchange: ExchangeEnum.okx, source: OKXSource.my, approx: { $ne: true } },
    undefined,
    {},
    true,
    true,
  )
  if (existingReal.status === StatusEnum.ok && existingReal.data.result.length) {
    logger.debug(
      'OKX-EU pairs | spot approximation skipped — real account data already present',
    )
    return
  }
  const factory = ExchangeChooser.chooseExchangeFactory(ExchangeEnum.okx)
  if (!factory) return
  const exchange = factory('', '', undefined, undefined, undefined, undefined)
  const info = await exchange.getAllExchangeInfo()
  if (info.status !== StatusEnum.ok) {
    logger.error(`OKX-EU pairs | spot approximation fetch failed: ${info.reason}`)
    return
  }
  const filtered = info.data.filter(
    (p) =>
      (p.quoteAsset.name === 'EUR' || p.quoteAsset.name === 'USDC') &&
      p.baseAsset.name !== 'USDT',
  )
  if (!filtered.length) {
    logger.error(
      'OKX-EU pairs | spot approximation empty after EUR/USDC filter; skipping',
    )
    return
  }
  await reconcileEuPairs(ExchangeEnum.okx, filtered, true)
  await reconcileEuPairs(ExchangeEnum.paperOkx, filtered, true)
}

/**
 * Refresh the OKX Europe (`okxSource=my`) authoritative X-Perp universe
 * (instType=FUTURES, ruleType=xperp; e.g. `BTC-USD_UM_XPERP`) for both the real
 * (`okxLinear`) and paper (`paperOkxLinear`) ids. Unlike EU spot (whose tradeable
 * set is account-restricted), X-Perps are identical for everyone and fully visible
 * on the *public* eea.okx.com feed — so this needs no account keys and runs from
 * the global cron, making EU perps available to paper-only users too. The connector
 * routes okxSource=my → eea.okx.com and keeps only ruleType=xperp rows.
 */
export async function updateOkxEuPerpPairs(): Promise<void> {
  const factory = ExchangeChooser.chooseExchangeFactory(ExchangeEnum.okxLinear)
  if (!factory) return
  const exchange = factory('', '', undefined, undefined, undefined, OKXSource.my)
  const info = await exchange.getAllExchangeInfo()
  if (info.status !== StatusEnum.ok) {
    logger.error(`OKX-EU pairs | perp fetch failed: ${info.reason}`)
    return
  }
  await reconcileEuPairs(ExchangeEnum.okxLinear, info.data)
  await reconcileEuPairs(ExchangeEnum.paperOkxLinear, info.data)
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

/**
 * Fiat currencies that multi-collateral venues (Kraken Futures) accept as
 * margin, with the Kraken spot pair that prices them. Kraken quotes some fiat
 * with USD as the BASE (USD/JPY), so `invert` says whether the ticker has to be
 * flipped to get "1 unit of asset = X USD".
 *
 * Fiat holdings are absent from every exchange's `getAllPrices` table (Kraken
 * Futures only publishes `PF_*` perpetual tickers), so `findUSDRate` returns 0
 * and the holding shows as $0.00 in the portfolio. These rates are injected
 * into the rate table under exchange `all` to close that gap.
 */
const FIAT_USD_PAIRS = [
  { asset: 'EUR', pair: 'EURUSD', invert: false },
  { asset: 'GBP', pair: 'GBPUSD', invert: false },
  { asset: 'AUD', pair: 'AUDUSD', invert: false },
  { asset: 'CHF', pair: 'USDCHF', invert: true },
  { asset: 'JPY', pair: 'USDJPY', invert: true },
  { asset: 'CAD', pair: 'USDCAD', invert: true },
]

/**
 * One ticker call per pair: Kraken answers with its own canonical key
 * (`EURUSD` → `ZEURZUSD`), so asking for a single pair lets us take the only
 * entry instead of guessing how to normalize the key. A pair that fails keeps
 * its previous rate — a transient Kraken hiccup must not zero out everyone's
 * fiat balances until the next run twelve hours later.
 */
const getFiatRates = async (
  previous: RateSchema['fiatRates'] = [],
): Promise<RateSchema['fiatRates']> => {
  const exchangeKraken = new Kraken()
  const rates: NonNullable<RateSchema['fiatRates']> = []
  for (const { asset, pair, invert } of FIAT_USD_PAIRS) {
    const prev = previous?.find((p) => p.asset === asset)
    try {
      const ticker = await exchangeKraken.ticker({ pair })
      const price = parseFloat(Object.values(ticker ?? {})[0]?.c?.[0] ?? '0')
      if (!price || !isFinite(price)) {
        throw new Error(`no price in ticker for ${pair}`)
      }
      rates.push({ asset, usdRate: invert ? 1 / price : price })
    } catch (e) {
      logger.error(`Get fiat rate ${pair} failed: ${e}`)
      if (prev) rates.push(prev)
    }
  }
  return rates
}

export const saveRate = async () => {
  const usdRate = await updateRate()
  const lastRate = await rateDb.readData<RateSchema>({}, undefined, {
    limit: 1,
    sort: { created: -1 },
  })
  const fiatRates = await getFiatRates(
    lastRate.status === StatusEnum.ok
      ? lastRate.data.result?.fiatRates
      : undefined,
  )
  rateDb
    .createData({ usdRate, fiatRates })
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
    .then(() => updateOkxEuPerpPairs())
    .then(() => updateOkxEuSpotApproxPairs())
    .then(() => utils.updateUserFee())
