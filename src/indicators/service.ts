import { isMainThread, threadId } from 'worker_threads'
import utils from '../utils'
import {
  createIndicator,
  feedCandle,
  getWarmupCandles,
} from '@gainium/indicators'
import type {
  RSI,
  MFI,
  ADX,
  BollingerBandsWidth,
  BollingerBands,
  MACD,
  EMA,
  CCI,
  AO,
  StochasticRSI,
  WilliamsR,
  BullBear,
  UltimateOscillator,
  StochasticOscillator,
  IchimokuCloud,
  VWMA,
  HMA,
  SMA,
  TVTA,
  WMA,
  DEMA,
  TEMA,
  RMA,
  SupportResistance,
  QFL,
  PSAR,
  VO,
  MOM,
  BBWP,
  ECD,
  MAR,
  BBPB,
  DIV,
  SuperTrend,
  PC,
  ATR,
  PriorPivot,
  ADR,
  ATH,
  KeltnerChannel,
  KeltnerChannelPB,
  DonchianChannels,
  OBFVG,
  LongWick,
} from '@gainium/indicators'
import { v4 } from 'uuid'
import {
  ExchangeEnum,
  ExchangeIntervals,
  intervalMap,
  StatusEnum,
  IndicatorEnum,
  serviceLogRedis,
} from '../../types'
import logger from '../utils/logger'
import type {
  TradeMessage,
  IndicatorHistory,
  CandleResponse,
  IndicatorSubscribers,
  IndicatorCb,
  IndicatorCreationConfig,
  SubscribeInternalIndicatorReponse,
  IndicatorState,
} from '../../types'
import { IdMute, IdMutex } from '../utils/mutex'
import { isKucoin, isOkx, isUsdmKucoin } from '../utils/exchange'
import RedisClient, { RedisWrapper } from '../db/redis'
import { removePaperFormExchangeName } from '../exchange/helpers'
import RabbitClient from '../db/rabbit'
import { getId } from '.'
import { CandlesProvider } from './candleProvider'

const { sleep } = utils

const kucoinIntervals = {
  [ExchangeIntervals.oneM]: '1min',
  [ExchangeIntervals.threeM]: '3min',
  [ExchangeIntervals.fiveM]: '5min',
  [ExchangeIntervals.fifteenM]: '15min',
  [ExchangeIntervals.thirtyM]: '30min',
  [ExchangeIntervals.oneH]: '1hour',
  [ExchangeIntervals.twoH]: '2hour',
  [ExchangeIntervals.fourH]: '4hour',
  [ExchangeIntervals.eightH]: '8hour',
  [ExchangeIntervals.oneD]: '1day',
  [ExchangeIntervals.oneW]: '1week',
}

const bitgetIntervals = {
  [ExchangeIntervals.oneM]: 'candle1m',
  [ExchangeIntervals.fiveM]: 'candle5m',
  [ExchangeIntervals.fifteenM]: 'candle15m',
  [ExchangeIntervals.thirtyM]: 'candle30m',
  [ExchangeIntervals.oneH]: 'candle1H',
  [ExchangeIntervals.fourH]: 'candle4H',
  [ExchangeIntervals.oneD]: 'candle1Dutc',
  [ExchangeIntervals.oneW]: 'candle1Wutc',
  [ExchangeIntervals.threeM]: '3min',
  [ExchangeIntervals.twoH]: '2h',
  [ExchangeIntervals.eightH]: '8h',
}

const bybitIntervals = {
  [ExchangeIntervals.oneM]: '1',
  [ExchangeIntervals.threeM]: '3',
  [ExchangeIntervals.fiveM]: '5',
  [ExchangeIntervals.fifteenM]: '15',
  [ExchangeIntervals.thirtyM]: '30',
  [ExchangeIntervals.oneH]: '60',
  [ExchangeIntervals.twoH]: '120',
  [ExchangeIntervals.fourH]: '240',
  [ExchangeIntervals.eightH]: '8hour',
  [ExchangeIntervals.oneD]: 'D',
  [ExchangeIntervals.oneW]: 'W',
}

const okxIntervals = {
  [ExchangeIntervals.oneM]: 'candle1m',
  [ExchangeIntervals.threeM]: 'candle3m',
  [ExchangeIntervals.fiveM]: 'candle5m',
  [ExchangeIntervals.fifteenM]: 'candle15m',
  [ExchangeIntervals.thirtyM]: 'candle30m',
  [ExchangeIntervals.oneH]: 'candle1H',
  [ExchangeIntervals.twoH]: 'candle2H',
  [ExchangeIntervals.fourH]: 'candle4H',
  [ExchangeIntervals.eightH]: 'candle4H',
  [ExchangeIntervals.oneD]: 'candle1Dutc',
  [ExchangeIntervals.oneW]: 'candle1Wutc',
}

const mexcKlineIntervals = {
  [ExchangeIntervals.oneM]: 'Min1',
  [ExchangeIntervals.fiveM]: 'Min5',
  [ExchangeIntervals.fifteenM]: 'Min15',
  [ExchangeIntervals.thirtyM]: 'Min30',
  [ExchangeIntervals.oneH]: 'Min60',
  [ExchangeIntervals.fourH]: 'Hour4',
  [ExchangeIntervals.oneD]: 'Day1',
  [ExchangeIntervals.oneW]: 'Week1',
  [ExchangeIntervals.threeM]: 'Min1',
  [ExchangeIntervals.twoH]: 'Hour1',
  [ExchangeIntervals.eightH]: 'Hour4',
}

const krakenSpotIntervals: Partial<Record<ExchangeIntervals, string>> = {
  [ExchangeIntervals.oneM]: '1',
  [ExchangeIntervals.fiveM]: '5',
  [ExchangeIntervals.fifteenM]: '15',
  [ExchangeIntervals.thirtyM]: '30',
  [ExchangeIntervals.oneH]: '60',
  [ExchangeIntervals.fourH]: '240',
  [ExchangeIntervals.oneD]: '1440',
  [ExchangeIntervals.oneW]: '10080',
}

const getIntervalByExchange = (
  exchange: ExchangeEnum,
  interval: ExchangeIntervals,
) => {
  switch (exchange) {
    case ExchangeEnum.binanceCoinm:
    case ExchangeEnum.binanceUsdm:
    case ExchangeEnum.paperBinanceCoinm:
    case ExchangeEnum.paperBinanceUsdm:
    case ExchangeEnum.binance:
    case ExchangeEnum.paperBinance:
    case ExchangeEnum.binanceUS: {
      return interval
    }
    case ExchangeEnum.bybit:
    case ExchangeEnum.paperBybit:
    case ExchangeEnum.bybitUsdm:
    case ExchangeEnum.paperBybitUsdm:
    case ExchangeEnum.bybitCoinm:
    case ExchangeEnum.paperBybitCoinm: {
      return bybitIntervals[interval]
    }
    case ExchangeEnum.bitget:
    case ExchangeEnum.paperBitget:
    case ExchangeEnum.bitgetUsdm:
    case ExchangeEnum.paperBitgetUsdm:
    case ExchangeEnum.bitgetCoinm:
    case ExchangeEnum.paperBitgetCoinm: {
      return bitgetIntervals[interval]
    }
    case ExchangeEnum.okx:
    case ExchangeEnum.okxInverse:
    case ExchangeEnum.okxLinear:
    case ExchangeEnum.paperOkx:
    case ExchangeEnum.paperOkxInverse:
    case ExchangeEnum.paperOkxLinear: {
      return okxIntervals[interval]
    }
    case ExchangeEnum.kucoin:
    case ExchangeEnum.paperKucoin:
    case ExchangeEnum.kucoinLinear:
    case ExchangeEnum.paperKucoinLinear:
    case ExchangeEnum.kucoinInverse:
    case ExchangeEnum.paperKucoinInverse: {
      return kucoinIntervals[interval]
    }
    case ExchangeEnum.mexc:
    case ExchangeEnum.paperMexc: {
      return mexcKlineIntervals[interval]
    }
    case ExchangeEnum.hyperliquid:
    case ExchangeEnum.paperHyperliquid:
    case ExchangeEnum.hyperliquidLinear:
    case ExchangeEnum.paperHyperliquidLinear: {
      return interval
    }
    case ExchangeEnum.kraken:
    case ExchangeEnum.paperKraken: {
      return krakenSpotIntervals[interval] ?? interval
    }
    default:
      return interval
  }
}

const mutex = new IdMutex()
const mutexConcurrently = new IdMutex(500)

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

// A delisted / no-archive-data symbol (e.g. an ESUSDT that left the exchange
// but is still subscribed for indicators) makes checkCandle's archive query
// fail on every candle, once per timeframe — a per-minute "parameter … does
// not exist" flood that buries every other error in the indicator worker.
// Track consecutive check-candle failures so we log the first few, then fall
// silent, and slow the retry cadence until data (live or archived) comes back.
// Any successful candle resets both (see updateCandle).
const CHECK_CANDLE_FAIL_LOG_LIMIT = Number(
  process.env.INDICATOR_CHECK_FAIL_LOG_LIMIT ?? 3,
)
const CHECK_CANDLE_FAIL_BACKOFF_AFTER = Number(
  process.env.INDICATOR_CHECK_FAIL_BACKOFF_AFTER ?? 5,
)
const CHECK_CANDLE_FAIL_BACKOFF_MS = Number(
  process.env.INDICATOR_CHECK_FAIL_BACKOFF_MS ?? 15 * 60 * 1000,
)

// …and track it per SYMBOL, not per Service. `getId` keys a Service by
// type+config+exchange+symbol+interval, so one pair carries as many Services as
// there are distinct indicator settings subscribed on it. checkCandle's failure
// is a property of the candle fetch (exchange+symbol+interval) and is identical
// for every one of them, so a per-instance counter multiplied the "first few"
// allowance by the instance count: AERGOUSDT@binanceUsdm (~86 stale bot docs,
// ~160 Services) burned 160 x (3 errors + 1 mute line) and was 97.5% of the
// indicator worker's error log, hiding every other error. Sharing the streak
// means the pair costs a fixed 3 errors + 1 mute line no matter how many
// Services ride it — and a new Service for an already-muted pair inherits the
// mute and the backoff instead of re-arming both.
const candleFailuresBySymbol = new Map<string, number>()
const candleFailureKey = (
  symbol: string,
  interval: ExchangeIntervals,
  exchange: ExchangeEnum,
) => `${symbol}@${interval}@${exchange}`

class InternalIndicator {
  protected candlesProvider = CandlesProvider
  private loaded = false
  private splitPhrase = `@gainium@`
  private id: string
  private cb?: IndicatorCb
  private indicator?:
    | RSI
    | MFI
    | ADX
    | BollingerBandsWidth
    | BollingerBands
    | MACD
    | EMA
    | CCI
    | AO
    | WilliamsR
    | BullBear
    | UltimateOscillator
    | StochasticOscillator
    | IchimokuCloud
    | StochasticRSI
    | VWMA
    | HMA
    | SMA
    | TVTA
    | WMA
    | DEMA
    | TEMA
    | RMA
    | SupportResistance
    | QFL
    | PSAR
    | VO
    | MOM
    | BBWP
    | ECD
    | MAR
    | BBPB
    | DIV
    | SuperTrend
    | PC
    | ATR
    | PriorPivot
    | ADR
    | ATH
    | KeltnerChannel
    | KeltnerChannelPB
    | DonchianChannels
    | OBFVG
    | LongWick
  private data: IndicatorHistory[]
  private lastPrice = 0
  private subscribers: IndicatorSubscribers[]
  private start: number
  private period: number
  private type: IndicatorEnum
  private length: number
  private indicatorName: string
  private symbol: string
  private symbolCode?: string
  private interval: ExchangeIntervals
  private exchange: ExchangeEnum
  private lastCandleTimestamp = 0
  private lastCandleTime = 0
  private o = 0
  private c = 0
  private h = 0
  private l = 0
  private v = 0
  private timer: NodeJS.Timeout | null
  private to = 0
  private updateCandlesHistory: Set<number> = new Set()
  private checkCandleTimer: NodeJS.Timeout | null = null
  private waitCandlePeriod = 8000
  private lastCandle = {
    open: '0',
    high: '0',
    low: '0',
    close: '0',
    volume: '0',
  }
  private closed = false
  private allowedToProcessPriceUpdate = false
  private redisClient: RedisWrapper | null = null
  private redisPublisher: RedisWrapper | null = null
  private test = false
  private limitMultiplier = 0
  private is1d?: boolean = false
  private lastSentUpdateAt = 0
  private rabbitClient = new RabbitClient()
  constructor({
    indicatorConfig,
    test,
    limitMultiplier,
    load1d,
    interval: _interval,
    symbol: _symbol,
    exchange: _exchange,
    symbolCode,
  }: IndicatorCreationConfig) {
    this.indicatorName =
      indicatorConfig.type === IndicatorEnum.ma
        ? indicatorConfig.maType
        : indicatorConfig.type
    // Indicator instantiation + warmup are now sourced from
    // @gainium/indicators (createIndicator / getWarmupCandles) so the live
    // service, the archive's on-demand evaluator, and any future consumer
    // share one definition of "what config produces what instance, with
    // what warmup."
    const created = createIndicator(indicatorConfig)
    if (created) {
      this.indicator = created
      this.length = getWarmupCandles(indicatorConfig)
    } else {
      this.length = 0
    }

    this.type = indicatorConfig.type
    this.data = []
    this.subscribers = []
    this.period = intervalMap[_interval]
    this.start = 0
    this.symbol = _symbol
    this.symbolCode = symbolCode
    this.interval = _interval
    this.exchange = _exchange
    this.test = !!test
    this.limitMultiplier = limitMultiplier ?? 0
    this.id = getId(
      indicatorConfig,
      this.exchange,
      this.symbol,
      this.interval,
      limitMultiplier,
    )
    this.updateCandle = this.updateCandle.bind(this)
    this.connectCandle = this.connectCandle.bind(this)
    this.publishToRedis = this.publishToRedis.bind(this)
    this.cb = (data, price, is1d) => {
      this.lastSentUpdateAt = +new Date()
      this.publishToRedis(this.id, { data, price, is1d })
    }
    this.cb = this.cb.bind(this)
    this.redisCb = this.redisCb.bind(this)
    this.processServiceLog = this.processServiceLog.bind(this)
    const time = new Date().getTime()
    const mod = time % +this.period
    this.timer = null
    this.is1d = load1d
    if (!this.test && !this.is1d) {
      this.timer = setTimeout(
        () => this.loadData(),
        +this.period - +mod + 5 * 1000,
      )
    }
    this.to = this.is1d ? time - +mod - 1 : time + this.period - +mod - 1
    if (this.test || this.is1d) {
      this.loadData(undefined, this.is1d)
    }

    this.checkCandle = this.checkCandle.bind(this)
  }
  private handleError(...msg: unknown[]) {
    logger.error(`${loggerPrefix}`, ...msg)
  }

  private handleDebug(...msg: unknown[]) {
    logger.debug(`${loggerPrefix}`, ...msg)
  }
  // Shared across every Service on this exchange+symbol+interval — see
  // candleFailuresBySymbol. Backed by a Map so the entry disappears on reset,
  // leaving only currently-failing pairs resident.
  private get consecutiveCandleFailures() {
    return (
      candleFailuresBySymbol.get(
        candleFailureKey(this.symbol, this.interval, this.exchange),
      ) ?? 0
    )
  }
  private set consecutiveCandleFailures(value: number) {
    const key = candleFailureKey(this.symbol, this.interval, this.exchange)
    if (value <= 0) {
      candleFailuresBySymbol.delete(key)
    } else {
      candleFailuresBySymbol.set(key, value)
    }
  }
  private addSplitPhrase(text: string) {
    return `${text}${this.splitPhrase}${this.id}`
  }
  private async publishToRedis(room: string, data: any) {
    try {
      if (!this.redisPublisher) {
        this.redisPublisher = await RedisClient.getInstance(
          false,
          'indicators-publisher',
        )
      }
      if (this.redisPublisher) {
        await this.redisPublisher.publish(room, JSON.stringify(data))
      }
    } catch (error) {
      this.handleError('Failed to publish to Redis:', error)
    }
  }
  public async subscribe(
    _id?: string,
    load1d?: boolean,
  ): Promise<SubscribeInternalIndicatorReponse> {
    const id = _id ?? v4()
    const externalId = this.addSplitPhrase(id)
    this.subscribers.push({
      id,
      is1d: load1d,
    })
    const c = () => {
      if (this.lastPrice && this.data.length) {
        this.cb?.(this.data, this.lastPrice)
      }
    }
    if (load1d && !this.is1d && !this.data.length) {
      if (this.timer) {
        clearTimeout(this.timer)
      }
      this.handleDebug(
        `Force load data for ${this.symbol}@${this.interval}@${this.exchange}`,
      )
      const time = new Date().getTime()
      const mod = time % +this.period
      this.to = time - +mod - 1
      this.loadData(true, undefined, c)
    }
    this.handleDebug(`Add subscriber ${id}. Size - ${this.subscribers.length}`)
    if (load1d) {
      setTimeout(c, 10 * 1000)
    }
    return { id: externalId }
  }
  public removeCallback(id: string) {
    this.subscribers = []
    this.handleDebug(
      `Remove subscriber ${id}. Left - ${this.subscribers.length}`,
    )
  }
  public unsubscribe(id: string) {
    this.subscribers = this.subscribers.filter((s) => s.id !== id)
    if (this.subscribers.length === 0) {
      if (this.timer) {
        clearTimeout(this.timer)
      }
      if (this.redisClient) {
        this.redisClient.unsubscribe(this.getRedisChannelName(), this.redisCb)
        this.redisClient.unsubscribe(serviceLogRedis, this.processServiceLog)
      }
      if (this.checkCandleTimer) {
        clearTimeout(this.checkCandleTimer)
      }
      this.closed = true
    }
    this.handleDebug(`Unsubscribe ${id}. Left - ${this.subscribers.length}`)
    return this.subscribers.length
  }

  @IdMute(mutex, (id: string) => id)
  private async checkCandle(_id: string, _start: number) {
    const start = +_start
    if (this.closed) {
      return
    }
    if (
      !this.updateCandlesHistory.has(start) &&
      _start + this.period >= this.start
    ) {
      this.handleDebug(
        `${this.symbol}@${this.interval}@${this.exchange} missed `,
        new Date(start),
        'last timestamp',
        new Date(this.lastCandleTimestamp),
        'last candle',
        new Date(this.lastCandleTime),
      )
      const candle = await this.getCandles(
        Math.max(
          0,
          start - (isUsdmKucoin(this.exchange) ? 5 * this.period : 0),
        ),
        start + this.period - (isUsdmKucoin(this.exchange) ? 0 : 1),
        isKucoin(this.exchange) ? 0 : 1,
      )
      if (candle.status === StatusEnum.ok) {
        let data: CandleResponse | undefined = candle.data[0]
        if (isUsdmKucoin(this.exchange) || isOkx(this.exchange)) {
          data = candle.data?.find((c) => c.time === start)
        }
        if (data) {
          this.updateCandle(this.id, { start, ...data }, true)
        } else {
          this.handleDebug(
            `${this.symbol}@${this.interval}@${this.exchange} serve last candle `,
            new Date(start),
          )
          this.updateCandle(
            this.id,
            {
              start,
              open: this.lastCandle.close,
              close: this.lastCandle.close,
              high: this.lastCandle.close,
              low: this.lastCandle.close,
              volume: '0',
            },
            true,
            true,
          )
        }
      } else {
        this.consecutiveCandleFailures += 1
        // Log the first few failures, then fall silent: a delisted / no-archive
        // symbol would otherwise re-log this every candle, per timeframe, and
        // drown out real errors. A successful candle re-arms logging + cadence.
        if (this.consecutiveCandleFailures <= CHECK_CANDLE_FAIL_LOG_LIMIT) {
          this.handleError(
            `${this.symbol}@${this.interval}@${this.exchange} error: ${candle.reason} `,
            new Date(start),
          )
          if (this.consecutiveCandleFailures === CHECK_CANDLE_FAIL_LOG_LIMIT) {
            this.handleError(
              `${this.symbol}@${this.interval}@${this.exchange} check-candle failing persistently (likely delisted / no archive data) — suppressing further errors and backing off until data returns`,
            )
          }
        }
      }
    }
    if (this.checkCandleTimer) {
      clearTimeout(this.checkCandleTimer)
    }
    try {
      // Once a symbol has failed persistently, stretch the retry cadence so a
      // dead symbol re-probes every ~15m instead of every candle.
      const backoff =
        this.consecutiveCandleFailures >= CHECK_CANDLE_FAIL_BACKOFF_AFTER
          ? CHECK_CANDLE_FAIL_BACKOFF_MS
          : 0
      const timeout =
        +start +
        +this.period * 2 +
        +this.waitCandlePeriod -
        +new Date() +
        backoff
      this.checkCandleTimer = setTimeout(
        () => this.checkCandle(this.id, +start + +this.period),
        timeout,
      )
    } catch (e) {
      this.handleError(
        `${this.indicatorName}@${this.symbol}@${this.exchange}@${
          this.interval
        } cannot set timer (${
          start + this.period * 2 + this.waitCandlePeriod - +new Date()
        }), ${this.start}, ${this.period} (${this.period * 2}), ${
          this.waitCandlePeriod
        }, ${+new Date()} | ${(e as Error)?.message || e}`,
      )
    }
  }
  @IdMute(mutex, (id: string, msg: TradeMessage) => `${id}${msg.start}`)
  private async updateCandle(
    _id: string,
    msg: TradeMessage,
    forceOld = false,
    synthetic = false,
  ) {
    if (this.closed) {
      return
    }
    // A REAL candle came through (live stream or archive) — clear any delisted /
    // no-data failure streak so checkCandle logging + cadence return to normal.
    // `synthetic` fills must NOT clear it: the "serve last candle" branches
    // re-serve lastCandle.close with volume 0, so no new data actually arrived.
    // For a delisted symbol those alternate with real failures, and clearing the
    // streak on one re-arms both the mute and the backoff — which is how
    // AERGOUSDT@binanceUsdm re-logged "suppressing further errors" 1,930 times
    // in 50h despite the ESUSDT fix.
    if (!synthetic) {
      this.consecutiveCandleFailures = 0
    }
    const { open: o, close: c, high: h, low: l, volume: v } = msg
    const start = +msg.start
    this.lastCandleTime = start
    this.lastCandleTimestamp = +new Date()
    const old = {
      o: this.o,
      h: this.h,
      l: this.l,
      c: this.c,
      v: this.v,
    }
    this.o = +o
    this.c = +c
    this.h = +h
    this.l = +l
    this.v = +v
    const exchangesWithClosedOnly = [
      ExchangeEnum.binance,
      ExchangeEnum.bybit,
      ExchangeEnum.okx,
    ]
    const isClosedOnly = exchangesWithClosedOnly.some(
      (e) =>
        this.exchange.toUpperCase().includes(e.toUpperCase()) ||
        e.toUpperCase().includes(this.exchange.toUpperCase()),
    )
    // closed-only streams deliver `start` as the just-closed candle's own start
    // (legacy streams use the next-period open), so they index like `forceOld`.
    // msg itself carries the closed candle's final OHLCV, so route it through
    // `old` (which the else-branch feeds to the indicator) instead of letting
    // the stale per-instance accumulator from the previous event sneak through.
    const closedCandleAlreadyKnown = forceOld || isClosedOnly
    if (forceOld || isClosedOnly) {
      old.o = +o
      old.h = +h
      old.l = +l
      old.c = +c
      old.v = +v
    }
    const startIndex = closedCandleAlreadyKnown ? start : start - this.period
    if (
      ((start > this.start && this.start !== 0) || isClosedOnly || forceOld) &&
      !this.updateCandlesHistory.has(startIndex)
    ) {
      this.updateCandlesHistory.add(startIndex)
      if (this.updateCandlesHistory.size > 10) {
        // Keep only the most recent 10 entries by clearing old ones
        const entries = Array.from(this.updateCandlesHistory).sort(
          (a, b) => b - a,
        )
        this.updateCandlesHistory.clear()
        entries
          .slice(0, 10)
          .forEach((entry) => this.updateCandlesHistory.add(entry))
      }
      if (+old.o === 0 || +old.h === 0 || +old.l === 0 || +old.c === 0) {
        const candle = await this.getCandles(
          this.start,
          this.start + this.period - (isUsdmKucoin(this.exchange) ? 0 : 1),
          isKucoin(this.exchange) ? 0 : 1,
        )
        if (candle.status === StatusEnum.ok) {
          const data = candle.data[0]
          if (data) {
            this.updateValue(
              {
                o: +data.open,
                h: +data.high,
                l: +data.low,
                c: +data.close,
                v: +data.volume,
              },
              this.start,
              true,
            )
          } else {
            this.handleDebug(
              `${this.symbol}@${this.interval}@${this.exchange} serve last candle `,
              new Date(start),
            )
            this.updateCandle(
              this.id,
              {
                start,
                open: this.lastCandle.close,
                close: this.lastCandle.close,
                high: this.lastCandle.close,
                low: this.lastCandle.close,
                volume: '0',
              },
              true,
              true,
            )
          }
        }
      } else {
        this.updateValue(
          { o: old.o, h: old.h, l: old.l, c: old.c, v: old.v },
          this.start,
          true,
        )
      }
      this.start = +start + (closedCandleAlreadyKnown ? this.period : 0)
      this.lastCandle = {
        open: `${old.o}`,
        high: `${old.h}`,
        low: `${old.l}`,
        close: `${old.c}`,
        volume: `${old.v}`,
      }
    }
  }
  private async updateValue(
    value: {
      o: number | string
      h: number | string
      l: number | string
      c: number | string
      v: number | string
    },
    time: number,
    callCB = false,
    is1d = false,
  ) {
    if (
      isNaN(+value.o) ||
      isNaN(+value.h) ||
      isNaN(+value.l) ||
      isNaN(+value.c) ||
      isNaN(+value.v)
    ) {
      return
    }
    // Per-class instanceof dispatch lives in @gainium/indicators' feedCandle —
    // one source of truth for "which input shape goes to which indicator."
    feedCandle(this.indicator, {
      o: +value.o,
      h: +value.h,
      l: +value.l,
      c: +value.c,
      v: +value.v,
    })
    try {
      const result = this.indicator ? this.indicator.result : undefined
      if (result !== undefined && result !== null) {
        this.data.push({
          time,
          // @ts-ignore
          value:
            this.type === IndicatorEnum.psar
              ? { psar: result as number, price: +value.c }
              : this.type !== IndicatorEnum.ma
                ? this.type !== IndicatorEnum.bb &&
                  this.type !== IndicatorEnum.kc
                  ? result
                  : { result, price: +value.c }
                : {
                    ma: result as number,
                    price: +value.c,
                    maType: this.indicatorName,
                  },
          type: this.type,
        })
        if (this.data.length > 3) {
          this.data.shift()
        }
        const price = +value.c
        this.lastPrice = price

        if (callCB) {
          this.cb?.(this.data, price, is1d)
        }
      } else {
        this.handleDebug(
          `No result for ${this.id} at ${new Date(time).toISOString()} with value ${JSON.stringify(value)}`,
        )
      }
    } catch (e) {
      this.handleError(
        `Cannot update value: ${(e as Error)?.message || e} for ${this.id} at ${new Date(time)} with value ${JSON.stringify(value)}`,
      )
    }
  }
  private async getCandles(
    from: number,
    to: number,
    length?: number,
    saveResult = true,
  ) {
    const instance = this.candlesProvider.getInstance()
    return await instance.getCandles(
      this.exchange,
      this.symbol,
      this.interval,
      from,
      to,
      length,
      saveResult,
    )
  }
  private async getCandlesFromExchange() {
    const requestStep =
      this.exchange === ExchangeEnum.binance ||
      this.exchange === ExchangeEnum.paperBinance ||
      this.exchange === ExchangeEnum.binanceUS ||
      this.exchange === ExchangeEnum.mexc ||
      this.exchange === ExchangeEnum.paperMexc ||
      // Bitget recent /market/candles serves up to 1000/call (spot & futures);
      // pairs with the connector's 1000-candle spot paging so a warmup that
      // falls through to the exchange (archive miss) makes ~5x fewer balancer
      // round-trips than the previous default of 200.
      this.exchange === ExchangeEnum.bitget ||
      this.exchange === ExchangeEnum.paperBitget ||
      this.exchange === ExchangeEnum.bitgetUsdm ||
      this.exchange === ExchangeEnum.paperBitgetUsdm ||
      this.exchange === ExchangeEnum.bitgetCoinm ||
      this.exchange === ExchangeEnum.paperBitgetCoinm
        ? 1000
        : this.exchange === ExchangeEnum.bybit ||
            this.exchange === ExchangeEnum.bybitCoinm ||
            this.exchange === ExchangeEnum.bybitUsdm ||
            this.exchange === ExchangeEnum.paperBybit ||
            this.exchange === ExchangeEnum.paperBybitCoinm ||
            this.exchange === ExchangeEnum.paperBybitUsdm
          ? 999
          : this.exchange === ExchangeEnum.binanceUsdm ||
              this.exchange === ExchangeEnum.binanceCoinm ||
              this.exchange === ExchangeEnum.kucoin ||
              this.exchange === ExchangeEnum.paperBinanceUsdm ||
              this.exchange === ExchangeEnum.paperBinanceCoinm ||
              this.exchange === ExchangeEnum.paperKucoin
            ? 1500
            : this.exchange === ExchangeEnum.okx ||
                this.exchange === ExchangeEnum.okxInverse ||
                this.exchange === ExchangeEnum.okxLinear ||
                this.exchange === ExchangeEnum.paperOkx ||
                this.exchange === ExchangeEnum.paperOkxInverse ||
                this.exchange === ExchangeEnum.paperOkxLinear
              ? 100
              : this.exchange === ExchangeEnum.hyperliquid ||
                  this.exchange === ExchangeEnum.hyperliquidLinear ||
                  this.exchange === ExchangeEnum.paperHyperliquid ||
                  this.exchange === ExchangeEnum.paperHyperliquidLinear
                ? 4999
                : this.exchange === ExchangeEnum.kraken ||
                    this.exchange === ExchangeEnum.paperKraken
                  ? 720
                  : this.exchange === ExchangeEnum.krakenUsdm ||
                      this.exchange === ExchangeEnum.paperKrakenUsdm ||
                      this.exchange === ExchangeEnum.krakenCoinm ||
                      this.exchange === ExchangeEnum.paperKrakenCoinm
                    ? 2000
                    : 200
    const to = this.to || new Date().getTime()
    const step = intervalMap[this.interval]
    const length = Math.max(Math.ceil(this.length * 2), 500)
    const from = Math.max(1, to - length * step)
    const count = Math.ceil(length / requestStep)
    const data: CandleResponse[] = []
    let prev = from
    const dataHasSet: Set<number> = new Set()

    for (const request of [...Array(count).keys()]) {
      const localTo = Math.min(from + (request + 1) * step * requestStep, to)
      const result = await this.getCandles(
        prev,
        localTo + (isUsdmKucoin(this.exchange) ? 1 : 0),
        isKucoin(this.exchange) ? undefined : requestStep,
      )
      prev = localTo
      if (result.status === StatusEnum.notok) {
        return result
      }
      const candles = result.data
      // Process candles in chunks to avoid blocking event loop
      for (let candleIndex = 0; candleIndex < candles.length; candleIndex++) {
        const d = candles[candleIndex]
        if (isUsdmKucoin(this.exchange) || isOkx(this.exchange)) {
          if (d.time > localTo) continue
        }

        const obj = [d]
        if (candleIndex !== 0) {
          const prevCandle = candles[candleIndex - 1]
          if (d.time - prevCandle.time > step) {
            const missed = Math.ceil((d.time - prevCandle.time) / step)
            for (const m of [...Array(missed).keys()]) {
              const time = prevCandle.time + step * (m + 1)
              if (!obj.find((o) => o.time === time)) {
                obj.push({
                  open: prevCandle.close,
                  high: prevCandle.close,
                  low: prevCandle.close,
                  close: prevCandle.close,
                  volume: '0',
                  time,
                  symbol: prevCandle.symbol,
                })
              }
            }
          }
        }

        for (const o of obj) {
          if (!dataHasSet.has(o.time)) {
            data.push(o)
            dataHasSet.add(o.time)
          }
        }

        // Yield control every 100 candles to prevent blocking
        if (candleIndex % 100 === 0) {
          await sleep(0)
        }
      }
      await sleep(0)
    }
    return {
      status: StatusEnum.ok,
      data: data.sort((a, b) => a.time - b.time),
      reason: null,
    }
  }

  @IdMute(mutexConcurrently, () => 'loadIndicatorsData')
  private async loadData(is1d?: boolean, filter1d?: boolean, cb?: () => void) {
    if (this.loaded) {
      if (cb) {
        cb()
      }
      return
    }
    this.loaded = true
    try {
      const candles = await this.getCandlesFromExchange()
      if (candles.status === StatusEnum.ok && candles.data.length > 0) {
        const { data } = candles
        const lastCandle = data[data.length - 1]
        this.start = +lastCandle.time + this.period
        let lastTime = +lastCandle.time
        const limit = +new Date() - this.period * (1 + this.limitMultiplier)
        const lastCandleLast = limit < this.start
        this.handleDebug(
          `${this.indicatorName}@${this.symbol}@${this.exchange}@${this.interval} | loaded ${data.length} candles | last time: `,
          new Date(lastTime),
        )
        for (let i = 0; i < data.length; i++) {
          const c = data[i]
          if (c.time < this.start) {
            this.updateValue(
              { o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume },
              c.time,
              is1d
                ? false
                : (this.limitMultiplier !== 0 && c.time > limit) ||
                    (lastCandleLast &&
                      (this.test || c.time === lastCandle.time)),
              filter1d,
            )
          }
          // Yield control every 50 candles to prevent blocking
          if (i % 50 === 0) {
            await sleep(0)
          }
        }
        if (!lastCandleLast) {
          let time = +lastCandle.time + this.period
          let fillCount = 0
          do {
            this.handleDebug(
              `${this.indicatorName}@${this.symbol}@${this.exchange}@${this.interval} | filled with last candle `,
              new Date(time),
            )
            this.updateValue(
              {
                o: lastCandle.close,
                h: lastCandle.close,
                l: lastCandle.close,
                c: lastCandle.close,
                v: 0,
              },
              time,
              is1d ? false : time + this.period * 2 > limit + this.period,
              filter1d,
            )
            lastTime = time
            time += this.period
            fillCount++

            // Yield control every 10 fills to prevent blocking
            if (fillCount % 10 === 0) {
              await sleep(0)
            }
          } while (time < limit)
          this.start = +time
        }
        this.lastCandle = {
          ...lastCandle,
        }
        this.handleDebug(
          `${this.indicatorName}@${this.symbol}@${this.exchange}@${this.interval} | processed ${data.length} candles | last time: `,
          new Date(lastTime),
        )
      } else {
        this.start = this.to ? +this.to + 1 : new Date().getTime()
        this.handleError(
          `${this.indicatorName}@${this.symbol}@${this.exchange}@${this.interval} | ${candles.status === StatusEnum.notok ? candles.reason : 'No data'}`,
        )
      }
    } catch (e) {
      this.start = this.to ? +this.to + 1 : new Date().getTime()
      this.handleError(
        `${this.indicatorName}@${this.symbol}@${this.exchange}@${this.interval} | Error in load data (${is1d}, ${filter1d}): ${e}`,
      )
    }
    const checkPrice = this.start
    this.allowedToProcessPriceUpdate = true
    try {
      const timeout =
        +this.start + +this.period + +this.waitCandlePeriod - +new Date()
      this.checkCandleTimer = setTimeout(
        () => this.checkCandle(this.id, +checkPrice),
        timeout,
      )
    } catch (e) {
      this.handleError(
        `${this.indicatorName}@${this.symbol}@${this.exchange}@${
          this.interval
        } cannot set timer (${
          this.start + this.period + this.waitCandlePeriod - +new Date()
        }), ${this.start}, ${this.period}, ${
          this.waitCandlePeriod
        }, ${+new Date()} | ${(e as Error)?.message || e}`,
      )
    }

    this.connectCandle()

    if (cb) {
      cb()
    }
  }

  private getRedisChannelName() {
    const exchange = removePaperFormExchangeName(this.exchange)
    const interval = getIntervalByExchange(this.exchange, this.interval)
    return `${this.symbolCode || this.symbol}@${exchange}@${interval}Candle`
  }

  private redisCb(msg: string) {
    if (this.allowedToProcessPriceUpdate) {
      this.updateCandle(this.id, JSON.parse(msg))
    }
  }

  private processServiceLog(msg: string) {
    const restart = JSON.parse(msg)?.restart
    if (restart === 'priceConnector') {
      this.connectCandle()
    }
  }

  private async connectCandle() {
    const exchange = removePaperFormExchangeName(this.exchange)
    const interval = getIntervalByExchange(this.exchange, this.interval)
    this.redisClient = await RedisClient.getInstance(true, 'indicators')
    if (this.redisClient) {
      this.redisClient.unsubscribe(this.getRedisChannelName(), this.redisCb)
      this.redisClient.unsubscribe(serviceLogRedis, this.processServiceLog)
      this.redisClient.subscribe(this.getRedisChannelName(), this.redisCb)
      this.redisClient.subscribe(serviceLogRedis, this.processServiceLog)
    }
    this.rabbitClient.send('candlesRequests', {
      symbol: this.symbolCode || this.symbol,
      exchange,
      interval,
    })
  }

  get currentData() {
    return this.data
  }

  public getState(): IndicatorState {
    return {
      id: this.id,
      type: this.type,
      indicatorName: this.indicatorName,
      exchange: this.exchange,
      symbol: this.symbol,
      symbolCode: this.symbolCode,
      interval: this.interval,
      period: this.period,
      loaded: this.loaded,
      closed: this.closed,
      is1d: !!this.is1d,
      test: this.test,
      limitMultiplier: this.limitMultiplier,
      warmupCandles: this.length,
      allowedToProcessPriceUpdate: this.allowedToProcessPriceUpdate,
      subscribers: this.subscribers.length,
      data: [...this.data],
      lastPrice: this.lastPrice,
      lastCandle: { ...this.lastCandle },
      current: { o: this.o, h: this.h, l: this.l, c: this.c, v: this.v },
      start: this.start,
      to: this.to,
      lastCandleTime: this.lastCandleTime,
      lastCandleTimestamp: this.lastCandleTimestamp,
      lastSentUpdateAt: this.lastSentUpdateAt,
      recentCandleStarts: [...this.updateCandlesHistory].sort((a, b) => b - a),
    }
  }
}

export default InternalIndicator
