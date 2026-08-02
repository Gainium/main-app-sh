import type { Prices } from '../../types'
import { ExchangeEnum } from '../../types'
import moment from 'moment-timezone'

/**
 * Sleep function
 *
 * @param {number} millisecond ms to sleep
 */
const sleep = (milliseconds: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const getTimezoneOffset = (timeZone: string, date = new Date()) => {
  // Returns offset in milliseconds using moment-timezone for reliability
  return moment.tz(date, timeZone).utcOffset() * 60 * 1000
}

/**
 * Function to generate random string, that used as order id
 *
 * @param {number} length Length of the returned string
 * @returns {string} Random string given length
 */
const id = (length: number): string => {
  let result = ''
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const charactersLength = characters.length
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength))
  }
  return result
}

const getWeek = (time: Date, timezone: string) => {
  const onejan =
    new Date(time.getFullYear(), 0, 1).getTime() + getTimezoneOffset(timezone)
  const current =
    new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime() +
    getTimezoneOffset(timezone)
  const dayOfYear = (current - onejan + 86400000) / 86400000
  return Math.ceil(dayOfYear / 7)
}

const findAsset = (base: string, quote: string) => (pr: Prices[0]) => {
  const p = pr.pair.split('_')[0]
  return (
    p === `${base}${quote}` ||
    p === `${base}-${quote}` ||
    p === `${base}/${quote}` ||
    p === `${base}Z${quote}`
  )
}

const findRate = (
  base: string,
  quote: string,
  prices: Prices,
  reverse = false,
): number | undefined => {
  const rate = prices.find(findAsset(base, quote))
  if (rate) {
    return reverse ? 1 / rate.price : rate.price
  }
  if (!reverse) {
    return findRate(quote, base, prices, true)
  }
}

const findUSDRate = (asset: string, _prices: Prices, exchange?: string) => {
  const prices = _prices.filter((p) =>
    exchange ? [exchange, 'all'].includes(p.exchange) : true,
  )
  asset = asset
    .replace('SBTC', 'BTC')
    .replace('SUSD', 'USD')
    .replace('SUSDT', 'USDT')
    .replace('UBTC', 'BTC')
  if (asset === 'USD') {
    return 1
  }
  let usdRate = Number(
    asset === 'USDT' ||
      (exchange?.toLowerCase().includes('hyperliquid') && asset === 'USDC'),
  )
  let usdtRate = Number(
    asset === 'USDT' ||
      (exchange?.toLowerCase().includes('hyperliquid') && asset === 'USDC'),
  )
  if (asset !== 'USDT') {
    const findUsdtRate =
      findRate(asset, 'USDT', prices) ||
      (exchange?.toLowerCase().includes('hyperliquid') &&
        findRate(asset, 'USDC', prices))
    if (findUsdtRate) {
      usdtRate = findUsdtRate
      usdRate = usdtRate
    } else {
      const _findUsdRate = findRate(asset, 'USD', prices)
      if (_findUsdRate) {
        return _findUsdRate
      }
      const findBtcRate = findRate(asset, 'BTC', prices)
      if (findBtcRate) {
        const findBtcUsdtRate = findRate('BTC', 'USDT', prices)
        if (findBtcUsdtRate) {
          usdtRate = findBtcRate * findBtcUsdtRate
          usdRate = usdtRate
        }
      }
    }
  }
  const findUsdtUsdRate = findRate('USDT', 'USD', prices)
  if (findUsdtUsdRate) {
    usdRate = usdtRate * findUsdtUsdRate
  }
  return usdRate
}

const getDateDiffInDays = (a: Date, b: Date) => {
  const _MS_PER_DAY = 1000 * 60 * 60 * 24
  const utc1 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const utc2 = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())

  return Math.floor((utc2 - utc1) / _MS_PER_DAY)
}

const mapToArray = (initialMap: Map<string, unknown>) => {
  return Array.from(initialMap, ([key, value]) => ({ key, value }))
}

const mapToObject = <T>(initialMap: Map<string, T>): { [x: string]: T } => {
  try {
    return [...initialMap.entries()].reduce(
      (acc, v) => {
        acc[v[0]] = v[1]
        return acc
      },
      {} as { [x: string]: T },
    )
  } catch (e) {
    return {}
  }
}

const checkNumber = (num?: string) => {
  return num && num !== '' && !isNaN(+num)
}

export const getRealFutures = () => [
  ExchangeEnum.binanceCoinm,
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.bybitCoinm,
  ExchangeEnum.bybitUsdm,
  ExchangeEnum.okxInverse,
  ExchangeEnum.okxLinear,
  ExchangeEnum.kucoinInverse,
  ExchangeEnum.kucoinLinear,
  ExchangeEnum.bitgetCoinm,
  ExchangeEnum.bitgetUsdm,
  ExchangeEnum.hyperliquidLinear,
  ExchangeEnum.krakenUsdm,
  ExchangeEnum.krakenCoinm,
]

export const getRealCoinm = () => [
  ExchangeEnum.binanceCoinm,
  ExchangeEnum.bybitCoinm,
  ExchangeEnum.okxInverse,
  ExchangeEnum.kucoinInverse,
  ExchangeEnum.bitgetCoinm,
  ExchangeEnum.krakenCoinm,
]

export const getRealSpot = () => [
  ExchangeEnum.binance,
  ExchangeEnum.kucoin,
  ExchangeEnum.bybit,
  ExchangeEnum.okx,
  ExchangeEnum.coinbase,
  ExchangeEnum.bitget,
  ExchangeEnum.mexc,
  ExchangeEnum.hyperliquid,
  ExchangeEnum.kraken,
]

export const isFutures = (exchange: ExchangeEnum) => {
  return [
    ExchangeEnum.binanceCoinm,
    ExchangeEnum.binanceUsdm,
    ExchangeEnum.paperBinanceCoinm,
    ExchangeEnum.paperBinanceUsdm,
    ExchangeEnum.paperBybitCoinm,
    ExchangeEnum.paperBybitUsdm,
    ExchangeEnum.bybitCoinm,
    ExchangeEnum.bybitUsdm,
    ExchangeEnum.okxInverse,
    ExchangeEnum.okxLinear,
    ExchangeEnum.paperOkxInverse,
    ExchangeEnum.paperOkxLinear,
    ExchangeEnum.kucoinInverse,
    ExchangeEnum.kucoinLinear,
    ExchangeEnum.paperKucoinInverse,
    ExchangeEnum.paperKucoinLinear,
    ExchangeEnum.bitgetCoinm,
    ExchangeEnum.paperBitgetCoinm,
    ExchangeEnum.bitgetUsdm,
    ExchangeEnum.paperBitgetUsdm,
    ExchangeEnum.hyperliquidLinear,
    ExchangeEnum.paperHyperliquidLinear,
    ExchangeEnum.krakenUsdm,
    ExchangeEnum.paperKrakenUsdm,
    ExchangeEnum.krakenCoinm,
    ExchangeEnum.paperKrakenCoinm,
  ].includes(exchange)
}

export const isCoinm = (exchange: ExchangeEnum) => {
  return [
    ExchangeEnum.binanceCoinm,
    ExchangeEnum.paperBinanceCoinm,
    ExchangeEnum.bybitCoinm,
    ExchangeEnum.paperBybitCoinm,
    ExchangeEnum.okxInverse,
    ExchangeEnum.paperOkxInverse,
    ExchangeEnum.paperKucoinInverse,
    ExchangeEnum.kucoinInverse,
    ExchangeEnum.bitgetCoinm,
    ExchangeEnum.paperBitgetCoinm,
    ExchangeEnum.krakenCoinm,
    ExchangeEnum.paperKrakenCoinm,
  ].includes(exchange)
}

export const isPaper = (exchange: ExchangeEnum) => {
  return [
    ExchangeEnum.paperBinance,
    ExchangeEnum.paperBinanceCoinm,
    ExchangeEnum.paperBinanceUsdm,
    ExchangeEnum.paperBybit,
    ExchangeEnum.paperFtx,
    ExchangeEnum.paperKucoin,
    ExchangeEnum.paperBybitCoinm,
    ExchangeEnum.paperBybitUsdm,
    ExchangeEnum.paperOkx,
    ExchangeEnum.paperOkxInverse,
    ExchangeEnum.paperOkxLinear,
    ExchangeEnum.paperCoinbase,
    ExchangeEnum.paperKucoinInverse,
    ExchangeEnum.paperKucoinLinear,
    ExchangeEnum.paperBitget,
    ExchangeEnum.paperBitgetUsdm,
    ExchangeEnum.paperBitgetCoinm,
    ExchangeEnum.paperMexc,
    ExchangeEnum.paperHyperliquid,
    ExchangeEnum.paperHyperliquidLinear,
    ExchangeEnum.paperKraken,
    ExchangeEnum.paperKrakenUsdm,
    ExchangeEnum.paperKrakenCoinm,
  ].includes(exchange)
}

const CONNECTION_ERROR_CODES = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]

/**
 * True when `error` means "the service we dialled is not listening / not reachable".
 *
 * Node dials every address family a host resolves to (`::1` *and* `127.0.0.1`), so a
 * refused connection to localhost throws an `AggregateError` whose `message` is the
 * **empty string** — the per-attempt codes live on `.code` / `.errors[]`, and once
 * axios has wrapped it, `.errors[]` sits on `.cause`. A message-only test therefore
 * misses exactly the case it exists for and the caller reports `AggregateError`.
 * The message test is kept as a fallback for throwers that only carry text.
 */
export const isServiceUnreachable = (error: unknown, message = ''): boolean => {
  type ErrLike = { code?: string; errors?: unknown; cause?: unknown }
  const codes: (string | undefined)[] = []
  let err = error as ErrLike | undefined
  // Walk the cause chain (depth-capped so a self-referencing cause can't loop).
  for (let depth = 0; err && depth < 5; depth++) {
    codes.push(err.code)
    if (Array.isArray(err.errors)) {
      codes.push(...err.errors.map((e) => (e as ErrLike)?.code))
    }
    err = err.cause as ErrLike | undefined
  }
  if (codes.some((c) => c && CONNECTION_ERROR_CODES.includes(c))) return true
  return message.includes('ECONNREFUSED') || message.includes('connect')
}

export default {
  sleep,
  getTimezoneOffset,
  getWeek,
  id,
  findUSDRate,
  getDateDiffInDays,
  mapToArray,
  mapToObject,
  checkNumber,
}
