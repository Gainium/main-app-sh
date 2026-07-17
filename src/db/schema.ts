import { Schema } from 'mongoose'
import type {
  BalancesSchema,
  BotEventSchema,
  ReconcileSweepSchema,
  QuantRulesEventSchema,
  BotMessageSchema,
  BotSchema,
  DCABacktestingResult,
  DCABotSchema,
  DCADealsSchema,
  FeesSchema,
  GRIDBacktestingResult,
  OrderSchema,
  PairsSchema,
  RateSchema,
  SnapshotSchema,
  TransactionSchema,
  UserSchema,
  UserPeriod,
  FavoritePairsSchema,
  ComboBotSchema,
  ComboBotSettings,
  ComboDealsSchema,
  ComboProfitSchema,
  ComboBacktestingResult,
  ComboMinigridSchema,
  ComboTransactionSchema,
  BacktestingSettings,
  SymbolStats,
  FavoriteIndicatorsSchema,
  PeriodicStats,
  StoreFilesSchema,
  BacktestRequestSchema,
  BotStats,
  UsdAssetNumber,
  BotSymbolsStats,
  BotProfitChartSchema,
  BotStatsSeries,
  UserProfitByHour,
  MigrationSchema,
  HedgeBotSchema,
  GlobalVariablesSchema,
  BrokerCodesSchema,
  HedgeComboBacktestingResult,
  HedgeDCABacktestingResult,
  SnapshotPerExchangeSchema,
  StreamWatchdogConfigSchema,
} from '../../types'
import {
  APIPermission,
  BBCrossingEnum,
  BotProgressCodeEnum,
  BotStatusEnum,
  BotType,
  DCADealStatusEnum,
  DCATypeEnum,
  ExchangeEnum,
  ExchangeIntervals,
  IndicatorEnum,
  ECDTriggerEnum,
  rsiValueEnum,
  rsiValue2Enum,
  IndicatorStartConditionEnum,
  MAEnum,
  MessageTypeEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  SRCrossingEnum,
  StartConditionEnum,
  StrategyEnum,
  TradingviewAnalysisConditionEnum,
  TradingviewAnalysisSignalEnum,
  TypeOrderEnum,
  CooldownUnits,
  BuyTypeEnum,
  TrailingModeEnum,
  BotStartTypeEnum,
  CloseDCATypeEnum,
  IndicatorAction,
  CloseConditionEnum,
  TerminalDealTypeEnum,
  IndicatorSection,
  BotMarginTypeEnum,
  PositionSide,
  FuturesStrategyEnum,
  ComboMinigridStatusEnum,
  VolumeValueEnum,
  StochRangeEnum,
  DCAConditionEnum,
  BacktestRequestStatus,
  ComboTpBase,
  CoinbaseKeysType,
  CooldownOptionsEnum,
  PairPrioritizationEnum,
  ppValueEnum,
  ppValueTypeEnum,
  ScaleDcaTypeEnum,
  BaseSlOnEnum,
  RangeType,
  IndicatorsLogicEnum,
  OKXSource,
  GlobalVariablesTypeEnum,
  DCValueEnum,
  ActionsEnum,
  DCACloseTriggerEnum,
  BybitHost,
  OBFVGValueEnum,
  OBFVGRefEnum,
  SessionRuleEnum,
  LWValueEnum,
  RRSlTypeEnum,
  LWConditionEnum,
  StreamWatchdogConfigTypeEnum,
  StreamWatchdogConfigStatusEnum,
} from '../../types'
import { collections } from './config'

const OrderStatusEnum = [
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'PENDING_CANCEL',
  'REJECTED',
  'EXPIRED',
]

const ThemeMode = ['dark', 'light']

const TypeEnum = ['LIMIT', 'MARKET']

const SideEnum = ['SELL', 'BUY']

const BotPrioritizeEnum = ['level', 'gridStep']

const BotCurrencyEnum = ['quote', 'base']

const GridTypeEnum = ['geometric', 'arithmetic']

const TpSlConditionEnum = ['valueChanged', 'priceReached']

const TpSlActionEnum = ['stop', 'stopAndSell']

const InitialPriceFromEnum = [
  'start',
  'swap',
  'user',
  'dealStart',
  'dealRegular',
]

const RequiredString = {
  type: String,
  required: true,
}

const RequiredNumber = {
  type: Number,
  required: true,
}

const RequiredBoolean = {
  type: Boolean,
  required: true,
}

const RequiredDate = {
  type: Date,
  required: true,
}

const CreatedUpdated = {
  created: {
    type: Date,
    default: Date.now,
  },
  updated: { type: Date, default: Date.now },
}

const favoritePairsSchema: Schema<FavoritePairsSchema> = new Schema({
  userId: RequiredString,
  provider: { ...RequiredString, enum: ExchangeEnum },
  pairs: [String],
  ...CreatedUpdated,
})

const favoriteIndicatorsSchema: Schema<FavoriteIndicatorsSchema> = new Schema({
  userId: RequiredString,
  indicators: [{ type: String, enum: IndicatorEnum }],
  ...CreatedUpdated,
})

export const userAPIKeys: Schema<UserSchema['apiKeys']> = new Schema({
  secret: RequiredString,
  created: RequiredDate,
  expired: RequiredDate,
  permission: { ...RequiredString, enum: APIPermission },
  name: String,
  paperContext: Boolean,
  botId: String,
  oauthClientId: String,
})

const botEventSchema: Schema<BotEventSchema> = new Schema({
  botId: RequiredString,
  botType: { ...RequiredString, enum: BotType },
  userId: RequiredString,
  event: RequiredString,
  description: String,
  metadata: Schema.Types.Mixed,
  paperContext: Boolean,
  type: { type: String, enum: MessageTypeEnum },
  deal: String,
  symbol: String,
  ...CreatedUpdated,
})

// Append-only record of reconciliation-sweep catches (a fill the user stream
// dropped that the periodic sweep recovered). Powers the admin user-stream
// health page; rows expire via TTL (see registerIndexes).
const reconcileSweepSchema: Schema<ReconcileSweepSchema> = new Schema(
  {
    botId: RequiredString,
    botType: { ...RequiredString, enum: BotType },
    userId: RequiredString,
    exchange: RequiredString,
    exchangeUUID: RequiredString,
    paperContext: Boolean,
    pair: String,
    missedFills: RequiredNumber,
    ...CreatedUpdated,
  },
  // Pin the collection explicitly. Mongoose otherwise lowercases the model
  // name (e.g. `dcaBots` → `dcabots`); the admin-app reader + backfill must
  // match this exact name or they silently read an empty collection.
  { collection: 'reconcilesweepcatches' },
)

// Binance Futures Quantitative Rules (-4400) cooldown events. Written by the
// bot engine's QuantRulesGuard on each NEW cooldown / escalation; read by the
// getQuantRulesStatus GraphQL query, admin-app, and the dashboard. Rows expire
// via TTL (see registerIndexes).
const quantRulesEventSchema: Schema<QuantRulesEventSchema> = new Schema(
  {
    userId: RequiredString,
    exchangeUUID: RequiredString,
    exchange: String,
    // Absent for account-scope (level 3) events.
    symbol: String,
    scope: { ...RequiredString, enum: ['symbol', 'account'] },
    level: RequiredNumber,
    until: RequiredDate,
    violationCount24h: Number,
    botId: String,
    botType: String,
    dealId: String,
    reason: String,
    ...CreatedUpdated,
  },
  // Pin the collection explicitly. Mongoose otherwise lowercases the model
  // name; the admin-app reader + dashboard GraphQL projection must match this
  // exact literal or they silently read an empty collection.
  { collection: 'quantrulesevents' },
)

const userSchema: Schema<UserSchema> = new Schema({
  bigAccount: Boolean,
  username: {
    ...RequiredString,
    unique: true,
    dropDubs: true,
  },
  picture: String,
  name: {
    type: String,
  },
  lastName: {
    type: String,
  },
  password: RequiredString,
  tokens: [
    {
      token: RequiredString,
      createdAt: {
        type: Date,
        default: Date.now,
      },
      expiredAt: {
        type: Date,
        default: null,
      },
      source: String,
      // Device context captured at login, for the user's session list.
      ip: String,
      userAgent: String,
    },
  ],
  exchanges: [
    {
      provider: { ...RequiredString, enum: ExchangeEnum },
      name: String,
      key: RequiredString,
      secret: RequiredString,
      passphrase: String,
      uuid: RequiredString,
      hedge: Boolean,
      zeroFee: Boolean,
      subaccount: Boolean,
      notAllowedToDelete: Boolean,
      linkedTo: String,
      status: Boolean,
      lastUpdated: Number,
      keysType: { type: String, enum: CoinbaseKeysType },
      okxSource: { type: String, enum: OKXSource },
      uid: Schema.Types.Mixed,
      affiliate: Boolean,
      waitingForConfirmation: Boolean,
      bybitHost: { type: String, enum: BybitHost },
    },
  ],
  timezone: RequiredString,
  weekStart: String,
  theme: {
    type: String,
    enum: ThemeMode,
  },
  ...CreatedUpdated,
  paperContext: Boolean,
  apiKeys: [userAPIKeys],
  shouldOnBoard: Boolean,
  shouldOnBoardExchange: Boolean,
  onboardingSteps: {
    signup: Boolean,
    liveExchange: Boolean,
    deployLiveBot: Boolean,
    earnProfit: Boolean,
  },
  displayName: String,
  ips: [
    {
      ip: String,
      userAgent: String,
      location: { country: String, city: String },
      ...CreatedUpdated,
    },
  ],
  videos: [{ id: String, watch80: Boolean, closed: Boolean }],
  licenseKey: String,
})

const workingShift = [{ start: RequiredNumber, end: Number }]

const asset = {
  base: Number,
  quote: Number,
}
const multiAsset = {
  base: Map<string, number>,
  quote: Map<string, number>,
}
const profit = {
  total: Number,
  totalUsd: Number,
  freeTotal: Number,
  freeTotalUsd: Number,
  pureBase: Number,
  pureQuote: Number,
  gridProfit: Number,
  gridProfitUsd: Number,
}

// Funding fees accrued on a futures position. Kept separate from `profit`
// because deal-close recomputes profit.total from scratch (which would wipe a
// running funding accumulator). `offset` is the dedup cursor — per-deal for
// DCA/Combo, per-bot for Grid; on the bot aggregate for DCA/Combo it is unused.
const funding = {
  total: Number, // cumulative funding in quote asset (signed; negative = paid)
  totalUsd: Number,
  offset: Number, // last processed fundingTime (ms)
  lastTime: Number, // last applied settlement time (ms)
  // Last 25 applied settlements — cheap to keep, very useful for debugging.
  history: [
    {
      time: Number,
      rate: Number,
      markPrice: Number,
      qty: Number, // signed position at settlement
      feeQuote: Number,
      feeUsd: Number,
    },
  ],
}

const profitByAssets = [
  {
    asset: String,
    total: Number,
    totalUsd: Number,
  },
]

const BuyTypeEnumDB = [BuyTypeEnum.X, BuyTypeEnum.all, BuyTypeEnum.proceed]

const Symbols = {
  symbol: String,
  baseAsset: String,
  quoteAsset: String,
}

const botCommon = {
  locked: Boolean,
  share: Boolean,
  shareId: String,
  pendingClose: Boolean,
  pendingCloseTime: Number,
  userId: RequiredString,
  status: {
    ...RequiredString,
    enum: BotStatusEnum,
  },
  previousStatus: {
    type: String,
    enum: BotStatusEnum,
  },
  statusReason: String,
  // Cold-store (archived-bot → ClickHouse). Set true ONLY once a bot's
  // orders/transactions have been copy-verify-deleted to CH (design phase 3).
  // When true the bot is READ-ONLY / one-way (cannot be un-archived — clone to
  // reuse) and its order/transaction drill-down reads route to CH, not Mongo.
  // Absent/false = grandfathered (stays in Mongo, old reversible semantics).
  coldArchived: Boolean,
  showErrorWarning: String,
  profit,
  funding,
  profitByAssets,
  profitToday: {
    start: Number,
    end: Number,
    totalToday: Number,
    totalTodayUsd: Number,
  },
  symbol: Symbols,
  exchange: {
    ...RequiredString,
    enum: ExchangeEnum,
  },
  exchangeUUID: RequiredString,
  unrealizedProfit: Number,
  workingShift,
  workingTimeNumber: Number,
  initialBalances: asset,
  currentBalances: asset,
  usdRate: Number,
  lastPrice: Number,
  lastUsdRate: Number,
  assets: {
    used: asset,
    required: asset,
  },
  uuid: RequiredString,
  paperContext: Boolean,
  isDeleted: Boolean,
  deleteTime: Date,
  exchangeUnassigned: Boolean,
  parentBotId: String,
  vars: {
    list: [{ type: String, ref: collections.globalVariables }],
    paths: [
      new Schema(
        {
          path: String,
          variable: { type: String, ref: collections.globalVariables },
        },
        { _id: false },
      ),
    ],
  },
  notEnoughBalance: {
    orders: Schema.Types.Map,
    thresholdPassed: Boolean,
    thresholdPassedTime: Number,
  },
  cost: Number,
  ...CreatedUpdated,
}

const botSettingsCommon = {
  name: String,
  pair: RequiredString,
  profitCurrency: {
    type: String,
    enum: BotCurrencyEnum,
  },
  orderFixedIn: {
    type: String,
    enum: BotCurrencyEnum,
  },
}

const priceFrom = { type: String, enum: InitialPriceFromEnum }

const botSettings = new Schema({
  ...botSettingsCommon,
  topPrice: RequiredNumber,
  lowPrice: RequiredNumber,
  levels: RequiredNumber,
  gridStep: RequiredNumber,
  budget: RequiredNumber,
  ordersInAdvance: {
    type: Number,
    required: false,
  },
  useOrderInAdvance: RequiredBoolean,
  prioritize: {
    type: String,
    enum: BotPrioritizeEnum,
  },

  sellDisplacement: RequiredNumber,
  gridType: {
    type: String,
    enum: GridTypeEnum,
  },
  tpSl: Boolean,
  tpSlCondition: {
    type: String,
    enum: TpSlConditionEnum,
  },
  tpSlAction: {
    type: String,
    enum: TpSlActionEnum,
  },
  sl: Boolean,
  slCondition: {
    type: String,
    enum: TpSlConditionEnum,
  },
  slAction: {
    type: String,
    enum: TpSlActionEnum,
  },
  tpPerc: Number,
  slPerc: Number,
  tpTopPrice: Number,
  slLowPrice: Number,
  updatedBudget: Boolean,
  useStartPrice: Boolean,
  startPrice: String,
  marginType: { type: String, enum: BotMarginTypeEnum },
  leverage: Number,
  futures: Boolean,
  coinm: Boolean,
  newProfit: Boolean,
  newBalance: Boolean,
  strategy: {
    type: String,
    enum: StrategyEnum,
  },
  futuresStrategy: {
    type: String,
    enum: FuturesStrategyEnum,
  },
  slLimit: Boolean,
  tpSlLimit: Boolean,
  feeOrder: Boolean,
  skipBalanceCheck: Boolean,
})

const botSchema: Schema<BotSchema> = new Schema({
  ...botCommon,
  feeBalance: Number,
  settings: botSettings,
  initialPrice: Number,
  initialPriceFrom: priceFrom,
  initialPriceStart: Number,
  initialPriceStartFrom: priceFrom,
  levels: {
    active: {
      buy: Number,
      sell: Number,
    },
    all: {
      buy: Number,
      sell: Number,
    },
  },
  transactionsCount: {
    buy: Number,
    sell: Number,
  },
  avgPrice: Number,
  progress: {
    stage: Number,
    total: Number,
    text: {
      type: String,
      enum: BotProgressCodeEnum,
    },
    isAllowedToCancel: Boolean,
  },
  swapType: { type: String, enum: BuyTypeEnumDB },
  swapSellCount: Number,
  initPriceForStartPrice: Number,
  haveStarted: Boolean,
  lastBalanceChange: Number,
  realInitialBalances: asset,
  position: {
    side: { type: String, enum: PositionSide },
    qty: Number,
    price: Number,
  },
  // Last few signed-position breakpoints {time, qty}, newest last. Lets the
  // funding processor rewind the position to a past settlement without reading
  // orders (grid drops filled orders from RAM once transacted).
  positionHistory: [
    {
      time: Number,
      qty: Number,
    },
  ],
  lastPositionChange: Number,
  stats: {
    drawdownPercent: RequiredNumber,
    runUpPercent: RequiredNumber,
    timeInProfit: RequiredNumber,
    timeInLoss: RequiredNumber,
    trackTime: RequiredNumber,
    timeCountStart: RequiredNumber,
    currentCount: String,
    unrealizedProfit: Number,
  },
  lastPriceRangeAlert: Number,
  liveStats: {
    budget: Number,
    value: Number,
    valueChange: Number,
    valueChangePerc: Number,
    avgDaily: Number,
    avgDailyPerc: Number,
    annualizedReturn: Number,
    freePorfit: Number,
    freeProfitUsd: Number,
    totalProfit: Number,
    totalProfitUsd: Number,
    tradingTime: Number,
    tradingTimeString: String,
  },
})

const orderSchema: Schema<OrderSchema> = new Schema({
  positionSide: String,
  reduceOnly: Boolean,
  closePosition: Boolean,
  timeInForce: String,
  cumQuote: String,
  cumBase: String,
  cumQty: String,
  avgPrice: String,
  symbol: RequiredString,
  baseAsset: RequiredString,
  quoteAsset: RequiredString,
  orderId: RequiredString,
  clientOrderId: {
    ...RequiredString,
    unique: true,
    dropDubs: true,
  },
  transactTime: Number,
  price: RequiredString,
  origPrice: String,
  origQty: RequiredString,
  executedQty: RequiredString,
  cummulativeQuoteQty: String,
  status: {
    ...RequiredString,
    enum: OrderStatusEnum,
  },
  type: {
    ...RequiredString,
    enum: TypeEnum,
  },
  side: {
    ...RequiredString,
    enum: SideEnum,
  },
  fills: [
    {
      price: RequiredString,
      qty: RequiredString,
      commission: RequiredString,
      commissionAsset: RequiredString,
      tradeId: {
        type: Schema.Types.Mixed,
        required: true,
      },
    },
  ],
  exchange: {
    ...RequiredString,
    enum: ExchangeEnum,
  },
  exchangeUUID: RequiredString,
  botId: RequiredString,
  userId: RequiredString,
  typeOrder: {
    ...RequiredString,
    enum: TypeOrderEnum,
  },
  updateTime: Number,
  dealId: String,
  paperContext: Boolean,
  tpSlTarget: String,
  dcaLevel: Number,
  minigridId: String,
  addFundsId: String,
  reduceFundsId: String,
  minigridBudget: Number,
  liquidation: Boolean,
  sl: Boolean,
  acBefore: Number,
  acAfter: Number,
  leverage: Number,
  ...CreatedUpdated,
})

const transactionSchema: Schema<TransactionSchema> = new Schema({
  updateTime: RequiredNumber,
  side: {
    ...RequiredString,
    enum: SideEnum,
  },
  amountBaseBuy: RequiredNumber,
  amountQuoteBuy: RequiredNumber,
  amountBaseSell: RequiredNumber,
  amountQuoteSell: RequiredNumber,
  priceBuy: RequiredNumber,
  priceSell: RequiredNumber,
  idBuy: String,
  idSell: String,
  feeBase: RequiredNumber,
  feeQuote: RequiredNumber,
  profitBase: RequiredNumber,
  profitQuote: RequiredNumber,
  botId: RequiredString,
  userId: RequiredString,
  symbol: RequiredString,
  baseAsset: RequiredString,
  quoteAsset: RequiredString,
  profitCurrency: RequiredString,
  profitUsdt: RequiredNumber,
  paperContext: Boolean,
  cummulativeProfitBase: Number,
  cummulativeProfitQuote: Number,
  cummulativeProfitUsdt: Number,
  executor: String,
  index: {
    type: String,
    unique: true,
    dropDubs: true,
    index: true,
    sparse: true,
  },
  amountFreeBaseBuy: Number,
  amountFreeQuoteBuy: Number,
  amountFreeBaseSell: Number,
  amountFreeQuoteSell: Number,
  freeProfitUsd: Number,
  isDeleted: Boolean,
  ...CreatedUpdated,
})

const comboTransactionSchema: Schema<ComboTransactionSchema> = new Schema({
  updateTime: RequiredNumber,
  side: {
    ...RequiredString,
    enum: SideEnum,
  },
  amountBaseBuy: RequiredNumber,
  amountQuoteBuy: RequiredNumber,
  amountBaseSell: RequiredNumber,
  amountQuoteSell: RequiredNumber,
  priceBuy: RequiredNumber,
  priceSell: RequiredNumber,
  idBuy: String,
  idSell: String,
  feeBase: RequiredNumber,
  feeQuote: RequiredNumber,
  profitBase: RequiredNumber,
  profitQuote: RequiredNumber,
  botId: RequiredString,
  userId: RequiredString,
  symbol: RequiredString,
  baseAsset: RequiredString,
  quoteAsset: RequiredString,
  profitCurrency: RequiredString,
  profitUsdt: RequiredNumber,
  paperContext: Boolean,
  cummulativeProfitBase: Number,
  cummulativeProfitQuote: Number,
  cummulativeProfitUsdt: Number,
  executor: String,
  index: {
    type: String,
    unique: true,
    dropDubs: true,
    index: true,
    sparse: true,
  },
  dealId: String,
  minigridId: String,
  pureBase: Number,
  pureFeeBase: Number,
  pureQuote: Number,
  pureFeeQuote: Number,
  ...CreatedUpdated,
})

const botMessageSchema: Schema<BotMessageSchema> = new Schema({
  userId: RequiredString,
  botId: RequiredString,
  botType: String,
  botName: String,
  message: RequiredString,
  time: RequiredNumber,
  type: { ...RequiredString, enum: MessageTypeEnum },
  isDeleted: {
    type: Boolean,
    default: false,
  },
  subType: String,
  // Aggregate count for digest-style notices (e.g. one daily "auto-archived"
  // notice summarising N bots) — the message text carries the human wording.
  count: Number,
  paperContext: Boolean,
  terminal: Boolean,
  showUser: Boolean,
  fullMessage: String,
  symbol: String,
  exchange: String,
  ...CreatedUpdated,
})

const rateSchema: Schema<RateSchema> = new Schema({
  usdRate: RequiredNumber,
  ...CreatedUpdated,
})

const pairsSchema: Schema<PairsSchema> = new Schema({
  wsCode: String,
  code: String,
  pair: RequiredString,
  exchange: { ...RequiredString, enum: ExchangeEnum },
  // OKX account-origin owning this pair (`my` = OKX Europe / eea.okx.com
  // authoritative USDC/EUR spot universe). Unset for the global feed + all other
  // exchanges. Bot form matches (exchange, source) to the account's okxSource.
  source: { type: String, enum: OKXSource },
  baseAsset: {
    minAmount: RequiredNumber,
    maxAmount: RequiredNumber,
    step: RequiredNumber,
    name: RequiredString,
    // Human-readable asset name (e.g. "Apple Inc.", "Bitcoin") resolved from a
    // reference source (coins collection for crypto, logo.dev/curated map for
    // stocks) by the `saveAssetNames` cron — exchanges don't return names.
    // Optional & additive: absent until resolved, UI falls back to the ticker.
    displayName: String,
    maxMarketAmount: Number,
    multiplier: Number,
  },
  quoteAsset: {
    minAmount: RequiredNumber,
    name: RequiredString,
    precision: Number,
  },
  maxOrders: RequiredNumber,
  priceAssetPrecision: RequiredNumber,
  priceMultiplier: {
    up: Number,
    down: Number,
    decimals: Number,
  },
  type: String,
  crossAvailable: Boolean,
  // Normalized asset class (crypto/stock/etf/commodity/metal/forex/index).
  // Defaults to 'crypto' so legacy/un-backfilled pairs read as crypto.
  assetCategory: {
    type: String,
    enum: ['crypto', 'stock', 'etf', 'commodity', 'metal', 'forex', 'index'],
    default: 'crypto',
  },
  // Canonical/curated-listing flag for the pair-picker "Canonical only" toggle.
  // Set only for Hyperliquid spot (HL-canonical or Unit-bridged); absent for
  // every other exchange => treated as canonical.
  isCanonical: Boolean,
  ...CreatedUpdated,
})

const feesSchema: Schema<FeesSchema> = new Schema({
  pair: RequiredString,
  exchange: { ...RequiredString, enum: ExchangeEnum },
  exchangeUUID: RequiredString,
  userId: RequiredString,
  maker: RequiredNumber,
  taker: RequiredNumber,
  ...CreatedUpdated,
})

const balancesSchema: Schema<BalancesSchema> = new Schema({
  asset: RequiredString,
  exchange: { ...RequiredString, enum: ExchangeEnum },
  exchangeUUID: RequiredString,
  userId: RequiredString,
  free: RequiredNumber,
  locked: RequiredNumber,
  paperContext: Boolean,
  ...CreatedUpdated,
})

const snapshotsSchema: Schema<SnapshotSchema> = new Schema({
  userId: RequiredString,
  updateTime: RequiredNumber,
  totalUsd: RequiredNumber,
  assets: [
    {
      name: String,
      amount: Number,
      amountUsd: Number,
      exchanges: [
        {
          uuid: String,
          amount: Number,
          amountUsd: Number,
        },
      ],
    },
  ],
  exchangesTotal: [
    {
      uuid: String,
      totalUsd: Number,
    },
  ],
  paperContext: Boolean,
  ...CreatedUpdated,
})

const snapshotsPerExchangeSchema: Schema<SnapshotPerExchangeSchema> =
  new Schema({
    userId: RequiredString,
    updateTime: RequiredNumber,
    totalUsd: RequiredNumber,
    uuid: String,
    paperContext: Boolean,
    ...CreatedUpdated,
  })

const usage = {
  current: asset,
  max: asset,
  currentUsd: Number,
  maxUsd: Number,
  relative: Number,
}

const indicatorGroup = new Schema(
  {
    id: String,
    logic: { type: String, enum: IndicatorsLogicEnum },
    action: { type: String, enum: IndicatorAction },
    section: String,
  },
  { _id: false },
)

const indicatorsSettings = new Schema({
  type: {
    type: String,
    enum: IndicatorEnum,
  },
  indicatorLength: Number,
  indicatorValue: String,
  indicatorCondition: {
    type: String,
    enum: IndicatorStartConditionEnum,
  },
  groupId: String,
  indicatorInterval: {
    type: String,
    enum: ExchangeIntervals,
  },
  uuid: String,
  signal: {
    type: String,
    enum: TradingviewAnalysisSignalEnum,
  },
  condition: {
    type: String,
    enum: TradingviewAnalysisConditionEnum,
  },
  checkLevel: Number,
  maType: {
    type: String,
    enum: MAEnum,
  },
  maCrossingValue: {
    type: String,
    enum: MAEnum,
  },
  maCrossingLength: Number,
  maCrossingInterval: String,
  maUUID: String,
  bbCrossingValue: {
    type: String,
    enum: BBCrossingEnum,
  },
  stochSmoothK: Number,
  stochSmoothD: Number,
  stochUpper: String,
  stochLower: String,
  stochRSI: Number,
  valueInsteadof: Number,
  rsiValue: { type: String, enum: rsiValueEnum },
  rsiValue2: { type: String, enum: rsiValue2Enum },
  stochRange: { type: String, enum: StochRangeEnum },
  srCrossingValue: { type: String, enum: SRCrossingEnum },
  leftBars: Number,
  rightBars: Number,
  interval: Number,
  basePeriods: Number,
  pumpPeriods: Number,
  pump: Number,
  baseCrack: Number,
  indicatorAction: { type: String, enum: IndicatorAction },
  section: { type: String, enum: IndicatorSection },
  psarStart: Number,
  psarInc: Number,
  psarMax: Number,
  minPercFromLast: String,
  orderSize: String,
  keepConditionBars: String,
  voShort: Number,
  voLong: Number,
  uoFast: Number,
  uoMiddle: Number,
  uoSlow: Number,
  momSource: String,
  bbwpLookback: Number,
  ecdTrigger: { type: String, enum: ECDTriggerEnum },
  xOscillator1: {
    type: String,
    enum: IndicatorEnum,
  },
  xOscillator2: {
    type: String,
    enum: IndicatorEnum,
  },
  xOscillator2length: Number,
  xOscillator2voLong: Number,
  xOscillator2voShort: Number,
  xOscillator2Interval: {
    type: String,
    enum: ExchangeIntervals,
  },
  xoUUID: String,
  percentile: Boolean,
  percentileLookback: Number,
  percentilePercentage: Number,
  mar1length: Number,
  mar1type: {
    type: String,
    enum: MAEnum,
  },
  mar2length: Number,
  mar2type: {
    type: String,
    enum: MAEnum,
  },
  bbwMult: Number,
  bbwMa: {
    type: String,
    enum: MAEnum,
  },
  bbwMaLength: Number,
  macdFast: Number,
  macdSlow: Number,
  macdMaSource: {
    type: String,
    enum: MAEnum,
  },
  macdMaSignal: {
    type: String,
    enum: MAEnum,
  },
  divOscillators: [String],
  divType: String,
  divMinCount: Number,
  trendFilter: Boolean,
  trendFilterLookback: Number,
  trendFilterType: String,
  trendFilterValue: Number,
  factor: Number,
  atrLength: Number,
  stCondition: String,
  pcUp: String,
  pcDown: String,
  pcCondition: String,
  pcValue: String,
  ppHighLeft: Number,
  ppHighRight: Number,
  ppLowLeft: Number,
  ppLowRight: Number,
  ppMult: Number,
  ppValue: { type: String, enum: ppValueEnum },
  ppType: { type: String, enum: ppValueTypeEnum },
  riskAtrMult: String,
  dynamicArFactor: String,
  athLookback: Number,
  kcMa: { type: String, enum: MAEnum },
  kcRange: { type: String, enum: RangeType },
  kcRangeLength: Number,
  unpnlValue: Number,
  unpnlCondition: { type: String, enum: IndicatorStartConditionEnum },
  dcValue: { type: String, enum: DCValueEnum },
  obfvgValue: { type: String, enum: OBFVGValueEnum },
  obfvgRef: { type: String, enum: OBFVGRefEnum },
  sessionDays: [Number],
  sessionRule: { type: String, enum: SessionRuleEnum },
  lwThreshold: Schema.Types.Mixed,
  lwMaxDuration: Schema.Types.Mixed,
  lwValue: { type: String, enum: LWValueEnum },
  lwCondition: { type: String, enum: LWConditionEnum },
})

const multiTP = new Schema({
  target: String,
  amount: String,
  uuid: String,
  fixed: String,
})

const dcaBotSettings = new Schema({
  ...botSettingsCommon,
  skipBalanceCheck: Boolean,
  dcaCondition: { type: String, enum: DCAConditionEnum },
  dcaVolumeBaseOn: String,
  dcaVolumeRequiredChange: String,
  dcaVolumeRequiredChangeRef: String,
  dcaVolumeMaxValue: String,
  baseSlOn: { type: String, enum: BaseSlOnEnum },
  closeByTimer: Boolean,
  closeByTimerValue: Number,
  closeByTimerUnits: { type: String, enum: CooldownUnits },
  maxDealsPerHigherTimeframe: String,
  useMaxDealsPerHigherTimeframe: Boolean,
  remainderFullAmount: Boolean,
  autoRebalancing: Boolean,
  adaptiveClose: Boolean,
  dcaCustom: [{ uuid: String, step: String, size: String }],
  strategy: {
    ...RequiredString,
    enum: StrategyEnum,
  },
  baseOrderSize: RequiredString,
  startOrderType: {
    ...RequiredString,
    enum: OrderTypeEnum,
  },
  startCondition: {
    ...RequiredString,
    enum: StartConditionEnum,
  },
  tpPerc: String,
  slPerc: String,
  orderSize: RequiredString,
  step: RequiredString,
  ordersCount: RequiredNumber,
  activeOrdersCount: RequiredNumber,
  volumeScale: RequiredString,
  stepScale: RequiredString,
  minimumDeviation: String,
  useTp: RequiredBoolean,
  useSl: RequiredBoolean,
  useSmartOrders: RequiredBoolean,
  minOpenDeal: Number,
  maxOpenDeal: Number,
  useDca: RequiredBoolean,
  hodlDay: String,
  hodlAt: String,
  hodlHourly: Boolean,
  hodlNextBuy: Number,
  hodleIgnoreAt: Boolean,
  maxNumberOfOpenDeals: String,
  indicators: [indicatorsSettings],
  indicatorGroups: [indicatorGroup],
  type: { type: String, enum: DCATypeEnum },
  baseOrderPrice: String,
  orderSizeType: { type: String, enum: OrderSizeTypeEnum },
  limitTimeout: String,
  useLimitTimeout: Boolean,
  notUseLimitReposition: Boolean,
  useLimitPrice: Boolean,
  cooldownAfterDealStart: Boolean,
  cooldownAfterDealStartUnits: { type: String, enum: CooldownUnits },
  cooldownAfterDealStartInterval: Number,
  cooldownAfterDealStop: Boolean,
  cooldownAfterDealStopUnits: { type: String, enum: CooldownUnits },
  cooldownAfterDealStopInterval: Number,
  cooldownAfterDealStartOption: { type: String, enum: CooldownOptionsEnum },
  cooldownAfterDealStopOption: { type: String, enum: CooldownOptionsEnum },
  moveSL: Boolean,
  moveSLTrigger: String,
  moveSLValue: String,
  moveSLForAll: Boolean,
  trailingSl: Boolean,
  trailingTp: Boolean,
  trailingTpPerc: String,
  useCloseAfterX: Boolean,
  useCloseAfterXwin: Boolean,
  closeAfterXwin: String,
  useCloseAfterXloss: Boolean,
  closeAfterXloss: String,
  useCloseAfterXprofit: Boolean,
  closeAfterXprofitValue: String,
  closeAfterXprofitCond: String,
  closeAfterX: String,
  useCloseAfterXopen: Boolean,
  closeAfterXopen: String,
  pair: [RequiredString],
  maxDealsPerPair: String,
  ignoreStartDeals: Boolean,
  comboTpBase: { type: String, enum: ComboTpBase },
  useMulti: Boolean,
  botStart: { type: String, enum: BotStartTypeEnum },
  useBotController: Boolean,
  stopType: { type: String, enum: CloseDCATypeEnum },
  stopStatus: { type: String, enum: BotStatusEnum },
  dealCloseCondition: { type: String, enum: CloseConditionEnum },
  dealCloseConditionSL: { type: String, enum: CloseConditionEnum },
  useMinTP: Boolean,
  minTp: String,
  closeDealType: { type: String, enum: CloseDCATypeEnum },
  closeOrderType: { type: String, enum: OrderTypeEnum },
  dcaByMarket: Boolean,
  terminalDealType: { type: String, enum: TerminalDealTypeEnum },
  useMultiTp: Boolean,
  multiTp: [multiTP],
  useMultiSl: Boolean,
  pairPrioritization: { type: String, enum: PairPrioritizationEnum },
  multiSl: [multiTP],
  marginType: { type: String, enum: BotMarginTypeEnum },
  leverage: Number,
  futures: Boolean,
  coinm: Boolean,
  importFrom: String,
  useVolumeFilter: Boolean,
  volumeTop: String,
  volumeValue: { type: String, enum: VolumeValueEnum },
  useFixedTPPrices: Boolean,
  useFixedSLPrices: Boolean,
  fixedTpPrice: String,
  fixedSlPrice: String,
  comboUpperMinigrids: String,
  comboLowerMinigrids: String,
  useRelativeVolumeFilter: Boolean,
  relativeVolumeTop: String,
  relativeVolumeValue: String,
  useStaticPriceFilter: Boolean,
  useCooldown: Boolean,
  useVolumeFilterAll: Boolean,
  useDynamicPriceFilter: Boolean,
  dynamicPriceFilterOverValue: String,
  dynamicPriceFilterUnderValue: String,
  dynamicPriceFilterDeviation: String,
  dynamicPriceFilterPriceType: String,
  useNoOverlapDeals: Boolean,
  dynamicPriceFilterDirection: String,
  useRiskReward: Boolean,
  rrSlType: { type: String, enum: RRSlTypeEnum },
  rrSlFixedValue: String,
  riskSlType: String,
  riskSlAmountPerc: String,
  riskSlAmountValue: String,
  riskUseTpRatio: Boolean,
  riskTpRatio: String,
  riskMinPositionSize: String,
  scaleDcaType: { type: String, enum: ScaleDcaTypeEnum },
  startDealLogic: { type: String, enum: IndicatorsLogicEnum },
  stopDealLogic: { type: String, enum: IndicatorsLogicEnum },
  stopDealSlLogic: { type: String, enum: IndicatorsLogicEnum },
  stopBotLogic: { type: String, enum: IndicatorsLogicEnum },
  riskMaxPositionSize: String,
  dynamicArLockValue: Boolean,
  riskMaxSl: String,
  riskMinSl: String,
  comboSmartGridsCount: String,
  comboUseSmartGrids: Boolean,
  useRiskReduction: Boolean,
  riskReductionValue: String,
  useReinvest: Boolean,
  reinvestValue: String,
  startBotPriceCondition: String,
  startBotPriceValue: String,
  stopBotPriceCondition: String,
  stopBotPriceValue: String,
  startBotLogic: String,
  botActualStart: String,
  useSeparateMaxDealsOverAndUnder: Boolean,
  maxDealsOver: String,
  maxDealsUnder: String,
  useSeparateMaxDealsOverAndUnderPerSymbol: Boolean,
  maxDealsOverPerSymbol: String,
  maxDealsUnderPerSymbol: String,
})

const comboBotSettings = new Schema<ComboBotSettings>({
  ...botSettingsCommon,
  skipBalanceCheck: Boolean,
  dcaCondition: { type: String, enum: DCAConditionEnum },
  dcaVolumeBaseOn: String,
  dcaVolumeRequiredChange: String,
  dcaVolumeRequiredChangeRef: String,
  dcaVolumeMaxValue: String,
  baseSlOn: { type: String, enum: BaseSlOnEnum },
  closeByTimer: Boolean,
  closeByTimerValue: Number,
  closeByTimerUnits: { type: String, enum: CooldownUnits },
  maxDealsPerHigherTimeframe: String,
  useMaxDealsPerHigherTimeframe: Boolean,
  remainderFullAmount: Boolean,
  autoRebalancing: Boolean,
  adaptiveClose: Boolean,
  useStaticPriceFilter: Boolean,
  useCooldown: Boolean,
  useVolumeFilterAll: Boolean,
  useDynamicPriceFilter: Boolean,
  dynamicPriceFilterDeviation: String,
  dynamicPriceFilterOverValue: String,
  dynamicPriceFilterUnderValue: String,
  dynamicPriceFilterPriceType: String,
  useNoOverlapDeals: Boolean,
  dynamicPriceFilterDirection: String,
  useRiskReward: Boolean,
  rrSlType: { type: String, enum: RRSlTypeEnum },
  rrSlFixedValue: String,
  riskSlType: String,
  riskSlAmountPerc: String,
  riskSlAmountValue: String,
  riskUseTpRatio: Boolean,
  riskTpRatio: String,
  riskMinPositionSize: String,
  scaleDcaType: { type: String, enum: ScaleDcaTypeEnum },
  startDealLogic: { type: String, enum: IndicatorsLogicEnum },
  stopDealLogic: { type: String, enum: IndicatorsLogicEnum },
  stopDealSlLogic: { type: String, enum: IndicatorsLogicEnum },
  stopBotLogic: { type: String, enum: IndicatorsLogicEnum },
  riskMaxPositionSize: String,
  dynamicArLockValue: Boolean,
  riskMaxSl: String,
  riskMinSl: String,
  dcaCustom: [{ uuid: String, step: String, size: String }],
  strategy: {
    ...RequiredString,
    enum: StrategyEnum,
  },
  baseOrderSize: RequiredString,
  startOrderType: {
    ...RequiredString,
    enum: OrderTypeEnum,
  },
  startCondition: {
    ...RequiredString,
    enum: StartConditionEnum,
  },
  tpPerc: RequiredString,
  slPerc: RequiredString,
  orderSize: RequiredString,
  step: RequiredString,
  ordersCount: RequiredNumber,
  activeOrdersCount: RequiredNumber,
  volumeScale: RequiredString,
  stepScale: RequiredString,
  useTp: RequiredBoolean,
  useSl: RequiredBoolean,
  useSmartOrders: RequiredBoolean,
  minOpenDeal: Number,
  maxOpenDeal: Number,
  useDca: RequiredBoolean,
  hodlDay: String,
  hodlAt: String,
  hodlHourly: Boolean,
  hodlNextBuy: Number,
  maxNumberOfOpenDeals: String,
  indicators: [indicatorsSettings],
  indicatorGroups: [indicatorGroup],
  type: { type: String, enum: DCATypeEnum },
  baseOrderPrice: String,
  orderSizeType: { type: String, enum: OrderSizeTypeEnum },
  limitTimeout: String,
  useLimitTimeout: Boolean,
  notUseLimitReposition: Boolean,
  useLimitPrice: Boolean,
  cooldownAfterDealStart: Boolean,
  cooldownAfterDealStartUnits: { type: String, enum: CooldownUnits },
  cooldownAfterDealStartInterval: Number,
  cooldownAfterDealStop: Boolean,
  cooldownAfterDealStopUnits: { type: String, enum: CooldownUnits },
  cooldownAfterDealStopInterval: Number,
  cooldownAfterDealStartOption: { type: String, enum: CooldownOptionsEnum },
  cooldownAfterDealStopOption: { type: String, enum: CooldownOptionsEnum },
  moveSL: Boolean,
  moveSLTrigger: String,
  moveSLValue: String,
  moveSLForAll: Boolean,
  trailingSl: Boolean,
  trailingTp: Boolean,
  trailingTpPerc: String,
  useCloseAfterX: Boolean,
  useCloseAfterXwin: Boolean,
  closeAfterXwin: String,
  useCloseAfterXloss: Boolean,
  closeAfterXloss: String,
  useCloseAfterXprofit: Boolean,
  closeAfterXprofitValue: String,
  closeAfterXprofitCond: String,
  closeAfterX: String,
  useCloseAfterXopen: Boolean,
  closeAfterXopen: String,
  pair: [RequiredString],
  maxDealsPerPair: String,
  ignoreStartDeals: Boolean,
  comboTpBase: { type: String, enum: ComboTpBase },
  useMulti: Boolean,
  botStart: { type: String, enum: BotStartTypeEnum },
  useBotController: Boolean,
  stopType: { type: String, enum: CloseDCATypeEnum },
  stopStatus: { type: String, enum: BotStatusEnum },
  dealCloseCondition: { type: String, enum: CloseConditionEnum },
  dealCloseConditionSL: { type: String, enum: CloseConditionEnum },
  useMinTP: Boolean,
  minTp: String,
  closeDealType: { type: String, enum: CloseDCATypeEnum },
  terminalDealType: { type: String, enum: TerminalDealTypeEnum },
  useMultiTp: Boolean,
  multiTp: [multiTP],
  useMultiSl: Boolean,
  pairPrioritization: { type: String, enum: PairPrioritizationEnum },
  multiSl: [multiTP],
  marginType: { type: String, enum: BotMarginTypeEnum },
  leverage: Number,
  futures: Boolean,
  coinm: Boolean,
  importFrom: String,
  gridLevel: String,
  feeOrder: Boolean,
  useVolumeFilter: Boolean,
  volumeTop: String,
  volumeValue: { type: String, enum: VolumeValueEnum },
  baseStep: String,
  baseGridLevels: String,
  useActiveMinigrids: Boolean,
  comboActiveMinigrids: String,
  comboSlLimit: Boolean,
  comboTpLimit: Boolean,
  newBalance: Boolean,
  useRelativeVolumeFilter: Boolean,
  relativeVolumeTop: String,
  relativeVolumeValue: String,
  comboSmartGridsCount: String,
  comboUseSmartGrids: Boolean,
  useRiskReduction: Boolean,
  riskReductionValue: String,
  useReinvest: Boolean,
  reinvestValue: String,
  startBotPriceCondition: String,
  startBotPriceValue: String,
  stopBotPriceCondition: String,
  stopBotPriceValue: String,
  startBotLogic: String,
  botActualStart: String,
  useSeparateMaxDealsOverAndUnder: Boolean,
  maxDealsOver: String,
  maxDealsUnder: String,
  useSeparateMaxDealsOverAndUnderPerSymbol: Boolean,
  maxDealsOverPerSymbol: String,
  maxDealsUnderPerSymbol: String,
  dcaByMarket: Boolean,
})

const botProfitChart: Schema<BotProfitChartSchema> = new Schema({
  userId: String,
  botId: String,
  value: Number,
  time: Number,
  type: { type: String, enum: BotType },
})

const usdAssetNumber: Schema<UsdAssetNumber> = new Schema({
  usd: Number,
  asset: Number,
})

const series: Schema<BotStatsSeries> = new Schema({
  count: Number,
  value: usdAssetNumber,
  minValue: usdAssetNumber,
  maxValue: usdAssetNumber,
  perc: Number,
})

const botStats: Schema<BotStats> = new Schema({
  numerical: {
    profit: {
      grossProfit: usdAssetNumber,
      grossProfitPerc: Number,
      maxDealProfit: usdAssetNumber,
      maxDealProfitPerc: Number,
      avgDealProfit: usdAssetNumber,
      avgDealProfitPerc: Number,
      maxRunUp: usdAssetNumber,
      maxRunUpPerc: Number,
      maxConsecutiveWins: Number,
      standardDeviationOfPositiveReturns: Number,
      series,
    },
    loss: {
      grossLoss: usdAssetNumber,
      grossLossPerc: Number,
      maxDealLoss: usdAssetNumber,
      maxDealLossPerc: Number,
      avgDealLoss: usdAssetNumber,
      avgDealLossPerc: Number,
      maxDrawdown: usdAssetNumber,
      maxDrawdownPerc: Number,
      maxEquityDrawdown: usdAssetNumber,
      maxEquityDrawdownPerc: Number,
      maxConsecutiveLosses: Number,
      standardDeviationOfNegativeReturns: Number,
      standardDeviationOfDownside: Number,
      series,
      seriesEquity: { value: Number, min: Number, max: Number, perc: Number },
    },
    general: {
      netProfitPerc: Number,
      avgDaily: usdAssetNumber,
      avgDailyPerc: Number,
      annualizedReturn: Schema.Types.Mixed,
      startBalance: usdAssetNumber,
      maxDCAOrdersTriggered: Number,
      avgDCAOrdersTriggered: Number,
      coveredPriceDeviation: Number,
      actualPriceDeviation: Number,
      confidenceGrade: String,
      bestDay: {
        time: Number,
        value: Number,
        percentage: Number,
      },
      worstDay: {
        time: Number,
        value: Number,
        percentage: Number,
      },
    },
    ratios: {
      profitFactor: Number,
      sharpeRatio: Number,
      sortinoRatio: Number,
      cwr: Number,
      buyAndHold: {
        result: Number,
        perc: Number,
        symbol: String,
        startPrice: Number,
      },
    },
    usage: {
      maxTheoreticalUsage: Number,
      maxActualUsage: Number,
      avgDealUsage: Number,
    },
    deals: {
      profit: Number,
      loss: Number,
    },
  },
  duration: {
    profit: {
      avgWinningTradeDuration: Number,
      maxWinningTradeDuration: Number,
      totalTime: Number,
    },
    loss: {
      avgLosingTradeDuration: Number,
      maxLosingTradeDuration: Number,
      totalTime: Number,
    },
    general: {
      maxDealDuration: Number,
      avgDealDuration: Number,
      dealsPerDay: Number,
      workingTime: Number,
      totalTime: Number,
    },
  },
  chart: [
    {
      realizedProfit: Number,
      buyAndHold: Number,
      equity: Number,
      time: Number,
    },
  ],
})

const botSymbolsStats: Schema<BotSymbolsStats> = new Schema({
  numerical: {
    deals: {
      profit: Number,
      loss: Number,
    },
    general: {
      startBalance: usdAssetNumber,
      netProfit: usdAssetNumber,
      netProfitPerc: Number,
      dailyProfit: usdAssetNumber,
      dailyProfitPerc: Number,
      winRate: Number,
      profitFactor: Number,
    },
  },
  duration: {
    maxDealDuration: Number,
    avgDealDuration: Number,
  },
  symbol: String,
})

const liveStats = {
  currentCost: Number,
  maxCost: Number,
  relativeCost: Number,
  relativeCostString: String,
  totalProfit: Number,
  relativeProfit: Number,
  value: Number,
  relativeValue: Number,
  avgDaily: Number,
  avgDailyRelative: Number,
  annualizedReturn: Number,
  tradingTimeString: String,
  tradingTimeNumber: Number,
  dealsTotal: Number,
}

const comboBotSchema: Schema<ComboBotSchema> = new Schema({
  ...botCommon,
  currentBalances: multiAsset,
  initialBalances: multiAsset,
  assets: { used: multiAsset, required: multiAsset },
  usdRate: Map<string, number>,
  lastUsdRate: Map<string, number>,
  lastPrice: Map<string, number>,
  symbol: Map<string, typeof Symbols>,
  settings: comboBotSettings,
  deals: {
    all: Number,
    active: Number,
  },
  usage,
  lastOpenedDeal: Number,
  lastClosedDeal: Number,
  lastOpenedDealPerSymbol: [{ symbol: String, time: Number }],
  lastClosedDealPerSymbol: [{ symbol: String, time: Number }],
  lastPricesPerSymbol: [
    { symbol: String, avg: Number, entry: Number, time: Number },
  ],
  dealsStatsForBot: [
    {
      dealId: String,
      avgPrice: Number,
      usage,
      profit: {
        total: Number,
        totalUsd: Number,
        pureBase: Number,
        pureQuote: Number,
      },
      feePaid: {
        base: Number,
        quote: Number,
      },
      symbol: String,
      currentBalances: asset,
      initialBalances: asset,
      comboTpBase: { type: String, enum: ComboTpBase },
    },
  ],
  dealsReduceForBot: [
    {
      profit: Number,
      profitUsd: Number,
      base: Number,
      quote: Number,
      id: String,
    },
  ],
  hodlIgnoreAt: Boolean,
  indicatorsData: [
    {
      signature: String,
      uuid: String,
      symbol: String,
      status: Boolean,
      statusTo: Number,
      statusSince: Number,
      numberOfSignals: Number,
    },
  ],
  feeBalance: Number,
  stats: botStats,
  symbolStats: [botSymbolsStats],
  resetStatsAfter: Number,
  ignoreStats: Boolean,
  useAssets: Boolean,
  flags: [String],
  action: {
    type: String,
    enum: ActionsEnum,
  },
  liveStats,
})

const dcaBotSchema: Schema<DCABotSchema> = new Schema({
  ...botCommon,
  dealsReduceForBot: [
    {
      profit: Number,
      profitUsd: Number,
      base: Number,
      quote: Number,
      id: String,
    },
  ],
  currentBalances: multiAsset,
  initialBalances: multiAsset,
  assets: { used: multiAsset, required: multiAsset },
  usdRate: Map<string, number>,
  lastUsdRate: Map<string, number>,
  lastPrice: Map<string, number>,
  symbol: Map<string, typeof Symbols>,
  settings: dcaBotSettings,
  deals: {
    all: Number,
    active: Number,
  },
  usage,
  lastOpenedDeal: Number,
  lastClosedDeal: Number,
  lastOpenedDealPerSymbol: [{ symbol: String, time: Number }],
  lastClosedDealPerSymbol: [{ symbol: String, time: Number }],
  lastPricesPerSymbol: [
    { symbol: String, avg: Number, entry: Number, time: Number },
  ],
  hodlIgnoreAt: Boolean,
  indicatorsData: [
    {
      signature: String,
      uuid: String,
      symbol: String,
      status: Boolean,
      statusTo: Number,
      statusSince: Number,
      numberOfSignals: Number,
    },
  ],
  stats: botStats,
  symbolStats: [botSymbolsStats],
  resetStatsAfter: Number,
  ignoreStats: Boolean,
  flags: [String],
  action: {
    type: String,
    enum: ActionsEnum,
  },
  liveStats,
})

const funds = [
  {
    qty: String,
    useLimitPrice: Boolean,
    limitPrice: String,
    asset: String,
    id: String,
    type: {
      type: String,
    },
  },
]

const filledFunds = [
  {
    price: Number,
    qty: Number,
  },
]

const dcaDealSchema: Schema<DCADealsSchema> = new Schema({
  closeTrigger: { type: String, enum: DCACloseTriggerEnum },
  flags: [String],
  note: String,
  botId: RequiredString,
  userId: RequiredString,
  status: {
    ...RequiredString,
    enum: DCADealStatusEnum,
  },
  initialBalances: asset,
  currentBalances: asset,
  feeBalance: Number,
  newBalance: Boolean,
  moveSlActivated: Boolean,
  initialPrice: Number,
  lastPrice: Number,
  profit: profit,
  funding: funding,
  feePaid: {
    base: Number,
    quote: Number,
  },
  avgPrice: Number,
  displayAvg: Number,
  commission: Number,
  createTime: Number,
  updateTime: Number,
  closeTime: Number,
  levels: {
    all: Number,
    complete: Number,
  },
  usage,
  assets: {
    used: asset,
    required: asset,
  },
  settings: {
    dcaCondition: { type: String, enum: DCAConditionEnum },
    dcaVolumeBaseOn: String,
    dcaVolumeRequiredChange: String,
    dcaVolumeRequiredChangeRef: String,
    dcaVolumeMaxValue: String,
    baseSlOn: { type: String, enum: BaseSlOnEnum },
    closeByTimer: Boolean,
    closeByTimerValue: Number,
    closeByTimerUnits: { type: String, enum: CooldownUnits },
    dcaCustom: [{ uuid: String, step: String, size: String }],
    ordersCount: Number,
    tpPerc: String,
    slPerc: String,
    profitCurrency: {
      type: String,
      enum: BotCurrencyEnum,
    },
    avgPrice: Number,
    baseOrderSize: String,
    baseOrderPrice: String,
    useLimitPrice: Boolean,
    startOrderType: { type: String, enum: OrderTypeEnum },
    volumeScale: String,
    stepScale: String,
    minimumDeviation: String,
    orderSize: String,
    changed: Boolean,
    useTp: Boolean,
    useSl: Boolean,
    useDca: Boolean,
    useSmartOrders: Boolean,
    activeOrdersCount: Number,
    orderSizePercQty: Number,
    slChangedByUser: Boolean,
    trailingSl: Boolean,
    moveSL: Boolean,
    moveSLTrigger: String,
    moveSLValue: String,
    moveSLForAll: Boolean,
    dealCloseCondition: { type: String, enum: CloseConditionEnum },
    dealCloseConditionSL: { type: String, enum: CloseConditionEnum },
    trailingTp: Boolean,
    trailingTpPerc: String,
    useMinTP: Boolean,
    minTp: String,
    closeDealType: { type: String, enum: CloseDCATypeEnum },
    closeOrderType: { type: String, enum: OrderTypeEnum },
    dcaByMarket: Boolean,
    orderSizeType: { type: String, enum: OrderSizeTypeEnum },
    useMultiSl: Boolean,
    multiSl: [multiTP],
    useMultiTp: Boolean,
    multiTp: [multiTP],
    step: String,
    futures: Boolean,
    coinm: Boolean,
    marginType: { type: String, enum: BotMarginTypeEnum },
    leverage: Number,
    useFixedTPPrices: Boolean,
    useFixedSLPrices: Boolean,
    fixedTpPrice: String,
    fixedSlPrice: String,
    comboTpBase: { type: String, enum: ComboTpBase },
    comboSmartGridsCount: String,
    comboUseSmartGrids: Boolean,
    comboActiveMinigrids: String,
    useActiveMinigrids: Boolean,
  },
  parentId: String,
  childIds: [RequiredString],
  parent: RequiredBoolean,
  child: RequiredBoolean,
  gridBreakpoints: [
    {
      price: Number,
      displacedPrice: Number,
    },
  ],
  paperContext: Boolean,
  type: { type: String, enum: DCATypeEnum },
  strategy: {
    type: String,
    enum: StrategyEnum,
  },
  exchange: String,
  exchangeUUID: String,
  symbol: { symbol: String, baseAsset: String, quoteAsset: String },
  bestPrice: Number,
  trailingLevel: Number,
  trailingMode: { type: String, enum: TrailingModeEnum },
  stats: {
    drawdownPercent: RequiredNumber,
    runUpPercent: RequiredNumber,
    timeInProfit: RequiredNumber,
    timeInLoss: RequiredNumber,
    trackTime: RequiredNumber,
    timeCountStart: RequiredNumber,
    currentCount: String,
    unrealizedProfit: Number,
    usage: Number,
    maxUsage: Number,
  },
  tpSlTargetFilled: [String],
  tpFilledHistory: [{ qty: Number, price: Number, id: String }],
  tpHistory: [{ qty: Number, price: Number, id: String }],
  dynamicAr: [{ value: Number, id: String }],
  allowBaseProcess: Boolean,
  pendingAddFunds: funds,
  pendingReduceFunds: funds,
  blockOrders: [
    { price: Number, qty: Number, side: { type: String, enum: SideEnum } },
  ],
  funds: filledFunds,
  reduceFunds: filledFunds,
  cost: Number,
  value: Number,
  size: Number,
  balanceStart: Number,
  isDeleted: Boolean,
  sizes: {
    base: Number,
    dca: [Number],
    origBase: Number,
    origDca: [Number],
  },
  tags: [String],
  ac: {
    before: Number,
    after: Number,
  },
  fixSize: Number,
  orderSizeType: String,
  enterMarketPrice: Boolean,
  eightySent: Number,
  hundredSent: Number,
  sellRemainder: Boolean,
  parentBotId: String,
  ...CreatedUpdated,
})

const comboDealSchema: Schema<ComboDealsSchema> = new Schema({
  closeTrigger: { type: String, enum: DCACloseTriggerEnum },
  action: { type: String, enum: ActionsEnum },
  note: String,
  botId: RequiredString,
  userId: RequiredString,
  status: {
    ...RequiredString,
    enum: DCADealStatusEnum,
  },
  initialBalances: asset,
  currentBalances: asset,
  feeBalance: Number,
  newBalance: Boolean,
  moveSlActivated: Boolean,
  initialPrice: Number,
  lastPrice: Number,
  profit: profit,
  funding: funding,
  feePaid: {
    base: Number,
    quote: Number,
  },
  avgPrice: Number,
  displayAvg: Number,
  commission: Number,
  createTime: Number,
  updateTime: Number,
  closeTime: Number,
  levels: {
    all: Number,
    complete: Number,
  },
  usage,
  assets: {
    used: asset,
    required: asset,
  },
  settings: {
    dcaCondition: { type: String, enum: DCAConditionEnum },
    dcaVolumeBaseOn: String,
    dcaVolumeRequiredChange: String,
    dcaVolumeRequiredChangeRef: String,
    dcaVolumeMaxValue: String,
    baseSlOn: { type: String, enum: BaseSlOnEnum },
    closeByTimer: Boolean,
    closeByTimerValue: Number,
    closeByTimerUnits: { type: String, enum: CooldownUnits },
    dcaCustom: [{ uuid: String, step: String, size: String }],
    ordersCount: Number,
    tpPerc: String,
    slPerc: String,
    profitCurrency: {
      type: String,
      enum: BotCurrencyEnum,
    },
    avgPrice: Number,
    baseOrderSize: String,
    baseOrderPrice: String,
    useLimitPrice: Boolean,
    startOrderType: { type: String, enum: OrderTypeEnum },
    volumeScale: String,
    stepScale: String,
    orderSize: String,
    changed: Boolean,
    useTp: Boolean,
    useSl: Boolean,
    useDca: Boolean,
    useSmartOrders: Boolean,
    activeOrdersCount: Number,
    orderSizePercQty: Number,
    slChangedByUser: Boolean,
    trailingSl: Boolean,
    moveSL: Boolean,
    moveSLTrigger: String,
    moveSLValue: String,
    moveSLForAll: Boolean,
    dealCloseCondition: { type: String, enum: CloseConditionEnum },
    dealCloseConditionSL: { type: String, enum: CloseConditionEnum },
    trailingTp: Boolean,
    trailingTpPerc: String,
    useMinTP: Boolean,
    minTp: String,
    closeDealType: { type: String, enum: CloseDCATypeEnum },
    orderSizeType: { type: String, enum: OrderSizeTypeEnum },
    useMultiSl: Boolean,
    multiSl: [multiTP],
    useMultiTp: Boolean,
    multiTp: [multiTP],
    step: String,
    futures: Boolean,
    coinm: Boolean,
    marginType: { type: String, enum: BotMarginTypeEnum },
    leverage: Number,
    gridLevel: String,
    feeOrder: Boolean,
    updatedComboAdjustments: Boolean,
    comboTpBase: { type: String, enum: ComboTpBase },
    comboSmartGridsCount: String,
    comboUseSmartGrids: Boolean,
    comboActiveMinigrids: String,
    useActiveMinigrids: Boolean,
    dcaByMarket: Boolean,
  },
  gridBreakpoints: [
    {
      price: Number,
      displacedPrice: Number,
    },
  ],
  paperContext: Boolean,
  strategy: {
    type: String,
    enum: StrategyEnum,
  },
  exchange: String,
  exchangeUUID: String,
  symbol: { symbol: String, baseAsset: String, quoteAsset: String },
  stats: {
    drawdownPercent: RequiredNumber,
    runUpPercent: RequiredNumber,
    timeInProfit: RequiredNumber,
    timeInLoss: RequiredNumber,
    trackTime: RequiredNumber,
    timeCountStart: RequiredNumber,
    currentCount: String,
    unrealizedProfit: Number,
    usage: Number,
    maxUsage: Number,
  },
  lastFilledLevel: Number,
  totalAssetAmount: Number,
  allowBaseProcess: Boolean,
  ignoreLevels: [Number],
  cost: Number,
  value: Number,
  size: Number,
  balanceStart: Number,
  transactions: {
    buy: Number,
    sell: Number,
  },
  sizes: {
    base: Number,
    dca: [Number],
    origBase: Number,
    origDca: [Number],
  },
  tags: [String],
  flags: [String],
  ac: {
    before: Number,
    after: Number,
  },
  fixSize: Number,
  fullFee: Number,
  eightySent: Number,
  hundredSent: Number,
  sellRemainder: Boolean,
  parentBotId: String,
  ...CreatedUpdated,
})

const comboProfitSchema: Schema<ComboProfitSchema> = new Schema({
  botId: RequiredString,
  userId: RequiredString,
  profit: {
    total: RequiredNumber,
    totalUsd: RequiredNumber,
  },
  updateTime: RequiredNumber,
  paperContext: RequiredBoolean,
  isDeleted: Boolean,
  ...CreatedUpdated,
})

const splitSchema = new Schema({
  d: String,
  h: String,
  min: String,
  s: String,
})

const backtestConfig: Schema<BacktestingSettings> = new Schema({
  userFee: String,
  slippage: String,
  firstDataTime: Number,
  lastDataTime: Number,
  RFR: String,
  MAR: String,
  usage: String,
  pair: String,
  multiIdependent: Boolean,
  multiCombined: Boolean,
})

const symbolStats: Schema<SymbolStats> = new Schema({
  pair: String,
  deals: {
    profit: Number,
    loss: Number,
    open: Number,
  },
  netProfit: { total: Number, totalUsd: Number, perc: Number },
  dailyReturn: { total: Number, totalUsd: Number, perc: Number },
  profitAsset: String,
  winRate: Number,
  profitFactor: String,
  maxDealDuration: splitSchema,
  avgDealDuration: splitSchema,
})

const periodicStats: Schema<PeriodicStats> = new Schema({
  deals: {
    profit: Number,
    loss: Number,
  },
  period: String,
  startTime: Number,
  netResult: Number,
  drawdown: Number,
  runup: Number,
})

const backtestRequest: Schema<BacktestRequestSchema> = new Schema({
  cost: Number,
  symbols: [
    {
      pair: String,
      baseAsset: String,
      quoteAsset: String,
    },
  ],
  exchange: { type: String, enum: ExchangeEnum },
  exchangeUUID: String,
  userId: String,
  status: { type: String, enum: BacktestRequestStatus },
  statusReason: String,
  backtestId: String,
  type: { type: String, enum: BotType },
  payload: Schema.Types.Mixed,
  statusHistory: [
    {
      status: { type: String, enum: BacktestRequestStatus },
      time: Number,
    },
  ],
  restarts: Number,
  ...CreatedUpdated,
})

const backtestFinancial = {
  netProfitTotal: Number,
  netProfitTotalUsd: Number,
  grossProfit: Number,
  grossProfitUsd: Number,
  grossLoss: Number,
  grossLossUsd: Number,
  avgGrossProfit: Number,
  avgGrossProfitUsd: Number,
  avgGrossLoss: Number,
  avgGrossLossUsd: Number,
  avgNetProfit: Number,
  avgNetProfitUsd: Number,
  avgNetDaily: Number,
  avgNetDailyUsd: Number,
  unrealizedPnL: Number,
  unrealizedPnLUsd: Number,
  unrealizedPnLPerc: Number,
  maxDealProfit: Number,
  maxDealLoss: Number,
  maxDealProfitUsd: Number,
  maxDealLossUsd: Number,
  maxRunUp: Number,
  maxRunUpUsd: Number,
  maxDrawDown: Number,
  maxDrawDownUsd: Number,
  maxDrawDownEquityUsd: Number,
  maxDrawDownEquityPerc: Number,
  netProfitTotalPerc: Number,
  grossProfitPerc: Number,
  grossLossPerc: Number,
  avgGrossProfitPerc: Number,
  avgGrossLossPerc: Number,
  avgNetProfitPerc: Number,
  avgNetDailyPerc: Number,
  annualizedReturn: Schema.Types.Mixed,
  maxDealProfitPerc: Number,
  maxDealLossPerc: Number,
  maxRunUpPerc: Number,
  maxDrawDownPerc: Number,
  initialBalanceUsd: Number,
  stDevWinningTrade: Number,
  stDevLosingTrade: Number,
  stDownDevLosingTrade: Number,
  unrealizedUsage: Number,
}

const backtestDuration = {
  avgDealDuration: Number,
  avgSplitDealDuration: splitSchema,
  firstDataTime: Number,
  lastDataTime: Number,
  loadingDataTime: Number,
  processingDataTime: Number,
  botWorkingTime: splitSchema,
  botWorkingTimeNumber: Number,
  maxDealDuration: splitSchema,
  maxDealDurationTime: Number,
  periodName: String,
  avgWinningTrade: Number,
  maxWinningTrade: Number,
  avgLosingTrade: Number,
  maxLosingTrade: Number,
}

const backtestUsage = {
  maxTheoreticalUsage: Number,
  maxRealUsage: Number,
  avgRealUsage: Number,
  maxTheoreticalUsageWithRate: Number,
}

const backtestNumerical = {
  all: Number,
  profit: Number,
  loss: Number,
  open: Number,
  closed: Number,
  maxConsecutiveWins: Number,
  maxConsecutiveLosses: Number,
  maxDCATriggered: Number,
  avgDCATriggered: Number,
  dealsPerDay: Number,
  coveredPriceDeviation: Number,
  actualPriceDeviation: Number,
  liquidationEvents: Number,
  confidenceGrade: String,
  dealsForConfidenceGrade: Number,
  priceDeviation: Number,
}

const backtestRatios = {
  profitFactor: Number,
  profitByPeriod: [Number],
  buyAndHold: {
    value: Number,
    valueUsd: Number,
    perc: Number,
  },
  periodRatio: Number,
  sharpe: Number,
  sortino: Number,
  cwr: Number,
}

const backtestCommon = {
  noData: Boolean,
  serverSide: Boolean,
  maxLeverage: Number,
  financial: backtestFinancial,
  duration: backtestDuration,
  usage: backtestUsage,
  numerical: backtestNumerical,
  ratios: backtestRatios,
  interval: { type: String, enum: ExchangeIntervals },
  quoteRate: Number,
  symbol: String,
  baseAsset: String,
  quoteAsset: String,
  userId: String,
  time: Number,
  exchange: { type: String, enum: ExchangeEnum },
  exchangeUUID: String,
  savePermanent: Boolean,
  shareId: String,
  value: Number,
  archive: Boolean,
  sent: Boolean,
  config: backtestConfig,
  note: String,
  multi: Boolean,
  multiPairs: Number,
  symbolStats: [symbolStats],
  periodicStats: [periodicStats],
  messages: [String],
}

const dcaBacktestingResult: Schema<DCABacktestingResult> = new Schema({
  ...backtestCommon,
  settings: dcaBotSettings,
  ...CreatedUpdated,
})

const comboBacktestingResult: Schema<ComboBacktestingResult> = new Schema({
  ...backtestCommon,
  settings: comboBotSettings,
  ...CreatedUpdated,
})

const hedgeBacktestCommon = {
  noData: Boolean,
  maxLeverage: Number,
  financial: backtestFinancial,
  duration: backtestDuration,
  usage: backtestUsage,
  numerical: backtestNumerical,
  ratios: backtestRatios,
  interval: { type: String, enum: ExchangeIntervals },
  quoteRate: Number,
  precision: Number,
  shared: Boolean,
  multi: Boolean,
  multiPairs: Number,
  symbolStats: [symbolStats],
  periodicStats: [periodicStats],
  messages: [String],
}

const hedgeBacktestSide = {
  symbol: String,
  baseAsset: String,
  quoteAsset: String,
  exchange: { type: String, enum: ExchangeEnum },
  exchangeUUID: String,
  duration: backtestDuration,
}

const hedgeComboBacktestingResult: Schema<HedgeComboBacktestingResult> =
  new Schema({
    serverSide: Boolean,
    hedgeResult: {
      financial: backtestFinancial,
      duration: backtestDuration,
      usage: backtestUsage,
      numerical: backtestNumerical,
      ratios: backtestRatios,
    },
    longResult: hedgeBacktestCommon,
    shortResult: hedgeBacktestCommon,
    long: { ...hedgeBacktestSide, settings: comboBotSettings },
    short: { ...hedgeBacktestSide, settings: comboBotSettings },
    userId: String,
    time: Number,
    savePermanent: Boolean,
    shareId: String,
    archive: Boolean,
    sent: Boolean,
    config: backtestConfig,
    note: String,
    ...CreatedUpdated,
  })

const hedgeDCABacktestingResult: Schema<HedgeDCABacktestingResult> = new Schema(
  {
    serverSide: Boolean,
    hedgeResult: {
      financial: backtestFinancial,
      duration: backtestDuration,
      usage: backtestUsage,
      numerical: backtestNumerical,
      ratios: backtestRatios,
    },
    longResult: hedgeBacktestCommon,
    shortResult: hedgeBacktestCommon,
    long: { ...hedgeBacktestSide, settings: dcaBotSettings },
    short: { ...hedgeBacktestSide, settings: dcaBotSettings },
    userId: String,
    time: Number,
    savePermanent: Boolean,
    shareId: String,
    archive: Boolean,
    sent: Boolean,
    config: backtestConfig,
    note: String,
    ...CreatedUpdated,
  },
)

const gridBacktestingResult: Schema<GRIDBacktestingResult> = new Schema({
  noData: Boolean,
  serverSide: Boolean,
  firstUsdRate: Number,
  lastUsdRate: Number,
  financial: {
    profitTotal: String,
    profitTotalUsd: Number,
    budgetUsd: Number,
    avgNetDaily: String,
    avgNetDailyUsd: Number,
    avgTransactionProfit: String,
    avgTransactionProfitUsd: Number,
    initialBalances: String,
    initialBalancesUsd: Number,
    currentBalances: String,
    currentBalancesUsd: Number,
    valueChange: String,
    valueChangeUsd: Number,
    startPrice: String,
    lastPrice: String,
    breakevenPrice: Number,
    initialBalancesByAsset: {
      base: String,
      quote: String,
    },
    currentBalancesByAsset: {
      base: String,
      quote: String,
    },
    profitTotalPerc: Number,
    freeProfitTotal: Number,
    freeProfitTotalUsd: Number,
    avgNetDailyPerc: Number,
    annualizedReturn: Schema.Types.Mixed,
    valueChangePerc: Number,
    avgTransactionProfitPerc: Number,
  },
  duration: {
    firstDataTime: Number,
    lastDataTime: Number,
    loadingDataTime: Number,
    processingDataTime: Number,
    botWorkingTime: splitSchema,
    periodName: String,
    botWorkingTimeNumber: Number,
  },
  numerical: {
    all: Number,
    transactionsPerDay: Number,
    buy: Number,
    sell: Number,
  },
  ratios: {
    profitByPeriod: [Number],
    buyAndHold: {
      value: Number,
      valueUsd: Number,
      perc: Number,
    },
    periodRatio: Number,
    sharpe: Number,
    sortino: Number,
    cwr: Number,
  },
  interval: { type: String, enum: ExchangeIntervals },
  quoteRate: Number,
  symbol: String,
  baseAsset: String,
  quoteAsset: String,
  userId: String,
  time: Number,
  settings: botSettings,
  exchange: { type: String, enum: ExchangeEnum },
  exchangeUUID: String,
  savePermanent: Boolean,
  shareId: String,
  position: {
    count: Number,
    qty: Number,
    price: Number,
    side: String,
    pnl: {
      value: Number,
      perc: Number,
    },
  },
  value: Number,
  archive: Boolean,
  sent: Boolean,
  config: backtestConfig,
  note: String,
  ...CreatedUpdated,
})

const userPeriod: Schema<UserPeriod> = new Schema({
  name: String,
  from: Number,
  to: Number,
  userId: String,
  uuid: String,
  ...CreatedUpdated,
})

const paperOrders = new Schema({
  amount: Number,
  filledAmount: Number,
  filledQuoteAmount: Number,
  quoteAmount: Number,
  price: Number,
  avgFilledPrice: Number,
  fee: Number,
  feePerc: Number,
  symbol: String,
  user: Schema.Types.Mixed,
  exchange: String,
  status: String,
  type: String,
  side: String,
  externalId: String,
  createdAt: Date,
  updatedAt: Date,
  reduceOnly: Boolean,
  positionSide: String,
})

const paperPositions = new Schema({
  _id: String,
  symbol: String,
  margin: Number,
  entryPrice: Number,
  closePrice: Number,
  liquidationPrice: Number,
  positionSide: String,
  positionAmt: Number,
  user: Schema.Types.Mixed,
  exchange: String,
  createdAt: Date,
  updatedAt: Date,
  id: String,
  status: String,
  profit: Number,
  fee: Number,
  leverage: Number,
  uuid: String,
})

const paperUser = new Schema({
  key: String,
  secret: String,
  username: String,
  takerFee: Number,
  makerFee: Number,
})

const comboMinigrid = new Schema<ComboMinigridSchema>({
  botId: String,
  userId: String,
  dealId: String,
  dcaOrderId: String,
  grids: { buy: Number, sell: Number },
  status: { type: String, enum: ComboMinigridStatusEnum },
  initialBalances: asset,
  currentBalances: asset,
  initialPrice: Number,
  realInitialPrice: Number,
  lastPrice: Number,
  lastSide: String,
  profit: {
    total: Number,
    totalUsd: Number,
    pureBase: Number,
    pureQuote: Number,
  },
  feePaid: {
    base: Number,
    quote: Number,
  },
  avgPrice: Number,
  createTime: Number,
  updateTime: Number,
  closeTime: Number,
  assets: { used: asset, required: asset },
  paperContext: Boolean,
  exchange: String,
  exchangeUUID: String,
  symbol: {
    symbol: String,
    baseAsset: String,
    quoteAsset: String,
  },
  settings: {
    topPrice: Number,
    lowPrice: Number,
    levels: Number,
    budget: Number,
    sellDisplacement: Number,
    profitCurrency: String,
    orderFixedIn: String,
  },
  transactions: {
    buy: Number,
    sell: Number,
  },
  lockClose: Boolean,
  ...CreatedUpdated,
})
const paperHedge = new Schema({
  user: Schema.Types.Mixed,
})

const paperLeverage = new Schema({
  user: Schema.Types.Mixed,
})

const paperWallets = new Schema({
  user: Schema.Types.Mixed,
  asset: String,
  free: Number,
  locked: Number,
})

const paperTrades = new Schema({
  order: Schema.Types.Mixed,
})

const storeFilesSchema = new Schema<StoreFilesSchema>({
  userId: String,
  fileName: String,
  size: Number,
  path: String,
  meta: Schema.Types.Mixed,
  ...CreatedUpdated,
})

const userProfitByHour = new Schema<UserProfitByHour>({
  userId: String,
  time: Number,
  profitUsd: Number,
  botType: { type: String, enum: BotType },
  terminal: Boolean,
  paperContext: Boolean,
  ...CreatedUpdated,
})

const migrationSchema = new Schema<MigrationSchema>({
  version: RequiredNumber,
  ...CreatedUpdated,
})

const globalVariablesSchema = new Schema<GlobalVariablesSchema>({
  name: RequiredString,
  type: {
    type: String,
    enum: GlobalVariablesTypeEnum,
    required: true,
  },
  value: Schema.Types.Mixed,
  botAmount: { type: Number, default: 0 },
  userId: RequiredString,
  ...CreatedUpdated,
})

const hedgeComboBotSchema = new Schema<HedgeBotSchema>({
  share: Boolean,
  shareId: String,
  paperContext: Boolean,
  profitByAssets,
  showErrorWarning: Boolean,
  status: { type: String, enum: BotStatusEnum },
  statusReason: String,
  userId: String,
  uuid: String,
  workingShift,
  profit,
  symbol: Map<string, typeof Symbols>,
  stats: botStats,
  symbolStats: botSymbolsStats,
  flags: [String],
  bots: [{ type: Schema.Types.ObjectId, ref: collections.comboBot }],
  initialBalances: {
    long: multiAsset,
    short: multiAsset,
  },
  currentBalances: {
    long: multiAsset,
    short: multiAsset,
  },
  assets: {
    long: {
      used: multiAsset,
      required: multiAsset,
    },
    short: {
      used: multiAsset,
      required: multiAsset,
    },
  },
  isDeleted: Boolean,
  deleteTime: Number,
  sharedSettings: {
    useTp: Boolean,
    useSl: Boolean,
    slPerc: String,
    tpPerc: String,
    comboSlLimit: Boolean,
    comboTpLimit: Boolean,
    comboTpBase: { type: String, enum: ComboTpBase },
    dealCloseConditionSL: { type: String, enum: CloseConditionEnum },
    dealCloseCondition: { type: String, enum: CloseConditionEnum },
  },
  cost: Number,
  ...CreatedUpdated,
})

const hedgeDcaBotSchema = new Schema<HedgeBotSchema>({
  paperContext: Boolean,
  profitByAssets,
  showErrorWarning: Boolean,
  status: { type: String, enum: BotStatusEnum },
  statusReason: String,
  userId: String,
  uuid: String,
  workingShift,
  profit,
  symbol: Map<string, typeof Symbols>,
  stats: botStats,
  symbolStats: botSymbolsStats,
  flags: [String],
  bots: [{ type: Schema.Types.ObjectId, ref: collections.dcaBot }],
  initialBalances: {
    long: multiAsset,
    short: multiAsset,
  },
  currentBalances: {
    long: multiAsset,
    short: multiAsset,
  },
  assets: {
    long: {
      used: multiAsset,
      required: multiAsset,
    },
    short: {
      used: multiAsset,
      required: multiAsset,
    },
  },
  isDeleted: Boolean,
  deleteTime: Number,
  sharedSettings: {
    useTp: Boolean,
    useSl: Boolean,
    slPerc: String,
    tpPerc: String,
    comboSlLimit: Boolean,
    comboTpLimit: Boolean,
    comboTpBase: { type: String, enum: ComboTpBase },
    dealCloseConditionSL: { type: String, enum: CloseConditionEnum },
  },
  cost: Number,
  ...CreatedUpdated,
})

const brokerCodes = new Schema<BrokerCodesSchema>({
  exchange: {
    type: String,
    enum: ExchangeEnum,
  },
  zone: {
    type: String,
    default: null,
    sparse: true,
  },
  code: String,
})

const streamWatchdogConfig = new Schema<StreamWatchdogConfigSchema>({
  status: { type: String, enum: StreamWatchdogConfigStatusEnum },
  type: { type: String, enum: StreamWatchdogConfigTypeEnum },
  ...CreatedUpdated,
})

/** Portfolio-snapshot Mongo TTL in seconds. Env-driven (SNAPSHOT_MONGO_TTL_DAYS,
 *  default 365d): cloud sets a thin buffer (e.g. 7) once the ClickHouse mirror
 *  serves long history; self-hosted / unset keeps the full 12 months in Mongo. */
export const snapshotMongoTtlSeconds = (): number => {
  const days = Number(process.env.SNAPSHOT_MONGO_TTL_DAYS)
  const safe = Number.isFinite(days) && days > 0 ? days : 365
  return Math.round(safe * 24 * 3600)
}

export const registerIndexes = () => {
  brokerCodes.index({ exchange: 1, zone: 1 }, { unique: true })

  reconcileSweepSchema.index({ created: -1 })
  reconcileSweepSchema.index({ exchangeUUID: 1, created: -1 })
  // Retain ~90 days of catches; bounds growth without manual cleanup.
  reconcileSweepSchema.index({ created: 1 }, { expireAfterSeconds: 7776000 })

  quantRulesEventSchema.index({ userId: 1, created: -1 })
  quantRulesEventSchema.index({ until: -1 })
  // Retain ~90 days of cooldown events; bounds growth without manual cleanup.
  quantRulesEventSchema.index({ created: 1 }, { expireAfterSeconds: 7776000 })

  userProfitByHour.index({ userId: 1 })

  backtestRequest.index({ userid: 1 })

  storeFilesSchema.index({ userId: 1 })

  botEventSchema.index({ botId: 1 })

  // TTL indexes (created on prod 2026-07-03; replace the weekly cleanDb
  // age-deletes). Expiry now runs continuously instead of a weekly bulk delete.
  botEventSchema.index({ created: 1 }, { expireAfterSeconds: 2592000 }) // 30d
  rateSchema.index({ created: 1 }, { expireAfterSeconds: 2592000 }) // 30d
  // Portfolio snapshots. Retention is env-driven (SNAPSHOT_MONGO_TTL_DAYS,
  // default 365) so cloud — which mirrors the long history to ClickHouse — can
  // set a thin 7-day hot buffer, while self-hosted (flag unset) keeps the full
  // 12 months in Mongo. NOTE: mongoose does NOT alter an existing TTL index's
  // expireAfterSeconds; a change here needs the collMod migration to converge a
  // deployed collection (phase4-snapshots-clickhouse.md §8).
  snapshotsSchema.index(
    { created: 1 },
    { expireAfterSeconds: snapshotMongoTtlSeconds() },
  )

  balancesSchema.index({ userId: 1 })

  dcaBacktestingResult.index({ userId: 1 })
  dcaBacktestingResult.index({ shareId: 1 })

  gridBacktestingResult.index({ userId: 1 })
  gridBacktestingResult.index({ shareId: 1 })

  comboBacktestingResult.index({ userId: 1 })
  comboBacktestingResult.index({ shareId: 1 })

  hedgeComboBacktestingResult.index({ userId: 1 })
  hedgeComboBacktestingResult.index({ shareId: 1 })

  hedgeDCABacktestingResult.index({ userId: 1 })
  hedgeDCABacktestingResult.index({ shareId: 1 })

  comboTransactionSchema.index({ userId: 1 })
  // Bot-engine per-bot transaction load (botId far more selective than userId).
  comboTransactionSchema.index({ botId: 1, userId: 1 })

  botMessageSchema.index({
    userId: 1,
  })

  botMessageSchema.index({
    userId: 1,
    botId: 1,
    subType: 1,
  })
  // Bot-error bulk soft-delete filters (botId, isDeleted) with a residual
  // subType:{$ne}; the userId-leading indexes above can't serve a botId-first
  // predicate. botId is write-once (static); isDeleted is one-way/low-cardinality.
  botMessageSchema.index({ botId: 1, isDeleted: 1 })

  botSchema.index({ userId: 1 })
  // Bot-list resolvers filter by userId (+optional status) and default-sort by
  // {created:-1}; compound indexes let Mongo serve the sort from the index
  // instead of an in-memory sort over all of a user's bots.
  botSchema.index({ userId: 1, status: 1, created: -1 })
  botSchema.index({ userId: 1, created: -1 })

  comboBotSchema.index({ userId: 1 })
  comboBotSchema.index({ userId: 1, status: 1, created: -1 })
  comboBotSchema.index({ userId: 1, created: -1 })

  comboDealSchema.index({ userId: 1 })
  comboDealSchema.index({ botId: 1 })

  comboMinigrid.index({ botId: 1 })

  comboProfitSchema.index({ userId: 1 })

  dcaBotSchema.index({ userId: 1 })
  dcaBotSchema.index({ userId: 1, status: 1, created: -1 })
  dcaBotSchema.index({ userId: 1, created: -1 })
  // Webhook path looks bots up by uuid (write-once/static) — was a COLLSCAN.
  dcaBotSchema.index({ uuid: 1 })

  hedgeComboBotSchema.index({ userId: 1 })
  hedgeComboBotSchema.index({ userId: 1, status: 1, created: -1 })
  hedgeComboBotSchema.index({ userId: 1, created: -1 })
  hedgeDcaBotSchema.index({ userId: 1 })
  hedgeDcaBotSchema.index({ userId: 1, status: 1, created: -1 })
  hedgeDcaBotSchema.index({ userId: 1, created: -1 })

  dcaDealSchema.index({ userId: 1 })
  dcaDealSchema.index({ botId: 1 })
  // Deals list (find({userId,status:'open',...}).sort({createTime:-1})): partial
  // index on open deals only serves the sort directly and stays tiny. createTime
  // is write-once (static); membership churns only on the open->closed transition.
  dcaDealSchema.index(
    { userId: 1, createTime: -1 },
    { partialFilterExpression: { status: 'open' } },
  )

  favoritePairsSchema.index({ userId: 1 })

  favoriteIndicatorsSchema.index({ userId: 1 })

  feesSchema.index({ userId: 1 })

  orderSchema.index({ userId: 1 })
  orderSchema.index({ botId: 1 })

  // Fill-failsafe resting-order lookup (src/fillFailsafe/registry.ts getOrdersFromDb).
  // Without this the query COLLSCANs all ~16M orders every FF_ORDERS_REFRESH_MS (30s):
  // measured on prod 2026-07-17 at p50 6.5s, 18.5M docsExamined -> 101 returned, and
  // 66% of ALL slow-query time on the database.
  //
  // PARTIAL on purpose. `status` is MUTABLE, and indexing mutable order fields
  // regressed writes badly once before (2026-07 audit), because the entry MOVES on
  // every change. Here `status` is only in the partialFilterExpression, never in the
  // key: it decides MEMBERSHIP of a tiny index (~101 resting orders) rather than
  // POSITION in a 16M-entry one, and an entry simply leaves when the order fills.
  // Validated on a throwaway mongod 8.0.26 (matching prod) before shipping:
  // $in IS supported in partialFilterExpression on 8.0 and the planner selects this
  // index; 50 entries / 20KB vs 20,050 / 242KB for a plain {status,type,created}.
  orderSchema.index(
    { created: 1 },
    {
      name: 'fillFailsafe_resting',
      partialFilterExpression: {
        status: { $in: ['NEW', 'PARTIALLY_FILLED'] },
        type: 'LIMIT',
      },
    },
  )

  pairsSchema.index({ exchange: 1 })

  paperTrades.index({ order: 1 })

  snapshotsSchema.index({ userId: 1 })

  transactionSchema.index({ userId: 1 })
  // Bot-engine per-bot transaction load (botId far more selective than userId).
  transactionSchema.index({ botId: 1, userId: 1 })

  userPeriod.index({ userId: 1 })

  botProfitChart.index({ botId: 1 })

  feesSchema.index({ userId: 1, exchangeUUID: 1 })

  snapshotsPerExchangeSchema.index({ userId: 1 })

  snapshotsPerExchangeSchema.index({ uuid: 1 })
}

const schema = {
  globalVariables: globalVariablesSchema,
  user: userSchema,
  botEvent: botEventSchema,
  reconcileSweep: reconcileSweepSchema,
  quantRulesEvent: quantRulesEventSchema,
  favoritePairs: favoritePairsSchema,
  favoriteIndicators: favoriteIndicatorsSchema,
  bot: botSchema,
  order: orderSchema,
  transaction: transactionSchema,
  botMessage: botMessageSchema,
  rate: rateSchema,
  pair: pairsSchema,
  fee: feesSchema,
  balance: balancesSchema,
  snapshot: snapshotsSchema,
  dcaBot: dcaBotSchema,
  comboBot: comboBotSchema,
  comdoDeal: comboDealSchema,
  comdoProfit: comboProfitSchema,
  comboMinigrid: comboMinigrid,
  comboTransaction: comboTransactionSchema,
  dcaDeal: dcaDealSchema,
  backtest: dcaBacktestingResult,
  gridBacktest: gridBacktestingResult,
  userPeriod: userPeriod,
  paperOrders,
  paperPositions,
  paperUser,
  comboBacktest: comboBacktestingResult,
  paperHedge,
  paperLeverage,
  paperWallets,
  paperTrades,
  storeFiles: storeFilesSchema,
  dcaBacktestRequest: backtestRequest,
  comboBacktestRequest: backtestRequest,
  gridBacktestRequest: backtestRequest,
  botProfitChart,
  userProfitByHour,
  migration: migrationSchema,
  hedgeComboBotSchema,
  hedgeDcaBotSchema,
  brokerCodes,
  hedgeComboBacktest: hedgeComboBacktestingResult,
  hedgeDcaBacktest: hedgeDCABacktestingResult,
  snapshotsPerExchange: snapshotsPerExchangeSchema,
  streamWatchdogConfig,
}

export default schema
