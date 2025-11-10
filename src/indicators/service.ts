import { isMainThread, threadId } from 'worker_threads'
import utils from '../utils'
import {
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
  DIVUsableOscillators,
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
  Sessions,
} from '@gainium/indicators'
import { v4 } from 'uuid'
import {
  ExchangeEnum,
  ExchangeIntervals,
  intervalMap,
  StatusEnum,
  IndicatorEnum,
  MAEnum,
  serviceLogRedis,
  RangeType,
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
    case ExchangeEnum.paperKucoin: {
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
    default:
      return interval
  }
}

const mutex = new IdMutex()
const mutexConcurrently = new IdMutex(500)

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

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
    | Sessions
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
    this.length = 0
    this.indicatorName =
      indicatorConfig.type === IndicatorEnum.ma
        ? indicatorConfig.maType
        : indicatorConfig.type
    if (indicatorConfig.type === IndicatorEnum.st) {
      this.indicator = new SuperTrend(
        indicatorConfig.factor,
        indicatorConfig.atrLength,
      )
      this.length = 750
    }
    if (indicatorConfig.type === IndicatorEnum.dc) {
      this.indicator = new DonchianChannels(indicatorConfig.length)
      this.length = indicatorConfig.length + 1
    }
    if (indicatorConfig.type === IndicatorEnum.pp) {
      this.indicator = new PriorPivot(
        indicatorConfig.ppHighLeft,
        indicatorConfig.ppHighRight,
        indicatorConfig.ppLowLeft,
        indicatorConfig.ppLowRight,
        indicatorConfig.ppMult,
      )
      this.length =
        Math.max(
          indicatorConfig.ppHighLeft + indicatorConfig.ppHighRight,
          indicatorConfig.ppLowLeft + indicatorConfig.ppLowRight,
          1000,
        ) + 1
    }
    if (indicatorConfig.type === IndicatorEnum.pc) {
      this.indicator = new PC(indicatorConfig.pcUp, indicatorConfig.pcDown)
      this.length = 1
    }
    if (indicatorConfig.type === IndicatorEnum.rsi) {
      this.indicator = new RSI(
        indicatorConfig.interval,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.atr) {
      this.indicator = new ATR(indicatorConfig.interval)
      this.length = indicatorConfig.interval
    }
    if (indicatorConfig.type === IndicatorEnum.adr) {
      this.indicator = new ADR(indicatorConfig.interval)
      this.length = indicatorConfig.interval
    }
    if (indicatorConfig.type === IndicatorEnum.ecd) {
      this.indicator = new ECD()
      this.length = 2
    }
    if (indicatorConfig.type === IndicatorEnum.ath) {
      this.indicator = new ATH(indicatorConfig.lookback)
      this.length = indicatorConfig.lookback + 1
    }
    if (indicatorConfig.type === IndicatorEnum.vo) {
      this.indicator = new VO(
        indicatorConfig.voShort,
        indicatorConfig.voLong,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.voLong +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.psar) {
      this.length = 100
      this.indicator = new PSAR(
        indicatorConfig.start,
        indicatorConfig.inc,
        indicatorConfig.max,
      )
    }
    if (indicatorConfig.type === IndicatorEnum.div) {
      this.length = 200
      this.indicator = new DIV(
        indicatorConfig.oscillators.map((v) =>
          v.toLowerCase(),
        ) as DIVUsableOscillators[],
        indicatorConfig.leftBars ?? 3,
        indicatorConfig.rightBars ?? 1,
        indicatorConfig.rangeLower ?? 1,
        indicatorConfig.rangeUpper ?? 60,
      )
    }
    if (indicatorConfig.type === IndicatorEnum.mom) {
      this.length = Math.max(
        indicatorConfig.interval +
          (indicatorConfig.percentile
            ? +(indicatorConfig.percentileLookback ?? '0')
            : 0),
        100,
      )
      this.indicator = new MOM(
        indicatorConfig.interval,
        //@ts-ignore
        indicatorConfig.source,
        indicatorConfig.percentile,
        indicatorConfig.percentileLookback,
        indicatorConfig.percentilePercentage,
      )
    }
    if (indicatorConfig.type === IndicatorEnum.mar) {
      this.indicator = new MAR(
        indicatorConfig.mar1type,
        indicatorConfig.mar1length,
        indicatorConfig.mar2type,
        indicatorConfig.mar2length,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
        indicatorConfig.trendFilter,
        indicatorConfig.trendFilterLookback,
        indicatorConfig.trendFilterValue,
        indicatorConfig.trendFilterType,
      )
      this.length =
        Math.max(indicatorConfig.mar1length, indicatorConfig.mar2length) +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.mfi) {
      this.indicator = new MFI(
        indicatorConfig.interval,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.adx) {
      this.indicator = new ADX(
        indicatorConfig.interval,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.bbw) {
      const bb = new BollingerBands(
        indicatorConfig.interval,
        indicatorConfig.bbwMult ?? 2,
        indicatorConfig.bbwMa ?? MAEnum.sma,
        indicatorConfig.bbwMaLength ?? 20,
      )
      this.indicator = new BollingerBandsWidth(
        bb,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.bbwMaLength ?? 0) *
          (indicatorConfig.bbwMa === MAEnum.tema
            ? 3
            : indicatorConfig.bbwMa === MAEnum.dema
              ? 2
              : 1) +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.bbpb) {
      const bb = new BollingerBands(
        indicatorConfig.interval,
        indicatorConfig.bbwMult ?? 2,
        indicatorConfig.bbwMa ?? MAEnum.sma,
        indicatorConfig.bbwMaLength ?? 20,
      )
      this.indicator = new BBPB(
        bb,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.bbwMaLength ?? 0) *
          (indicatorConfig.bbwMa === MAEnum.tema
            ? 3
            : indicatorConfig.bbwMa === MAEnum.dema
              ? 2
              : 1) +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.kcpb) {
      const kc = new KeltnerChannel(
        indicatorConfig.interval,
        indicatorConfig.multiplier ?? 2,
        indicatorConfig.ma ?? MAEnum.ema,
        indicatorConfig.range ?? RangeType.atr,
        indicatorConfig.rangeLength ?? 10,
      )
      this.indicator = new KeltnerChannelPB(
        kc,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.rangeLength ?? 10) +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.kc) {
      this.indicator = new KeltnerChannel(
        indicatorConfig.interval,
        indicatorConfig.multiplier ?? 2,
        indicatorConfig.ma ?? MAEnum.ema,
        indicatorConfig.range ?? RangeType.atr,
        indicatorConfig.rangeLength ?? 10,
      )
      this.length =
        indicatorConfig.interval + (indicatorConfig.rangeLength ?? 10) + 1
    }
    if (indicatorConfig.type === IndicatorEnum.bbwp) {
      const bb = new BollingerBands(indicatorConfig.interval, 1, MAEnum.sma, 20)
      this.indicator = new BBWP(bb, indicatorConfig.lookback)
      this.length = indicatorConfig.interval + indicatorConfig.lookback
    }
    if (indicatorConfig.type === IndicatorEnum.bb) {
      this.indicator = new BollingerBands(
        indicatorConfig.interval,
        indicatorConfig.bbwMult ?? 2,
        indicatorConfig.bbwMa ?? MAEnum.sma,
        indicatorConfig.bbwMaLength ?? 20,
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.bbwMaLength ?? 0) *
          (indicatorConfig.bbwMa === MAEnum.tema
            ? 3
            : indicatorConfig.bbwMa === MAEnum.dema
              ? 2
              : 1)
    }
    if (indicatorConfig.type === IndicatorEnum.macd) {
      const maSource = indicatorConfig.maSource === MAEnum.sma ? SMA : EMA
      const maSignal = indicatorConfig.maSignal === MAEnum.sma ? SMA : EMA
      this.indicator = new MACD(
        new maSource(indicatorConfig.shortInterval),
        new maSource(indicatorConfig.longInterval),
        new maSignal(indicatorConfig.signalInterval),
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        Math.max(indicatorConfig.longInterval + indicatorConfig.shortInterval) +
        indicatorConfig.signalInterval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.stoch) {
      this.indicator = new StochasticOscillator(
        indicatorConfig.k,
        indicatorConfig.ksmooth,
        indicatorConfig.dsmooth,
      )
      this.length =
        indicatorConfig.k + indicatorConfig.ksmooth + indicatorConfig.dsmooth
    }
    if (indicatorConfig.type === IndicatorEnum.cci) {
      this.indicator = new CCI(
        indicatorConfig.interval,
        'hlc3',
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.ao) {
      this.indicator = new AO(
        5,
        34,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        34 +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.stochRSI) {
      this.indicator = new StochasticRSI(
        indicatorConfig.interval,
        indicatorConfig.k,
        indicatorConfig.ksmooth,
        indicatorConfig.dsmooth,
      )
      this.length =
        indicatorConfig.interval +
        indicatorConfig.k +
        indicatorConfig.ksmooth +
        indicatorConfig.dsmooth
    }
    if (indicatorConfig.type === IndicatorEnum.wr) {
      this.indicator = new WilliamsR(
        indicatorConfig.interval,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.bullBear) {
      this.indicator = new BullBear(indicatorConfig.interval)
      this.length = indicatorConfig.interval
    }
    if (indicatorConfig.type === IndicatorEnum.uo) {
      this.indicator = new UltimateOscillator(
        indicatorConfig.fast,
        indicatorConfig.middle,
        indicatorConfig.slow,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        Math.max(
          indicatorConfig.fast,
          indicatorConfig.middle,
          indicatorConfig.slow,
        ) +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.ic) {
      this.indicator = new IchimokuCloud(
        indicatorConfig.conversionPeriods,
        indicatorConfig.basePeriods,
        indicatorConfig.laggingSpan2Periods,
        indicatorConfig.laggingSpan,
      )
      this.length = Math.max(
        indicatorConfig.conversionPeriods,
        indicatorConfig.basePeriods,
        indicatorConfig.laggingSpan2Periods,
        indicatorConfig.laggingSpan,
      )
    }
    if (indicatorConfig.type === IndicatorEnum.ma) {
      if (indicatorConfig.maType === MAEnum.ema) {
        this.indicator = new EMA(indicatorConfig.interval)
        this.length = indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.sma) {
        this.indicator = new SMA(indicatorConfig.interval)
        this.length = indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.wma) {
        this.indicator = new WMA(indicatorConfig.interval)
        this.length = indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.hma) {
        this.indicator = new HMA(indicatorConfig.interval)
        this.length = indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.vwma) {
        this.indicator = new VWMA(indicatorConfig.interval)
        this.length = indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.dema) {
        this.indicator = new DEMA(indicatorConfig.interval)
        this.length = 2 * indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.tema) {
        this.indicator = new TEMA(indicatorConfig.interval)
        this.length = 3 * indicatorConfig.interval + 300
      }
      if (indicatorConfig.maType === MAEnum.rma) {
        this.indicator = new RMA(indicatorConfig.interval)
        this.length = indicatorConfig.interval + 300
      }
    }
    if (indicatorConfig.type === IndicatorEnum.tv) {
      this.indicator = new TVTA(
        indicatorConfig.checkLevel,
        indicatorConfig.useAsEntryExitPoints,
      )
      this.length = 3000
    }
    if (indicatorConfig.type === IndicatorEnum.sr) {
      this.indicator = new SupportResistance(
        indicatorConfig.leftBars,
        indicatorConfig.rightBars,
      )
      this.length = indicatorConfig.leftBars + indicatorConfig.rightBars
    }
    if (indicatorConfig.type === IndicatorEnum.mfi) {
      this.indicator = new MFI(
        indicatorConfig.interval,
        indicatorConfig.percentile,
        +(indicatorConfig.percentileLookback ?? '0'),
        +(indicatorConfig.percentilePercentage ?? '0'),
      )
      this.length =
        indicatorConfig.interval +
        (indicatorConfig.percentile
          ? +(indicatorConfig.percentileLookback ?? '0')
          : 0)
    }
    if (indicatorConfig.type === IndicatorEnum.qfl) {
      this.indicator = new QFL(
        indicatorConfig.basePeriods,
        indicatorConfig.pumpPeriods,
        indicatorConfig.pump,
        indicatorConfig.baseCrack,
      )
      this.length = indicatorConfig.basePeriods + indicatorConfig.pumpPeriods
    }
    if (indicatorConfig.type === IndicatorEnum.obfvg) {
      this.indicator = new OBFVG()
      this.length = 1000
    }
    if (indicatorConfig.type === IndicatorEnum.sessions) {
      this.indicator = new Sessions(
        indicatorConfig.enableSunday,
        indicatorConfig.sundayStart,
        indicatorConfig.sundayEnd,
        indicatorConfig.enableMonday,
        indicatorConfig.mondayStart,
        indicatorConfig.mondayEnd,
        indicatorConfig.enableTuesday,
        indicatorConfig.tuesdayStart,
        indicatorConfig.tuesdayEnd,
        indicatorConfig.enableWednesday,
        indicatorConfig.wednesdayStart,
        indicatorConfig.wednesdayEnd,
        indicatorConfig.enableThursday,
        indicatorConfig.thursdayStart,
        indicatorConfig.thursdayEnd,
        indicatorConfig.enableFriday,
        indicatorConfig.fridayStart,
        indicatorConfig.fridayEnd,
        indicatorConfig.enableSaturday,
        indicatorConfig.saturdayStart,
        indicatorConfig.saturdayEnd,
      )
      this.length = 1 // Sessions indicator only needs current candle
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
          )
        }
      } else {
        this.handleError(
          `${this.symbol}@${this.interval}@${this.exchange} error: ${candle.reason} `,
          new Date(start),
        )
      }
    }
    if (this.checkCandleTimer) {
      clearTimeout(this.checkCandleTimer)
    }
    try {
      const timeout =
        +start + +this.period * 2 + +this.waitCandlePeriod - +new Date()
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
  private async updateCandle(_id: string, msg: TradeMessage, forceOld = false) {
    if (this.closed) {
      return
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
    if (forceOld) {
      old.o = +o
      old.h = +h
      old.l = +l
      old.c = +c
      old.v = +v
    }
    const startIndex = start - (!forceOld ? this.period : 0)
    if (
      ((start > this.start && this.start !== 0) || forceOld) &&
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
      this.start = +start + (forceOld ? this.period : 0)
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
    if (this.indicator && this.indicator instanceof VO) {
      this.indicator.next(+value.v)
    }
    if (
      this.indicator &&
      (this.indicator instanceof RSI ||
        this.indicator instanceof MACD ||
        this.indicator instanceof EMA ||
        this.indicator instanceof DEMA ||
        this.indicator instanceof TEMA ||
        this.indicator instanceof RMA ||
        this.indicator instanceof SMA ||
        this.indicator instanceof WMA ||
        this.indicator instanceof HMA)
    ) {
      this.indicator?.next(+value.c)
    }
    if (
      this.indicator &&
      (this.indicator instanceof ADX ||
        this.indicator instanceof StochasticOscillator ||
        this.indicator instanceof CCI ||
        this.indicator instanceof StochasticRSI ||
        this.indicator instanceof WilliamsR ||
        this.indicator instanceof UltimateOscillator ||
        this.indicator instanceof IchimokuCloud ||
        this.indicator instanceof SupportResistance ||
        this.indicator instanceof QFL ||
        this.indicator instanceof PSAR ||
        this.indicator instanceof SuperTrend ||
        this.indicator instanceof ATR ||
        this.indicator instanceof PriorPivot ||
        this.indicator instanceof ADR ||
        this.indicator instanceof ATH)
    ) {
      this.indicator?.next({
        high: +value.h,
        low: +value.l,
        close: +value.c,
      })
    }
    if (
      this.indicator &&
      (this.indicator instanceof BullBear ||
        this.indicator instanceof MOM ||
        this.indicator instanceof ECD ||
        this.indicator instanceof DonchianChannels ||
        this.indicator instanceof OBFVG ||
        this.indicator instanceof Sessions)
    ) {
      this.indicator?.next({
        high: +value.h,
        low: +value.l,
        close: +value.c,
        open: +value.o,
        timestamp: time,
      })
    }
    if (
      this.indicator &&
      (this.indicator instanceof VWMA ||
        this.indicator instanceof TVTA ||
        this.indicator instanceof MFI ||
        this.indicator instanceof BollingerBandsWidth ||
        this.indicator instanceof BollingerBands ||
        this.indicator instanceof KeltnerChannel ||
        this.indicator instanceof KeltnerChannelPB ||
        this.indicator instanceof BBWP ||
        this.indicator instanceof BBPB ||
        this.indicator instanceof MAR ||
        this.indicator instanceof DIV ||
        this.indicator instanceof PC)
    ) {
      this.indicator?.next({
        high: +value.h,
        low: +value.l,
        close: +value.c,
        open: +value.o,
        volume: +value.v,
      })
    }
    if (this.indicator && this.indicator instanceof AO) {
      this.indicator?.next({
        high: +value.h,
        low: +value.l,
      })
    }
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
          `No result for ${this.id} at ${new Date(time)} with value ${JSON.stringify(value)}`,
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
      this.exchange === ExchangeEnum.paperMexc
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
}

export default InternalIndicator
