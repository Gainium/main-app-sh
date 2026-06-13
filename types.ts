import type { Document } from 'mongoose'
import {
  BandsResult,
  IchimokuCloudResult,
  MACDResult,
  StochasticResult,
  PivotResult,
  DIVResult,
  SuperTrendResult,
  PCResult,
  PriorPivotResult,
  QFLResult,
  DCResult,
  PercentileResult,
  OBFVGResult,
  LongWickResult,
} from '@gainium/indicators'
import {
  DCABacktestingInput,
  GRIDBacktestingInput,
} from '@gainium/backtester/dist/types'

/**
 * Price in initial grids
 */
export type PriceInGrid = {
  /**
   * Price for buy case
   */
  buy: number
  /**
   * Price for sell case
   */
  sell: number
}

/**
 * Return from getSellBuyCount function
 */
export type getSellBuyCountReturn = {
  /**
   * Prices for sell orders from current price
   */
  sells: PriceInGrid[]
  /**
   * Prices for buy orders from current price
   */
  buys: PriceInGrid[]
  /**
   * Count sell orders
   */
  sellCount: number
  /**
   * Count buy orders
   */
  buyCount: number
}

export const pairsLimit = 500

export const freePairsLimit = 50

export const indicatorsLimit = 20

export const DEFAULT_DB_LIMIT = 100
export const BOT_STATUS_EVENT = 'Status'
export const BOT_CHANGE_EVENT = 'Change'

export type PositionInfo = {
  symbol: string
  initialMargin: string
  maintMargin: string
  unrealizedProfit: string
  positionInitialMargin: string
  openOrderInitialMargin: string
  leverage: string
  isolated: boolean
  entryPrice: string
  maxNotional: string
  positionSide: PositionSide_LT
  positionAmt: string
  notional: string
  isolatedWallet: string
  updateTime: number
  bidNotional: string
  askNotional: string
}

export enum ExchangeEnum {
  binance = 'binance',
  kucoin = 'kucoin',
  kucoinLinear = 'kucoinLinear',
  kucoinInverse = 'kucoinInverse',
  paperKucoinLinear = 'paperKucoinLinear',
  paperKucoinInverse = 'paperKucoinInverse',
  ftx = 'ftx',
  bybit = 'bybit',
  binanceUS = 'binanceUS',
  ftxUS = 'ftxUS',
  paperBinance = 'paperBinance',
  paperFtx = 'paperFtx',
  paperBybit = 'paperBybit',
  paperKucoin = 'paperKucoin',
  binanceCoinm = 'binanceCoinm',
  binanceUsdm = 'binanceUsdm',
  paperBinanceCoinm = 'paperBinanceCoinm',
  paperBinanceUsdm = 'paperBinanceUsdm',
  bybitCoinm = 'bybitInverse',
  bybitUsdm = 'bybitLinear',
  paperBybitCoinm = 'paperBybitInverse',
  paperBybitUsdm = 'paperBybitLinear',
  okx = 'okx',
  okxLinear = 'okxLinear',
  okxInverse = 'okxInverse',
  paperOkx = 'paperOkx',
  paperOkxLinear = 'paperOkxLinear',
  paperOkxInverse = 'paperOkxInverse',
  coinbase = 'coinbase',
  paperCoinbase = 'paperCoinbase',
  bitget = 'bitget',
  paperBitget = 'paperBitget',
  bitgetUsdm = 'bitgetUsdm',
  bitgetCoinm = 'bitgetCoinm',
  paperBitgetUsdm = 'paperBitgetUsdm',
  paperBitgetCoinm = 'paperBitgetCoinm',
  mexc = 'mexc',
  paperMexc = 'paperMexc',
  hyperliquid = 'hyperliquid',
  hyperliquidLinear = 'hyperliquidLinear',
  paperHyperliquid = 'paperHyperliquid',
  paperHyperliquidLinear = 'paperHyperliquidLinear',
  kraken = 'kraken',
  krakenUsdm = 'krakenUsdm',
  krakenCoinm = 'krakenCoinm',
  paperKraken = 'paperKraken',
  paperKrakenUsdm = 'paperKrakenUsdm',
  paperKrakenCoinm = 'paperKrakenCoinm',
}

export enum BinanceFutures {
  usdm = 'usdm',
  coinm = 'coinm',
  null = 'null',
}

export enum TradeTypeEnum {
  all = 'all',
  margin = 'margin',
  spot = 'spot',
  futures = 'futures',
}

export enum ExchangeDomain {
  us = 'us',
  com = 'com',
}

export enum TypeOrderEnum {
  swap = 'swap',
  regular = 'regular',
  stop = 'stop',
  dealStart = 'dealStart',
  dealRegular = 'dealRegular',
  dealTP = 'dealTP',
  stab = 'stab',
  dealGrid = 'dealGrid',
  split = 'split',
  fee = 'fee',
  liquidation = 'liquidation',
  br = 'br',
  rebalance = 'rebalance',
  hedge = 'hedge',
}

export enum BalancesAction {
  add = 'add',
  reduce = 'reduce',
  none = 'none',
}

export type CompareBalancesResponse = {
  currentBase: number
  currentQuote: number
  realBase: number
  realQuote: number
  filledBase: number
  filledQuote: number
  feeBase: number
  feeQuote: number
  suggestedAction: BalancesAction
  diffBase: number
  diffQuote: number
}

export type TypeOrder =
  | typeof TypeOrderEnum.swap
  | typeof TypeOrderEnum.regular
  | typeof TypeOrderEnum.stop
  | typeof TypeOrderEnum.dealStart
  | typeof TypeOrderEnum.dealRegular
  | typeof TypeOrderEnum.dealTP
  | typeof TypeOrderEnum.stab
  | typeof TypeOrderEnum.dealGrid
  | typeof TypeOrderEnum.split
  | typeof TypeOrderEnum.fee
  | typeof TypeOrderEnum.liquidation
  | typeof TypeOrderEnum.br
  | typeof TypeOrderEnum.rebalance
  | typeof TypeOrderEnum.hedge
export const BUY = 'BUY'
export const SELL = 'SELL'
export const OK = 'OK'
export const NOTOK = 'NOTOK'

/**
 * General statuses of all requests or responses
 * @enum {OK | NOTOK}
 */
export enum StatusEnum {
  ok = 'OK',
  notok = 'NOTOK',
}

export type Currency = 'quote' | 'base'
export type OrderTypes = typeof BUY | typeof SELL

/**
 * Order side
 * @enum {BUY | SELL}
 */
export enum OrderSideEnum {
  buy = 'BUY',
  sell = 'SELL',
}

export type ExchangeInfo = {
  wsCode?: string
  code?: string
  baseAsset: {
    minAmount: number
    maxAmount: number
    step: number
    name: string
    maxMarketAmount: number
    multiplier?: number
  }
  quoteAsset: {
    minAmount: number
    name: string
    precision?: number
  }
  maxOrders: number
  priceAssetPrecision: number
  priceMultiplier?: {
    up: number
    down: number
    decimals: number
  }
  type?: string
  crossAvailable?: boolean
}

export type TpSlCondition = 'valueChanged' | 'priceReached'

export type TpSlAction = 'stop' | 'stopAndSell'

export type Prioritze = 'gridStep' | 'level'
export type BotStatus =
  | 'open'
  | 'closed'
  | 'range'
  | 'error'
  | 'archive'
  | 'monitoring'

/**
 * Bot statuses. Range cannot be set to bot outside, it's only seted by the bot itself
 * @enum {open | closed | range}
 */
export enum BotStatusEnum {
  open = 'open',
  closed = 'closed',
  range = 'range',
  error = 'error',
  archive = 'archive',
  monitoring = 'monitoring',
}

export type GridType = 'geometric' | 'arithmetic'

export interface BaseSettings {
  name: string
  profitCurrency: Currency
  orderFixedIn: Currency
  pair: string | string[]
  futures?: boolean
  coinm?: boolean
  marginType?: BotMarginTypeEnum
  leverage?: number
  strategy?: StrategyEnum
}

export interface BotSettings extends BaseSettings {
  pair: string
  topPrice: number
  lowPrice: number
  levels: number
  gridStep: number
  budget: number
  ordersInAdvance?: number
  useOrderInAdvance: boolean
  prioritize: Prioritze
  sellDisplacement: number
  gridType: GridType
  tpSl?: boolean
  tpSlCondition?: TpSlCondition
  tpSlAction?: TpSlAction
  sl?: boolean
  slCondition?: TpSlCondition
  slAction?: TpSlAction
  tpPerc?: number
  slPerc?: number
  tpTopPrice?: number
  slLowPrice?: number
  updatedBudget?: boolean
  useStartPrice?: boolean
  startPrice?: string
  futures?: boolean
  newProfit?: boolean
  newBalance?: boolean
  coinm?: boolean
  strategy?: StrategyEnum
  futuresStrategy?: FuturesStrategyEnum
  slLimit?: boolean
  tpSlLimit?: boolean
  feeOrder?: boolean
  lastPriceRangeAlert?: number
  skipBalanceCheck?: boolean
}

export enum FuturesStrategyEnum {
  long = 'LONG',
  short = 'SHORT',
  neutral = 'NEUTRAL',
}

export enum StrategyEnum {
  long = 'LONG',
  short = 'SHORT',
}

export enum ActionsEnum {
  useBalance = 'useBalance',
  buyForAll = 'buyForAll',
  buyDiff = 'buyDiff',
  sellForAll = 'sellForAll',
  sellDiff = 'sellDiff',
  noAction = 'noAction',
  useOppositeBalance = 'useOppositeBalance',
}

export enum OrderTypeEnum {
  limit = 'LIMIT',
  market = 'MARKET',
}

export enum StartConditionEnum {
  asap = 'ASAP',
  manual = 'Manual',
  tradingviewSignals = 'TradingviewSignals',
  timer = 'Timer',
  ti = 'TechnicalIndicators',
}

export enum IndicatorStartConditionEnum {
  cd = 'cd',
  cu = 'cu',
  gt = 'gt',
  lt = 'lt',
}

export enum BBCrossingEnum {
  middle = 'middle',
  upper = 'upper',
  lower = 'lower',
}

export enum SRCrossingEnum {
  support = 'support',
  resistance = 'resistance',
}
export enum rsiValueEnum {
  k = 'k',
  d = 'd',
}
export enum rsiValue2Enum {
  k = 'k',
  d = 'd',
  custom = 'custom',
}
export enum StochRangeEnum {
  upper = 'upper',
  lower = 'lower',
  both = 'both',
  none = 'none',
}
export enum IndicatorAction {
  startDeal = 'startDeal',
  closeDeal = 'closeDeal',
  startDca = 'startDca',
  stopBot = 'stopBot',
  riskReward = 'riskReward',
  startBot = 'startBot',
}
export enum IndicatorSection {
  tp = 'tp',
  sl = 'sl',
  dca = 'dca',
  controller = 'controller',
}
export type SettingsIndicators = {
  type: IndicatorEnum
  indicatorLength: number
  indicatorValue: string
  indicatorCondition: IndicatorStartConditionEnum
  indicatorInterval: ExchangeIntervals
  groupId: string
  uuid: string
  signal?: TradingviewAnalysisSignalEnum
  condition?: TradingviewAnalysisConditionEnum
  checkLevel?: number
  maType?: MAEnum
  maCrossingValue?: MAEnum
  maCrossingLength?: number
  maCrossingInterval?: ExchangeIntervals
  maUUID?: string
  bbCrossingValue?: BBCrossingEnum
  stochSmoothK?: number
  stochSmoothD?: number
  stochUpper?: string
  stochLower?: string
  stochRSI?: number
  rsiValue?: rsiValueEnum
  rsiValue2?: rsiValue2Enum
  valueInsteadof?: number
  leftBars?: number
  rightBars?: number
  srCrossingValue?: SRCrossingEnum
  basePeriods?: number
  pumpPeriods?: number
  pump?: number
  interval?: number
  baseCrack?: number
  indicatorAction: IndicatorAction
  section?: IndicatorSection
  psarStart?: number
  psarInc?: number
  psarMax?: number
  stochRange?: StochRangeEnum
  minPercFromLast?: string
  orderSize?: string
  keepConditionBars?: string
  voShort?: number
  voLong?: number
  uoFast?: number
  uoMiddle?: number
  uoSlow?: number
  momSource?: string
  bbwpLookback?: number
  ecdTrigger?: ECDTriggerEnum
  xOscillator1?:
    | IndicatorEnum.rsi
    | IndicatorEnum.cci
    | IndicatorEnum.mfi
    | IndicatorEnum.vo
  xOscillator2?:
    | IndicatorEnum.rsi
    | IndicatorEnum.cci
    | IndicatorEnum.mfi
    | IndicatorEnum.vo
  xOscillator2length?: number
  xOscillator2Interval?: ExchangeIntervals
  xOscillator2voLong?: number
  xOscillator2voShort?: number
  xoUUID?: string
  mar1length?: number
  mar1type?: MAEnum
  mar2length?: number
  mar2type?: MAEnum
  bbwMult?: number
  bbwMa?: MAEnum
  bbwMaLength?: number
  macdFast?: number
  macdSlow?: number
  macdMaSource?: MAEnum
  macdMaSignal?: MAEnum
  divOscillators?: DivergenceOscillators[]
  divType?: DivTypeEnum
  divMinCount?: number
  factor?: number
  atrLength?: number
  stCondition?: STConditionEnum
  pcUp?: string
  pcDown?: string
  pcCondition?: PCConditionEnum
  pcValue?: string
  ppHighLeft?: number
  ppHighRight?: number
  ppLowLeft?: number
  ppLowRight?: number
  ppMult?: number
  ppValue?: ppValueEnum
  ppType?: ppValueTypeEnum
  riskAtrMult?: string
  dynamicArFactor?: string
  athLookback?: number
  kcMa?: MAEnum
  kcRange?: RangeType
  kcRangeLength?: number
  unpnlValue?: number
  unpnlCondition?: IndicatorStartConditionEnum
  dcValue?: DCValueEnum
  obfvgValue?: OBFVGValueEnum
  obfvgRef?: OBFVGRefEnum
  sessionDays?: number[]
  sessionRule?: SessionRuleEnum
  lwThreshold?: string
  lwMaxDuration?: string
  lwValue?: LWValueEnum
  lwCondition?: LWConditionEnum
} & Percentile &
  TrendFilter

export enum LWConditionEnum {
  onStart = 'onStart',
  during = 'during',
}

export enum SessionRuleEnum {
  in = 'in',
  out = 'out',
}

export enum LWValueEnum {
  top = 'top',
  bottom = 'bottom',
  any = 'any',
}

export enum OBFVGValueEnum {
  bullish = 'bullish',
  bearish = 'bearish',
  any = 'any',
}

export enum OBFVGRefEnum {
  high = 'high',
  low = 'low',
  middle = 'middle',
}

export enum DCValueEnum {
  basis = 'basis',
  lower = 'lower',
  upper = 'upper',
}

export enum ppValueTypeEnum {
  price = 'Price Based',
  event = 'Event Based',
  market = 'Market Based',
}

export enum ppValueEnum {
  hh = 'HH',
  hl = 'HL',
  lh = 'LH',
  ll = 'LL',
  anyH = 'Any High',
  anyL = 'Any Low',
  sl = 'SL',
  wl = 'WL',
  sh = 'SH',
  wh = 'WH',
  anySWL = 'anyL',
  anySWH = 'anyH',
  bullMarket = 'BullM',
  bearMarket = 'BearM',
  sBullBoS = 'SBullBoS',
  sBearBoS = 'SBearBoS',
  sBullCHoCH = 'SBullCHoCH',
  sBearCHoCH = 'SBearCHoCH',
  iBullBoS = 'IBullBoS',
  iBearBoS = 'IBearBoS',
  iBullCHoCH = 'IBullCHoCH',
  iBearCHoCH = 'IBearCHoCH',
  IanyBull = 'IAnyBull',
  IanyBear = 'IAnyBear',
  SanyBull = 'SAnyBull',
  SanyBear = 'SAnyBear',
  bullAnyBoS = 'BullAnyBoS',
  bearAnyBoS = 'BearAnyBoS',
  bullAnyCHoCH = 'BullAnyCHoCH',
  bearAnyCHoCH = 'BearAnyCHoCH',
}

export enum PCConditionEnum {
  up = 'UP',
  down = 'DOWN',
}

export enum STConditionEnum {
  up = 'up',
  down = 'down',
  upToDown = 'upToDown',
  downToUp = 'downToUp',
}

export enum DivTypeEnum {
  bull = 'Bullish',
  bear = 'Bearish',
  hbull = 'Hidden Bullish',
  hbear = 'Hidden Bearish',
  abull = 'Any Bullish',
  abear = 'Any Bearish',
}

export enum ECDTriggerEnum {
  bearish = 'bearish',
  bullish = 'bullish',
  both = 'both',
}

export enum TradingviewAnalysisSignalEnum {
  strongBuy = 'strongBuy',
  strongSell = 'strongSell',
  buy = 'buy',
  sell = 'sell',
  bothBuy = 'bothBuy',
  bothSell = 'bothSell',
}

export enum TradingviewAnalysisConditionEnum {
  every = 'every',
  entry = 'entry',
}

export enum OrderSizeTypeEnum {
  base = 'base',
  quote = 'quote',
  percTotal = 'percTotal',
  percFree = 'percFree',
  usd = 'usd',
}

export enum BotStartTypeEnum {
  manual = 'manual',
  webhook = 'webhook',
  indicators = 'indicators',
  price = 'price',
}

export enum CloseConditionEnum {
  tp = 'tp',
  techInd = 'techInd',
  manual = 'manual',
  webhook = 'webhook',
  dynamicAr = 'dynamicAr',
}

export type MultiTP = {
  target: string
  amount: string
  uuid: string
  fixed?: string
}

export enum DCAConditionEnum {
  percentage = 'percentage',
  indicators = 'indicators',
  custom = 'custom',
  dynamicAr = 'dynamicAr',
}

export enum BaseSlOnEnum {
  start = 'start',
  avg = 'avg',
}

export type DCACustom = {
  step: string
  size: string
  uuid: string
}

export enum CooldownOptionsEnum {
  symbol = 'symbol',
  bot = 'bot',
}

export enum DCAVolumeType {
  scale = 'scale',
  change = 'change',
}

export enum DcaVolumeRequiredChangeRef {
  tp = 'tp',
  avg = 'avg',
}

export type SettingsIndicatorGroup = {
  id: string
  logic: IndicatorsLogicEnum
  action: IndicatorAction
  section?: IndicatorSection
}

export enum RRSlTypeEnum {
  fixed = 'fixed',
  indicator = 'indicator',
}

export interface DCABotSettings extends BaseSettings {
  skipBalanceCheck?: boolean
  dcaCondition?: DCAConditionEnum
  dcaVolumeBaseOn?: DCAVolumeType
  dcaVolumeRequiredChange?: string
  dcaVolumeMaxValue?: string
  dcaVolumeRequiredChangeRef?: DcaVolumeRequiredChangeRef
  baseSlOn?: BaseSlOnEnum
  dcaCustom?: DCACustom[]
  strategy: StrategyEnum
  baseOrderSize: string
  baseOrderPrice?: string
  useLimitPrice?: boolean
  startOrderType: OrderTypeEnum
  startCondition: StartConditionEnum
  tpPerc: string
  slPerc: string
  orderSize: string
  step: string
  ordersCount: number
  activeOrdersCount: number
  volumeScale: string
  stepScale: string
  minimumDeviation?: string
  useTp: boolean
  useSl: boolean
  useSmartOrders: boolean
  minOpenDeal?: string
  maxOpenDeal?: string
  useDca: boolean
  hodlDay: string
  hodlAt: string
  hodlHourly?: boolean
  hodlNextBuy: number
  maxNumberOfOpenDeals?: string
  indicators: SettingsIndicators[]
  indicatorGroups: SettingsIndicatorGroup[]
  type?: DCATypeEnum
  orderSizeType: OrderSizeTypeEnum
  limitTimeout?: string
  useLimitTimeout?: boolean
  notUseLimitReposition?: boolean
  cooldownAfterDealStart?: boolean
  cooldownAfterDealStartUnits?: CooldownUnits
  cooldownAfterDealStartInterval?: number
  cooldownAfterDealStartOption?: CooldownOptionsEnum
  cooldownAfterDealStop?: boolean
  cooldownAfterDealStopUnits?: CooldownUnits
  cooldownAfterDealStopInterval?: number
  cooldownAfterDealStopOption?: CooldownOptionsEnum
  moveSL?: boolean
  moveSLTrigger?: string
  moveSLValue?: string
  moveSLForAll?: boolean
  trailingSl?: boolean
  trailingTp?: boolean
  trailingTpPerc?: string
  useCloseAfterX?: boolean
  useCloseAfterXwin?: boolean
  closeAfterXwin?: string
  useCloseAfterXloss?: boolean
  closeAfterXloss?: string
  useCloseAfterXprofit?: boolean
  closeAfterXprofitValue?: string
  closeAfterXprofitCond?: IndicatorStartConditionEnum
  closeAfterX?: string
  useCloseAfterXopen?: boolean
  closeAfterXopen?: string
  pair: string[]
  useMulti?: boolean
  maxDealsPerPair?: string
  ignoreStartDeals?: boolean
  comboTpBase?: ComboTpBase
  botStart?: BotStartTypeEnum
  useBotController?: boolean
  stopType?: CloseDCATypeEnum
  stopStatus?: 'closed' | 'monitoring'
  dealCloseCondition?: CloseConditionEnum
  dealCloseConditionSL?: CloseConditionEnum
  useMinTP?: boolean
  minTp?: string
  closeDealType?: CloseDCATypeEnum
  closeOrderType?: OrderTypeEnum
  terminalDealType?: TerminalDealTypeEnum
  useMultiTp?: boolean
  multiTp?: MultiTP[]
  useMultiSl?: boolean
  pairPrioritization?: PairPrioritizationEnum
  multiSl?: MultiTP[]
  marginType?: BotMarginTypeEnum
  leverage?: number
  futures?: boolean
  importFrom?: string
  gridLevel?: string
  useVolumeFilter?: boolean
  useRelativeVolumeFilter?: boolean
  volumeTop?: string
  relativeVolumeTop?: string
  volumeValue?: VolumeValueEnum
  relativeVolumeValue?: VolumeValueEnum
  useFixedTPPrices?: boolean
  useFixedSLPrices?: boolean
  fixedTpPrice?: string
  fixedSlPrice?: string
  baseStep?: string
  baseGridLevels?: string
  useActiveMinigrids?: boolean
  comboActiveMinigrids?: string
  comboSlLimit?: boolean
  comboTpLimit?: boolean
  closeByTimer?: boolean
  closeByTimerValue?: number
  closeByTimerUnits?: CooldownUnits
  feeOrder?: boolean
  maxDealsPerHigherTimeframe?: string
  useMaxDealsPerHigherTimeframe?: boolean
  remainderFullAmount?: boolean
  autoRebalancing?: boolean
  adaptiveClose?: boolean
  useStaticPriceFilter?: boolean
  useCooldown?: boolean
  useVolumeFilterAll?: boolean
  useDynamicPriceFilter?: boolean
  dynamicPriceFilterDeviation?: string
  dynamicPriceFilterOverValue?: string
  dynamicPriceFilterUnderValue?: string
  dynamicPriceFilterPriceType?: DynamicPriceFilterPriceTypeEnum
  dynamicPriceFilterDirection?: DynamicPriceFilterDirectionEnum
  useRiskReward?: boolean
  rrSlType?: RRSlTypeEnum
  rrSlFixedValue?: string
  riskSlType?: RiskSlTypeEnum
  riskSlAmountPerc?: string
  riskSlAmountValue?: string
  riskUseTpRatio?: boolean
  riskTpRatio?: string
  riskMinPositionSize?: string
  riskMaxPositionSize?: string
  dynamicArLockValue?: boolean
  comboUseSmartGrids?: boolean
  comboSmartGridsCount?: string
  riskMaxSl?: string
  riskMinSl?: string
  scaleDcaType?: ScaleDcaTypeEnum
  startDealLogic?: IndicatorsLogicEnum
  stopDealLogic?: IndicatorsLogicEnum
  stopDealSlLogic?: IndicatorsLogicEnum
  stopBotLogic?: IndicatorsLogicEnum
  useRiskReduction?: boolean
  riskReductionValue?: string
  useReinvest?: boolean
  reinvestValue?: string
  startBotPriceCondition?: IndicatorStartConditionEnum
  startBotPriceValue?: string
  stopBotPriceCondition?: IndicatorStartConditionEnum
  stopBotPriceValue?: string
  startBotLogic?: IndicatorsLogicEnum
  botActualStart?: BotStartTypeEnum
  useNoOverlapDeals?: boolean
  useSeparateMaxDealsOverAndUnder?: boolean
  maxDealsOver?: string
  maxDealsUnder?: string
  useSeparateMaxDealsOverAndUnderPerSymbol?: boolean
  maxDealsOverPerSymbol?: string
  maxDealsUnderPerSymbol?: string
  dcaByMarket?: boolean
}

export enum IndicatorsLogicEnum {
  and = 'and',
  or = 'or',
}

export enum ScaleDcaTypeEnum {
  percentage = 'percentage',
  atr = 'atr',
  adr = 'adr',
}

export enum RiskSlTypeEnum {
  perc = 'perc',
  fixed = 'fixed',
}

export enum DynamicPriceFilterDirectionEnum {
  over = 'over',
  under = 'under',
  overAndUnder = 'overAndUnder',
}

export enum PairPrioritizationEnum {
  alphabetical = 'alphabetical',
  random = 'random',
}

export enum DynamicPriceFilterPriceTypeEnum {
  avg = 'avg',
  entry = 'entry',
}

export enum ComboTpBase {
  full = 'full',
  filled = 'filled',
}

export enum VolumeValueEnum {
  top25 = 'top25',
  top100 = 'top100',
  top200 = 'top200',
  custom = 'custom',
}

export interface ComboBotSettings extends DCABotSettings {
  gridLevel: string
  newBalance?: boolean
  feeOrder?: boolean
}

export enum TerminalDealTypeEnum {
  simple = 'simple',
  smart = 'smart',
  import = 'import',
}

export enum CooldownUnits {
  seconds = 'seconds',
  minutes = 'minutes',
  hours = 'hours',
  days = 'days',
}

export enum DCATypeEnum {
  regular = 'regular',
  terminal = 'terminal',
  trigger = 'trigger',
}

export type WorkingShift = {
  start: number
  end?: number
}

/**
 * Initial price from swap, user or swap
 * @enum {start | swap | user}
 */
export enum InitialPriceFromEnum {
  start = 'start',
  swap = 'swap',
  user = 'user',
}

export enum ThemeModeEnum {
  Dark = 'dark',
  Light = 'light',
}

export type Symbols = {
  symbol: string
  baseAsset: string
  quoteAsset: string
}
export type BotData = {
  _id: string
  userId: string
  status: BotStatusEnum
  previousStatus: BotStatusEnum
  settings: BotSettings
  exchange: ExchangeEnum
  exchangeUUID: string
  initialPrice: number
  initialPriceFrom?: InitialPriceFromEnum
  initialPriceStart?: number
  initialPriceStartFrom?: InitialPriceFromEnum
  workingShift: WorkingShift[]
  workingTimeNumber: number
  initialBalances: Asset
  currentBalances: Asset
  levels: {
    active: Level
    all: Level
  }
  usdRate: number
  lastPrice: number
  lastUsdRate: number
  transactionsCount: Level
  profit: {
    total: number
    totalUsd: number
    freeTotal: number
    freeTotalUsd: number
    pureBase?: number
    pureQuote?: number
  }
  profitToday: {
    start: number
    end: number
    totalToday: number
    totalTodayUsd: number
  }
  symbol: Symbols
  created?: Date
  public?: boolean
  avgPrice?: number
}
export type DCABotData = {
  _id: string
  userId: string
  status: BotStatus
  settings: DCABotSettings
  exchange: ExchangeEnum
  exchangeUUID: string
  workingShift: WorkingShift[]
  workingTimeNumber: number
  initialBalances: Asset
  currentBalances: Asset
  usdRate: number
  lastPrice: number
  lastUsdRate: number
  profit: {
    total: number
    totalUsd: number
  }
  profitToday: {
    start: number
    end: number
    totalToday: number
    totalTodayUsd: number
  }
  symbol: {
    symbol: string
    baseAsset: string
    quoteAsset: string
  }
  created?: Date
  public?: boolean
}

export enum DCADealStatusEnum {
  /** take profit is filled */
  closed = 'closed',
  /** base order is filled */
  open = 'open',
  /** send base order */
  start = 'start',
  /** error from base order */
  error = 'error',
  /** canceled by user */
  canceled = 'canceled',
}

export type GridFilterItem = {
  field?: string
  operator?: string
  value: string
  id?: number
}

export type LegacyGridFilterItem = {
  columnField?: string
  operatorValue?: string
  value: string
  id?: number
}

export type GridSortModel = {
  field?: string
  sort?: string
}

export type DataGridFilterInput = {
  page?: number
  pageSize?: number
  sortModel?: GridSortModel[]
  filterModel?: { items: GridFilterItem[]; linkOperator?: string }
}

export type DCADealsSettings = Pick<
  DCABotSettings,
  | 'ordersCount'
  | 'baseOrderSize'
  | 'baseOrderPrice'
  | 'useLimitPrice'
  | 'startOrderType'
  | 'tpPerc'
  | 'profitCurrency'
  | 'baseOrderSize'
  | 'orderSize'
  | 'useTp'
  | 'useDca'
  | 'useSmartOrders'
  | 'activeOrdersCount'
  | 'volumeScale'
  | 'stepScale'
  | 'minimumDeviation'
  | 'step'
  | 'useSl'
  | 'slPerc'
  | 'trailingSl'
  | 'moveSL'
  | 'moveSLTrigger'
  | 'moveSLValue'
  | 'moveSLForAll'
  | 'trailingTp'
  | 'trailingTpPerc'
  | 'useMinTP'
  | 'minTp'
  | 'orderSizeType'
  | 'useMultiSl'
  | 'multiSl'
  | 'useMultiTp'
  | 'multiTp'
  | 'dealCloseCondition'
  | 'dealCloseConditionSL'
  | 'closeDealType'
  | 'futures'
  | 'coinm'
  | 'marginType'
  | 'leverage'
  | 'gridLevel'
  | 'useFixedTPPrices'
  | 'useFixedSLPrices'
  | 'fixedTpPrice'
  | 'fixedSlPrice'
  | 'dcaCondition'
  | 'dcaCustom'
  | 'closeByTimer'
  | 'closeByTimerUnits'
  | 'closeByTimerValue'
  | 'feeOrder'
  | 'comboTpBase'
  | 'comboSmartGridsCount'
  | 'comboUseSmartGrids'
  | 'comboActiveMinigrids'
  | 'useActiveMinigrids'
  | 'baseSlOn'
  | 'dcaVolumeBaseOn'
  | 'dcaVolumeMaxValue'
  | 'dcaVolumeRequiredChange'
  | 'closeOrderType'
  | 'dcaByMarket'
> & {
  avgPrice: number
  changed: boolean
  orderSizePercQty?: number
  slChangedByUser?: boolean
  updatedComboAdjustments?: boolean
}

export type ComboDealsSettings = DCADealsSettings &
  Pick<ComboBotSettings, 'gridLevel'> & { updatedComboAdjustments?: boolean }

export enum TrailingModeEnum {
  ttp = 'ttp',
  tsl = 'tsl',
}

export type ProfitLossStats = {
  drawdownPercent: number
  runUpPercent: number
  timeInProfit: number
  timeInLoss: number
  trackTime: number
  timeCountStart: number
  currentCount?: 'loss' | 'profit'
  unrealizedProfit: number
  usage: number
  maxUsage: number
}

export type BlockOrder = { price: number; qty: number; side: OrderSideEnum }

export type Sizes = {
  base: number
  dca: number[]
  origBase: number
  origDca: number[]
}

export enum DCADealFlags {
  newMultiTp = 'newMultiTp',
  futuresPrecision = 'futuresPrecision',
  externalTp = 'externalTp',
  externalSl = 'externalSl',
}

export enum DCACloseTriggerEnum {
  combined = 'combined',
  manual = 'manual',
  tp = 'tp',
  sl = 'sl',
  webhook = 'webhook',
  api = 'api',
  trailing = 'trailing',
  liquidation = 'liquidation',
  auto = 'auto',
  bot = 'bot',
  timer = 'timer',
  indicator = 'indicator',
  base = 'base',
}

export interface DCADealsSchema extends SchemaI {
  action?: ActionsEnum
  closeTrigger?: DCACloseTriggerEnum
  flags?: DCADealFlags[]
  balanceStart?: number
  cost?: number
  value?: number
  size?: number
  note?: string
  botId: string
  userId: string
  status: DCADealStatusEnum
  initialBalances: Asset
  currentBalances: Asset
  initialPrice: number
  lastPrice: number
  profit: {
    total: number
    totalUsd: number
    pureBase?: number
    pureQuote?: number
    gridProfit?: number
    gridProfitUsd?: number
  }
  feePaid?: {
    base?: number
    quote?: number
  }
  avgPrice: number
  displayAvg: number
  commission: number
  createTime: number
  updateTime: number
  closeTime?: number
  levels: {
    all: number
    complete: number
  }
  usage: Usage
  assets: { used: Asset; required: Asset }
  settings: DCADealsSettings
  parentId: string | null
  childIds: string[]
  parent: boolean
  child: boolean
  gridBreakpoints: GridBreakpoint[]
  paperContext?: boolean
  type?: DCATypeEnum
  strategy: StrategyEnum
  exchange: string
  exchangeUUID: string
  symbol: {
    symbol: string
    baseAsset: string
    quoteAsset: string
  }
  bestPrice?: number
  trailingLevel?: number
  trailingMode?: TrailingModeEnum
  stats: ProfitLossStats
  tpSlTargetFilled?: string[]
  blockSl?: boolean
  tpHistory?: { id: string; qty: number; price: number }[]
  tpFilledHistory?: { id: string; qty: number; price: number }[]
  dynamicAr?: DynamicArPrices[]
  allowBaseProcess?: boolean
  pendingAddFunds?: (AddFundsSettings & { id: string })[]
  pendingReduceFunds?: (AddFundsSettings & { id: string })[]
  blockOrders?: BlockOrder[]
  funds?: {
    price: number
    qty: number
  }[]
  reduceFunds?: {
    price: number
    qty: number
  }[]
  ignoreLevels?: number[]
  isDeleted?: boolean
  feeBalance?: number
  moveSlActivated?: boolean
  newBalance?: boolean
  sizes?: Sizes
  fullFee?: number
  fixSize?: number
  orderSizeType?: OrderSizeTypeEnum
  tags?: string[]
  ac?: {
    before: number
    after: number
  }
  enterMarketPrice?: boolean
  eightySent?: number
  hundredSent?: number
  sellRemainder?: boolean
  parentBotId?: string
}

export enum AddFundsTypeEnum {
  fixed = 'fixed',
  perc = 'perc',
}

export type AddFundsSettings = {
  qty: string
  useLimitPrice: boolean
  limitPrice?: string
  asset: OrderSizeTypeEnum
  type?: AddFundsTypeEnum
}

export interface ComboDealsSchema extends DCADealsSchema {
  botId: string
  userId: string
  status: DCADealStatusEnum
  initialBalances: Asset
  currentBalances: Asset
  feeBalance?: number
  moveSlActivated?: boolean
  initialPrice: number
  lastPrice: number
  profit: {
    total: number
    totalUsd: number
    pureBase?: number
    pureQuote?: number
    gridProfit?: number
    gridProfitUsd?: number
  }
  feePaid?: {
    base?: number
    quote?: number
  }
  avgPrice: number
  displayAvg: number
  commission: number
  createTime: number
  updateTime: number
  closeTime?: number
  levels: {
    all: number
    complete: number
  }
  usage: Usage
  assets: { used: Asset; required: Asset }
  settings: ComboDealsSettings
  paperContext?: boolean
  strategy: StrategyEnum
  exchange: string
  exchangeUUID: string
  symbol: {
    symbol: string
    baseAsset: string
    quoteAsset: string
  }
  stats: ProfitLossStats
  lastFilledLevel?: number
  totalAssetAmount?: number
  pendingAddFunds?: (AddFundsSettings & { id: string })[]
  funds?: {
    price: number
    qty: number
  }[]
  transactions?: {
    buy: number
    sell: number
  }
}

export interface ComboProfitSchema extends SchemaI {
  profit: {
    total: number
    totalUsd: number
  }
  userId: string
  botId: string
  updateTime: number
  paperContext: boolean
  isDeleted?: boolean
}

export type CleanComboProfitSchema = ExcludeDoc<ComboProfitSchema>

export enum ComboMinigridStatusEnum {
  active = 'active',
  range = 'range',
  closed = 'closed',
}

export interface ComboMinigridSchema extends SchemaI {
  botId: string
  userId: string
  dealId: string
  dcaOrderId: string
  grids: { buy: number; sell: number }
  status: ComboMinigridStatusEnum
  initialBalances: Asset
  currentBalances: Asset
  initialPrice: number
  realInitialPrice: number
  lastPrice: number
  lastSide: OrderSideEnum
  profit: {
    total: number
    totalUsd: number
    pureBase?: number
    pureQuote?: number
  }
  feePaid?: {
    base?: number
    quote?: number
  }
  avgPrice: number
  createTime: number
  updateTime: number
  closeTime?: number
  assets: { used: Asset; required: Asset }
  paperContext?: boolean
  exchange: string
  exchangeUUID: string
  symbol: {
    symbol: string
    baseAsset: string
    quoteAsset: string
  }
  settings: {
    topPrice: number
    lowPrice: number
    levels: number
    budget: number
    sellDisplacement: number
    profitCurrency: Currency
    orderFixedIn: Currency
  }
  transactions: {
    buy: number
    sell: number
  }
  lockClose: boolean
}

export type CleanComboMinigridSchema = ExcludeDoc<ComboMinigridSchema>

export type GridBreakpoint = {
  price: number
  displacedPrice: number
}
export type CleanDCADealsSchema = ExcludeDoc<DCADealsSchema>

export type CleanComboDealsSchema = ExcludeDoc<ComboDealsSchema>
export type UserToken = {
  token: string
  expiredAt: number
  createdAt: number
}
export type UserData = {
  id: string
  username: string
  passwordHash: string
  tokens: UserToken[]
  exchange: ExchangeInUser[]
  timezone: string
  demo?: boolean
}
export type OrderData = {
  userId: string
  botId: string
  id: string
  clientOrderId: string
  cummulativeQuoteQty: string
  executedQty: string
  icebergQty: string
  isWorking: boolean
  orderId?: number
  origQty: string
  price: string
  side: string
  status: string
  stopPrice: string
  symbol: string
  time: number
  timeInForce: string
  type: string
  updateTime: number
  exchange: ExchangeEnum
  exchangeUUID: string
  typeOrder: TypeOrder
}

export interface BaseSchema {
  created?: Date
  updated?: Date
  _id: any
  __v?: number
}

export type ExcludeDoc<T> = Omit<T, keyof Omit<Document, 'id'>> & BaseSchema

export interface SchemaI extends Document, BaseSchema {
  created?: Date
  updated?: Date
  _id: any
  __v?: number
}

export enum CoinbaseKeysType {
  legacy = 'legacy',
  cloud = 'cloud',
}

export enum OKXSource {
  my = 'my',
  app = 'app',
  com = 'com',
}

export type ExchangeInUser = {
  provider: ExchangeEnum
  name: string
  key: string
  secret: string
  passphrase?: string
  uuid: string
  hedge?: boolean
  notAllowedToDelete?: boolean
  linkedTo?: string
  status?: boolean
  lastUpdated?: number
  keysType?: CoinbaseKeysType
  okxSource?: OKXSource
  zeroFee?: boolean
  subaccount?: boolean
  bybitHost?: BybitHost
  affiliate?: boolean
}

export interface FavoritePairsSchema extends SchemaI {
  provider: ExchangeEnum
  userId: string
  pairs: string[]
}

export interface FavoriteIndicatorsSchema extends SchemaI {
  userId: string
  indicators: IndicatorEnum[]
}

export enum APIPermission {
  read = 'read',
  write = 'write',
}

export interface UserSchema extends SchemaI {
  username: string
  password: string
  bigAccount?: boolean
  tokens: UserToken[]
  exchanges: ExchangeInUser[]
  timezone: string
  weekStart?: string
  theme?: ThemeModeEnum
  picture?: string
  name?: string
  lastName?: string
  paperContext?: boolean
  apiKeys?: {
    _id?: string
    secret: string
    created: Date
    expired: Date
    permission: APIPermission
    paperContext?: boolean
    botId?: string
    /** Set when this key was minted for an OAuth grant (a "connected app").
     *  Such keys are managed under Settings → Connected apps, not the regular
     *  API Keys list, so the UI filters them out there. */
    oauthClientId?: string
  }[]
  shouldOnBoard?: boolean
  shouldOnBoardExchange?: boolean
  onboardingSteps: {
    signup: boolean
    liveExchange: boolean
    deployLiveBot: boolean
    earnProfit: boolean
  }
  last_active?: Date
  displayName?: string | null
  ips?: {
    ip?: string
    userAgent?: string
    location?: { country?: string; city?: string }
    created?: Date
    updated?: Date
  }[]
  videos?: { id: string; watch80?: boolean; closed?: boolean }[]
  licenseKey?: string
}

export interface BotEventSchema extends SchemaI {
  botId: string
  botType: BotType
  userId: string
  event: string
  description?: string
  metadata?: any
  paperContext: boolean
  type?: MessageTypeEnum
  deal?: string
  symbol?: string
}

export type CleanBotEventSchema = ExcludeDoc<BotEventSchema>

export type ClearUserSchema = ExcludeDoc<UserSchema>

export interface TransactionSchema extends SchemaI {
  updateTime: number
  side: typeof BUY | typeof SELL
  amountBaseBuy: number
  amountQuoteBuy: number
  amountBaseSell: number
  amountQuoteSell: number
  amountFreeBaseBuy: number
  amountFreeQuoteBuy: number
  amountFreeBaseSell: number
  amountFreeQuoteSell: number
  priceBuy: number
  priceSell: number
  idBuy: string
  idSell: string
  feeBase: number
  feeQuote: number
  profitBase: number
  profitQuote: number
  botId: string
  userId: string
  symbol: string
  baseAsset: string
  quoteAsset: string
  profitCurrency: string
  profitUsdt: number
  freeProfitUsd: number
  paperContext?: boolean
  cummulativeProfitBase?: number
  cummulativeProfitQuote?: number
  cummulativeProfitUsdt?: number
  executor?: string
  index?: string
  isDeleted?: boolean
  pureBase?: number
  pureQuote?: number
  pureFeeBase?: number
  pureFeeQuote?: number
}

export interface ComboTransactionSchema extends TransactionSchema {
  dealId?: string
  minigridId?: string
}

export type ClearComboTransactionSchema = ExcludeDoc<ComboTransactionSchema>
export type ClearTransactionSchema = ExcludeDoc<TransactionSchema>
type Level = {
  buy: number
  sell: number
}
export type Asset = {
  base: number
  quote: number
}

export type MultiAssets = {
  base: Map<string, number>
  quote: Map<string, number>
}

export enum BotProgressCodeEnum {
  placeSwap = 'Place swap order',
  placeOrder = 'Place order',
  cancelOrder = 'Cancel order',
  placeStop = 'Waiting stop order to fill',
}

export interface MainBot<T = BaseSettings> extends SchemaI {
  locked?: boolean
  unrealizedProfit?: number
  pendingClose?: boolean
  pendingCloseTime?: number
  userId: string
  status: BotStatusEnum
  previousStatus?: BotStatusEnum
  statusReason?: string
  showErrorWarning?: 'error' | 'warning' | 'none'
  exchange: ExchangeEnum
  exchangeUUID: string
  settings: T
  workingShift: WorkingShift[]
  workingTimeNumber: number
  profit: {
    total: number
    totalUsd: number
    freeTotal: number
    freeTotalUsd: number
    pureBase?: number
    pureQuote?: number
  }
  profitByAssets?: { asset: string; total: number; totalUsd: number }[]
  profitToday: {
    start: number
    end: number
    totalToday: number
    totalTodayUsd: number
  }
  uuid: string
  progress?: {
    stage: number
    total: number
    text: BotProgressCodeEnum
    isAllowedToCancel: boolean
  } | null
  paperContext?: boolean
  isDeleted?: boolean
  deleteTime?: Date
  exchangeUnassigned?: boolean
  parentBotId?: string
  vars?: BotVars | null
  notEnoughBalance?: {
    orders?: Record<string, number>
    thresholdPassed?: boolean
    thresholdPassedTime?: number
  }
  share?: boolean
  shareId?: string
  cost?: number
}

export type BotVars = {
  list: string[]
  paths: { path: string; variable: string }[]
}

export type CleanMainBot = ExcludeDoc<MainBot>
export type PositionInBot = {
  side: PositionSide
  qty: number
  price: number
}
export interface BotSchema extends MainBot<BotSettings> {
  initialPrice: number
  initialPriceFrom?: InitialPriceFromEnum
  initialPriceStart?: number
  initialPriceStartFrom?: InitialPriceFromEnum
  levels: {
    active: Level
    all: Level
  }
  transactionsCount: Level
  avgPrice?: number
  swapType?: BuyTypeEnum
  swapSellCount?: number
  initPriceForStartPrice?: number
  haveStarted?: boolean
  lastBalanceChange?: number | null
  realInitialBalances: Asset | null
  symbol: Symbols
  initialBalances: Asset
  currentBalances: Asset
  feeBalance?: number
  usdRate: number
  lastPrice: number
  lastUsdRate: number
  assets: {
    used: Asset
    required: Asset
  }
  position: PositionInBot
  stats: ProfitLossStats
  lastPositionChange?: number
  lastPriceRangeAlert?: number
  liveStats?: GridLiveStats
}

export type GridLiveStats = {
  budget: number
  value: number
  valueChange: number
  valueChangePerc: number
  avgDaily: number
  avgDailyPerc: number
  annualizedReturn: number
  freePorfit: number
  freeProfitUsd: number
  totalProfit: number
  totalProfitUsd: number
  tradingTime: number
  tradingTimeString: string
}

export type ClearBotSchema = ExcludeDoc<BotSchema>
export type Usage = {
  current: Asset
  max: Asset
  currentUsd?: number
  maxUsd?: number
  relative?: number
}

type LastEventPerSymbols = { symbol: string; time: number }

export type LastPricesPerSymbols = {
  symbol: string
  avg: number
  entry: number
  time?: number
}

export type IndicatorsData = {
  signature: string
  uuid: string
  symbol: string
  status: boolean
  statusTo?: number
  statusSince?: number
  numberOfSignals?: number
}

export type UsdAssetNumber = {
  usd: number
  asset: number
}

export interface BotProfitChartSchema extends SchemaI {
  userId: string
  botId: string
  value: number
  time: number
  type: BotType
}

export type BotStatsSeries = {
  count: number
  value: UsdAssetNumber
  minValue: UsdAssetNumber
  maxValue: UsdAssetNumber
  perc: number
}

export type BotStatsBestDay = {
  time: number
  value: number
  percentage: number
}

export type BotStats = {
  numerical: {
    profit: {
      grossProfit: UsdAssetNumber
      grossProfitPerc: number
      maxDealProfit: UsdAssetNumber
      maxDealProfitPerc: number
      avgDealProfit: UsdAssetNumber
      avgDealProfitPerc: number
      maxRunUp: UsdAssetNumber
      maxRunUpPerc: number
      maxConsecutiveWins: number
      standardDeviationOfPositiveReturns: number
      series: BotStatsSeries
    }
    loss: {
      grossLoss: UsdAssetNumber
      grossLossPerc: number
      maxDealLoss: UsdAssetNumber
      maxDealLossPerc: number
      avgDealLoss: UsdAssetNumber
      avgDealLossPerc: number
      maxDrawdown: UsdAssetNumber
      maxDrawdownPerc: number
      maxEquityDrawdown: UsdAssetNumber
      maxEquityDrawdownPerc: number
      maxConsecutiveLosses: number
      standardDeviationOfNegativeReturns: number
      standardDeviationOfDownside: number
      series: BotStatsSeries
      seriesEquity: { value: number; min: number; max: number; perc: number }
    }
    general: {
      bestDay?: BotStatsBestDay
      worstDay?: BotStatsBestDay
      netProfitPerc: number
      avgDaily: UsdAssetNumber
      avgDailyPerc: number
      annualizedReturn?: number
      startBalance: UsdAssetNumber
      maxDCAOrdersTriggered: number
      avgDCAOrdersTriggered: number
      coveredPriceDeviation: number
      actualPriceDeviation: number
      confidenceGrade: string
    }
    ratios: {
      profitFactor: number
      sharpeRatio: number
      sortinoRatio: number
      cwr: number
      buyAndHold: {
        symbol: string
        startPrice: number
        result: number
        perc: number
      }
    }
    usage: {
      maxTheoreticalUsage: number
      maxActualUsage: number
      avgDealUsage: number
    }
    deals: {
      profit: number
      loss: number
    }
  }
  duration: {
    profit: {
      avgWinningTradeDuration: number
      maxWinningTradeDuration: number
      totalTime: number
    }
    loss: {
      avgLosingTradeDuration: number
      maxLosingTradeDuration: number
      totalTime: number
    }
    general: {
      maxDealDuration: number
      avgDealDuration: number
      dealsPerDay: number
      workingTime: number
      totalTime: number
    }
  }
  chart: {
    realizedProfit: number
    buyAndHold: number
    equity: number
    time: number
  }[]
}

export type BotSymbolsStats = {
  numerical: {
    deals: {
      profit: number
      loss: number
    }
    general: {
      startBalance: UsdAssetNumber
      netProfit: UsdAssetNumber
      netProfitPerc: number
      dailyProfit: UsdAssetNumber
      dailyProfitPerc: number
      winRate: number
      profitFactor: number
    }
  }
  duration: {
    maxDealDuration: number
    avgDealDuration: number
  }
  symbol: string
}

export interface DCABotSchema<
  Settings = DCABotSettings,
> extends MainBot<Settings> {
  deals: {
    all: number
    active: number
  }
  usage: Usage
  lastOpenedDeal?: number
  lastClosedDeal?: number
  lastOpenedDealPerSymbol?: LastEventPerSymbols[]
  lastClosedDealPerSymbol?: LastEventPerSymbols[]
  lastPricesPerSymbol?: LastPricesPerSymbols[]
  symbol: Map<string, Symbols>
  initialBalances: MultiAssets
  currentBalances: MultiAssets
  usdRate: Map<string, number>
  lastPrice: Map<string, number>
  lastUsdRate: Map<string, number>
  assets: {
    used: MultiAssets
    required: MultiAssets
  }
  hodlIgnoreAt?: boolean
  indicatorsData?: IndicatorsData[]
  feeBalance?: number
  stats?: BotStats
  symbolStats?: BotSymbolsStats[]
  ignoreStats?: boolean
  flags?: string[]
  resetStatsAfter?: number
  dealsReduceForBot?: {
    id: string
    profit: number
    profitUsd: number
    base: number
    quote: number
  }[]
  action?: ActionsEnum
  liveStats?: BotLiveStats
}

export type BotLiveStats = {
  currentCost: number
  maxCost: number
  relativeCost: number
  relativeCostString: string
  totalProfit: number
  relativeProfit: number
  value: number
  relativeValue: number
  avgDaily: number
  avgDailyRelative: number
  annualizedReturn: number
  tradingTimeString: string
  tradingTimeNumber: number
  dealsTotal: number
}

export enum BotFlags {
  kucoinNewFee = 'kucoinNewFee',
  newMinTp = 'newMinTp',
  newBaseProfit = 'newBaseProfit',
  externalTp = 'externalTp',
  externalSl = 'externalSl',
}

export type DealStatsForBot = {
  dealId: string
  avgPrice: number
  usage: Usage
  profit: {
    total: number
    totalUsd: number
    pureBase?: number
    pureQuote?: number
  }
  feePaid?: {
    base?: number
    quote?: number
  }
  symbol: string
  currentBalances: Asset
  initialBalances: Asset
  comboTpBase?: ComboTpBase
}

export type ComboBotSchema = DCABotSchema<ComboBotSettings> & {
  dealsStatsForBot: DealStatsForBot[]
  useAssets?: boolean
}

export type ClearDCABotSchema = ExcludeDoc<DCABotSchema>
export type ClearComboBotSchema = ExcludeDoc<ComboBotSchema>

/**
 * Bot types
 *
 * @enum {grid | dca}
 */
export enum BotType {
  grid = 'grid',
  dca = 'dca',
  combo = 'combo',
  hedgeCombo = 'hedgeCombo',
  hedgeDca = 'hedgeDca',
}

export type OrderSchema = SchemaI &
  Order & {
    exchange: ExchangeEnum
    exchangeUUID: string
    botId: string
    userId: string
    typeOrder: TypeOrder
    updateTime: number
    baseAsset: string
    quoteAsset: string
    paperContext?: boolean
    tpSlTarget?: string
    dcaLevel?: number
    minigridId?: string
    sl?: boolean
  }
export type ClearOrderSchema = ExcludeDoc<OrderSchema>

/**
 * Return good result
 */
export type ReturnGood<T> = {
  status: StatusEnum.ok
  data: T
  reason?: null
  timeProfile?: BalancerTimeProfile
}
/**
 * Return bad result
 */
export type ReturnBad = {
  status: StatusEnum.notok
  data: null
  reason: string
  timeProfile?: BalancerTimeProfile
}
/**
 * Base return type
 */
export type BaseReturn<T = any> = ReturnGood<T> | ReturnBad

/**
 * Free asset type
 */
export type FreeAsset = {
  /**
   * Asset name
   */
  asset: string
  /** Free amount */
  free: number
  /** Locked amount */
  locked: number
}[]

export type MessageSocket = {
  type: 'error' | 'info'
  message: string
  time: number
  botId: string
  botName?: string
}

export enum MessageTypeEnum {
  error = 'error',
  info = 'info',
  warning = 'warning',
}

export interface BotMessageSchema extends SchemaI {
  userId: string
  botId: string
  botName?: string
  botType?: BotType
  message: string
  type: MessageTypeEnum
  time: number
  isDeleted?: boolean
  subType: string
  terminal?: boolean
  paperContext?: boolean
  showUser?: boolean
  fullMessage?: string
  symbol?: string
  exchange?: string
}

export type ClearBotErrorSchema = ExcludeDoc<BotMessageSchema>

export interface RateSchema extends SchemaI {
  usdRate: number
}

export type ClearRateSchema = ExcludeDoc<RateSchema>

export interface PairsSchema extends SchemaI {
  wsCode?: string
  code?: string
  pair: string
  exchange: ExchangeEnum
  baseAsset: {
    minAmount: number
    maxAmount: number
    step: number
    name: string
    maxMarketAmount: number
    multiplier?: number
  }
  quoteAsset: {
    minAmount: number
    name: string
    precision?: number
  }
  maxOrders: number
  priceAssetPrecision: number
  priceMultiplier?: {
    up: number
    down: number
    decimals: number
  }
  type?: string
  crossAvailable?: boolean
}

export interface StoreFilesSchema extends SchemaI {
  userId: string
  size: number
  fileName: string
  path: string
  meta?: Record<string, unknown>
}

export type CleanStoreFilesSchema = ExcludeDoc<StoreFilesSchema>

export type ClearPairsSchema = ExcludeDoc<PairsSchema>

export interface FeesSchema extends SchemaI {
  userId: string
  exchange: ExchangeEnum
  exchangeUUID: string
  pair: string
  maker: number
  taker: number
}

export type UserFee = { maker: number; taker: number }

export type ClearFeesSchema = ExcludeDoc<FeesSchema>

export interface BalancesSchema extends SchemaI {
  userId: string
  exchange: ExchangeEnum
  exchangeUUID: string
  asset: string
  free: number
  locked: number
  paperContext?: boolean
}

export type ClearBalancesSchema = ExcludeDoc<BalancesSchema>

export type CoingeckoLockalization =
  | 'ar'
  | 'bg'
  | 'cs'
  | 'da'
  | 'de'
  | 'el'
  | 'en'
  | 'es'
  | 'fi'
  | 'fr'
  | 'he'
  | 'hi'
  | 'hr'
  | 'hu'
  | 'id'
  | 'it'
  | 'ja'
  | 'ko'
  | 'lt'
  | 'nl'
  | 'no'
  | 'pl'
  | 'ru'
  | 'pt'
  | 'ro'
  | 'sk'
  | 'sl'
  | 'sv'
  | 'th'
  | 'tr'
  | 'uk'
  | 'vi'
  | 'zh'
  | 'zh-tw'

export type CoingeckoMarketDataCurrency =
  | 'aed'
  | 'ars'
  | 'aud'
  | 'bch'
  | 'bdt'
  | 'bhd'
  | 'bits'
  | 'bmd'
  | 'bnb'
  | 'brl'
  | 'btc'
  | 'cad'
  | 'chf'
  | 'clp'
  | 'cny'
  | 'czk'
  | 'dkk'
  | 'dot'
  | 'eos'
  | 'eth'
  | 'eur'
  | 'gbp'
  | 'hkd'
  | 'huf'
  | 'idr'
  | 'ils'
  | 'inr'
  | 'jpy'
  | 'krw'
  | 'kwd'
  | 'link'
  | 'lkr'
  | 'ltc'
  | 'mmk'
  | 'mxn'
  | 'myr'
  | 'ngn'
  | 'nok'
  | 'nzd'
  | 'php'
  | 'pkr'
  | 'pln'
  | 'rub'
  | 'sar'
  | 'sats'
  | 'sek'
  | 'sgd'
  | 'thb'
  | 'try'
  | 'twd'
  | 'uah'
  | 'usd'
  | 'vef'
  | 'vnd'
  | 'xag'
  | 'xau'
  | 'xdr'
  | 'xlm'
  | 'xrp'
  | 'yfi'
  | 'zar'

export type CoingeckoCommunityData = {
  facebook_likes: number | null
  reddit_accounts_active_48h: number | null
  reddit_average_comments_48h: number | null
  reddit_average_posts_48h: number | null
  reddit_subscribers: number | null
  telegram_channel_user_count: number | null
  twitter_followers: number | null
}
export type CoingeckDeveloperData = {
  closed_issues: number | null
  code_additions_deletions_4_weeks: {
    additions: number | null
    deletions: number | null
  }
  commit_count_4_weeks: number | null
  forks: number | null
  last_4_weeks_commit_activity_series: string[]
  pull_request_contributors: number | null
  pull_requests_merged: number | null
  stars: number | null
  subscribers: number | null
  total_issues: number | null
}
export type CoingeckoLinks = {
  announcement_url: string[]
  bitcointalk_thread_identifier: number | null
  blockchain_site: string[]
  chat_url: string[]
  facebook_username: string | null
  homepage: string[]
  official_forum_url: string[]
  repos_url: {
    bitbucket: string[]
    github: string[]
  }
  subreddit_url: string | null
  telegram_channel_identifier: string | null
  twitter_screen_name: string | null
}
export type CoingeckoMarketData = {
  volatility: {
    '1d': number | null
    '3d': number | null
    '7d': number | null
  } | null
  ath: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  ath_change_percentage: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  ath_date: {
    [x in CoingeckoMarketDataCurrency]: string | null
  }
  atl: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  atl_change_percentage: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  atl_date: {
    [x in CoingeckoMarketDataCurrency]: string | null
  }
  circulating_supply: number | null
  sparkline_7d: { price: number[] | null } | null
  current_price: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  fdv_to_tvl_ratio: string | null
  high_24h: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  last_updated: string | null
  low_24h: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  market_cap: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  market_cap_change_24h: number | null
  market_cap_change_24h_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  market_cap_change_percentage_24h: number | null
  market_cap_change_percentage_24h_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  market_cap_rank: number | null
  max_supply: number | null
  mcap_to_tvl_ratio: number | null
  price_change_24h: number | null
  price_change_24h_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_1h_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_1y: number | null
  price_change_percentage_1y_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_7d: number | null
  price_change_percentage_7d_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_14d: number | null
  price_change_percentage_14d_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_24h: number | null
  price_change_percentage_24h_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_30d: number | null
  price_change_percentage_30d_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_60d: number | null
  price_change_percentage_60d_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  price_change_percentage_200d: number | null
  price_change_percentage_200d_in_currency: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
  roi: {
    times: number
    currency: string
    percentage: number
  }
  total_supply: number | null
  total_value_locked: { btc: number; usd: number }
  total_volume: {
    [x in CoingeckoMarketDataCurrency]: number | null
  }
}
export type CoingeckoTickerConverted = 'btc' | 'eth' | 'usd'
export type CoingeckoTicker = {
  base: string
  bid_ask_spread_percentage: number
  coin_id: string
  converted_last: {
    [x in CoingeckoTickerConverted]: number
  }
  converted_volume: {
    [x in CoingeckoTickerConverted]: number
  }
  is_anomaly: boolean
  is_stale: boolean
  last: number
  last_fetch_at: string
  last_traded_at: string
  market: {
    has_trading_incentive: boolean
    identifier: string
    name: string
  }
  target: string
  timestamp: string
  token_info_url: string | null
  trade_url: string
  trust_score: string
  volume: string
}

export type CoingeckoStatusUpdate = {
  description: string
  category: string
  created_at: string
  user: string
  user_title: string
  pin: boolean
}

export type CoingeckoCoinInfo = {
  additional_notices: string[]
  asset_platform_id: string | null
  block_time_in_minutes: number | null
  categories: string[]
  coingecko_rank: number | null
  coingecko_score: number | null
  community_data: CoingeckoCommunityData
  community_score: number | null
  contract_address: string | null
  country_origin: string | null
  description: {
    [x in CoingeckoLockalization]: string | null
  }
  developer_data: CoingeckDeveloperData
  developer_score: number | null
  genesis_date: string | null
  hashing_algorithm: string | null
  id: string | null
  image: CoingeckoImage
  last_updated: string | null
  links: CoingeckoLinks
  liquidity_score: number | null
  localization: {
    [x in CoingeckoLockalization]: string | null
  }
  market_cap_rank: number | null
  market_data: CoingeckoMarketData
  name: string
  platforms: {
    [x: string]: string | null
  }
  public_interest_score: number | null
  public_interest_stats: {
    alexa_rank: number | null
    bing_matches: number | null
  }
  public_notice: string | null
  sentiment_votes_down_percentage: number | null
  sentiment_votes_up_percentage: number | null
  status_updates: CoingeckoStatusUpdate[]
  symbol: string | null
  tickers: CoingeckoTicker[]
}

export type CoingeckCoinHistoryInfo = {
  id: string
  symbol: string
  name: string
  localization?:
    | {
        [x in CoingeckoLockalization]: string | null
      }
    | null
  image?: {
    thumb: string | null
    small: string | null
  } | null
  market_data?: {
    current_price?: { [x in CoingeckoMarketDataCurrency]: number | null } | null
    market_cap?: { [x in CoingeckoMarketDataCurrency]: number | null } | null
    total_volume?: { [x in CoingeckoMarketDataCurrency]: number | null } | null
  } | null
  community_data?: {
    facebook_likes: number | null
    twitter_followers: number | null
    reddit_average_posts_48h: number | null
    reddit_average_comments_48h: number | null
    reddit_subscribers: number | null
    reddit_accounts_active_48h: number | null
  } | null
  developer_data?: {
    forks: number | null
    stars: number | null
    subscribers: number | null
    total_issues: number | null
    closed_issues: number | null
    pull_requests_merged: number | null
    pull_request_contributors: number | null
    code_additions_deletions_4_weeks?: {
      additions: number | null
      deletions: number | null
    } | null
    commit_count_4_weeks: number | null
  } | null
  public_interest_stats?: {
    alexa_rank: number | null
    bing_matches: number | null
  } | null
}

export type CoingeckCoinMarketHistoryInfo = {
  prices?: [number, number][] | null
  market_caps?: [number, number][] | null
  total_volumes?: [number, number][] | null
}

export type CoingeckoImage = {
  large: string | null
  small: string | null
  thumb: string | null
}

export type SentimentPeriod = '30d' | '7d' | '24h'

export type SentimentData = {
  positiveNews: number
  negativeNews: number
  neutralNews: number
  sentiment: number
  updateTime: Date
}

export interface CoinsSchema extends SchemaI {
  additional_notices: string[]
  asset_platform_id: string | null
  block_time_in_minutes: number | null
  categories: string[]
  coingecko_rank: number | null
  coingecko_score: number | null
  community_data: CoingeckoCommunityData
  community_score: number | null
  contract_address: string | null
  country_origin: string | null
  description: {
    [x in CoingeckoLockalization]: string | null
  }
  developer_data: CoingeckDeveloperData
  developer_score: number | null
  genesis_date: string | null
  hashing_algorithm: string | null
  id: string | null
  image: CoingeckoImage
  last_updated: string | null
  links: CoingeckoLinks
  liquidity_score: number | null
  localization: {
    [x in CoingeckoLockalization]: string | null
  }
  market_cap_rank: number | null
  market_data?: CoingeckoMarketData
  name: string
  platforms: { name: string; text: string }[]
  public_interest_score: number | null
  public_interest_stats: {
    alexa_rank: number | null
    bing_matches: number | null
  }
  public_notice: string | null
  sentiment_votes_down_percentage: number | null
  sentiment_votes_up_percentage: number | null
  status_updates: CoingeckoStatusUpdate[]
  symbol: string | null
  tickers: CoingeckoTicker[]
  sentimentData?: {
    [key in SentimentPeriod]: SentimentData
  }
  volume_change_24h?: number
  exchanges?: ExchangeEnum[]
}

export type CleanCoinsSchema = ExcludeDoc<CoinsSchema>

export type RestartProgress = {
  id: string
  loadedData: boolean
  finishLoad: boolean
  loadTime: number
  finishTime: number
}

export type amountUsdAsset = {
  name: string
  amount: number
  amountUsd: number
  exchanges?: {
    uuid: string
    amount: number
    amountUsd: number
  }[]
}

export interface SnapshotSchema extends SchemaI {
  userId: string
  updateTime: number
  totalUsd: number
  assets: amountUsdAsset[]
  exchangesTotal: {
    uuid: string
    totalUsd: number
  }[]
  paperContext?: boolean
}

export interface SnapshotPerExchangeSchema extends SchemaI {
  userId: string
  updateTime: number
  totalUsd: number
  uuid: string
  paperContext?: boolean
}

export type CleanSnapshotSchema = ExcludeDoc<SnapshotSchema>

export type PriceMessage = {
  symbol: string
  price: number
  time: number
  volume: number
  eventTime?: number
}

export type TradeMessage = {
  start: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

export type OrderAdditionalParams = {
  dealId?: string
  type: OrderTypeT
  reduceOnly?: boolean
  positionSide?: PositionSide
  acBefore?: number
  acAfter?: number
}

/**
 * Grid type
 */
export type Grid = {
  /**
   * Number of the grid
   */
  number: number
  /**
   * Price of the grid
   */
  price: number
  /**
   * Side of the grid
   */
  side: OrderSideEnum
  /**
   * Id for future order request
   */
  newClientOrderId: string
  /**
   * Qty of the grid
   */
  qty: number
  /**
   * Type of the grid
   */
  type: TypeOrderEnum
  /**
   * Target uuid for multiple TP/SL
   */
  tpSlTarget?: string
  /**
   * Deal id
   */
  dealId?: string
  dcaLevel?: number
  minigridId?: string
  market?: boolean
  minigridBudget?: number
  hide?: boolean
  levelNumber?: number
  sl?: boolean
}

export type OrderStatusType =
  | 'CANCELED'
  | 'FILLED'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'EXPIRED'

export type OrderTypeT = 'LIMIT' | 'MARKET'

export type OrderSideType = 'BUY' | 'SELL'

export type PositionSide_LT = 'BOTH' | 'SHORT' | 'LONG'

export type TimeInForce_LT = 'GTC' | 'IOC' | 'FOK'

export enum MarginType {
  ISOLATED = 'ISOLATED',
  CROSSED = 'CROSSED',
}

export enum BotMarginTypeEnum {
  inherit = 'inherit',
  cross = 'cross',
  isolated = 'isolated',
}

export type LeverageBracket = {
  symbol: string
  leverage: number
  step: number
  min: number
}

export type CommonOrder = {
  /**futures */
  positionSide?: PositionSide_LT
  reduceOnly?: boolean
  closePosition?: boolean
  timeInForce?: TimeInForce_LT
  cumQuote?: string
  cumBase?: string
  cumQty?: string
  avgPrice?: string
  /**spot */
  symbol: string
  orderId: string | number
  clientOrderId: string
  transactTime?: number
  updateTime: number
  price: string
  origQty: string
  executedQty: string
  cummulativeQuoteQty?: string
  status: OrderStatusType
  type: OrderTypeT
  side: OrderSideType
  fills?: {
    price: string
    qty: string
    commission: string
    commissionAsset: string
    tradeId: string
  }[]
}

export type Order = CommonOrder & {
  _id?: string
  exchange: ExchangeEnum
  exchangeUUID: string
  typeOrder: TypeOrder
  botId: string
  userId: string
  dealId?: string
  baseAsset: string
  quoteAsset: string
  origPrice: string
  tpSlTarget?: string
  dcaLevel?: number
  minigridId?: string
  addFundsId?: string
  reduceFundsId?: string
  minigridBudget?: number
  liquidation?: boolean
  sl?: boolean
  acBefore?: number
  acAfter?: number
  leverage?: number
}

export enum CloseDCATypeEnum {
  /** Do nothing */
  leave = 'leave',
  /** Cancel orders */
  cancel = 'cancel',
  /** Close deals by LIMIT */
  closeByLimit = 'closeByLimit',
  /** Close deals by Market */
  closeByMarket = 'closeByMarket',
}

export enum CloseGRIDTypeEnum {
  /** Cancel orders */
  cancel = 'cancel',
  /** Close deals by LIMIT */
  closeByLimit = 'closeByLimit',
  /** Close deals by Market */
  closeByMarket = 'closeByMarket',
}

export enum WebhookActionEnum {
  /** Start deal */
  start = 'startDeal',
  /** Close deal */
  close = 'closeDeal',
  /** Close deal */
  closeSl = 'closeDealSl',
  /** Start bot */
  startBot = 'startBot',
  /** Stop bot */
  stopBot = 'stopBot',
  /** Add funds */
  addFunds = 'addFunds',
  /** Reduce funds */
  reduceFunds = 'reduceFunds',
  /** Change pairs */
  changePairs = 'changePairs',
  enterLong = 'enterLong',
  enterShort = 'enterShort',
  exitLong = 'exitLong',
  exitShort = 'exitShort',
}

export enum PairsToSetMode {
  add = 'add',
  remove = 'remove',
  replace = 'replace',
}

export type UnPromise<T> = T extends Promise<infer U> ? U : T

export interface AssetBalance {
  asset: string
  free: string
  locked: string
}

export interface OutboundAccountPosition {
  balances: AssetBalance[]
  eventTime: number
  eventType: 'outboundAccountPosition'
  lastAccountUpdate: number
}

export interface BalanceUpdate {
  asset: string
  balanceDelta: string
  clearTime: number
  eventTime: number
  eventType: 'balanceUpdate'
}

export type OrderStatus_LT =
  | 'CANCELED'
  | 'FILLED'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'EXPIRED'
  | 'PENDING_CANCEL'
  | 'REJECTED'

export type FuturesOrderType_LT =
  | 'LIMIT'
  | 'MARKET'
  | 'STOP'
  | 'TAKE_PROFIT'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT_MARKET'
  | 'TRAILING_STOP_MARKET'
  | 'LIQUIDATION'

export type OrderSide_LT = 'BUY' | 'SELL'

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}
export enum TimeInForce {
  GTC = 'GTC',
  IOC = 'IOC',
  FOK = 'FOK',
}
export enum ExecutionType {
  NEW = 'NEW',
  CANCELED = 'CANCELED',
  REPLACED = 'REPLACED',
  REJECTED = 'REJECTED',
  TRADE = 'TRADE',
  EXPIRED = 'EXPIRED',
}
export enum OrderStatus {
  CANCELED = 'CANCELED',
  EXPIRED = 'EXPIRED',
  FILLED = 'FILLED',
  NEW = 'NEW',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  PENDING_CANCEL = 'PENDING_CANCEL',
  REJECTED = 'REJECTED',
}
export enum WorkingType {
  MARK_PRICE = 'MARK_PRICE',
  CONTRACT_PRICE = 'CONTRACT_PRICE',
}

export enum PositionSide {
  BOTH = 'BOTH',
  SHORT = 'SHORT',
  LONG = 'LONG',
}

export interface OrderUpdate {
  eventType: 'ORDER_TRADE_UPDATE'
  eventTime: number
  transactionTime: number
  symbol: string
  clientOrderId: string
  side: OrderSide
  orderType: FuturesOrderType_LT
  timeInForce: TimeInForce
  quantity: string
  price: string
  averagePrice: string
  stopPrice: string
  executionType: ExecutionType
  orderStatus: OrderStatus
  orderId: number
  lastTradeQuantity: string
  totalTradeQuantity: string
  priceLastTrade: string
  commissionAsset: string | null
  commission: string
  orderTime: number
  tradeId: number
  bidsNotional: string
  asksNotional: string
  isMaker: boolean
  isReduceOnly: boolean
  workingType: WorkingType
  originalOrderType: FuturesOrderType_LT
  positionSide: PositionSide
  closePosition: boolean
  activationPrice: string
  callbackRate: string
  realizedProfit: string
}

export interface SpotUpdate {
  creationTime: number // Order creation time
  eventTime: number
  eventType: 'executionReport'
  newClientOrderId: string // Client order ID
  orderId: number | string // Order ID
  orderStatus: OrderStatus_LT // Current order status
  orderTime: number // Transaction time
  orderType: FuturesOrderType_LT // Order type
  originalClientOrderId: string | null // Original client order ID; This is the ID of the order being canceled
  price: string // Order price
  quantity: string // Order quantity
  side: OrderSide_LT // Side
  symbol: string // Symbol
  totalQuoteTradeQuantity: string // Cumulative quote asset transacted quantity
  totalTradeQuantity: string // Cumulative filled quantity
}
export type ExecutionReport = (SpotUpdate | OrderUpdate) & {
  liquidation?: boolean
}

export type EventReasonType =
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'ORDER'
  | 'FUNDING_FEE'
  | 'WITHDRAW_REJECT'
  | 'ADJUSTMENT'
  | 'INSURANCE_CLEAR'
  | 'ADMIN_DEPOSIT'
  | 'ADMIN_WITHDRAW'
  | 'MARGIN_TRANSFER'
  | 'MARGIN_TYPE_CHANGE'
  | 'ASSET_TRANSFER'
  | 'OPTIONS_PREMIUM_FEE'
  | 'OPTIONS_SETTLE_PROFIT'
  | 'AUTO_EXCHANGE'

export interface Balance {
  asset: string
  walletBalance: string
  crossWalletBalance: string
  balanceChange: string
}

export interface Position {
  symbol: string
  positionAmount: string
  entryPrice: string
  accumulatedRealized: string
  unrealizedPnL: string
  marginType: 'isolated' | 'cross'
  isolatedWallet: string
  positionSide: PositionSide_LT
}

export type UserDataStreamEvent = (
  | OutboundAccountPosition
  | ExecutionReport
  | BalanceUpdate
  | AccountUpdate
) & { liquidation?: boolean }

export interface AccountUpdate {
  eventTime: number
  eventType: 'ACCOUNT_UPDATE'
  transactionTime: number
  eventReasonType: EventReasonType
  balances: Balance[]
  positions: Position[]
}

export type CandleResponse = {
  open: string
  high: string
  low: string
  close: string
  time: number
  volume: string
  symbol: string
}

export type TradeResponse = {
  aggId: string
  symbol: string
  price: string
  quantity: string
  firstId: number
  lastId: number
  timestamp: number
}

export type AllPricesResponse = {
  pair: string
  price: number
}

export enum ExchangeIntervals {
  oneM = '1m',
  threeM = '3m',
  fiveM = '5m',
  fifteenM = '15m',
  thirtyM = '30m',
  oneH = '1h',
  twoH = '2h',
  fourH = '4h',
  eightH = '8h',
  oneD = '1d',
  oneW = '1w',
}

export const intervalMap: { [x in ExchangeIntervals]: number } = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
}

export enum IndicatorEnum {
  rsi = 'RSI',
  adx = 'ADX',
  bbw = 'BBW',
  bb = 'BB',
  macd = 'MACD',
  stoch = 'Stoch',
  cci = 'CCI',
  ao = 'AO',
  stochRSI = 'StochRSI',
  wr = 'WR',
  bullBear = 'BullBear',
  uo = 'UO',
  ic = 'IC',
  tv = 'TV',
  ma = 'MA',
  sr = 'SR',
  qfl = 'QFL',
  mfi = 'MFI',
  psar = 'PSAR',
  vo = 'VO',
  mom = 'MOM',
  bbwp = 'BBWP',
  ecd = 'ECD',
  xo = 'XO',
  mar = 'MAR',
  bbpb = 'BBPB',
  div = 'DIV',
  st = 'ST',
  pc = 'PC',
  atr = 'ATR',
  pp = 'PP',
  adr = 'ADR',
  ath = 'ATH',
  kc = 'KC',
  kcpb = 'KCPB',
  unpnl = 'UNPNL',
  dc = 'DC',
  obfvg = 'OBFVG',
  session = 'SESSION',
  lw = 'LW',
}

export enum MAEnum {
  ema = 'ema',
  sma = 'sma',
  wma = 'wma',
  price = 'price',
  dema = 'dema',
  tema = 'tema',
  vwma = 'vwma',
  hma = 'hma',
  rma = 'rma',
}

export enum RangeType {
  atr = 'ATR',
  tr = 'TR',
  r = 'R',
}

export type MAResult = {
  ma: number
  maType: string
  price: number
}

export type IndicatorHistory = { time: number } & (
  | { type: IndicatorEnum.obfvg; value: OBFVGResult }
  | { type: IndicatorEnum.dc; value: DCResult }
  | { type: IndicatorEnum.pp; value: PriorPivotResult }
  | { type: IndicatorEnum.st; value: SuperTrendResult }
  | {
      type:
        | IndicatorEnum.rsi
        | IndicatorEnum.cci
        | IndicatorEnum.ao
        | IndicatorEnum.uo
        | IndicatorEnum.wr
        | IndicatorEnum.adx
        | IndicatorEnum.bbw
        | IndicatorEnum.mfi
        | IndicatorEnum.vo
        | IndicatorEnum.mom
        | IndicatorEnum.mar
        | IndicatorEnum.bbpb
        | IndicatorEnum.kcpb
        | IndicatorEnum.unpnl
      value: PercentileResult
    }
  | {
      type:
        | IndicatorEnum.bullBear
        | IndicatorEnum.bbwp
        | IndicatorEnum.ecd
        | IndicatorEnum.xo
        | IndicatorEnum.atr
        | IndicatorEnum.adr
        | IndicatorEnum.ath
      value: number
    }
  | { type: IndicatorEnum.pc; value: PCResult }
  | {
      type: IndicatorEnum.bb | IndicatorEnum.kc
      value: { result: BandsResult; price: number }
    }
  | {
      type: IndicatorEnum.macd
      value: MACDResult
    }
  | {
      type: IndicatorEnum.ma
      value: MAResult
    }
  | {
      type: IndicatorEnum.stoch | IndicatorEnum.stochRSI
      value: StochasticResult
    }
  | {
      type: IndicatorEnum.ic
      value: IchimokuCloudResult
    }
  | { type: IndicatorEnum.tv; value: number }
  | { type: IndicatorEnum.div; value: DIVResult }
  | { type: IndicatorEnum.sr; value: PivotResult }
  | { type: IndicatorEnum.qfl; value: QFLResult }
  | { type: IndicatorEnum.psar; value: { psar: number; price: number } }
  | { type: IndicatorEnum.lw; value: LongWickResult }
  | { type: IndicatorEnum.session; value: boolean }
)

type Percentile = {
  percentile?: boolean
  percentileLookback?: number
  percentilePercentage?: number
}

type TrendFilter = {
  trendFilter?: boolean
  trendFilterLookback?: number
  trendFilterType?: TrendFilterOperatorEnum
  trendFilterValue?: number
}

export enum TrendFilterOperatorEnum {
  lower = 'lower',
  higher = 'higher',
  between = 'between',
}

export type DivergenceOscillators =
  | IndicatorEnum.adx
  | IndicatorEnum.cci
  | IndicatorEnum.mfi
  | IndicatorEnum.rsi
  | IndicatorEnum.wr
  | IndicatorEnum.macd
  | IndicatorEnum.uo
  | IndicatorEnum.ao
  | IndicatorEnum.mom
  | IndicatorEnum.bbw
  | IndicatorEnum.vo
  | IndicatorEnum.bbpb
  | IndicatorEnum.stoch

export type IndicatorConfig =
  | { type: IndicatorEnum.lw; lwThreshold: number; lwMaxDuration: number }
  | { type: IndicatorEnum.obfvg }
  | { type: IndicatorEnum.dc; length: number }
  | {
      type: IndicatorEnum.pc
      pcUp: number
      pcDown: number
    }
  | {
      type: IndicatorEnum.ath
      lookback: number
    }
  | {
      type: IndicatorEnum.pp
      ppHighLeft: number
      ppHighRight: number
      ppLowLeft: number
      ppLowRight: number
      ppMult: number
    }
  | { type: IndicatorEnum.st; factor: number; atrLength: number }
  | {
      type: IndicatorEnum.div
      oscillators: DivergenceOscillators[]
      leftBars?: number
      rightBars?: number
      rangeLower?: number
      rangeUpper?: number
    }
  | {
      type: IndicatorEnum.tv
      checkLevel?: number
      useAsEntryExitPoints?: boolean
    }
  | ({
      type: IndicatorEnum.mar
      mar1type: MAEnum
      mar1length: number
      mar2type: MAEnum
      mar2length: number
    } & Percentile &
      TrendFilter)
  | ({
      type: IndicatorEnum.mom
      interval: number
      source: string
    } & Percentile)
  | {
      type: IndicatorEnum.bbwp
      interval: number
      lookback: number
      source: string
    }
  | ({
      type:
        | IndicatorEnum.rsi
        | IndicatorEnum.adx
        | IndicatorEnum.cci
        | IndicatorEnum.wr
        | IndicatorEnum.bullBear
        | IndicatorEnum.mfi
        | IndicatorEnum.atr
        | IndicatorEnum.adr
      interval: number
    } & Percentile)
  | ({
      type: IndicatorEnum.bbw | IndicatorEnum.bb | IndicatorEnum.bbpb
      interval: number
      bbwMult?: number
      bbwMa?: MAEnum
      bbwMaLength?: number
    } & Percentile)
  | ({
      type: IndicatorEnum.kc | IndicatorEnum.kcpb
      interval: number
      multiplier?: number
      ma?: MAEnum
      range?: RangeType
      rangeLength?: number
    } & Percentile)
  | ({
      type: IndicatorEnum.macd
      longInterval: number
      shortInterval: number
      signalInterval: number
      maSource?: MAEnum
      maSignal?: MAEnum
    } & Percentile)
  | {
      type: IndicatorEnum.stoch
      k: number
      ksmooth: number
      dsmooth: number
    }
  | ({
      type: IndicatorEnum.ao
    } & Percentile)
  | {
      type: IndicatorEnum.stochRSI
      interval: number
      k: number
      ksmooth: number
      dsmooth: number
    }
  | ({
      type: IndicatorEnum.uo
      fast: number
      middle: number
      slow: number
    } & Percentile)
  | {
      type: IndicatorEnum.ic
      conversionPeriods: number
      basePeriods: number
      laggingSpan2Periods: number
      laggingSpan: number
    }
  | {
      type: IndicatorEnum.ma
      maType: MAEnum
      interval: number
    }
  | {
      type: IndicatorEnum.sr
      leftBars: number
      rightBars: number
    }
  | {
      type: IndicatorEnum.qfl
      basePeriods: number
      pumpPeriods: number
      pump: number
      baseCrack: number
    }
  | {
      type: IndicatorEnum.psar
      start: number
      inc: number
      max: number
    }
  | ({ type: IndicatorEnum.vo; voShort: number; voLong: number } & Percentile)
  | { type: IndicatorEnum.ecd }
  | {
      type: IndicatorEnum.lw
      lwThreshold: number
      lwMaxDuration: number
    }

export type Prices = {
  pair: string
  price: number
  exchange: string
}[]

export type SplitTime = {
  d: string
  h: string
  min: string
  s: string
}

export type SymbolStatsProfit = {
  total: number
  totalUsd: number
  perc: number
}

export type SymbolStats = {
  pair: string
  deals: {
    profit: number
    loss: number
    open: number
  }
  netProfit: SymbolStatsProfit
  dailyReturn: SymbolStatsProfit
  profitAsset: string
  winRate: number
  profitFactor: string
  maxDealDuration: SplitTime
  avgDealDuration: SplitTime
}

export enum BacktestRequestStatus {
  pending = 'pending',
  loadingData = 'loadingData',
  processing = 'processing',
  success = 'success',
  failed = 'failed',
}

export interface BacktestRequestSchema extends SchemaI {
  cost: number
  symbols: {
    pair: string
    baseAsset: string
    quoteAsset: string
  }[]
  exchange: ExchangeEnum
  exchangeUUID: string
  userId: string
  status: BacktestRequestStatus
  statusReason?: string
  backtestId?: string
  type: BotType
  payload: ServerSideBacktestPayload
  statusHistory?: {
    status: BacktestRequestStatus
    time: number
  }[]
  restarts?: number
}

export interface ExchangeStatsSchema extends SchemaI {
  exchange: ExchangeEnum
  type: 'paid' | 'free' | 'total'
  time: number
  amount: number
  fee: number
  users: number
  market: string
  effectiveVolume?: number
}

export interface RebateStatsSchema extends SchemaI {
  userId: string
  username: string
  time: number
  tradeAmount: number
  feeAmount: number
  rebateAmount: number
  exchange: ExchangeEnum
  type: 'futures' | 'spot'
}

export type CleanExchangeStatsSchema = ExcludeDoc<ExchangeStatsSchema>

export interface SSBCreditSchema extends SchemaI {
  candleFactor: number
  gridThreshold: number
  multiply: number
}

export interface DCABacktestingResult extends SchemaI {
  serverSide?: boolean
  noData?: boolean
  maxLeverage?: number
  financial: {
    netProfitTotal: number
    netProfitTotalUsd: number
    grossProfit: number
    grossProfitUsd: number
    grossLoss: number
    grossLossUsd: number
    avgGrossProfit: number
    avgGrossProfitUsd: number
    avgGrossLoss: number
    avgGrossLossUsd: number
    avgNetProfit: number
    avgNetProfitUsd: number
    avgNetDaily: number
    avgNetDailyUsd: number
    unrealizedPnL: number
    unrealizedPnLUsd: number
    unrealizedPnLPerc: number
    maxDealProfit: number
    maxDealLoss: number
    maxDealProfitUsd: number
    maxDealLossUsd: number
    maxRunUp: number
    maxRunUpUsd: number
    maxDrawDown: number
    maxDrawDownUsd: number
    maxDrawDownEquityUsd?: number
    maxDrawDownEquityPerc?: number
    netProfitTotalPerc: number
    grossProfitPerc: number
    grossLossPerc: number
    avgGrossProfitPerc: number
    avgGrossLossPerc: number
    avgNetProfitPerc: number
    avgNetDailyPerc: number
    annualizedReturn?: number
    maxDealProfitPerc: number
    maxDealLossPerc: number
    maxRunUpPerc: number
    maxDrawDownPerc: number
    initialBalanceUsd: number
    stDevWinningTrade?: number
    stDevLosingTrade?: number
  }
  duration: {
    avgDealDuration: number
    avgSplitDealDuration: SplitTime
    firstDataTime: number
    lastDataTime: number
    loadingDataTime: number
    processingDataTime: number
    botWorkingTime: SplitTime
    botWorkingTimeNumber: number
    maxDealDuration: SplitTime
    maxDealDurationTime: number
    periodName?: string
    avgWinningTrade?: number
    maxWinningTrade?: number
    avgLosingTrade?: number
    maxLosingTrade?: number
  }
  usage: {
    maxTheoreticalUsage: number
    maxRealUsage: number
    avgRealUsage: number
  }
  numerical: {
    all: number
    profit: number
    loss: number
    open: number
    closed: number
    maxConsecutiveWins: number
    maxConsecutiveLosses: number
    maxDCATriggered: number
    avgDCATriggered: number
    dealsPerDay: number
    coveredPriceDeviation: number
    actualPriceDeviation: number
    liquidationEvents?: number
    confidenceGrade?: string
    dealsForConfidenceGrade?: number
    priceDeviation?: number
  }
  ratios: {
    profitFactor: number
    profitByPeriod: number[]
    buyAndHold: {
      value: number
      valueUsd: number
      perc: number
    }
    periodRatio: number
    sharpe: number
    sortino: number
    cwr: number
  }
  interval: ExchangeIntervals
  quoteRate: number
  symbol: string
  baseAsset: string
  quoteAsset: string
  userId: string
  time: number
  settings: DCABotSettings
  exchange: ExchangeEnum
  exchangeUUID: string
  savePermanent: boolean
  shareId?: string
  value?: number
  archive?: boolean
  author?: string
  sent?: boolean
  config?: BacktestingSettings
  note?: string
  multi?: boolean
  multiPairs?: number
  symbolStats?: SymbolStats[]
  periodicStats?: PeriodicStats[]
  messages?: string[]
}
export type PeriodicStats = {
  period: string
  startTime: number
  netResult: number
  drawdown: number
  runup: number
  deals: {
    profit: number
    loss: number
  }
}
export interface ComboBacktestingResult extends SchemaI {
  serverSide: boolean
  noData?: boolean
  maxLeverage?: number
  financial: {
    netProfitTotal: number
    netProfitTotalUsd: number
    grossProfit: number
    grossProfitUsd: number
    grossLoss: number
    grossLossUsd: number
    avgGrossProfit: number
    avgGrossProfitUsd: number
    avgGrossLoss: number
    avgGrossLossUsd: number
    avgNetProfit: number
    avgNetProfitUsd: number
    avgNetDaily: number
    avgNetDailyUsd: number
    unrealizedPnL: number
    unrealizedPnLUsd: number
    unrealizedPnLPerc: number
    unrealizedUsage: number
    maxDealProfit: number
    maxDealLoss: number
    maxDealProfitUsd: number
    maxDealLossUsd: number
    maxRunUp: number
    maxRunUpUsd: number
    maxDrawDown: number
    maxDrawDownUsd: number
    maxDrawDownEquityUsd?: number
    maxDrawDownEquityPerc?: number
    netProfitTotalPerc: number
    grossProfitPerc: number
    grossLossPerc: number
    avgGrossProfitPerc: number
    avgGrossLossPerc: number
    avgNetProfitPerc: number
    avgNetDailyPerc: number
    annualizedReturn?: number
    maxDealProfitPerc: number
    maxDealLossPerc: number
    maxRunUpPerc: number
    maxDrawDownPerc: number
    initialBalanceUsd: number
    stDevWinningTrade?: number
    stDevLosingTrade?: number
  }
  duration: {
    avgDealDuration: number
    avgSplitDealDuration: SplitTime
    firstDataTime: number
    lastDataTime: number
    loadingDataTime: number
    processingDataTime: number
    botWorkingTime: SplitTime
    botWorkingTimeNumber: number
    maxDealDuration: SplitTime
    maxDealDurationTime: number
    periodName?: string
    avgWinningTrade?: number
    maxWinningTrade?: number
    avgLosingTrade?: number
    maxLosingTrade?: number
  }
  usage: {
    maxTheoreticalUsage: number
    maxRealUsage: number
    avgRealUsage: number
    maxTheoreticalUsageWithRate: number
  }
  numerical: {
    all: number
    profit: number
    loss: number
    open: number
    closed: number
    maxConsecutiveWins: number
    maxConsecutiveLosses: number
    maxDCATriggered: number
    avgDCATriggered: number
    dealsPerDay: number
    coveredPriceDeviation: number
    actualPriceDeviation: number
    confidenceGrade: string
    dealsForConfidenceGrade?: number
    priceDeviation?: number
  }
  ratios: {
    profitFactor: number
    profitByPeriod: number[]
    buyAndHold: {
      value: number
      valueUsd: number
      perc: number
    }
    periodRatio: number
    sharpe: number
    sortino: number
    cwr: number
  }
  interval: ExchangeIntervals
  quoteRate: number
  symbol: string
  baseAsset: string
  quoteAsset: string
  userId: string
  time: number
  settings: ComboBotSettings
  exchange: ExchangeEnum
  exchangeUUID: string
  savePermanent: boolean
  shareId?: string
  value?: number
  archive?: boolean
  author?: string
  sent?: boolean
  config?: BacktestingSettings
  note?: string
  multi?: boolean
  multiPairs?: number
  symbolStats?: SymbolStats[]
  periodicStats?: PeriodicStats[]
  messages?: string[]
}

export type DCABacktestingResultShort = {
  noData?: boolean
  maxLeverage?: number
  financial: {
    netProfitTotal: number
    netProfitTotalUsd: number
    netProfitTotalPerc: number
    grossProfit: number
    grossProfitUsd: number
    grossProfitPerc: number
    grossLoss: number
    grossLossUsd: number
    grossLossPerc: number
    avgGrossProfit: number
    avgGrossProfitUsd: number
    avgGrossProfitPerc: number
    avgGrossLoss: number
    avgGrossLossUsd: number
    avgGrossLossPerc: number
    avgNetProfit: number
    avgNetProfitUsd: number
    avgNetProfitPerc: number
    avgNetDaily: number
    avgNetDailyUsd: number
    avgNetDailyPerc: number
    unrealizedPnL: number
    unrealizedPnLUsd: number
    unrealizedPnLPerc: number
    unrealizedUsage: number
    maxDealProfit: number
    maxDealLoss: number
    maxDealProfitUsd: number
    maxDealProfitPerc: number
    maxDealLossUsd: number
    maxDealLossPerc: number
    maxRunUp: number
    maxRunUpUsd: number
    maxRunUpPerc: number
    maxDrawDown: number
    maxDrawDownUsd: number
    maxDrawDownPerc: number
    maxDrawDownEquityUsd?: number
    maxDrawDownEquityPerc?: number
    initialBalanceUsd: number
    stDevWinningTrade?: number
    stDevLosingTrade?: number
    stDownDevLosingTrade?: number
    annualizedReturn?: number
  }
  duration: {
    avgDealDuration: number
    avgSplitDealDuration: SplitTime
    firstDataTime: number
    lastDataTime: number
    loadingDataTime: number
    processingDataTime: number
    botWorkingTime: SplitTime
    maxDealDuration: SplitTime
    maxDealDurationTime: number
    periodName?: string
    botWorkingTimeNumber: number
    avgWinningTrade?: number
    maxWinningTrade?: number
    avgLosingTrade?: number
    maxLosingTrade?: number
  }
  usage: {
    maxTheoreticalUsageWithRate: number
    maxTheoreticalUsage: number
    maxRealUsage: number
    avgRealUsage: number
  }
  numerical: {
    all: number
    profit: number
    loss: number
    open: number
    closed: number
    maxConsecutiveWins: number
    maxConsecutiveLosses: number
    maxDCATriggered: number
    avgDCATriggered: number
    dealsPerDay: number
    coveredPriceDeviation: number
    actualPriceDeviation: number
    liquidationEvents?: number
    confidenceGrade?: string
    dealsForConfidenceGrade?: number
    priceDeviation?: number
  }
  ratios: {
    profitFactor: number
    profitByPeriod: number[]
    buyAndHold: {
      value: number
      valueUsd: number
      perc: number
    }
    periodRatio: number
    sharpe: number
    sortino: number
    cwr: number
  }
  interval: ExchangeIntervals
  quoteRate: number
  precision?: number
  _id?: string
  shared?: boolean
  multi?: boolean
  multiPairs?: number
  symbolStats?: SymbolStats[]
  periodicStats?: PeriodicStats[]
  messages?: string[]
}

export interface _HedgeBacktestingResult {
  longResult: DCABacktestingResultShort
  shortResult: DCABacktestingResultShort
  hedgeResult: Pick<
    DCABacktestingResult,
    'financial' | 'duration' | 'usage' | 'numerical' | 'ratios'
  >
}

export type HedgeDCABacktestSideConfig = {
  symbol: string
  baseAsset: string
  quoteAsset: string
  exchange: ExchangeEnum
  exchangeUUID: string
  settings: DCABotSettings
  duration: _HedgeBacktestingResult['longResult']['duration'] & {
    periodName?: string
  }
}

export type HedgeComboBacktestSideConfig = Omit<
  HedgeDCABacktestSideConfig,
  'settings'
> & {
  settings: ComboBotSettings
}

export type HedgeComboBacktestingResult = Omit<
  HedgeDCABacktestingResult,
  'long' | 'short'
> & { long: HedgeComboBacktestSideConfig; short: HedgeComboBacktestSideConfig }

export type HedgeDCABacktestingResult = {
  serverSide?: boolean
  hedgeResult: _HedgeBacktestingResult['hedgeResult']
  longResult: _HedgeBacktestingResult['longResult']
  shortResult: _HedgeBacktestingResult['shortResult']
  long: HedgeDCABacktestSideConfig
  short: HedgeDCABacktestSideConfig
  userId: string
  time: number
  savePermanent: boolean
  config: BacktestingSettings
  archive?: boolean
  author?: string
  sent?: boolean
  note?: string
  shareId?: string
}

export interface GRIDBacktestingResult extends SchemaI {
  serverSide?: boolean
  noData?: boolean
  firstUsdRate: number
  lastUsdRate: number
  financial: {
    profitTotal: string
    profitTotalUsd: number
    budgetUsd: number
    avgNetDaily: string
    avgNetDailyUsd: number
    avgTransactionProfit: string
    avgTransactionProfitUsd: number
    initialBalances: string
    initialBalancesUsd: number
    currentBalances: string
    currentBalancesUsd: number
    valueChange: string
    valueChangeUsd: number
    startPrice: string
    lastPrice: string
    breakevenPrice: number
    initialBalancesByAsset: {
      base: string
      quote: string
    }
    currentBalancesByAsset: {
      base: string
      quote: string
    }
    profitTotalPerc: number
    avgNetDailyPerc: number
    annualizedReturn?: number
    valueChangePerc: number
    avgTransactionProfitPerc: number
  }
  duration: {
    firstDataTime: number
    lastDataTime: number
    loadingDataTime: number
    processingDataTime: number
    botWorkingTime: SplitTime
    botWorkingTimeNumber: number
    periodName?: string
  }
  numerical: {
    all: number
    transactionsPerDay: number
    buy: number
    sell: number
  }
  ratios: {
    profitByPeriod: number[]
    buyAndHold: {
      value: number
      valueUsd: number
      perc: number
    }
    periodRatio: number
    sharep?: number
    sortino: number
    cwr?: number
  }
  interval?: ExchangeIntervals
  quoteRate: number
  symbol: string
  baseAsset: string
  quoteAsset: string
  userId: string
  time: number
  settings: BotSettings
  exchange: ExchangeEnum
  exchangeUUID: string
  savePermanent: boolean
  shareId?: string
  position: {
    count: number
    qty: number
    price: number
    side: string
    pnl: {
      value: number
      perc: number
    }
  }
  value?: number
  archive?: boolean
  author?: string
  sent?: boolean
  config?: BacktestingSettings
  note?: string
}

export type CleanGRIDBacktestingResult = ExcludeDoc<GRIDBacktestingResult>

export type CleanDCABacktestingResult = ExcludeDoc<DCABacktestingResult>

export interface UserNotificationHistorySchema extends SchemaI {
  type: 'email'
  to: string
  subject: string
  html: string
  text: string
  sent: boolean
  reason?: string
}

export interface StripeWebhook extends SchemaI {
  secret: string
}

export interface UserPeriod extends SchemaI {
  name: string
  from: number
  to: number
  userId: string
  uuid: string
}

export type CleanUserPeriod = ExcludeDoc<UserPeriod>

export enum BuyTypeEnum {
  X = 'X',
  all = 'all',
  proceed = 'proceed',
  diff = 'diff',
  sellDiff = 'sellDiff',
}

export type CryptoNewsTickerStat = {
  'Total Positive': number
  'Total Negative': number
  'Total Neutral': number
  'Sentiment Score': number
}

export type GeneralOpenOrder = {
  symbol: string
  botId?: string
  botName?: string
  side: OrderSideType
  type: OrderTypeT
  created: Date
  exchange: ExchangeEnum
  exchangeUUID: string
  exchangeName: string
  status: OrderStatusType
  botType?: 'dca' | 'grid' | 'terminal' | 'combo' | 'hedgeDca' | 'hedgeCombo'
  dealId?: string
  price: string
  quantity: string
  baseAssetName?: string
  quoteAssetName?: string
  orderId: string
  executedQty: string
  clientOrderId: string
}

export type GeneralFuture = {
  symbol: string
  created: Date
  exchange: ExchangeEnum
  exchangeUUID: string
  exchangeName: string
  leverage: string
  side: PositionSide_LT
  price: string
  quantity: string
  baseAssetName?: string
  quoteAssetName?: string
  positionId: string
  botId?: string
  botName?: string
  botType?: 'dca' | 'grid' | 'terminal' | 'combo' | 'hedgeDca' | 'hedgeCombo'
  marginType: BotMarginTypeEnum
}

export type CSV = {
  a: string
  p: string
  q: string
  f: string
  l: string
  T: string
  m: string
  M: string
}

export type CSVCandle = {
  o: string
  h: string
  l: string
  c: string
  v: string
  t: string
}

export type BacktestingSettings = {
  userFee: number
  slippage: string
  firstDataTime?: number
  lastDataTime?: number
  RFR?: string
  MAR?: string
  usage?: 'maxRealUsage' | 'maxTheoreticalUsage'
  pair?: string
  multiIdependent?: boolean
  multiCombined?: boolean
}

export enum MaintenanceServicesEnum {
  dca = 'dca',
  combo = 'combo',
  grid = 'grid',
  hedgeCombo = 'hedgeCombo',
  hedgeDca = 'hedgeDca',
}

export interface MaintenanceSchema extends SchemaI {
  text: string
  title: string
  scheduledDate: Date
  duration: number
  active: boolean
  services?: MaintenanceServicesEnum[]
  textShort: string
  titleShort: string
}

export type CreateBotDto = {
  do: 'create'
  botType: BotType
  botId: string
  args: unknown[]
  userId: string
  exchange: ExchangeEnum
}

export type MethodBotDto = {
  do: 'method'
  botType: BotType
  botId: string
  method: string
  args: unknown[]
  responseId?: string
  ping?: string
}

export type UpdateBotExchangeDto = {
  do: 'update'
  exchangeUUID: string
  key: string
  secret: string
  passphrase?: string
  userId: string
  keysType?: CoinbaseKeysType
  okxSource?: OKXSource
  bybitHost?: BybitHost
}

export type UpdateBotExchangeInfoDto = {
  do: 'exchangeInfo'
  info: ClearPairsSchema[]
  exchange: ExchangeEnum
}

export type DeleteBotDto = {
  do: 'delete'
  botId: string
  botType: BotType
}

export type BotWorkerDto =
  | CreateBotDto
  | MethodBotDto
  | UpdateBotExchangeDto
  | UpdateBotExchangeInfoDto
  | DeleteBotDto
  | RAMDump
  | UpdateLogLevel

export type RAMDump = {
  do: 'ramDump'
}

export type UpdateLogLevel = {
  do: 'updateLogLevel'
  logLevel: LogLevel
}

export type BacktestOnboardingWorkerDto = {
  do: 'onboarding'
  data: {
    presets: {
      id: string
      exchange: ExchangeEnum
      type: BotType
      from?: number
      to?: number
      interval?: ExchangeIntervals
      fromBacktest?: boolean
    }[]
    userId: string
    encryptedToken: string
  }
}

export type BacktestServerSideWorkerDto = {
  do: 'serverSide'
  data: {
    payload: ServerSideBacktestPayload
    userId: string
    requestId: string
    encryptedToken: string
  }
}

export type BacktestWorkerDto =
  | BacktestOnboardingWorkerDto
  | BacktestServerSideWorkerDto

export type BotParentCreateEventDto = {
  event: 'createBot'
  botId: string
  create: boolean
}

export type BotParentReponseEventDto = {
  event: 'response'
  botId: string
  responseId: string
  response: unknown
}

export type BotParentIndicatorEventDto = {
  event: 'subscribeIndicator'
  botId: string
  data: {
    indicatorConfig: IndicatorConfig
    interval: ExchangeIntervals
    symbol: string
    exchange: ExchangeEnum
    test: boolean
    limitMultiplier?: number
    load1d?: boolean
  }
  responseId: string
  responseParams: {
    uuid: string
    symbol: string
  }
  type: BotType
}

export type BotParentUnsubscribeIndicatorEventDto = {
  event: 'unsubscribeIndicator'
  id: string
  botId: string
  responseId: string
  type: BotType
}

export type InputDeal = {
  _id: string
  settings: {
    futures: CleanDCADealsSchema['settings']['futures']
    marginType: CleanDCADealsSchema['settings']['marginType']
    leverage: CleanDCADealsSchema['settings']['leverage']
    comboTpBase: CleanDCADealsSchema['settings']['comboTpBase']
    coinm: CleanDCADealsSchema['settings']['coinm']
    profitCurrency: CleanDCADealsSchema['settings']['profitCurrency']
  }
  currentBalances: CleanDCADealsSchema['currentBalances']
  initialBalances: CleanDCADealsSchema['initialBalances']
  feePaid: CleanDCADealsSchema['feePaid']
  profit: {
    total: CleanDCADealsSchema['profit']['total']
    pureBase: CleanDCADealsSchema['profit']['pureBase']
    pureQuote: CleanDCADealsSchema['profit']['pureQuote']
  }
  avgPrice: CleanDCADealsSchema['avgPrice']
  strategy: CleanDCADealsSchema['strategy']
  usage: CleanDCADealsSchema['usage']
  stats: CleanDCADealsSchema['stats']
  reduceFunds: CleanDCADealsSchema['reduceFunds']
  flags: CleanDCADealsSchema['flags']
  tpFilledHistory: CleanDCADealsSchema['tpFilledHistory']
  botId: string
}

export type InputGrid = {
  _id: string
  exchange: ClearBotSchema['exchange']
  initialBalances: ClearBotSchema['initialBalances']
  initialPrice: ClearBotSchema['initialPrice']
  currentBalances: ClearBotSchema['currentBalances']
  realInitialBalances: ClearBotSchema['realInitialBalances']
  settings: {
    marginType: ClearBotSchema['settings']['marginType']
    leverage: ClearBotSchema['settings']['leverage']
    profitCurrency: ClearBotSchema['settings']['profitCurrency']
  }
  position: ClearBotSchema['position']
  profit: {
    total: ClearBotSchema['profit']['total']
  }
  stats: ClearBotSchema['stats']
}

export type BotParentProcessStatsEventDtoDcaCombo = {
  event: 'processStats'
  botId: string
  botType: BotType.combo | BotType.dca
  payload: {
    combo: boolean
    data: PriceMessage
    deal: InputDeal
    fee: number
    usdRate: number
  }
}

export type BotParentRemoveStatsEventDtoDcaCombo = {
  event: 'removeStats'
  dealId: string
}

export type BotParentProcessStatsEventDtoGrid = {
  event: 'processStats'
  botId: string
  botType: BotType.grid
  payload: {
    data: PriceMessage
    bot: InputGrid
  }
}

export type BotParentProcessStatsEventDto =
  | BotParentProcessStatsEventDtoDcaCombo
  | BotParentProcessStatsEventDtoGrid

export type BotParentBotClosed = {
  event: 'botClosed'
  botId: string
  botType: BotType
}

export type BotParentEventsDto =
  | BotParentCreateEventDto
  | BotParentReponseEventDto
  | BotParentIndicatorEventDto
  | BotParentUnsubscribeIndicatorEventDto
  | BotParentProcessStatsEventDto
  | BotParentBotClosed

export type ParentIndicatorMessage = {
  event: 'indicatorData'
  data: IndicatorHistory[]
  id: string
  price: number
}

export type ServerSideBacktestPayload =
  | {
      type: BotType.dca | BotType.combo
      data: Omit<DCABacktestingInput, 'prices' | 'symbols' | 'exchange'> & {
        exchange: ExchangeEnum
        exchangeUUID: string
      }
      config: BacktestingSettings & { periodName?: string }
    }
  | {
      type: BotType.grid
      data: Omit<GRIDBacktestingInput, 'prices' | 'symbols' | 'exchange'> & {
        exchange: ExchangeEnum
        exchangeUUID: string
      }
      config: BacktestingSettings & { periodName?: string }
    }

export const timeIntervalMap = {
  [ExchangeIntervals.oneM]: 60 * 1000,
  [ExchangeIntervals.threeM]: 3 * 60 * 1000,
  [ExchangeIntervals.fiveM]: 5 * 60 * 1000,
  [ExchangeIntervals.fifteenM]: 15 * 60 * 1000,
  [ExchangeIntervals.thirtyM]: 30 * 60 * 1000,
  [ExchangeIntervals.oneH]: 60 * 60 * 1000,
  [ExchangeIntervals.twoH]: 2 * 60 * 60 * 1000,
  [ExchangeIntervals.fourH]: 4 * 60 * 60 * 1000,
  [ExchangeIntervals.eightH]: 8 * 60 * 60 * 1000,
  [ExchangeIntervals.oneD]: 24 * 60 * 60 * 1000,
  [ExchangeIntervals.oneW]: 7 * 24 * 60 * 60 * 1000,
}

export type WorkerUpdateDto =
  | {
      event: 'end'
    }
  | { event: 'queueCandle'; key: string; responseId: string }
  | { event: 'unQueueCandle'; key: string }

export type DynamicArPrices = { id: string; value: number }

export type ExchangeTimeProfile = {
  attempts: number
  incomingTime: number
  outcomingTime: number
  inQueueStartTime: number
  inQueueEndTime: number
  exchangeRequestStartTime: number
  exchangeRequestEndTime: number
}

export type BalancerTimeProfile = Partial<ExchangeTimeProfile> & {
  balancerIncomingTime: number
  balancerOutcomingTime: number
  balancerRequestStartTime: number
  balancerRequestEndTime: number
}

export type ExchangeRequestTimeProfile = Partial<BalancerTimeProfile> & {
  appIncomingTime: number
  appOutcomingTime: number
  appRequestStartTime: number
  appRequestEndTime: number
  appAttempts: number
  exchange: ExchangeEnum
  requestName: string
  exchangeBalancerDiff?: number
  balanacerAppDiff?: number
}

export interface ExchangeRequestTimeProfileSchema
  extends SchemaI, ExchangeRequestTimeProfile {
  exchangeTotal: number
  exchangeQueueTotal: number
  exchangeRequestTotal: number
  balancerTotal: number
  balancerRequestTotal: number
  appTotal: number
  appRequestTotal: number
}

export type DealHistory = {
  time: number
  perc: number
  total: number
  totalUsd: number
  usage: number
  duration: number
  dcaOrders: number
  symbol: string
  id: string
}

export type DealStopLossCombo = { sl: number; tp: number }

export interface UserProfitByHour extends SchemaI {
  userId: string
  time: number
  profitUsd: number
  botType: BotType
  terminal?: boolean
  paperContext: boolean
}

export const rabbitIndicatorsKey = 'indicatorsActions'
export const serviceLogRedis = 'serviceLog'
export const rabbitExchange = 'gainium'
export const liveupdate = 'liveupdate'
export const rabbitUsersStreamKey = 'usersStreamAction'
export const setToRedisDelay = 750

export type IndicatorCb = (
  data: IndicatorHistory[],
  price: number,
  is1d?: boolean,
) => any

export type IndicatorSubscribers = {
  id: string
  is1d?: boolean
}

export type IndicatorWorkerResponsePayload = {
  event: 'indicatorUpdate'
  payload: { id: string; data: IndicatorHistory[]; price: number }
}

export type IndicatorCreationConfig = {
  indicatorConfig: IndicatorConfig
  interval: ExchangeIntervals
  symbol: string
  symbolCode?: string
  exchange: ExchangeEnum
  test?: boolean
  limitMultiplier?: number
  load1d?: boolean
}

export type SubscribeInternalIndicatorReponse = {
  id: string
  data?: IndicatorHistory[]
  lastPrice?: number
}

export type IndicatorServiceParentMessageCreateIndicator = {
  event: 'createIndicator'
  payload: IndicatorCreationConfig
  response: string
  id: string
}

export type IndicatorServiceParentMessageDeleteIndicator = {
  event: 'deleteIndicator'
  response: string
  id: string
}

export type IndicatorUpdateLogLevelIndicator = {
  event: 'updateLogLevel'
  logLevel: LogLevel
}

export type IndicatorServiceChildMessageCreateIndicator = {
  response: string
}

export type IndicatorServiceChildMessageDeleteIndicator = {
  response: string
}

export type IndicatorServiceChildMessageSubscribeIndicator = {
  response: string
  data: SubscribeInternalIndicatorReponse
}

export type IndicatorServiceParentMessageSubscribeIndicator = {
  event: 'subscribe'
  payload: [string | undefined, boolean | undefined]
  id: string
  response: string
}

export type IdicatorServiceChildMessageUnsubscribeIndicator = {
  response: string
  data: number
}

export type IndicatorServiceParentMessageUnsubscribeIndicator = {
  event: 'unsubscribe'
  payload: [string]
  id: string
  response: string
}

export type IndicatorServiceChildMessageRemoveCallback = {
  response: string
}

export type IndicatorServiceParentMessageRemoveCallback = {
  event: 'removeCallback'
  payload: [string]
  id: string
  response: string
}

export type IndicatorState = {
  id: string
  type: IndicatorEnum
  indicatorName: string
  exchange: ExchangeEnum
  symbol: string
  symbolCode?: string
  interval: ExchangeIntervals
  period: number
  loaded: boolean
  closed: boolean
  is1d: boolean
  test: boolean
  limitMultiplier: number
  warmupCandles: number
  allowedToProcessPriceUpdate: boolean
  subscribers: number
  data: IndicatorHistory[]
  lastPrice: number
  lastCandle: {
    open: string
    high: string
    low: string
    close: string
    volume: string
  }
  current: { o: number; h: number; l: number; c: number; v: number }
  start: number
  to: number
  lastCandleTime: number
  lastCandleTimestamp: number
  lastSentUpdateAt: number
  recentCandleStarts: number[]
}

export type IndicatorServiceChildMessageGetState = {
  response: string
  data: IndicatorState | null
}

export type IndicatorServiceParentMessageGetState = {
  event: 'getState'
  payload: []
  id: string
  response: string
}

export type IndicatorServiceChildMessage =
  | IndicatorServiceChildMessageCreateIndicator
  | IndicatorServiceChildMessageSubscribeIndicator
  | IdicatorServiceChildMessageUnsubscribeIndicator
  | IndicatorServiceChildMessageRemoveCallback
  | IndicatorServiceChildMessageGetState

export type IndicatorServiceParentMessage =
  | IndicatorServiceParentMessageCreateIndicator
  | IndicatorServiceParentMessageSubscribeIndicator
  | IndicatorServiceParentMessageUnsubscribeIndicator
  | IndicatorServiceParentMessageRemoveCallback
  | IndicatorServiceParentMessageDeleteIndicator
  | IndicatorServiceParentMessageGetState
  | IndicatorUpdateLogLevelIndicator

export type IndicatorServiceParentMessageMethods =
  | IndicatorServiceParentMessageSubscribeIndicator
  | IndicatorServiceParentMessageUnsubscribeIndicator
  | IndicatorServiceParentMessageRemoveCallback
  | IndicatorServiceParentMessageGetState

export interface MigrationSchema extends SchemaI {
  version: number
}

export type MigrationJob = {
  version: number
  job: () => Promise<void>
}

export enum BotServiceQueues {
  gridQueue = 'gridQueue',
  dcaQueue = 'dcaQueue',
  comboQueue = 'comboQueue',
  hedgeComboQueue = 'hedgeComboQueue',
  hedgeDcaQueue = 'hedgeDcaQueue',
}

export enum OrderCurrencyEnum {
  base = 'base',
  quote = 'quote',
  perc = 'perc',
}

export enum GlobalVariablesTypeEnum {
  text = 'text',
  int = 'int',
  float = 'float',
}

export type RelatedBot = {
  id: string
  name: string
}

export interface GlobalVariablesSchema extends SchemaI {
  name: string
  value: string | number
  type: GlobalVariablesTypeEnum
  botAmount: number
  userId: string
}

export type CleanGlobalVariablesSchema = ExcludeDoc<GlobalVariablesSchema>

export type CreateComboBotInput = ComboBotSettings & {
  baseAsset?: string[]
  quoteAsset?: string[]
  exchange: ExchangeEnum
  exchangeUUID: string
  vars?: BotVars | null
}

export type CreateGridBotInput = BotSettings & {
  exchange: ExchangeEnum
  exchangeUUID: string
  vars?: BotVars | null
}

export type HedgeBotSettings = Pick<
  ComboBotSettings,
  | 'useTp'
  | 'tpPerc'
  | 'useSl'
  | 'slPerc'
  | 'comboTpBase'
  | 'comboTpLimit'
  | 'comboSlLimit'
  | 'dealCloseConditionSL'
  | 'dealCloseCondition'
>
export interface HedgeBotSchema
  extends
    SchemaI,
    Pick<
      MainBot,
      | 'paperContext'
      | 'profitByAssets'
      | 'showErrorWarning'
      | 'status'
      | 'statusReason'
      | 'userId'
      | 'uuid'
      | 'workingShift'
      | 'isDeleted'
      | 'deleteTime'
      | 'share'
      | 'shareId'
      | 'cost'
    >,
    Pick<
      DCABotSchema,
      'profit' | 'symbol' | 'stats' | 'symbolStats' | 'flags'
    > {
  bots: ComboBotSchema[]
  initialBalances: {
    long: DCABotSchema['initialBalances']
    short: DCABotSchema['initialBalances']
  }
  currentBalances: {
    long: DCABotSchema['currentBalances']
    short: DCABotSchema['currentBalances']
  }
  assets: {
    long: DCABotSchema['assets']
    short: DCABotSchema['assets']
  }
  sharedSettings?: HedgeBotSettings
}

export type CleanHedgeBotSchema = ExcludeDoc<HedgeBotSchema>

export enum ResetAccountTypeEnum {
  whole = 'whole',
  paper = 'paper',
  live = 'live',
  softLive = 'softLive',
}

export type ResetLogStatus = 'ok' | 'error' | 'skipped'

export interface ResetLogEntry {
  step: string
  collection?: string
  deletedCount?: number
  status: ResetLogStatus
  reason?: string
  at: Date
}

export interface BrokerCodesSchema extends SchemaI {
  exchange: ExchangeEnum
  zone?: string
  code: string
}

export type CleanBrokerCodesSchema = ExcludeDoc<BrokerCodesSchema>
export type InputRequest = {
  token: string
  userAgent?: string
  req: {
    user?: { username: string; authorized: boolean }
    cookies: { a?: string; aid?: string }
  }
  paperContext: boolean
  ip?: string
}

export enum BybitHost {
  eu = 'eu',
  com = 'com',
  nl = 'nl',
  tr = 'tr',
  kz = 'kz',
  ge = 'ge',
}

export type LogLevel = 'error' | 'info' | 'warn' | 'debug'

export type CreateDCABotInput = DCABotSettings & {
  baseAsset?: string[]
  quoteAsset?: string[]
  exchange: ExchangeEnum
  exchangeUUID: string
  uuid?: string
  vars?: BotVars | null
}
