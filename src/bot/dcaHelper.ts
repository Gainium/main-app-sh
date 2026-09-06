import Big from 'big.js'
import { v4 } from 'uuid'
import type DB from '../db'
import {
  OrderSideEnum,
  StatusEnum,
  BotStatusEnum,
  MessageTypeEnum,
  TypeOrderEnum,
  DCADealStatusEnum,
  OrderTypeEnum,
  StrategyEnum,
  StartConditionEnum,
  BotType,
  CloseDCATypeEnum,
  ExchangeEnum,
  IndicatorEnum,
  rsiValueEnum,
  rsiValue2Enum,
  IndicatorStartConditionEnum,
  TradingviewAnalysisConditionEnum,
  TradingviewAnalysisSignalEnum,
  DCATypeEnum,
  MAEnum,
  OrderSizeTypeEnum,
  BBCrossingEnum,
  SRCrossingEnum,
  TrailingModeEnum,
  IndicatorAction,
  CloseConditionEnum,
  TerminalDealTypeEnum,
  IndicatorSection,
  BOT_STATUS_EVENT,
  BotMarginTypeEnum,
  PositionSide,
  ExcludeDoc,
  StochRangeEnum,
  DCAConditionEnum,
  BotStartTypeEnum,
  ECDTriggerEnum,
  DivTypeEnum,
  TrendFilterOperatorEnum,
  STConditionEnum,
  timeIntervalMap,
  SettingsIndicators,
  CooldownOptionsEnum,
  BotParentIndicatorEventDto,
  BotParentUnsubscribeIndicatorEventDto,
  PCConditionEnum,
  IndicatorsData,
  DynamicPriceFilterPriceTypeEnum,
  LastPricesPerSymbols,
  PairPrioritizationEnum,
  BotStats,
  BotSymbolsStats,
  ComboTpBase,
  ppValueEnum,
  ppValueTypeEnum,
  Symbols,
  RiskSlTypeEnum,
  DynamicArPrices,
  ScaleDcaTypeEnum,
  BotFlags,
  BaseSlOnEnum,
  RangeType,
  IndicatorsLogicEnum,
  Sizes,
  BotParentProcessStatsEventDtoDcaCombo,
  rabbitIndicatorsKey,
  setToRedisDelay,
  DCADealFlags,
  AddFundsTypeEnum,
  DCAVolumeType,
  OrderStatusType,
  DcaVolumeRequiredChangeRef,
  DynamicPriceFilterDirectionEnum,
  DCValueEnum,
  ActionsEnum,
  DCACustom,
  MultiTP,
  DCADealsSchema,
  OBFVGRefEnum,
  OBFVGValueEnum,
  RRSlTypeEnum,
  ComboBotSchema,
  LWConditionEnum,
  DealStartBlock,
} from '../../types'
import { observedFeeSplit } from './orderFee'
import { MathHelper } from '../utils/math'
import MainBot, {
  notEnoughErrors,
  isDefinitiveOrderNotFound,
  reconcileUnresolvedWarn,
  QUANT_RULES_RETRY_BUDGET_ASAP,
} from './main'
import { underfilledTpQty } from './dca/partialTp'
import utils from '../utils'
import {
  gt,
  lt,
  lte,
  gte,
  eq,
  OBFVGResult,
  LongWickResult,
  isInSession,
} from '@gainium/indicators'
import { IdMute, IdMutex } from '../utils/mutex'
import {
  DCABotSchema,
  PriceMessage,
  Order,
  CleanDCADealsSchema,
  Grid,
  ExecutionReport,
  IndicatorHistory,
  IndicatorConfig,
  MAResult,
  UnPromise,
  AddFundsSettings,
  PositionInBot,
  DealStopLossCombo,
  CleanMainBot,
  SettingsIndicatorGroup,
  CleanComboDealsSchema,
  DCACloseTriggerEnum,
} from '../../types'
import { ExchangeIntervals } from '../../types'
import { convertDCABot, convertComboBot, positionLeftOpen } from './utils'
import { dealRefPrice, withoutUnusableAvgPrice } from './dealRefPrice'
import DCAUtils from './dca/utils'
import { grossEntryVolume, resolveBaseOrderQty } from './dca/baseOrderQty'
import { tpPriceDisplacement, worstFee } from './dca/tpFees'
import {
  buyAndHoldOutcome,
  carryForwardBenchmark,
} from './dca/buyAndHoldBenchmark'
import {
  dealCloseEventDescription,
  dealLeftOpenSize,
  leftOpenPositionMessage,
} from './dca/dealOutcome'
import {
  classifyTpCloseAttempt,
  tpCloseBlockedMessage,
} from './dca/tpCloseOutcome'
import {
  dealPositionGoneMessage,
  reconcileDealAgainstVenue,
} from './dca/positionReconcile'
import { shouldRearmTpTargets } from './dca/multiTpCompletion'
import {
  reconcileTpCoverage,
  tpCoverageDriftWarn,
  trackedPosition,
  type LiveTpOrder,
  type TpCoverageProbe,
} from './dca/tpCoverageReconcile'
import RetryBackoff from './retryBackoff'
import Bot from './index'
import { getIntersection } from '../utils/set'
import { removePaperFormExchangeName } from '../exchange/helpers'
import logger from '../utils/logger'
import { botProfitChartDb, dcaBotDb, dcaDealsDb } from '../db/dbInit'
import { RunWithDelay } from '../utils/delay'
import { DealStats } from './worker/statsService'
import RedisClient from '../db/redis'
import {
  BandsResult,
  DIVResult,
  PCResult,
  PivotResult,
  PriorPivotResult,
  QFLResult,
  SuperTrendResult,
} from '@gainium/indicators'
import { botMonitor, CalculateDCALiveStatsParams } from './botMonitor'
import { getSubTypeBehavior } from './errorRulesCache'
import {
  notEnoughBalanceNewDeal,
  standingConditionKey,
  tpCoverageDrift,
} from './conditionLatch'

export type PercentileResult = {
  percentile?: number
  value: number
}

const { sleep, checkNumber, mapToArray } = utils

/**
 * Arms the take-profit coverage CORRECTION (issue #696, spec
 * `013.tp-coverage-drift-after-partial-tp` §4.2).
 *
 * Detection is unconditional and only ever logs. This flag gates the part that
 * cancels a resting order and places a new one on a live venue with real money,
 * so it is deliberately opt-in: deploying the fix must not, by itself, start
 * trading against anyone's account. An operator arms it once, deliberately,
 * having read the `tp-coverage drift` lines the detection pass emits.
 */
const tpCoverageRepairArmed = /^(1|true|yes)$/i.test(
  process.env.BOT_TP_COVERAGE_REPAIR ?? '',
)

export type FullDeal<Deal extends CleanDCADealsSchema> = {
  deal: Deal
  initialOrders: Grid[]
  currentOrders: Grid[]
  previousOrders: Grid[]
  closeBySl: boolean
  notCheckSl: boolean
  closeByTp: boolean
}

const mutex = new IdMutex()

const mutexIndicators = new IdMutex(100)

const mutexConcurrently = new IdMutex(30)

const mutexDCAOrdersByIndicator = new IdMutex(100)

const mutexPriceConcurrently = new IdMutex(30)

const mutexOpenDealBySignal = new IdMutex(15)

/**
 * How long a deal waits before re-attempting a market take-profit close the
 * venue has REFUSED as un-reducible (`Futures position` — "Reduce order is
 * rejected", "current position is zero…"). `checkTPLevel` fires on the price
 * tick, so without this the identical reduce-only order goes back to the venue
 * roughly twice a second for as long as the divergence lasts.
 *
 * Deliberately a shorter ladder than the 5 min → 1 h siblings (`nb`, `cr`,
 * `er`): this one gates a CLOSE, and a position-sync blip that clears must not
 * cost the user a quarter-hour of unrealised profit. 1 → 2 → 4 → 8 → 15 min
 * takes the observed 1031 attempts in ~2 h down to 6, and any accepted close
 * clears it outright.
 */
const tpCloseBackoff = new RetryBackoff({
  namespace: 'tpc',
  minMs: 60 * 1000,
  maxMs: 15 * 60 * 1000,
})

/**
 * How often a deal that reached its take profit and failed to close may ask the
 * venue whether it still holds the position (spec 005 / issue #630).
 *
 * A throttle, not a rejection ladder: the price tick fires ~2/s per symbol and a
 * positions round trip must not ride it. Wider than `tpCloseBackoff` because
 * nothing is waiting on the answer — a deal whose position really is gone has
 * already been gone for months, and five minutes more costs nothing, while a
 * position that is merely mid-sync gets several chances to reappear before
 * anything is settled.
 */
const positionProbeBackoff = new RetryBackoff({
  namespace: 'dpp',
  minMs: 5 * 60 * 1000,
  maxMs: 60 * 60 * 1000,
})

/**
 * Exchange rejections that mean "this order's notional is under the venue
 * minimum". They route the order into the slippage-retry ladder, which on a
 * combo bot terminates in the `count === slippageRetry` branch of
 * `closeDealById` that books the deal closed without an order — the only
 * possible resolution when what is left to close is a residue the venue will
 * never accept an order for. Anything not listed here falls through to the
 * generic handler, which classifies it as `Order params` and stops the bot.
 */
const notionalReasons = [
  // KuCoin
  'The order funds should be more than',
  // Binance NOTIONAL / MIN_NOTIONAL filter
  'NOTIONAL',
  // Hyperliquid — "order must have minimum value of $10. asset=122"
  'must have minimum value of',
]

/**
 * Exchange rejections that mean "there is nothing left to close" — the position
 * is already flat (or on the other side), so a reduce-only closing order can
 * never be accepted. Retrying is pointless; the deal must be booked closed.
 */
const positionAlreadyClosedReasons = [
  // Hyperliquid
  'reduce only order would increase position',
  // Binance -2022
  'ReduceOnly Order is rejected',
  // Bybit
  'current position is zero, cannot fix reduce-only order qty',
  'reduce-only order has same side with current position',
  // OKX 51169 / 51023
  "You don't have any positions in this contract",
  'Position does not exist',
  // dYdX — camelCase; matched via the normalisation in
  // isPositionAlreadyClosedReason, not literally
  'wouldNotReducePosition',
  'no position to close',
]

/**
 * Exchange rejections that mean "this book is only accepting LIMIT orders right
 * now". Coinbase puts a product into limit-only mode during a volatility
 * auction; a MARKET order can never be accepted while that holds, but a LIMIT
 * one still can. So this is not a fatal entry error — the base order must fall
 * BACK to limit rather than be abandoned. Kept deliberately narrow: post-only
 * rejections ("order would immediately match and take") are a *limit* order
 * being refused and must NOT match here, or the limit fallback would loop.
 */
const limitOnlyReasons = [
  // Coinbase Advanced Trade — observed verbatim as
  // "Orderbook is in limit only mode - please use limit order type".
  // Matched via normalizeReason, so "limit-only" spells the same.
  'limit only',
]

/**
 * Venues word the same condition as prose or as a camelCase/hyphenated code
 * ("no position to close" vs "wouldNotReducePosition", "limit only mode" vs
 * "limit-only"), so compare on letters and digits only — one list entry then
 * covers every spelling.
 */
const normalizeReason = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const maxTimeout = 2 ** 31 - 1

// Helper function to apply decorators to methods
/* export function applyMethodDecorator(
  decorator: MethodDecorator,
  target: any,
  propertyKey: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey)
  if (descriptor) {
    decorator(target, propertyKey, descriptor)
  }
} */

type LocalIndicators = {
  uuid: string
  id: string
  room: string
  status: boolean
  statusTo?: number
  statusSince?: number
  numberOfSignals?: number
  data: boolean
  history: IndicatorHistory[]
  symbol: string
  key: string
  action: IndicatorAction
  maCross: boolean
  childIndicator: string
  parentIndicator: string
  section?: IndicatorSection
  interval: ExchangeIntervals
  cb?: (_msg: string) => void
  groupId: string
  is1d: boolean
}

type TrailingDeal = {
  trailingTp: boolean
  skipTp: boolean
  trailingSl: boolean
  skipSl: boolean
  trailingTpPrice: number
}

type DealIndicatorUnpnlVal = {
  min: number
  max: number
}

function createDCABotHelper<
  Schema extends DCABotSchema = DCABotSchema,
  Deal extends DCADealsSchema = DCADealsSchema,
  TBaseClass extends new (...args: any[]) => MainBot<Schema> = new (
    ...args: any[]
  ) => MainBot<Schema>,
>(BaseClass?: TBaseClass) {
  const ActualBaseClass = (BaseClass || MainBot) as TBaseClass extends new (
    ...args: any[]
  ) => infer T
    ? new (
        id: string,
        exchange: ExchangeEnum,
        log?: boolean,
        serviceRestart?: boolean,
        ignoreStats?: boolean,
      ) => T
    : new (
        id: string,
        exchange: ExchangeEnum,
        log?: boolean,
        serviceRestart?: boolean,
        ignoreStats?: boolean,
      ) => MainBot<Schema>

  class DCABotHelper extends ActualBaseClass {
    indicatorTimeout = 60 * 1000
    indicatorRoomConfigMap: Map<string, Set<string>> = new Map()
    indicatorConfigIdMap: Map<string, string> = new Map()
    indicatorSubscribedRooms: Set<string> = new Set()
    indicatorGroupsToUse: SettingsIndicatorGroup[] = []
    botProfitDb = botProfitChartDb
    /** Bot deals */
    deals: Map<string, FullDeal<ExcludeDoc<Deal>>> = new Map()
    /** Map status to deal */
    dealStatusMap: Map<DCADealStatusEnum, Set<string>> = new Map()
    /** Map symbol to deal */
    dealSymbolMap: Map<string, Set<string>> = new Map()
    /** DB instance to work with deals */
    dealsDb: DB<Deal>
    /** Close after TP filled */
    closeAfterTpFilled: boolean
    /** Timer for time base trigger */
    timer: NodeJS.Timeout | null
    /** Timeout first time */
    startTimeoutTime: Map<string, number>
    /** Indicators */
    indicators: Map<string, LocalIndicators> = new Map()
    indicatorsIntervalActionMap: Map<string, number> = new Map()
    /** indicator actions */
    indicatorActions = {
      startDeal: new Map<string, number>(),
      stopBot: new Map<string, number>(),
      startBot: new Map<string, number>(),
      closeDealTp: new Map<string, number>(),
      closeDealSl: new Map<string, number>(),
      dcaOrder: new Map<string, number>(),
    }
    dcaOrdersBySignal = new Set<string>()
    /** Processed filled list */
    processedFilled: Map<string, Set<string>> = new Map()
    /** Processed deal update list */
    dealUpdateOrders: Map<string, Set<string>> = new Map()
    feeProcessed: Map<string, Set<string>> = new Map()
    /** Lock sl check */
    lockSLCheck = false
    /** Pending deals */
    pendingDeals = 0
    pendingDealsOver = 0
    pendingDealsUnder = 0
    /** Pending deals per pair */
    pendingDealsPerPair: Map<string, number> = new Map()
    /** Last indicators data map */
    lastIndicatorsDataMap: Map<string, number> = new Map()
    /** Initial all deals value */
    allDeals = 0
    /** Allow to place orders by deal*/
    allowToPlaceOrders: Map<string, boolean> = new Map()
    /** Open new deal timer */
    openNewDealTimer: Map<string, NodeJS.Timeout> = new Map()
    /** Close deal timers */
    closeDealTimer: Map<string, NodeJS.Timeout | null> = new Map()

    blockCheck = false

    utils: DCAUtils = new DCAUtils()
    stopList: Set<string> = new Set()

    pendingOrdersList: Map<string, Grid[]> = new Map()
    runAfterRestartQueue: (() => Promise<void>)[] = []
    ignoreStats = false
    saveIndicatorTimer: NodeJS.Timeout | null = null
    saveIndicatorTimeout = 20 * 1000
    openAtStartTriggered = false
    checkIndicatorsQueue: Map<
      string,
      {
        data: IndicatorHistory[]
        uuid: string
        symbol: string
        is1d?: boolean
      }[]
    > = new Map()
    equityTimer: NodeJS.Timeout | null = null
    sessionCheckTimer: NodeJS.Timeout | null = null
    statsTimer: NodeJS.Timeout | null = null
    lastStatsCheck = 0
    indicatorCheckTimers: { [x: string]: NodeJS.Timeout | null | undefined } =
      {}
    indicatorCheckTimersFired: {
      [x: string]: boolean | undefined
    } = {}
    coinsMemory: Set<string> = new Set()
    coinsLastRequest = 0
    relativeCoinsMemory: Set<string> = new Set()
    relativeCoinsLastRequest = 0
    coinsTimeout = 60 * 60 * 1000
    ignoreRestartStats = false
    saveIndicators = false
    slippageRetry = 5
    profitBaseDealMap: Map<string, boolean> = new Map()
    leverageMap: Map<string, number> = new Map()
    baseSlOnMap: Map<string, BaseSlOnEnum> = new Map()
    minigridDealMap: Map<string, Set<string>> = new Map()
    combo = false
    scaleAr = false
    useCompountReduce = false
    tpAr = false
    isMonitoring = false
    useMonitoring = false
    slAr = false
    isLong = true
    dealTimersMap: Map<
      string,
      {
        limitTimer: NodeJS.Timeout | null
        enterMarketTimer: NodeJS.Timeout | null
      }
    > = new Map()
    dealsForMoveSl: Map<string, number> = new Map()
    dealsForTrailing: Map<string, TrailingDeal> = new Map()
    dealsForStopLoss: Map<string, number> = new Map()
    dealsForIndicatorUnpnl: Map<string, DealIndicatorUnpnlVal> = new Map()
    dealsForStopLossCombo: Map<string, DealStopLossCombo> = new Map()
    dealsDCALevelCheck: Map<string, number> = new Map()
    dealsDCAByMarket: Map<string, number> = new Map()
    dealsByMarketProcessing: Set<string> = new Set()
    dealsForTPLevelCheck: Map<string, number> = new Map()
    startSent = false
    stopSent = false
    private defaultUnpnl = 2
    private defaultUnpnlCondition = IndicatorStartConditionEnum.gt
    private afterIndicatorsConnected: (() => void | Promise<void>)[] = []
    ordersInBetweenUpdates: Set<string> = new Set()
    private pendingClose: Set<string> = new Set()
    /**
     * Prepare DB instaces
     *
     * Connect to socket io streams
     *
     * Set initial values
     * @param {string} id Id of the bot
     * @param {boolean} log Enable/disable logging
     */
    constructor(
      id: string,
      exchange: ExchangeEnum,
      log = true,
      serviceRestart = false,
      ignoreStats = false,
    ) {
      super(id, exchange, log)
      this.ignoreStats = ignoreStats
      this.db = dcaBotDb
      //@ts-ignore
      this.dealsDb = dcaDealsDb
      this.math = new MathHelper()
      this.runAfterIndicatorsConnected =
        this.runAfterIndicatorsConnected.bind(this)
      this.priceUpdateCallback = this.priceUpdateCallback.bind(this)
      this.processFilledOrder = this.processFilledOrder.bind(this)
      this.processPartiallyFilledOrder =
        this.processPartiallyFilledOrder.bind(this)
      this.processCanceledOrder = this.processCanceledOrder.bind(this)
      this.processNewOrder = this.processNewOrder.bind(this)
      this.processLiquidationOrder = this.processLiquidationOrder.bind(this)
      this.sortQueue = this.sortQueue.bind(this)
      this.botType = BotType.dca
      this.cbFunctions = {
        sort: this.sortQueue,
        onFilled: this.processFilledOrder,
        onPartiallyFilled: this.processPartiallyFilledOrder,
        onCanceled: this.processCanceledOrder,
        onNew: this.processNewOrder,
        onLiquidation: this.processLiquidationOrder,
      }
      this.closeAfterTpFilled = false
      this.timer = null
      this.orderLimitRepositionTimeout = 10000
      this.enterMarketTimeout = 35000
      this.startTimeoutTime = new Map()
      this.openDealByTimer = this.openDealByTimer.bind(this)
      this.startTimeBasedTrigger = this.startTimeBasedTrigger.bind(this)
      this.checkIndicatorConditions = this.checkIndicatorConditions.bind(this)
      this.checkTPOrder = this.checkTPOrder.bind(this)
      this.checkBaseOrder = this.checkBaseOrder.bind(this)
      this.serviceRestart = serviceRestart
      this.callbackAfterUserStream = this.checkOrdersAfterReconnect.bind(this)
      this.closeByTimer = this.closeByTimer.bind(this)
      this.setCloseByTimer = this.setCloseByTimer.bind(this)
      this.priceTimerFn = this.priceTimerFn.bind(this)
      this.openDealAfterTimer = this.openDealAfterTimer.bind(this)
      this.indicatorCheckTimeout = this.indicatorCheckTimeout.bind(this)
      this.indicatorDataCb = this.indicatorDataCb.bind(this)
      this.indicatorDataCbRedis = this.indicatorDataCbRedis.bind(this)
      this.triggerMoveSl = this.triggerMoveSl.bind(this)
      this.triggerTrailing = this.triggerTrailing.bind(this)
      this.triggerStopLoss = this.triggerStopLoss.bind(this)
      this.isDealForStopLoss = this.isDealForStopLoss.bind(this)
      this.isDealForMoveSl = this.isDealForMoveSl.bind(this)
      this.isDealForTrailing = this.isDealForTrailing.bind(this)
    }

    removeDealByStatus(id: string) {
      for (const s of [...this.dealStatusMap.keys()]) {
        const get = this.dealStatusMap.get(s)
        if (get) {
          get.delete(id)
        }
      }
    }

    removeDealBySymbol(symbol: string, id: string) {
      const get = this.dealSymbolMap.get(symbol)
      if (get) {
        get.delete(id)
      }
    }

    setDealByStatus(status: DCADealStatusEnum, id: string) {
      if (!id) {
        return
      }
      this.removeDealByStatus(id)
      this.dealStatusMap.set(
        status,
        (this.dealStatusMap.get(status) ?? new Set()).add(id),
      )
    }

    setDealBySymbol(symbol: string, id: string) {
      if (!id) {
        return
      }
      this.removeDealBySymbol(symbol, id)
      this.dealSymbolMap.set(
        symbol,
        (this.dealSymbolMap.get(symbol) ?? new Set()).add(id),
      )
    }

    @RunWithDelay(
      (botId: string) => `${botId}setDealToRedis`,
      (_botId: string, restart: boolean) => setToRedisDelay * (restart ? 5 : 2),
    )
    setDealToRedis(_botId: string, _restart: boolean) {
      this.setToRedis('deals', [...this.deals.values()])
    }

    setDeal(deal: FullDeal<ExcludeDoc<Deal>>, save = true) {
      const key = `${deal.deal._id}`
      this.deals.set(key, deal)
      this.setDealByStatus(deal.deal.status, key)
      this.setDealBySymbol(deal.deal.symbol.symbol, key)
      if (save) {
        this.setDealToRedis(
          this.botId,
          this.serviceRestart && !this.secondRestart,
        )
      }
    }

    getDeal(key?: string) {
      if (!key) {
        return
      }
      return this.deals.get(key)
    }

    deleteDeal(id: string) {
      const key = `${id}`
      const get = this.deals.get(key)
      this.deals.delete(key)
      this.removeDealByStatus(key)
      if (get) {
        this.removeDealBySymbol(get.deal.symbol.symbol, key)
      }
    }

    /**
     * Put the venue's refusal of a deal's opening order ON the deal, or clear it
     * once the venue accepts one. Overrides the no-op on `MainBot`; inherited by
     * the combo and hedge bots, which extend this helper.
     *
     * Why the deal and not just the notification: a deal is written before its
     * base order reaches the exchange, so a refusal leaves it in `start` with no
     * orders. The bot-level warning that `handleErrors` raises names neither the
     * deal nor the symbol and is coalesced across hours, so the user staring at
     * a stuck deal has nothing connecting the two. An account-wide Binance
     * Quantitative Rules restriction stalled several of one account's deals this
     * way, and the exchange's own order history could not explain it either —
     * unsurprisingly, since the orders were never sent.
     *
     * Descriptive only: no status change, no error, no notification of its own.
     * The -4400 path must stay soft (re-hitting Binance escalates the penalty
     * L1 -> L2 -> L3, and the deferred retry is the self-heal), so this adds an
     * explanation to that state without turning it into an alarm.
     */
    /**
     * Re-run the deal-opening sequence for a deal whose base order a
     * Quantitative Rules cooldown refused. Overrides the no-op on `MainBot`;
     * inherited by the combo and hedge bots, which extend this helper.
     *
     * Calls `placeBaseOrder` rather than re-sending the refused order, because
     * the send is only part of what opening a deal does — see `retryDealStart`
     * on `MainBot`. The refused order was already deleted and marked CANCELED
     * by the caller, so this mints a fresh one, exactly as the periodic
     * `checkOrders` sweep does for the same deals.
     *
     * Every guard that makes this safe lives in `placeBaseOrder` itself: it
     * returns early on a deal that has since opened, on a deal that already
     * holds an active base order, and on a bot that is no longer running. A
     * retry that races the sweep therefore cannot open a second position.
     */
    /**
     * Only an ASAP deal may have its opening order re-sent later.
     *
     * Every other start condition is a point in time: a TradingView webhook, an
     * indicator cross, a timer, a manual click. Re-sending one of those after a
     * Binance restriction lifts opens a trade the signal never described — the
     * price it referred to is minutes or hours gone — and each of those
     * re-sends is also a refused order, which is itself a Quantitative Rules
     * violation. They all have their own next trigger; it will fire when it
     * means to. ASAP carries no timing and the bot is meant to stay in a
     * position, so abandoning its open would strand the bot with no deals.
     */
    /**
     * Cancel a deal we have given up opening, so it stops occupying its
     * symbol's slot.
     *
     * Only ever touches a deal still in `start` — one that never reached the
     * venue and therefore holds no position. A deal that has opened, or that
     * has since been closed or cancelled, is left exactly as it is: this must
     * not become a path that can cancel real positions.
     *
     * `closeDealById` already does the right thing for a `start` deal (marks it
     * cancelled, and a deal that never traded carries zero profit, so the
     * accounting paths are unaffected). Reusing it keeps this out of the
     * business of mutating deal status by hand.
     */
    protected override async releaseBlockedDeal(order: Order): Promise<void> {
      if (!order.dealId) {
        return
      }
      const fullDeal = this.getDeal(order.dealId)
      if (!fullDeal) {
        return
      }
      if (fullDeal.deal.status !== DCADealStatusEnum.start) {
        this.handleLog(
          `Not releasing deal ${order.dealId}: status is ${fullDeal.deal.status}, not start`,
        )
        return
      }
      this.handleLog(
        `Releasing deal ${order.dealId} (${fullDeal.deal.symbol?.symbol}): its opening order was refused and will not be retried, so the deal is cancelled rather than left holding the pair`,
      )
      await this.closeDealById(
        this.botId,
        order.dealId,
        CloseDCATypeEnum.cancel,
        false,
      )
    }

    protected override async quantRulesRetryBudget(
      order: Order,
    ): Promise<number> {
      const fullDeal = order.dealId ? this.getDeal(order.dealId) : undefined
      const settings = await this.getAggregatedSettings(fullDeal?.deal)
      return settings.startCondition === StartConditionEnum.asap
        ? QUANT_RULES_RETRY_BUDGET_ASAP
        : 0
    }

    protected override async retryDealStart(order: Order): Promise<void> {
      const fullDeal = this.getDeal(order.dealId)
      if (!fullDeal) {
        this.handleLog(
          `Quantitative Rules deal re-open dropped for ${order.dealId}: deal is gone`,
        )
        return
      }
      const deal = fullDeal.deal
      if (deal.status !== DCADealStatusEnum.start) {
        this.handleLog(
          `Quantitative Rules deal re-open dropped for ${deal._id}: status is ${deal.status}`,
        )
        return
      }
      this.handleLog(
        `Quantitative Rules cooldown over for deal ${deal._id}. Place base order again`,
      )
      await this.placeBaseOrder(
        this.botId,
        deal.symbol.symbol,
        deal._id,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        deal.fixSize,
        undefined,
        deal.sizes,
        deal.orderSizeType,
      )
    }

    protected async markDealStartBlocked(
      order: Order,
      reason: string | null,
      cooldown?: {
        until?: number | null
        level?: number | null
        scope?: string | null
      },
    ): Promise<void> {
      const dealId = order.dealId
      // Only the OPENING order can leave a deal unstarted. A refused safety
      // order or take-profit is a different situation with a different remedy,
      // and the deal it belongs to is already open and visibly working.
      if (!dealId || order.typeOrder !== TypeOrderEnum.dealStart) {
        return
      }
      const fullDeal = this.getDeal(dealId)
      if (!fullDeal) {
        return
      }
      const deal = fullDeal.deal
      try {
        if (reason === null) {
          if (!deal.startBlocked) {
            return
          }
          delete deal.startBlocked
          await this.dealsDb.updateData(
            { _id: dealId } as any,
            {
              $unset: { startBlocked: 1 },
            } as any,
          )
        } else {
          // A deal past `start` has opened, so nothing about it is blocked —
          // whatever was refused belongs to a later stage of its life.
          if (deal.status !== DCADealStatusEnum.start) {
            return
          }
          const now = +new Date()
          const subType = this.getErrorSubType(reason)
          // Prefer the operator-configured wording for this subType, so the
          // deal reads the same as the notification for the same condition and
          // an admin can improve both without a deploy.
          const userMessage = getSubTypeBehavior(subType)?.userMessage
          const previous = deal.startBlocked
          // `since` and `attempts` describe one run of refusals for one cause.
          // A different cause is a new run, not a continuation of the old count.
          const continues = !!previous && previous.subType === subType
          const block: DealStartBlock = {
            reason: (userMessage || reason).slice(0, 500),
            subType,
            since: continues ? previous.since : now,
            lastAttempt: now,
            attempts: continues ? previous.attempts + 1 : 1,
          }
          if (cooldown?.until) {
            block.retryAfter = cooldown.until
          }
          if (cooldown?.scope) {
            block.scope = cooldown.scope
          }
          if (cooldown?.level) {
            block.level = cooldown.level
          }
          deal.startBlocked = block
          await this.dealsDb.updateData(
            { _id: dealId } as any,
            {
              $set: { startBlocked: block },
            } as any,
          )
        }
        this.setDeal(fullDeal, false)
        this.emit('bot deal update', deal)
      } catch (e) {
        // Never let bookkeeping break the order path — this is an explanation,
        // and an order that cannot be placed is worse than one that cannot be
        // explained.
        this.handleWarn(
          `markDealStartBlocked failed for deal ${dealId}: ${
            (e as Error)?.message ?? e
          }`,
        )
      }
    }

    getDealsByStatusAndSymbol({
      status,
      symbol,
    }: {
      symbol?: string | string[]
      status?: DCADealStatusEnum | DCADealStatusEnum[]
    }) {
      const statusIds: Set<string> = new Set()

      if (status) {
        for (const s of [status].flat()) {
          const getByStatus = this.dealStatusMap.get(s)
          if (getByStatus) {
            for (const id of getByStatus) {
              statusIds.add(id)
            }
          }
        }
      }

      const symbolIds: Set<string> = new Set()

      if (symbol) {
        for (const s of [symbol].flat()) {
          const getBySymbol = this.dealSymbolMap.get(s)
          if (getBySymbol) {
            for (const id of getBySymbol) {
              symbolIds.add(id)
            }
          }
        }
      }

      const ids =
        symbol && status
          ? getIntersection(symbolIds, statusIds)
          : symbol
            ? symbolIds
            : status
              ? statusIds
              : new Set<string>()

      const result: FullDeal<ExcludeDoc<Deal>>[] = []
      for (const id of ids) {
        const deal = this.deals.get(id)
        if (deal) {
          result.push(deal)
        }
      }
      return result
    }

    get allDealsData() {
      return [...this.deals.values()]
    }

    private indicatorDataCbRedis(room: string) {
      return (_msg: string) => {
        try {
          const msg = JSON.parse(_msg) as {
            data: IndicatorHistory[]
            price: number
            id1d?: boolean
          }
          const findRoom = this.indicatorRoomConfigMap.get(room)
          if (!findRoom) {
            return
          }
          for (const key of findRoom) {
            const response = key.split('@')
            this.indicatorDataCb(this.botId, {
              ...msg,
              responseParams: { uuid: response[0], symbol: response[1] },
            })
          }
        } catch (e) {
          this.handleErrors(
            `Catch error ${e}`,
            'indicatorDataCbRedis',
            '',
            false,
            false,
            false,
          )
        }
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}indicatorDataCb`)
    private async indicatorDataCb(
      _botId: string,
      msg: {
        data: IndicatorHistory[]
        price: number
        responseParams: { uuid: string; symbol: string }
        is1d?: boolean
      },
    ) {
      const settings = await this.getAggregatedSettings()

      let done = false
      if (
        settings.pairPrioritization === PairPrioritizationEnum.alphabetical &&
        settings.useMulti
      ) {
        const keyI = `${msg.responseParams.uuid}@${msg.responseParams.symbol}`
        const find = this.indicators.get(keyI)
        if (
          find &&
          find.action === IndicatorAction.startDeal &&
          this.pairs?.has(msg.responseParams.symbol)
        ) {
          const last = this.lastIndicatorsDataMap.get(keyI)
          const lastTime = [...msg.data].sort((a, b) => b.time - a.time)?.[0]
            ?.time
          const isNotLatest = last && lastTime && last >= lastTime
          if (
            !isNotLatest &&
            lastTime &&
            lastTime + timeIntervalMap[find.interval] > this.startTime
          ) {
            const key = `${find.action}@${find.interval}@${lastTime}`
            done = true
            const get = this.checkIndicatorsQueue.get(key) ?? []
            get.push({
              data: msg.data,
              uuid: find.uuid,
              symbol: find.symbol,
              is1d: msg.is1d,
            })
            if (
              get.length ===
              (this.indicatorsIntervalActionMap.get(
                `${find.interval}@${find.action}`,
              ) ?? 0)
            ) {
              const timer = this.indicatorCheckTimers[key]
              if (timer) {
                clearTimeout(timer)
              }
              delete this.indicatorCheckTimers[key]
              delete this.indicatorCheckTimersFired[key]
              this.checkIndicatorsQueue.delete(key)
              for (const d of get.sort((a, b) =>
                `${a.symbol}`.localeCompare(`${b.symbol}`),
              )) {
                this.checkIndicatorConditions(
                  this.botId,
                  d.uuid,
                  d.data,
                  d.symbol,
                  d.is1d,
                )
                await sleep(0)
              }
            } else {
              this.checkIndicatorsQueue.set(key, get)
              if (!this.indicatorCheckTimersFired[key]) {
                const timer = this.indicatorCheckTimers[key]
                if (timer) {
                  clearTimeout(timer)
                }
                this.indicatorCheckTimers[key] = setTimeout(
                  () => this.indicatorCheckTimeout(key),
                  30 * 1000,
                )
                this.indicatorCheckTimersFired[key] = false
              }
            }
          }
        }
      }
      if (
        !settings.pairPrioritization ||
        settings.pairPrioritization === PairPrioritizationEnum.random ||
        !done
      ) {
        this.checkIndicatorConditions(
          this.botId,
          msg.responseParams.uuid,
          msg.data,
          msg.responseParams.symbol,
          msg.is1d,
        )
      }
    }

    private async indicatorCheckTimeout(key: string) {
      this.indicatorCheckTimersFired[key] = true
      const get = this.checkIndicatorsQueue.get(key) ?? []
      delete this.indicatorCheckTimers[key]
      delete this.indicatorCheckTimersFired[key]
      for (const d of get.sort((a, b) =>
        `${a.symbol}`.localeCompare(`${b.symbol}`),
      )) {
        this.checkIndicatorConditions(this.botId, d.uuid, d.data, d.symbol)
        await sleep(0)
      }
      this.checkIndicatorsQueue.delete(key)
    }

    async profitBase(deal?: ExcludeDoc<Deal>) {
      const key = deal?._id ?? 'bot'
      if (this.profitBaseDealMap.has(key)) {
        return this.profitBaseDealMap.get(key)
      }
      const settings = await this.getAggregatedSettings(deal)
      const result =
        (this.futures && this.coinm) ||
        (!this.futures && settings.profitCurrency === 'base')
      this.profitBaseDealMap.set(key, result)
      return result
    }

    async getAggregatedSettings(deal?: ExcludeDoc<Deal>) {
      const botSettings = await this.replaceBotSettings(
        (this.data?.settings ?? {}) as Schema['settings'],
      )

      const settings = {
        ...botSettings,
        ...(deal?.settings ?? {}),
      }
      return {
        ...settings,
        useFixedTPPrices:
          (this.botType === BotType.dca &&
            settings.type === DCATypeEnum.terminal &&
            settings.useTp &&
            settings.useFixedTPPrices) ||
          (this.botType === BotType.dca &&
            settings.useRiskReward &&
            settings.riskUseTpRatio),
        useFixedSLPrices:
          (this.botType === BotType.dca &&
            settings.type === DCATypeEnum.terminal &&
            settings.useSl &&
            !settings.trailingSl &&
            !settings.moveSL &&
            settings.useFixedSLPrices) ||
          (this.botType === BotType.dca && settings.useRiskReward),
      }
    }

    getInitalDealSettings(): Deal['settings'] | undefined {
      if (this.data) {
        return this.utils.getInitalDealSettings(BotType.dca, this.data.settings)
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}updateDealLastPrices`)
    async updateDealLastPrices(
      _botId: string,
      override?: LastPricesPerSymbols,
      removeSymbol?: string,
    ) {
      if (!this.data) {
        return
      }
      if (removeSymbol) {
        this.data.lastPricesPerSymbol = (
          this.data.lastPricesPerSymbol ?? []
        ).filter((d) => d.symbol !== removeSymbol)
      }
      if (!override) {
        const deals = this.getDealsByStatusAndSymbol({
          status: DCADealStatusEnum.open,
        }).reduce(
          (acc, v) =>
            acc.set(
              v.deal.symbol.symbol,
              (acc.get(v.deal.symbol.symbol) ?? []).concat(v),
            ),
          new Map() as Map<string, FullDeal<ExcludeDoc<Deal>>[]>,
        )
        this.data.lastPricesPerSymbol = (
          this.data.lastPricesPerSymbol ?? []
        ).filter((p) => [...deals.keys()].includes(p.symbol))
        for (const [symbol, _deals] of deals) {
          const last = _deals.sort(
            (a, b) => b.deal.createTime - a.deal.createTime,
          )[0]
          if (last) {
            let found = false
            this.data.lastPricesPerSymbol = (
              this.data.lastPricesPerSymbol ?? []
            ).map((p) => {
              if (p.symbol === symbol) {
                found = true
                if ((p.time && p.time <= last.deal.createTime) || !p.time) {
                  return {
                    symbol,
                    avg: last.deal.avgPrice,
                    entry: last.deal.initialPrice,
                    time: last.deal.createTime,
                  }
                }
              }
              return p
            })
            if (!found) {
              this.data.lastPricesPerSymbol.push({
                symbol,
                avg: last.deal.avgPrice,
                entry: last.deal.initialPrice,
                time: last.deal.createTime,
              })
            }
          }
        }
      }
      if (override) {
        this.data.lastPricesPerSymbol = [
          ...(this.data.lastPricesPerSymbol ?? []).filter(
            (d) => d.symbol !== override.symbol,
          ),
          override,
        ]
      }
      this.updateData({
        lastPricesPerSymbol: this.data.lastPricesPerSymbol,
      })
    }

    updateDealLastTime(
      _botId: string,
      type: 'opened' | 'closed',
      time: number,
      symbol: string,
    ) {
      if (this.data) {
        if (type === 'opened') {
          this.data.lastOpenedDeal = time
          this.data.lastOpenedDealPerSymbol = [
            ...(this.data.lastOpenedDealPerSymbol ?? []).filter(
              (d) => d.symbol !== symbol,
            ),
            { symbol, time },
          ]
          this.updateData({
            lastOpenedDeal: time,
            lastOpenedDealPerSymbol: this.data.lastOpenedDealPerSymbol,
          })
        }
        if (type === 'closed') {
          this.data.lastClosedDeal = time
          this.data.lastClosedDealPerSymbol = [
            ...(this.data.lastClosedDealPerSymbol ?? []).filter(
              (d) => d.symbol !== symbol,
            ),
            { symbol, time },
          ]
          this.updateData({
            lastClosedDeal: time,
            lastClosedDealPerSymbol: this.data.lastClosedDealPerSymbol,
          })
        }
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}checkCooldownStart`)
    async checkCooldownStart(_botId: string, symbol: string) {
      const settings = await this.getAggregatedSettings()
      const cooldownAfterDealStartOption =
        settings?.cooldownAfterDealStartOption && settings?.useMulti
          ? settings?.cooldownAfterDealStartOption
          : CooldownOptionsEnum.bot
      const lastTime =
        cooldownAfterDealStartOption === CooldownOptionsEnum.bot
          ? this.data?.lastOpenedDeal
          : this.data?.lastOpenedDealPerSymbol?.find((d) => d.symbol === symbol)
              ?.time
      return this.utils.checkCooldownStart(settings, lastTime ?? 0)
    }

    @IdMute(mutex, (botId: string) => `${botId}checkCooldownStop`)
    async checkCooldownStop(_botId: string, symbol: string) {
      const settings = await this.getAggregatedSettings()
      const cooldownAfterDealStartOption =
        settings?.cooldownAfterDealStopOption && settings?.useMulti
          ? settings?.cooldownAfterDealStopOption
          : CooldownOptionsEnum.bot
      const lastTime =
        cooldownAfterDealStartOption === CooldownOptionsEnum.bot
          ? this.data?.lastClosedDeal
          : this.data?.lastClosedDealPerSymbol?.find((d) => d.symbol === symbol)
              ?.time
      return this.utils.checkCooldownStop(settings, lastTime ?? 0)
    }

    async comboBasedOn(deal?: ExcludeDoc<Deal>) {
      const settings = await this.getAggregatedSettings(deal)
      return settings.comboTpBase && !settings.useTp && !settings.useSl
        ? ComboTpBase.filled
        : !settings.comboTpBase || settings.comboTpBase === ComboTpBase.full
          ? ComboTpBase.full
          : ComboTpBase.filled
    }

    /**
     * Read orders from {@link MainBot#_loadOrders}<br />
     *
     */

    async loadOrders(): Promise<void> {
      const _id = this.startMethod('loadOrders')
      // Deals restored from Redis are SEEDED here and their orders generated
      // further down, AFTER `_loadOrders` has filled the order book. Generating
      // them here — which is what this used to do — sized every restored deal's
      // take-profit against an order map that was still empty, so `getTPOrder`
      // saw no fills at all and fell through to the nominal base order size: a
      // Coinbase AIOZ deal came back resting a 1786.1 take-profit against
      // 3711.30 held, and a paperBinance TURBO deal still rests 2226 against
      // 103,547 taken on over 25 filled orders.
      //
      // Seeding first also fixes a second-order version of the same thing: with
      // the deal generated and set in one pass, `getDeal` could not see the deal
      // whose orders it was generating, so `findBaseOrderByDeal` — which returns
      // nothing without it — could never find that deal's own base order either.
      let restoredFromRedis: FullDeal<ExcludeDoc<Deal>>[] = []
      if (this.serviceRestart && !this.secondRestart) {
        const fromRedis =
          await this.getFromRedis<FullDeal<ExcludeDoc<Deal>>[]>('deals')
        if (fromRedis?.length) {
          this.handleLog(`Found in redis ${fromRedis.length} deals`)
          const checkAvg = fromRedis.some(
            (d) => typeof d.deal.avgPrice !== 'number',
          )
          if (!checkAvg) {
            restoredFromRedis = fromRedis.filter(
              (d) =>
                d.deal.status !== DCADealStatusEnum.closed &&
                d.deal.status !== DCADealStatusEnum.canceled,
            )
            for (const d of restoredFromRedis) {
              this.setDeal(
                {
                  ...d,
                  initialOrders: [],
                  currentOrders: [],
                  // `closeBySl` / `closeByTp` mean "a close is in flight in
                  // this process". Nothing is in flight at load, so a value
                  // restored from Redis is stale by definition — and a stale
                  // `true` is a one-way latch: the deal is skipped by
                  // `checkPlaceOrders` and by the close-recovery, so a close
                  // that failed once freezes the deal permanently. The DB
                  // load path below already resets both; this one did not.
                  closeBySl: false,
                  closeByTp: false,
                },
                false,
              )
            }
          }
        }
      }
      const loadFromDb =
        !(this.serviceRestart && !this.secondRestart) || !this.deals.size
      let deals: ExcludeDoc<Deal>[] = []
      if (loadFromDb) {
        this.handleLog(`Get deals from DB`)
        const dealData = await this.dealsDb.readData(
          {
            botId: this.botId,
            status: {
              $in: [
                DCADealStatusEnum.error,
                DCADealStatusEnum.open,
                DCADealStatusEnum.start,
              ],
            },
          } as any,
          {},
          {},
          true,
        )

        if (dealData.status === StatusEnum.notok) {
          this.loadingComplete = true
          this.endMethod(_id)
          return this.handleErrors(
            `Error getting deals from DB: ${dealData.reason}`,
            'loadOrders()',
            'reading deals',
          )
        }
        deals = dealData.data.result
      }
      const keys = loadFromDb
        ? deals.map((d) => `${d._id}`)
        : [...this.deals.keys()]
      const orders = await this._loadOrders({
        $or: [
          {
            dealId: { $in: keys },
            status: { $nin: ['CANCELED', 'EXPIRED'] },
          },
          {
            // An entry order that partially filled and was THEN cancelled still
            // holds the part the venue executed, and the running bot keeps it in
            // the order map — `setOrder` overwrites the status in place, it does
            // not drop the row. Excluding it here meant a restart silently threw
            // that volume away, and every consumer written for exactly this case
            // (`findBaseOrderByDeal`, the deal fee split, `updateUsage`'s filled
            // base) went looking for a row that could no longer be there. The
            // AIOZ base order — origQty 1790.1, executedQty 345.3, CANCELED —
            // is the shape this restores.
            //
            // Scoped to the open deals, so it adds a handful of rows to a scan
            // the `botId` index already drives: across all 11.5M orders on prod
            // only 19,354 rows match at all, and only one belonged to an open
            // deal. `$convert` rather than `$gt: '0'` because `executedQty` is a
            // STRING — `'0.00000000' > '0'` is TRUE lexicographically — and
            // rather than a bare `$toDouble`, which throws the whole query on a
            // single unparseable value.
            dealId: { $in: keys },
            status: 'CANCELED',
            typeOrder: {
              $in: [TypeOrderEnum.dealStart, TypeOrderEnum.dealRegular],
            },
            $expr: {
              $gt: [
                {
                  $convert: {
                    input: '$executedQty',
                    to: 'double',
                    onError: 0,
                    onNull: 0,
                  },
                },
                0,
              ],
            },
          },
          {
            status: { $nin: ['CANCELED', 'EXPIRED', 'FILLED'] },
          },
        ],
        botId: this.botId,
        typeOrder: { $nin: [TypeOrderEnum.liquidation, TypeOrderEnum.br] },
      })
      orders
        .filter(
          (o) =>
            o.status !== 'FILLED' ||
            (keys.includes(`${o.dealId}`) && o.status === 'FILLED'),
        )
        .map((o) => this.setOrder(o, false))
      this.setOrdersToRedis(
        this.botId,
        this.serviceRestart && !this.secondRestart,
      )
      // Now that the order book is populated, generate the orders for the deals
      // restored from Redis above. `getTPOrder` reads this deal's filled orders
      // and its base order out of that map; before, it ran against an empty one.
      for (const d of restoredFromRedis) {
        const initialOrders: Grid[] = []
        for (const o of d.initialOrders) {
          initialOrders.push({
            ...o,
            qty: this.math.round(
              o.qty,
              await this.baseAssetPrecision(d.deal.symbol.symbol),
            ),
            newClientOrderId:
              o.type === TypeOrderEnum.dealRegular
                ? this.combo
                  ? this.getOrderId('CMB-RO')
                  : this.getOrderId('D-RO')
                : this.getOrderId('D-TP'),
          })
        }
        const currentOrders = await this.createCurrentDealOrders(
          d.deal.symbol.symbol,
          d.deal.lastPrice,
          initialOrders,
          d.deal.settings.avgPrice || d.deal.avgPrice,
          d.deal.initialPrice,
          `${d.deal._id}`,
          false,
          d.deal,
          false,
        )
        this.setDeal(
          {
            ...d,
            initialOrders,
            currentOrders,
            closeBySl: false,
            closeByTp: false,
          },
          false,
        )
      }
      if (loadFromDb) {
        deals.map((d) =>
          this.setDeal(
            {
              deal: { ...d, _id: `${d._id}` },
              initialOrders: [],
              currentOrders: [],
              previousOrders: [],
              closeBySl: false,
              notCheckSl: false,
              closeByTp: false,
            },
            false,
          ),
        )
        const openDeals = deals.filter(
          (d) => d.status === DCADealStatusEnum.open,
        )
        for (const deal of openDeals) {
          let initialOrders: Grid[] = []
          let currentOrders: Grid[] = []
          const safeDealId = `${deal._id}`
          if (
            deal.initialPrice !== 0 &&
            deal.lastPrice !== 0 &&
            deal.settings.avgPrice !== 0
          ) {
            initialOrders = await this.createInitialDealOrders(
              deal.symbol.symbol,
              deal.initialPrice,
              safeDealId,
              deal,
            )
            currentOrders = await this.createCurrentDealOrders(
              deal.symbol.symbol,
              deal.lastPrice,
              initialOrders,
              deal.settings.avgPrice || deal.avgPrice,
              deal.initialPrice,
              safeDealId,
              false,
              deal,
              false,
            )
            const tempInitOrders = this.getDealInitialOrders(safeDealId)
            initialOrders =
              tempInitOrders.length > 0 ? tempInitOrders : initialOrders
          }
          deal.fullFee = await this.getCommDeal(deal)
          const fullDeal = {
            initialOrders,
            currentOrders,
            previousOrders: [],
            deal: {
              ...deal,
              _id: safeDealId,
            },
            limitTimer: null,
            enterMarketTimer: null,
            closeBySl: false,
            notCheckSl: false,
            closeByTp: false,
          }
          this.setDeal(fullDeal, false)
        }
        this.setDealToRedis(
          this.botId,
          this.serviceRestart && !this.secondRestart,
        )
      }
      const count = await this.dealsDb.countData({
        botId: this.botId,
      } as any)
      this.handleLog(`Get deals count ${count?.data?.result ?? 0}`)
      this.allDeals = count?.data?.result ?? this.deals.size

      this.handleLog(`Check exchange info and user fee to be in the bot`)
      if (this.deals.size) {
        const newSymbols: string[] = []
        const toSearch: Set<string> = new Set()
        for (const d of this.allDealsData) {
          if (!(await this.getExchangeInfo(d.deal.symbol.symbol))) {
            this.handleWarn(
              `Cannot find exchange info for ${d.deal.symbol.symbol}`,
            )
            toSearch.add(d.deal.symbol.symbol)
          }
          if (!(await this.getUserFee(d.deal.symbol.symbol))) {
            this.handleWarn(`Cannot find fee for ${d.deal.symbol.symbol}`)
            toSearch.add(d.deal.symbol.symbol)
          }
          if (!this.pairs.has(d.deal.symbol.symbol)) {
            // Debug, not warn: the loop below immediately subscribes every
            // symbol collected here, so this is an internal observation about
            // work in progress, never a condition anyone needs to act on. At
            // warn level it was 110 k lines/day in the DCA error stream —
            // `loadOrders` re-runs periodically and re-announces the same deals
            // every time (spec 008 §2.4).
            this.handleDebug(`Deal symbol ${d.deal.symbol.symbol} not in pairs`)
            newSymbols.push(d.deal.symbol.symbol)
          }
        }
        if (!this.combo) {
          if (toSearch.size) {
            await this.fillExchangeInfo([...toSearch])
            await this.getUserFees([...toSearch])
            for (const s of toSearch) {
              if (await this.confirmPairMissing(s)) {
                this.handleDebug(`Push ${s} to not found`)
                this.pairsNotFound.add(s)
              }
              if (!(await this.getUserFee(s))) {
                this.handleDebug(`Push ${s} to not found`)
                this.pairsNotFound.add(s)
              }
            }
          }
          if (newSymbols.length) {
            if (this.redisSubGlobal) {
              for (const pair of await this.redisSubKeys(newSymbols)) {
                this.redisSubGlobal.subscribe(pair, this.redisSubCb)
              }
            }
          }
        }
      }
      if (this.futures) {
        await this.startFunding().catch(() => undefined)
      }
      this.endMethod(_id)
    }

    override async afterUpdateExchangeInfo(pairs: Set<string>): Promise<void> {
      for (const o of pairs) {
        const getOld = this.precisions.get(o)
        const newData = await this.getExchangeInfo(o)
        const newBaseAssetPrecision = await this.baseAssetPrecision(o)
        const oldBaseAssetPrecision = this.basePrecisions.get(o)
        let updateDeals = false
        if (
          newData &&
          typeof getOld !== 'undefined' &&
          newData.priceAssetPrecision < getOld
        ) {
          this.precisions.set(o, newData.priceAssetPrecision)
          const deals = this.getDealsByStatusAndSymbol({ symbol: o })
          updateDeals = !!deals.length
          for (const d of deals) {
            d.currentOrders = d.currentOrders.map((co) => {
              co.price = this.math.round(co.price, newData.priceAssetPrecision)
              return co
            })
            d.initialOrders = d.initialOrders.map((io) => {
              io.price = this.math.round(io.price, newData.priceAssetPrecision)
              return io
            })
            this.saveDeal(d)
          }
        }
        if (
          typeof newBaseAssetPrecision !== 'undefined' &&
          typeof oldBaseAssetPrecision !== 'undefined' &&
          newBaseAssetPrecision < oldBaseAssetPrecision
        ) {
          this.basePrecisions.set(o, newBaseAssetPrecision)
          const deals = this.getDealsByStatusAndSymbol({ symbol: o })
          updateDeals = !!deals.length
          for (const d of deals) {
            d.currentOrders = d.currentOrders.map((co) => {
              co.qty = this.math.round(co.price, newBaseAssetPrecision)
              return co
            })
            d.initialOrders = d.initialOrders.map((io) => {
              io.qty = this.math.round(io.price, newBaseAssetPrecision)
              return io
            })
            this.saveDeal(d)
          }
        }
        if (updateDeals) {
          this.setDealToRedis(this.botId, false)
        }
      }
    }
    /**
     * Save deal after changes
     * @param {FullDeal} FullDeal
     * @param {Partial<ExcludeDoc<Deal>} changed
     */
    @IdMute(
      mutex,
      (fullDeal: FullDeal<ExcludeDoc<Deal>>) =>
        `${fullDeal.deal._id}@${fullDeal.deal.botId}saveDeal`,
    )
    async saveDeal(
      fullDeal: FullDeal<ExcludeDoc<Deal>>,
      deal?: Partial<any>,
      send = true,
    ) {
      const dealId = fullDeal.deal._id
      let fullResult: FullDeal<ExcludeDoc<Deal>> = fullDeal
      const get = this.getDeal(dealId)
      if (get) {
        const result = {
          ...fullDeal,
          deal: {
            ...get.deal,
            ...deal,
          },
        }
        fullResult = result
        this.setDeal(fullResult)
      }

      if (deal && Object.entries(deal).length && this.shouldProceed()) {
        this.dealsDb
          .updateData({ _id: dealId }, { $set: { ...deal } as any })
          .then((res) => {
            if (res.status === StatusEnum.notok) {
              this.handleErrors(
                `Error saving deal: ${dealId}. Reason: ${res.reason}`,
                '',
                '',
                false,
                false,
                false,
              )
            }
          })
        if (send) {
          this.emit('bot deal update', {
            ...fullResult.deal,
            botName: this.data?.settings.name ?? '',
            combo: this.combo,
          })
        }
      }
    }
    /**
     * Create deal record in db
     *
     * Push new deal to {@link DCABotHelper#deals} array
     *
     * @returns {Promise<string | undefined>} Id of the deal or null if error
     */

    async createDeal(
      symbol: string,
      fixSl = 0,
      fixTp = 0,
      fixSize = 0,
      dynamicAr: DynamicArPrices[] = [],
      sizes?: Sizes | null,
      orderSizeType?: OrderSizeTypeEnum,
    ): Promise<string | undefined> {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('create deal'))
        return
      }
      const _id = this.startMethod('createDeal')
      const time = new Date().getTime()
      let symbolData: Symbols | undefined
      try {
        const ed = await this.getExchangeInfo(symbol)
        if (!ed) {
          this.handleWarn(`Cannot create deal for ${symbol}. ED not found`)
          this.endMethod(_id)
          return
        }
        symbolData = {
          symbol: ed.pair,
          baseAsset: ed.baseAsset.name,
          quoteAsset: ed.quoteAsset.name,
        }
      } catch (e) {
        this.handleWarn(
          `Cannot create deal for ${symbol}. Catch error in reading exchange data: ${
            (e as Error)?.message ?? e
          }`,
        )
        this.endMethod(_id)
        return
      }
      if (!symbolData) {
        this.handleWarn(
          `Cannot create deal for ${symbol}. Symbol data not found. Data size ${this.data?.symbol?.size}`,
        )
        this.endMethod(_id)
        return
      }
      const dealSettings = this.getInitalDealSettings()
      if (this.data && symbolData && dealSettings) {
        const flags: DCADealFlags[] = [DCADealFlags.newMultiTp]
        if (this.data.flags?.includes(BotFlags.externalSl)) {
          flags.push(DCADealFlags.externalSl)
        }
        if (this.data.flags?.includes(BotFlags.externalTp)) {
          flags.push(DCADealFlags.externalTp)
        }
        const record = await this.dealsDb.createData({
          flags,
          botId: this.botId,
          userId: this.userId,
          status: DCADealStatusEnum.start,
          initialBalances: {
            base: 0,
            quote: 0,
          },
          currentBalances: {
            base: 0,
            quote: 0,
          },
          initialPrice: 0,
          avgPrice: 0,
          displayAvg: 0,
          profit: {
            total: 0,
            totalUsd: 0,
            pureBase: 0,
            pureQuote: 0,
          },
          feePaid: {
            base: 0,
            quote: 0,
          },
          lastPrice: 0,
          commission: 0,
          createTime: time,
          updateTime: time,
          levels: {
            all: this.data.settings.useDca
              ? this.data.settings.dcaCondition === DCAConditionEnum.indicators
                ? this.data.settings.indicators.filter(
                    (si) => si.indicatorAction === IndicatorAction.startDca,
                  ).length + 1
                : this.data.settings.dcaCondition === DCAConditionEnum.custom
                  ? (this.data.settings.dcaCustom ?? []).length + 1
                  : this.data.settings.ordersCount + 1
              : 1,
            complete: 0,
          },
          usage: {
            current: {
              base: 0,
              quote: 0,
            },
            max: {
              base: 0,
              quote: 0,
            },
          },
          assets: {
            used: {
              base: 0,
              quote: 0,
            },
            required: {
              base: 0,
              quote: 0,
            },
          },
          settings: {
            ...dealSettings,
            fixedSlPrice: this.data.settings.useRiskReward
              ? fixSl
                ? fixSl
                : undefined
              : this.data.settings.fixedSlPrice,
            fixedTpPrice:
              this.data.settings.useRiskReward &&
              this.data.settings.riskUseTpRatio
                ? fixTp
                  ? fixTp
                  : undefined
                : this.data.settings.fixedTpPrice,
            useTp:
              this.data.settings.useRiskReward &&
              fixTp &&
              this.data.settings.riskUseTpRatio
                ? true
                : this.data.settings.useTp,
            useSl: this.data.settings.useRiskReward
              ? true
              : this.data.settings.useSl,
            dealCloseCondition:
              this.data.settings.useRiskReward &&
              fixTp &&
              this.data.settings.riskUseTpRatio
                ? CloseConditionEnum.tp
                : this.data.settings.dealCloseCondition,
            dealCloseConditionSL:
              this.data.settings.useRiskReward && fixSl
                ? CloseConditionEnum.tp
                : this.data.settings.dealCloseConditionSL,
          },
          parentId: null,
          childIds: [],
          parent: false,
          child: false,
          gridBreakpoints: [],
          paperContext: this.data.paperContext,
          type: this.data.settings.type,
          symbol: symbolData,
          exchange: this.data.exchange,
          exchangeUUID: this.data.exchangeUUID,
          strategy: this.data.settings.strategy,
          stats: {
            drawdownPercent: 0,
            runUpPercent: 0,
            timeInProfit: 0,
            timeInLoss: 0,
            trackTime: 0,
            timeCountStart: Date.now(),
          },
          dynamicAr,
          sizes: sizes || undefined,
          fixSize,
          orderSizeType,
          parentBotId: this.data.parentBotId,
          action: this.data.settings.futures ? undefined : this.data.action,
          // Funding cursor starts at deal creation so we never backfill funding
          // from before the deal existed.
          funding: { total: 0, totalUsd: 0, offset: time, lastTime: 0 },
          tags: ['TPrev150925'],
        } as any)
        if (record.status === StatusEnum.notok) {
          this.handleErrors(
            `Cannot create deal: ${record.reason}`,
            'createDeal()',
            'create deal',
          )
          this.endMethod(_id)
          return
        }
        const dealId = `${record.data._id}`
        this.handleLog(`Deal created with id ${dealId}`)
        this.setDeal({
          deal: { ...record.data, _id: dealId },
          initialOrders: [],
          currentOrders: [],
          previousOrders: [],
          closeBySl: false,
          notCheckSl: false,
          closeByTp: false,
        })
        this.resetPending(this.botId, symbol)
        if (this.futures) {
          const fundingSym = await this.toFundingSymbol(symbolData.symbol)
          if (fundingSym) {
            await this.subscribeFunding(fundingSym)
          }
        }
        this.emit('bot deal update', record.data)
        this.updateBotDeals(this.botId, true)
        this.endMethod(_id)
        return dealId
      }
      this.handleWarn(
        `Cannot create deal for ${symbol}, data: ${!!this
          .data}, symbolData: ${!!symbolData}, dealSettings: ${!!dealSettings}`,
      )
      this.endMethod(_id)
      return
    }
    // ---- Funding fees (DCA/Combo: per open deal, offset on each deal) ----

    protected override async startFunding(): Promise<void> {
      if (!this.futures) {
        return
      }
      const open = this.getDealsByStatusAndSymbol({
        status: [DCADealStatusEnum.open, DCADealStatusEnum.start],
      })
      const pairs = new Set<string>()
      for (const fd of open) {
        const pair = fd.deal.symbol?.symbol
        if (pair) {
          pairs.add(pair)
        }
      }
      for (const pair of pairs) {
        const fundingSym = await this.toFundingSymbol(pair)
        if (!fundingSym) {
          continue
        }
        await this.subscribeFunding(fundingSym)
        await this.onFundingNotify(this.fundingChannelFor(fundingSym))
      }
    }

    protected override async onFundingNotify(
      channelKey: string,
    ): Promise<void> {
      if (!this.futures) {
        return
      }
      const fundingSym = this.fundingSymbolFromChannel(channelKey)
      if (!fundingSym) {
        return
      }
      const pair = await this.fromFundingSymbol(fundingSym)
      const deals = this.getDealsByStatusAndSymbol({
        status: DCADealStatusEnum.open,
        symbol: pair,
      })
      for (const fd of deals) {
        await this.processDealFunding(fd.deal._id)
      }
    }

    @IdMute(mutex, (dealId: string) => `${dealId}funding`)
    private async processDealFunding(dealId: string) {
      const fd = this.getDeal(dealId)
      if (!fd) {
        return
      }
      const deal = fd.deal
      const pair = deal.symbol?.symbol
      if (!pair) {
        return
      }
      const fundingSym = await this.toFundingSymbol(pair)
      if (!fundingSym) {
        return
      }
      const offset = deal.funding?.offset ?? deal.createTime
      // Deals keep all their orders in RAM — derive the position from those
      // in-memory fills (no DB round-trip), folding fills up to each settlement.
      const fills = this.getSignedFillsFromMemory(dealId)
      const getQtyAt = (eventTime: number) =>
        fills.reduce(
          (sum, f) => (f.time <= eventTime ? sum + f.signedQty : sum),
          0,
        )
      const result = await this.computeFundingFor(
        fundingSym,
        pair,
        offset,
        getQtyAt,
      )
      if (result.applied === 0) {
        return
      }
      this.handleDebug(
        `Funding for deal ${dealId}. Quote: ${result.deltaQuote}, USD: ${result.deltaUsd}, max time: ${result.maxTime}, last time: ${result.lastTime}, applied: ${result.applied}`,
      )
      // Adopt the cursor on a deal that has none. The commit below is a CAS on
      // `funding.offset`, and `{'funding.offset': <n>}` matches no document
      // where that field is absent — so on such a deal every funding write was
      // a permanent no-op while `closeDeal` still folded the in-memory funding
      // into the reported profit. Every combo deal was in that state (their
      // `createDeal` override never seeded the cursor), and the ones already
      // open when this shipped still are, so seeding at creation alone does not
      // repair them.
      //
      // `$exists: false` is what makes this safe: it can only ever write a
      // cursor that is missing, never move a live one backwards. Carrying the
      // in-memory totals across means a deal that has been accruing unpersisted
      // funding this session adopts what it already has rather than restarting
      // from zero behind its own cursor.
      if (result.applied > 0) {
        await this.dealsDb.updateData(
          { _id: dealId, 'funding.offset': { $exists: false } } as any,
          {
            $set: {
              'funding.offset': offset,
              'funding.total': deal.funding?.total ?? 0,
              'funding.totalUsd': deal.funding?.totalUsd ?? 0,
              'funding.lastTime': deal.funding?.lastTime ?? 0,
            },
          } as any,
        )
      }
      // Per-deal commit: atomic + CAS on the deal's own offset.
      await this.dealsDb.updateData(
        { _id: dealId, 'funding.offset': offset } as any,
        {
          $inc: {
            'funding.total': result.deltaQuote,
            'funding.totalUsd': result.deltaUsd,
          },
          $set: {
            'funding.offset': result.maxTime,
            'funding.lastTime': result.lastTime,
          },
          $push: {
            'funding.history': { $each: result.entries, $slice: -25 },
          },
        } as any,
      )
      // Bot-level aggregate (no offset — each deal owns its own). lastTime via
      // $max: a bot can hold several symbols whose settlements differ.
      await this.db?.updateData(
        { _id: this.botId } as any,
        {
          $inc: {
            'funding.total': result.deltaQuote,
            'funding.totalUsd': result.deltaUsd,
          },
          $max: { 'funding.lastTime': result.lastTime },
        } as any,
      )
      // In-memory mirrors.
      const f = deal.funding ?? {
        total: 0,
        totalUsd: 0,
        offset,
        lastTime: 0,
        history: [],
      }
      deal.funding = {
        total: (f.total ?? 0) + result.deltaQuote,
        totalUsd: (f.totalUsd ?? 0) + result.deltaUsd,
        offset: result.maxTime,
        lastTime: result.lastTime,
        history: [...(f.history ?? []), ...result.entries].slice(-25),
      }
      this.setDeal(fd, false)
      if (this.data) {
        const bf = this.data.funding ?? {
          total: 0,
          totalUsd: 0,
          offset: 0,
          lastTime: 0,
        }
        this.data.funding = {
          total: (bf.total ?? 0) + result.deltaQuote,
          totalUsd: (bf.totalUsd ?? 0) + result.deltaUsd,
          offset: bf.offset ?? 0,
          lastTime: Math.max(bf.lastTime ?? 0, result.lastTime),
        }
      }
      // Push the change to the UI (deal + bot aggregate).
      this.emit('bot deal update', deal)
      this.emit('bot settings update', { funding: this.data?.funding })
    }

    /** Settle funding one last time, then drop the symbol sub if unused. */
    private async finishDealFunding(dealId: string, pair: string) {
      if (!this.futures || !pair) {
        return
      }
      await this.processDealFunding(dealId)
      const others = this.getDealsByStatusAndSymbol({
        status: [DCADealStatusEnum.open, DCADealStatusEnum.start],
        symbol: pair,
      }).filter((fd) => fd.deal._id !== dealId)
      if (!others.length) {
        const fundingSym = await this.toFundingSymbol(pair)
        if (fundingSym) {
          await this.unsubscribeFunding(fundingSym)
        }
      }
    }

    /**
     * Clear deal timer
     */

    async clearDealTimer(dealId: string) {
      const findDeal = this.dealTimersMap.get(dealId)
      if (findDeal) {
        if (findDeal.limitTimer) {
          clearTimeout(findDeal.limitTimer)
          findDeal.limitTimer = null
        }
        if (findDeal.enterMarketTimer) {
          clearTimeout(findDeal.enterMarketTimer)
          findDeal.enterMarketTimer = null
        }
        this.startTimeoutTime.delete(dealId)
        this.dealTimersMap.set(dealId, findDeal)
      }
    }

    /**
     * The deal's total fee, in the deal's profit currency.
     *
     * Per order this prefers the fee the VENUE reported over the
     * `qty * price * storedFeeRate` estimate this method used to be built
     * entirely from. The estimate remains the fallback for any order the venue
     * did not report a fee for, or reported in an asset that is neither side
     * of the pair — so a fee we could not observe still costs the deal
     * something, rather than silently becoming free.
     *
     * The observed legs are expressed in whichever side the venue charged, so
     * they have to be converted into the profit currency before summing. That
     * conversion uses the deal's own `lastPrice`, the same price the callers
     * of this method use to move between base and quote.
     */
    async getCommDeal(findDeal: ExcludeDoc<Deal>) {
      const fee = await this.getUserFee(findDeal.symbol.symbol)
      const profitBase = await this.profitBase(findDeal)
      const dealPrice = findDeal.lastPrice || findDeal.avgPrice || 0
      return this.getOrdersByStatusAndDealId({
        status: 'FILLED',
        dealId: `${findDeal._id}`,
      }).reduce((acc, v) => {
        // Convert at the ORDER's own fill price, not the deal's — the estimate
        // this replaces was per order at `v.price` too, and a deal that has
        // moved since a fill would otherwise value that fill's fee at today's
        // price. The deal price is only the fallback for an order with none.
        const price = parseFloat(v.price) || dealPrice
        const observed = price
          ? observedFeeSplit(
              v,
              findDeal.symbol?.baseAsset,
              findDeal.symbol?.quoteAsset,
            )
          : null
        if (observed) {
          return (
            acc +
            (profitBase
              ? observed.base + observed.quote / price
              : observed.base * price + observed.quote)
          )
        }
        return (
          acc +
          (profitBase
            ? parseFloat(v.executedQty) *
              (v.type === 'MARKET' ? (fee?.taker ?? 0) : (fee?.maker ?? 0))
            : parseFloat(v.executedQty) *
              parseFloat(v.price) *
              (v.type === 'MARKET' ? (fee?.taker ?? 0) : (fee?.maker ?? 0)))
        )
      }, 0)
    }
    /**
     * Close deal when TP is filled
     *
     * @param {Order} tpOrder Order which close the deal
     *
     */
    @IdMute(
      mutex,
      (botId: string, order: Order) => `${botId}${order.clientOrderId}`,
    )
    async closeDeal(
      _botId: string,
      dealId: string,
      tpOrder?: Order,
      liquidationPrice?: number,
    ) {
      const _id = this.startMethod('closeDeal')
      let stop = false
      const findDeal = this.getDeal(dealId)
      if (
        findDeal &&
        (findDeal.deal.status === DCADealStatusEnum.open ||
          (findDeal.deal.status === DCADealStatusEnum.canceled &&
            !findDeal.deal.profit.total &&
            tpOrder)) &&
        this.data &&
        this.orders &&
        dealId
      ) {
        // Settle any funding accrued up to close before the deal leaves memory.
        await this.finishDealFunding(dealId, findDeal.deal.symbol?.symbol ?? '')
        const profitBase = await this.profitBase(findDeal.deal)
        if (tpOrder) {
          this.handleLog('TP order FILLED')
          this.pendingClose.add(dealId)
          const fee = await this.getUserFee(tpOrder.symbol)
          const orderPrice = parseFloat(tpOrder.price)
          const orderQty = parseFloat(tpOrder.executedQty)
          const filledTp = (findDeal.deal.tpHistory ?? []).filter(
            (d) => d.id !== tpOrder.clientOrderId,
          )
          const qty = orderQty + filledTp.reduce((acc, d) => acc + d.qty, 0)
          const price =
            (orderPrice * orderQty +
              filledTp.reduce((acc, d) => acc + d.qty * d.price, 0)) /
            qty

          findDeal.deal.status = DCADealStatusEnum.closed
          findDeal.deal.lastPrice = parseFloat(tpOrder.price)
          findDeal.deal.currentBalances = {
            base:
              findDeal.deal.currentBalances.base +
              qty * (tpOrder.side === OrderSideEnum.buy ? 1 : -1),
            quote:
              findDeal.deal.currentBalances.quote +
              qty * price * (tpOrder.side === OrderSideEnum.sell ? 1 : -1),
          }
          findDeal.deal.updateTime = tpOrder.updateTime
          const dealOrders = this.getOrdersByStatusAndDealId({
            dealId,
            status: ['FILLED', 'CANCELED'],
          }).filter(
            (o) =>
              +o.executedQty > 0 &&
              ![TypeOrderEnum.br, TypeOrderEnum.rebalance].includes(
                o.typeOrder,
              ),
          )
          const commDeal = await this.getCommDeal(findDeal.deal)
          let feeBaseFull = 0
          let feeQuoteFull = 0
          for (const o of dealOrders) {
            // Prefer what the VENUE said it charged. `deal.feePaid` was
            // previously the sum of `qty * price * storedFeeRate` for every
            // filled order — an estimate that is only as good as the stored
            // rate, and therefore wrong for the whole deal whenever that rate
            // has drifted from the venue's real schedule.
            //
            // The fallback is per ORDER, not per deal: a deal can mix orders
            // the venue reported a fee for with orders it did not (a fee
            // charged in BNB, an order that predates the capture, a paper
            // leg). Estimating only the ones we could not observe keeps the
            // total complete — and an unresolvable fee must never book as
            // zero, which is why `observedFeeSplit` returns null rather than a
            // zeroed split.
            const observed = observedFeeSplit(
              o,
              findDeal.deal.symbol?.baseAsset,
              findDeal.deal.symbol?.quoteAsset,
            )
            if (observed) {
              feeBaseFull += observed.base
              feeQuoteFull += observed.quote
              continue
            }
            if (o.side === OrderSideEnum.buy) {
              feeBaseFull +=
                +o.executedQty *
                (o.type === 'MARKET' ? (fee?.taker ?? 0) : (fee?.maker ?? 0))
            } else {
              feeQuoteFull +=
                +o.executedQty *
                +o.price *
                (o.type === 'MARKET' ? (fee?.taker ?? 0) : (fee?.maker ?? 0))
            }
          }

          const pureQuote =
            findDeal.deal.currentBalances.quote -
            (findDeal.deal.initialBalances.quote +
              (this.combo ? (findDeal.deal.profit.pureQuote ?? 0) : 0)) -
            feeQuoteFull
          const pureBase =
            findDeal.deal.currentBalances.base -
            (findDeal.deal.initialBalances.base +
              (this.combo ? (findDeal.deal.profit.pureBase ?? 0) : 0)) -
            feeBaseFull

          const total =
            (!profitBase
              ? findDeal.deal.currentBalances.quote -
                (findDeal.deal.initialBalances.quote +
                  (this.combo ? findDeal.deal.profit.total : 0)) +
                (findDeal.deal.currentBalances.base -
                  findDeal.deal.initialBalances.base) *
                  findDeal.deal.lastPrice
              : findDeal.deal.currentBalances.base -
                (findDeal.deal.initialBalances.base +
                  (this.combo ? findDeal.deal.profit.total : 0)) +
                (findDeal.deal.currentBalances.quote -
                  findDeal.deal.initialBalances.quote) /
                  findDeal.deal.lastPrice) - commDeal
          const rate = await this.getUsdRate(tpOrder.symbol)
          const totalUsd =
            total * (!profitBase ? 1 : findDeal.deal.lastPrice) * rate
          findDeal.deal.profit = {
            ...findDeal.deal.profit,
            pureBase: (findDeal.deal.profit.pureBase ?? 0) + pureBase,
            pureQuote: (findDeal.deal.profit.pureQuote ?? 0) + pureQuote,
            total: (this.combo ? findDeal.deal.profit.total : 0) + total,
            totalUsd:
              (this.combo ? findDeal.deal.profit.totalUsd : 0) + totalUsd,
          }
          findDeal.deal.feeBalance = 0
          findDeal.deal.closeTrigger =
            findDeal.deal.closeTrigger &&
            findDeal.deal.closeTrigger !== DCACloseTriggerEnum.base
              ? findDeal.deal.closeTrigger
              : tpOrder.sl
                ? DCACloseTriggerEnum.sl
                : DCACloseTriggerEnum.tp
          const usdUpdate = this.combo
            ? findDeal.deal.profit.totalUsd
            : totalUsd
          this.saveProfitToDb(usdUpdate, findDeal.deal.closeTime ?? +new Date())
          this.data.profit = {
            freeTotal: 0,
            freeTotalUsd: 0,
            total: this.data.profit.total + findDeal.deal.profit.total,
            totalUsd: this.data.profit.totalUsd + usdUpdate,
            pureBase:
              (this.data.profit.pureBase ?? 0) +
              (findDeal.deal.profit.pureBase ?? 0),
            pureQuote:
              (this.data.profit.pureQuote ?? 0) +
              (findDeal.deal.profit.pureQuote ?? 0),
          }
          const longBase = this.isLong && (await this.profitBase())
          const shortQuote = !this.isLong && !(await this.profitBase())
          if (
            this.data.flags?.includes(BotFlags.newBaseProfit) &&
            this.data.settings.useMulti &&
            (longBase || shortQuote)
          ) {
            const { baseAsset, quoteAsset } = findDeal.deal.symbol
            const findBase = (this.data.profitByAssets ?? []).find(
              (p) => p.asset === baseAsset,
            )
            const findQuote = (this.data.profitByAssets ?? []).find(
              (p) => p.asset === quoteAsset,
            )
            this.data.profitByAssets = (this.data.profitByAssets ?? []).filter(
              (p) => p.asset !== baseAsset && p.asset !== quoteAsset,
            )
            const price = findDeal.deal.avgPrice || findDeal.deal.lastPrice
            this.data.profitByAssets.push({
              asset: baseAsset,
              total:
                (findBase?.total ?? 0) + (findDeal.deal.profit.pureBase ?? 0),
              totalUsd: longBase
                ? (findBase?.totalUsd ?? 0) +
                  (findDeal.deal.profit.pureBase ?? 0) * rate * price
                : (findBase?.totalUsd ?? 0) + pureBase * rate * price,
            })
            this.data.profitByAssets.push({
              asset: quoteAsset,
              total:
                (findQuote?.total ?? 0) + (findDeal.deal.profit.pureQuote ?? 0),
              totalUsd: shortQuote
                ? (findQuote?.totalUsd ?? 0) +
                  (findDeal.deal.profit.pureQuote ?? 0) * rate
                : (findQuote?.totalUsd ?? 0) + pureQuote * rate,
            })
          }
          findDeal.deal.feePaid = {
            base: feeBaseFull,
            quote: feeQuoteFull,
          }
          findDeal.deal.commission += commDeal
          if (tpOrder.acBefore && tpOrder.acAfter) {
            findDeal.deal.ac = {
              before: tpOrder.acBefore,
              after: tpOrder.acAfter,
            }
          }
          // Record what actually closed. `size` is a display field, and while
          // the deal is open it means the live position; the moment the
          // position is gone `updateUsage` has nothing left to read it from
          // and used to back-derive it from usage instead, which is a
          // different quantity entirely. `qty` here is the real closed amount
          // — this fill plus any earlier partial take-profits — so pin it now
          // and let `updateUsage` preserve it.
          findDeal.deal.size = qty
          this.saveDeal(findDeal, {
            commission: findDeal.deal.commission,
            profit: findDeal.deal.profit,
            updateTime: findDeal.deal.updateTime,
            status: findDeal.deal.status,
            lastPrice: findDeal.deal.lastPrice,
            currentBalances: findDeal.deal.currentBalances,
            size: findDeal.deal.size,
            tpHistory: filledTp,
            feePaid: findDeal.deal.feePaid,
            feeBalance: findDeal.deal.feeBalance,
            ac: findDeal.deal.ac,
            closeTrigger: findDeal.deal.closeTrigger,
          })
          this.handleDebug(
            `Deal closed with profit ${total} ${totalUsd} (${findDeal.deal.profit.total} ${findDeal.deal.profit.totalUsd})`,
          )
          const botUpdate = {
            profit: { ...this.data.profit },
            profitByAssets: [
              ...((this.data.profitByAssets ?? []) as NonNullable<
                CleanMainBot['profitByAssets']
              >),
            ],
          }

          this.updateData(botUpdate)
          this.emit('bot settings update', botUpdate)
          const remainder =
            (this.isLong
              ? findDeal.deal.currentBalances.base
              : findDeal.deal.initialBalances.base -
                findDeal.deal.currentBalances.base) -
            (profitBase ? findDeal.deal.profit.total : 0)
          const ed = await this.getExchangeInfo(findDeal.deal.symbol.symbol)
          if (
            ed &&
            remainder > ed.baseAsset.minAmount &&
            remainder * findDeal.deal.avgPrice > ed.quoteAsset.minAmount
          ) {
            await this.sellRemainder(
              dealId,
              remainder,
              findDeal.deal.avgPrice,
              true,
              findDeal,
              undefined,
              true,
            )
          }
          stop = await this.processDealClose(
            this.botId,
            dealId,
            { total, totalUsd },
            undefined,
            undefined,
            tpOrder,
          )
          this.updateUserProfitStep()
        } else if (liquidationPrice) {
          this.handleLog('Liquidation order FILLED')
          const price = liquidationPrice
          findDeal.deal.status = DCADealStatusEnum.closed
          findDeal.deal.lastPrice = price
          findDeal.deal.currentBalances = {
            base: this.isLong
              ? 0
              : findDeal.deal.currentBalances.base +
                findDeal.deal.currentBalances.quote / liquidationPrice,
            quote: this.isLong
              ? findDeal.deal.currentBalances.quote +
                findDeal.deal.currentBalances.base * liquidationPrice
              : 0,
          }
          findDeal.deal.updateTime = +new Date()

          const pureQuote =
            findDeal.deal.currentBalances.quote -
            (findDeal.deal.initialBalances.quote +
              (findDeal.deal.profit.pureQuote ?? 0))
          const pureBase =
            findDeal.deal.currentBalances.base -
            (findDeal.deal.initialBalances.base +
              (findDeal.deal.profit.pureBase ?? 0))
          const total = !profitBase
            ? findDeal.deal.currentBalances.quote -
              (findDeal.deal.initialBalances.quote +
                findDeal.deal.profit.total) +
              (findDeal.deal.currentBalances.base -
                findDeal.deal.initialBalances.base) *
                findDeal.deal.lastPrice
            : findDeal.deal.currentBalances.base -
              findDeal.deal.initialBalances.base +
              (findDeal.deal.currentBalances.quote -
                findDeal.deal.initialBalances.quote) /
                findDeal.deal.lastPrice
          const rate = await this.getUsdRate(findDeal.deal.symbol.symbol)
          const totalUsd =
            total * (!profitBase ? 1 : findDeal.deal.lastPrice) * rate
          findDeal.deal.profit = {
            ...findDeal.deal.profit,
            pureBase: (findDeal.deal.profit.pureBase ?? 0) + pureBase,
            pureQuote: (findDeal.deal.profit.pureQuote ?? 0) + pureQuote,
            total: findDeal.deal.profit.total + total,
            totalUsd: findDeal.deal.profit.totalUsd + totalUsd,
          }
          this.data.profit = {
            freeTotal: 0,
            freeTotalUsd: 0,
            total: this.data.profit.total + total,
            totalUsd: this.data.profit.totalUsd + totalUsd,
            pureBase: (this.data.profit.pureBase ?? 0) + pureBase,
            pureQuote: (this.data.profit.pureQuote ?? 0) + pureQuote,
          }
          this.saveProfitToDb(totalUsd, findDeal.deal.closeTime ?? +new Date())
          this.saveDeal(findDeal, {
            profit: findDeal.deal.profit,
            updateTime: findDeal.deal.updateTime,
            status: findDeal.deal.status,
            lastPrice: findDeal.deal.lastPrice,
            currentBalances: findDeal.deal.currentBalances,
          })
          this.updateData({ profit: { ...this.data.profit } })
          this.emit('bot settings update', { profit: this.data.profit })
          stop = await this.processDealClose(
            this.botId,
            dealId,
            { total, totalUsd },
            undefined,
            undefined,
            tpOrder,
          )
          this.updateUserProfitStep()
        } else {
          this.handleLog('Close without TP order')
          const rate = await this.getUsdRate(findDeal.deal.symbol.symbol)
          findDeal.deal.status = DCADealStatusEnum.closed
          findDeal.deal.updateTime = +new Date()
          const commDeal = await this.getCommDeal(findDeal.deal)
          const commUsd =
            commDeal * (!profitBase ? 1 : findDeal.deal.lastPrice) * rate
          findDeal.deal.profit.total -= commDeal
          findDeal.deal.profit.totalUsd -= commUsd
          findDeal.deal.commission = commDeal
          this.data.profit.total += findDeal.deal.profit.total
          this.data.profit.totalUsd += findDeal.deal.profit.totalUsd
          this.saveProfitToDb(
            findDeal.deal.profit.totalUsd,
            findDeal.deal.closeTime ?? +new Date(),
          )
          this.updateData({ profit: this.data.profit })
          this.emit('bot settings update', { profit: this.data.profit })
          this.saveDeal(findDeal, {
            updateTime: findDeal.deal.updateTime,
            status: findDeal.deal.status,
            profit: findDeal.deal.profit,
            commission: findDeal.deal.commission,
          })
          stop = await this.processDealClose(
            this.botId,
            dealId,
            {
              total: 0,
              totalUsd: 0,
            },
            undefined,
            undefined,
            tpOrder,
          )
        }

        // Fold settled funding into the realized P&L so the headline profit
        // (deal + bot aggregate) is net of funding. `funding.total` stays as the
        // breakdown line; the UI must not add it again for closed deals.
        const fundingTotal = findDeal.deal.funding?.total ?? 0
        const fundingTotalUsd = findDeal.deal.funding?.totalUsd ?? 0
        if (
          findDeal.deal.status === DCADealStatusEnum.closed &&
          (fundingTotal || fundingTotalUsd)
        ) {
          findDeal.deal.profit.total += fundingTotal
          findDeal.deal.profit.totalUsd += fundingTotalUsd
          this.data.profit.total += fundingTotal
          this.data.profit.totalUsd += fundingTotalUsd
          this.updateData({ profit: this.data.profit })
          this.saveDeal(findDeal, { profit: findDeal.deal.profit })
        }

        if (stop) {
          this.stop()
        }
      }
      this.endMethod(_id)
    }
    /** Check closed deals */

    async checkClosedDeals() {
      if (!this.data || !this.allowedMethods.has('checkClosedDeals')) {
        return
      }

      const {
        useCloseAfterX,
        closeAfterX,
        useBotController,
        useCloseAfterXloss,
        closeAfterXloss,
        useCloseAfterXwin,
        closeAfterXwin,
        useCloseAfterXprofit,
        closeAfterXprofitCond,
        closeAfterXprofitValue,
      } = await this.getAggregatedSettings()
      if (
        ((!useCloseAfterX || !closeAfterX || !checkNumber(closeAfterX)) &&
          (!useCloseAfterXloss ||
            !closeAfterXloss ||
            !checkNumber(closeAfterXloss)) &&
          (!useCloseAfterXwin ||
            !closeAfterXwin ||
            !checkNumber(closeAfterXwin)) &&
          (!useCloseAfterXprofit ||
            !closeAfterXprofitValue ||
            !checkNumber(closeAfterXprofitValue) ||
            !closeAfterXprofitCond)) ||
        !useBotController
      ) {
        return
      }
      if (
        useCloseAfterXprofit &&
        closeAfterXprofitValue &&
        checkNumber(closeAfterXprofitValue) &&
        closeAfterXprofitCond
      ) {
        const val = this.data?.profit?.totalUsd ?? 0
        const close =
          closeAfterXprofitCond === IndicatorStartConditionEnum.gt
            ? val > +closeAfterXprofitValue
            : val < +closeAfterXprofitValue
        if (close) {
          this.handleLog(
            `Close deal after X profit accumulated, profit: ${val}, trigger: ${closeAfterXprofitValue}`,
          )
          await this.stop(CloseDCATypeEnum.leave)
        }
      }
      if (useCloseAfterX && closeAfterX && checkNumber(closeAfterX)) {
        const deals = await this.dealsDb.countData({
          status: DCADealStatusEnum.closed,
          botId: this.botId,
        } as any)
        if (deals.status === StatusEnum.notok) {
          return this.handleErrors(
            `Error reading deals x close ${deals.reason}`,
            'checkClosedDeals',
            undefined,
            false,
            false,
            false,
          )
        }
        if (
          deals.data.result >= +closeAfterX &&
          this.data.status !== BotStatusEnum.closed
        ) {
          this.handleLog(
            `Close deal after X trigger, closed: ${deals.data.result}, trigger: ${closeAfterX}`,
          )
          await this.stop(CloseDCATypeEnum.leave)
        }
      }
      if (
        useCloseAfterXloss &&
        closeAfterXloss &&
        checkNumber(closeAfterXloss)
      ) {
        const deals = await this.dealsDb.countData({
          status: DCADealStatusEnum.closed,
          botId: this.botId,
          'profit.totalUsd': { $lte: 0 },
        } as any)
        if (deals.status === StatusEnum.notok) {
          return this.handleErrors(
            `Error reading deals x loss ${deals.reason}`,
            'checkClosedDeals',
            undefined,
            false,
            false,
            false,
          )
        }
        if (
          deals.data.result >= +closeAfterXloss &&
          this.data.status !== BotStatusEnum.closed
        ) {
          this.handleLog(
            `Close deal after X loss trigger, closed in loss: ${deals.data.result}, trigger: ${closeAfterXloss}`,
          )
          await this.stop(CloseDCATypeEnum.leave)
        }
      }
      if (useCloseAfterXwin && closeAfterXwin && checkNumber(closeAfterXwin)) {
        const deals = await this.dealsDb.countData({
          status: DCADealStatusEnum.closed,
          botId: this.botId,
          'profit.totalUsd': { $gt: 0 },
        } as any)
        if (deals.status === StatusEnum.notok) {
          return this.handleErrors(
            `Error reading deals x win ${deals.reason}`,
            'checkClosedDeals',
            undefined,
            false,
            false,
            false,
          )
        }
        if (
          deals.data.result >= +closeAfterXwin &&
          this.data.status !== BotStatusEnum.closed
        ) {
          this.handleLog(
            `Close deal after X win trigger, closed in profit: ${deals.data.result}, trigger: ${closeAfterXwin}`,
          )
          await this.stop(CloseDCATypeEnum.leave)
        }
      }
    }

    async afterDealClose(
      _dealId: string,
      _profit: { total: number; totalUsd: number },
    ) {
      return
    }

    removeOrdersByDeal(dealId: string) {
      const get = this.getOrdersByStatusAndDealId({ dealId })
      for (const o of get) {
        this.deleteOrder(o.clientOrderId)
      }
    }

    /**
     * Volume this deal still holds on the exchange, or 0.
     *
     * A deal that ends without a closing order leaves this on the venue. It is
     * the discriminator between "the deal finished" and "we walked away from an
     * open position", so both the deal event and the bot-stop warning key off
     * it rather than off the close type.
     */
    dealLeftOpenSize(deal: ExcludeDoc<Deal>): number {
      return dealLeftOpenSize(deal.size)
    }

    /**
     * Describe how a deal actually ended.
     *
     * A `canceled` deal that still holds volume was NOT closed: the position
     * stays on the exchange, unmanaged, with no take profit and no stop loss —
     * this is the ordinary outcome of stopping a bot whose `stopType` is
     * `leave`. Reporting that as "Deal closed" is what let an abandoned short
     * sit unwatched until the venue liquidated it, so name the outcome instead.
     */
    dealCloseEventDescription(deal: ExcludeDoc<Deal>): string {
      return dealCloseEventDescription(deal)
    }

    /**
     * Tell the user that a deal is being abandoned with volume still on the
     * exchange.
     *
     * The `leave` close path cancels the resting orders and returns without
     * reaching {@link DCABotHelper#processDealClose}, so nothing else records
     * that a live position was left behind. Deliberately a WARNING, not an
     * error: leaving a position is what the user asked for, and it must not
     * flip the bot into `error`. It must still reach them — that it never did
     * is the entire defect.
     *
     * A deal holding nothing stays silent; leaving an empty deal costs nothing.
     */
    async announceLeftOpenPosition(deal: ExcludeDoc<Deal>) {
      const left = this.dealLeftOpenSize(deal)
      if (!left || !this.shouldProceed()) {
        return
      }
      const message = leftOpenPositionMessage(deal)
      this.botEventDb.createData({
        userId: this.userId,
        botId: this.botId,
        event: 'Deal',
        botType: this.botType,
        description: message,
        paperContext: !!this.data?.paperContext,
        deal: deal._id,
        symbol: deal.symbol.symbol,
        type: MessageTypeEnum.warning,
      })
      await this.processError(
        this.botId,
        positionLeftOpen,
        // @ts-ignore
        this.data?.settings.type === DCATypeEnum.terminal,
        false,
        true,
        message,
        +new Date(),
        message,
        // User-initiated, so the throttle must not swallow it: stopping two
        // bots in a row has to report both positions, not just the first.
        true,
        deal.symbol.symbol,
      )
    }

    /**
     * Process deal close
     *
     * @param {string} dealId Id of the deal
     * @param {boolean} [reopen] Required to reopen deal. Default = true
     * @param {boolean} [cancel] Cancel deal orders. Default = true
     * @param {Order} [tpOrder] Take profit order to close deal
     */
    @IdMute(mutex, (botId: string) => `${botId}processDealClose`)
    async processDealClose(
      _botId: string,
      dealId: string,
      profit: { total: number; totalUsd: number },
      reopen = true,
      cancel = true,
      order?: Order,
    ): Promise<boolean> {
      this.removeDealFromStopLossMethods(dealId)
      DealStats.getInstance().removeStats({ event: 'removeStats', dealId })
      const deal = this.getDeal(dealId)
      this.pendingClose.delete(dealId)
      if (!deal) {
        this.handleWarn(`Deal ${dealId} not found in local deals`)
        return false
      }
      if (!this.combo) {
        const botUpdate = {
          dealsReduceForBot:
            this.data?.dealsReduceForBot?.filter(
              (d) => d.id !== deal.deal._id,
            ) ?? [],
        }
        if (this.data) {
          this.data.dealsReduceForBot = botUpdate.dealsReduceForBot
        }
        this.updateData(botUpdate)
        this.emit('bot settings update', botUpdate)
      }
      if (
        this.combo &&
        (deal.deal.status === DCADealStatusEnum.canceled ||
          profit.total === 0) &&
        deal.deal.feeBalance &&
        deal.deal.feeBalance > 0 &&
        !this.futures &&
        this.data
      ) {
        this.data.feeBalance = Math.max(0, deal.deal.feeBalance)
        this.updateData({ feeBalance: this.data.feeBalance })
      }
      const { symbol } = deal.deal.symbol

      if (!this.data?.settings.pair.includes(symbol)) {
        this.handleDebug(`Symbol ${symbol} not in settings. Unsubscribe`)
        const openDeals = this.getOpenDeals(false, symbol)
        if (!openDeals.length) {
          for (const [_, indicator] of this.indicators) {
            if (indicator.symbol === symbol) {
              this.sendIndicatorUnsubscribeEvent(
                indicator.id,
                indicator.room,
                indicator.cb,
              )
              this.indicators.delete(indicator.key)
            }
          }
          this.pairs.delete(symbol)
          this.unsubscribeFromExchangeInfo(symbol)
          this.unsubscribeFromUserFee(symbol)
          if (this.redisSubGlobal) {
            for (const pair of await this.redisSubKeys([symbol])) {
              this.redisSubGlobal.unsubscribe(pair, this.redisSubCb)
            }
          }
        }
      }

      const timer = this.closeDealTimer.get(dealId)
      if (timer) {
        clearTimeout(timer)
        this.closeDealTimer.delete(dealId)
      }
      this.deleteDeal(dealId)
      this.botUpdateStats(this.botId, deal)
      this.resetAssets()
      await this.updateBotDeals(this.botId, false)
      this.updateUsage(dealId || '', true)
      await this.checkDealsAllowedMethods()
      if (this.data) {
        if (this.data.notEnoughBalance?.orders) {
          for (const o of Object.keys(this.data.notEnoughBalance.orders)) {
            if (o.startsWith(dealId)) {
              delete this.data.notEnoughBalance.orders[o]
            }
          }
          this.checkNotEnoughBalanceErrors(this.botId)
        }
        if (cancel) {
          await this.cancelAllOrder(deal.deal.lastPrice, dealId, true)
          for (const o of this.getOrdersByStatusAndDealId({ dealId })) {
            this.partiallyFilledFilledSet.delete(o.clientOrderId)
          }
          this.removeOrdersByDeal(dealId)
        }
        if (
          this.data.status === BotStatusEnum.error &&
          this.data.previousStatus !== BotStatusEnum.closed
        ) {
          this.restoreFromRangeOrError()
        }
        if (deal) {
          this.updateDealLastTime(
            this.botId,
            'closed',
            +new Date(),
            deal.deal.symbol.symbol,
          )
          deal.deal.closeTime = order ? order.updateTime : +new Date()
          const set = await this.getAggregatedSettings(deal.deal)
          const read = await this.dealsDb.readData(
            { _id: deal.deal._id },
            { stats: 1 },
          )
          if (
            read.status === StatusEnum.ok &&
            read.data.result &&
            read.data.result.stats.trackTime !== 0
          ) {
            deal.deal.stats = read.data.result.stats
            let profitPerc =
              ((deal.deal.lastPrice - deal.deal.avgPrice) /
                deal.deal.avgPrice) *
              (set.futures
                ? set.marginType !== BotMarginTypeEnum.inherit
                  ? (set.leverage ?? 1)
                  : 1
                : 1)
            profitPerc =
              profitPerc *
              (1 -
                ((await this.getUserFee(deal.deal.symbol.symbol))?.taker ?? 0) *
                  2 *
                  (profitPerc > 0 ? 1 : -1))
            if (deal.deal.strategy === StrategyEnum.long) {
              if (
                profitPerc < 0 &&
                Math.abs(profitPerc) > deal.deal.stats.drawdownPercent
              ) {
                deal.deal.stats.drawdownPercent = Math.abs(profitPerc)
              }
              if (profitPerc > 0 && profitPerc > deal.deal.stats.runUpPercent) {
                deal.deal.stats.runUpPercent = profitPerc
              }
            } else {
              if (
                profitPerc < 0 &&
                Math.abs(profitPerc) > deal.deal.stats.runUpPercent
              ) {
                deal.deal.stats.runUpPercent = Math.abs(profitPerc)
              }
              if (
                profitPerc > 0 &&
                profitPerc > deal.deal.stats.drawdownPercent
              ) {
                deal.deal.stats.drawdownPercent = profitPerc
              }
            }
            this.saveDeal(deal, {
              closeTime: +new Date(),
              stats: deal.deal.stats,
            })
          } else {
            this.saveDeal(deal, {
              closeTime: +new Date(),
            })
          }

          if (this.shouldProceed()) {
            this.botEventDb.createData({
              userId: this.userId,
              botId: this.botId,
              event: 'Deal',
              botType: this.botType,
              description: this.dealCloseEventDescription(deal.deal),
              paperContext: !!this.data?.paperContext,
              deal: deal.deal._id,
              symbol: deal.deal.symbol.symbol,
            })
          }
          if (deal.deal.status === DCADealStatusEnum.closed) {
            this.sendDealClosedAlert(deal.deal, order)
          }
        }
        this.deleteDeal(dealId)

        this.updateDealLastPrices(
          this.botId,
          undefined,
          deal.deal.symbol.symbol,
        )
        const openDeals = this.getOpenDeals()
        await this.checkClosedDeals()
        await this.afterDealClose(dealId, profit)
        this.handleDebug(`Closed after TP is: ${this.closeAfterTpFilled}`)
        this.processedFilled.delete(dealId)
        this.feeProcessed.delete(dealId)
        if (openDeals.length === 0) {
          this.updateData({ unrealizedProfit: 0 })
        }
        if (this.closeAfterTpFilled) {
          if (openDeals.length === 0) {
            return true
          } else {
            return false
          }
        }
        if (!reopen) {
          this.handleDebug(`Not reopen after ${dealId}`)
        }
        if (reopen) {
          const settings = await this.getAggregatedSettings(deal.deal)
          const inRange = await this.checkInRange(deal.deal.symbol.symbol)
          if (inRange) {
            if (settings.startCondition === StartConditionEnum.asap) {
              if (
                !settings.useMulti &&
                openDeals.length !== 0 &&
                !settings.useDynamicPriceFilter
              ) {
                this.handleDebug(`Not open new ASAP deal ${dealId}`)
              } else {
                const usedSymbols = openDeals.map((d) => d.deal.symbol.symbol)
                const filtered = await this.filterCoinsByVolume(
                  this.botId,
                  settings.useMulti
                    ? (
                        await this.getSymbolsToOpenAsapDeals(
                          false,
                          false,
                          usedSymbols,
                        )
                      ).filter((s) => !usedSymbols.includes(s))
                    : [deal.deal.symbol.symbol],
                )
                if (filtered.length) {
                  if (!settings.useMulti && openDeals.length === 0) {
                    this.openNewDeal(this.botId, filtered[0])
                  }
                  if (
                    !settings.useMulti &&
                    openDeals.length !== 0 &&
                    settings.useDynamicPriceFilter
                  ) {
                    this.openNewDeal(this.botId, filtered[0])
                  }
                  if (settings.useMulti) {
                    for (const s of filtered) {
                      this.openNewDeal(this.botId, s)
                    }
                  }
                }
              }
            }
          } else if (
            !inRange &&
            !settings.useMulti &&
            settings.useStaticPriceFilter &&
            (!settings.useDynamicPriceFilter ||
              (settings.useDynamicPriceFilter && openDeals.length === 0))
          ) {
            this.handleDebug(`Set range after ${dealId}`)
            this.setRangeOrError()
          }
        }
      }
      return false
    }

    private async checkInDynamicRange(
      symbol: string,
      price?: number,
    ): Promise<boolean> {
      if (!this.allowedMethods.has('checkInDynamicRange')) {
        return true
      }
      const settings = await this.getAggregatedSettings()
      if (!settings.useDynamicPriceFilter) {
        return true
      }

      let overValue =
        parseFloat(settings.dynamicPriceFilterOverValue || '') ||
        parseFloat(settings.dynamicPriceFilterDeviation || '') ||
        0
      let underValue =
        parseFloat(settings.dynamicPriceFilterUnderValue || '') ||
        parseFloat(settings.dynamicPriceFilterDeviation || '') ||
        0

      if (
        isNaN(overValue) ||
        !isFinite(overValue) ||
        isNaN(underValue) ||
        !isFinite(underValue)
      ) {
        return true
      }
      overValue = Math.max(overValue, 0.5)
      underValue = Math.max(underValue, 0.5)
      let lastData = (this.data?.lastPricesPerSymbol ?? []).find(
        (d) => d.symbol === symbol,
      )
      if (!lastData) {
        return true
      }
      const lastStart = this.getDealsByStatusAndSymbol({
        symbol,
        status: DCADealStatusEnum.start,
      }).sort((a, b) => b.deal.createTime - a.deal.createTime)[0]
      if (
        lastStart &&
        lastData.time &&
        lastStart.deal.createTime > lastData.time
      ) {
        const findOrder = this.getOrdersByStatusAndDealId({
          dealId: lastStart.deal._id,
          status: ['NEW', 'PARTIALLY_FILLED'],
        })
          .filter((o) => o.typeOrder === TypeOrderEnum.dealStart)
          .sort((a, b) => b.updateTime - a.updateTime)[0]
        if (
          findOrder &&
          +findOrder.price &&
          !isNaN(+findOrder.price) &&
          isFinite(+findOrder.price)
        ) {
          lastData = {
            symbol,
            entry: +findOrder.price,
            avg: +findOrder.price,
            time: lastStart.deal.createTime,
          }
        }
      }
      const latestPrice = price || (await this.getLatestPrice(symbol))
      if (!latestPrice) {
        this.handleWarn(`Latest price not found for ${symbol}`)
        return false
      }
      const referencePrice =
        settings.dynamicPriceFilterPriceType ===
        DynamicPriceFilterPriceTypeEnum.avg
          ? lastData.avg
          : lastData.entry
      const calculatedOverValue =
        referencePrice + (referencePrice * overValue) / 100
      const calculatedUnderValue =
        referencePrice - (referencePrice * underValue) / 100
      if (settings.useNoOverlapDeals) {
        const openDeals = this.getDealsByStatusAndSymbol({
          symbol: symbol,
          status: DCADealStatusEnum.open,
        })
        if (openDeals.length > 0) {
          const ranges = openDeals.map((d) => ({
            start:
              (settings.dynamicPriceFilterPriceType ===
              DynamicPriceFilterPriceTypeEnum.avg
                ? d.deal.avgPrice ||
                  d.deal.settings.avgPrice ||
                  d.deal.initialPrice
                : d.deal.initialPrice) *
              (this.isLong
                ? settings.dynamicPriceFilterDirection ===
                    DynamicPriceFilterDirectionEnum.over ||
                  settings.dynamicPriceFilterDirection ===
                    DynamicPriceFilterDirectionEnum.overAndUnder
                  ? 1 + overValue / 100
                  : 1
                : settings.dynamicPriceFilterDirection ===
                      DynamicPriceFilterDirectionEnum.under ||
                    settings.dynamicPriceFilterDirection ===
                      DynamicPriceFilterDirectionEnum.overAndUnder
                  ? 1 - underValue / 100
                  : 1),
            end:
              (settings.dynamicPriceFilterPriceType ===
              DynamicPriceFilterPriceTypeEnum.avg
                ? d.deal.avgPrice ||
                  d.deal.settings.avgPrice ||
                  d.deal.initialPrice
                : d.deal.initialPrice) *
              (this.isLong
                ? settings.dynamicPriceFilterDirection ===
                    DynamicPriceFilterDirectionEnum.under ||
                  settings.dynamicPriceFilterDirection ===
                    DynamicPriceFilterDirectionEnum.overAndUnder
                  ? 1 - underValue / 100
                  : 1
                : settings.dynamicPriceFilterDirection ===
                      DynamicPriceFilterDirectionEnum.over ||
                    settings.dynamicPriceFilterDirection ===
                      DynamicPriceFilterDirectionEnum.overAndUnder
                  ? 1 + overValue / 100
                  : 1),
          }))
          const currentRange = {
            start: latestPrice,
            end: latestPrice,
          }
          const isCurrentDealRangeIsInRanges = ranges.some((r) => {
            const isInRange = this.isLong
              ? (currentRange.start <= r.start &&
                  currentRange.start >= r.end) ||
                (currentRange.end <= r.start && currentRange.end >= r.end)
              : (currentRange.start >= r.start &&
                  currentRange.start <= r.end) ||
                (currentRange.end >= r.start && currentRange.end <= r.end)
            return isInRange
          })
          if (isCurrentDealRangeIsInRanges) {
            this.handleDebug(
              `Dynamic range overlap with existing deals ${symbol} ${latestPrice} ${currentRange.start} ${currentRange.end}`,
            )
            return false
          }
        }
      }

      if (
        settings.dynamicPriceFilterDirection ===
          DynamicPriceFilterDirectionEnum.overAndUnder ||
        !settings.dynamicPriceFilterDirection
      ) {
        return (
          latestPrice > calculatedOverValue ||
          latestPrice < calculatedUnderValue
        )
      } else if (
        settings.dynamicPriceFilterDirection ===
        DynamicPriceFilterDirectionEnum.over
      ) {
        return latestPrice > calculatedOverValue
      } else if (
        settings.dynamicPriceFilterDirection ===
        DynamicPriceFilterDirectionEnum.under
      ) {
        return latestPrice < calculatedUnderValue
      }
      return false
    }

    /**
     * Check if deal in range
     * @param {number} [price] Price to check. Optional
     */

    async checkInRange(symbol: string, price?: number) {
      if (!this.data) {
        return false
      }
      if (!this.allowedMethods.has('checkInRange')) {
        return true
      }
      const settings = await this.getAggregatedSettings()

      if (settings.useMulti && !settings.useDynamicPriceFilter) {
        return true
      }
      const dynamic = await this.checkInDynamicRange(symbol, price)
      let staticResult = true
      if (settings.useStaticPriceFilter && !settings.useMulti) {
        let minOpenDeal = parseFloat(settings.minOpenDeal || '0')
        let maxOpenDeal = parseFloat(settings.maxOpenDeal || '0')
        minOpenDeal = isNaN(minOpenDeal) ? 0 : minOpenDeal
        maxOpenDeal = isNaN(maxOpenDeal) ? 0 : maxOpenDeal
        if (minOpenDeal === 0 && maxOpenDeal === 0) {
          return true
        }
        const latestPrice =
          price || (await this.getLatestPrice(this.data.settings.pair[0]))
        staticResult =
          (minOpenDeal !== 0 &&
            maxOpenDeal === 0 &&
            latestPrice > minOpenDeal) ||
          (maxOpenDeal !== 0 &&
            minOpenDeal === 0 &&
            latestPrice < maxOpenDeal) ||
          (minOpenDeal !== 0 &&
            maxOpenDeal !== 0 &&
            latestPrice > minOpenDeal &&
            latestPrice < maxOpenDeal) ||
          (minOpenDeal === 0 && maxOpenDeal === 0)
      }
      return dynamic && staticResult
    }

    private getIndicatorSignature(ind: SettingsIndicators) {
      return Object.entries(ind)
        .map(([k, v]) =>
          k === '_id' ? '' : `${k}: ${Array.isArray(v) ? v.join(', ') : v}`,
        )
        .join(', ')
    }

    @IdMute(mutex, (botId: string) => `${botId}saveIndicatorsData`)
    private async saveIndicatorsData(_botId: string, run = false) {
      if (!run) {
        if (this.saveIndicatorTimer) {
          clearTimeout(this.saveIndicatorTimer)
        }
        this.saveIndicatorTimer = setTimeout(
          () => this.saveIndicatorsData.bind(this)(this.botId, true),
          this.saveIndicatorTimeout,
        )
        return
      }
      const data: IndicatorsData[] = []
      const settings = await this.getAggregatedSettings()
      if (settings.startCondition !== StartConditionEnum.ti) {
        return
      }
      const sd = (settings?.indicators ?? []).filter(
        (i) => i.indicatorAction === IndicatorAction.startDeal,
      )
      if (sd.length === 0) {
        return
      }
      const intervals = sd.reduce(
        (acc, v) => acc.add(v.indicatorInterval),
        new Set<ExchangeIntervals>(),
      )
      const useMaxDealsPerSignal =
        intervals.size > 1
          ? typeof settings.useMaxDealsPerHigherTimeframe !== 'undefined'
            ? !!settings.useMaxDealsPerHigherTimeframe
            : true
          : false
      if (useMaxDealsPerSignal) {
        const highestInterval = Array.from(intervals).sort(
          (a, b) => timeIntervalMap[b] - timeIntervalMap[a],
        )?.[0]
        const indicatorsWithHighestInterval = sd.filter(
          (i) => i.indicatorInterval === highestInterval,
        )
        if (indicatorsWithHighestInterval.length * this.pairs.size <= 1000) {
          for (const i of indicatorsWithHighestInterval) {
            for (const symbol of this.pairs) {
              const ind = this.indicators.get(`${i.uuid}@${symbol}`)
              if (ind) {
                data.push({
                  signature: this.getIndicatorSignature(i),
                  uuid: i.uuid,
                  symbol,
                  status: ind.status,
                  statusSince: ind.statusSince,
                  statusTo: ind.statusTo,
                  numberOfSignals: ind.numberOfSignals,
                })
              }
              await sleep(0)
            }
            await sleep(0)
          }
        }
      }
      if (this.data) {
        this.data.indicatorsData = data
      }
      this.updateData({ indicatorsData: data })
    }

    async replaceBotSettings(botSettings: Schema['settings']) {
      if (this.data?.vars?.list?.length && this.data?.vars?.paths?.length) {
        for (const path of this.data.vars.paths) {
          const isIndicatorsPath = path.path.includes('indicators')
          const isDcaCustomPath = path.path.includes('dcaCustom')
          const isMultiTpPath = path.path.includes('multiTp')
          const isMultiSlPath = path.path.includes('multiSl')
          if (
            !isIndicatorsPath &&
            !isDcaCustomPath &&
            !isMultiTpPath &&
            !isMultiSlPath
          ) {
            const p = path.path as keyof Schema['settings']
            const v = botSettings[p]
            if (typeof v !== 'undefined') {
              botSettings[p] = await this.replaceInputVars(
                this.data.vars ?? { list: [], paths: [] },
                String(p),
                v,
              )
            }
          } else {
            const split = path.path.split('.')
            if (split.length === 3) {
              if (isIndicatorsPath) {
                const find = botSettings.indicators.find(
                  (i) => i.uuid === split[1],
                )
                if (find) {
                  const p = split[2] as keyof SettingsIndicators
                  let v = find[p]
                  if (typeof v !== 'undefined') {
                    v = await this.replaceInputVars(
                      this.data.vars,
                      path.path,
                      v,
                    )
                    //@ts-ignore
                    find[p] = v
                    botSettings.indicators = botSettings.indicators.map((i) =>
                      i.uuid === find.uuid ? find : i,
                    )
                  }
                }
              }
              if (isDcaCustomPath) {
                const find = (botSettings.dcaCustom ?? []).find(
                  (i) => i.uuid === split[1],
                )
                if (find) {
                  const p = split[2] as keyof DCACustom
                  let v = find[p]
                  if (typeof v !== 'undefined') {
                    v = await this.replaceInputVars(
                      this.data.vars,
                      path.path,
                      v,
                    )
                    //@ts-ignore
                    find[p] = v
                    botSettings.dcaCustom = (botSettings.dcaCustom ?? []).map(
                      (i) => (i.uuid === find.uuid ? find : i),
                    )
                  }
                }
              }
              if (isMultiTpPath) {
                const find = (botSettings.multiTp ?? []).find(
                  (i) => i.uuid === split[1],
                )
                if (find) {
                  const p = split[2] as keyof MultiTP
                  let v = find[p]
                  if (typeof v !== 'undefined') {
                    v = await this.replaceInputVars(
                      this.data.vars,
                      path.path,
                      v,
                    )
                    //@ts-ignore
                    find[p] = v
                    botSettings.multiTp = (botSettings.multiTp ?? []).map(
                      (i) => (i.uuid === find.uuid ? find : i),
                    )
                  }
                }
              }
              if (isMultiSlPath) {
                const find = (botSettings.multiSl ?? []).find(
                  (i) => i.uuid === split[1],
                )
                if (find) {
                  const p = split[2] as keyof MultiTP
                  let v = find[p]
                  if (typeof v !== 'undefined') {
                    v = await this.replaceInputVars(
                      this.data.vars,
                      path.path,
                      v,
                    )
                    //@ts-ignore
                    find[p] = v
                    botSettings.multiSl = (botSettings.multiSl ?? []).map(
                      (i) => (i.uuid === find.uuid ? find : i),
                    )
                  }
                }
              }
            }
          }
        }
      }
      return botSettings
    }
    @RunWithDelay(
      (
        botId: string,
        symbol: string,
        _lastData: IndicatorHistory,
        _interval?: ExchangeIntervals,
        section?: IndicatorSection,
        action?: IndicatorAction,
      ) => `${botId}${symbol}${section}${action}checkIndicatorStatus`,
      500,
    )
    @IdMute(
      mutex,
      (botId: string, symbol: string) =>
        `${botId}${symbol}checkIndicatorStatus`,
    )
    async checkIndicatorStatus(
      _botId: string,
      symbol: string,
      lastData: IndicatorHistory,
      interval?: ExchangeIntervals,
      section?: IndicatorSection,
      action?: IndicatorAction,
    ) {
      if (!this.data) {
        return
      }
      const lastTime =
        lastData.time + timeIntervalMap[interval ?? ExchangeIntervals.oneM]
      const settings = await this.getAggregatedSettings()
      const ps = settings.indicators
        ?.map((i) => this.indicators.get(`${i.uuid}@${symbol}`))
        .filter((i) => !!i) as LocalIndicators[]
      const allForSymbol = ps.filter(
        (i) =>
          !i.maCross &&
          i.action !== IndicatorAction.riskReward &&
          (this.scaleAr
            ? i.action !== IndicatorAction.startDca
            : this.tpAr
              ? !(
                  i.action === IndicatorAction.closeDeal &&
                  i.section !== IndicatorSection.sl
                )
              : this.slAr
                ? !(
                    i.action === IndicatorAction.closeDeal &&
                    i.section === IndicatorSection.sl
                  )
                : true),
      )
      // `allForSymbol` is built from the indicators currently held in
      // `this.indicators`, so a leg that is not loaded for this symbol (failed
      // `sendIndicatorSubscribeEvent`, or not warmed up yet after a re-arm)
      // silently disappears from its group. An `and` group is checked as
      // "every leg present is true", so the surviving legs alone can satisfy it
      // — e.g. `MA cross AND RSI < 100` collapses to the always-true RSI leg and
      // opens a deal whose real conditions were never met. Treat a group with a
      // configured-but-missing leg as unevaluable instead.
      const groupsWithMissingLeg = new Set<string>(
        (settings.indicators ?? [])
          .filter(
            (i) => !!i.groupId && !this.indicators.get(`${i.uuid}@${symbol}`),
          )
          .map((i) => i.groupId as string),
      )
      const allForSymbolCloseSl =
        action === IndicatorAction.closeDeal && section === IndicatorSection.sl
          ? allForSymbol.filter(
              (i) =>
                i.action === IndicatorAction.closeDeal &&
                i.section === IndicatorSection.sl,
            )
          : []
      const allForSymbolCloseTp =
        action === IndicatorAction.closeDeal && section !== IndicatorSection.sl
          ? allForSymbol.filter(
              (i) =>
                i.action === IndicatorAction.closeDeal &&
                i.section !== IndicatorSection.sl,
            )
          : []
      const allForSymbolStopBot =
        action === IndicatorAction.stopBot
          ? allForSymbol.filter((i) => i.action === IndicatorAction.stopBot)
          : []
      const allForSymbolStartBot =
        action === IndicatorAction.startBot
          ? allForSymbol.filter((i) => i.action === IndicatorAction.startBot)
          : []
      const allForSymbolOpen =
        action === IndicatorAction.startDeal
          ? allForSymbol.filter((i) => i.action === IndicatorAction.startDeal)
          : []
      const all = allForSymbol.filter(
        (i) => i.status && (i.statusTo ? i.statusTo >= +new Date() : true),
      )
      const allCloseSl =
        action === IndicatorAction.closeDeal && section === IndicatorSection.sl
          ? all.filter(
              (i) =>
                i.action === IndicatorAction.closeDeal &&
                i.section === IndicatorSection.sl,
            )
          : []
      const allCloseTp =
        action === IndicatorAction.closeDeal && section !== IndicatorSection.sl
          ? all.filter(
              (i) =>
                i.action === IndicatorAction.closeDeal &&
                i.section !== IndicatorSection.sl,
            )
          : []
      const allStopBot =
        action === IndicatorAction.stopBot
          ? all.filter((i) => i.action === IndicatorAction.stopBot)
          : []
      const allStartBot =
        action === IndicatorAction.startBot
          ? all.filter((i) => i.action === IndicatorAction.startBot)
          : []
      const allOpen =
        action === IndicatorAction.startDeal
          ? all.filter((i) => i.action === IndicatorAction.startDeal)
          : []
      const allOpenDCA =
        action === IndicatorAction.startDca
          ? all.filter((i) => i.action === IndicatorAction.startDca)
          : []
      const closeDealSlGroupsStatus = !allCloseSl.length
        ? []
        : this.indicatorGroupsToUse
            .filter(
              (ig) =>
                ig.action === IndicatorAction.closeDeal &&
                ig.section === IndicatorSection.sl,
            )
            .map((ig) => {
              const findAll = allForSymbolCloseSl.filter(
                (i) => i.groupId === ig.id,
              )
              const findAllStatus = allCloseSl.filter(
                (i) => i.groupId === ig.id,
              )
              return !!(ig.logic === IndicatorsLogicEnum.or
                ? findAllStatus.length > 0
                : findAll.length && findAll.length === findAllStatus.length)
            })
      if (
        (settings.stopDealSlLogic === IndicatorsLogicEnum.and ||
        !settings.stopDealSlLogic
          ? closeDealSlGroupsStatus.every((r) => !!r)
          : closeDealSlGroupsStatus.some((r) => !!r)) &&
        closeDealSlGroupsStatus.length !== 0
      ) {
        for (const ai of allForSymbolCloseSl) {
          const i = this.indicators.get(ai.key)
          if (i) {
            this.indicators.set(ai.key, {
              ...i,
              status: i.statusTo ? i.status : false,
            })
          }
        }
        if ((this.indicatorActions.closeDealSl.get(symbol) ?? 0) < lastTime) {
          this.indicatorActions.closeDealSl.set(symbol, lastTime)
          this.closeAllDeals(
            settings.closeDealType ?? CloseDCATypeEnum.closeByMarket,
            symbol,
            false,
            true,
            undefined,
            true,
            undefined,
            DCACloseTriggerEnum.sl,
          )
        }
      }
      const closeDealTpGroupsStatus = !allCloseTp.length
        ? []
        : this.indicatorGroupsToUse
            .filter(
              (ig) =>
                ig.action === IndicatorAction.closeDeal &&
                ig.section !== IndicatorSection.sl,
            )
            .map((ig) => {
              const findAll = allForSymbolCloseTp.filter(
                (i) => i.groupId === ig.id,
              )
              const findAllStatus = allCloseTp.filter(
                (i) => i.groupId === ig.id,
              )
              return !!(ig.logic === IndicatorsLogicEnum.or
                ? findAllStatus.length > 0
                : findAll.length && findAll.length === findAllStatus.length)
            })
      if (
        (settings.stopDealLogic === IndicatorsLogicEnum.and ||
        !settings.stopDealLogic
          ? closeDealTpGroupsStatus.every((r) => !!r)
          : closeDealTpGroupsStatus.some((r) => !!r)) &&
        closeDealTpGroupsStatus.length !== 0
      ) {
        for (const ai of allForSymbolCloseTp) {
          const i = this.indicators.get(ai.key)
          if (i) {
            this.indicators.set(ai.key, {
              ...i,
              status: i.statusTo ? i.status : false,
            })
          }
        }
        if ((this.indicatorActions.closeDealTp.get(symbol) ?? 0) < lastTime) {
          this.indicatorActions.closeDealTp.set(symbol, lastTime)
          this.closeAllDeals(
            settings.closeDealType ?? CloseDCATypeEnum.closeByMarket,
            symbol,
            true,
            true,
            undefined,
            undefined,
            undefined,
            DCACloseTriggerEnum.tp,
          )
        }
      }
      const stopBotGroupsStatus = !allStopBot.length
        ? []
        : this.indicatorGroupsToUse
            .filter((ig) => ig.action === IndicatorAction.stopBot)
            .map((ig) => {
              const findAll = allForSymbolStopBot.filter(
                (i) => i.groupId === ig.id,
              )
              const findAllStatus = allStopBot.filter(
                (i) => i.groupId === ig.id,
              )
              return !!(ig.logic === IndicatorsLogicEnum.or
                ? findAllStatus.length > 0
                : findAll.length && findAll.length === findAllStatus.length)
            })
      if (
        (settings.stopBotLogic === IndicatorsLogicEnum.and ||
        !settings.stopBotLogic
          ? stopBotGroupsStatus.every((r) => !!r)
          : stopBotGroupsStatus.some((r) => !!r)) &&
        stopBotGroupsStatus.length !== 0 &&
        this.data.status !== BotStatusEnum.monitoring
      ) {
        for (const ai of allForSymbolStopBot) {
          const i = this.indicators.get(ai.key)
          if (i) {
            this.indicators.set(ai.key, {
              ...i,
              status: i.statusTo ? i.status : false,
            })
          }
        }
        if ((this.indicatorActions.stopBot.get(symbol) ?? 0) < lastTime) {
          this.indicatorActions.stopBot.set(symbol, lastTime)
          await this.setStatus(
            this.botId,
            BotStatusEnum.closed,
            undefined,
            undefined,
            undefined,
            true,
          )
          if (
            this.data.settings.stopStatus === BotStatusEnum.monitoring &&
            (this.data.settings.botActualStart ===
              BotStartTypeEnum.indicators ||
              this.data.settings.botActualStart === BotStartTypeEnum.price)
          ) {
            this.setStatus(
              this.botId,
              BotStatusEnum.open,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true,
            )
          }
        }
      }
      const startBotGroupsStatus = !allStartBot.length
        ? []
        : this.indicatorGroupsToUse
            .filter((ig) => ig.action === IndicatorAction.startBot)
            .map((ig) => {
              const findAll = allForSymbolStartBot.filter(
                (i) => i.groupId === ig.id,
              )
              const findAllStatus = allStartBot.filter(
                (i) => i.groupId === ig.id,
              )
              return !!(ig.logic === IndicatorsLogicEnum.or
                ? findAllStatus.length > 0
                : findAll.length &&
                  findAll.length === findAllStatus.length &&
                  !groupsWithMissingLeg.has(ig.id))
            })
      if (
        (settings.startBotLogic === IndicatorsLogicEnum.and ||
        !settings.startBotLogic
          ? startBotGroupsStatus.every((r) => !!r)
          : startBotGroupsStatus.some((r) => !!r)) &&
        startBotGroupsStatus.length !== 0 &&
        this.data.status === BotStatusEnum.monitoring
      ) {
        for (const ai of allForSymbolStartBot) {
          const i = this.indicators.get(ai.key)
          if (i) {
            this.indicators.set(ai.key, {
              ...i,
              status: i.statusTo ? i.status : false,
            })
          }
        }
        if ((this.indicatorActions.startBot.get(symbol) ?? 0) < lastTime) {
          this.indicatorActions.startBot.set(symbol, lastTime)
          this.setStatus(
            this.botId,
            BotStatusEnum.open,
            undefined,
            undefined,
            undefined,
            true,
            undefined,
            true,
          )
        }
      }
      const openDealGroupsStatus = !allOpen.length
        ? []
        : this.indicatorGroupsToUse
            .filter((ig) => ig.action === IndicatorAction.startDeal)
            .map((ig) => {
              const findAll = allForSymbolOpen.filter(
                (i) => i.groupId === ig.id,
              )
              const findAllStatus = allOpen.filter((i) => i.groupId === ig.id)
              return !!(ig.logic === IndicatorsLogicEnum.or
                ? findAllStatus.length > 0
                : findAll.length &&
                  findAll.length === findAllStatus.length &&
                  !groupsWithMissingLeg.has(ig.id))
            })
      if (
        (settings.startDealLogic === IndicatorsLogicEnum.and ||
        !settings.startDealLogic
          ? openDealGroupsStatus.every((r) => !!r)
          : openDealGroupsStatus.some((r) => !!r)) &&
        openDealGroupsStatus.length !== 0 &&
        !(
          this.data?.status === BotStatusEnum.archive ||
          this.data.status === BotStatusEnum.closed ||
          (this.data?.status === BotStatusEnum.error &&
            this.data.previousStatus === BotStatusEnum.closed)
        )
      ) {
        const useMaxDealsPerSignal =
          (settings?.indicators ?? [])
            .filter((i) => i.indicatorAction === IndicatorAction.startDeal)
            .reduce(
              (acc, v) => acc.add(v.indicatorInterval),
              new Set<ExchangeIntervals>(),
            ).size > 1
            ? typeof settings.useMaxDealsPerHigherTimeframe !== 'undefined'
              ? !!settings.useMaxDealsPerHigherTimeframe
              : true
            : false
        const maxDealsPerSignal =
          typeof settings.useMaxDealsPerHigherTimeframe !== 'undefined'
            ? !settings.useMaxDealsPerHigherTimeframe
              ? Infinity
              : +(settings.maxDealsPerHigherTimeframe ?? '1')
            : 1
        const highestInterval = (settings.indicators ?? [])
          .filter((i) => i.indicatorAction === IndicatorAction.startDeal)
          .map((i) => i.indicatorInterval)
          .sort((a, b) => timeIntervalMap[b] - timeIntervalMap[a])?.[0]
        for (const ai of allForSymbolOpen) {
          const i = this.indicators.get(ai.key)
          if (i) {
            const maxNumberExceed =
              i.interval === highestInterval &&
              useMaxDealsPerSignal &&
              (i.numberOfSignals ?? 0) + 1 >= maxDealsPerSignal
            this.indicators.set(ai.key, {
              ...i,
              status: maxNumberExceed ? false : i.statusTo ? i.status : false,
              numberOfSignals: maxNumberExceed
                ? 0
                : i.interval === highestInterval
                  ? (i.numberOfSignals ?? 0) + 1
                  : i.numberOfSignals,
            })
          }
        }
        if ((this.indicatorActions.startDeal.get(symbol) ?? 0) < lastTime) {
          const cbIfNotOpened = () => {
            for (const ai of allForSymbolOpen) {
              const i = this.indicators.get(ai.key)
              if (i) {
                const maxNumberExceed =
                  i.interval === highestInterval &&
                  useMaxDealsPerSignal &&
                  Math.max(0, (i.numberOfSignals ?? 0) - 1) >= maxDealsPerSignal
                this.indicators.set(ai.key, {
                  ...i,
                  status: maxNumberExceed
                    ? false
                    : i.statusTo
                      ? i.statusTo > +new Date()
                        ? true
                        : i.status
                      : false,
                  numberOfSignals: maxNumberExceed
                    ? 0
                    : i.interval === highestInterval
                      ? Math.max(0, (i.numberOfSignals ?? 0) - 1)
                      : i.numberOfSignals,
                })
              }
            }
          }
          this.indicatorActions.startDeal.set(symbol, lastTime)
          if ((await this.filterCoinsByVolume(this.botId, [symbol])).length) {
            this.openNewDeal(
              this.botId,
              symbol,
              undefined,
              undefined,
              undefined,
              cbIfNotOpened,
            )
          }
        }
      }
      if (allOpenDCA.length) {
        const key = `${symbol}`
        if ((this.indicatorActions.dcaOrder.get(key) ?? 0) < lastTime) {
          this.indicatorActions.dcaOrder.set(key, lastTime)
          for (const i of allOpenDCA) {
            const ind = this.indicators.get(i.key)
            if (ind) {
              this.indicators.set(i.key, {
                ...ind,
                status: false,
              })
            }
            const index = (settings.indicators ?? [])
              .filter((ind) => ind.indicatorAction === IndicatorAction.startDca)
              .findIndex((si) => si.uuid === i.uuid)
            this.addDCAOrderByIndicator(
              this.botId,
              index,
              i.symbol,
              lastData.time,
            )
          }
        }
      }
      this.saveIndicatorsData(this.botId)
    }

    private convertNullToNan(obj: Record<string, unknown>) {
      for (const key in obj) {
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          this.convertNullToNan(obj[key] as Record<string, unknown>)
        } else if (obj[key] === null) {
          obj[key] = NaN
        }
      }
      return obj
    }

    /**
     * Check indicator condition
     */
    @IdMute(
      mutex,
      (
        botId: string,
        _uuid: string,
        _data: IndicatorHistory[],
        symbol: string,
      ) => `${botId}${symbol}checkIndicatorConditions`,
    )
    @IdMute(
      mutexIndicators,
      (botId: string) => `${botId}checkIndicatorConditions`,
    )
    async checkIndicatorConditions(
      _botId: string,
      uuid: string,
      data: IndicatorHistory[],
      symbol: string,
      is1d = false,
    ) {
      if (data.length === 0) {
        return
      }
      const key = `${uuid}@${symbol}`
      if (
        this.pairs.size < 100 &&
        this.indicators.size < 1000 &&
        !this.indicators.has(key) &&
        (this.data?.settings?.pair?.includes(symbol) || this.pairs.has(symbol))
      ) {
        this.handleDebug(
          `Indicator ${uuid}@${symbol} not connected yet, will be processed after`,
        )
        this.afterIndicatorsConnected.push(() =>
          this.checkIndicatorConditions(_botId, uuid, data, symbol, is1d),
        )

        if (this.scaleAr) {
          const find = this.data?.settings.indicators?.find(
            (ind) => ind.uuid === uuid,
          )
          if (find?.indicatorAction === IndicatorAction.startDca) {
            this.handleDebug(
              `AFTER | Scale DCA ${uuid}@${symbol} action: ${
                find?.indicatorAction
              }, data: ${data?.[(data?.length ?? 0) - 1]?.value}`,
            )
          }
        }
        return
      }
      const sortedByTime = [...data].sort((a, b) => b.time - a.time)
      const lastTime = sortedByTime[0].time

      if (this.lastIndicatorsDataMap.has(key)) {
        if ((this.lastIndicatorsDataMap.get(key) ?? lastTime) >= lastTime) {
          return
        }
      }
      let risk = false
      let dcaAr = false
      this.lastIndicatorsDataMap.set(key, lastTime)
      const settings = await this.getAggregatedSettings()
      if (this.data) {
        const [lastData, prevData] = sortedByTime
        const i = this.indicators.get(key)
        if (!i?.is1d && is1d) {
          return
        }
        let action = false
        let skipAction = false
        let trendFilterAction = false
        let lastDataString = ''
        let prevDataString = ''
        let trendValue: number | undefined
        let cont = false
        if (i) {
          i.data = true
          i.history = data
          this.indicators.set(key, i)
          if (i.maCross) {
            const parentIndicator = this.indicators.get(
              `${i.parentIndicator}@${symbol}`,
            )
            if (
              !parentIndicator ||
              !parentIndicator.history?.length ||
              !parentIndicator.data
            ) {
              cont = true
            } else {
              this.lastIndicatorsDataMap.delete(
                `${i.parentIndicator}@${symbol}`,
              )
              this.checkIndicatorConditions(
                this.botId,
                i.parentIndicator,
                parentIndicator.history,
                symbol,
              )
              cont = true
            }
          }
          if (i.childIndicator) {
            const childIndicator = this.indicators.get(
              `${i.childIndicator}@${symbol}`,
            )
            if (
              !childIndicator ||
              !childIndicator.history?.length ||
              !childIndicator.data
            ) {
              cont = true
            }
          }
          if (
            i.action !== IndicatorAction.riskReward &&
            !(this.scaleAr && i.action === IndicatorAction.startDca) &&
            !(
              this.tpAr &&
              i.action === IndicatorAction.closeDeal &&
              i.section !== IndicatorSection.sl
            ) &&
            !(
              this.slAr &&
              i.action === IndicatorAction.closeDeal &&
              i.section === IndicatorSection.sl
            ) &&
            !cont
          ) {
            i.data = false
            i.history = []
          }

          const find = settings.indicators?.find((ind) => ind.uuid === uuid)
          const showLog = this.indicators.size < 100
          if (find) {
            const {
              indicatorValue,
              indicatorCondition,
              type,
              checkLevel,
              signal,
              maUUID,
              maCrossingValue,
              maType,
              indicatorInterval,
              bbCrossingValue,
              stochUpper,
              stochLower,
              srCrossingValue,
              indicatorAction,
              stochRange,
              keepConditionBars,
              ecdTrigger,
              xoUUID,
              xOscillator1,
              percentile,
              divMinCount,
              divType,
              trendFilter,
              trendFilterType,
              stCondition,
              pcValue,
              ppValue,
              ppType,
              section,
              dcValue,
              obfvgRef,
              obfvgValue,
              lwValue,
              lwCondition,
            } = find
            if (indicatorAction === IndicatorAction.riskReward) {
              risk = true
              cont = true
            }
            if (this.scaleAr && indicatorAction === IndicatorAction.startDca) {
              this.handleDebug(
                `Scale DCA ${uuid}@${symbol} action: ${indicatorAction}, data: ${
                  data?.[(data?.length ?? 0) - 1]?.value
                }`,
              )
              dcaAr = true
              cont = true
            }
            if (
              this.tpAr &&
              indicatorAction === IndicatorAction.closeDeal &&
              section !== IndicatorSection.sl
            ) {
              dcaAr = true
              cont = true
            }
            if (
              this.slAr &&
              indicatorAction === IndicatorAction.closeDeal &&
              section === IndicatorSection.sl
            ) {
              dcaAr = true
              cont = true
            }
            if (!cont) {
              let { rsiValue, rsiValue2, valueInsteadof } = find
              rsiValue = rsiValue ?? rsiValueEnum.k
              rsiValue2 = rsiValue2 ?? rsiValue2Enum.d
              valueInsteadof = valueInsteadof ?? 1
              let value = indicatorValue !== undefined ? +indicatorValue : 0
              let prevValue = value
              if (type === IndicatorEnum.obfvg) {
                const [l, p] = [...data].sort((a, b) => b.time - a.time)
                const last = this.convertNullToNan(
                  l.value as OBFVGResult,
                ) as OBFVGResult
                const prev = this.convertNullToNan(
                  p.value as OBFVGResult,
                ) as OBFVGResult
                const lastBull =
                  obfvgRef === OBFVGRefEnum.high
                    ? last.bullishFVGHigh
                    : obfvgRef === OBFVGRefEnum.low
                      ? last.bullishFVGLow
                      : last.bullishFVGMiddle
                const lastBear =
                  obfvgRef === OBFVGRefEnum.high
                    ? last.bearishFVGHigh
                    : obfvgRef === OBFVGRefEnum.low
                      ? last.bearishFVGLow
                      : last.bearishFVGMiddle
                const prevBull =
                  obfvgRef === OBFVGRefEnum.high
                    ? prev.bullishFVGHigh
                    : obfvgRef === OBFVGRefEnum.low
                      ? prev.bullishFVGLow
                      : prev.bullishFVGMiddle
                const prevBear =
                  obfvgRef === OBFVGRefEnum.high
                    ? prev.bearishFVGHigh
                    : obfvgRef === OBFVGRefEnum.low
                      ? prev.bearishFVGLow
                      : prev.bearishFVGMiddle
                const lastPrice = last.price
                const prevPrice = prev.price
                const bullCd =
                  !isNaN(lastBull) &&
                  !isNaN(prevBull) &&
                  !isNaN(lastPrice) &&
                  !isNaN(prevPrice) &&
                  ((gt(prevPrice, prevBull) && lt(lastPrice, lastBull)) ||
                    (gt(prevPrice, prevBull) && lte(lastPrice, lastBull)))
                const bearCd =
                  !isNaN(lastBear) &&
                  !isNaN(prevBear) &&
                  !isNaN(lastPrice) &&
                  !isNaN(prevPrice) &&
                  ((gt(prevPrice, prevBear) && lt(lastPrice, lastBear)) ||
                    (gt(prevPrice, prevBear) && lte(lastPrice, lastBear)))
                const bullCu =
                  !isNaN(lastBull) &&
                  !isNaN(prevBull) &&
                  !isNaN(lastPrice) &&
                  !isNaN(prevPrice) &&
                  ((lt(prevPrice, prevBull) && gt(lastPrice, lastBull)) ||
                    (lt(prevPrice, prevBull) && gte(lastPrice, lastBull)))
                const bearCu =
                  !isNaN(lastBear) &&
                  !isNaN(prevBear) &&
                  !isNaN(lastPrice) &&
                  !isNaN(prevPrice) &&
                  ((lt(prevPrice, prevBear) && gt(lastPrice, lastBear)) ||
                    (lt(prevPrice, prevBear) && gte(lastPrice, lastBear)))
                const bullGt =
                  !isNaN(lastBull) &&
                  !isNaN(prevPrice) &&
                  gt(lastPrice, lastBull)
                const bearGt =
                  !isNaN(lastBear) &&
                  !isNaN(lastPrice) &&
                  gt(lastPrice, lastBear)
                const bullLt =
                  !isNaN(lastBull) &&
                  !isNaN(lastPrice) &&
                  lt(lastPrice, lastBull)
                const bearLt =
                  !isNaN(lastBear) &&
                  !isNaN(lastPrice) &&
                  lt(lastPrice, lastBear)

                action =
                  indicatorCondition === IndicatorStartConditionEnum.cd
                    ? obfvgValue === OBFVGValueEnum.bearish
                      ? bearCd
                      : obfvgValue === OBFVGValueEnum.any
                        ? bullCd || bearCd
                        : bullCd
                    : indicatorCondition === IndicatorStartConditionEnum.cu
                      ? obfvgValue === OBFVGValueEnum.bearish
                        ? bearCu
                        : obfvgValue === OBFVGValueEnum.any
                          ? bullCu || bearCu
                          : bullCu
                      : indicatorCondition === IndicatorStartConditionEnum.gt
                        ? obfvgValue === OBFVGValueEnum.bearish
                          ? bearGt
                          : obfvgValue === OBFVGValueEnum.any
                            ? bullGt || bearGt
                            : bullGt
                        : indicatorCondition === IndicatorStartConditionEnum.lt
                          ? obfvgValue === OBFVGValueEnum.bearish
                            ? bearLt
                            : obfvgValue === OBFVGValueEnum.any
                              ? bullLt || bearLt
                              : bullLt
                          : false
              } else if (type === IndicatorEnum.pc) {
                const pcCondition =
                  +(pcValue ?? '5') > 0
                    ? PCConditionEnum.up
                    : PCConditionEnum.down
                const [last] = [...data].sort((a, b) => b.time - a.time)
                action =
                  (pcCondition === PCConditionEnum.down &&
                    (last.value as PCResult).down) ||
                  (pcCondition === PCConditionEnum.up &&
                    (last.value as PCResult).up)
                if (action && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger action: up: ${
                      (last.value as PCResult).up
                    }, down: ${
                      (last.value as PCResult).down
                    }, condition: ${pcCondition}, last time ${new Date(
                      lastTime,
                    )?.toISOString()}`,
                  )
                }
              } else if (type === IndicatorEnum.lw) {
                const [ld, pd] = sortedByTime
                const last = this.convertNullToNan(
                  ld?.value as LongWickResult,
                ) as LongWickResult
                const prev = this.convertNullToNan(
                  pd?.value as LongWickResult,
                ) as LongWickResult
                if (last && prev) {
                  const useTop =
                    typeof lwValue === 'undefined' ||
                    lwValue === 'top' ||
                    lwValue === 'any'
                  const useBottom =
                    typeof lwValue === 'undefined' ||
                    lwValue === 'bottom' ||
                    lwValue === 'any'
                  const cond =
                    typeof lwCondition === 'undefined'
                      ? LWConditionEnum.during
                      : lwCondition
                  action =
                    (useTop &&
                      (cond === LWConditionEnum.during
                        ? !isNaN(last.bull)
                        : isNaN(prev.bull) && !isNaN(last.bull))) ||
                    (useBottom &&
                      (cond === LWConditionEnum.during
                        ? !isNaN(last.bear)
                        : isNaN(prev.bear) && !isNaN(last.bear)))
                }
              } else if (type === IndicatorEnum.st) {
                const [ld, pd] = sortedByTime
                const lastData = ld?.value as SuperTrendResult
                const prevData = pd?.value as SuperTrendResult
                action =
                  (stCondition === STConditionEnum.up &&
                    lastData?.direction === -1) ||
                  (stCondition === STConditionEnum.down &&
                    lastData?.direction === 1) ||
                  (stCondition === STConditionEnum.upToDown &&
                    prevData?.direction === -1 &&
                    lastData?.direction === 1) ||
                  (stCondition === STConditionEnum.downToUp &&
                    prevData?.direction === 1 &&
                    lastData?.direction === -1)
                if (action && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger action: ${indicatorAction}. ${
                      prevData.direction
                    }, ${lastData.direction}, ${prevData.value}, ${
                      lastData.value
                    }, last time ${new Date(lastTime)?.toISOString()}`,
                  )
                }
              } else if (type === IndicatorEnum.div) {
                const [lastData] = sortedByTime
                const result = lastData.value as DIVResult
                const min = +(divMinCount ?? 2)
                action = action =
                  ((divType === DivTypeEnum.bear ||
                    divType === DivTypeEnum.abear) &&
                    result.negdivergence >= min) ||
                  ((divType === DivTypeEnum.hbear ||
                    divType === DivTypeEnum.abear) &&
                    result.negdivergencehidden >= min) ||
                  ((divType === DivTypeEnum.bull ||
                    divType === DivTypeEnum.abull) &&
                    result.posdivergence >= min) ||
                  ((divType === DivTypeEnum.hbull ||
                    divType === DivTypeEnum.abull) &&
                    result.posdivergencehidden >= min)
                if (action && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger action: ${indicatorAction}. ${
                      result.negdivergence
                    }, ${result.negdivergencehidden}, ${result.posdivergence}, ${
                      result.posdivergencehidden
                    }, last time ${new Date(lastTime)?.toISOString()}`,
                  )
                }
              } else if (type === IndicatorEnum.qfl) {
                action = (lastData.value as QFLResult).action
                if (action && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger action: ${indicatorAction}, last time ${new Date(
                      lastTime,
                    )?.toISOString()}`,
                  )
                }
              } else if (type === IndicatorEnum.tv && checkLevel && signal) {
                /**
                 * TradingViews Technical Analysis
                 *
                 * Result:
                 *  - 0 - neutral
                 *
                 *  - 1 - Buy
                 *
                 *  - 2 - Strong buy
                 *
                 *  - 3 - Sell
                 *
                 *  - 4 - Strong sell
                 *
                 *  - 5 - No action (for useEntryExitPoints)
                 */
                const tvta = lastData.value as number
                if (
                  signal === TradingviewAnalysisSignalEnum.buy &&
                  tvta === 1
                ) {
                  action = true
                } else if (
                  signal === TradingviewAnalysisSignalEnum.strongBuy &&
                  tvta === 2
                ) {
                  action = true
                } else if (
                  signal === TradingviewAnalysisSignalEnum.bothBuy &&
                  (tvta === 2 || tvta === 1)
                ) {
                  action = true
                } else if (
                  signal === TradingviewAnalysisSignalEnum.sell &&
                  tvta === 3
                ) {
                  action = true
                } else if (
                  signal === TradingviewAnalysisSignalEnum.strongSell &&
                  tvta === 4
                ) {
                  action = true
                } else if (
                  signal === TradingviewAnalysisSignalEnum.bothSell &&
                  (tvta === 3 || tvta === 4)
                ) {
                  action = true
                }
                if (action && showLog) {
                  this.handleDebug(
                    `${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger. ${
                      tvta === 0
                        ? 'Neutral'
                        : tvta === 1
                          ? 'Buy'
                          : tvta === 2
                            ? 'Strong Buy'
                            : tvta === 3
                              ? 'Sell'
                              : tvta === 4
                                ? 'Strong Sell'
                                : 'No action'
                    } action: ${indicatorAction}, last time ${new Date(
                      lastTime,
                    )?.toISOString()}`,
                  )
                }
              } else if (type === IndicatorEnum.ecd && ecdTrigger) {
                /**
                 * Engulfing candle detector
                 *
                 * Result:
                 *  - 0 - na
                 *
                 *  - 1 - Bearish
                 *
                 *  - 2 - Bullish
                 *
                 */
                const [lastData] = sortedByTime
                const ecd = lastData.value as number
                if (
                  ecd === 1 &&
                  [ECDTriggerEnum.bearish, ECDTriggerEnum.both].includes(
                    ecdTrigger,
                  )
                ) {
                  action = true
                } else if (
                  ecd === 2 &&
                  [ECDTriggerEnum.bullish, ECDTriggerEnum.both].includes(
                    ecdTrigger,
                  )
                ) {
                  action = true
                }
                if (action && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger. ${
                      ecd === 1
                        ? 'Bearish'
                        : ecd === 2
                          ? 'Bullish'
                          : 'No action'
                    } action: ${indicatorAction}, last time ${new Date(
                      lastTime,
                    )?.toISOString()}`,
                  )
                }
              } else if (
                (indicatorValue !== undefined || type === IndicatorEnum.ma) &&
                indicatorCondition &&
                prevData
              ) {
                let last = 0
                let prev = 0
                let checkValue = true
                if (
                  (lastData.type === IndicatorEnum.rsi ||
                    lastData.type === IndicatorEnum.ao ||
                    lastData.type === IndicatorEnum.cci ||
                    lastData.type === IndicatorEnum.uo ||
                    lastData.type === IndicatorEnum.mom ||
                    lastData.type === IndicatorEnum.wr ||
                    lastData.type === IndicatorEnum.mfi ||
                    lastData.type === IndicatorEnum.adx ||
                    lastData.type === IndicatorEnum.bbw ||
                    lastData.type === IndicatorEnum.bbpb ||
                    lastData.type === IndicatorEnum.kcpb ||
                    lastData.type === IndicatorEnum.vo ||
                    lastData.type === IndicatorEnum.mar) &&
                  (prevData.type === IndicatorEnum.rsi ||
                    prevData.type === IndicatorEnum.ao ||
                    prevData.type === IndicatorEnum.cci ||
                    prevData.type === IndicatorEnum.uo ||
                    prevData.type === IndicatorEnum.mom ||
                    prevData.type === IndicatorEnum.wr ||
                    prevData.type === IndicatorEnum.mfi ||
                    prevData.type === IndicatorEnum.adx ||
                    prevData.type === IndicatorEnum.bbw ||
                    prevData.type === IndicatorEnum.bbpb ||
                    prevData.type === IndicatorEnum.kcpb ||
                    prevData.type === IndicatorEnum.vo ||
                    prevData.type === IndicatorEnum.mar)
                ) {
                  last = lastData.value.value
                  prev = prevData.value.value
                  if (percentile) {
                    const tmpValue = lastData.value.percentile
                    const tmpPrevValue = prevData.value.percentile
                    if (
                      typeof tmpValue === 'undefined' ||
                      typeof tmpPrevValue === 'undefined'
                    ) {
                      last = 0
                      prev = 0
                      value = 0
                      prevValue = 0
                    } else {
                      value = tmpValue
                      prevValue = tmpPrevValue
                    }
                  }
                  if (trendFilter) {
                    trendFilterAction =
                      (trendFilterType === TrendFilterOperatorEnum.lower &&
                        lastData.value.trend === 1) ||
                      (trendFilterType === TrendFilterOperatorEnum.higher &&
                        lastData.value.trend === 2) ||
                      (trendFilterType === TrendFilterOperatorEnum.between &&
                        lastData.value.trend === 3)
                    trendValue = lastData.value.trend
                  }
                }
                if (
                  lastData.type === IndicatorEnum.dc &&
                  prevData.type === IndicatorEnum.dc
                ) {
                  last = lastData.value.price
                  prev = prevData.value.price
                  value =
                    dcValue === DCValueEnum.lower
                      ? lastData.value.low
                      : dcValue === DCValueEnum.upper
                        ? lastData.value.high
                        : lastData.value.basis
                  prevValue =
                    dcValue === DCValueEnum.lower
                      ? prevData.value.low
                      : dcValue === DCValueEnum.upper
                        ? prevData.value.high
                        : prevData.value.basis
                }
                if (
                  lastData.type === IndicatorEnum.bbwp &&
                  prevData?.type === IndicatorEnum.bbwp
                ) {
                  last = lastData.value
                  prev = prevData.value
                }
                if (
                  lastData.type === IndicatorEnum.atr &&
                  prevData?.type === IndicatorEnum.atr
                ) {
                  last = lastData.value
                  prev = prevData.value
                }
                if (
                  lastData.type === IndicatorEnum.adr &&
                  prevData?.type === IndicatorEnum.adr
                ) {
                  last = lastData.value
                  prev = prevData.value
                }
                if (
                  lastData.type === IndicatorEnum.ath &&
                  prevData.type === IndicatorEnum.ath
                ) {
                  last = lastData.value
                  prev = prevData.value
                  value = Math.abs(+(indicatorValue ?? '70')) * -1
                  prevValue = value
                }
                if (
                  lastData.type === IndicatorEnum.macd &&
                  prevData?.type === IndicatorEnum.macd
                ) {
                  last = lastData.value.histogram
                  prev = prevData.value.histogram
                }
                if (
                  lastData.type === IndicatorEnum.ma &&
                  prevData?.type === IndicatorEnum.ma
                ) {
                  last = lastData.value.ma
                  prev = prevData.value.ma
                  if (maCrossingValue === MAEnum.price) {
                    value = lastData.value.price
                    prevValue = prevData.value.price
                  } else if (lastData.value.maType === maType) {
                    const maKey = `${maUUID}@${symbol}`
                    const findMA = this.indicators.get(maKey)
                    if (findMA) {
                      const data = [...findMA.history].sort(
                        (a, b) => b.time - a.time,
                      )
                      const prevMAData =
                        findMA.interval === i.interval
                          ? data.find((d) => d.time === prevData.time) ||
                            data[1] ||
                            0
                          : data[1]
                      const dataMA =
                        findMA.interval === i.interval
                          ? data.find((d) => d.time === lastData.time) ||
                            data[0] ||
                            0
                          : data[0]
                      prevValue = prevMAData
                        ? (prevMAData.value as MAResult).ma
                        : 0
                      findMA.data =
                        findMA.interval === i.interval ||
                        timeIntervalMap[findMA.interval] <
                          timeIntervalMap[i.interval]
                          ? false
                          : findMA.data
                      this.indicators.set(maKey, findMA)
                      value = dataMA ? (dataMA.value as MAResult).ma : 0
                      if (
                        (eq(prevValue, 0) && !eq(value, 0)) ||
                        (eq(value, 0) && !eq(prevValue, 0))
                      ) {
                        this.handleDebug(
                          `Indicator ${maKey} some values are zero: ${value} value, ${prevValue} prevValue | ${new Date(
                            lastData.time,
                          )}`,
                        )
                        value = 0
                        prevValue = 0
                      }
                    } else {
                      this.handleDebug(
                        `Indicator ${maKey} not found | ${new Date(
                          lastData.time,
                        )}`,
                      )
                      value = 0
                      prevValue = 0
                      last = 0
                      prev = 0
                    }
                  } else {
                    value = 0
                    prevValue = 0
                    last = 0
                    prev = 0
                  }
                }
                if (
                  find.type === IndicatorEnum.xo &&
                  lastData.type === xOscillator1 &&
                  prevData?.type === xOscillator1
                ) {
                  last = lastData.value.value
                  prev = prevData.value.value
                  const xoKey = `${xoUUID}@${symbol}`
                  const findXO = this.indicators.get(xoKey)
                  if (findXO) {
                    const [dataXO, prevXOData] = [...findXO.history].sort(
                      (a, b) => b.time - a.time,
                    )
                    prevValue = prevXOData
                      ? (prevXOData.value as PercentileResult).value
                      : 0
                    value = dataXO
                      ? (dataXO.value as PercentileResult).value
                      : 0
                    findXO.data =
                      findXO.interval === i.interval ||
                      timeIntervalMap[findXO.interval] <
                        timeIntervalMap[i.interval]
                        ? false
                        : findXO.data
                    this.indicators.set(xoKey, findXO)
                  } else {
                    last = 0
                    prev = 0
                    value = 0
                    prevValue = 0
                  }
                }
                if (
                  lastData.type === IndicatorEnum.psar &&
                  prevData.type === IndicatorEnum.psar
                ) {
                  last = lastData.value.price
                  prev = prevData.value.price
                  value = lastData.value.psar
                  prevValue = prevData.value.psar
                }
                if (
                  (lastData.type === IndicatorEnum.bb ||
                    lastData.type === IndicatorEnum.kc) &&
                  (prevData.type === IndicatorEnum.bb ||
                    prevData.type === IndicatorEnum.kc)
                ) {
                  last = lastData.value.price
                  prev = prevData.value.price
                  value =
                    bbCrossingValue === BBCrossingEnum.lower
                      ? lastData.value.result.lower
                      : bbCrossingValue === BBCrossingEnum.middle
                        ? lastData.value.result.middle
                        : lastData.value.result.upper
                  prevValue =
                    bbCrossingValue === BBCrossingEnum.lower
                      ? prevData.value.result.lower
                      : bbCrossingValue === BBCrossingEnum.middle
                        ? prevData.value.result.middle
                        : prevData.value.result.upper
                }
                if (type === IndicatorEnum.pp) {
                  const [ld, pd] = sortedByTime
                  const lastData = this.convertNullToNan(
                    ld.value as PriorPivotResult,
                  ) as PriorPivotResult
                  const prevData = this.convertNullToNan(
                    pd.value as PriorPivotResult,
                  ) as PriorPivotResult
                  if (!ppType || ppType === ppValueTypeEnum.price) {
                    last = lastData.price
                    prev = prevData.price
                    value =
                      ppValue === ppValueEnum.anyH
                        ? isNaN(lastData.hh)
                          ? lastData.lh
                          : lastData.hh
                        : ppValue === ppValueEnum.anyL
                          ? isNaN(lastData.ll)
                            ? lastData.hl
                            : lastData.ll
                          : ppValue === ppValueEnum.hh
                            ? lastData.hh
                            : ppValue === ppValueEnum.hl
                              ? lastData.hl
                              : ppValue === ppValueEnum.ll
                                ? lastData.ll
                                : lastData.lh
                    prevValue =
                      ppValue === ppValueEnum.anyH
                        ? isNaN(prevData.hh)
                          ? prevData.lh
                          : prevData.hh
                        : ppValue === ppValueEnum.anyL
                          ? isNaN(prevData.ll)
                            ? prevData.hl
                            : prevData.ll
                          : ppValue === ppValueEnum.hh
                            ? prevData.hh
                            : ppValue === ppValueEnum.hl
                              ? prevData.hl
                              : ppValue === ppValueEnum.ll
                                ? prevData.ll
                                : prevData.lh
                    if (isNaN(value) || isNaN(prevValue)) {
                      last = 0
                      prev = 0
                      value = 0
                      prevValue = 0
                    }
                  }
                  if (ppType === ppValueTypeEnum.event) {
                    skipAction = true
                    action =
                      ((ppValue === ppValueEnum.sBullCHoCH ||
                        ppValue === ppValueEnum.SanyBull ||
                        ppValue === ppValueEnum.bullAnyCHoCH) &&
                        lastData.sBullCHoCH) ||
                      ((ppValue === ppValueEnum.sBearCHoCH ||
                        ppValue === ppValueEnum.SanyBear ||
                        ppValue === ppValueEnum.bearAnyCHoCH) &&
                        lastData.sBearCHoCH) ||
                      ((ppValue === ppValueEnum.sBullBoS ||
                        ppValue === ppValueEnum.SanyBull ||
                        ppValue === ppValueEnum.bullAnyBoS) &&
                        lastData.sBullBoS) ||
                      ((ppValue === ppValueEnum.sBearBoS ||
                        ppValue === ppValueEnum.SanyBear ||
                        ppValue === ppValueEnum.bearAnyBoS) &&
                        lastData.sBearBoS) ||
                      ((ppValue === ppValueEnum.iBullCHoCH ||
                        ppValue === ppValueEnum.IanyBull ||
                        ppValue === ppValueEnum.bullAnyCHoCH) &&
                        lastData.iBullCHoCH) ||
                      ((ppValue === ppValueEnum.iBearCHoCH ||
                        ppValue === ppValueEnum.IanyBear ||
                        ppValue === ppValueEnum.bearAnyCHoCH) &&
                        lastData.iBearCHoCH) ||
                      ((ppValue === ppValueEnum.iBullBoS ||
                        ppValue === ppValueEnum.IanyBull ||
                        ppValue === ppValueEnum.bullAnyBoS) &&
                        lastData.iBullBoS) ||
                      ((ppValue === ppValueEnum.iBearBoS ||
                        ppValue === ppValueEnum.IanyBear ||
                        ppValue === ppValueEnum.bearAnyBoS) &&
                        lastData.iBearBoS)
                    if (action && showLog) {
                      this.handleDebug(
                        `${uuid}@${type}@${indicatorInterval}@${this.data.exchange}@${symbol} trigger. Action: ${ppValue}`,
                      )
                    }
                  }
                  if (ppType === ppValueTypeEnum.market) {
                    skipAction = true
                    action =
                      (ppValue === ppValueEnum.bullMarket &&
                        lastData.market === 'bull') ||
                      (ppValue === ppValueEnum.bearMarket &&
                        lastData.market === 'bear')
                    if (action && showLog) {
                      this.handleDebug(
                        `${uuid}@${type}@${indicatorInterval}@${this.data.exchange}@${symbol} trigger. Action: ${ppValue}`,
                      )
                    }
                  }
                }
                if (
                  (lastData.type === IndicatorEnum.stoch &&
                    prevData.type === IndicatorEnum.stoch) ||
                  (lastData.type === IndicatorEnum.stochRSI &&
                    prevData.type === IndicatorEnum.stochRSI)
                ) {
                  if (rsiValue === rsiValueEnum.k) {
                    last = lastData.value.stochK
                    prev = prevData.value.stochK
                  } else if (rsiValue === rsiValueEnum.d) {
                    last = lastData.value.stochD
                    prev = prevData.value.stochD
                  }
                  if (rsiValue2 === rsiValue2Enum.d) {
                    value = lastData.value.stochD
                    prevValue = prevData.value.stochD
                  } else if (rsiValue2 === rsiValue2Enum.k) {
                    value = lastData.value.stochK
                    prevValue = prevData.value.stochK
                  } else if (rsiValue2 === rsiValue2Enum.custom) {
                    value = valueInsteadof
                    prevValue = valueInsteadof
                    checkValue = false
                  }
                }
                if (
                  lastData.type === IndicatorEnum.sr &&
                  prevData.type === IndicatorEnum.sr
                ) {
                  last = lastData.value.price
                  prev = prevData.value.price
                  value =
                    srCrossingValue === SRCrossingEnum.resistance
                      ? lastData.value.high
                      : lastData.value.low
                  prevValue =
                    srCrossingValue === SRCrossingEnum.resistance
                      ? lastData.value.high
                      : lastData.value.low
                }
                lastDataString = `${last}`
                prevDataString = `${prev}`
                if (
                  (indicatorCondition === IndicatorStartConditionEnum.cu ||
                    indicatorCondition === IndicatorStartConditionEnum.cd) &&
                  data.length < 2
                ) {
                  this.handleDebug(
                    `Not enough data to count crossing down/up. Wait for next tick`,
                  )
                }

                if (
                  (indicatorCondition === IndicatorStartConditionEnum.cu ||
                    indicatorCondition === IndicatorStartConditionEnum.cd) &&
                  data.length >= 2 &&
                  !skipAction
                ) {
                  if (indicatorCondition === IndicatorStartConditionEnum.cd) {
                    action =
                      (gt(value, last) && lt(prevValue, prev)) ||
                      (gt(value, last) && lte(prevValue, prev))
                  }
                  if (indicatorCondition === IndicatorStartConditionEnum.cu) {
                    action =
                      (lt(value, last) && gt(prevValue, prev)) ||
                      (lt(value, last) && gte(prevValue, prev))
                  }
                }
                if (
                  indicatorCondition === IndicatorStartConditionEnum.gt &&
                  !skipAction
                ) {
                  action = gt(last, value)
                }
                if (
                  indicatorCondition === IndicatorStartConditionEnum.lt &&
                  !skipAction
                ) {
                  action = lt(last, value)
                }

                if (
                  ((lastData.type === IndicatorEnum.stoch &&
                    prevData.type === IndicatorEnum.stoch) ||
                    (lastData.type === IndicatorEnum.stochRSI &&
                      prevData.type === IndicatorEnum.stochRSI)) &&
                  action &&
                  checkValue &&
                  stochRange !== StochRangeEnum.none
                ) {
                  const upper =
                    stochRange === StochRangeEnum.lower
                      ? 100
                      : stochRange === StochRangeEnum.upper
                        ? +(stochLower ?? '')
                        : +(stochUpper ?? '')
                  const lower =
                    stochRange === StochRangeEnum.upper
                      ? 0
                      : stochRange === StochRangeEnum.lower
                        ? +(stochUpper ?? '')
                        : +(stochLower ?? '')
                  action =
                    !isNaN(upper) &&
                    !isNaN(lower) &&
                    ((last > upper &&
                      value > upper &&
                      prev > upper &&
                      prevValue > upper) ||
                      (last < lower &&
                        value < lower &&
                        prev < lower &&
                        prevValue < lower))
                }
                if (trendFilter) {
                  action = trendFilterAction && action
                }
                if (action && !trendFilter && !skipAction && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger. ${type} prev: ${prevDataString}, value prev: ${prevValue}, ${type} last: ${lastDataString}, value last: ${value} action: ${indicatorAction}, last time ${new Date(
                      lastTime,
                    )?.toISOString()}`,
                  )
                }
                if (action && trendFilter && !skipAction && showLog) {
                  this.handleDebug(
                    `${uuid}@${type}@${indicatorInterval}@${
                      this.data.exchange
                    }@${symbol} trigger. ${type} prev: ${prevDataString}, value prev: ${prevValue}, ${type} last: ${lastDataString}, value last: ${value} action: ${indicatorAction} ${type} trend value ${trendValue}, type: ${trendFilterType}, last time ${new Date(
                      lastTime,
                    )?.toISOString()}`,
                  )
                }
              }
              const toMultiplier = this.convertToMultiplier(keepConditionBars)
              const step = timeIntervalMap[indicatorInterval]
              if (i.statusTo && i.statusTo < lastData.time + step) {
                i.statusTo = undefined
                i.statusSince = undefined
              }
              if (toMultiplier !== 0) {
                if (action) {
                  i.statusSince = lastData.time + step
                  i.statusTo = lastData.time + step * (2 + toMultiplier) - 1
                  if (i.statusTo < +new Date()) {
                    this.handleDebug(
                      `Indicator ${uuid}@${symbol} statusTo (${new Date(
                        i.statusTo,
                      )}) < now (${new Date()}). Adding step (${step}) to statusTo`,
                    )
                    i.statusTo += step
                  }
                  i.status = true
                } else {
                  if (i.statusSince && i.statusTo) {
                    i.statusSince += step
                    if (i.statusSince > i.statusTo) {
                      i.status = false
                      i.statusSince = undefined
                      i.statusTo = undefined
                      i.statusTo = i.statusSince
                    } else {
                      i.status = true
                    }
                  } else {
                    i.status = action
                    i.statusTo = lastData.time + step * 2 - 1
                  }
                }
              } else {
                i.status = action
                i.statusTo = lastData.time + step * 2 - 1
              }
              this.indicators.set(key, i)
            }
          }
        }

        if (
          this.data.settings.useRiskReward &&
          this.indicators.get(key) &&
          this.data.settings.startCondition === StartConditionEnum.asap &&
          risk
        ) {
          return this.openNewDeal(this.botId, symbol)
        }
        if (
          (this.scaleAr || this.tpAr || this.slAr) &&
          this.indicators.get(key) &&
          this.data.settings.startCondition === StartConditionEnum.asap &&
          dcaAr &&
          (this.data.settings.type !== DCATypeEnum.terminal
            ? this.getOpenDeals(false, symbol).length === 0
            : this.data.deals.all === 0)
        ) {
          return this.openNewDeal(this.botId, symbol)
        }
        this.checkIndicatorStatus(
          this.botId,
          symbol,
          lastData,
          i?.interval,
          i?.section,
          i?.action,
        )
      }
    }

    @IdMute(mutexDCAOrdersByIndicator, () => 'addDCAOrderByIndicator')
    private async addDCAOrderByIndicator(
      _botId: string,
      index: number,
      symbol: string,
      time: number,
    ) {
      const key = `${symbol}@${index}@${time}`
      if (this.dcaOrdersBySignal.has(key)) {
        this.handleDebug(
          `DCA Signals | Received add DCA signal for index ${index}@${symbol}@${new Date(
            time,
          ).toISOString()}, key already processed `,
        )
        return
      }
      const deals = this.getDealsByStatusAndSymbol({
        status: DCADealStatusEnum.open,
        symbol,
      }).filter((d) => d.deal.levels.complete === index + 1)
      this.handleDebug(
        `DCA Signals | Received add DCA signal for index ${index}@${symbol}@${new Date(
          time,
        ).toISOString()}, found ${deals.length} deals`,
      )
      if (deals.length) {
        const others = this.dcaOrdersBySignal.keys()
        for (const k of others) {
          if (!k.startsWith(`${symbol}@${index}`)) {
            continue
          }
          const [s, i, t] = k.split('@')
          if (s === symbol && +i === index) {
            if (+t < time) {
              this.dcaOrdersBySignal.delete(k)
            }
          }
        }
        this.dcaOrdersBySignal.add(key)
      }
      for (const d of deals) {
        const settings = await this.getAggregatedSettings(d.deal)
        if (settings.dcaCondition !== DCAConditionEnum.indicators) {
          this.handleDebug(
            `DCA Signals | deal ${d.deal._id} not started dca orders by signal`,
          )
          continue
        }
        const ind = (this.data?.settings?.indicators ?? []).filter(
          (i) => i.indicatorAction === IndicatorAction.startDca,
        )[index]
        const price = await this.getLatestPrice(symbol)
        if (ind) {
          const { minPercFromLast } = ind
          if (minPercFromLast && !isNaN(+minPercFromLast)) {
            const diff = this.isLong
              ? d.deal.lastPrice - price
              : price - d.deal.lastPrice
            const absDiff = diff / d.deal.lastPrice

            if (absDiff >= +minPercFromLast / 100) {
              const orders = await this.createInitialDealOrders(
                symbol,
                d.deal.initialPrice,
                d.deal._id,
                d.deal,
                price,
              )
              const dcaOrder = orders.find((o) => o.levelNumber === index + 1)
              const ed = await this.getExchangeInfo(symbol)
              if (dcaOrder && ed) {
                if (!this.futures) {
                  const quote = dcaOrder.qty * price
                  if (quote < ed.quoteAsset.minAmount) {
                    dcaOrder.qty = this.math.round(
                      ed.quoteAsset.minAmount / price,
                      await this.baseAssetPrecision(ed.pair),
                      false,
                      true,
                    )
                  }
                  dcaOrder.price = this.math.round(
                    price,
                    ed.priceAssetPrecision,
                  )
                }
                const order = await this.sendGridToExchange(
                  dcaOrder,
                  {
                    dealId: d.deal._id,
                    type: 'MARKET',
                    positionSide: this.hedge
                      ? this.isLong
                        ? PositionSide.LONG
                        : PositionSide.SHORT
                      : PositionSide.BOTH,
                  },
                  ed,
                )
                if (
                  order &&
                  (order.status === 'FILLED' ||
                    (order.exchange === ExchangeEnum.bybit &&
                      (order.status === 'CANCELED' ||
                        order.status === 'PARTIALLY_FILLED')))
                ) {
                  this.processFilledOrder(order)
                }
              }
            } else {
              this.handleDebug(
                `DCA Signals | calculated precent ${
                  absDiff * 100
                } less than target ${minPercFromLast}`,
              )
            }
          }
        } else {
          this.handleDebug(
            `DCA Signals | Cannot find indicator ${index}@${symbol}`,
          )
        }
      }
    }

    async checkMaxDealsPerPair(symbol: string) {
      if (!this.allowedMethods.has('checkMaxDealsPerPair')) {
        return true
      }
      const settings = await this.getAggregatedSettings()
      if (this.useMaxDealsPerSymbolOverAndUnder) {
        const deals = this.getOpenDeals(true, symbol)
        if (!deals.length) {
          return true
        }
        const firstDeal = deals.sort(
          (a, b) => a.deal.createTime - b.deal.createTime,
        )[0]
        if (!firstDeal) {
          return true
        }
        const overDeals = deals.filter(
          (d) =>
            d.deal._id !== firstDeal.deal._id &&
            d.deal.initialPrice >= firstDeal.deal.initialPrice,
        )
        const underDeals = deals.filter(
          (d) =>
            d.deal._id !== firstDeal.deal._id &&
            d.deal.initialPrice < firstDeal.deal.initialPrice,
        )
        const maxDealsOver = +(settings.maxDealsOverPerSymbol || '1') || 1
        const maxDealsUnder = +(settings.maxDealsUnderPerSymbol || '1') || 1
        const latestPrice = await this.getLatestPrice(symbol)
        if (!latestPrice) {
          this.handleErrors(
            `Latest price is 0`,
            'checkMaxDealsPerPair()',
            'Get latest price',
            false,
            false,
            false,
          )
          return false
        }
        this.handleDebug(
          `Max Deals Per Symbol Over and Under | Over deals: ${overDeals.length}, Under deals: ${underDeals.length}, Max Over: ${maxDealsOver}, Max Under: ${maxDealsUnder}, Latest price: ${latestPrice}, First deal price: ${firstDeal.deal.initialPrice}`,
        )
        const isGoingToBeOver = latestPrice >= firstDeal.deal.initialPrice
        if (isGoingToBeOver) {
          this.handleDebug(
            `Max Deals Per Symbol Over and Under | Latest price is going to be over first deal price`,
          )
        } else {
          this.handleDebug(
            `Max Deals Per Symbol Over and Under | Latest price is going to be under first deal price`,
          )
        }
        if (isGoingToBeOver) {
          const key = `${symbol}-over`
          const pendingDeals = this.pendingDealsPerPair.get(key) ?? 0
          if (overDeals.length + pendingDeals < maxDealsOver) {
            this.pendingDealsPerPair.set(key, pendingDeals + 1)
            return true
          } else {
            return false
          }
        } else {
          const key = `${symbol}-under`
          const pendingDeals = this.pendingDealsPerPair.get(key) ?? 0
          if (underDeals.length + pendingDeals < maxDealsUnder) {
            this.pendingDealsPerPair.set(key, pendingDeals + 1)
            return true
          } else {
            return false
          }
        }
      }
      if (
        settings.useMulti &&
        settings.maxDealsPerPair &&
        settings.maxDealsPerPair !== ''
      ) {
        const max = +settings.maxDealsPerPair
        if (!isNaN(max) && max >= 0) {
          const deals = this.getOpenDeals(false, symbol)
          const symbolDealsLength = deals.length
          const pendingDeals = this.pendingDealsPerPair.get(symbol) ?? 0
          if (symbolDealsLength + pendingDeals < max) {
            this.pendingDealsPerPair.set(symbol, (pendingDeals ?? 0) + 1)
            return true
          }
          this.handleDebug(
            `Exceed max amount of active deals by max deals per pair ${symbol}`,
          )
          return false
        }
      }
      return true
    }
    get useMaxDealsOverAndUnder() {
      return (
        !this.data?.settings.useMulti &&
        this.data?.settings?.useDynamicPriceFilter &&
        this.data?.settings?.dynamicPriceFilterDirection ===
          DynamicPriceFilterDirectionEnum.overAndUnder &&
        this.data?.settings.useSeparateMaxDealsOverAndUnder
      )
    }
    get useMaxDealsPerSymbolOverAndUnder() {
      return (
        this.data?.settings.useMulti &&
        this.data?.settings?.useDynamicPriceFilter &&
        this.data?.settings?.dynamicPriceFilterDirection ===
          DynamicPriceFilterDirectionEnum.overAndUnder &&
        this.data?.settings.useSeparateMaxDealsOverAndUnderPerSymbol
      )
    }
    /**
     * Check max amount of active deals
     */
    @IdMute(mutex, (botId: string) => `checkMaxDeals${botId}`)
    async checkMaxDeals(_botId: string, symbol: string) {
      if (!this.allowedMethods.has('checkMaxDeals')) {
        return true
      }
      const settings = await this.getAggregatedSettings()
      if (this.useMaxDealsOverAndUnder) {
        const deals = this.getOpenDeals(true)
        if (!deals.length) {
          return true
        }
        const firstDeal = deals.sort(
          (a, b) => a.deal.createTime - b.deal.createTime,
        )[0]
        if (!firstDeal) {
          return true
        }
        const overDeals = deals.filter(
          (d) =>
            d.deal._id !== firstDeal.deal._id &&
            d.deal.initialPrice >= firstDeal.deal.initialPrice,
        )
        const underDeals = deals.filter(
          (d) =>
            d.deal._id !== firstDeal.deal._id &&
            d.deal.initialPrice < firstDeal.deal.initialPrice,
        )
        const maxDealsOver = +(settings.maxDealsOver || '1') || 1
        const maxDealsUnder = +(settings.maxDealsUnder || '1') || 1
        const latestPrice = await this.getLatestPrice(symbol)
        if (!latestPrice) {
          this.handleErrors(
            `Latest price is 0`,
            'checkMaxDeals()',
            'Get latest price',
            false,
            false,
            false,
          )
          return false
        }
        this.handleDebug(
          `Max Deals Over and Under | Over deals: ${overDeals.length}, Under deals: ${underDeals.length}, Max Over: ${maxDealsOver}, Max Under: ${maxDealsUnder}, Latest price: ${latestPrice}, First deal price: ${firstDeal.deal.initialPrice}`,
        )
        const isGoingToBeOver = latestPrice >= firstDeal.deal.initialPrice
        if (isGoingToBeOver) {
          this.handleDebug(
            `Max Deals Over and Under | Latest price is going to be over first deal price`,
          )
        } else {
          this.handleDebug(
            `Max Deals Over and Under | Latest price is going to be under first deal price`,
          )
        }
        if (isGoingToBeOver) {
          if (overDeals.length + this.pendingDealsOver < maxDealsOver) {
            this.pendingDealsOver += 1
            return true
          } else {
            return false
          }
        } else {
          if (underDeals.length + this.pendingDealsUnder < maxDealsUnder) {
            this.pendingDealsUnder += 1
            return true
          } else {
            return false
          }
        }
      }

      if (
        settings.maxNumberOfOpenDeals &&
        settings.maxNumberOfOpenDeals !== ''
      ) {
        const max = +settings.maxNumberOfOpenDeals
        if (!isNaN(max) && max >= 0) {
          const deals = this.getOpenDeals(settings.ignoreStartDeals)
          const dealsLength = deals.length
          if (dealsLength + this.pendingDeals < max) {
            if (await this.checkMaxDealsPerPair(symbol)) {
              this.pendingDeals += 1
              return true
            } else {
              return false
            }
          }
          this.handleDebug(
            `Exceed max amount of active deals by max deals ${symbol}`,
          )
          return false
        }
      }
      if (await this.checkMaxDealsPerPair(symbol)) {
        this.pendingDeals += 1
        return true
      } else {
        return false
      }
    }

    private isNotionalReason(text: string): boolean {
      for (const r of notionalReasons) {
        if (text.toLowerCase().indexOf(r.toLowerCase()) !== -1) {
          return true
        }
      }
      return false
    }

    private isPositionAlreadyClosedReason(text: string): boolean {
      const haystack = normalizeReason(text)
      for (const r of positionAlreadyClosedReasons) {
        if (haystack.indexOf(normalizeReason(r)) !== -1) {
          return true
        }
      }
      return false
    }

    private isLimitOnlyReason(text: string): boolean {
      const haystack = normalizeReason(text)
      for (const r of limitOnlyReasons) {
        if (haystack.indexOf(normalizeReason(r)) !== -1) {
          return true
        }
      }
      return false
    }

    async prepareTpOrder(
      findDeal: FullDeal<ExcludeDoc<Deal>>,
      slSource = false,
      sl = false,
    ) {
      const symbol = await this.getExchangeInfo(findDeal.deal.symbol.symbol)
      const priceRequest = await this.getLatestPrice(symbol?.pair ?? '')
      if (priceRequest === 0) {
        return this.handleErrors(
          'Latest price = 0',
          'placeBaseOrder()',
          'Get latest price',
          false,
          false,
          false,
        )
      }
      const tpOrder = (
        await this.getTPOrder(
          findDeal.deal.symbol.symbol,
          priceRequest,
          findDeal.initialOrders,
          findDeal.deal.avgPrice,
          findDeal.deal.initialPrice,
          findDeal.deal._id,
          findDeal.deal,
          !slSource,
          slSource,
          priceRequest,
        )
      )?.sort((a, b) =>
        this.isLong ? b.price - a.price : a.price - b.price,
      )?.[0]
      if (tpOrder) {
        const symbol = await this.getExchangeInfo(findDeal.deal.symbol.symbol)
        if (symbol) {
          if (
            this.combo &&
            this.coinm &&
            !this.isBitget &&
            Math.max(
              1,
              this.math.round(
                (tpOrder.qty * tpOrder.price) /
                  (symbol?.quoteAsset?.minAmount ?? 1),
                0,
              ),
            ) < 1
          ) {
            return this.handleDebug(
              `Combo coinm TP order less than 1 contract, skipping`,
            )
          }
          if (!this.isLong && !this.futures) {
            const fee =
              (await this.getUserFee(findDeal.deal.symbol.symbol))?.taker ?? 0
            const precision = await this.baseAssetPrecision(
              findDeal.deal.symbol.symbol,
            )
            const quote = this.math.round(
              findDeal.deal.currentBalances.quote * (1 - fee),
              (await this.getExchangeInfo(findDeal.deal.symbol.symbol))
                ?.priceAssetPrecision,
              true,
            )
            if (tpOrder.qty * tpOrder.price > quote && quote) {
              tpOrder.qty = this.math.round(
                quote / tpOrder.price,
                precision,
                true,
              )
              if (
                (tpOrder.qty < symbol.baseAsset.minAmount ||
                  tpOrder.qty * tpOrder.price < symbol.quoteAsset.minAmount) &&
                this.botType !== BotType.combo
              ) {
                return this.handleErrors(
                  `Cannot place TP order, because its amount would be lower than exchange minimum`,
                  'prepate close order',
                )
              }
            }
          }
          tpOrder.sl = sl
          return tpOrder
        }
      }
    }

    async closeByTimer(d: ExcludeDoc<Deal>) {
      const oldTimer = this.closeDealTimer.get(d._id)
      if (oldTimer) {
        clearTimeout(oldTimer)
        this.closeDealTimer.set(d._id, null)
      }
      const settings = await this.getAggregatedSettings(d)
      if (
        settings.closeByTimer &&
        settings.closeByTimerUnits &&
        settings.useTp
      ) {
        this.handleDebug(`Timer | Close by timer deal ${d._id}`)
        this.closeDealById(
          this.botId,
          d._id,
          settings.closeDealType,
          undefined,
          true,
          false,
          false,
          undefined,
          undefined,
          undefined,
          DCACloseTriggerEnum.timer,
        )
      }
    }

    async setCloseByTimer(d: ExcludeDoc<Deal>) {
      const settings = await this.getAggregatedSettings(d)
      if (
        settings.closeByTimer &&
        settings.closeByTimerUnits &&
        settings.useTp
      ) {
        if (d.status !== DCADealStatusEnum.open) {
          this.handleDebug(`Timer | Deal ${d._id} is not open`)
        }
        this.handleDebug(`Timer | Set close by timer for deal ${d._id}`)
        const closeByTimerValue = settings.closeByTimerValue ?? 1
        const value = this.utils.convertCooldown(
          closeByTimerValue,
          settings.closeByTimerUnits,
        )
        this.handleDebug(
          `Timer | Deal ${d._id} value is ${value} (${closeByTimerValue} ${settings.closeByTimerUnits})`,
        )
        const baseOrder = this.findBaseOrderByDeal(d._id)
        const closeTime = baseOrder
          ? baseOrder.updateTime + value - +new Date()
          : d.createTime + value - +new Date()
        if (baseOrder) {
          this.handleDebug(
            `Timer | Deal ${d._id} base order update time ${baseOrder.updateTime}, creation time ${d.createTime}`,
          )
        }
        if (closeTime < 0) {
          this.handleDebug(
            `Timer | Deal ${d._id} will be closed immediately close time (${closeTime}) is lower than 0`,
          )
          return await this.closeByTimer(d)
        }
        this.handleDebug(
          `Timer | Deal ${d._id} will be closed after ${closeTime} at ${new Date(
            +new Date() + closeTime,
          ).toUTCString()}`,
        )
        const timer =
          closeTime > maxTimeout
            ? setTimeout(async () => await this.setCloseByTimer(d), maxTimeout)
            : setTimeout(async () => await this.closeByTimer(d), closeTime)
        const oldTimer = this.closeDealTimer.get(d._id)
        if (oldTimer) {
          clearTimeout(oldTimer)
          this.closeDealTimer.set(d._id, null)
        }
        this.closeDealTimer.set(d._id, timer)
      } else {
        const oldTimer = this.closeDealTimer.get(d._id)
        if (oldTimer) {
          clearTimeout(oldTimer)
          this.closeDealTimer.set(d._id, null)
        }
      }
    }

    override allowToProcessBr(id: string, type?: TypeOrderEnum) {
      return (
        type === TypeOrderEnum.dealTP ||
        this.allowToPlaceOrders.get(this.getOrderFromMap(id)?.dealId ?? '') !==
          false
      )
    }
    /**
     * Manualy close deal by id
     *
     * @param {string} dealId Id of the deal
     * @param {CloseDCATypeEnum} [closeType] Close type. Default = leave
     */
    @IdMute(
      mutex,
      (botId: string, dealId: string) => `${botId}${dealId ?? 'closeById'}`,
    )
    async closeDealById(
      _botId: string,
      dealId: string,
      closeType: CloseDCATypeEnum = CloseDCATypeEnum.leave,
      reopen = true,
      forceMarket = false,
      slSource = false,
      checkProfit = false,
      price = '',
      liquidationPrice?: number,
      sl = false,
      closeTrigger?: DCACloseTriggerEnum,
      count = 0,
    ) {
      if (!this.loadingComplete) {
        this.runAfterLoadingQueue.push(() =>
          this.closeDealById.bind(this)(
            this.botId,
            dealId,
            closeType,
            reopen,
            forceMarket,
            slSource,
            checkProfit,
            price,
            liquidationPrice,
            sl,
            closeTrigger,
            count,
          ),
        )
        return this.handleLog('Loading not complete yet')
      }
      const _id = this.startMethod('closeDealById')
      let stop = false
      await this.clearDealTimer(dealId)
      this.handleLog(`Сlose deal ${dealId}`)
      let findDeal = this.getDeal(dealId)
      if (!findDeal) {
        if (this.closeAfterTpFilled && this.getOpenDeals().length === 0) {
          this.stop()
        }
        this.endMethod(_id)
        return this.handleWarn(`Deal ${dealId} not found when close`)
      }
      if (
        checkProfit &&
        !(await this.checkMinTp(
          findDeal,
          findDeal.deal.symbol.symbol,
          sl ? 'sl' : 'tp',
        ))
      ) {
        this.endMethod(_id)
        return this.handleDebug(`Deal ${dealId} not fit min profit`)
      }

      if (findDeal && closeType === CloseDCATypeEnum.leave) {
        await this.cancelAllOrder(findDeal.deal._id)
        // Leaving a deal cancels its resting orders and walks away from
        // whatever is already filled. That is the intended behaviour, but it
        // used to be recorded nowhere at all: the position stayed on the venue
        // with no TP and no SL while the bot went quiet. Say so, once, where
        // the user will see it.
        await this.announceLeftOpenPosition(findDeal.deal)
        this.endMethod(_id)
        return
      }
      if (
        findDeal &&
        (findDeal.deal.status === DCADealStatusEnum.start ||
          closeType === CloseDCATypeEnum.cancel)
      ) {
        const settings = await this.getAggregatedSettings(findDeal.deal)
        const status =
          settings.terminalDealType === TerminalDealTypeEnum.simple &&
          findDeal.deal.levels.complete === 1
            ? DCADealStatusEnum.closed
            : DCADealStatusEnum.canceled
        findDeal.deal.status = status
        findDeal.deal.closeTrigger = closeTrigger
        // A combo deal books realized profit as each minigrid round-trip
        // completes, so a deal being cancelled can already carry real profit.
        // `closeDeal()` is what credits the bot aggregate and the profit
        // history, and this path never reaches it — without this the profit
        // stays visible on the deal but is counted nowhere. A deal that never
        // traded has zero here, so the ordinary cancel is unaffected.
        const realized = findDeal.deal.profit
        if (this.data && (realized.total || realized.totalUsd)) {
          const profitBase = await this.profitBase(findDeal.deal)
          const rate = await this.getUsdRate(findDeal.deal.symbol.symbol)
          const commDeal = await this.getCommDeal(findDeal.deal)
          const commUsd =
            commDeal * (!profitBase ? 1 : findDeal.deal.lastPrice) * rate
          realized.total -= commDeal
          realized.totalUsd -= commUsd
          findDeal.deal.commission = commDeal
          this.data.profit.total += realized.total
          this.data.profit.totalUsd += realized.totalUsd
          this.saveProfitToDb(
            realized.totalUsd,
            findDeal.deal.closeTime ?? +new Date(),
          )
          this.updateData({ profit: this.data.profit })
          this.emit('bot settings update', { profit: this.data.profit })
        }
        this.saveDeal(findDeal, {
          status,
          profit: findDeal.deal.profit,
          commission: findDeal.deal.commission,
          closeTrigger: findDeal.deal.closeTrigger,
        })
        stop = await this.processDealClose(
          this.botId,
          dealId,
          { total: 0, totalUsd: 0 },
          reopen,
          closeType !== CloseDCATypeEnum.leave,
        )
        if (stop) {
          this.endMethod(_id)
          return this.stop()
        }
      }
      if (
        findDeal &&
        findDeal.deal.status === DCADealStatusEnum.open &&
        this.data &&
        this.orders &&
        this.exchange
      ) {
        this.allowToPlaceOrders.set(dealId, false)
        const fastClose =
          this.combo &&
          this.futures &&
          !liquidationPrice &&
          closeType === CloseDCATypeEnum.closeByMarket
        const closeSell = async () =>
          await this.cancelAllOrder(
            findDeal?.deal.lastPrice,
            dealId,
            true,
            undefined,
            this.isLong ? OrderSideEnum.sell : OrderSideEnum.buy,
          )
        const closeBuy = async () =>
          await this.cancelAllOrder(
            findDeal?.deal.lastPrice,
            dealId,
            true,
          ).then(() => this.allowToPlaceOrders.delete(dealId))
        if (fastClose) {
          await closeSell()
        } else {
          await this.cancelAllOrder(0, dealId, true)
          this.allowToPlaceOrders.delete(dealId)
        }
        findDeal = this.getDeal(dealId)
        if (findDeal && findDeal.deal.status === DCADealStatusEnum.open) {
          if (closeTrigger) {
            findDeal.deal.closeTrigger = closeTrigger
            this.saveDeal(findDeal, { closeTrigger })
          }
          if (liquidationPrice) {
            this.handleLog(`Close deal ${dealId} order by liquidation price`)
            this.endMethod(_id)
            return this.closeDeal(
              this.botId,
              dealId,
              undefined,
              liquidationPrice,
            )
          }
          await sleep(100)
          if (
            [
              ExchangeEnum.bybit,
              ExchangeEnum.bybitCoinm,
              ExchangeEnum.bybitUsdm,
            ].includes(this.data.exchange)
          ) {
            await sleep(500)
          }
          const tpOrder = await this.prepareTpOrder(findDeal, slSource, sl)
          if (tpOrder) {
            if (tpOrder.qty <= 0) {
              if (fastClose) {
                await closeBuy()
              }
              this.handleDebug(`Tp order qty less than 0 ${tpOrder.qty}`)
              return await this.closeDeal(this.botId, dealId)
            }
            if (this.combo && count === this.slippageRetry) {
              if (fastClose) {
                await closeBuy()
              }
              this.handleDebug(`Close combo deal ${dealId} without order`)
              this.endMethod(_id)
              return await this.closeDeal(this.botId, dealId)
            }
            const symbol = await this.getExchangeInfo(
              findDeal.deal.symbol.symbol,
            )
            if (symbol) {
              let result = await this.sendGridToExchange(
                {
                  ...tpOrder,
                  price: price
                    ? this.math.round(+price, symbol.priceAssetPrecision)
                    : tpOrder.price,
                },
                {
                  dealId: findDeal.deal._id,
                  type:
                    count === this.slippageRetry
                      ? OrderTypeEnum.limit
                      : forceMarket
                        ? OrderTypeEnum.market
                        : closeType === CloseDCATypeEnum.closeByLimit
                          ? OrderTypeEnum.limit
                          : OrderTypeEnum.market,
                  reduceOnly: !!this.futures,
                  positionSide: this.hedge
                    ? this.isLong
                      ? PositionSide.LONG
                      : PositionSide.SHORT
                    : PositionSide.BOTH,
                },
                symbol,
                true,
              )
              if (result) {
                if (
                  typeof result === 'string' &&
                  this.data.settings.adaptiveClose &&
                  notEnoughErrors.some((s) =>
                    `${result}`.toLowerCase().includes(s.toLowerCase()),
                  )
                ) {
                  this.handleDebug(
                    `TP order got not enough balance, but adaptive close is on`,
                  )
                  const balances = await this.checkAssets(true)
                  const asset = symbol.baseAsset.name
                  const find = balances?.get(asset)
                  if (!find) {
                    this.handleDebug(
                      `Asset ${asset} not found in user balances`,
                    )
                  } else {
                    const toPlace = Math.min(
                      this.math.round(
                        find.free,
                        await this.baseAssetPrecision(symbol.pair),
                        true,
                      ),
                      tpOrder.qty,
                    )
                    this.handleDebug(
                      `Found free ${find.free}, to place ${toPlace}`,
                    )
                    if (
                      toPlace < symbol.baseAsset.minAmount ||
                      toPlace * tpOrder.price < symbol.quoteAsset.minAmount
                    ) {
                      this.handleDebug(
                        `Asset ${asset} free amount ${toPlace} is lower than exchange requirements base ${toPlace}, ${
                          symbol.baseAsset.minAmount
                        }, quote - ${toPlace * tpOrder.price}, ${
                          symbol.quoteAsset.minAmount
                        }`,
                      )
                    } else {
                      this.handleDebug(
                        `Place new TP order with amount ${toPlace} ${asset} (tp order was ${tpOrder.qty} ${asset})`,
                      )
                      result = await this.sendGridToExchange(
                        {
                          ...tpOrder,
                          qty: toPlace,
                          price: price
                            ? this.math.round(
                                +price,
                                symbol.priceAssetPrecision,
                              )
                            : tpOrder.price,
                          newClientOrderId: `${tpOrder.newClientOrderId.slice(
                            0,
                            tpOrder.newClientOrderId.length - 2,
                          )}ac`,
                        },
                        {
                          dealId: findDeal.deal._id,
                          type:
                            count === this.slippageRetry
                              ? OrderTypeEnum.limit
                              : forceMarket
                                ? OrderTypeEnum.market
                                : closeType === CloseDCATypeEnum.closeByLimit
                                  ? OrderTypeEnum.limit
                                  : OrderTypeEnum.market,
                          reduceOnly: !!this.futures,
                          positionSide: this.hedge
                            ? this.isLong
                              ? PositionSide.LONG
                              : PositionSide.SHORT
                            : PositionSide.BOTH,
                          acBefore: tpOrder.qty,
                          acAfter: toPlace,
                        },
                        symbol,
                        true,
                      )
                    }
                  }
                }
                if (result) {
                  if (typeof result === 'string') {
                    if (
                      this.isNotionalReason(result) &&
                      count < this.slippageRetry
                    ) {
                      this.handleDebug(
                        `Cannot place take profit due to slippage ${
                          tpOrder.newClientOrderId
                        }, attempt ${count + 1}`,
                      )
                      await sleep(250)
                      this.closeDealById(
                        this.botId,
                        dealId,
                        closeType,
                        reopen,
                        forceMarket,
                        slSource,
                        checkProfit,
                        price,
                        liquidationPrice,
                        sl,
                        closeTrigger,
                        count + 1,
                      )
                    } else if (this.isPositionAlreadyClosedReason(result)) {
                      // The exchange says there is no position left to reduce,
                      // so the closing order can never be placed. Without this
                      // the deal stays open forever with no orders — see the
                      // combo base-minigrid case, where completing the base
                      // minigrid means the position is already flat.
                      this.handleLog(
                        `Close order for deal ${dealId} rejected because the position is already closed (${result}). Closing deal without order`,
                      )
                      if (fastClose) {
                        await closeBuy()
                      }
                      this.endMethod(_id)
                      return await this.closeDeal(this.botId, dealId)
                    } else {
                      this.handleOrderErrors(
                        result,
                        {
                          symbol: symbol.pair,
                          orderId: '0',
                          clientOrderId: tpOrder.newClientOrderId,
                          transactTime: +new Date(),
                          updateTime: +new Date(),
                          price: `${tpOrder.price}`,
                          origQty: `${tpOrder.qty}`,
                          executedQty: '0',
                          cummulativeQuoteQty: '0',
                          status: 'CANCELED',
                          type: 'MARKET',
                          side: tpOrder.side,
                          quoteAsset: symbol.quoteAsset.name,
                          baseAsset: symbol.baseAsset.name,
                          typeOrder: tpOrder.type,
                          exchange: this.data.exchange,
                          exchangeUUID: this.data.exchangeUUID,
                          botId: this.botId,
                          userId: this.userId,
                          origPrice: `${tpOrder.price}`,
                        },
                        'limitOrders()',
                        `Send new order request ${tpOrder.newClientOrderId}, qty ${tpOrder.qty}, price ${tpOrder.price}, side ${tpOrder.side}`,
                      )
                      if (fastClose) {
                        await closeBuy()
                      }
                    }
                  } else {
                    if (result.status === 'FILLED') {
                      this.processFilledOrder(result)
                    }
                    if (
                      result.status !== 'FILLED' &&
                      closeType === CloseDCATypeEnum.closeByLimit
                    ) {
                      const deal = this.getDeal(dealId)
                      if (deal && !price && count < this.slippageRetry) {
                        const dealTimer = this.dealTimersMap.get(
                          deal.deal._id,
                        ) ?? {
                          limitTimer: null,
                          enterMarketTimer: null,
                        }
                        if (
                          this.orderLimitRepositionTimeout !== 0 &&
                          !this.data.settings.notUseLimitReposition
                        ) {
                          if (!this.startTimeoutTime.get(deal.deal._id)) {
                            this.startTimeoutTime.set(
                              deal.deal._id,
                              new Date().getTime(),
                            )
                          }

                          if (
                            this.enterMarketTimeout === 0 ||
                            (this.enterMarketTimeout !== 0 &&
                              new Date().getTime() +
                                this.orderLimitRepositionTimeout >
                                (this.startTimeoutTime.get(deal.deal._id) ??
                                  new Date().getTime()) +
                                  this.enterMarketTimeout)
                          ) {
                            dealTimer.limitTimer = setTimeout(
                              () =>
                                this.checkTPOrder(
                                  this.botId,
                                  tpOrder.newClientOrderId,
                                  dealId,
                                  closeType,
                                  reopen,
                                  undefined,
                                  checkProfit,
                                ),
                              this.orderLimitRepositionTimeout,
                            )
                          }
                        }
                        if (
                          this.enterMarketTimeout !== 0 &&
                          !dealTimer.enterMarketTimer &&
                          (!this.data.settings.notUseLimitReposition ||
                            (this.data.settings.notUseLimitReposition &&
                              this.data.settings.useLimitTimeout))
                        ) {
                          dealTimer.limitTimer = setTimeout(
                            () =>
                              this.checkTPOrder(
                                this.botId,
                                tpOrder.newClientOrderId,
                                dealId,
                                closeType,
                                reopen,
                                true,
                                checkProfit,
                              ),
                            this.orderLimitRepositionTimeout,
                          )
                        }
                        this.dealTimersMap.set(deal.deal._id, dealTimer)
                      }
                    }
                  }
                }
              }
            } else {
              if (fastClose) {
                await closeBuy()
              }
              this.handleWarn(
                `No symbol found. Close ${dealId} ${findDeal.deal.symbol.symbol}`,
              )
            }
          } else {
            if (fastClose) {
              await closeBuy()
            }
            this.handleDebug(`No tp order. Close without order`)
            return this.closeDeal(this.botId, dealId)
          }
        } else {
          this.handleLog(
            findDeal
              ? `Deal found with status ${findDeal.deal.status}. Close ${dealId}`
              : `Deal not found with. Close ${dealId}`,
          )
        }
      }
      this.endMethod(_id)
    }

    async checkMinTp(
      d: FullDeal<ExcludeDoc<Deal>>,
      symbol: string,
      section: 'sl' | 'tp',
    ) {
      if (!this.data || !this.allowedMethods.has('checkMinTp')) {
        return true
      }
      const settings = await this.getAggregatedSettings(d.deal)
      let value: number | undefined
      let isGt = true
      if (
        section !== 'sl' &&
        settings.useMinTP &&
        settings.dealCloseCondition &&
        [CloseConditionEnum.techInd, CloseConditionEnum.webhook].includes(
          settings.dealCloseCondition,
        ) &&
        settings.minTp &&
        checkNumber(settings.minTp)
      ) {
        value = +(settings.minTp ?? '0') / 100
      }
      if (section === 'sl') {
        const foundUnpnl =
          this.data?.settings.dealCloseConditionSL ===
          CloseConditionEnum.techInd
            ? (this.data?.settings.indicators ?? []).find(
                (i) =>
                  i.type === IndicatorEnum.unpnl &&
                  i.section === IndicatorSection.sl,
              )
            : undefined
        if (foundUnpnl) {
          isGt =
            (foundUnpnl.unpnlCondition ?? this.defaultUnpnlCondition) ===
            IndicatorStartConditionEnum.gt
          value = (foundUnpnl.unpnlValue ?? this.defaultUnpnl) / 100
        }
      }
      if (
        section === 'tp' &&
        (this.data.settings.stopDealLogic === IndicatorsLogicEnum.and ||
          !this.data.settings.stopDealLogic)
      ) {
        const foundUnpnl =
          this.data?.settings.dealCloseCondition === CloseConditionEnum.techInd
            ? (this.data?.settings.indicators ?? []).find(
                (i) =>
                  i.type === IndicatorEnum.unpnl &&
                  i.section !== IndicatorSection.sl,
              )
            : undefined
        if (foundUnpnl) {
          isGt =
            (foundUnpnl.unpnlCondition ?? this.defaultUnpnlCondition) ===
            IndicatorStartConditionEnum.gt
          value = (foundUnpnl.unpnlValue ?? this.defaultUnpnl) / 100
        }
      }
      if (typeof value !== 'undefined') {
        const price = await this.getLatestPrice(symbol)
        const fee = await this.getUserFee(symbol)
        if (price === 0) {
          return false
        }
        const diff = this.isLong
          ? price - d.deal.avgPrice
          : d.deal.avgPrice - price
        const current = diff / d.deal.avgPrice - (fee?.taker ?? 0.001) * 2
        if (isNaN(current) || !isFinite(current)) {
          return false
        }
        this.handleDebug(
          `Check minimum profit: deal ${
            d.deal._id
          }, current profit: ${current}, min profit: ${value}${
            !isGt ? ' (lt)' : ''
          }`,
        )
        return isGt ? current >= value : current <= value
      }
      return true
    }
    /**
     * Close all deals
     */

    async closeAllDeals(
      closeType: CloseDCATypeEnum = CloseDCATypeEnum.closeByMarket,
      symbol?: string,
      checkProfit = false,
      ignoreStart = false,
      force = false,
      slSource = false,
      liquidationPrice?: number,
      closeTrigger?: DCACloseTriggerEnum,
    ) {
      if (!this.loadingComplete) {
        this.runAfterLoadingQueue.push(() =>
          this.closeAllDeals.bind(this)(
            closeType,
            symbol,
            checkProfit,
            ignoreStart,
            force,
            slSource,
            liquidationPrice,
            closeTrigger,
          ),
        )
        return this.handleLog('Loading not complete yet')
      }
      const active: FullDeal<ExcludeDoc<Deal>>[] = []
      for (const d of this.getOpenDeals(ignoreStart, symbol)) {
        const settings = await this.getAggregatedSettings(d.deal)
        if (
          force ||
          (settings.dealCloseCondition &&
            [CloseConditionEnum.techInd, CloseConditionEnum.webhook].includes(
              settings.dealCloseCondition,
            )) ||
          (settings.dealCloseConditionSL &&
            [CloseConditionEnum.techInd, CloseConditionEnum.webhook].includes(
              settings.dealCloseConditionSL,
            ))
        ) {
          active.push(d)
        }
      }
      for (const f of active) {
        if (
          (checkProfit &&
            (await this.checkMinTp(
              f,
              f.deal.symbol.symbol,
              slSource ? 'sl' : 'tp',
            ))) ||
          !checkProfit
        ) {
          await this.closeDealById(
            this.botId,
            f.deal._id,
            closeType,
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            liquidationPrice,
            slSource,
            closeTrigger,
          )
        }
      }
    }

    async sendDealOpenedAlert(_deal: ExcludeDoc<Deal>, _order: Order) {
      return
    }

    /**
     * Start deal when BO is filled
     *
     * @param {Order} orderBo Base order
     */
    @IdMute(mutex, (order: Order) => `${order.botId}${order.clientOrderId}`)
    async startDeal(orderBo: Order) {
      const _id = this.startMethod('startDeal')
      const { dealId } = orderBo
      const get = this.getDeal(dealId)
      const findDeal = get && get.initialOrders.length === 0 ? get : undefined
      if (
        findDeal &&
        dealId &&
        findDeal.deal.status === DCADealStatusEnum.start
      ) {
        const settings = await this.getAggregatedSettings(findDeal.deal)
        this.handleLog('Base order FILLED')
        const initialPrice = parseFloat(orderBo.price)
        const qty = parseFloat(orderBo.executedQty)
        await this.clearDealTimer(dealId)
        const long = this.isLong
        findDeal.initialOrders = await this.createInitialDealOrders(
          findDeal.deal.symbol.symbol,
          initialPrice,
          dealId,
          findDeal.deal,
        )
        findDeal.currentOrders = await this.createCurrentDealOrders(
          findDeal.deal.symbol.symbol,
          initialPrice,
          findDeal.initialOrders,
          initialPrice,
          initialPrice,
          dealId,
          false,
          findDeal.deal,
          false,
        )
        findDeal.previousOrders = []
        findDeal.deal.initialBalances = {
          base: long
            ? 0
            : findDeal.initialOrders
                .filter((o) => o.side === OrderSideEnum.sell)
                .reduce((acc, v) => acc + v.qty, 0) + qty,
          quote: long
            ? findDeal.initialOrders
                .filter((o) => o.side === OrderSideEnum.buy)
                .reduce((acc, v) => acc + v.qty * v.price, 0) +
              initialPrice * qty
            : 0,
        }
        findDeal.deal.currentBalances = {
          base: long ? qty : findDeal.deal.initialBalances.base - qty,
          quote: long
            ? findDeal.deal.initialBalances.quote - qty * initialPrice
            : qty * initialPrice,
        }
        findDeal.deal.initialPrice = initialPrice
        findDeal.deal.lastPrice = initialPrice
        const avgs = await this.getAvgPrice(dealId)
        findDeal.deal.avgPrice = avgs.avg || initialPrice
        findDeal.deal.displayAvg = avgs.display
        findDeal.deal.settings.avgPrice = avgs.avg || initialPrice
        this.handleDebug(
          `Set deal avg prices ${findDeal.deal.avgPrice}, ${findDeal.deal.settings.avgPrice} (display ${findDeal.deal.displayAvg})`,
        )
        findDeal.deal.status =
          settings.terminalDealType === TerminalDealTypeEnum.simple
            ? DCADealStatusEnum.closed
            : DCADealStatusEnum.open
        findDeal.deal.updateTime = orderBo.updateTime
        findDeal.deal.levels.complete = findDeal.deal.levels.complete + 1
        findDeal.closeByTp = false
        this.saveDeal(findDeal, {
          initialBalances: findDeal.deal.initialBalances,
          currentBalances: findDeal.deal.currentBalances,
          initialPrice: findDeal.deal.initialPrice,
          lastPrice: findDeal.deal.lastPrice,
          avgPrice: findDeal.deal.avgPrice,
          displayAvg: findDeal.deal.displayAvg,
          'settings.avgPrice': findDeal.deal.settings.avgPrice,
          updateTime: findDeal.deal.updateTime,
          levels: findDeal.deal.levels,
          status: findDeal.deal.status,
        }).then(async () => {
          await this.checkDealSlMethods(findDeal)
          await this.checkDealsAllowedMethods()
          await this.setCloseByTimer(findDeal.deal)
          this.updateUsage(dealId)
          this.sendDealOpenedAlert(findDeal.deal, orderBo)
          this.updateAssets(dealId)
        })
        await this.placeOrders(
          this.botId,
          orderBo.symbol,
          dealId,
          this.findDiff(findDeal.currentOrders, []),
        )
        await this.checkOpenedDeals()
        if (settings.terminalDealType === TerminalDealTypeEnum.simple) {
          await this.processDealClose(
            this.botId,
            dealId,
            { total: 0, totalUsd: 0 },
            false,
            true,
          )
          this.stop()
        }
        await this.updateDealLastPrices(this.botId)
      }
      if (
        (!findDeal && dealId) ||
        (findDeal &&
          dealId &&
          (findDeal.deal.status === DCADealStatusEnum.closed ||
            findDeal.deal.status === DCADealStatusEnum.canceled))
      ) {
        const findTp = await this.ordersDb.countData({
          botId: this.botId,
          dealId,
          typeOrder: TypeOrderEnum.dealTP,
        })
        if (findTp.data?.result && findTp.data.result > 0) {
          this.handleDebug(
            `Sell remainder | TP order found for deal ${dealId}, skipping sell remainder`,
          )
        } else {
          await this.sellRemainder(
            dealId,
            +orderBo.executedQty,
            +orderBo.price,
            false,
            findDeal,
          )
        }
      }
      this.endMethod(_id)
    }
    /** Sell remainder for deal */
    @IdMute(mutex, (dealId: string) => `${dealId}sellRemainder`)
    async sellRemainder(
      dealId: string,
      _qty: number,
      _price?: number,
      sellNotByOrder = false,
      findDeal?: FullDeal<ExcludeDoc<Deal>>,
      updateBalances = true,
      force = false,
    ) {
      if (
        this.data?.settings.type === DCATypeEnum.terminal &&
        this.data.settings.terminalDealType === TerminalDealTypeEnum.simple
      ) {
        return
      }
      this.handleDebug(
        `Sell remainder | Deal ${dealId}, qty ${_qty}, price ${_price}, sellNotByOrder ${sellNotByOrder}, findDeal ${!!findDeal}, updateBalances ${updateBalances}`,
      )
      const _id = this.startMethod('sellRemainder')
      let dealData = findDeal?.deal
      if (!dealData) {
        this.handleDebug(`Sell remainder | Deal not found, check in DB`)
        const realDeal = await this.dealsDb.readData({ _id: dealId } as any)
        if (realDeal.status === StatusEnum.notok) {
          this.endMethod(_id)
          return this.handleErrors(
            `Cannot read deal ${dealId} ${realDeal.reason}`,
            'updateDeal',
            'read deal',
            false,
            false,
            false,
          )
        }
        if (!realDeal.data.result) {
          this.endMethod(_id)
          return this.handleWarn(
            `Sell remainder | Deal ${dealId} not found in DB`,
          )
        }
        dealData = realDeal.data.result
        dealData._id = `${dealData._id}`
      }
      if (dealData.sellRemainder) {
        this.handleDebug(`Sell remainder | Deal ${dealId} already sold`)
        this.endMethod(_id)
        return
      }
      if (
        dealData.status === DCADealStatusEnum.closed ||
        (dealData.status === DCADealStatusEnum.canceled &&
          dealData.levels.complete === 0) ||
        force
      ) {
        if (await this.profitBase(findDeal?.deal)) {
          this.handleLog(
            `Sell remainder | Deal ${dealId} is profit in base, skipping`,
          )
          this.endMethod(_id)
          return
        }
        const { symbol } = dealData.symbol
        if (!symbol) {
          this.handleWarn(`Sell remainder | Symbol not found`)
          this.endMethod(_id)
          return
        }
        const ed = await this.getExchangeInfo(symbol)
        const _fee = await this.getUserFee(symbol)
        if (!ed || !_fee) {
          this.handleWarn(
            `Sell remainder | ${!ed ? 'Exchange info' : 'Fee'} not found`,
          )
          this.endMethod(_id)
          return
        }
        const qty = _qty
        const orderPrice = _price ?? (await this.getLatestPrice(symbol))
        const long = this.isLong
        let qtyWithoutFee =
          +qty * (1 - (this.futures ? 0 : long ? _fee.taker : 0))
        if (sellNotByOrder) {
          const allDealOrders = await this.ordersDb.readData(
            {
              dealId,
              status: 'FILLED',
              side: this.isLong ? 'BUY' : 'SELL',
              botId: this.botId,
            },
            {},
            {},
            true,
          )
          const totalFee = this.futures
            ? 0
            : (allDealOrders.data?.result ?? []).reduce(
                (acc, v) => acc + +v.executedQty * _fee.taker,
                0,
              )
          qtyWithoutFee = +qty - totalFee
        }
        const price = await this.getLatestPrice(symbol)
        if (
          qtyWithoutFee >= ed.baseAsset.minAmount &&
          qtyWithoutFee * price >= ed.quoteAsset.minAmount
        ) {
          const result = await this.sendGridToExchange(
            {
              price: this.math.round(price, ed.priceAssetPrecision),
              number: 0,
              side: !long ? OrderSideEnum.buy : OrderSideEnum.sell,
              qty: this.math.round(
                qtyWithoutFee,
                await this.baseAssetPrecision(symbol),
                !this.futures,
              ),
              type: TypeOrderEnum.dealTP,
              newClientOrderId: this.getOrderId(`D-SR`),
              dealId,
            },
            {
              dealId,
              type: 'MARKET',
              reduceOnly: true,
              positionSide: this.hedge
                ? this.isLong
                  ? PositionSide.LONG
                  : PositionSide.SHORT
                : PositionSide.BOTH,
            },
            ed,
          )
          if (result) {
            const srQty = +result.executedQty
            const srPrice = +result.price
            this.handleDebug(
              `Sell remainder order filled for deal ${dealId} ${
                result.clientOrderId
              }, price: ${srPrice}, base: ${srQty}, quote: ${
                srPrice * srQty
              }, time: ${result.updateTime}`,
            )
            dealData.updateTime = result.updateTime
            dealData.lastPrice = srPrice
            dealData.levels.complete += updateBalances
              ? sellNotByOrder
                ? 0
                : 1
              : 0
            dealData.currentBalances = updateBalances
              ? {
                  base:
                    dealData.currentBalances.base +
                    srQty * (result.side === OrderSideEnum.buy ? 1 : -1) +
                    qtyWithoutFee * (sellNotByOrder ? 0 : long ? 1 : -1),
                  quote:
                    dealData.currentBalances.quote +
                    srQty *
                      srPrice *
                      (result.side === OrderSideEnum.sell ? 1 : -1) +
                    qtyWithoutFee *
                      orderPrice *
                      (sellNotByOrder ? 0 : long ? 1 : -1),
                }
              : dealData.currentBalances
            const fee = (await this.profitBase(dealData))
              ? (qty * _fee.maker * (sellNotByOrder ? 0 : 1) +
                  srQty * _fee.taker) *
                _fee.maker
              : qty * orderPrice * _fee.maker * (sellNotByOrder ? 0 : 1) +
                srQty * srPrice * _fee.taker
            const feeBase =
              result.side === OrderSideEnum.buy || (this.futures && this.coinm)
                ? +result.executedQty * (fee ?? 0)
                : 0
            const feeQuote =
              result.side === OrderSideEnum.sell ||
              (this.futures && !this.coinm)
                ? +result.executedQty * +result.price * (fee ?? 0)
                : 0
            const pureQuote =
              dealData.currentBalances.quote -
              (dealData.initialBalances.quote +
                (dealData.profit.pureQuote ?? 0)) -
              feeQuote
            const pureBase =
              dealData.currentBalances.base -
              (dealData.initialBalances.base +
                (dealData.profit.pureBase ?? 0)) -
              feeBase
            const total =
              (!(await this.profitBase(findDeal?.deal))
                ? srQty * srPrice -
                  qtyWithoutFee * orderPrice +
                  (qtyWithoutFee - srQty) * orderPrice
                : srQty -
                  qtyWithoutFee +
                  (srQty * srPrice - qtyWithoutFee * orderPrice) / orderPrice) -
              fee
            const rate = await this.getUsdRate(symbol)
            const totalUsd =
              total *
              (!(await this.profitBase(findDeal?.deal)) ? 1 : srPrice) *
              rate
            dealData.profit.total += updateBalances ? total : 0
            dealData.profit.totalUsd += updateBalances ? totalUsd : 0
            dealData.profit.pureBase = updateBalances
              ? (dealData.profit.pureBase ?? 0) + pureBase
              : 0
            dealData.profit.pureQuote = updateBalances
              ? (dealData.profit.pureQuote ?? 0) + pureQuote
              : 0
            if (this.data && updateBalances) {
              this.data.profit = {
                ...this.data.profit,
                total: this.data.profit.total + total,
                totalUsd: this.data.profit.totalUsd + totalUsd,
                freeTotal: 0,
                freeTotalUsd: 0,
                pureBase: (this.data.profit.pureBase ?? 0) + pureBase,
                pureQuote: (this.data.profit.pureQuote ?? 0) + pureQuote,
              }
              this.saveProfitToDb(totalUsd, dealData.closeTime ?? +new Date())
              this.updateData({ profit: { ...this.data.profit } })
              this.emit('bot settings update', { profit: this.data.profit })
            }
            dealData.commission += fee
            dealData.assets.used = updateBalances
              ? {
                  base:
                    dealData.assets.used.base +
                    qtyWithoutFee * (sellNotByOrder ? 0 : long ? 1 : -1),
                  quote:
                    dealData.assets.used.quote +
                    qtyWithoutFee *
                      orderPrice *
                      (sellNotByOrder ? 0 : long ? -1 : 1),
                }
              : dealData.assets.used
            dealData.assets.required = updateBalances
              ? {
                  base:
                    dealData.assets.required.base +
                    qtyWithoutFee * (sellNotByOrder ? 0 : long ? 1 : -1),
                  quote:
                    dealData.assets.required.quote +
                    qtyWithoutFee *
                      orderPrice *
                      (sellNotByOrder ? 0 : long ? -1 : 1),
                }
              : dealData.assets.required

            if (this.shouldProceed()) {
              this.dealsDb
                .updateData({ _id: dealId } as any, {
                  $set: {
                    commission: dealData.commission,
                    profit: dealData.profit,
                    updateTime: dealData.updateTime,
                    lastPrice: dealData.lastPrice,
                    currentBalances: dealData.currentBalances,
                    'levels.complete': dealData.levels.complete,
                    assets: dealData.assets,
                  },
                })
                .then((res) => {
                  if (res.status === StatusEnum.notok) {
                    this.handleWarn(
                      `Error saving deal: ${dealId}. Reason: ${res.reason}`,
                    )
                  }
                })
            }
          }
          const getDeal = this.deals.get(`${dealId}`)
          if (getDeal && getDeal.deal.status === DCADealStatusEnum.open) {
            getDeal.deal.sellRemainder = true
            this.setDeal(getDeal)
          }
          this.dealsDb.updateData({ _id: dealId } as any, {
            $set: { sellRemainder: true },
          })
        } else {
          this.handleDebug(
            `Sell remainder | qty less than minimals qty: ${qtyWithoutFee},min: ${
              ed.baseAsset.minAmount
            }, quote: ${qtyWithoutFee * price}, min ${ed.quoteAsset.minAmount} `,
          )
        }
      }
      this.endMethod(_id)
    }

    private async getAvgPrice(
      dealId: string,
    ): Promise<{ avg: number; display: number }> {
      if (this.futures) {
        let filledDealOrder = this.getOrdersByStatusAndDealId({
          status: 'FILLED',
          dealId,
        })
        filledDealOrder = [...filledDealOrder].sort(
          (a, b) => a.updateTime - b.updateTime,
        )
        let pos: PositionInBot = {
          price: 0,
          side: PositionSide.LONG,
          qty: 0,
        }
        for (const o of filledDealOrder) {
          pos = await this.calculateAbstractPosition(
            {
              qty: +(o.executedQty ?? '0') || +o.origQty,
              price: +o.price,
              side: o.side,
              symbol: o.symbol,
            },
            pos,
          )
        }
        return { avg: pos.price, display: pos.price }
      }
      const filledDealOrder = this.getOrdersByStatusAndDealId({
        status: 'FILLED',
        dealId,
      }).filter((o) => o.side === (this.isLong ? 'BUY' : 'SELL'))
      const base = filledDealOrder.reduce(
        (acc, v) => acc + parseFloat(v.executedQty),
        0,
      )
      const quote = filledDealOrder.reduce(
        (acc, v) => acc + parseFloat(v.executedQty) * parseFloat(v.price),
        0,
      )
      let avg = quote / base
      if (isNaN(avg)) {
        avg = 0
      }
      let display = avg
      if (!isNaN(avg)) {
        const d = this.getDeal(dealId)
        if (d) {
          const profitBase = await this.profitBase(d.deal)
          const qty = this.isLong
            ? d.deal.currentBalances.base
            : d.deal.initialBalances.base - d.deal.currentBalances.base
          const quote =
            (this.isLong
              ? d.deal.initialBalances.quote - d.deal.currentBalances.quote
              : d.deal.currentBalances.quote) +
            (profitBase ? 0 : d.deal.profit.total * (this.isLong ? 1 : -1))
          const fee = (await this.getUserFee(d.deal.symbol.symbol))?.maker ?? 0
          if (profitBase) {
            display =
              quote /
              (qty -
                (qty * fee - d.deal.profit.total) / (this.isLong ? 1 : -1) -
                d.deal.profit.total * (this.isLong ? 1 : -1))
          } else {
            display =
              (quote * (this.isLong ? 1 : -1) - d.deal.profit.total) /
              (((this.isLong ? 1 : -1) - fee) * qty)
          }
          if (isNaN(display) || !isFinite(display) || display < 0) {
            display = avg
          }
        }
      }
      return { avg, display }
    }

    @RunWithDelay(
      (deal: ExcludeDoc<Deal>) => `${deal._id}sendDealClosedAlert`,
      5 * 1000,
    )
    async sendDealClosedAlert(
      _deal: ExcludeDoc<Deal>,
      _order?: Order,
      _partial = false,
    ) {
      return
    }
    /**
     * Update deal when Regular order is filled
     *
     * @param {Order} order Base order
     */
    @IdMute(
      mutex,
      (botId: string, order: Order) => `${botId}${order?.dealId}update`,
    )
    async updateDeal(_botId: string, order: Order) {
      const _id = this.startMethod('updateDeal')
      this.ordersInBetweenUpdates.delete(order.clientOrderId)
      const { dealId, clientOrderId } = order
      const getSet = dealId
        ? (this.dealUpdateOrders.get(dealId) ?? new Set<string>())
        : new Set<string>()
      if (getSet.has(clientOrderId)) {
        this.endMethod(_id)
        return this.handleDebug(
          `Order ${clientOrderId} already processed in update deal`,
        )
      }
      if (!dealId) {
        this.endMethod(_id)
        return this.handleWarn(`Order ${clientOrderId} has no dealId`)
      }

      this.dealUpdateOrders.set(dealId, getSet.add(clientOrderId))
      const price = parseFloat(order.price)
      const qty = parseFloat(order.executedQty)
      const findDeal = this.getDeal(dealId)
      if (
        findDeal &&
        dealId &&
        this.orders &&
        findDeal.deal.status === DCADealStatusEnum.open
      ) {
        const roa =
          order.clientOrderId.indexOf('-ROA-') !== -1 ||
          order.clientOrderId.indexOf('ROA') !== -1
        findDeal.deal.lastPrice = this.isLong
          ? Math.min(findDeal.deal.lastPrice, parseFloat(order.price))
          : Math.max(findDeal.deal.lastPrice, parseFloat(order.price))
        if (!roa) {
          findDeal.deal.currentBalances = {
            base:
              findDeal.deal.currentBalances.base +
              qty * (order.side === OrderSideEnum.buy ? 1 : -1),
            quote:
              findDeal.deal.currentBalances.quote +
              qty * price * (order.side === OrderSideEnum.sell ? 1 : -1),
          }
        }
        findDeal.deal.updateTime = order.updateTime
        if (roa) {
          findDeal.deal.pendingAddFunds = (
            findDeal.deal.pendingAddFunds ?? []
          ).filter((s) => s.id !== order.addFundsId)
          findDeal.deal.funds = [...(findDeal.deal.funds ?? []), { price, qty }]
          const avgPrice = await this.getAvgPrice(dealId)
          findDeal.deal.avgPrice = avgPrice.avg
          findDeal.deal.displayAvg = avgPrice.display
          findDeal.deal.settings.avgPrice = avgPrice.avg
          findDeal.previousOrders = findDeal.currentOrders
          findDeal.deal.levels.complete += 1
          findDeal.deal.levels.all = Math.max(
            findDeal.deal.levels.complete,
            findDeal.initialOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ).length +
              1 +
              (findDeal.deal.pendingAddFunds ?? []).length +
              (findDeal.deal.funds ?? []).length,
          )
          if (
            findDeal.currentOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ).length === 0
          ) {
            findDeal.deal.levels.all = Math.max(
              findDeal.deal.levels.complete,
              1 +
                findDeal.initialOrders.filter(
                  (o) => o.type === TypeOrderEnum.dealRegular,
                ).length,
              1 + (findDeal.deal.funds ?? []).length,
            )
          }
          findDeal.currentOrders = await this.createCurrentDealOrders(
            findDeal.deal.symbol.symbol,
            findDeal.deal.lastPrice,
            findDeal.initialOrders,
            findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
            findDeal.deal.initialPrice,
            findDeal.deal._id,
            false,
            findDeal.deal,
            false,
          )
          findDeal.deal.initialBalances = {
            base:
              findDeal.deal.initialBalances.base +
              qty * (order.side === OrderSideEnum.buy ? 0 : 1),
            quote:
              findDeal.deal.initialBalances.quote +
              qty * price * (order.side === OrderSideEnum.buy ? 1 : 0),
          }
          findDeal.deal.currentBalances = {
            base:
              findDeal.deal.currentBalances.base +
              qty * (order.side === OrderSideEnum.buy ? 1 : 0),
            quote:
              findDeal.deal.currentBalances.quote +
              qty * price * (order.side === OrderSideEnum.buy ? 0 : 1),
          }
          findDeal.closeByTp = false
          await this.checkDealSlMethods(findDeal)
          this.checkDealsPriceExtremum()
          this.saveDeal(findDeal, {
            funds: findDeal.deal.funds,
            pendingAddFunds: findDeal.deal.pendingAddFunds,
            lastPrice: findDeal.deal.lastPrice,
            updateTime: findDeal.deal.updateTime,
            avgPrice: findDeal.deal.avgPrice,
            displayAvg: findDeal.deal.displayAvg,
            'settings.avgPrice': findDeal.deal.settings.avgPrice,
            levels: findDeal.deal.levels,
            currentBalances: findDeal.deal.currentBalances,
            initialBalances: findDeal.deal.initialBalances,
          }).then(() => {
            this.updateUsage(dealId)
            this.updateAssets(dealId, findDeal)
            this.updateDealBalances(findDeal)
            this.updateDealLastPrices(this.botId)
          })

          this.placeOrders(
            this.botId,
            order.symbol,
            dealId,
            this.findDiff(findDeal.currentOrders, findDeal.previousOrders),
          )
        } else if (order.typeOrder === TypeOrderEnum.dealTP) {
          const isReduce = !!order.reduceFundsId
          if (isReduce) {
            this.handleLog(`Reduce TP order FILLED ${order.clientOrderId}`)
            findDeal.deal.pendingReduceFunds = (
              findDeal.deal.pendingReduceFunds ?? []
            ).filter((r) => r.id !== order.reduceFundsId)
            findDeal.deal.reduceFunds = [
              ...(findDeal.deal.reduceFunds ?? []),
              { price, qty },
            ]
          } else {
            this.handleLog(`Multiple TP order FILLED ${order.clientOrderId}`)
          }
          const settings = await this.getAggregatedSettings(findDeal.deal)
          const commDeal = await this.getCommDeal(findDeal.deal)
          const { avgPrice } = findDeal.deal
          const total =
            (!(await this.profitBase(findDeal.deal))
              ? this.isLong
                ? qty * price - qty * avgPrice
                : avgPrice * qty - qty * price
              : this.isLong
                ? qty * (price / avgPrice - 1)
                : qty * (avgPrice / price - 1)) - commDeal
          const rate = await this.getUsdRate(order.symbol)
          const totalUsd =
            total *
            (!(await this.profitBase(findDeal.deal))
              ? 1
              : findDeal.deal.lastPrice) *
            rate
          findDeal.deal.profit = {
            ...findDeal.deal.profit,
            total: findDeal.deal.profit.total + total,
            totalUsd: findDeal.deal.profit.totalUsd + totalUsd,
          }
          findDeal.deal.tpHistory = (findDeal.deal.tpHistory ?? []).filter(
            (t) => t.id !== order.clientOrderId,
          )
          this.updateUserProfitStep()
          let reopen = false
          if (!isReduce) {
            if (
              order.tpSlTarget &&
              !((findDeal.deal.tpSlTargetFilled ?? []) as string[]).includes(
                order.tpSlTarget,
              )
            ) {
              findDeal.deal.tpSlTargetFilled = [
                ...(findDeal.deal.tpSlTargetFilled ?? []),
                order.tpSlTarget,
              ]
              findDeal.deal.tpFilledHistory =
                findDeal.deal.tpFilledHistory ?? []
              findDeal.deal.tpFilledHistory.push({
                id: order.tpSlTarget,
                price,
                qty,
              })
            }
            findDeal.currentOrders = findDeal.currentOrders.filter(
              (o) => o.type !== TypeOrderEnum.dealRegular,
            )

            if (
              order.tpSlTarget &&
              (settings.multiSl ?? [])
                .map((tp) => tp.uuid)
                .includes(order.tpSlTarget)
            ) {
              findDeal.previousOrders = findDeal.currentOrders
              findDeal.currentOrders = await this.createCurrentDealOrders(
                findDeal.deal.symbol.symbol,
                price,
                findDeal.initialOrders,
                findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
                findDeal.deal.initialPrice,
                findDeal.deal._id,
                false,
                findDeal.deal,
                false,
              )
              reopen = true
            }
            if (findDeal.notCheckSl) {
              findDeal.notCheckSl = false
            }
          }
          if (isReduce) {
            findDeal.previousOrders = findDeal.currentOrders
            findDeal.currentOrders = await this.createCurrentDealOrders(
              findDeal.deal.symbol.symbol,
              price,
              findDeal.initialOrders,
              findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
              findDeal.deal.initialPrice,
              findDeal.deal._id,
              false,
              findDeal.deal,
              false,
            )
          }
          findDeal.deal.commission += commDeal
          findDeal.closeByTp = false
          this.saveDeal(findDeal, {
            commission: findDeal.deal.commission,
            profit: findDeal.deal.profit,
            updateTime: findDeal.deal.updateTime,
            lastPrice: findDeal.deal.lastPrice,
            currentBalances: findDeal.deal.currentBalances,
            tpSlTargetFilled: findDeal.deal.tpSlTargetFilled,
            tpFilledHistory: findDeal.deal.tpFilledHistory,
            blockSl: findDeal.deal.blockSl,
            tpHistory: findDeal.deal.tpHistory,
            reduceFunds: findDeal.deal.reduceFunds,
            pendingReduceFunds: findDeal.deal.pendingReduceFunds,
          }).then(async () => {
            if (isReduce) {
              this.updateUsage(dealId)
              this.updateAssets(dealId)
              this.sendDealClosedAlert(findDeal.deal, order, true)
            }
            // A take-profit target that just filled has to be disarmed, not
            // only the multi-SL one. `dealsForTPLevelCheck` and the price
            // extremum still hold the target that filled; `getDealTPLevelToCheck`
            // drops it only when it is recomputed against `tpFilledHistory`.
            // Until then the next tick above that price re-fires `checkTPLevel`
            // for a target that is already done — it re-sends the same
            // clientOrderId, which comes back "already processed", and the
            // `closeByTp` flag it set on the way in is never cleared. That is
            // what stranded the remaining targets of a live Coinbase multi-TP
            // deal for nearly three hours.
            await this.checkDealSlMethods(findDeal)
            this.checkDealsPriceExtremum()
          })

          this.updateAssets(dealId, findDeal)
          if (!isReduce) {
            const activeOrders = this.getOrdersByStatusAndDealId({
              dealId,
              defaultStatuses: true,
            }).filter((o) => o.typeOrder === TypeOrderEnum.dealRegular)
            for (const aOrder of activeOrders) {
              await this.cancelOrderOnExchange(aOrder)
            }
            if (reopen) {
              this.placeOrders(
                this.botId,
                order.symbol,
                dealId,
                this.findDiff(findDeal.currentOrders, findDeal.previousOrders),
              )
            }
          }
          if (isReduce) {
            if (this.data) {
              this.data.dealsReduceForBot =
                this.data.dealsReduceForBot?.filter(
                  (d) => d.id !== findDeal.deal._id,
                ) ?? []

              this.data.dealsReduceForBot?.push({
                id: findDeal.deal._id,
                profit: findDeal.deal.profit.total,
                profitUsd: findDeal.deal.profit.totalUsd,
                base:
                  (findDeal.deal.reduceFunds?.reduce(
                    (acc, v) => acc + v.qty,
                    0,
                  ) ?? 0) *
                  (await this.getUsdRate(findDeal.deal.symbol.symbol, 'base')),
                quote:
                  (findDeal.deal.reduceFunds?.reduce(
                    (acc, v) => acc + v.qty * v.price,
                    0,
                  ) ?? 0) *
                  (await this.getUsdRate(findDeal.deal.symbol.symbol, 'quote')),
              })
              this.updateData({
                dealsReduceForBot: this.data.dealsReduceForBot,
              })
              this.emit('bot settings update', {
                dealsReduceForBot: this.data.dealsReduceForBot,
              })
            }
            this.placeOrders(
              this.botId,
              order.symbol,
              dealId,
              this.findDiff(findDeal.currentOrders, findDeal.previousOrders),
            )
          }
        } else {
          this.handleLog(`Regular order FILLED ${order.clientOrderId}`)
          const avgPrice = await this.getAvgPrice(dealId)

          if (price !== +order.origPrice) {
            const breakpoint = {
              price: +order.origPrice,
              displacedPrice: price,
            }
            findDeal.deal.gridBreakpoints = await this.aggregateBreakpoint(
              breakpoint,
              findDeal.deal,
            )
            findDeal.initialOrders = await this.createInitialDealOrders(
              findDeal.deal.symbol.symbol,
              findDeal.deal.initialPrice,
              `${findDeal.deal._id}`,
              findDeal.deal,
            )
            this.saveDeal(findDeal, {
              gridBreakpoints: findDeal.deal.gridBreakpoints,
            })
          }
          findDeal.deal.avgPrice = avgPrice.avg
          findDeal.deal.displayAvg = avgPrice.display
          findDeal.deal.settings.avgPrice = findDeal.deal.avgPrice
          findDeal.deal.levels.complete = Math.max(
            findDeal.deal.levels.complete ?? 1,
            this.getOrdersByStatusAndDealId({
              dealId: findDeal.deal._id,
              status: ['FILLED', 'CANCELED'],
            }).filter(
              (o) =>
                (o.typeOrder === TypeOrderEnum.dealRegular ||
                  o.typeOrder === TypeOrderEnum.dealStart) &&
                (this.data?.exchange === ExchangeEnum.bybit
                  ? +o.executedQty !== 0
                  : o.status === 'FILLED'),
            ).length ?? 1,
          )
          if (
            findDeal.currentOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ).length === 0
          ) {
            findDeal.deal.levels.all = Math.max(
              findDeal.deal.levels.complete,
              1 +
                findDeal.initialOrders.filter(
                  (o) => o.type === TypeOrderEnum.dealRegular,
                ).length,
              1 + (findDeal.deal.funds ?? []).length,
            )
          }
          if (findDeal.deal.levels.complete > findDeal.deal.levels.all) {
            findDeal.deal.levels.all = findDeal.deal.levels.complete
          }
          findDeal.previousOrders = findDeal.currentOrders
          findDeal.currentOrders = await this.createCurrentDealOrders(
            findDeal.deal.symbol.symbol,
            price,
            findDeal.initialOrders,
            findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
            findDeal.deal.initialPrice,
            findDeal.deal._id,
            false,
            findDeal.deal,
            false,
          )
          findDeal.closeByTp = false
          if (findDeal.deal.bestPrice) {
            findDeal.deal.bestPrice = 0
          }
          this.handleDebug(
            `Avg price ${findDeal.deal.avgPrice} @ ${findDeal.deal.symbol.baseAsset} / ${findDeal.deal.symbol.quoteAsset}`,
          )
          await this.checkDealSlMethods(findDeal)
          this.checkDealsPriceExtremum()
          this.saveDeal(findDeal, {
            avgPrice: findDeal.deal.avgPrice,
            displayAvg: findDeal.deal.displayAvg,
            'settings.avgPrice': findDeal.deal.settings.avgPrice,
            currentBalances: findDeal.deal.currentBalances,
            updateTime: findDeal.deal.updateTime,
            levels: findDeal.deal.levels,
            lastPrice: findDeal.deal.lastPrice,
          }).then(() => {
            this.updateUsage(dealId)
            this.updateDealLastPrices(this.botId)
            this.updateAssets(dealId)
          })

          await this.placeOrders(
            this.botId,
            order.symbol,
            dealId,
            this.findDiff(findDeal.currentOrders, findDeal.previousOrders),
          )
        }
      } else if (
        dealId &&
        order.botId === this.botId &&
        (!findDeal || findDeal.deal.status === DCADealStatusEnum.closed)
      ) {
        await this.sellRemainder(
          dealId,
          +order.executedQty,
          +order.price,
          false,
          findDeal,
        )
      }
      this.endMethod(_id)
    }
    /**
     * Check TP order status after timeout
     * @param {string} id Base order id to check
     */
    @IdMute(
      mutex,
      (botId: string, _id: string, dealId: string) =>
        `${botId}${dealId ?? 'closeById'}`,
    )
    async checkTPOrder(
      _botId: string,
      id: string,
      dealId: string,
      closeType: CloseDCATypeEnum = CloseDCATypeEnum.leave,
      reopen = true,
      forceMarket = false,
      checkProfit = false,
    ) {
      if (this.orders) {
        const find = this.getOrderFromMap(id)
        if (this.hyperliquid && +(find?.executedQty || '0') > 0) {
          this.handleLog(
            `Hyperliquid base order ${id} has partial fill ${find?.executedQty}, skip check`,
          )
          return
        }
        if (
          find &&
          find.status !== 'FILLED' &&
          find.status !== 'PARTIALLY_FILLED'
        ) {
          this.handleLog(`${id} not filled. Create new one`)
          const findOtherTp = this.getOrdersByStatusAndDealId({ dealId }).find(
            (o) =>
              o.typeOrder === TypeOrderEnum.dealTP &&
              o.status !== 'CANCELED' &&
              o.clientOrderId !== find.clientOrderId,
          )
          if (findOtherTp) {
            this.handleLog(`${dealId} have processed TP order`)
            return
          }
          const cancelOrder = await this.cancelOrderOnExchange(find)
          if (cancelOrder?.status === 'FILLED') {
            return this.handleUnknownOrder(cancelOrder)
          }
          this.closeDealById(
            this.botId,
            dealId,
            closeType,
            reopen,
            forceMarket,
            undefined,
            checkProfit,
            undefined,
            undefined,
            cancelOrder?.sl,
          )
        }
      }
    }
    /**
     * Check base order status after timeout
     * @param {string} id Base order id to check
     * @param {string} dealId Deal id base order to check
     */
    @IdMute(
      mutex,
      (botId: string, _symbol: string) => `${botId}placeBaseOrder${_symbol}`,
    )
    async checkBaseOrder(
      _botId: string,
      symbol: string,
      id?: string,
      dealId?: string,
      forceMarket = false,
    ) {
      if (this.orders) {
        if (id) {
          const find = this.getOrderFromMap(id)
          if (this.hyperliquid && +(find?.executedQty || '0') > 0) {
            this.handleLog(
              `Hyperliquid base order ${id} has partial fill ${find?.executedQty}, skip check`,
            )
            return
          }
          if (
            find &&
            find.status !== 'FILLED' &&
            find.status !== 'PARTIALLY_FILLED'
          ) {
            const deal = this.getDeal(find.dealId)
            this.handleLog(`${id} not filled. Create new one`)
            const cancelBase = await this.cancelOrderOnExchange(find)
            if (cancelBase?.status === 'FILLED') {
              return this.handleUnknownOrder(cancelBase)
            }
            if (deal?.deal.status === DCADealStatusEnum.start) {
              this.placeBaseOrder(
                this.botId,
                symbol,
                find.dealId,
                forceMarket,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                deal.deal.dynamicAr,
                deal.deal.sizes,
                deal.deal.orderSizeType,
              )
            } else {
              this.handleLog(
                `Deal ${find.dealId} not in start status ${deal?.deal.status}`,
              )
            }
          }
        } else if (dealId) {
          this.handleLog(`Deal ${dealId} enter market price`)
          const findDeal = this.getDeal(dealId)
          if (findDeal?.deal.enterMarketPrice) {
            this.handleLog(`Deal ${dealId} already enter market price`)
            return
          }
          const findDealTimer = this.dealTimersMap.get(dealId)
          if (findDealTimer && findDealTimer.limitTimer) {
            clearTimeout(findDealTimer.limitTimer)
            findDealTimer.limitTimer = null
            this.dealTimersMap.set(dealId, findDealTimer)
            this.handleLog(`Deal ${dealId} clear limit timer`)
          }
          const find = this.getOrdersByStatusAndDealId({ dealId }).find(
            (o) => o.typeOrder === TypeOrderEnum.dealStart,
          )
          if (this.hyperliquid && +(find?.executedQty || '0') > 0) {
            this.handleLog(
              `Hyperliquid base order for deal ${dealId} has partial fill ${find?.executedQty}, skip check`,
            )
            return
          }
          this.handleLog(
            `Deal ${dealId} ${
              find
                ? `found base order with status ${find.status}`
                : 'not found base order'
            }`,
          )
          if (
            (find &&
              find.status !== 'FILLED' &&
              find.status !== 'PARTIALLY_FILLED') ||
            !find
          ) {
            if (find?.status === 'NEW') {
              const cancelBase = await this.cancelOrderOnExchange(find)
              if (cancelBase?.status === 'FILLED') {
                return this.handleUnknownOrder(cancelBase)
              }
            }
            if (findDeal?.deal.status !== DCADealStatusEnum.start) {
              this.handleLog(
                `Deal ${dealId} not in start status ${findDeal?.deal.status}`,
              )
              return
            }
            // `enterMarketPrice` is the one-way latch that makes this method
            // return early forever after, so it must record that the deal HAS
            // entered at market — not that we are about to try. It used to be
            // written here, before the send, and `placeBaseOrder` cannot be
            // awaited to learn the outcome (it shares this method's
            // `${botId}placeBaseOrder${symbol}` mutex, so awaiting it
            // deadlocks). A venue refusal therefore latched the flag on a deal
            // whose resting base order had just been cancelled to make room for
            // the market entry, leaving it in `start` with no order on the book
            // and no path back — see bug #505, deal 6a8db1f2271530b06e5360a6 on
            // a Coinbase book in limit-only mode. The latch now lives in
            // `placeBaseOrder`, where the venue's answer is known.
            this.placeBaseOrder(
              this.botId,
              symbol,
              dealId,
              forceMarket,
              true,
              undefined,
              undefined,
              undefined,
              undefined,
              findDeal.deal.dynamicAr,
              findDeal.deal.sizes,
              findDeal.deal.orderSizeType,
            )
          }
        }
      }
    }

    async getBaseOrder(
      symbol: string,
      dealId?: string,
      forceMarket?: boolean,
      inputPrice?: number,
      count = 0,
      fixSize = 0,
      sizes?: Sizes | null,
      _override_orderSizeType?: OrderSizeTypeEnum,
    ) {
      const fee = await this.getUserFee(symbol)
      const ed = await this.getExchangeInfo(symbol)
      if (this.data && this.exchange && ed && fee) {
        const settings = await this.getAggregatedSettings()
        if (
          this.data &&
          settings.terminalDealType === TerminalDealTypeEnum.import &&
          settings.baseOrderPrice &&
          settings.baseOrderSize
        ) {
          const ed = await this.getExchangeInfo(symbol)
          if (ed) {
            const price = +settings.baseOrderPrice
            const qty = await this.getSmartSellOrderQty(
              symbol,
              await this.checkAssets(true, true),
            )
            const order: Order = {
              clientOrderId: this.getOrderId(`D-BO`),
              status: 'FILLED',
              executedQty: `${qty}`,
              price: `${price}`,
              origPrice: `${price}`,
              cummulativeQuoteQty: `${price * qty}`,
              orderId: '-1',
              origQty: `${qty}`,
              side: this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell,
              symbol,
              type: OrderTypeEnum.limit,
              updateTime: new Date().getTime(),
              transactTime: new Date().getTime(),
              exchange: this.data.exchange,
              exchangeUUID: this.data.exchangeUUID,
              typeOrder: TypeOrderEnum.dealStart,
              botId: this.botId,
              userId: this.userId,
              dealId,
              fills: [],
              baseAsset: ed.baseAsset.name,
              quoteAsset: ed.quoteAsset.name,
            }
            return order
          }
        }
        const { orderSizeType: _orderSizeType, useLimitPrice } = settings
        const orderSizeType =
          _override_orderSizeType ??
          (fixSize
            ? settings.futures
              ? settings.coinm
                ? OrderSizeTypeEnum.base
                : OrderSizeTypeEnum.quote
              : settings.strategy === StrategyEnum.long
                ? OrderSizeTypeEnum.quote
                : OrderSizeTypeEnum.base
            : _orderSizeType)
        const baseOrderSize = fixSize || +(settings.baseOrderSize ?? '0')
        const baseOrderPrice = +(settings.baseOrderPrice ?? '0')
        const precision = await this.baseAssetPrecision(symbol)
        const priceRequest = inputPrice ?? (await this.getLatestPrice(symbol))
        if (priceRequest === 0) {
          this.handleDebug('Get latest price. Latest price = 0. getBaseOrder')
          return
        }
        const baseOrderType = settings.startOrderType ?? OrderTypeEnum.market
        const type = forceMarket ? OrderTypeEnum.market : baseOrderType
        const slippage =
          (settings.type === DCATypeEnum.terminal ? 0 : 0.005) *
          (1 + count / 10)
        let price =
          priceRequest *
          (1 -
            (type === OrderTypeEnum.market ? slippage : 0) *
              (this.isLong ? 1 : -1) *
              (this.useCompountReduce ? -1 : 1))
        let useLimit = false
        if (
          settings.startOrderType === OrderTypeEnum.limit &&
          baseOrderPrice &&
          baseOrderPrice !== 0 &&
          !isNaN(baseOrderPrice) &&
          settings.type === DCATypeEnum.terminal &&
          useLimitPrice
        ) {
          useLimit = true
          price = baseOrderPrice
        }
        price = this.math.round(price, ed.priceAssetPrecision)
        const short = !this.isLong
        // A SPOT LONG entry is grossed up by one taker fee so the deal ends up
        // able to close the size the user configured. A SHORT entry SELLS base
        // — the fee never comes out of the base sent — so grossing up there just
        // sells MORE base than the user asked for (and more than the safety
        // orders, which never gross up). Bug #396.
        //
        // ⚠️ The reason this gross-up is correct is VENUE-SPECIFIC, and the
        // obvious reading of it is wrong on at least one venue. This comment
        // used to say "spot fees are charged in the asset you RECEIVE, so the
        // fill credits base minus fee". That holds on Binance-shaped venues. It
        // does NOT hold on Kraken, whose `oflags` default is `fciq` for a BUY
        // (fee in QUOTE) and `fcib` for a SELL (fee in BASE) — we set no
        // oflags, so both defaults apply. A Kraken buy therefore credits the
        // FULL quantity and takes its fee in quote.
        //
        // The gross-up is still right there, for the other reason: it funds the
        // SELL leg's base-denominated fee. Buy `Q = size/price * (1 + f)`, close
        // `Q * (1 - f)`, and Kraken takes `f` of that sale in base — which is
        // almost exactly the extra base the entry bought. Verified end to end
        // against a live ETH-EUR deal (2026-08-27): real base left over was
        // 0.0000115 ETH, and the reported deal total of -4.861308 reproduced the
        // venue economics to six decimals.
        //
        // So do NOT "fix" this by removing the gross-up on Kraken. Removing it
        // leaves the close short of the base it needs to pay its own fee. If you
        // ever set `oflags`, or add a venue whose fee currency differs again,
        // re-derive this per venue rather than trusting either explanation.
        const feeFactor =
          this.futures || short
            ? 1
            : settings.terminalDealType === TerminalDealTypeEnum.simple
              ? 1
              : 1 + fee.taker
        let qty = this.math.round(
          (baseOrderSize / price) * feeFactor + (sizes?.base ?? 0),
          precision,
          true,
        )
        if (orderSizeType === OrderSizeTypeEnum.base) {
          qty = this.math.round(
            baseOrderSize * feeFactor + (sizes?.base ?? 0),
            precision,
            true,
          )
        }
        if (orderSizeType === OrderSizeTypeEnum.usd) {
          qty = this.math.round(
            (baseOrderSize * feeFactor) /
              ((await this.getUsdRate(symbol, 'quote')) * price) +
              (sizes?.base ?? 0),
            precision,
            true,
          )
        }
        if (orderSizeType === OrderSizeTypeEnum.quote && this.coinm) {
          qty = this.math.round(
            (baseOrderSize * ed.quoteAsset.minAmount) / price +
              (sizes?.base ?? 0),
            precision,
            true,
          )
        }
        if (
          orderSizeType === OrderSizeTypeEnum.percFree ||
          orderSizeType === OrderSizeTypeEnum.percTotal
        ) {
          const balances = await this.getBalancesFromExchange()
          if (balances && balances.status === StatusEnum.ok) {
            const long = this.isLong
            const asset = this.futures
              ? this.coinm
                ? ed.baseAsset.name
                : ed.quoteAsset.name
              : ed?.[long ? 'quoteAsset' : 'baseAsset'].name
            const find = balances.data.find((b) => b.asset === asset)
            if (find) {
              let useQty =
                orderSizeType === OrderSizeTypeEnum.percFree
                  ? find.free
                  : find.free + find.locked
              if (dealId) {
                if (this.shouldProceed()) {
                  await this.dealsDb.updateData({ _id: `${dealId}` } as any, {
                    $set: { balanceStart: useQty },
                  })
                }

                const findDeal = this.getDeal(`${dealId}`)
                if (findDeal) {
                  findDeal.deal.balanceStart = useQty
                  this.saveDeal(findDeal, {
                    balanceStart: findDeal.deal.balanceStart,
                  })
                }
              }
              useQty = useQty * (baseOrderSize / 100)
              if (this.futures) {
                useQty *= await this.getLeverageMultipler(
                  this.getDeal(dealId)?.deal,
                )
              }
              qty = this.math.round(
                (this.futures
                  ? this.coinm
                    ? useQty
                    : useQty / (useLimit ? price : priceRequest)
                  : long
                    ? useQty / (useLimit ? price : priceRequest)
                    : useQty) * (baseOrderSize === 100 ? 1 : feeFactor),
                precision,
                true,
              )
            } else {
              return this.handleErrors(
                `Asset ${asset} not found in user balances`,
                'placeBaseOrder',
              )
            }
          } else {
            return this.handleErrors(
              `Error getting balance: ${balances?.reason}`,
              'placeBaseOrder',
            )
          }
        }
        if (
          settings.useTp &&
          ((settings.tpPerc &&
            settings.dealCloseCondition === CloseConditionEnum.tp) ||
            (settings.useMinTP &&
              settings.minTp &&
              (settings.dealCloseCondition === CloseConditionEnum.techInd ||
                settings.dealCloseCondition === CloseConditionEnum.webhook))) &&
          (!this.futures ||
            (this.futures && this.data.exchange === ExchangeEnum.bitgetUsdm))
        ) {
          const perc =
            settings.dealCloseCondition === CloseConditionEnum.tp
              ? +(settings.tpPerc ?? '0') / 100
              : +(settings.minTp ?? '0') / 100

          const tpPrice = price * (1 + perc)
          const tpQty = this.math.round(qty * (2 - feeFactor), precision, true)
          if (tpQty * tpPrice < ed.quoteAsset.minAmount) {
            qty = this.math.round(
              (ed.quoteAsset.minAmount / tpPrice) * feeFactor +
                ed.baseAsset.step,
              precision,
              false,
              true,
            )
          }
          if (tpQty < ed.baseAsset.minAmount) {
            qty = this.math.round(
              ed.baseAsset.minAmount * feeFactor + ed.baseAsset.step,
              precision,
              false,
              true,
            )
          }
        }
        if (qty < ed.baseAsset.minAmount) {
          qty = this.math.round(
            ed.baseAsset.minAmount * feeFactor,
            precision,
            false,
            true,
          )
        }
        // A venue measures the minimum notional at the price the order will
        // actually transact at: the live market price for a MARKET order, the
        // limit price for a LIMIT one. `price` above carries the slippage
        // shift, which for a SHORT sits ABOVE the market — sizing against it
        // satisfies this guard while the notional the exchange sees is still
        // under the minimum, so the entry is rejected and the slippage ladder
        // (which raises the price, and so shrinks qty, on every rung) can never
        // converge. Size against whichever of the two is lower so the notional
        // clears at both. For a LONG the slippage price is already the lower
        // one, so this leaves that side untouched. See bug #376.
        const notionalPrice =
          type === OrderTypeEnum.market ? Math.min(price, priceRequest) : price
        if (qty * notionalPrice < ed.quoteAsset.minAmount) {
          qty = this.math.round(
            (ed.quoteAsset.minAmount / notionalPrice) * feeFactor,
            precision,
            false,
            true,
          )
        }
        if (!this.futures && short && settings.useTp && settings.tpPerc) {
          const tpPerc = +settings.tpPerc / 100
          if (
            this.math.round(qty / feeFactor, precision, true) *
              price *
              (1 - tpPerc) <
            ed.quoteAsset.minAmount
          ) {
            qty = this.math.round(
              qty + ed.baseAsset.step,
              precision,
              false,
              true,
            )
          }
        }
        if (this.coinm) {
          const cont = (price * qty) / ed.quoteAsset.minAmount
          if (cont < 1) {
            qty = this.math.round(
              ed.quoteAsset.minAmount / price,
              precision,
              false,
              true,
            )
          } else if (cont % 1 > Number.EPSILON) {
            qty = this.math.round(
              (this.math.round(cont, 0) * ed.quoteAsset.minAmount) / price,
              precision,
              false,
              true,
            )
          }
        }
        try {
          const mod = +new Big(qty).mod(ed.baseAsset.step).toFixed(20)
          if (mod !== 0) {
            qty = this.math.round(
              qty - mod + ed.baseAsset.step,
              precision,
              false,
              true,
            )
          }
        } catch (e) {
          this.handleErrors(
            `Big number error ${(e as Error).message || e}`,
            'getBaseOrder',
            '',
            false,
            false,
            false,
          )
        }
        const baseId = this.getOrderId(`D-BO`)

        const baseOrder: Order = {
          clientOrderId: baseId,
          status: 'NEW',
          executedQty: '0',
          price: `${price}`,
          origPrice: `${price}`,
          cummulativeQuoteQty: `${price * qty}`,
          orderId: '-1',
          origQty: `${qty}`,
          side: this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell,
          symbol,
          type:
            settings.useRiskReward && !useLimit
              ? OrderTypeEnum.market
              : forceMarket
                ? OrderTypeEnum.market
                : baseOrderType,
          updateTime: new Date().getTime(),
          transactTime: new Date().getTime(),
          exchange: this.data.exchange,
          exchangeUUID: this.data.exchangeUUID,
          typeOrder: TypeOrderEnum.dealStart,
          botId: this.botId,
          userId: this.userId,
          dealId,
          fills: [],
          baseAsset: ed.baseAsset.name,
          quoteAsset: ed.quoteAsset.name,
          positionSide: this.hedge
            ? this.isLong
              ? PositionSide.LONG
              : PositionSide.SHORT
            : PositionSide.BOTH,
        }
        return baseOrder
      }
    }
    /**
     * Place base order<br />
     * @param {string} [oldDealId] Deal id to create a new base order
     */
    @IdMute(
      mutex,
      (botId: string, symbol: string) => `${botId}placeBaseOrder${symbol}`,
    )
    async placeBaseOrder(
      _botId: string,
      symbol: string,
      oldDealId?: string,
      forceMarket = false,
      cancelPending = false,
      count = 0,
      fixSl = 0,
      fixTp = 0,
      fixSize = 0,
      dynamicAr: DynamicArPrices[] = [],
      sizes?: Sizes | null,
      orderSizeType?: OrderSizeTypeEnum,
    ) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('place base order'))
        return
      }
      const _id = this.startMethod('placeBaseOrder')
      let dealId: string | undefined
      if (!oldDealId) {
        this.handleLog('Create new deal')
        dealId = await this.createDeal(
          symbol,
          fixSl,
          fixTp,
          fixSize,
          dynamicAr,
          sizes,
          orderSizeType,
        )
        if (!dealId) {
          this.resetPending(this.botId, symbol)
          this.endMethod(_id)
          return this.handleErrors(
            `Cannot create deal for ${symbol}`,
            'placeBaseOrder',
            '',
            false,
          )
        }
      }
      const settings = await this.getAggregatedSettings()
      if (settings.terminalDealType === TerminalDealTypeEnum.import) {
        const order = await this.getBaseOrder(
          symbol,
          dealId,
          forceMarket,
          undefined,
          undefined,
          fixSize,
        )
        if (order) {
          this.setOrder(order)
          this.ordersDb.createData(order)
          this.endMethod(_id)
          return this.startDeal(order)
        }
      }
      if (oldDealId) {
        dealId = oldDealId
      }
      const deal = this.getDeal(dealId)
      if (deal?.deal.status === DCADealStatusEnum.open) {
        this.handleLog(`Deal ${dealId} already open`)
        this.endMethod(_id)
        return
      }
      if (cancelPending) {
        for (const order of this.getOrdersByStatusAndDealId({
          status: 'NEW',
          dealId,
        }).filter((o) => o.typeOrder === TypeOrderEnum.dealStart)) {
          const o = await this.cancelOrderOnExchange(order)
          if (o?.status === 'FILLED') {
            this.endMethod(_id)
            return this.handleUnknownOrder(o)
          }
        }
      }
      const currentBase = this.getOrdersByStatusAndDealId({
        dealId,
        defaultStatuses: true,
      }).find((o) => o.typeOrder === TypeOrderEnum.dealStart)
      if (currentBase) {
        this.endMethod(_id)
        return this.handleLog(
          `Deal ${dealId} already have and active base order`,
        )
      }
      if (this.data && this.exchange) {
        const baseOrder = await this.getBaseOrder(
          symbol,
          dealId,
          forceMarket,
          undefined,
          count,
          fixSize,
          sizes,
          orderSizeType,
        )
        if (forceMarket && sizes && this.useCompountReduce && baseOrder) {
          const deal = this.getDeal(dealId)
          if (deal && deal.deal.sizes) {
            deal.deal.sizes.origBase =
              +baseOrder.origQty + (deal.deal.sizes.base ?? 0)
            this.saveDeal(deal, { sizes: deal.deal.sizes })
          }
        }
        const { startOrderType, useLimitPrice } = settings
        const baseOrderPrice = +(settings.baseOrderPrice ?? '0')
        if (baseOrder) {
          this.updateDealLastPrices(this.botId, {
            symbol,
            entry: +baseOrder.price,
            avg: +baseOrder.price,
            time: this.getDeal(dealId)?.deal.createTime,
          })
          if (!this.data.settings.futures) {
            if (this.data?.action) {
              this.db?.updateData(
                { _id: this.botId },
                { $unset: { action: null } },
              )
              this.data.action = undefined
            }
            if (!oldDealId && dealId) {
              const deal = this.getDeal(dealId)
              if (!deal) {
                this.resetPending(this.botId, symbol)
                this.endMethod(_id)
                return this.handleErrors(
                  `Cannot find deal ${dealId} after creation`,
                  'placeBaseOrder',
                  '',
                  false,
                  false,
                  false,
                )
              }
              if (
                deal.deal.action &&
                deal.deal.action !== ActionsEnum.useBalance
              ) {
                if (deal.deal.action === ActionsEnum.noAction) {
                  this.resetPending(this.botId, symbol)
                  this.endMethod(_id)
                  return this.handleErrors(
                    `Cannot place base order. Action is noAction`,
                    'placeBaseOrder',
                  )
                }
                let proceedBaseOrder = false
                if (
                  [
                    ActionsEnum.buyDiff,
                    ActionsEnum.buyForAll,
                    ActionsEnum.sellDiff,
                    ActionsEnum.sellForAll,
                  ].includes(deal.deal.action) &&
                  deal.deal.settings.useDca
                ) {
                  this.handleDebug(`Action ${deal.deal.action} detected`)
                  const lp = await this.getLatestPrice(symbol)
                  const orders = await this.createInitialDealOrders(
                    symbol,
                    lp,
                    dealId,
                    deal.deal,
                  )
                  const required = this.isLong
                    ? orders.reduce((acc, v) => acc + v.qty * v.price, 0) / lp
                    : orders.reduce((acc, v) => acc + v.qty, 0) * lp
                  this.handleDebug(
                    `Required amount for ${deal.deal.action} is ${required}, price is ${lp}`,
                  )
                  const ei = await this.getExchangeInfo(symbol)
                  const balance =
                    (await this.checkAssets(true, true))?.get(
                      (this.isLong
                        ? ei?.baseAsset.name
                        : ei?.quoteAsset.name) ?? '',
                    )?.free ?? 0
                  this.handleDebug(`Available balance is ${balance}`)
                  const orderSize = [
                    ActionsEnum.buyDiff,
                    ActionsEnum.sellDiff,
                  ].includes(deal.deal.action)
                    ? required - balance
                    : required
                  this.handleDebug(`Order size is ${orderSize}`)
                  if (orderSize > 0) {
                    const price = `${this.math.round(
                      lp,
                      ei?.priceAssetPrecision,
                    )}`
                    const qty = `${this.math.round(
                      orderSize * (this.isLong ? 1 : 1 / lp),
                      await this.baseAssetPrecision(symbol),
                    )}`
                    const r = await this.sendOrderToExchange(
                      {
                        clientOrderId: this.getOrderId('CMB-H'),
                        status: 'NEW',
                        executedQty: '0',
                        price: price,
                        origPrice: price,
                        cummulativeQuoteQty: `${+price * +qty}`,
                        orderId: '-1',
                        origQty: `${qty}`,
                        side: this.isLong
                          ? OrderSideEnum.sell
                          : OrderSideEnum.buy,
                        symbol,
                        type: OrderTypeEnum.market,
                        updateTime: new Date().getTime(),
                        transactTime: new Date().getTime(),
                        exchange: this.data.exchange,
                        exchangeUUID: this.data.exchangeUUID,
                        typeOrder: TypeOrderEnum.dealStart,
                        botId: this.botId,
                        userId: this.userId,
                        dealId,
                        fills: [],
                        baseAsset: ei?.baseAsset.name ?? '',
                        quoteAsset: ei?.quoteAsset.name ?? '',
                      },
                      true,
                    )
                    if (typeof r === 'string') {
                      this.endMethod(_id)
                      return this.handleErrors(
                        `Error placing order: ${r}`,
                        'placeBaseOrder',
                        '',
                        false,
                        false,
                        false,
                      )
                    }
                    if (!r) {
                      this.endMethod(_id)
                      return this.handleErrors(
                        `Error placing order`,
                        'placeBaseOrder',
                        '',
                        false,
                        false,
                        false,
                      )
                    }
                    this.handleDebug(`Order ${r.clientOrderId} filled`)
                  }
                  proceedBaseOrder = true
                }
                if (deal.deal.action === ActionsEnum.useOppositeBalance) {
                  this.handleDebug(`Action ${deal.deal.action} detected`)
                  proceedBaseOrder = true
                }
                if (proceedBaseOrder) {
                  baseOrder.status = 'FILLED'
                  baseOrder.executedQty = baseOrder.origQty
                  this.setOrder(baseOrder)
                  this.ordersDb.createData(baseOrder)
                  this.endMethod(_id)
                  return this.startDeal(baseOrder)
                }
              }
            }
          }
          this.handleLog('Send base order')
          // The last rung of the slippage ladder downgrades the entry to a
          // LIMIT so the venue accepts its notional. That leaves a RESTING
          // order even when the bot's `startOrderType` is MARKET, so the timer
          // block below has to key off what was actually sent — see bug #376.
          const sentType =
            count === this.slippageRetry ? OrderTypeEnum.limit : baseOrder.type
          const result = await this.sendOrderToExchange(
            {
              ...baseOrder,
              type: sentType,
            },
            true,
          )
          if (result) {
            if (typeof result !== 'string' && forceMarket) {
              // The venue accepted the forced market entry, so only NOW is it
              // true that this deal entered at market. Latching this before the
              // send (which is where `checkBaseOrder` used to do it) stranded
              // deals whose market order was refused — bug #505.
              const enteredDeal = this.getDeal(dealId)
              if (enteredDeal && !enteredDeal.deal.enterMarketPrice) {
                enteredDeal.deal.enterMarketPrice = true
                await this.saveDeal(enteredDeal, {
                  enterMarketPrice: enteredDeal.deal.enterMarketPrice,
                })
              }
            }
            if (typeof result === 'string') {
              if (
                forceMarket &&
                startOrderType === OrderTypeEnum.limit &&
                sentType === OrderTypeEnum.market &&
                this.isLimitOnlyReason(result)
              ) {
                // The book is in limit-only mode, so this market entry can
                // never be accepted, however many times we retry it. The
                // caller (`checkBaseOrder`'s enter-market path) has already
                // cancelled the resting LIMIT base order to make room for it,
                // so giving up here leaves the deal in `start` with nothing on
                // the book at all. Re-place as a LIMIT — the same order the
                // ladder was resting before the fallback fired — instead of
                // abandoning the entry. Not awaited and `count` is not
                // advanced: this is the same rung retried in a different order
                // type, and awaiting would deadlock on our own mutex.
                //
                // The `startOrderType` guard is what makes this terminate:
                // `getBaseOrder` derives the type as
                // `forceMarket ? market : (startOrderType ?? market)`, so the
                // re-place below only actually produces a LIMIT for a
                // limit-entry bot. Without it, a MARKET-entry bot whose last
                // slippage rung happened to arm the enter-market timer would
                // re-send a market order into the same refusal, forever.
                this.handleLog(
                  `${symbol} book is in limit only mode, cannot enter at market. Re-placing base order as limit`,
                )
                await sleep(250)
                this.placeBaseOrder(
                  this.botId,
                  symbol,
                  dealId,
                  false,
                  cancelPending,
                  count,
                  fixSl,
                  fixTp,
                  fixSize,
                  dynamicAr,
                  sizes,
                  orderSizeType,
                )
              } else if (
                this.isNotionalReason(result) &&
                count < this.slippageRetry
              ) {
                this.handleDebug(
                  `Cannot place base order due to slippage ${
                    baseOrder.clientOrderId
                  }, attempt ${count + 1}`,
                )
                await sleep(250)
                this.placeBaseOrder(
                  this.botId,
                  symbol,
                  dealId,
                  forceMarket,
                  cancelPending,
                  count + 1,
                  fixSl,
                  fixTp,
                  fixSize,
                  dynamicAr,
                  sizes,
                  orderSizeType,
                )
              } else {
                this.handleOrderErrors(
                  result,
                  baseOrder,
                  'limitOrders()',
                  `Send new order request ${baseOrder.clientOrderId}, qty ${baseOrder.origQty}, price ${baseOrder.price}, side ${baseOrder.side}`,
                )
                if (this.data.settings.type === DCATypeEnum.terminal) {
                  this.endMethod(_id)
                  return this.stop()
                }
              }
            } else if (result.status === 'FILLED') {
              await this.startDeal(result)
            } else {
              if (baseOrder.clientOrderId !== result.clientOrderId) {
                baseOrder.clientOrderId = result.clientOrderId
              }
              if (
                (startOrderType === OrderTypeEnum.limit ||
                  sentType === OrderTypeEnum.limit) &&
                (baseOrderPrice === 0 ||
                  isNaN(baseOrderPrice) ||
                  !useLimitPrice)
              ) {
                const deal = this.getDeal(dealId)
                if (deal && count <= this.slippageRetry) {
                  const dealTimer = this.dealTimersMap.get(deal.deal._id) ?? {
                    limitTimer: null,
                    enterMarketTimer: null,
                  }
                  if (
                    this.orderLimitRepositionTimeout !== 0 &&
                    !this.data.settings.notUseLimitReposition
                  ) {
                    if (!this.startTimeoutTime.get(deal.deal._id)) {
                      this.startTimeoutTime.set(
                        deal.deal._id,
                        new Date().getTime(),
                      )
                    }
                    if (
                      this.enterMarketTimeout === 0 ||
                      (this.enterMarketTimeout !== 0 &&
                        new Date().getTime() +
                          this.orderLimitRepositionTimeout <
                          (this.startTimeoutTime.get(deal.deal._id) ??
                            +new Date()) +
                            this.enterMarketTimeout)
                    ) {
                      dealTimer.limitTimer = setTimeout(
                        () =>
                          this.checkBaseOrder(
                            this.botId,
                            symbol,
                            baseOrder.clientOrderId,
                            dealId,
                          ),
                        this.orderLimitRepositionTimeout,
                      )
                    }
                  }
                  if (
                    this.enterMarketTimeout !== 0 &&
                    !dealTimer.enterMarketTimer &&
                    (!this.data.settings.notUseLimitReposition ||
                      (this.data.settings.useLimitTimeout &&
                        this.data.settings.notUseLimitReposition))
                  ) {
                    dealTimer.enterMarketTimer = setTimeout(
                      () =>
                        this.checkBaseOrder(
                          this.botId,
                          symbol,
                          undefined,
                          dealId,
                          true,
                        ),
                      this.enterMarketTimeout,
                    )
                  }
                  this.dealTimersMap.set(deal.deal._id, dealTimer)
                }
              }
            }
          }
        }
      }
      this.endMethod(_id)
    }
    /**
     * Update bot assets
     *
     * @param {string} dealId Id of the deal
     * @param {Order} order Order to change assets
     */

    async updateAssets(dealId: string, deal?: FullDeal<ExcludeDoc<Deal>>) {
      const findDeal = deal ?? this.getDeal(dealId)
      if (this.data && findDeal) {
        const long = this.isLong
        let requiredBase = 0
        let requiredQuote = 0
        const settings = await this.getAggregatedSettings(findDeal.deal)
        const { useTp, useSl, trailingTp, dealCloseCondition } = settings
        const current = await this.createCurrentDealOrders(
          findDeal.deal.symbol.symbol,
          findDeal.deal.lastPrice,
          findDeal.initialOrders,
          findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
          findDeal.deal.initialPrice,
          findDeal.deal._id,
          settings.useSmartOrders &&
            settings.activeOrdersCount !== settings.ordersCount,
          findDeal.deal,
          true,
          false,
        )
        let used = current
        if (
          settings.useSmartOrders &&
          settings.activeOrdersCount !== settings.ordersCount
        ) {
          used = await this.createCurrentDealOrders(
            findDeal.deal.symbol.symbol,
            findDeal.deal.lastPrice,
            findDeal.initialOrders,
            findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
            findDeal.deal.initialPrice,
            findDeal.deal._id,
            false,
            findDeal.deal,
            true,
            false,
          )
        }
        const usedRegular = used.filter(
          (u) => u.type === TypeOrderEnum.dealRegular,
        )
        const all = current.filter((g) => g.type === TypeOrderEnum.dealRegular)
        const leverage = await this.getLeverageMultipler(findDeal.deal)
        const pending = this.getPendingAddFunds(findDeal)
        const pendingReduce = this.getPendingReduceFunds(findDeal)
        if (long) {
          requiredQuote = this.coinm
            ? 0
            : all.reduce((acc, v) => acc + v.qty * v.price, 0) +
              pending.quote -
              pendingReduce.quote
          if (this.coinm) {
            requiredBase =
              all.reduce((acc, v) => acc + v.qty, 0) +
              pending.base -
              pendingReduce.base
          }

          if (!this.futures) {
            if (
              useTp &&
              !trailingTp &&
              dealCloseCondition === CloseConditionEnum.tp &&
              !this.data?.flags?.includes(BotFlags.externalTp)
            ) {
              requiredBase = findDeal.currentOrders
                .filter((g) => g.type === TypeOrderEnum.dealTP)
                .reduce((acc, v) => acc + v.qty, 0)
            } else if (
              (useTp && trailingTp) ||
              (!useTp && useSl) ||
              (useTp && dealCloseCondition !== CloseConditionEnum.tp) ||
              this.data?.flags?.includes(BotFlags.externalTp)
            ) {
              const orders = await this.getTPOrder(
                findDeal.deal.symbol.symbol,
                findDeal.deal.lastPrice,
                findDeal.initialOrders,
                findDeal.deal.avgPrice,
                findDeal.deal.initialPrice,
                findDeal.deal._id,
                findDeal.deal,
              )
              if (orders) {
                requiredBase = orders.reduce((acc, v) => acc + v.qty, 0)
              }
            }
          }
        }
        if (!long) {
          requiredBase =
            this.futures && !this.coinm
              ? 0
              : all.reduce((acc, v) => acc + v.qty, 0) +
                pending.base -
                pendingReduce.base
          if (!(this.futures && !this.coinm)) {
            if (
              useTp &&
              !trailingTp &&
              dealCloseCondition === CloseConditionEnum.tp
            ) {
              requiredQuote = findDeal.currentOrders
                .filter((g) => g.type === TypeOrderEnum.dealTP)
                .reduce((acc, v) => acc + v.qty * v.price, 0)
            } else if (
              (useTp && trailingTp) ||
              (!useTp && useSl) ||
              (useTp && dealCloseCondition !== CloseConditionEnum.tp)
            ) {
              const orders = await this.getTPOrder(
                findDeal.deal.symbol.symbol,
                findDeal.deal.lastPrice,
                findDeal.initialOrders,
                findDeal.deal.avgPrice,
                findDeal.deal.initialPrice,
                findDeal.deal._id,
                findDeal.deal,
              )
              if (orders) {
                requiredQuote = orders.reduce(
                  (acc, v) => acc + v.qty * v.price,
                  0,
                )
              }
            }
          } else {
            requiredQuote =
              all.reduce((acc, v) => acc + v.qty * v.price, 0) +
              pending.quote -
              pendingReduce.quote
          }
        }
        let usedBase =
          used
            .filter((g) => g.side === OrderSideEnum.sell)
            .reduce((acc, v) => acc + v.qty, 0) +
          pending.base -
          pendingReduce.base
        let usedQuote =
          used
            .filter((g) => g.side === OrderSideEnum.buy)
            .reduce((acc, v) => acc + v.qty * v.price, 0) +
          pending.quote -
          pendingReduce.quote
        if (this.futures) {
          if (this.coinm) {
            usedQuote = 0
            usedBase =
              usedRegular.reduce((acc, v) => acc + v.qty, 0) +
              pending.base -
              pendingReduce.base
          } else {
            usedBase = 0
            usedQuote =
              usedRegular.reduce((acc, v) => acc + v.qty * v.price, 0) +
              pending.quote -
              pendingReduce.quote
          }
        }
        findDeal.deal.assets = {
          used: {
            base: usedBase / leverage,
            quote: usedQuote / leverage,
          },
          required: {
            base: requiredBase / leverage,
            quote: requiredQuote / leverage,
          },
        }
        this.saveDeal(findDeal, { assets: findDeal.deal.assets })
        this.updateBotAssets()
      }
    }
    /**
     * Update bot assets
     */

    updateBotAssets() {
      if (this.data) {
        const activeDeals = this.getOpenDeals()
        const used: typeof this.data.assets.used = {
          base: new Map(),
          quote: new Map(),
        }
        const required: typeof this.data.assets.required = {
          base: new Map(),
          quote: new Map(),
        }
        for (const d of activeDeals) {
          const base = d.deal.symbol.baseAsset
          const quote = d.deal.symbol.quoteAsset
          used.base.set(
            base,
            (used.base.get(base) ?? 0) + d.deal.assets.used.base,
          )
          used.quote.set(
            quote,
            (used.quote.get(quote) ?? 0) + d.deal.assets.used.quote,
          )
          required.base.set(
            base,
            (required.base.get(base) ?? 0) + d.deal.assets.required.base,
          )
          required.quote.set(
            quote,
            (required.quote.get(quote) ?? 0) + d.deal.assets.required.quote,
          )
        }
        this.data.assets = {
          used,
          required,
        }
        this.updateData({ assets: this.data.assets })
        this.emit('bot settings update', {
          assets: {
            used: {
              base: mapToArray(used.base),
              quote: mapToArray(used.quote),
            },
            required: {
              base: mapToArray(required.base),
              quote: mapToArray(required.quote),
            },
          },
        })
      }
    }
    /**
     * Update bot deals
     * @param {boolean} increase
     */
    @IdMute(mutex, (botId) => `updateBotDeals${botId}`)
    async updateBotDeals(_botId: string, increase: boolean) {
      if (this.data) {
        this.data.deals = {
          all: this.data.deals.all + (increase ? 1 : 0),
          active: this.data.deals.active + (increase ? 1 : -1),
        }
        if (this.data.deals.active < 0) {
          this.data.deals.active = 0
        }
        this.updateData({ deals: this.data.deals })
        this.emit('bot settings update', { dealsInBot: this.data.deals })
      }
    }

    getPendingAddFunds(deal: FullDeal<ExcludeDoc<Deal>>) {
      const pendingAddFunds =
        deal.deal.pendingAddFunds ??
        ([] as unknown as NonNullable<Deal['pendingAddFunds']>)
      const base = pendingAddFunds.reduce(
        (acc, v) =>
          acc +
          (v.useLimitPrice
            ? v.asset === OrderSizeTypeEnum.base
              ? +v.qty
              : +v.qty / +(v.limitPrice ?? '0')
            : 0),
        0,
      )
      const quote = pendingAddFunds.reduce(
        (acc, v) =>
          acc +
          (v.useLimitPrice
            ? v.asset === OrderSizeTypeEnum.base
              ? +v.qty * +(v.limitPrice ?? '0')
              : +v.qty
            : 0),
        0,
      )
      return { base, quote }
    }

    getPendingReduceFunds(deal: FullDeal<ExcludeDoc<Deal>>) {
      const pendingReduceFunds =
        deal.deal.pendingReduceFunds ??
        ([] as unknown as NonNullable<Deal['pendingReduceFunds']>)
      const base = pendingReduceFunds.reduce(
        (acc, v) =>
          acc +
          (v.useLimitPrice
            ? v.asset === OrderSizeTypeEnum.base
              ? +v.qty
              : +v.qty / +(v.limitPrice ?? '0')
            : 0),
        0,
      )
      const quote = pendingReduceFunds.reduce(
        (acc, v) =>
          acc +
          (v.useLimitPrice
            ? v.asset === OrderSizeTypeEnum.base
              ? +v.qty * +(v.limitPrice ?? '0')
              : +v.qty
            : 0),
        0,
      )
      return { base, quote }
    }
    sendEightyAlert(_findDeal: FullDeal<ExcludeDoc<Deal>>) {
      return
    }
    async sendHundredAlert(_findDeal: FullDeal<ExcludeDoc<Deal>>) {
      return
    }
    /**
     * Update usage for bot and deal
     * @param {string} dealId Id of the deal
     * @param {boolean} [reset] Reset usage. Default=false
     * @param {boolean} [noBotUsage] Not calculate bot usage. Default = false
     */

    @IdMute(mutex, (dealId) => `updateUsage${dealId}`)
    async updateUsage(
      dealId: string,
      reset = false,
      noBotUsage = false,
      sendAlert = true,
    ) {
      const findDeal = this.getDeal(dealId)
      const runBot = () => {
        if (!noBotUsage) {
          this.calculateBotUsage(this.botId)
        }
      }
      if (this.data && findDeal) {
        const long = this.isLong
        const leverage = await this.getLeverageMultipler(findDeal.deal)
        const bo = this.findBaseOrderByDeal(findDeal.deal._id)
        const regular = findDeal.initialOrders.filter(
          (o) => o.type === TypeOrderEnum.dealRegular,
        )
        const boQty = +(bo?.executedQty ?? '0') || +(bo?.origQty ?? '0') || 0
        const boPrice = +(bo?.price ?? '0') || 0
        const fundsBase = (
          findDeal.deal.funds ?? ([] as unknown as NonNullable<Deal['funds']>)
        ).reduce((acc, v) => acc + v.qty, 0)
        const fundsQuote = (
          findDeal.deal.funds ?? ([] as unknown as NonNullable<Deal['funds']>)
        ).reduce((acc, v) => acc + v.qty * v.price, 0)
        const reduceFundsBase = (
          findDeal.deal.reduceFunds ??
          ([] as unknown as NonNullable<Deal['reduceFunds']>)
        ).reduce((acc, v) => acc + v.qty, 0)
        const reduceFundsQuote = (
          findDeal.deal.reduceFunds ??
          ([] as unknown as NonNullable<Deal['reduceFunds']>)
        ).reduce((acc, v) => acc + v.qty * v.price, 0)
        const pending = this.getPendingAddFunds(findDeal)
        const pendingReduce = this.getPendingReduceFunds(findDeal)
        const totalBase =
          regular.reduce((acc, g) => acc + g.qty, 0) +
          boQty +
          fundsBase +
          pending.base -
          reduceFundsBase -
          pendingReduce.base
        const totalQuote =
          regular.reduce((acc, g) => acc + g.qty * g.price, 0) +
          boQty * boPrice +
          fundsQuote +
          pending.quote -
          reduceFundsQuote -
          pendingReduce.quote
        const base = (await this.profitBase(findDeal.deal))
          ? findDeal.deal.profit.total
          : 0

        const quote = !(await this.profitBase(findDeal.deal))
          ? findDeal.deal.profit.total
          : 0
        const rate = await this.getUsdRate(
          findDeal.deal.symbol.symbol,
          this.futures
            ? this.coinm
              ? 'base'
              : 'quote'
            : long
              ? 'quote'
              : 'base',
        )
        let maxBase =
          (this.futures ? (this.coinm ? totalBase : 0) : long ? 0 : totalBase) /
          leverage
        let maxQuote =
          (this.futures
            ? this.coinm
              ? 0
              : totalQuote
            : long
              ? totalQuote
              : 0) / leverage
        const currentBase =
          (!reset
            ? this.futures
              ? this.coinm
                ? long
                  ? findDeal.deal.currentBalances.base
                  : findDeal.deal.initialBalances.base -
                    (findDeal.deal.currentBalances.base - base)
                : 0
              : long
                ? 0
                : findDeal.deal.initialBalances.base -
                  (findDeal.deal.currentBalances.base - base)
            : 0) / leverage
        const currentQuote =
          (!reset
            ? this.futures
              ? this.coinm
                ? 0
                : !long
                  ? findDeal.deal.currentBalances.quote
                  : findDeal.deal.initialBalances.quote -
                    (findDeal.deal.currentBalances.quote - quote)
              : long
                ? findDeal.deal.initialBalances.quote -
                  (findDeal.deal.currentBalances.quote - quote)
                : 0
            : 0) / leverage
        if (
          findDeal.deal.levels.complete > 0 &&
          findDeal.deal.levels.complete === findDeal.deal.levels.all
        ) {
          if (maxQuote > 0 && maxQuote > currentQuote) {
            maxQuote = currentQuote
          }
          if (maxBase > 0 && maxBase > currentBase) {
            maxBase = currentBase
          }
        }
        const maxUsd = this.futures
          ? this.coinm
            ? maxBase * rate
            : maxQuote * rate
          : long
            ? maxQuote * rate
            : maxBase * rate
        const currentUsd = this.futures
          ? this.coinm
            ? currentBase * rate
            : currentQuote * rate
          : long
            ? currentQuote * rate
            : currentBase * rate
        if (sendAlert) {
          this.sendEightyAlert(findDeal)
          await this.sendHundredAlert(findDeal)
        }
        let relative = currentUsd / maxUsd
        if (isNaN(relative) || !isFinite(relative)) {
          relative = 0
        }
        findDeal.deal.usage = {
          max: {
            base: maxBase,
            quote: maxQuote,
          },
          current: {
            base: currentBase,
            quote: currentQuote,
          },
          maxUsd,
          currentUsd,
          relative,
        }
        if (findDeal.deal.usage.current.base > findDeal.deal.usage.max.base) {
          findDeal.deal.usage.max.base = findDeal.deal.usage.current.base
        }
        if (findDeal.deal.usage.current.quote > findDeal.deal.usage.max.quote) {
          findDeal.deal.usage.max.quote = findDeal.deal.usage.current.quote
        }
        const costValue =
          this.futures && findDeal.deal.status === DCADealStatusEnum.closed
            ? this.coinm
              ? findDeal.deal.usage.current.base *
                findDeal.deal.avgPrice *
                leverage
              : findDeal.deal.usage.current.quote * leverage
            : Math.max(
                (this.futures
                  ? this.coinm
                    ? findDeal.deal.usage.current.base * findDeal.deal.avgPrice
                    : findDeal.deal.usage.current.quote
                  : long
                    ? findDeal.deal.usage.current.quote
                    : findDeal.deal.usage.current.base) * leverage,
                0,
              )
        const sizeValue =
          this.futures && !this.coinm
            ? findDeal.deal.status === DCADealStatusEnum.closed
              ? // Keep whatever the position last measured. `closeDeal` pins
                // the real closed quantity here; back-deriving it from usage
                // put a different quantity in the same field depending on
                // whether a usage update happened to land after the status
                // flipped, so the column silently changed meaning at close.
                (findDeal.deal.size ?? 0)
              : long
                ? findDeal.deal.currentBalances.base
                : findDeal.deal.initialBalances.base -
                  findDeal.deal.currentBalances.base
            : Math.max(
                (this.futures
                  ? this.coinm
                    ? findDeal.deal.usage.current.base
                    : findDeal.deal.usage.current.quote
                  : long
                    ? findDeal.deal.usage.current.quote
                    : findDeal.deal.usage.current.base) * leverage,
                0,
              )
        const costMultiplier = this.futures
          ? 1
          : long
            ? 1
            : findDeal.deal.avgPrice
        const sizeDenominator = this.futures
          ? 1
          : long
            ? findDeal.deal.avgPrice
            : 1
        let s = sizeValue / sizeDenominator
        s = isNaN(s) ? 0 : isFinite(s) ? s : 0
        let c = costValue * costMultiplier
        c = isNaN(c) ? 0 : c
        this.saveDeal(findDeal, {
          usage: findDeal.deal.usage,
          size: s,
          cost: c / leverage,
          value: c,
        }).then(runBot)
      }
      if (!findDeal && reset) {
        runBot()
      }
    }
    /**
     * Rest bot assets
     *
     */

    resetAssets() {
      this.updateBotAssets()
    }
    /**
     * Get open deals
     */

    getOpenDeals(ignoreStartDeals?: boolean, symbol?: string) {
      return this.getDealsByStatusAndSymbol({
        status: ignoreStartDeals
          ? DCADealStatusEnum.open
          : [DCADealStatusEnum.open, DCADealStatusEnum.start],
        symbol,
      })
    }

    async checkOpenedDeals() {
      if (!this.data || !this.allowedMethods.has('checkOpenedDeals')) {
        return
      }
      const { useCloseAfterXopen, closeAfterXopen, useBotController } =
        await this.getAggregatedSettings()
      if (
        !useBotController ||
        !useCloseAfterXopen ||
        !closeAfterXopen ||
        !checkNumber(closeAfterXopen)
      ) {
        return
      }
      const deals = await this.dealsDb.countData({
        status: {
          $in: [
            DCADealStatusEnum.closed,
            DCADealStatusEnum.error,
            DCADealStatusEnum.open,
            DCADealStatusEnum.canceled,
          ],
        },
        botId: this.botId,
      } as any)
      if (deals.status === StatusEnum.notok) {
        return this.handleErrors(
          `Error reading deals ${deals.reason}`,
          'checkOpenedDeals',
          undefined,
          false,
          false,
          false,
        )
      }
      if (
        deals.data.result >= +closeAfterXopen &&
        this.data.status !== BotStatusEnum.closed
      ) {
        this.handleLog(
          `Close deal after X opened trigger, opened: ${deals.data.result}, trigger: ${closeAfterXopen}`,
        )
        await this.stop(CloseDCATypeEnum.leave)
      }
    }
    /**
     * Caluculate bot deals
     */

    calculateBotDeals() {
      const openDeals = this.getOpenDeals()
      if (this.data) {
        this.data.deals = {
          active: openDeals.length,
          all: this.allDeals,
        }
        this.updateData({ deals: this.data.deals })
        this.emit('bot settings update', { dealsInBot: this.data.deals })
        this.checkOpenedDeals()
      }
    }
    /**
     * Calculate bot usage
     */

    @IdMute(mutex, (botId) => `calculateBotUsage${botId}`)
    async calculateBotUsage(_botId: string) {
      if (this.data) {
        const updateOpenDeals = this.getOpenDeals()
        this.data.usage = {
          current: {
            base: 0,
            quote: 0,
          },
          max: {
            base: 0,
            quote: 0,
          },
          currentUsd: 0,
          maxUsd: 0,
          relative: 0,
        }
        const settings = await this.getAggregatedSettings()
        let { maxNumberOfOpenDeals } = settings
        if (
          !maxNumberOfOpenDeals ||
          maxNumberOfOpenDeals === '' ||
          isNaN(+maxNumberOfOpenDeals) ||
          +maxNumberOfOpenDeals < 0
        ) {
          maxNumberOfOpenDeals = '1'
        }
        const currentUsage = {
          base: updateOpenDeals.reduce(
            (acc, d) => acc + d.deal.usage.current.base,
            0,
          ),
          quote: updateOpenDeals.reduce(
            (acc, d) => acc + d.deal.usage.current.quote,
            0,
          ),
        }
        const currentUsd = updateOpenDeals.reduce(
          (acc, d) => acc + (d.deal.usage.currentUsd ?? 0),
          0,
        )
        const [first] = settings.pair ?? []
        if (first) {
          const latestPrice = await this.getLatestPrice(first)
          if (latestPrice !== 0) {
            const long = this.isLong
            const grids = await this.createInitialDealOrders(
              first,
              latestPrice,
              '',
            )
            const base = await this.getBaseOrder(
              first,
              undefined,
              undefined,
              latestPrice,
            )
            const regularOrders = grids.filter(
              (g) => g.type === TypeOrderEnum.dealRegular,
            )
            const leverage = await this.getLeverageMultipler()
            const dealMaxUsage = {
              base:
                (this.futures
                  ? this.coinm
                    ? regularOrders.reduce((acc, g) => acc + g.qty, 0) +
                      +(base?.origQty ?? '0')
                    : 0
                  : long
                    ? 0
                    : grids
                        .filter((g) => g.side === OrderSideEnum.sell)
                        .reduce((acc, g) => acc + g.qty, 0) +
                      +(base?.origQty ?? '0')) / leverage,
              quote:
                (this.futures
                  ? this.coinm
                    ? 0
                    : regularOrders.reduce(
                        (acc, v) => acc + v.qty * v.price,
                        0,
                      ) +
                      +(base?.origQty ?? '0') * +(base?.price ?? '0')
                  : long
                    ? grids
                        .filter((g) => g.side === OrderSideEnum.buy)
                        .reduce((acc, g) => acc + g.qty * g.price, 0) +
                      +(base?.origQty ?? '0') * +(base?.price ?? '0')
                    : 0) / leverage,
            }
            const realDealsMaxUsage = {
              base: updateOpenDeals.reduce(
                (acc, d) => acc + d.deal.usage.max.base,
                0,
              ),
              quote: updateOpenDeals.reduce(
                (acc, d) => acc + d.deal.usage.max.quote,
                0,
              ),
            }
            const maxBase =
              +maxNumberOfOpenDeals === 0
                ? 0
                : realDealsMaxUsage.base +
                  dealMaxUsage.base *
                    (+maxNumberOfOpenDeals - updateOpenDeals.length)
            const maxQuote =
              +maxNumberOfOpenDeals === 0
                ? 0
                : realDealsMaxUsage.quote +
                  dealMaxUsage.quote *
                    (+maxNumberOfOpenDeals - updateOpenDeals.length)
            const rate = await this.getUsdRate(
              this.data.settings.pair[0],
              this.futures
                ? this.coinm
                  ? 'base'
                  : 'quote'
                : long
                  ? 'quote'
                  : 'base',
            )
            const maxUsd = this.futures
              ? this.coinm
                ? maxBase * rate
                : maxQuote * rate
              : long
                ? maxQuote * rate
                : maxBase * rate
            let relative = maxUsd / currentUsd
            if (isNaN(relative) || !isFinite(relative)) {
              relative = 0
            }
            this.data.usage = {
              current: currentUsage,
              currentUsd,
              max: {
                base: maxBase,
                quote: maxQuote,
              },
              maxUsd,
              relative,
            }
          }
        }

        if (this.data.usage.current.base > this.data.usage.max.base) {
          this.data.usage.max.base = this.data.usage.current.base
        }
        if (this.data.usage.current.quote > this.data.usage.max.quote) {
          this.data.usage.max.quote = this.data.usage.current.quote
        }
        this.updateData({ usage: this.data.usage })
        this.emit('bot settings update', { usage: this.data.usage })
        this.calculateBotBalances()
      }
    }
    /**
     * Calculate bot balances
     */

    calculateBotBalances() {
      if (this.data) {
        const updateOpenDeals = this.getOpenDeals()
        this.data.initialBalances = {
          base: new Map(),
          quote: new Map(),
        }
        this.data.currentBalances = {
          base: new Map(),
          quote: new Map(),
        }
        for (const d of updateOpenDeals) {
          const base = d.deal.symbol.baseAsset
          const quote = d.deal.symbol.quoteAsset
          this.data.initialBalances.base.set(
            base,
            (this.data.initialBalances.base.get(base) ?? 0) +
              d.deal.initialBalances.base,
          )
          this.data.initialBalances.quote.set(
            quote,
            (this.data.initialBalances.quote.get(quote) ?? 0) +
              d.deal.initialBalances.quote,
          )
          this.data.currentBalances.base.set(
            base,
            (this.data.currentBalances.base.get(base) ?? 0) +
              d.deal.currentBalances.base,
          )
          this.data.currentBalances.quote.set(
            quote,
            (this.data.currentBalances.quote.get(quote) ?? 0) +
              d.deal.currentBalances.quote,
          )
        }
        const data = {
          initialBalances: this.data.initialBalances,
          currentBalances: this.data.currentBalances,
        }
        this.updateData({
          ...data,
        })
        this.emit('bot settings update', {
          currentBalances: {
            base: mapToArray(data.currentBalances.base),
            quote: mapToArray(data.currentBalances.quote),
          },
          initialBalances: {
            base: mapToArray(data.initialBalances.base),
            quote: mapToArray(data.initialBalances.quote),
          },
        })
      }
    }
    /**
     * Calculate usage
     */

    async calculateUsage(sendAlert = true) {
      const openDeals = this.getOpenDeals()
      if (this.data) {
        for (const d of openDeals) {
          await this.updateUsage(d.deal._id, false, true, sendAlert)
        }
      }
      this.calculateBotUsage(this.botId)
    }

    getTimeByTimezone(timeZone: string, value: string) {
      const ts = new Date(`${value} GMT`).toUTCString()
      const newDate = new Date(ts)
      const tz = newDate
        .toLocaleString('en', { timeZone, timeStyle: 'long' })
        .split(' ')[2]
      return Date.parse(`${ts} ${tz}`)
    }
    /**
     * Find diff to start time based trigger
     */

    async findTimeDiff() {
      if (this.data) {
        const timeZone = (await this.getUser())?.timezone ?? 'UTC'
        const { hodlAt, hodlNextBuy, hodlHourly } =
          await this.getAggregatedSettings()
        if (hodlNextBuy && hodlAt) {
          const time = hodlHourly
            ? hodlNextBuy
            : this.getTimeByTimezone(
                timeZone,
                `${new Date(hodlNextBuy).toDateString()} ${hodlAt}`,
              )
          const diff = time - new Date().getTime()
          return diff
        }
      }
    }
    /**
     *  Update next buy
     */

    async updateNextBuy(newTime = false) {
      if (this.data) {
        const timeZone = (await this.getUser())?.timezone ?? 'UTC'
        const hour = 60 * 60 * 1000
        const day = 24 * hour
        const { hodlDay, hodlAt, hodlNextBuy, hodlHourly } =
          await this.getAggregatedSettings()
        if (hodlDay && hodlAt && hodlNextBuy) {
          let add = parseFloat(hodlDay) * (hodlHourly ? hour : day)
          if (newTime) {
            let date = hodlHourly
              ? hodlNextBuy
              : this.getTimeByTimezone(
                  timeZone,
                  `${new Date().toDateString()} ${hodlAt}`,
                )
            const currentDate = +new Date()
            if (date < currentDate) {
              const cd = new Date(currentDate)
              if (hodlHourly) {
                cd.setHours(cd.getHours() + +hodlDay, 0, 0, 0)
                date = +cd
              } else {
                date += day
              }
            }

            add = date - hodlNextBuy
          }
          this.data.settings.hodlNextBuy += add
          this.updateData({ settings: { ...this.data.settings } })
        }
      }
    }
    /**
     * Open deal by timer
     */

    async openDealByTimer() {
      if (this.data) {
        await this.updateNextBuy()
        const diff = await this.findTimeDiff()
        if (diff && diff > 0) {
          if (this.timer) {
            clearTimeout(this.timer)
          }
          for (const symbol of await this.getSymbolsToOpenAsapDeals()) {
            this.openNewDeal(this.botId, symbol)
          }
          this.timer =
            diff > maxTimeout
              ? setTimeout(this.startTimeBasedTrigger, maxTimeout)
              : setTimeout(this.openDealByTimer, diff)
          this.handleLog(
            `Next deal will start in ${this.math.round(
              diff / 1000,
              0,
            )}s ${new Date(+new Date() + diff).toUTCString()}`,
          )
        }
      }
    }
    /**
     * Start time based trigger
     */

    async startTimeBasedTrigger() {
      if (this.data) {
        let diff = await this.findTimeDiff()
        if (diff && diff < 0) {
          await this.updateNextBuy(true)
          diff = await this.findTimeDiff()
        }
        if (diff) {
          this.timer =
            diff > maxTimeout
              ? setTimeout(this.startTimeBasedTrigger, maxTimeout)
              : setTimeout(this.openDealByTimer, diff)
          this.handleLog(
            `Next deal will start in ${this.math.round(
              diff / 1000,
              0,
            )}s ${new Date(+new Date() + diff).toUTCString()}`,
          )
        }
      }
    }

    processOrdersAfterCheck(
      filledOrders: Order[],
      partiallyFilledOrders: Order[],
    ) {
      for (const base of filledOrders.filter(
        (o) => o.typeOrder === TypeOrderEnum.dealStart,
      )) {
        this.processFilledOrder(base)
      }
      for (const tp of filledOrders
        .filter((o) => o.typeOrder === TypeOrderEnum.dealTP)
        .sort((a, b) =>
          this.isLong
            ? +a.origPrice - +b.origPrice
            : +b.origPrice - +a.origPrice,
        )) {
        this.processFilledOrder(tp)
      }
      for (const dca of filledOrders
        .filter((o) => o.typeOrder === TypeOrderEnum.dealRegular)
        .sort((a, b) =>
          this.isLong
            ? +b.origPrice - +a.origPrice
            : +a.origPrice - +b.origPrice,
        )) {
        this.processFilledOrder(dca)
      }
      for (const partially of partiallyFilledOrders) {
        this.processPartiallyFilledOrder(partially)
      }
    }
    /** Check orders after socket reconnect */

    async checkOrdersAfterReconnect(_botId: string) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('orders check after reconnect'))
        return
      }
      if (this.blockCheck) {
        this.handleDebug(`Block check skip orders check after reconnect`)
        return
      }
      if (this.serviceRestart) {
        this.handleDebug(`Service restart skip orders check after reconnect`)
        return
      }
      const _id = this.startMethod('checkOrdersAfterReconnect')
      this.blockCheck = true
      try {
        this.handleLog('Check order after user stream reconnect')
        await this.spreadReconcileStart()
        const filledOrders: Order[] = []
        const partiallyFilledOrders: Order[] = []
        // Reported once at the end rather than per order: a bad window used to
        // emit hundreds of identical warnings across the fleet, which buried
        // the signal it was trying to raise.
        const unresolved: string[] = []
        // Attempts actually spent on the orders in `unresolved` — the warn used
        // to print the budget constant instead, which reads as a retry storm
        // when the ladder in fact stopped on its first answer (#676).
        let unresolvedLookupAttempts = 0
        // Take-profit coverage (#696) is decided on what the VENUE says is
        // resting, never on our copy — the `orders` collection keeps long-dead
        // `NEW` rows, and a deal read from it can appear to hold tens of
        // thousands of live take-profits. This pass already asks the venue
        // about every open order, so the answers are collected here rather
        // than re-fetched. A deal with even one unanswered order is recorded
        // as unresolved and skipped entirely: a missing answer could be a live
        // order, and a coverage sum missing one is not a coverage sum.
        const venueConfirmed = new Map<string, Order[]>()
        const coverageUnresolved = new Set<string>()
        const noteVenueAnswer = (o: Order, answered: boolean) => {
          const dealId = `${o.dealId}`
          if (!dealId) return
          if (!answered) {
            coverageUnresolved.add(dealId)
            return
          }
          const list = venueConfirmed.get(dealId) ?? []
          list.push(o)
          venueConfirmed.set(dealId, list)
        }
        const toCheck = this.getOrdersByStatusAndDealId({
          defaultStatuses: true,
        })
        await this.primeReconcileBatch(toCheck)
        for (const o of toCheck) {
          let attemptsForOrder = 0
          const getOrder = await this.getOrderForReconcile(o, {
            onAttempts: (n) => (attemptsForOrder = n),
          })
          if (!getOrder || !getOrder.data) {
            unresolved.push(o.clientOrderId)
            unresolvedLookupAttempts += attemptsForOrder
            noteVenueAnswer(o, false)
            continue
          }
          if (getOrder.status === StatusEnum.notok) {
            this.handleWarn(`Cannot get order ${getOrder.reason}`)
            noteVenueAnswer(o, false)
            continue
          }
          const mergedOrder = await this.mergeCommonOrderWithOrder(
            getOrder.data,
            o,
          )
          // The venue answered for this one, whether or not the answer differed
          // from our copy — an unchanged resting order is confirmation too.
          noteVenueAnswer(mergedOrder, true)
          if (mergedOrder.status !== o.status) {
            this.emit('bot update', mergedOrder)
            this.deleteOrder(mergedOrder.clientOrderId)
            if (mergedOrder.status !== 'CANCELED') {
              this.setOrder(mergedOrder)
            }
            this.handleDebug(
              `${mergedOrder.typeOrder} order ${mergedOrder.clientOrderId} is ${
                mergedOrder.status
              }. Base ${mergedOrder.origQty} (${mergedOrder.executedQty}), quote ${
                mergedOrder.cummulativeQuoteQty
              } (${+mergedOrder.executedQty * +mergedOrder.price}), price ${
                mergedOrder.price
              }`,
            )
            this.updateOrderOnDb(mergedOrder)
            if (mergedOrder.status === 'FILLED') {
              filledOrders.push(mergedOrder)
            }
            if (mergedOrder.status === 'PARTIALLY_FILLED') {
              partiallyFilledOrders.push(mergedOrder)
            }
          } else {
            this.handleDebug(
              `${mergedOrder.typeOrder} order ${mergedOrder.clientOrderId} not changed.`,
            )
          }
        }
        if (unresolved.length) {
          // These orders were NOT checked. The fill-failsafe sweep is the net
          // that re-raises them (it watches the price feed independently), so
          // this is a health signal, not a dead end — but it is the fingerprint
          // of a reconcile pass that could not see the venue.
          this.handleWarn(
            reconcileUnresolvedWarn(unresolved, unresolvedLookupAttempts),
          )
        }
        if (this.reconcileViaSweep && filledOrders.length > 0) {
          // Greppable health signal: the periodic sweep (not a reconnect)
          // caught order fills the user stream had dropped.
          this.handleLog(
            `reconcile-sweep caught ${filledOrders.length} missed fill(s)`,
          )
          this.recordReconcileSweepCatch(filledOrders.length)
        }
        this.processOrdersAfterCheck(filledOrders, partiallyFilledOrders)
        // Last, and never fatal: the fills above are this pass's job, and a
        // coverage check that threw must not cost the bot its reconcile.
        await this.checkTpCoverage(venueConfirmed, coverageUnresolved).catch(
          (e) =>
            this.handleWarn(
              `tp-coverage check failed: ${(e as Error).message}`,
            ),
        )
      } catch (e) {
        // Never leave blockCheck stuck on a throw (see grid checkOrdersAfterReconnect).
        this.handleWarn(
          `Check orders after reconnect failed: ${(e as Error).message}`,
        )
      } finally {
        this.reconcileBatch = null
        this.blockCheck = false
        this.endMethod(_id)
      }
    }

    /**
     * Does every open deal's resting take-profit still cover the position it
     * tracks? Issue #696, spec `013.tp-coverage-drift-after-partial-tp`.
     *
     * #694 stopped this drift being created; it could not repair the deals
     * already drifted, because coverage is only ever re-established as a side
     * effect of `placeOrders` and `placeOrders` runs on a fill. So a deal whose
     * take-profit stopped covering its position while that path was broken
     * stays that way until its next safety order happens to fill — a market
     * event that may never arrive. Three production deals were sitting like
     * that across three users on 2026-09-06, one of them with 110,493 B3
     * carrying no take-profit at all.
     *
     * Detection is unconditional and only reads. The CORRECTION cancels a
     * resting order and places a new one with real money, and is armed only by
     * `BOT_TP_COVERAGE_REPAIR` (§4.2) — deploying this must not, by itself,
     * trade on anyone's account.
     */
    private async checkTpCoverage(
      venueConfirmed: Map<string, Order[]>,
      unresolvedDeals: Set<string>,
    ) {
      const openDeals = this.getDealsByStatusAndSymbol({
        status: DCADealStatusEnum.open,
      })
      for (const findDeal of openDeals) {
        const deal = findDeal.deal
        const dealId = `${deal._id}`
        const symbol = deal.symbol?.symbol
        if (!symbol) continue
        const settings = await this.getAggregatedSettings(deal)
        const { useTp, trailingTp, dealCloseCondition } = settings
        // Only deals that are supposed to hold ONE resting take-profit. A
        // multi-TP ladder has its own completion accounting (§4.3), and a
        // trailing, non-TP-close or externally-managed deal is *correct* with
        // no resting take-profit — reading those as uncovered would report the
        // whole fleet as broken.
        if (
          settings.useMultiTp ||
          !useTp ||
          trailingTp ||
          dealCloseCondition !== CloseConditionEnum.tp ||
          this.data?.flags?.includes(BotFlags.externalTp)
        ) {
          continue
        }
        const confirmed = (venueConfirmed.get(dealId) ?? []).filter(
          (o) => o.typeOrder === TypeOrderEnum.dealTP,
        )
        // A deal holding NO live take-profit is out of scope. It is a routine
        // transient — every deal is in that state between its base order
        // filling and its take-profit being armed — and treating it as
        // uncovered would report a large part of the fleet on every pass. The
        // defect this check exists for always leaves at least the stale order
        // resting; `reconcileTpCoverage` still answers for the empty case, but
        // deciding it is not this caller's business.
        if (!confirmed.length && !unresolvedDeals.has(dealId)) continue
        const probe: TpCoverageProbe = unresolvedDeals.has(dealId)
          ? { kind: 'unavailable' }
          : {
              kind: 'orders',
              orders: confirmed.map(
                (o): LiveTpOrder => ({
                  clientOrderId: o.clientOrderId,
                  status: o.status,
                  origQty: o.origQty,
                  executedQty: o.executedQty,
                }),
              ),
            }
        const ed = await this.getExchangeInfo(symbol)
        if (!ed) continue
        // The same terms `getTPOrder` sizes a replacement from, so a healthy
        // deal cannot read as drifted: `tpHistory` minus the entries already
        // booked as filled closes, minus base withdrawn by reduce funds.
        const filledCloseOrders = this.getOrdersByStatusAndDealId({
          status: 'FILLED',
          dealId,
        }).filter(
          (o) => o.typeOrder === TypeOrderEnum.dealTP && !o.reduceFundsId,
        )
        const pendingReduce = this.getPendingReduceFunds(findDeal)
        const tracked = trackedPosition({
          size: deal.size ?? 0,
          tpHistory: deal.tpHistory ?? [],
          filledCloseOrders,
          reduceFundsBase: (deal.reduceFunds ?? []).reduce(
            (acc, v) => acc + v.qty,
            0,
          ),
          pendingReduceFundsBase: pendingReduce.base,
        })
        const verdict = reconcileTpCoverage(probe, tracked, {
          baseMinAmount: ed.baseAsset.minAmount,
          quoteMinAmount: ed.quoteAsset.minAmount,
          price: deal.lastPrice || deal.avgPrice || 0,
        })
        const latchKey = standingConditionKey(tpCoverageDrift, dealId)
        if (verdict.state === 'covered' || verdict.state === 'unknown') {
          // Covered again — a later recurrence is news and reports afresh.
          // `unknown` deliberately does not clear: the venue said nothing, so
          // nothing is known to have changed.
          if (verdict.state === 'covered') {
            this.standingConditionLatch.clear(latchKey)
          }
          continue
        }
        // The drift is standing: it does not change between passes, and only
        // this check or a safety-order fill will move it. Reporting per pass
        // would be one warning per drifted deal per pass across the fleet
        // (spec 008). The correction rides the same latch so an armed engine
        // that cannot fix a deal retries it on that cadence rather than
        // cancelling and re-placing orders on every reconcile.
        if (!this.standingConditionLatch.shouldReport(latchKey, +new Date())) {
          continue
        }
        this.handleWarn(tpCoverageDriftWarn({ dealId, symbol, verdict }))
        if (!tpCoverageRepairArmed) {
          // The whole point of the flag. Say so once, with what WOULD happen,
          // so the log is enough for an operator to decide on.
          this.handleLog(
            `tp-coverage drift | deal ${dealId} left as is — correction is not armed ` +
              `(set BOT_TP_COVERAGE_REPAIR to cancel ${
                verdict.staleTps.length
              } stale take-profit(s) and re-arm)`,
          )
          continue
        }
        for (const stale of verdict.staleTps) {
          const order = confirmed.find(
            (o) => o.clientOrderId === stale.clientOrderId,
          )
          if (!order) continue
          this.handleLog(
            `tp-coverage drift | deal ${dealId} cancelling stale take-profit ${order.clientOrderId}`,
          )
          // `promotePartialToFilled: false` — NOT optional. Every order here is
          // PARTIALLY_FILLED by construction, and the default path promotes a
          // cancelled order carrying fills to FILLED, which reaches
          // `processFilledOrder` -> `closeDeal`. That would close the deal on
          // whatever fraction had sold and strand the rest: the very bug being
          // repaired, inflicted on more deals. Same reasoning, same opt-out as
          // `placeOrders` (spec `007.tp-resize-cancel-must-never-promote`) —
          // this cancel is a re-size, not a close, and the fills it carries are
          // a partial take profit `tpHistory` already accounts for.
          await this.cancelOrderOnExchange(order, true, true, false)
        }
        if (!verdict.rearm) continue
        const tpOrders = await this.getTPOrder(
          symbol,
          deal.lastPrice,
          findDeal.initialOrders,
          deal.avgPrice,
          deal.initialPrice,
          dealId,
          deal,
        )
        if (!tpOrders?.length) {
          this.handleWarn(
            `tp-coverage drift | deal ${dealId} has nothing to re-arm with`,
          )
          continue
        }
        this.handleLog(
          `tp-coverage drift | deal ${dealId} re-arming take-profit ${tpOrders
            .map((o) => o.qty)
            .join(', ')}`,
        )
        await this.placeOrders(this.botId, symbol, dealId, {
          new: tpOrders,
          cancel: [],
        })
      }
    }

    async getDiffForCheckOrders(
      deal: FullDeal<CleanDCADealsSchema>,
      activeRegularOrders: Order[],
    ) {
      return this.findDiff(
        deal.currentOrders.filter((g) => g.type !== TypeOrderEnum.dealTP),
        activeRegularOrders.map((o) => this.mapOrderToGrid(o)),
        true,
      )
    }
    /** Check orders after service restart */
    @IdMute(mutex, (botId: string) => `${botId}checkOrders`)
    async checkOrders(_botId: string, partiallyFilled?: boolean) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('orders check'))
        return
      }
      if (this.blockCheck) {
        return
      }
      if (partiallyFilled) {
        this.handleLog(`Check partially filled orders`)
      }
      const _id = this.startMethod('checkOrders')
      this.blockCheck = true
      this.beginRestartProbeBudget()
      this.beginOrderCheckRun()
      if (this.serviceRestart || partiallyFilled) {
        const dealOrders: Map<string, Order[]> = new Map()
        const all = this.allOrders.filter((o) =>
          partiallyFilled ? o.status === 'PARTIALLY_FILLED' : true,
        )
        const ordersWithoutDeal = all.filter((o) => !o.dealId)
        if (ordersWithoutDeal) {
          for (const o of ordersWithoutDeal) {
            this.handleDebug(`Order ${o.clientOrderId} without deal`)
            await this.cancelOrderOnExchange(o, false)
            this.deleteOrder(o.clientOrderId)
          }
        }
        all.map(
          (o) =>
            o.dealId &&
            dealOrders.set(o.dealId, [...(dealOrders.get(o.dealId) ?? []), o]),
        )
        main: for (const [dealId, orders] of dealOrders) {
          const activeTPSLOrders = orders.filter(
            (o) =>
              this.orderStatuses.includes(o.status) &&
              o.typeOrder === TypeOrderEnum.dealTP,
          )
          const deal = this.getDeal(dealId)
          if (deal?.closeBySl || deal?.closeByTp) {
            continue main
          }
          const forTPCheck = deal && (await this.isDealForTPLevelCheck(deal))
          if (activeTPSLOrders.length && deal && !forTPCheck) {
            for (const activeTPSLOrder of activeTPSLOrders) {
              if (this.isOrderQuarantined(activeTPSLOrder)) continue
              if (this.restartProbeExhausted()) continue
              // Bounded retry on a transient, exactly as the reconnect pass
              // does. This loop was a single shot: one lookup blip rendered
              // as "not found" skipped the order for the whole restart, and
              // a FILLED order is the one most likely to be reported that
              // way (see `isDefinitiveOrderNotFound`).
              const tpslOrderData = await this.getOrderForReconcile(
                activeTPSLOrder,
                { fromCache: true },
              )
              // `notok` is tested BEFORE `!data`: every failed lookup nulls
              // `data`, so testing `!data` first made this branch unreachable
              // and discarded the venue's reason — the one thing that separates
              // "this order does not exist" from "the call failed".
              if (isDefinitiveOrderNotFound(tpslOrderData)) {
                this.handleWarn(
                  `Order ${activeTPSLOrder.clientOrderId} not found on exchange: ${tpslOrderData?.reason}`,
                )
                this.noteOrderNotFound(
                  activeTPSLOrder,
                  `${tpslOrderData?.reason}`,
                )
              } else if (tpslOrderData?.status === StatusEnum.notok) {
                this.handleWarn(`Cannot get order ${tpslOrderData.reason}`)
              } else if (!tpslOrderData || !tpslOrderData.data) {
                this.handleWarn(
                  `Not enough data to get order ${activeTPSLOrder.clientOrderId}`,
                )
              } else {
                this.clearOrderStrikes(activeTPSLOrder)
                const updatedOrder = await this.mergeCommonOrderWithOrder(
                  tpslOrderData.data,
                  activeTPSLOrder,
                )
                if (updatedOrder.status === 'CANCELED') {
                  this.deleteOrder(updatedOrder.clientOrderId)
                  this.handleDebug(
                    `TP/SL order ${updatedOrder.clientOrderId} is CANCELED.`,
                  )
                  this.serviceRestart = false
                  this.emit('bot update', updatedOrder)
                  this.updateOrderOnDb(updatedOrder)
                  if (
                    deal &&
                    ![
                      DCADealStatusEnum.closed,
                      DCADealStatusEnum.canceled,
                    ].includes(deal.deal.status)
                  ) {
                    await this.placeOrders(
                      this.botId,
                      updatedOrder.symbol,
                      dealId,
                      {
                        new: [this.mapOrderToGrid(updatedOrder)],
                        cancel: [],
                      },
                    )
                  }
                } else if (updatedOrder.status === 'FILLED') {
                  this.setOrder(updatedOrder)
                  this.handleDebug(
                    `TP/SL order ${updatedOrder.clientOrderId} is FILLED.`,
                  )

                  this.emit('bot update', updatedOrder)
                  this.updateOrderOnDb(updatedOrder)
                  await this.processFilledOrder(updatedOrder)
                  continue main
                } else if (
                  updatedOrder.status === 'PARTIALLY_FILLED' &&
                  activeTPSLOrder.status === 'NEW'
                ) {
                  this.setOrder(updatedOrder)
                  this.handleDebug(
                    `TP/SL order ${updatedOrder.clientOrderId} is PARTIALLY_FILLED.`,
                  )
                  this.emit('bot update', updatedOrder)
                  this.updateOrderOnDb(updatedOrder)
                  this.processPartiallyFilledOrder(updatedOrder)
                  continue
                } else {
                  this.handleDebug(
                    `TP/SL order not changed ${updatedOrder.clientOrderId}`,
                  )
                }
              }
            }
          }

          if (!forTPCheck) {
            const tpOrdersInCurrent = (
              deal ?? { currentOrders: [] }
            ).currentOrders.filter(
              (g) =>
                g.type === TypeOrderEnum.dealTP &&
                !((deal?.deal.tpSlTargetFilled ?? []) as string[]).includes(
                  g.tpSlTarget ?? '',
                ),
            )
            if (activeTPSLOrders.length !== tpOrdersInCurrent.length) {
              for (const tpOrderInCurrent of tpOrdersInCurrent) {
                if (
                  activeTPSLOrders.find(
                    (o) =>
                      o.side === tpOrderInCurrent.side &&
                      +o.price === tpOrderInCurrent.price &&
                      +o.origQty === tpOrderInCurrent.qty,
                  )
                ) {
                  continue
                }
                this.handleDebug(
                  `TP order wasn't found in orders, but must be in grid ${
                    tpOrderInCurrent.side
                  }, base: ${tpOrderInCurrent.qty}, quote: ${
                    tpOrderInCurrent.price * tpOrderInCurrent.qty
                  }, price: ${tpOrderInCurrent.price}`,
                )
                if (deal) {
                  await this.placeOrders(
                    this.botId,
                    deal.deal.symbol.symbol,
                    dealId,
                    {
                      new: [tpOrderInCurrent],
                      cancel: [],
                    },
                  )
                }
              }
            }
          }

          if (
            deal?.deal.action !== ActionsEnum.useOppositeBalance &&
            !(await this.getAggregatedSettings(deal?.deal)).dcaByMarket
          ) {
            const activeRegularOrders = orders.filter(
              (o) =>
                this.orderStatuses.includes(o.status) &&
                [TypeOrderEnum.dealRegular, TypeOrderEnum.dealGrid].includes(
                  o.typeOrder,
                ),
            )
            if (
              deal &&
              ![DCADealStatusEnum.closed, DCADealStatusEnum.canceled].includes(
                deal.deal.status,
              ) &&
              !activeTPSLOrders.find((o) => o.status === 'PARTIALLY_FILLED')
            ) {
              const canceledOrders: Order[] = []
              let filledOrders: Order[] = []
              let newOrders: Grid[] = []
              const diff = await this.getDiffForCheckOrders(
                deal,
                activeRegularOrders,
              )
              if (diff.new.length > 0) {
                newOrders = diff.new
              }
              for (const o of activeRegularOrders) {
                if (this.isOrderQuarantined(o)) continue
                if (this.restartProbeExhausted()) continue
                // Same bounded retry as the TP/SL loop above, and for the
                // same reason: this is where three filled safety orders were
                // skipped on a restart because one transient miss each was
                // read as the venue's answer.
                const exchangeData = await this.getOrderForReconcile(o, {
                  fromCache: true,
                })
                if (isDefinitiveOrderNotFound(exchangeData)) {
                  this.handleWarn(
                    `Order ${o.clientOrderId} not found on exchange: ${exchangeData?.reason}`,
                  )
                  this.noteOrderNotFound(o, `${exchangeData?.reason}`)
                } else if (!exchangeData || !exchangeData.data) {
                  this.handleWarn(
                    `Not enough data to get order ${o.clientOrderId}`,
                  )
                } else {
                  if (exchangeData.status === StatusEnum.notok) {
                    this.handleWarn(`Cannot get order ${exchangeData.reason}`)
                  } else {
                    this.clearOrderStrikes(o)
                    const updatedOrder = await this.mergeCommonOrderWithOrder(
                      exchangeData.data,
                      o,
                    )
                    if (updatedOrder.status === 'CANCELED') {
                      this.emit('bot update', updatedOrder)
                      this.deleteOrder(updatedOrder.clientOrderId)
                      this.handleDebug(
                        `Order ${updatedOrder.clientOrderId} is CANCELED.`,
                      )
                      this.updateOrderOnDb(updatedOrder)
                      canceledOrders.push(o)
                    } else if (updatedOrder.status === 'FILLED') {
                      this.emit('bot update', updatedOrder)
                      this.setOrder(updatedOrder)
                      this.handleDebug(
                        `Order ${updatedOrder.clientOrderId} is FILLED.`,
                      )
                      this.updateOrderOnDb(updatedOrder)
                      filledOrders.push(updatedOrder)
                    } else if (
                      o.status === 'NEW' &&
                      updatedOrder.status === 'PARTIALLY_FILLED'
                    ) {
                      this.emit('bot update', updatedOrder)
                      this.setOrder(updatedOrder)
                      this.handleDebug(
                        `Order ${updatedOrder.clientOrderId} is PARTIALLY_FILLED.`,
                      )
                      this.updateOrderOnDb(updatedOrder)
                    } else {
                      this.handleDebug(
                        `Regular order not changed ${updatedOrder.clientOrderId}`,
                      )
                    }
                  }
                }
              }

              for (const o of filledOrders.sort((a, b) =>
                this.isLong
                  ? +b.origPrice - +a.origPrice
                  : +a.origPrice - +b.origPrice,
              )) {
                this.handleDebug(
                  `Rebuilding grid after ${o.clientOrderId}, ${o.side}, base: ${
                    o.executedQty
                  }, quote: ${+o.executedQty * +o.price}, price: ${o.price}`,
                )
                this.processFilledOrder(o)
              }
              for (const o of canceledOrders) {
                this.handleDebug(
                  `Send order again ${o.clientOrderId}, ${o.side}, base: ${
                    o.origQty
                  }, quote: ${+o.price * +o.origQty}, price: ${o.price}`,
                )
                const precision = await this.baseAssetPrecision(o.symbol)
                o.origQty = `${this.math.round(+o.origQty, precision)}`
                await this.placeOrders(this.botId, o.symbol, dealId, {
                  new: [this.mapOrderToGrid(o)],
                  cancel: [],
                })
              }
              filledOrders = []
              for (const g of newOrders) {
                const filledOrder = this.getOrdersByStatusAndDealId({
                  status: ['FILLED', 'CANCELED'],
                }).find(
                  (fo) =>
                    +fo.origPrice === g.price &&
                    (fo.side === 'BUY'
                      ? g.side === OrderSideEnum.buy
                      : g.side === OrderSideEnum.sell) &&
                    +fo.executedQty === g.qty &&
                    (this.data?.exchange === ExchangeEnum.bybit
                      ? +fo.executedQty !== 0 &&
                        ['FILLED', 'CANCELED'].includes(fo.status)
                      : fo.status === 'FILLED') &&
                    fo.updateTime >= this.startTime,
                )
                if (filledOrder) {
                  this.handleDebug(
                    `Order wasn't found in orders, but already filled during check  ${
                      g.side
                    }, base: ${g.qty}, quote: ${g.price * g.qty}, price: ${
                      g.price
                    }`,
                  )
                  filledOrders.push(filledOrder)
                  continue
                }
                this.handleDebug(
                  `Order wasn't found in orders, but must be in grid ${
                    g.side
                  }, base: ${g.qty}, quote: ${g.price * g.qty}, price: ${
                    g.price
                  }`,
                )
                await this.placeOrders(
                  this.botId,
                  deal.deal.symbol.symbol,
                  dealId,
                  {
                    new: [g],
                    cancel: [],
                  },
                )
              }

              for (const o of filledOrders.sort((a, b) =>
                this.isLong
                  ? +b.origPrice - +a.origPrice
                  : +a.origPrice - +b.origPrice,
              )) {
                this.handleDebug(
                  `Rebuilding grid after ${o.clientOrderId}, ${o.side}, base: ${
                    o.origQty
                  }, quote: ${+o.origQty * +o.price}, price: ${o.price}`,
                )
                this.processFilledOrder(o)
              }
            } else if (
              !deal ||
              [DCADealStatusEnum.closed, DCADealStatusEnum.canceled].includes(
                deal.deal.status,
              )
            ) {
              for (const o of orders) {
                this.handleDebug(
                  `Deal not found or already closed. Cancel order ${
                    o.clientOrderId
                  }, ${o.side}, base: ${o.origQty}, quote: ${
                    +o.price * +o.origQty
                  }, price: ${o.price}`,
                )
                await this.cancelOrderOnExchange(o)
              }
            }
          }
        }

        if (!partiallyFilled) {
          this.serviceRestart = false
        }
      }
      this.endRestartProbeBudget('checkOrders')
      this.endOrderCheckRun()
      this.blockCheck = false
      this.endMethod(_id)
    }

    @IdMute(mutex, (botId: string) => `${botId}filterCoinsByVolume`)
    protected async filterCoinsByVolume(
      _botId: string,
      pairs: string[],
    ): Promise<string[]> {
      //TODO: self-hosted logic to filter coins by volume
      return pairs
    }

    async getSymbolsToOpenAsapDeals(
      skipVolume = false,
      all = false,
      skippedPairs: string[] = [],
    ): Promise<string[]> {
      if (!this.data) {
        return []
      }
      const settings = await this.getAggregatedSettings()
      let maxNumberOfOpenDeals = +(settings.maxNumberOfOpenDeals ?? '1')
      if (maxNumberOfOpenDeals < 0) {
        maxNumberOfOpenDeals = settings.useMulti
          ? Math.max(
              Math.max(
                1,
                Math.max(1, +(settings.maxDealsPerPair ?? '1')) *
                  (settings.pair ?? []).length,
              ),
              1,
            )
          : 1
      }
      let maxDealsPerPair = +(settings.maxDealsPerPair ?? '1')
      if (maxDealsPerPair < 0) {
        maxDealsPerPair = 1
      }
      const pairs = (settings.pair ?? []).filter(
        (p) => !skippedPairs.includes(p),
      )
      if (pairs.length > 0 && !settings.useMulti) {
        return [pairs[0]]
      }
      const symbolsNum = pairs.length
      let dealPairs = [...pairs]
      if (symbolsNum > +maxNumberOfOpenDeals) {
        dealPairs = [...pairs]
          .sort((a, b) =>
            settings.pairPrioritization === PairPrioritizationEnum.alphabetical
              ? `${a}`.localeCompare(`${b}`)
              : 0.5 - Math.random(),
          )
          .slice(0, all ? pairs.length + 1 : +maxNumberOfOpenDeals)
      } else if (settings.startCondition !== StartConditionEnum.timer) {
        const numberOfFullRepeats =
          Math.floor(maxNumberOfOpenDeals / symbolsNum) - 1
        if (maxDealsPerPair - 1 >= numberOfFullRepeats) {
          for (let index = 0; index < numberOfFullRepeats; index++) {
            dealPairs = dealPairs.concat(pairs)
          }
          const singleRepeats = +maxNumberOfOpenDeals % symbolsNum
          if (maxDealsPerPair - numberOfFullRepeats - 1 >= singleRepeats) {
            dealPairs = dealPairs.concat(
              [...pairs]
                .sort(() => 0.5 - Math.random())
                .slice(0, singleRepeats),
            )
          }
        }
      }
      return !skipVolume && this.botType === BotType.dca
        ? await this.filterCoinsByVolume(this.botId, dealPairs)
        : dealPairs
    }

    private convertToMultiplier(keepConditionBars?: string) {
      return keepConditionBars
        ? isNaN(+keepConditionBars)
          ? 0
          : +keepConditionBars < 0
            ? 0
            : +keepConditionBars
        : 0
    }

    private async isIndicator(serviceRestart: boolean, activeDeals: number) {
      const settings = await this.getAggregatedSettings()
      return (
        this.data &&
        ((settings.startCondition === StartConditionEnum.ti &&
          (settings.indicators ?? []).filter(
            (i) => i.indicatorAction === IndicatorAction.startDeal,
          ).length > 0) ||
          (settings.dcaCondition === DCAConditionEnum.indicators &&
            (settings.indicators ?? []).filter(
              (i) => i.indicatorAction === IndicatorAction.startDca,
            ).length > 0 &&
            settings.useDca) ||
          (this.scaleAr &&
            (settings.indicators ?? []).filter(
              (i) => i.indicatorAction === IndicatorAction.startDca,
            ).length > 0) ||
          ((settings.dealCloseCondition === CloseConditionEnum.techInd ||
            this.tpAr) &&
            (settings.indicators ?? []).filter(
              (i) =>
                i.indicatorAction === IndicatorAction.closeDeal &&
                i.section !== IndicatorSection.sl,
            ).length > 0) ||
          ((settings.dealCloseConditionSL === CloseConditionEnum.techInd ||
            this.slAr) &&
            (settings.indicators ?? []).filter(
              (i) =>
                i.indicatorAction === IndicatorAction.closeDeal &&
                i.section === IndicatorSection.sl,
            ).length > 0) ||
          (settings.useRiskReward &&
            (settings.indicators ?? []).filter(
              (i) => i.indicatorAction === IndicatorAction.riskReward,
            ).length > 0 &&
            settings.type !== DCATypeEnum.terminal) ||
          (settings.botStart === BotStartTypeEnum.indicators &&
            settings.useBotController &&
            (settings.indicators ?? []).filter(
              (i) => i.indicatorAction === IndicatorAction.stopBot,
            ).length > 0) ||
          (settings.botActualStart === BotStartTypeEnum.indicators &&
            settings.useBotController &&
            (settings.indicators ?? []).filter(
              (i) => i.indicatorAction === IndicatorAction.startBot,
            ).length > 0)) &&
        (settings.indicators ?? []).filter(
          (i) => i.type !== IndicatorEnum.unpnl,
        ).length > 0 &&
        (this.data.status !== BotStatusEnum.closed ||
          !!activeDeals ||
          serviceRestart)
      )
    }

    override async processServiceLog(msg: string) {
      const service = JSON.parse(msg)?.restart
      if (service === 'userStream') {
        this.connectRabbitUserStream()
      }
      if (service === 'indicators') {
        await this.startIndicatorInit(
          false,
          this.getDealsByStatusAndSymbol({
            status: [
              DCADealStatusEnum.error,
              DCADealStatusEnum.open,
              DCADealStatusEnum.start,
            ],
          }).length,
        )
      }
    }

    public async startIndicatorInit(
      serviceRestart: boolean,
      activeDeals: number,
    ) {
      const isIndicator = await this.isIndicator(serviceRestart, activeDeals)
      this.handleDebug(
        `Start indicator init. Service restart: ${serviceRestart}, active deals: ${activeDeals}, check result: ${isIndicator}, status: ${this.data?.status}`,
      )
      if (isIndicator) {
        if (!this.redisSubIndicators) {
          this.redisSubIndicators = await RedisClient.getInstance(
            true,
            'indicators',
          )
        }

        await this.openIndicators(this.botId, serviceRestart)
      }
    }
    /**
     * Restore work
     */

    async restoreWork() {
      const _id = this.startMethod('restoreWork')
      const serviceRestart = this.serviceRestart && !this.secondRestart
      if (!serviceRestart) {
        this.calculateBotDeals()
      } else {
        this.handleDebug('Service restart skip calculate bot deals')
      }
      this.handleLog('Checking for existing deals')
      const settings = await this.getAggregatedSettings()
      this.closeAfterTpFilled = settings.type === DCATypeEnum.terminal
      const asapSymbols = await this.getSymbolsToOpenAsapDeals()
      if (serviceRestart || this.keepOrders) {
        // `keepOrders` is a settings save or a deal restore. It is not a cold
        // service restart, but it is emphatically not the user starting the bot
        // either, so it must not fall into the branch below — that branch
        // cancels every resting order the bot owns. Reconcile against the venue
        // instead and leave the book standing.
        //
        // This is the second of two teardowns on the save path. Removing only
        // the one in `reloadBot` moved the cancel here rather than removing it:
        // a 50-pair DCA bot still had all 300 of its orders pulled and re-placed
        // on an edit, while `serviceRestart && !secondRestart` (false for this
        // reload) sent it down the user-start branch. Note comboHelper's
        // override tests `this.serviceRestart` alone, so combo never had the
        // bug — this asymmetry is DCA-only. Forum #5044.
        await this.checkOrders(this.botId)
      } else {
        // Not a service restart — the user started or restarted this bot, which
        // is the manual escape hatch from order quarantine: whatever we decided
        // to stop polling, look again now.
        await this.clearAllOrderQuarantine('bot started by user')
        await this.cancelAllOrder()
        await this.checkOrders(this.botId, true)
      }
      const openDeals = this.getOpenDeals()
      const activeDeals = openDeals.filter(
        (d) => d.deal.status === DCADealStatusEnum.open,
      )
      const startDeals = openDeals.filter(
        (d) => d.deal.status === DCADealStatusEnum.start,
      )
      if (startDeals.length > 0) {
        for (const d of startDeals) {
          const inDb = await this.ordersDb.readData<{
            symbol: string
            clientOrderId: string
            status: OrderStatusType
          }>(
            {
              botId: this.botId,
              dealId: d.deal._id,
              typeOrder: TypeOrderEnum.dealStart,
              status: { $ne: 'CANCELED' },
            },
            { symbol: 1, clientOrderId: 1, status: 1 },
          )
          if (inDb && inDb.status === StatusEnum.ok && inDb.data.result) {
            if (inDb.data.result.status !== 'FILLED') {
              await this.checkBaseOrder(
                this.botId,
                inDb.data.result.symbol,
                inDb.data.result.clientOrderId,
                d.deal._id,
              )
            } else {
              this.handleLog(
                `Deal ${d.deal._id} in status start, but found filled base order`,
              )
              const full = await this.ordersDb.readData({
                clientOrderId: inDb.data.result.clientOrderId,
              })
              if (full.data?.result) {
                await this.startDeal(full.data.result)
              } else {
                this.handleWarn(
                  `Cannot find full order for ${inDb.data.result.clientOrderId}`,
                )
              }
            }
          } else {
            // Same intent rule as the Quantitative Rules give-up path: a deal
            // opened by a point-in-time trigger (a TradingView webhook, an
            // indicator cross, a timer, a manual click) must not have its
            // opening order re-sent later — by the time a reload or restart
            // walks this list, the moment the signal described is gone, and
            // replaying it opens a trade the signal never asked for. One
            // production account had a reload replay a 21-hour-old webhook
            // deal into a long the strategy had since flipped short on. Only
            // ASAP carries no timing, so only ASAP replays.
            const dealSettings = await this.getAggregatedSettings(d.deal)
            if (dealSettings.startCondition !== StartConditionEnum.asap) {
              this.handleLog(
                `${d.deal._id} (${d.deal.symbol.symbol}) never started and its ${dealSettings.startCondition} trigger has passed. Cancelling the stale deal instead of replaying it`,
              )
              await this.closeDealById(
                this.botId,
                d.deal._id,
                CloseDCATypeEnum.cancel,
                false,
              )
              continue
            }
            this.handleLog(
              `${d.deal._id} not started yet. Place base order again`,
            )
            await this.placeBaseOrder(
              this.botId,
              d.deal.symbol.symbol,
              d.deal._id,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              d.deal.fixSize,
              undefined,
              d.deal.sizes,
              d.deal.orderSizeType,
            )
          }
        }
      }
      if (activeDeals.length > 0) {
        this.handleLog(`Found ${activeDeals.length} open deals`)

        for (const d of activeDeals) {
          const findFilledTp = this.getOrdersByStatusAndDealId({
            status: 'FILLED',
            dealId: `${d.deal._id}`,
          }).filter(
            (o) => o.typeOrder === TypeOrderEnum.dealTP && !o.reduceFundsId,
          )
          const settings = await this.getAggregatedSettings(d.deal)
          let skip = false
          if (settings.useMultiSl) {
            const filledSl = new Set(
              d.deal.tpSlTargetFilled?.filter((sl) =>
                settings.multiSl?.map((s) => s.target).includes(sl),
              ) ?? [],
            )
            findFilledTp.forEach(
              (f) => f.tpSlTarget && filledSl.add(f.tpSlTarget),
            )
            if (filledSl.size < (settings.multiSl?.length ?? 0)) {
              skip = true
            }
          }
          if (settings.useMultiTp) {
            const filledTp = new Set(
              d.deal.tpSlTargetFilled?.filter((tp) =>
                settings.multiTp?.map((t) => t.target).includes(tp),
              ) ?? [],
            )
            findFilledTp.forEach(
              (f) => f.tpSlTarget && filledTp.add(f.tpSlTarget),
            )
            if (filledTp.size < (settings.multiTp?.length ?? 0)) {
              skip = true
            }
          }
          if (!settings.useMultiTp && !settings.useMultiSl) {
            const tp = findFilledTp[0]
            skip = !!tp && this.underfilledTpQty(tp) > 0
            if (skip) {
              this.handleLog(
                `Deal ${d.deal._id} left open: TP ${tp.clientOrderId} is FILLED but sold only ${tp.executedQty} of ${tp.origQty}`,
              )
            }
          }
          if (
            findFilledTp.length &&
            d.deal.status !== DCADealStatusEnum.closed &&
            !skip &&
            !d.deal.parent &&
            !this.pendingClose.has(d.deal._id)
          ) {
            this.handleLog(
              `Found filled tp ${findFilledTp
                .map((f) => f.clientOrderId)
                .join(', ')} for ${d.deal._id}, change deal status to closed`,
            )
            if (d.deal.profit.total) {
              d.deal.status = DCADealStatusEnum.closed
              this.saveDeal(d, { status: d.deal.status })
              const stop = await this.processDealClose(this.botId, d.deal._id, {
                total: d.deal.profit.total,
                totalUsd: d.deal.profit.totalUsd,
              })
              if (stop) {
                this.endMethod(_id)
                return this.stop()
              }
            } else {
              this.handleLog(
                `No profit in deal, process full close for ${d.deal._id}`,
              )
              this.closeDeal(
                this.botId,
                `${d.deal._id}`,
                [...findFilledTp].sort(
                  (a, b) => b.updateTime - a.updateTime,
                )[0],
              )
            }
            continue
          }
          await this.setCloseByTimer(d.deal)
          if (!serviceRestart) {
            this.updateDealBalances(d)
            const completeLevels =
              (this.getOrdersByStatusAndDealId({
                dealId: `${d.deal._id}`,
                status: ['FILLED', 'CANCELED'],
              }).filter(
                (o) =>
                  (o.typeOrder === TypeOrderEnum.dealRegular ||
                    (!d.deal.parent &&
                      o.typeOrder === TypeOrderEnum.dealStart)) &&
                  (this.data?.exchange === ExchangeEnum.bybit
                    ? (o.status === 'FILLED' || o.status === 'CANCELED') &&
                      +o.executedQty !== 0
                    : o.status === 'FILLED'),
              ).length ?? 1) + (d.deal.parent ? 1 : 0)
            d.deal = {
              ...d.deal,
              levels: {
                complete: completeLevels,
                all: Math.max(
                  completeLevels,
                  d.initialOrders.filter(
                    (o) => o.type === TypeOrderEnum.dealRegular,
                  ).length +
                    1 +
                    (d.deal.pendingAddFunds ?? []).length +
                    (d.deal.funds ?? []).length,
                ),
              },
            }
            this.saveDeal(d, { levels: d.deal.levels })
            this.updateAssets(d.deal._id)
            const findTp = this.getOrdersByStatusAndDealId({
              status: 'PARTIALLY_FILLED',
              dealId: `${d.deal._id}`,
            }).find((o) => o.typeOrder === TypeOrderEnum.dealTP)
            // On a keep-orders reload — a settings save, or a deal restore —
            // the deal's safety orders are still resting on the venue, because
            // this path deliberately skips both teardowns. But `currentOrders`
            // was rebuilt from the deal's CURRENT price, so its levels sit at
            // different prices and sizes than the orders already out there:
            // `isOrderExistInDeal` matches on price+qty+side, finds no
            // counterpart for any of them, and a whole second ladder goes on
            // top of the live one — the deal ends up with twice the resting
            // exposure the user configured. (A TP cannot duplicate this way:
            // `placeOrders` has its own guard for that one.) Leave the
            // standing ladder alone; it is replaced by the fill path as each
            // level is taken, which is the same promise the rest of this path
            // makes to a running deal.
            const resting = this.keepOrders
              ? this.getOrdersByStatusAndDealId({
                  status: 'NEW',
                  dealId: `${d.deal._id}`,
                })
              : []
            const hasRestingDca = resting.some(
              (o) => o.typeOrder === TypeOrderEnum.dealRegular,
            )
            // The TP needs the same treatment as the ladder above, and
            // `placeOrders`' own TP guard is NOT enough to give it: that guard
            // only skips when the resting TP is LARGER than the recomputed
            // one. A recomputed TP that is larger makes it CANCEL the resting
            // TP and send a replacement, and one of equal size but a different
            // price makes it place a SECOND TP on top. Both reach every open
            // deal at once on a save, so a 50-pair bot re-places ~50 TPs
            // inside two minutes with the entries hours old. Binance Futures
            // scores that as ~50 orders placed against no fills in the same
            // 10-minute cycle — an unfilled ratio of 1.0 versus a 0.99
            // threshold — which is an account-wide Quantitative Rules
            // restriction.
            //
            // A running deal keeps the settings AND the orders it started
            // with, so its resting TP is the correct one by definition and a
            // save has no business touching it. Only place a TP when the deal
            // has none resting.
            // Pinned by tests/processing/tpBurstInvariant.ts.
            const hasRestingTp = resting.some(
              (o) => o.typeOrder === TypeOrderEnum.dealTP,
            )
            await this.placeOrders(
              this.botId,
              d.deal.symbol.symbol,
              d.deal._id,
              {
                new: d.currentOrders.filter((o) => {
                  if (
                    (findTp || hasRestingTp) &&
                    o.type === TypeOrderEnum.dealTP
                  ) {
                    return false
                  }
                  return !(
                    hasRestingDca && o.type === TypeOrderEnum.dealRegular
                  )
                }),
                cancel: [],
              },
            )
            const pendingAddFunds = d.deal.pendingAddFunds ?? []
            if (pendingAddFunds.length) {
              d.deal.pendingAddFunds = []
              this.saveDeal(d, { pendingAddFunds: [] })
              for (const pending of pendingAddFunds) {
                const { id: _id, ...settings } = pending
                this.addDealFunds(this.botId, d.deal._id, settings)
              }
            }
            const pendingReduceFunds = d.deal.pendingReduceFunds ?? []
            if (pendingReduceFunds.length) {
              d.deal.pendingReduceFunds = []
              this.saveDeal(d, { pendingReduceFunds: [] })
              for (const pending of pendingReduceFunds) {
                const { id: _id, ...settings } = pending
                this.reduceDealFunds(this.botId, d.deal._id, settings)
              }
            }
          }
        }
      }

      if (!serviceRestart) {
        this.updateDealLastPrices(this.botId)
      } else {
        this.handleDebug('Service restart skip update last deal price')
      }
      if (
        settings.startCondition === StartConditionEnum.asap &&
        this.data?.status !== BotStatusEnum.closed
      ) {
        if (
          activeDeals.length === 0 &&
          startDeals.length === 0 &&
          !settings.useMulti
        ) {
          if (await this.checkInRange(asapSymbols[0])) {
            this.openNewDeal(this.botId, asapSymbols[0])
          } else {
            if (
              !settings.useDynamicPriceFilter &&
              settings.useStaticPriceFilter
            ) {
              this.setRangeOrError()
            }
          }
        }
        if (settings.useMulti) {
          for (const symbol of asapSymbols) {
            if (await this.checkInRange(symbol)) {
              this.openNewDeal(this.botId, symbol)
            }
          }
        }
      }
      if (
        settings.startCondition === StartConditionEnum.timer &&
        this.data?.status !== BotStatusEnum.closed
      ) {
        this.startTimeBasedTrigger()
      }
      await this.startIndicatorInit(serviceRestart, activeDeals.length)
      if (!serviceRestart) {
        this.calculateBotBalances()
        this.calculateUsage()
      } else {
        this.handleDebug(
          'Service restart skip calculate bot balances and usage',
        )
      }
      this.endMethod(_id)
    }

    private indicatorKey(i: SettingsIndicators) {
      return `${i.indicatorAction}-${i.section}`
    }

    private showIndicatorLogs() {
      return (
        (this.data?.settings.indicators ?? []).length *
          (this.data?.settings.pair ?? []).length <
        200
      )
    }

    private async sendIndicatorSubscribeEvent(
      data: BotParentIndicatorEventDto,
    ): Promise<{
      id: string
      room: string
      data?: IndicatorHistory[]
      lastPrice?: number
      cb?: (_msg: string) => void
    }> {
      if (this.rabbitClient) {
        const result = await this.rabbitClient.sendWithCallback<
          BotParentIndicatorEventDto,
          {
            room: string
            id: string
            status: boolean
            message?: string
            data?: IndicatorHistory[]
            lastPrice?: number
          }
        >(rabbitIndicatorsKey, data, this.indicatorTimeout)
        if (result && result?.response) {
          if (result.response.status) {
            const room = `${result.response.room}`
            const get = this.indicatorRoomConfigMap.get(room) ?? new Set()
            const config = `${data.responseParams.uuid}@${data.responseParams.symbol}`
            get.add(config)
            this.indicatorRoomConfigMap.set(room, get)
            this.indicatorConfigIdMap.set(result.response.id, config)
            const cb = this.indicatorDataCbRedis(room)
            if (!this.indicatorSubscribedRooms.has(room)) {
              this.indicatorSubscribedRooms.add(room)
              if (this.redisSubIndicators) {
                this.redisSubIndicators.subscribe(room, cb)
              }
            }
            return {
              id: result.response.id,
              room,
              data: result.response.data,
              lastPrice: result.response.lastPrice,
              cb,
            }
          } else {
            const msg = `${result.response.message}`
            if (msg.indexOf('not found in exchange') === -1) {
              this.handleErrors(
                `Indicators error: ${result.response.message}`,
                'indicator service',
                '',
                false,
                false,
                true,
              )
            }
          }
        }
      }

      return { id: '', room: '' }
    }

    private async sendIndicatorUnsubscribeEvent(
      id: string,
      room: string,
      cb?: (_msg: string) => void,
      wait = true,
    ): Promise<boolean> {
      const responseId = v4()
      const payload: BotParentUnsubscribeIndicatorEventDto = {
        event: 'unsubscribeIndicator',
        id,
        botId: this.botId,
        responseId,
        type: this.botType,
      }
      const timeout = wait ? this.indicatorTimeout : 0
      if (this.rabbitClient) {
        const result = await this.rabbitClient.sendWithCallback<
          BotParentUnsubscribeIndicatorEventDto,
          boolean
        >(rabbitIndicatorsKey, payload, timeout)
        if (result) {
          if (result.response) {
            const text = `Unsubscribed from indicator ${id}`
            if (this.showIndicatorLogs()) {
              this.handleLog(text)
            } else {
              this.handleDebug(text)
            }
            if (this.redisSubIndicators && cb) {
              this.redisSubIndicators.unsubscribe(room, cb)
            }
            const get = this.indicatorConfigIdMap.get(id)
            this.indicatorConfigIdMap.delete(id)
            if (get) {
              const getRoom = this.indicatorRoomConfigMap.get(room)
              if (getRoom) {
                getRoom.delete(get)
                if (getRoom.size === 0) {
                  this.indicatorRoomConfigMap.delete(room)
                  this.indicatorSubscribedRooms.delete(room)
                } else {
                  this.indicatorRoomConfigMap.set(room, getRoom)
                }
              }
            }
            return true
          }
        }
      }

      return true
    }

    @IdMute(mutex, (botId: string) => `${botId}filterCoinsByVolume`)
    async runAfterIndicatorsConnected(_botId: string) {
      this.handleDebug('Run after indicators connected')
      const c = [...this.afterIndicatorsConnected]
      for (const f of c) {
        await f.bind(this)()
        await sleep(0)
      }
      this.afterIndicatorsConnected = []
    }
    override async beforeDelete() {
      this.stopSessionCheckTimer()
      for (const i of this.indicators.values()) {
        this.handleLog(`Remove listener ${i.id} ${i.uuid}@${i.symbol}`)
        if (this.redisSubIndicators) {
          this.redisSubIndicators.unsubscribe(i.room, i.cb)
        }
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}openIndicators`)
    async openIndicators(_botId: string, _serviceRestart?: boolean) {
      this.indicatorConfigIdMap = new Map()
      this.indicatorRoomConfigMap = new Map()
      this.indicatorSubscribedRooms = new Set()
      this.afterIndicatorsConnected = []
      this.handleLog('Open indicators')
      this.indicatorGroupsToUse = (
        this.data?.settings.indicatorGroups ?? []
      ).filter((ig) => {
        const indicators = (this.data?.settings.indicators ?? []).filter(
          (i) => i.groupId === ig.id,
        )
        return indicators.length > 0
      })
      this.handleLog(
        `Indicator groups to use ${this.indicatorGroupsToUse.length}`,
      )
      const _id = this.startMethod('openIndicators')
      try {
        const saveIndicators = this.saveIndicators
        if (saveIndicators) {
          this.saveIndicators = false
        }
        const serviceRestart = _serviceRestart && !this.openAtStartTriggered
        if (serviceRestart) {
          this.openAtStartTriggered = true
        }
        if (!this.data) {
          this.handleWarn('Open indicators | No data')
          this.endMethod(_id)
          return
        }
        const settings = await this.getAggregatedSettings()

        const symbols = new Set([
          ...(settings.pair ?? []),
          ...this.getOpenDeals().map((d) => d.deal.symbol.symbol),
        ])
        const copySymbols = new Set([...symbols])
        if (saveIndicators) {
          ;[...this.indicators.values()].forEach((i) => {
            if (
              !copySymbols.has(i.symbol) &&
              !this.getDealsByStatusAndSymbol({ symbol: i.symbol }).length
            ) {
              this.handleDebug(
                `Indicator ${i.id} ${i.uuid}@${i.symbol} is not needed anymore. Unsubscribe`,
              )
              this.sendIndicatorUnsubscribeEvent(i.id, i.room, i.cb)
              this.lastIndicatorsDataMap.delete(`${i.uuid}@${i.symbol}`)
              if (this.redisSubIndicators) {
                this.redisSubIndicators.unsubscribe(i.room, i.cb)
              }
              this.indicators.delete(i.key)
              const k = `${i.interval}@${i.action}`
              this.indicatorsIntervalActionMap.set(
                k,
                (this.indicatorsIntervalActionMap.get(k) ?? 1) - 1,
              )
            }
            if (copySymbols.has(i.symbol)) {
              symbols.delete(i.symbol)
            }
          })
        } else {
          for (const i of this.indicators.values()) {
            this.lastIndicatorsDataMap.delete(`${i.uuid}@${i.symbol}`)
            if (this.redisSubIndicators) {
              this.redisSubIndicators.unsubscribe(i.room, i.cb)
            }
          }
        }

        const _indicators: Map<string, LocalIndicators> = saveIndicators
          ? this.indicators
          : new Map()
        if (!saveIndicators) {
          this.indicators.forEach((i) => this.indicators.delete(i.key))
          this.indicators = new Map()
          this.indicatorsIntervalActionMap = new Map()
        }
        const indicatorTypeMap: Map<string, SettingsIndicators[]> = new Map()
        const groupsId = this.indicatorGroupsToUse.map((g) => g.id)
        const filteredIndicators = (settings.indicators ?? [])
          .filter(
            (i) =>
              i.type !== IndicatorEnum.unpnl &&
              i.type !== IndicatorEnum.session,
          )
          .filter(
            (i) => !i.groupId || (i.groupId && groupsId.includes(i.groupId)),
          )
        for (const i of filteredIndicators) {
          if (i.section === IndicatorSection.dca) {
            continue
          }
          const key = this.indicatorKey(i)
          indicatorTypeMap.set(key, [...(indicatorTypeMap.get(key) ?? []), i])
        }
        this.handleDebug(
          `Open indicators | Adding indicators ${symbols.size} symbol`,
        )
        for (const symbol of symbols) {
          const time = +new Date()
          this.handleDebug(`Open indicators | Symbol ${symbol} start`)
          await Promise.all(
            filteredIndicators.map(async (i) => {
              {
                if (!this.data) {
                  return
                }
                const {
                  indicatorLength: _indicatorLength,
                  type,
                  uuid,
                  indicatorInterval,
                  checkLevel: _checkLevel,
                  condition,
                  maType,
                  maCrossingValue,
                  maCrossingInterval,
                  maCrossingLength,
                  maUUID,
                  stochSmoothD: _stochSmoothD,
                  stochSmoothK: _stochSmoothK,
                  stochRSI: _stochRSI,
                  leftBars: _leftBars,
                  rightBars: _rightBars,
                  basePeriods: _basePeriods,
                  pumpPeriods: _pumpPeriods,
                  pump: _pump,
                  baseCrack: _baseCrack,
                  indicatorAction,
                  section,
                  psarInc: _psarInc,
                  psarMax: _psarMax,
                  psarStart: _psarStart,
                  keepConditionBars,
                  voLong: _voLong,
                  voShort: _voShort,
                  uoFast: _uoFast,
                  uoMiddle: _uoMiddle,
                  uoSlow: _uoSlow,
                  momSource,
                  bbwpLookback,
                  xOscillator1,
                  xOscillator2,
                  xOscillator2Interval,
                  xOscillator2length: _xOscillator2length,
                  xOscillator2voLong: _xOscillator2voLong,
                  xOscillator2voShort: _xOscillator2voShort,
                  xoUUID,
                  percentile,
                  mar1length: _mar1length,
                  mar1type,
                  mar2length,
                  mar2type,
                  bbwMa,
                  bbwMaLength: _bbwMaLength,
                  bbwMult: _bbwMult,
                  macdFast: _macdFast,
                  macdSlow: _macdSlow,
                  macdMaSignal,
                  macdMaSource,
                  divOscillators,
                  trendFilter,
                  trendFilterLookback,
                  trendFilterType,
                  trendFilterValue,
                  factor: _factor,
                  atrLength: _atrLength,
                  pcValue,
                  ppHighLeft,
                  ppHighRight,
                  ppLowLeft,
                  ppLowRight,
                  ppMult,
                  athLookback: _athLookback,
                  kcMa,
                  kcRange,
                  kcRangeLength: _kcRangeLength,
                  lwMaxDuration,
                  lwThreshold,
                } = i
                let { percentileLookback, percentilePercentage } = i
                percentileLookback = percentileLookback ?? 150
                percentilePercentage = percentilePercentage ?? 80
                const macdFast = +(_macdFast ?? 12)
                const macdSlow = +(_macdSlow ?? 26)
                const indicatorLength = +(_indicatorLength ?? 14)
                const factor = +(_factor ?? 3)
                const atrLength = +(_atrLength ?? 10)

                const checkLevel = +(_checkLevel ?? 0)
                const athLookback = +(_athLookback ?? 100)
                const stochSmoothD = +(_stochSmoothD ?? 3)
                const stochSmoothK = +(_stochSmoothK ?? 3)
                const stochRSI = +(_stochRSI ?? 14)
                const leftBars = +(_leftBars ?? 5)
                const rightBars = +(_rightBars ?? 5)
                const mar1length = +(_mar1length ?? 20)
                const basePeriods = +(_basePeriods ?? 36)
                const pumpPeriods = +(_pumpPeriods ?? 8)
                const uoFast = +(_uoFast ?? 7)
                const uoMiddle = +(_uoMiddle ?? 14)
                const uoSlow = +(_uoSlow ?? 28)
                const psarInc = +(_psarInc ?? 0.02)
                const psarMax = +(_psarMax ?? 0.2)
                const psarStart = +(_psarStart ?? 0.02)
                const voLong = +(_voLong ?? 10)
                const voShort = +(_voShort ?? 5)
                const bbwMult = +(_bbwMult ?? 2)
                const kcRangeLength = +(_kcRangeLength ?? 20)
                const bbwMaLength = +(_bbwMaLength ?? 20)
                const pump = +(_pump ?? 3)
                const baseCrack = +(_baseCrack ?? 3)
                const xOscillator2length = +(_xOscillator2length ?? 14)
                if (
                  (settings.startCondition !== StartConditionEnum.ti &&
                    indicatorAction === IndicatorAction.startDeal) ||
                  (!settings.useRiskReward &&
                    indicatorAction === IndicatorAction.riskReward) ||
                  (settings.useRiskReward &&
                    indicatorAction === IndicatorAction.riskReward &&
                    settings.type === DCATypeEnum.terminal) ||
                  ((!settings.useTp ||
                    (settings.dealCloseCondition !==
                      CloseConditionEnum.techInd &&
                      !this.tpAr)) &&
                    indicatorAction === IndicatorAction.closeDeal &&
                    section !== IndicatorSection.sl) ||
                  ((!settings.useSl ||
                    (settings.dealCloseConditionSL !==
                      CloseConditionEnum.techInd &&
                      !this.slAr)) &&
                    indicatorAction === IndicatorAction.closeDeal &&
                    section === IndicatorSection.sl) ||
                  ((!settings.useDca ||
                    !(
                      settings.dcaCondition === DCAConditionEnum.indicators ||
                      this.scaleAr
                    )) &&
                    indicatorAction === IndicatorAction.startDca) ||
                  ((!settings.useBotController ||
                    settings.botStart !== BotStartTypeEnum.indicators) &&
                    indicatorAction === IndicatorAction.stopBot) ||
                  ((!settings.useBotController ||
                    settings.botActualStart !== BotStartTypeEnum.indicators) &&
                    indicatorAction === IndicatorAction.startBot)
                ) {
                  return
                }
                if (indicatorLength && indicatorInterval) {
                  const rrOrAr =
                    indicatorAction === IndicatorAction.riskReward ||
                    (indicatorAction === IndicatorAction.startDca &&
                      this.scaleAr) ||
                    (indicatorAction === IndicatorAction.closeDeal &&
                      section !== IndicatorSection.sl &&
                      this.tpAr) ||
                    (indicatorAction === IndicatorAction.closeDeal &&
                      section === IndicatorSection.sl &&
                      this.slAr)
                  const otherOnType = rrOrAr
                    ? []
                    : filteredIndicators.filter(
                        (i) =>
                          i.indicatorAction === indicatorAction &&
                          ((!i.section && !section) || i.section === section),
                      )
                  const lowerIntervals = otherOnType.filter(
                    (i) =>
                      timeIntervalMap[i.indicatorInterval] <
                      timeIntervalMap[indicatorInterval],
                  ).length
                  const useAnd =
                    i.indicatorAction === IndicatorAction.closeDeal
                      ? i.section === IndicatorSection.sl
                        ? !settings.stopDealSlLogic ||
                          settings.stopDealSlLogic === IndicatorsLogicEnum.and
                        : !settings.stopDealLogic ||
                          settings.stopDealLogic === IndicatorsLogicEnum.and
                      : i.indicatorAction === IndicatorAction.startBot
                        ? !settings.startBotLogic ||
                          settings.startBotLogic === IndicatorsLogicEnum.and
                        : i.indicatorAction === IndicatorAction.startDeal
                          ? !settings.startDealLogic ||
                            settings.startDealLogic === IndicatorsLogicEnum.and
                          : i.indicatorAction === IndicatorAction.stopBot
                            ? !settings.stopBotLogic ||
                              settings.stopBotLogic === IndicatorsLogicEnum.and
                            : false
                  const hasLower = rrOrAr
                    ? false
                    : otherOnType.length > 1 && lowerIntervals > 0 && useAnd
                  if (hasLower) {
                    this.handleDebug(
                      `Indicator ${uuid} ${symbol} ${indicatorAction} has indicators with lower interval: ${lowerIntervals}`,
                    )
                  }
                  const indicatorData: BotParentIndicatorEventDto = {
                    data: {
                      indicatorConfig:
                        type === IndicatorEnum.lw
                          ? {
                              type: IndicatorEnum.lw,
                              lwThreshold: +(lwThreshold ?? 2),
                              lwMaxDuration: +(lwMaxDuration ?? 1000),
                            }
                          : type === IndicatorEnum.obfvg
                            ? { type }
                            : type === IndicatorEnum.dc
                              ? { type, length: indicatorLength }
                              : type === IndicatorEnum.macd
                                ? {
                                    type,
                                    shortInterval: macdFast ?? 12,
                                    longInterval: macdSlow ?? 26,
                                    signalInterval: indicatorLength,
                                    percentile,
                                    percentileLookback,
                                    percentilePercentage,
                                    maSignal: macdMaSignal ?? MAEnum.ema,
                                    maSource: macdMaSource ?? MAEnum.ema,
                                  }
                                : type === IndicatorEnum.st
                                  ? {
                                      type,
                                      factor: factor ?? 3,
                                      atrLength: atrLength ?? 10,
                                    }
                                  : type === IndicatorEnum.pp
                                    ? {
                                        type,
                                        ppHighLeft: +(ppHighLeft ?? 5),
                                        ppHighRight: +(ppHighRight ?? 5),
                                        ppLowLeft: +(ppLowLeft ?? 5),
                                        ppLowRight: +(ppLowRight ?? 5),
                                        ppMult: +(ppMult ?? 1),
                                      }
                                    : type === IndicatorEnum.tv
                                      ? {
                                          type,
                                          checkLevel,
                                          useAsEntryExitPoints:
                                            condition ===
                                            TradingviewAnalysisConditionEnum.entry,
                                        }
                                      : type === IndicatorEnum.pc
                                        ? {
                                            type,
                                            pcUp: Math.abs(+(pcValue ?? '5')),
                                            pcDown: Math.abs(+(pcValue ?? '5')),
                                          }
                                        : type === IndicatorEnum.div
                                          ? {
                                              type,
                                              oscillators: divOscillators ?? [],
                                            }
                                          : type === IndicatorEnum.ma
                                            ? {
                                                type,
                                                interval: indicatorLength,
                                                maType: maType || MAEnum.ema,
                                              }
                                            : type === IndicatorEnum.ath
                                              ? {
                                                  type,
                                                  lookback: athLookback ?? 100,
                                                }
                                              : type === IndicatorEnum.xo
                                                ? xOscillator1 ===
                                                  IndicatorEnum.vo
                                                  ? {
                                                      type: xOscillator1,
                                                      voLong: voLong ?? 10,
                                                      voShort: voShort ?? 5,
                                                    }
                                                  : {
                                                      type:
                                                        xOscillator1 ||
                                                        IndicatorEnum.rsi,
                                                      interval: indicatorLength,
                                                    }
                                                : type === IndicatorEnum.atr
                                                  ? {
                                                      type,
                                                      interval: indicatorLength,
                                                    }
                                                  : type === IndicatorEnum.adr
                                                    ? {
                                                        type,
                                                        interval:
                                                          indicatorLength,
                                                      }
                                                    : type ===
                                                        IndicatorEnum.stoch
                                                      ? {
                                                          type,
                                                          k: indicatorLength,
                                                          dsmooth:
                                                            stochSmoothD ?? 1,
                                                          ksmooth:
                                                            stochSmoothK ?? 3,
                                                        }
                                                      : type ===
                                                          IndicatorEnum.stochRSI
                                                        ? {
                                                            type,
                                                            k: indicatorLength,
                                                            dsmooth:
                                                              stochSmoothD ?? 3,
                                                            ksmooth:
                                                              stochSmoothK ?? 3,
                                                            interval:
                                                              stochRSI ?? 14,
                                                          }
                                                        : type ===
                                                            IndicatorEnum.sr
                                                          ? {
                                                              type,
                                                              leftBars:
                                                                leftBars ?? 15,
                                                              rightBars:
                                                                rightBars ?? 15,
                                                            }
                                                          : type ===
                                                              IndicatorEnum.mar
                                                            ? {
                                                                type,
                                                                mar1type:
                                                                  mar1type ||
                                                                  MAEnum.ema,
                                                                mar1length:
                                                                  mar1length ||
                                                                  20,
                                                                mar2type:
                                                                  mar2type ||
                                                                  MAEnum.price,
                                                                mar2length:
                                                                  mar2length ||
                                                                  20,
                                                                percentile,
                                                                percentileLookback,
                                                                percentilePercentage,
                                                                trendFilter,
                                                                trendFilterLookback,
                                                                trendFilterType,
                                                                trendFilterValue,
                                                              }
                                                            : type ===
                                                                IndicatorEnum.mfi
                                                              ? {
                                                                  type,
                                                                  interval:
                                                                    indicatorLength ??
                                                                    14,
                                                                  percentile,
                                                                  percentileLookback,
                                                                  percentilePercentage,
                                                                }
                                                              : type ===
                                                                  IndicatorEnum.qfl
                                                                ? {
                                                                    type,
                                                                    basePeriods:
                                                                      basePeriods ??
                                                                      36,
                                                                    pumpPeriods:
                                                                      pumpPeriods ??
                                                                      8,
                                                                    pump:
                                                                      (pump ??
                                                                        3) /
                                                                      100,
                                                                    baseCrack:
                                                                      (baseCrack ??
                                                                        3) /
                                                                      100,
                                                                  }
                                                                : type ===
                                                                    IndicatorEnum.uo
                                                                  ? {
                                                                      type,
                                                                      fast:
                                                                        uoFast ??
                                                                        7,
                                                                      middle:
                                                                        uoMiddle ??
                                                                        14,
                                                                      slow:
                                                                        uoSlow ??
                                                                        28,
                                                                      percentile,
                                                                      percentileLookback,
                                                                      percentilePercentage,
                                                                    }
                                                                  : type ===
                                                                      IndicatorEnum.mom
                                                                    ? {
                                                                        type,
                                                                        interval:
                                                                          indicatorLength,
                                                                        source:
                                                                          momSource ??
                                                                          'close',
                                                                        percentile,
                                                                        percentileLookback,
                                                                        percentilePercentage,
                                                                      }
                                                                    : type ===
                                                                        IndicatorEnum.bbwp
                                                                      ? {
                                                                          type,
                                                                          interval:
                                                                            indicatorLength,
                                                                          source:
                                                                            momSource ??
                                                                            'close',
                                                                          lookback:
                                                                            bbwpLookback ??
                                                                            252,
                                                                        }
                                                                      : type ===
                                                                          IndicatorEnum.psar
                                                                        ? {
                                                                            type,
                                                                            start:
                                                                              psarStart ??
                                                                              0.02,
                                                                            inc:
                                                                              psarInc ??
                                                                              0.02,
                                                                            max:
                                                                              psarMax ??
                                                                              0.2,
                                                                          }
                                                                        : type ===
                                                                            IndicatorEnum.vo
                                                                          ? {
                                                                              type,
                                                                              voLong:
                                                                                voLong ??
                                                                                10,
                                                                              voShort:
                                                                                voShort ??
                                                                                5,
                                                                              percentile,
                                                                              percentileLookback,
                                                                              percentilePercentage,
                                                                            }
                                                                          : type ===
                                                                              IndicatorEnum.kc
                                                                            ? {
                                                                                type,
                                                                                interval:
                                                                                  indicatorLength,
                                                                                ma:
                                                                                  kcMa ||
                                                                                  MAEnum.ema,
                                                                                multiplier:
                                                                                  bbwMult ||
                                                                                  2,
                                                                                range:
                                                                                  kcRange ||
                                                                                  RangeType.atr,
                                                                                rangeLength:
                                                                                  kcRangeLength ||
                                                                                  20,
                                                                              }
                                                                            : type ===
                                                                                IndicatorEnum.kcpb
                                                                              ? {
                                                                                  type,
                                                                                  interval:
                                                                                    indicatorLength,
                                                                                  ma:
                                                                                    kcMa ||
                                                                                    MAEnum.ema,
                                                                                  multiplier:
                                                                                    bbwMult ||
                                                                                    2,
                                                                                  range:
                                                                                    kcRange ||
                                                                                    RangeType.atr,
                                                                                  rangeLength:
                                                                                    kcRangeLength ||
                                                                                    20,
                                                                                  percentile,
                                                                                  percentileLookback,
                                                                                  percentilePercentage,
                                                                                }
                                                                              : type ===
                                                                                  IndicatorEnum.bb
                                                                                ? {
                                                                                    type,
                                                                                    interval:
                                                                                      indicatorLength,
                                                                                    bbwMa:
                                                                                      bbwMa ||
                                                                                      MAEnum.sma,
                                                                                    bbwMaLength:
                                                                                      bbwMaLength ||
                                                                                      20,
                                                                                    bbwMult:
                                                                                      bbwMult ||
                                                                                      2,
                                                                                  }
                                                                                : type ===
                                                                                    IndicatorEnum.bbw
                                                                                  ? {
                                                                                      type,
                                                                                      interval:
                                                                                        indicatorLength,
                                                                                      bbwMa:
                                                                                        bbwMa ||
                                                                                        MAEnum.sma,
                                                                                      bbwMaLength:
                                                                                        bbwMaLength ||
                                                                                        20,
                                                                                      bbwMult:
                                                                                        bbwMult ||
                                                                                        2,
                                                                                      percentile,
                                                                                      percentileLookback,
                                                                                      percentilePercentage,
                                                                                    }
                                                                                  : type ===
                                                                                      IndicatorEnum.bbpb
                                                                                    ? {
                                                                                        type,
                                                                                        interval:
                                                                                          indicatorLength,
                                                                                        bbwMa:
                                                                                          bbwMa ||
                                                                                          MAEnum.sma,
                                                                                        bbwMaLength:
                                                                                          bbwMaLength ||
                                                                                          20,
                                                                                        bbwMult:
                                                                                          bbwMult ||
                                                                                          2,
                                                                                        percentile,
                                                                                        percentileLookback,
                                                                                        percentilePercentage,
                                                                                      }
                                                                                    : type ===
                                                                                        IndicatorEnum.ecd
                                                                                      ? {
                                                                                          type,
                                                                                        }
                                                                                      : ({
                                                                                          type,
                                                                                          interval:
                                                                                            indicatorLength,
                                                                                          percentile,
                                                                                          percentileLookback,
                                                                                          percentilePercentage,
                                                                                        } as IndicatorConfig),
                      interval:
                        type === IndicatorEnum.adr
                          ? ExchangeIntervals.oneD
                          : indicatorInterval,
                      symbol,
                      exchange: this.data.exchange,
                      test: false,
                      limitMultiplier: serviceRestart
                        ? this.convertToMultiplier(keepConditionBars)
                        : undefined,
                      load1d: rrOrAr || hasLower,
                    },
                    event: 'subscribeIndicator',
                    botId: this.botId,
                    responseId: v4(),
                    responseParams: {
                      uuid,
                      symbol,
                    },
                    type: this.botType,
                  }
                  const { id, room, data, cb } =
                    await this.sendIndicatorSubscribeEvent(indicatorData)
                  if (!id) {
                    this.handleDebug(
                      `Indicator ${uuid} ${symbol} not connected`,
                    )
                    return
                  }
                  const maChild =
                    type === IndicatorEnum.ma &&
                    maCrossingValue !== MAEnum.price &&
                    maCrossingInterval &&
                    maCrossingLength &&
                    maUUID &&
                    maCrossingValue &&
                    indicatorAction !== IndicatorAction.riskReward &&
                    !(
                      this.scaleAr &&
                      indicatorAction === IndicatorAction.startDca
                    ) &&
                    !(
                      indicatorAction === IndicatorAction.closeDeal &&
                      section !== IndicatorSection.sl &&
                      this.tpAr
                    ) &&
                    !(
                      indicatorAction === IndicatorAction.closeDeal &&
                      section === IndicatorSection.sl &&
                      this.slAr
                    )
                  const xoChild =
                    type === IndicatorEnum.xo &&
                    xOscillator2 &&
                    xOscillator2Interval &&
                    xOscillator2length &&
                    xoUUID &&
                    indicatorAction !== IndicatorAction.riskReward &&
                    !(
                      this.scaleAr &&
                      indicatorAction === IndicatorAction.startDca
                    ) &&
                    !(
                      indicatorAction === IndicatorAction.closeDeal &&
                      section !== IndicatorSection.sl &&
                      this.tpAr
                    ) &&
                    !(
                      indicatorAction === IndicatorAction.closeDeal &&
                      section === IndicatorSection.sl &&
                      this.slAr
                    )
                  const key = `${uuid}@${symbol}`
                  const findInCurrent = serviceRestart
                    ? this.data.indicatorsData?.find(
                        (id) =>
                          id.signature === this.getIndicatorSignature(i) &&
                          id.symbol === symbol &&
                          id.uuid === uuid,
                      )
                    : _indicators.get(key)

                  const active = (findInCurrent?.statusTo ?? 0) > +new Date()
                  const k = `${indicatorInterval}@${indicatorAction}`
                  this.indicatorsIntervalActionMap.set(
                    k,
                    (this.indicatorsIntervalActionMap.get(k) ?? 0) + 1,
                  )
                  this.indicators.set(key, {
                    uuid,
                    id: id,
                    room,
                    status: active ? (findInCurrent?.status ?? false) : false,
                    statusSince: active
                      ? findInCurrent?.statusSince
                      : undefined,
                    statusTo: active ? findInCurrent?.statusTo : undefined,
                    numberOfSignals: active
                      ? findInCurrent?.numberOfSignals
                      : undefined,
                    data: !!data,
                    history: data ?? [],
                    symbol,
                    key,
                    action: indicatorAction,
                    maCross: false,
                    section,
                    interval: indicatorInterval,
                    parentIndicator: '',
                    childIndicator: maChild ? maUUID : xoChild ? xoUUID : '',
                    cb,
                    groupId: i.groupId,
                    is1d: rrOrAr || hasLower,
                  })
                  const text = `Bot connected to ${type} indicator. Id: ${id}, room: ${room}`
                  if (this.showIndicatorLogs()) {
                    this.handleLog(text)
                  } else {
                    this.handleDebug(text)
                  }
                  if (maChild) {
                    const load1d =
                      hasLower &&
                      timeIntervalMap[indicatorInterval] <=
                        timeIntervalMap[maCrossingInterval]
                    const indicatorChildData: BotParentIndicatorEventDto = {
                      data: {
                        indicatorConfig: {
                          type,
                          interval: maCrossingLength,
                          maType: maCrossingValue,
                        },
                        interval: maCrossingInterval,
                        symbol,
                        exchange: this.data.exchange,
                        test: false,
                        load1d,
                      },

                      botId: this.botId,
                      responseId: v4(),
                      responseParams: { uuid: maUUID, symbol },
                      event: 'subscribeIndicator',
                      type: this.botType,
                    }
                    const {
                      id: idChild,
                      room: roomChild,
                      data: dataChild,
                      cb: cbChild,
                    } = await this.sendIndicatorSubscribeEvent(
                      indicatorChildData,
                    )
                    if (!idChild) {
                      this.handleWarn(
                        `Indicator ${maUUID} ${symbol} not connected`,
                      )
                      return
                    }
                    const maKey = `${maUUID}@${symbol}`
                    const findInCurrent = _indicators.get(maKey)

                    const active =
                      !serviceRestart &&
                      (findInCurrent?.statusTo ?? 0) > +new Date()
                    this.indicators.set(maKey, {
                      uuid: maUUID,
                      id: idChild,
                      room: roomChild,
                      status: active ? (findInCurrent?.status ?? false) : false,
                      statusSince: active
                        ? findInCurrent?.statusSince
                        : undefined,
                      statusTo: active ? findInCurrent?.statusTo : undefined,
                      numberOfSignals: active
                        ? findInCurrent?.numberOfSignals
                        : undefined,
                      data: !!dataChild,
                      history: dataChild ?? [],
                      symbol,
                      key: maKey,
                      action: indicatorAction,
                      maCross: true,
                      section,
                      interval: indicatorInterval,
                      parentIndicator: uuid,
                      childIndicator: '',
                      cb: cbChild,
                      groupId: '',
                      is1d: load1d,
                    })
                    const text = `Bot connected to ${type} indicator. Id: ${idChild}, room: ${roomChild}`
                    if (this.showIndicatorLogs()) {
                      this.handleLog(text)
                    } else {
                      this.handleDebug(text)
                    }
                  }
                  if (xoChild) {
                    const load1d =
                      hasLower &&
                      timeIntervalMap[indicatorInterval] <=
                        timeIntervalMap[
                          xOscillator2Interval || indicatorInterval
                        ]
                    const indicatorChildData: BotParentIndicatorEventDto = {
                      data: {
                        indicatorConfig:
                          xOscillator2 === IndicatorEnum.vo
                            ? {
                                type: xOscillator2,
                                voLong: _xOscillator2voLong ?? voLong ?? 10,
                                voShort: _xOscillator2voShort ?? voShort ?? 5,
                              }
                            : {
                                type: xOscillator2 || IndicatorEnum.mfi,
                                interval: xOscillator2length || indicatorLength,
                              },
                        interval: xOscillator2Interval || indicatorInterval,
                        symbol,
                        exchange: this.data.exchange,
                        test: false,
                        load1d,
                      },
                      event: 'subscribeIndicator',
                      botId: this.botId,
                      responseId: v4(),
                      responseParams: { uuid: xoUUID, symbol },
                      type: this.botType,
                    }
                    const {
                      id: idChild,
                      room: roomChild,
                      data: dataChild,
                      cb: cbChild,
                    } = await this.sendIndicatorSubscribeEvent(
                      indicatorChildData,
                    )
                    if (!idChild) {
                      this.handleWarn(
                        `Indicator ${xoUUID} ${symbol} not connected`,
                      )
                      return
                    }
                    const xoKey = `${xoUUID}@${symbol}`
                    const findInCurrent = _indicators.get(xoKey)
                    const active =
                      !serviceRestart &&
                      (findInCurrent?.statusTo ?? 0) > +new Date()
                    this.indicators.set(xoKey, {
                      uuid: xoUUID,
                      id: idChild,
                      room: roomChild,
                      status: active ? (findInCurrent?.status ?? false) : false,
                      statusSince: active
                        ? findInCurrent?.statusSince
                        : undefined,
                      statusTo: active ? findInCurrent?.statusTo : undefined,
                      numberOfSignals: active
                        ? findInCurrent?.numberOfSignals
                        : undefined,
                      data: !!dataChild,
                      history: dataChild ?? [],
                      symbol,
                      key: xoKey,
                      action: indicatorAction,
                      maCross: true,
                      section,
                      interval: indicatorInterval,
                      childIndicator: '',
                      parentIndicator: uuid,
                      cb: cbChild,
                      groupId: '',
                      is1d: load1d,
                    })
                    const text = `Bot connected to ${type} indicator. Id: ${idChild}, room: ${roomChild}`
                    if (this.showIndicatorLogs()) {
                      this.handleLog(text)
                    } else {
                      this.handleDebug(text)
                    }
                  }
                } else {
                  this.handleDebug(
                    `Bot start condition set to ${type}, but values wasn't provided.`,
                  )
                }
              }
            }),
          )
          await sleep(0)
          this.handleDebug(
            `Open indicators | Symbol ${symbol} end. Took ${
              (+new Date() - time) / 1000
            }s to connect ${filteredIndicators.length} indicators`,
          )
        }
        this.handleDebug(
          `Open indicators | Added ${this.indicators.size} indicators to the bot`,
        )
      } catch (e) {
        this.handleErrors(
          `Open indicators error: ${(e as Error)?.message ?? e}`,
          'indicator service',
          '',
          false,
          false,
          false,
        )
      }
      this.endMethod(_id)
      this.runAfterIndicatorsConnected(this.botId)
      this.startSessionCheckTimer()
    }

    private startSessionCheckTimer() {
      this.stopSessionCheckTimer()
      const sessionIndicator = this.data?.settings.indicators?.find(
        (i) => i.type === IndicatorEnum.session,
      )
      if (!sessionIndicator) {
        return
      }
      const days = sessionIndicator.sessionDays ?? [1, 2, 3, 4, 5]
      const rule = sessionIndicator.sessionRule ?? 'in'
      const { uuid, indicatorAction, section, groupId } = sessionIndicator
      // Register session indicator in the map for the first symbol
      // Session is time-based, not symbol-specific, so one entry per symbol
      for (const symbol of this.pairs) {
        const key = `${uuid}@${symbol}`
        if (!this.indicators.has(key)) {
          this.indicators.set(key, {
            uuid,
            id: `session-${uuid}`,
            room: '',
            status: false,
            data: true,
            history: [],
            symbol,
            key,
            action: indicatorAction,
            maCross: false,
            section,
            interval: ExchangeIntervals.oneM,
            parentIndicator: '',
            childIndicator: '',
            groupId: groupId,
            is1d: false,
          })
        }
      }
      const check = () => {
        this.handleDebug('Checking session indicator status')
        const inSession = isInSession(Date.now(), days, rule)
        const toProcess: (() => void)[] = []
        for (const [key, ind] of this.indicators.entries()) {
          if (ind.uuid === uuid) {
            ind.status = inSession
            ind.data = true
            ind.history = ind.history ?? []
            const lastData = {
              time: Date.now(),
              value: inSession,
              type: IndicatorEnum.session as typeof IndicatorEnum.session,
            }
            ind.history.push(lastData)
            this.indicators.set(key, ind)
            if (inSession) {
              toProcess.push(() =>
                this.checkIndicatorStatus(
                  this.botId,
                  ind.symbol,
                  lastData,
                  ind.interval,
                  ind.section,
                  ind.action,
                ),
              )
            }
          }
          toProcess.forEach((fn) => fn())
        }
      }
      // Run immediately then every 60s
      check()
      this.sessionCheckTimer = setInterval(check, 60_000)
    }

    private stopSessionCheckTimer() {
      if (this.sessionCheckTimer) {
        clearInterval(this.sessionCheckTimer)
        this.sessionCheckTimer = null
      }
    }

    /**
     * Open new deal manualy
     */

    async openNewDealMan(_symbol?: string) {
      if (this.data) {
        const settings = await this.getAggregatedSettings()
        const symbols = _symbol ? [_symbol] : (settings.pair ?? [])
        this.handleLog('Open new deal manualy')
        for (const symbol of symbols) {
          this.openNewDeal(this.botId, symbol, true)
        }
      }
    }

    async getSmartSellOrderQty(
      symbol: string,
      _balance: UnPromise<ReturnType<typeof this.checkAssets>>,
    ) {
      const ed = await this.getExchangeInfo(symbol)
      if (!ed || !this.data) {
        return 0
      }
      const settings = await this.getAggregatedSettings()
      if (
        checkNumber(settings.baseOrderSize) &&
        settings.baseOrderPrice &&
        checkNumber(settings.baseOrderPrice) &&
        settings.baseOrderSize
      ) {
        const { orderSizeType } = settings
        const price = +settings.baseOrderPrice
        const baseSize = +settings.baseOrderSize
        const precision = await this.baseAssetPrecision(symbol)
        let required = this.math.round(baseSize, precision, true)
        if (orderSizeType === OrderSizeTypeEnum.quote) {
          required = this.math.round(
            (baseSize * (this.coinm ? ed.quoteAsset.minAmount : 1)) / price,
            precision,
            true,
          )
        }
        if (settings.coinm) {
          const cont = (price * required) / ed.quoteAsset.minAmount
          if (cont < 1) {
            required = this.math.round(
              ed.quoteAsset.minAmount / price,
              precision,
              false,
              true,
            )
          } else if (cont % 1 > Number.EPSILON) {
            required = this.math.round(
              (this.math.round(cont, 0) * ed.quoteAsset.minAmount) / price,
              precision,
              false,
              true,
            )
          }
        }
        return required
      }
      return 0
    }

    async checkBalance(symbol: string) {
      const result = {
        status: true,
        required: 0,
        available: 0,
        price: 0,
      }
      if (
        this.data?.action &&
        this.data.action !== ActionsEnum.noAction &&
        this.data.action !== ActionsEnum.useBalance
      ) {
        this.handleLog(`Balance check skipped. Action is ${this.data.action}`)
        return result
      }
      const settings = await this.getAggregatedSettings()
      if (settings.skipBalanceCheck) {
        this.handleLog(`Balance check skipped`)
        return result
      }
      const ed = await this.getExchangeInfo(symbol)
      if (!ed) {
        return result
      }
      const balance = await this.checkAssets(true, true)
      const leverage = await this.getLeverageMultipler()
      if (settings.terminalDealType === TerminalDealTypeEnum.import) {
        const fee = await this.getUserFee(settings.pair?.[0] ?? '')
        const requiredBase =
          ((await this.getSmartSellOrderQty(symbol, balance)) / leverage) *
          (1 - (fee?.maker ?? 0))
        const baseBalance = balance?.get(ed.baseAsset.name)?.free ?? 0
        const requiredQuote =
          (requiredBase * +(settings.baseOrderPrice ?? 0)) / leverage
        const quoteBalance = balance?.get(ed.quoteAsset.name)?.free ?? 0
        if (this.futures) {
          if (this.coinm) {
            if (baseBalance < requiredBase) {
              return {
                status: false,
                available: baseBalance,
                required: requiredBase,
                price: 0,
              }
            }
          } else {
            if (quoteBalance < requiredQuote) {
              return {
                status: false,
                available: quoteBalance,
                required: requiredQuote,
                price: 0,
              }
            }
          }
        } else {
          if (this.isLong) {
            if (baseBalance < requiredBase) {
              return {
                status: false,
                available: baseBalance,
                required: requiredBase,
                price: 0,
              }
            }
          } else {
            if (quoteBalance < requiredQuote) {
              return {
                status: false,
                available: quoteBalance,
                required: requiredQuote,
                price: 0,
              }
            }
          }
        }
        return result
      }
      const latestPrice = await this.getLatestPrice(symbol)
      if (latestPrice === 0) {
        this.handleDebug('Latest price is 0, bypass check balance')
        return result
      }
      const base = await this.getBaseOrder(
        symbol,
        undefined,
        undefined,
        latestPrice,
      )
      if (!base) {
        this.handleDebug('Cannot get base order, bypass check balance')
        return result
      }
      const initialGrids = await this.createInitialDealOrders(
        symbol,
        latestPrice,
        '',
      )
      const currentGrids = await this.createCurrentDealOrders(
        symbol,
        latestPrice,
        initialGrids,
        latestPrice,
        latestPrice,
        '',
        false,
        undefined,
        true,
      )
      const allGrids = currentGrids.filter(
        (g) => g.type === TypeOrderEnum.dealRegular,
      )
      const usedGrids = currentGrids.filter(
        (g) =>
          g.side === (this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell),
      )
      let additionalValue = 0
      if (this.useCompountReduce) {
        const profit =
          (this.data?.profit.total ?? 0) /
          (settings.profitCurrency === 'base' ? 1 : +base.price)
        if (profit < 0 && settings.useRiskReduction) {
          additionalValue =
            profit * (+(settings.riskReductionValue ?? '50') / 100) * 0.995
        }
        if (profit > 0 && settings.useReinvest) {
          additionalValue = profit * (+(settings.reinvestValue ?? '50') / 100)
        }
      }
      const requiredAmount = this.futures
        ? this.coinm
          ? allGrids.reduce((acc, g) => acc + g.qty, 0) +
            +base.origQty +
            additionalValue
          : allGrids.reduce((acc, g) => acc + g.qty * g.price, 0) +
            (+base.origQty + additionalValue) * +base.price
        : this.isLong
          ? (+base.origQty + additionalValue) * +base.price +
            usedGrids.reduce((acc, g) => acc + g.price * g.qty, 0)
          : +base.origQty +
            usedGrids.reduce((acc, g) => acc + g.qty, 0) +
            additionalValue
      let available =
        (this.futures
          ? this.coinm
            ? (balance?.get(ed.baseAsset.name)?.free ?? 0)
            : (balance?.get(ed.quoteAsset.name)?.free ?? 0)
          : this.isLong
            ? (balance?.get(ed.quoteAsset.name)?.free ?? 0)
            : balance?.get(ed.baseAsset.name)?.free) ?? 0
      if (requiredAmount / leverage > available) {
        available = await this.pooledMarginOrKeep(ed.quoteAsset.name, available)
      }
      if (requiredAmount / leverage > available) {
        return {
          status: false,
          required: requiredAmount / leverage,
          available,
          price: latestPrice,
        }
      }
      return result
    }

    @IdMute(mutex, (botId: string) => `${botId}resetPending`)
    resetPending(_botId: string, symbol: string) {
      this.pendingDeals -= 1
      if (this.pendingDeals < 0) {
        this.pendingDeals = 0
      }
      this.pendingDealsOver -= 1
      if (this.pendingDealsOver < 0) {
        this.pendingDealsOver = 0
      }
      this.pendingDealsUnder -= 1
      if (this.pendingDealsUnder < 0) {
        this.pendingDealsUnder = 0
      }
      const keys = [symbol, `${symbol}-over`, `${symbol}-under`]
      for (const key of keys) {
        const perPair = this.pendingDealsPerPair.get(key)
        if (perPair && perPair <= 1) {
          this.pendingDealsPerPair.delete(key)
        }
        if (!perPair || perPair > 1) {
          this.pendingDealsPerPair.set(key, perPair ? perPair - 1 : 1)
        }
      }
    }

    async openDealAfterTimer() {
      const asapSymbols = await this.getSymbolsToOpenAsapDeals()
      for (const symbol of asapSymbols) {
        this.openNewDeal(this.botId, symbol)
      }
    }

    private async checkRiskRewardCondition(
      pair: string,
      price: number,
    ): Promise<{ tp?: number; sl: number; size: number } | null> {
      const {
        riskTpRatio,
        riskSlAmountValue,
        riskSlType,
        riskSlAmountPerc,
        riskMaxPositionSize,
        riskMinPositionSize,
        riskUseTpRatio,
        indicators,
        riskMaxSl,
        riskMinSl,
        rrSlFixedValue,
        rrSlType,
      } = await this.getAggregatedSettings()
      const isRRSLTypeIndicator =
        rrSlType === RRSlTypeEnum.indicator || !rrSlType
      const isRRSLTypeFixed = rrSlType === RRSlTypeEnum.fixed
      const indicator = isRRSLTypeIndicator
        ? [...this.indicators.values()].find(
            (i) => i.symbol === pair && i.action === IndicatorAction.riskReward,
          )
        : undefined
      if (!indicator && isRRSLTypeIndicator) {
        this.handleErrors(
          `Risk reward indicator not found for ${pair}`,
          'checkRiskRewardCondition',
          '',
          false,
          false,
          false,
        )
        return null
      }

      const [last] =
        isRRSLTypeIndicator && indicator
          ? [...indicator.history].sort((a, b) => b.time - a.time)
          : []
      if (!last && isRRSLTypeIndicator) {
        return null
      }

      const indicatorSettings = isRRSLTypeIndicator
        ? (indicators ?? []).find(
            (i) => i.indicatorAction === IndicatorAction.riskReward,
          )
        : undefined
      if (!indicatorSettings && isRRSLTypeIndicator) {
        if (!indicator) {
          this.handleErrors(
            `Risk reward indicator not found for ${pair}`,
            'checkRiskRewardCondition',
            '',
            false,
          )
          return null
        }
        return null
      }

      let value = NaN
      if (indicatorSettings) {
        const { type, ppValue, srCrossingValue, bbCrossingValue, stCondition } =
          indicatorSettings
        if (type === IndicatorEnum.pp) {
          const data = last.value as PriorPivotResult
          if (ppValue === ppValueEnum.anyH) {
            value = isNaN(data.hh) || data.hh === null ? data.lh : data.hh
          }
          if (ppValue === ppValueEnum.hh) {
            value = data.all.hh
          }
          if (ppValue === ppValueEnum.lh) {
            value = data.all.lh
          }
          if (ppValue === ppValueEnum.anyL) {
            value = isNaN(data.ll) || data.ll === null ? data.hl : data.ll
          }
          if (ppValue === ppValueEnum.hl) {
            value = data.all.hl
          }
          if (ppValue === ppValueEnum.ll) {
            value = data.all.ll
          }
          if (ppValue === ppValueEnum.anySWH) {
            value = isNaN(data.wh) || data.wh === null ? data.sh : data.wh
          }
          if (ppValue === ppValueEnum.wh) {
            value = data.all.wh
          }
          if (ppValue === ppValueEnum.sh) {
            value = data.all.sh
          }
          if (ppValue === ppValueEnum.anySWL) {
            value = isNaN(data.wl) || data.wl === null ? data.sl : data.wl
          }
          if (ppValue === ppValueEnum.wl) {
            value = data.all.wl
          }
          if (ppValue === ppValueEnum.sl) {
            value = data.all.sl
          }
        }
        if (type === IndicatorEnum.qfl) {
          const data = last.value as QFLResult
          value = data.base
        }
        if (type === IndicatorEnum.sr) {
          const data = last.value as PivotResult
          value =
            srCrossingValue === SRCrossingEnum.resistance ? data.high : data.low
        }
        if (type === IndicatorEnum.bb || type === IndicatorEnum.kc) {
          const data = last.value as {
            result: BandsResult
            price: number
          }
          value =
            bbCrossingValue === BBCrossingEnum.lower
              ? data.result.lower
              : bbCrossingValue === BBCrossingEnum.middle
                ? data.result.middle
                : data.result.upper
        }
        if (type === IndicatorEnum.ma) {
          const data = last.value as MAResult
          value = data.ma
        }
        if (type === IndicatorEnum.st) {
          const data = last.value as SuperTrendResult
          value =
            stCondition === STConditionEnum.down ? data.all.down : data.all.up
        }
        if (type === IndicatorEnum.psar) {
          const data = last.value as { psar: number; price: number }
          value = data.psar
        }
        if (type === IndicatorEnum.atr) {
          const atrMultiplier = +(indicatorSettings?.riskAtrMult ?? '1')
          const data = last.value as number
          value = this.isLong
            ? price - data * atrMultiplier
            : price + data * atrMultiplier
        }
      }
      if (isRRSLTypeFixed) {
        const sl = +(rrSlFixedValue ?? '-1') / 100
        value = this.isLong ? price * (1 + sl) : price * (1 - sl)
      }
      if (isNaN(value) || value === null) {
        this.handleErrors(
          `Risk reward value not found for ${pair}`,
          'checkRiskRewardCondition',
          '',
          false,
        )
        return null
      }
      const symbol = await this.getExchangeInfo(pair)
      const precisionPrice = symbol?.priceAssetPrecision
      const precisionQuote = precisionPrice
      const precisionBase = await this.baseAssetPrecision(pair)
      let currentRiskSlPrice = this.math.round(value, precisionPrice)
      const minSl =
        typeof riskMinSl !== 'undefined' && `${riskMinSl}` !== 'null'
          ? Math.abs(+riskMinSl) / 100
          : riskSlType === RiskSlTypeEnum.perc && riskSlAmountPerc
            ? Math.abs(+riskSlAmountPerc) / 100
            : null
      const maxSl = riskMaxSl ? Math.abs(+riskMaxSl) / 100 : 1
      let currentSl = Math.abs((currentRiskSlPrice - price) / price)
      if (minSl && currentSl < minSl) {
        this.handleErrors(
          `Current SL ${this.math.round(
            currentSl * 100 * -1,
            2,
          )}% lower than minimum SL ${this.math.round(
            minSl * 100 * -1,
            2,
          )}% for ${pair}. Using minimum SL`,
          'riskReward',
          '',
          false,
          false,
        )
        currentSl = minSl * -1
      } else if (maxSl && currentSl > maxSl) {
        this.handleErrors(
          `Current SL ${this.math.round(
            currentSl * 100 * -1,
            2,
          )}% more than maximum SL ${this.math.round(
            maxSl * 100 * -1,
            2,
          )}% for ${pair}. Using maximum SL`,
          'riskReward',
          '',
          false,
          false,
        )
        currentSl = maxSl * -1
      } else {
        currentSl *= -1
      }
      const riskSlPerc = currentSl
      currentRiskSlPrice = this.math.round(
        price * (1 + riskSlPerc * (this.isLong ? 1 : -1)),
        symbol?.priceAssetPrecision,
      )
      const rewardTpPerc = Math.abs(riskSlPerc) * +(riskTpRatio ?? '1')
      const rewardTpPrice = this.math.round(
        price * (1 + rewardTpPerc * (this.isLong ? 1 : -1)),
        precisionPrice,
      )
      const riskPrecision = this.futures
        ? this.coinm
          ? precisionBase
          : precisionQuote
        : this.isLong
          ? precisionQuote
          : precisionBase
      const balances = await this.checkAssets(true, true)
      const asset =
        (this.futures
          ? this.coinm
            ? symbol?.baseAsset.name
            : symbol?.quoteAsset.name
          : this.isLong
            ? symbol?.quoteAsset.name
            : symbol?.baseAsset.name) || ''
      const riskBalance = balances?.get(asset)?.free
      if ((riskBalance ?? 0) <= 0) {
        this.handleErrors(
          `Balance for ${asset} is lower than 0 (${riskBalance})`,
          'riskReward',
          '',
          false,
        )
        return null
      }
      const riskSize = this.math.round(
        riskSlType === RiskSlTypeEnum.fixed
          ? +(riskSlAmountValue ?? 0)
          : (riskBalance ?? 0) * (+(riskSlAmountPerc ?? '1') / 100),
        riskPrecision ? riskPrecision + 2 : undefined,
      )
      const positionSize =
        riskSlPerc >= 0 || riskSize === 0
          ? 0
          : this.math.round(
              riskSize /
                Math.abs(riskSlPerc) /
                (await this.getLeverageMultipler()),
              riskPrecision,
            )
      if (positionSize <= 0) {
        this.handleErrors(
          `Position size is lower than 0 for ${pair}`,
          'riskReward',
          '',
          false,
        )
        return null
      }
      let min = +(riskMinPositionSize ?? '0')
      if (min === -1) {
        min = 0
      }
      let max = +(riskMaxPositionSize ?? '0')
      if (max === -1 || max === 0) {
        max = Infinity
      }
      if (positionSize < min || positionSize > max) {
        this.handleErrors(
          `Position size (${positionSize}) ${
            positionSize < min ? `lower than ${min}` : `higher than ${max}`
          } for ${pair}`,
          'riskReward',
          '',
          false,
        )
        return null
      }
      return {
        size: positionSize,
        sl: currentRiskSlPrice,
        tp: riskUseTpRatio ? rewardTpPrice : undefined,
      }
    }

    /**
     * The indicators whose values price a dynamic-AR ladder for `pair`.
     *
     * Split out from {@link getDynamicLevels} so a caller can tell the two very
     * different reasons for "no levels" apart: NONE configured (a broken bot
     * that can never open a deal) versus configured but not warmed up yet
     * (transient, clears within a candle). Bug #463.
     */
    private getDynamicArIndicators(pair: string) {
      return [...this.indicators.values()].filter(
        (i) =>
          i.symbol === pair &&
          ((this.scaleAr && i.action === IndicatorAction.startDca) ||
            (this.tpAr &&
              i.action === IndicatorAction.closeDeal &&
              i.section !== IndicatorSection.sl) ||
            (this.slAr &&
              i.action === IndicatorAction.closeDeal &&
              i.section === IndicatorSection.sl)),
      )
    }

    private getDynamicLevels(pair: string): DynamicArPrices[] {
      const indicators = this.getDynamicArIndicators(pair)
      const result: DynamicArPrices[] = []
      for (const i of indicators) {
        if (!i.history || !i.history.length) {
          continue
        }
        const [last] = [...i.history].sort((a, b) => b.time - a.time)

        result.push({ id: i.uuid, value: last.value as number })
      }
      if (indicators.length !== result.length) {
        return []
      }
      return result
    }

    public async calculateCompoundReduce(
      symbol: string,
    ): Promise<Sizes | null> {
      const use = this.useCompountReduce
      if (!use) {
        return null
      }

      const settings = await this.getAggregatedSettings()

      const profit = this.data?.profit.total ?? 0

      if (
        (profit > 0 && !settings.useReinvest) ||
        (profit < 0 && !settings.useRiskReduction)
      ) {
        return null
      }

      let maxDeals = +(settings.maxNumberOfOpenDeals ?? '0')
      if (!maxDeals || maxDeals <= 0) {
        if (settings.useMulti) {
          const maxDealsPerPair = +(settings.maxDealsPerPair ?? '0')
          if (!maxDealsPerPair || maxDealsPerPair <= 0) {
            maxDeals = 1
          } else {
            maxDeals = Math.max(
              1,
              maxDealsPerPair * (settings.pair ?? []).length,
            )
          }
        }
      }

      const toUse =
        (profit *
          (settings.useReinvest
            ? +(settings.reinvestValue ?? '50') / 100
            : +(settings.riskReductionValue ?? '50') / 100)) /
        maxDeals

      const price = await this.getLatestPrice(symbol)

      const orders = (
        await this.createInitialDealOrders(symbol, price, '')
      ).filter((o) => o.type === TypeOrderEnum.dealRegular)

      const baseOrder = await this.getBaseOrder(symbol)

      if (!baseOrder) {
        return null
      }

      const totalOrders =
        orders.reduce((acc, v) => acc + v.qty, 0) + +baseOrder.origQty

      const sizes: Sizes = {
        base:
          (+baseOrder.origQty / totalOrders) *
          (toUse *
            (settings.profitCurrency === 'base' ? 1 : 1 / +baseOrder.price)),
        dca: orders.map(
          (o) =>
            (o.qty / totalOrders) *
            (toUse * (settings.profitCurrency === 'base' ? 1 : 1 / o.price)),
        ),
        origBase: +baseOrder.origQty,
        origDca: orders.map((o) => o.qty),
      }

      return sizes
    }
    /**
     * Open new deal
     */
    @IdMute(
      mutex,
      (botId: string, symbol: string) => `${botId}newDeal@${symbol}`,
    )
    async openNewDeal(
      _botId: string,
      symbol: string,
      skip = false,
      dynamic = false,
      time = 0,
      cbIfNotOpened?: () => void,
    ) {
      if (!this.loadingComplete) {
        this.runAfterLoadingQueue.push(() =>
          this.openNewDeal.bind(this)(
            this.botId,
            symbol,
            skip,
            dynamic,
            time,
            cbIfNotOpened,
          ),
        )
        return this.handleLog('Loading not complete yet')
      }
      if (!skip && this.data?.status === BotStatusEnum.monitoring) {
        this.handleDebug('Bot is in monitoring mode. Wont open new deal')
        if (cbIfNotOpened) {
          cbIfNotOpened()
        }
        return
      }
      const _id = this.startMethod('openNewDeal')
      const settings = await this.getAggregatedSettings()
      const t = this.openNewDealTimer.get(symbol)
      if (t) {
        clearTimeout(t)
        this.openNewDealTimer.delete(symbol)
      }
      if (!this.pairs.has(symbol)) {
        this.endMethod(_id)
        if (cbIfNotOpened) {
          cbIfNotOpened()
        }
        return this.handleDebug(`Bot settings does not contain ${symbol}`)
      }
      if (
        this.pairs.has(symbol) &&
        !(this.data?.settings.pair ?? []).includes(symbol)
      ) {
        this.endMethod(_id)
        if (cbIfNotOpened) {
          cbIfNotOpened()
        }
        return this.handleDebug(
          `Bot settings does not contain ${symbol}. Wont open new deal`,
        )
      }
      const ed = await this.getExchangeInfo(symbol)
      const skipRange = skip && !dynamic
      if (await this.checkMaxDeals(this.botId, symbol)) {
        this.handleLog(`Open new deal ${symbol}`)
        if (
          ed &&
          (skipRange || (await this.checkInRange(symbol))) &&
          this.data?.status !== BotStatusEnum.closed &&
          !(
            this.data?.status === BotStatusEnum.error &&
            this.data.previousStatus === BotStatusEnum.closed
          )
        ) {
          this.handleLog(
            `Bot status is ${this.data?.status}, close after tp ${this.closeAfterTpFilled}`,
          )
          let checkBalance = await this.checkBalance(symbol)
          if (!checkBalance.status) {
            this.handleDebug(
              `Not enough balance to start new deal. Required: ${checkBalance.required}, available: ${checkBalance.available}, repeat check in 5 seconds`,
            )
            await sleep(5000)
            checkBalance = await this.checkBalance(symbol)
          }
          if (checkBalance.status) {
            // The shortfall cleared — re-arm, so if it returns the user is told
            // again. Keyed on the balance condition alone; whether a deal
            // actually opens below (cooldowns can still decline) is a different
            // question.
            this.standingConditionLatch.clear(
              standingConditionKey(notEnoughBalanceNewDeal, symbol),
            )
            if (!(skip && !dynamic)) {
              const cooldownStart = await this.checkCooldownStart(
                this.botId,
                symbol,
              )
              if (!cooldownStart.status) {
                this.handleDebug(
                  `Deal must wait because of cooldown start check. Time: ${cooldownStart.time}, last opened: ${cooldownStart.last}, diff: ${cooldownStart.diff}, cooldown: ${cooldownStart.cooldown} ${symbol} ${settings.cooldownAfterDealStartOption}`,
                )
                this.resetPending(this.botId, symbol)
                if (settings.startCondition === StartConditionEnum.asap) {
                  this.openNewDealTimer.set(
                    symbol,
                    setTimeout(
                      () => this.openDealAfterTimer(),
                      cooldownStart.last +
                        cooldownStart.cooldown -
                        +new Date() -
                        1,
                    ),
                  )
                }
                this.endMethod(_id)
                if (cbIfNotOpened) {
                  cbIfNotOpened()
                }
                return
              }
              const cooldownStop = await this.checkCooldownStop(
                this.botId,
                symbol,
              )
              if (!cooldownStop.status) {
                this.handleDebug(
                  `Deal must wait because of cooldown stop check. Time: ${cooldownStop.time}, last closed: ${cooldownStop.last}, diff: ${cooldownStop.diff}, cooldown: ${cooldownStop.cooldown} ${symbol} ${settings.cooldownAfterDealStopOption}`,
                )
                if (settings.startCondition === StartConditionEnum.asap) {
                  this.openNewDealTimer.set(
                    symbol,
                    setTimeout(
                      () => this.openDealAfterTimer(),
                      cooldownStop.last +
                        cooldownStop.cooldown -
                        +new Date() -
                        1,
                    ),
                  )
                }
                this.resetPending(this.botId, symbol)
                this.endMethod(_id)
                if (cbIfNotOpened) {
                  cbIfNotOpened()
                }
                return
              }
            }
            let fixSl = 0
            let fixTp = 0
            let fixSize = 0
            if (
              this.data?.settings?.useRiskReward &&
              this.data.settings.type !== DCATypeEnum.terminal
            ) {
              const riskReward = await this.checkRiskRewardCondition(
                symbol,
                await this.getLatestPrice(symbol),
              )
              if (!riskReward) {
                this.resetPending(this.botId, symbol)
                this.endMethod(_id)
                if (cbIfNotOpened) {
                  cbIfNotOpened()
                }
                return
              }
              fixSl = riskReward.sl
              fixTp = riskReward.tp ?? 0
              fixSize = riskReward.size
            }
            let dynamicAr: DynamicArPrices[] = []
            if (this.scaleAr || this.tpAr || this.slAr) {
              const dynamic = this.getDynamicLevels(symbol)
              this.handleDebug(
                `Dynamic levels for ${symbol}: ${dynamic.length}, ${dynamic
                  .map((d) => `${d.id}: ${d.value}`)
                  .join(', ')}`,
              )
              if (!dynamic.length) {
                // Empty levels have two causes and only one is worth a user's
                // attention. Indicators that exist but have no history yet are
                // warming up and clear on their own — staying silent there is
                // deliberate. NO matching indicator at all is a broken config:
                // this bot cannot open a deal on any pair, ever, and until
                // Bug #463 it said nothing at all — the exit below is reached
                // after "Balance check skipped" with no error, no bot message
                // and no event, so the deal simply never appeared. Say so.
                if (!this.getDynamicArIndicators(symbol).length) {
                  const arMode =
                    settings.scaleDcaType === ScaleDcaTypeEnum.adr
                      ? 'ADR'
                      : 'ATR'
                  this.handleErrors(
                    this.scaleAr
                      ? `Cannot open deal for ${symbol}: DCA order spacing is set to scale on ${arMode}, but this bot has no ${arMode} indicator configured, so order levels cannot be calculated. Set "Base scaling on" back to Percentage, or re-select ${arMode} to restore the indicator.`
                      : `Cannot open deal for ${symbol}: deal close is set to dynamic ${arMode} levels, but this bot has no ${arMode} indicator configured, so those levels cannot be calculated.`,
                    'openNewDeal',
                    '',
                    false,
                    true,
                  )
                }
                this.resetPending(this.botId, symbol)
                this.endMethod(_id)
                if (cbIfNotOpened) {
                  cbIfNotOpened()
                }
                return
              }
              dynamicAr = dynamic
            }
            let sizes: Sizes | undefined | null
            if (this.useCompountReduce) {
              sizes = await this.calculateCompoundReduce(symbol)
            }
            this.updateDealLastTime(this.botId, 'opened', +new Date(), symbol)
            await this.placeBaseOrder(
              this.botId,
              symbol,
              undefined,
              undefined,
              undefined,
              undefined,
              fixSl,
              fixTp,
              fixSize,
              dynamicAr,
              sizes,
            )
          } else {
            const asset = this.futures
              ? this.coinm
                ? ed.baseAsset.name
                : ed.quoteAsset.name
              : settings.terminalDealType === TerminalDealTypeEnum.import
                ? this.isLong
                  ? ed.baseAsset.name
                  : ed.quoteAsset.name
                : this.isLong
                  ? ed.quoteAsset.name
                  : ed.baseAsset.name
            const msg = `Not enough balance to start new deal required: ${
              checkBalance.required
            } ${asset}, available: ${checkBalance.available} ${asset}${
              checkBalance.price
                ? `, price: ${checkBalance.price} ${ed.quoteAsset.name}`
                : ''
            }`
            // Report the shortfall once per (pair, condition) rather than on
            // every cycle. `openNewDeal` re-runs about once a minute and the
            // account balance behind the refusal does not change between runs,
            // so this was 8.3 M log lines and 56 % of all `botevents` written in
            // a day (spec 008). The latch keys on the CONDITION, not on `msg` —
            // `required`/`price` are recomputed from the live price every cycle,
            // so the text differs each time while the condition is identical.
            // Terminal deals are exempt: that is a one-shot the user just asked
            // for, it stops the bot below, and it must always be answered.
            if (
              settings.type === DCATypeEnum.terminal ||
              this.standingConditionLatch.shouldReport(
                standingConditionKey(notEnoughBalanceNewDeal, symbol),
                +new Date(),
              )
            ) {
              this.handleErrors(msg, 'openNewDeal', '', false, true)
            }
            this.resetPending(this.botId, symbol)
            if (cbIfNotOpened) {
              cbIfNotOpened()
            }
            if (settings.type === DCATypeEnum.terminal) {
              this.stop()
            }
          }
        } else {
          if (cbIfNotOpened) {
            cbIfNotOpened()
          }
          this.resetPending(this.botId, symbol)
        }
      } else {
        if (cbIfNotOpened) {
          cbIfNotOpened()
        }
      }
      this.endMethod(_id)
    }

    async convertSymbol(symbol?: string, checkOpen?: boolean) {
      if (symbol) {
        const [base, quote] = symbol.split('_')
        // The webhook contract documents `BASE_QUOTE`, but every pair
        // identifier the platform itself stores and renders is exchange-native
        // — compact on Binance (`AAVEUSDT`), dashed on KuCoin (`AAVE-USDT`) —
        // so users copy the pair straight out of their own bot settings and it
        // was rejected outright as "format is incorrect" (bug #463).
        // Accept those too, by comparing a separator-stripped form against the
        // bot's OWN configured pairs. This is not the suffix-guessing this
        // codebase forbids: the quote is never inferred, each candidate keeps
        // its explicit baseAsset/quoteAsset and we only match against a finite
        // known list. The canonical `val.pair` is always what gets returned, so
        // case-folding never leaks into the resolved symbol.
        const compact = (s: string) => s.replace(/[-_/]/g, '').toUpperCase()
        const wanted = compact(symbol)
        if (!wanted) {
          return this.handleErrors(
            `Symbol ${symbol} format is incorrect`,
            'openDealBySignal',
            '',
            false,
          )
        }
        // An exact BASE_QUOTE hit still wins and still short-circuits the scan;
        // the separator-insensitive hit is only a fallback, so every input that
        // resolves today resolves to exactly the same pair.
        let symbolToUse = ''
        let looseMatch = ''
        for (const p of this.pairs) {
          const val = await this.getExchangeInfo(p)
          if (!val) {
            continue
          }
          if (val.baseAsset.name === base && val.quoteAsset.name === quote) {
            symbolToUse = val.pair
            break
          }
          if (
            !looseMatch &&
            (wanted === compact(val.pair) ||
              wanted === compact(`${val.baseAsset.name}${val.quoteAsset.name}`))
          ) {
            looseMatch = val.pair
          }
        }
        if (!symbolToUse) {
          symbolToUse = looseMatch
        }
        if (!symbolToUse && checkOpen) {
          for (const val of this.getOpenDeals()) {
            const dealSymbol = val.deal.symbol
            if (
              (dealSymbol.baseAsset === base &&
                dealSymbol.quoteAsset === quote) ||
              wanted === compact(dealSymbol.symbol) ||
              wanted ===
                compact(`${dealSymbol.baseAsset}${dealSymbol.quoteAsset}`)
            ) {
              symbolToUse = dealSymbol.symbol
              break
            }
          }
        }
        if (symbolToUse === '' || !symbolToUse) {
          return this.handleErrors(
            `Symbol ${symbol} doesn't exist in bot settings`,
            'openDealBySignal',
            '',
            false,
          )
        }
        return symbolToUse
      }
    }
    /**
     * Open deal by signal if settings are specified
     */
    @IdMute(
      mutexOpenDealBySignal,
      (botId: string) => `${botId}openDealBySignal`,
    )
    public async openDealBySignal(
      _botId: string,
      _symbol?: string,
      ignoreSettings = false,
    ) {
      this.handleLog('Open new deal by signal')
      if (!this.loadingComplete) {
        this.runAfterLoadingQueue.push(() =>
          this.openDealBySignal.bind(this)(_botId, _symbol, ignoreSettings),
        )
        return this.handleLog('Loading not complete yet')
      }
      const settings = await this.getAggregatedSettings()
      let pairsToUse = await this.getSymbolsToOpenAsapDeals(false, true)
      if (_symbol) {
        const symbolToUse = await this.convertSymbol(_symbol)
        if (!symbolToUse) {
          return this.handleWarn(`Signal for ${_symbol} cannot be passed`)
        }
        if (!settings.pair?.includes(symbolToUse)) {
          return this.handleErrors(
            `Received signal for ${symbolToUse} but the pair is not in settings`,
            'openDealBySignal',
            '',
            false,
          )
        }
        if (symbolToUse && !pairsToUse.includes(symbolToUse)) {
          return this.handleErrors(
            `Received signal for ${symbolToUse} but didn't pass the volume filter`,
            'openDealBySignal',
            '',
            false,
          )
        }
        if (symbolToUse) {
          pairsToUse = [symbolToUse]
          this.handleDebug(`Received signal for ${symbolToUse}`)
        }
      }
      if (
        settings.startCondition === StartConditionEnum.tradingviewSignals ||
        ignoreSettings
      ) {
        for (const symbol of pairsToUse) {
          await this.openNewDeal(this.botId, symbol)
        }
      } else {
        this.handleDebug(
          `Only ${StartConditionEnum.tradingviewSignals} start condition can start deal by signals`,
        )
      }
    }
    /**
     * Close deal by signal if settings are specified
     */

    public async closeDealBySignal(
      _symbol?: string,
      ignoreSettings = false,
      sl = false,
    ) {
      this.handleLog(`Close by signal${_symbol ? ` symbol:${_symbol}` : ''}`)

      let settings = await this.getAggregatedSettings()
      if (this.data?.settings.type === DCATypeEnum.terminal) {
        const deal = this.getOpenDeals(true)?.[0]
        settings = await this.getAggregatedSettings(deal?.deal)
      }
      if (
        (settings.useTp &&
          settings.dealCloseCondition === CloseConditionEnum.webhook) ||
        (settings.useSl &&
          settings.dealCloseConditionSL === CloseConditionEnum.webhook) ||
        ignoreSettings
      ) {
        const symbol = await this.convertSymbol(_symbol, true)
        if (_symbol && !symbol) {
          return this.handleWarn(`Signal for ${symbol} cannot be passed`)
        }
        this.closeAllDeals(
          ignoreSettings
            ? CloseDCATypeEnum.closeByMarket
            : settings.dealCloseCondition === CloseConditionEnum.webhook
              ? settings.closeDealType
              : settings.dealCloseConditionSL === CloseConditionEnum.webhook
                ? CloseDCATypeEnum.closeByMarket
                : undefined,
          symbol ?? undefined,
          true,
          true,
          ignoreSettings,
          sl,
          undefined,
          DCACloseTriggerEnum.webhook,
        )
      }
    }
    /**
     * Check new order in array of placed/pending orders
     *
     * @param {Grid} n order to find
     * @param {TypeOrderEnum} type order type
     * @param {string} dealId Id of the deal
     * @returns {boolean} Indicates order exist or not
     */

    isOrderExistInDeal(n: Grid, type: TypeOrderEnum, dealId: string): boolean {
      if (this.orders && this.orders.size > 0) {
        const newOrder = Boolean(
          this.getOrdersByStatusAndDealId({
            defaultStatuses: true,
            dealId,
          }).find(
            (o) =>
              parseFloat(o.origPrice) === n.price &&
              o.side === n.side &&
              parseFloat(o.origQty) === n.qty &&
              o.typeOrder === type,
          ),
        )
        if (!newOrder) {
          const filled = this.getOrdersByStatusAndDealId({
            dealId,
            status: 'FILLED',
          }).find(
            (o) =>
              this.ordersInBetweenUpdates.has(o.clientOrderId) &&
              parseFloat(o.origPrice) === n.price &&
              o.side === n.side &&
              parseFloat(o.origQty) === n.qty &&
              o.typeOrder === type,
          )
          if (filled) {
            this.handleDebug(
              `Order, qty: ${n.qty}, price: ${n.price}, side: ${n.side}, type: ${type} doesn't exists in new, but already filled and not processed yet ${filled.clientOrderId}, skip place new order`,
            )
          }
          return !!filled
        }
        return newOrder
      }
      return false
    }
    /**
     * Place orders queue
     *
     * @param {string} dealId Id of the deal
     * @param {{new: Grid[], cancel: Grid[]}} orders Orders to cancel and place
     */

    @IdMute(
      mutex,
      (botId: string, _symbol: string, dealId: string) => `${botId}${dealId}`,
    )
    async placeOrders(
      _botId: string,
      symbol: string,
      dealId: string,
      orders: { new: Grid[]; cancel: Grid[] },
    ): Promise<void | Order> {
      const _id = this.startMethod('placeOrders')
      const deal = this.getDeal(dealId)
      // `symbol` arrives here in two different alphabets. Callers holding a
      // deal pass the platform pair (`ETH-EUR`); callers that take it off an
      // exchange ORDER pass whatever the venue calls it — on Kraken that is
      // `ETHEUR`, `XBTUSD`, `XRPUSD`. `getExchangeInfo` is keyed on the
      // platform form, so the order-derived spelling missed, `ed` came back
      // undefined, and this method returned before placing a single order.
      //
      // What that looked like in production: a Kraken DCA deal opened with NO
      // safety orders on the book at all. The ladder is built when the base
      // order fills and handed straight to this method as `orderBo.symbol`, so
      // it was dropped here every single time; it only ever reached the
      // exchange if something later reloaded the bot, because the restore path
      // passes the deal's own symbol instead. Silent by construction — a
      // handleWarn goes to the error log, not the bot's own timeline, and there
      // is no bot message, so the deal just ran unprotected. Visible every day
      // as `Exchange info not found for XBTUSD` / `XRPUSD`.
      //
      // Resolve from the deal, which is always the platform form. Every caller
      // passes a real `dealId`, so this is the normal path; the argument stays
      // as the fallback only for when the deal is not in memory to look up
      // (mid-restore, or an id that has already been released).
      //
      // Combo shares this method and had the same defect on two of its callers
      // (`order.symbol`, `orderBo.symbol` in comboHelper), so they are fixed by
      // the same line rather than needing their own.
      const pair = deal?.deal.symbol.symbol ?? symbol
      const ed = await this.getExchangeInfo(pair)
      if (!ed) {
        this.handleWarn(`Exchange info not found for ${pair}`)
        this.endMethod(_id)
        return
      }
      if (this.allowToPlaceOrders.get(dealId) === false) {
        this.handleLog(`Deal ${dealId} is not allowed to place orders`)
        this.endMethod(_id)
        return
      }
      if (deal?.closeBySl) {
        this.endMethod(_id)
        return this.handleLog(`Deal ${dealId} closing by SL. Skip place orders`)
      }
      if (deal?.closeBySl || deal?.closeByTp) {
        this.endMethod(_id)
        return this.handleLog(`Deal ${dealId} closing by TP. Skip place orders`)
      }
      const settings = await this.getAggregatedSettings(deal?.deal)
      if (this.data?.status === BotStatusEnum.error) {
        this.restoreFromRangeOrError()
      }
      if (this.exchange && this.data) {
        /**
         * Cancel all unnecessery orders, remove them from orders property
         */
        for (const order of orders.cancel.sort((a) =>
          a.type === TypeOrderEnum.dealTP ? -1 : 1,
        )) {
          const o = await this.cancelGridOnExchange(
            order,
            order.type === TypeOrderEnum.dealTP,
            false,
          )
          if (
            o?.status === 'FILLED' ||
            (o?.status === 'PARTIALLY_FILLED' &&
              o.typeOrder === TypeOrderEnum.dealTP)
          ) {
            await this.handleUnknownOrder(o)
            if (!o.tpSlTarget && this.botType !== BotType.combo) {
              this.endMethod(_id)
              return o
            }
          }
        }
        if (
          [
            ExchangeEnum.kucoin,
            ExchangeEnum.okx,
            ExchangeEnum.okxInverse,
            ExchangeEnum.okxLinear,
          ].includes(this.data.exchange)
        ) {
          await utils.sleep(300)
        }
        /**
         * Add new orders, add them to orders property
         */
        for (const order of [...orders.new]
          .sort(
            (a, b) =>
              Math.abs(a.price - (deal?.deal?.lastPrice ?? 0)) -
              Math.abs(b.price - (deal?.deal?.lastPrice ?? 0)),
          )
          .sort((a, b) =>
            a.type === TypeOrderEnum.dealTP
              ? 1
              : b.type === TypeOrderEnum.dealTP
                ? -1
                : 0,
          )) {
          if (
            deal &&
            (await this.isDealForTPLevelCheck(deal)) &&
            order.type === TypeOrderEnum.dealTP
          ) {
            this.handleDebug(
              `Deal ${deal.deal._id} close order is MARKET. Skip TP order placement`,
            )
            continue
          }
          if (this.stopList.has(order.newClientOrderId)) {
            this.handleLog(
              `Order in stop list ${order.newClientOrderId}, side - ${order.side}, price - ${order.price}, qty - ${order.qty}`,
            )
            this.stopList.delete(order.newClientOrderId)
            continue
          }
          if (
            (deal?.deal.action === ActionsEnum.useOppositeBalance ||
              settings.dcaByMarket) &&
            order.type === TypeOrderEnum.dealRegular
          ) {
            continue
          }
          if (order.minigridId) {
            this.pendingOrdersList.set(
              order.minigridId,
              (this.pendingOrdersList.get(order.minigridId) ?? []).filter(
                (o) => o.newClientOrderId !== order.newClientOrderId,
              ),
            )
          }
          const get = this.getOrderFromMap(order.newClientOrderId)
          if (get && get.status !== 'CANCELED') {
            this.handleLog(`Order duplicate: ${order.newClientOrderId}`)
            continue
          }
          if (!this.isOrderExistInDeal(order, order.type, dealId)) {
            if (order.type === TypeOrderEnum.dealTP) {
              // A take-profit that has already taken some size is still LIVE on
              // the venue and still locks its unfilled remainder, so the
              // replacement cannot be funded until it is cancelled. This lookup
              // used to ask for status 'NEW' only — which is exactly the status
              // such an order no longer has — so neither branch below could
              // fire and the replacement was sent on top of the live order.
              // Bug #694, deal 6a90e161a76e7fe63ea3118f (B3-USDC, Coinbase):
              // D-TP-TNTUX… sat PARTIALLY_FILLED 54,103 of 878,966 from
              // 2026-08-31 with no cancel line in nine days of logs, and every
              // replacement was refused `free 110,493 / required 934,119` —
              // 110,493 plus the 824,863 that order still held being the whole
              // wallet. The deal could not close.
              const tp = this.getOrdersByStatusAndDealId({
                dealId,
                status: ['NEW', 'PARTIALLY_FILLED'],
              }).filter((o) => o.typeOrder === TypeOrderEnum.dealTP)
              // Compare on what the resting order can still SELL, not on the
              // size it was created for. `getTPOrder` already subtracts the
              // executed part (via `tpHistory`) from the replacement it sizes,
              // so `origQty` and `order.qty` are two different measures the
              // moment a TP takes a partial fill. For a NEW order
              // `executedQty` is 0 and this is the original test.
              const restingTpQty = tp.length
                ? parseFloat(tp[0].origQty) -
                  (parseFloat(tp[0].executedQty) || 0)
                : 0
              if (
                tp.length > 0 &&
                restingTpQty < order.qty &&
                !settings.useMultiTp
              ) {
                this.handleLog(
                  `Deal already has a TP order with lower qty. Wait until cancel the order ${tp[0].clientOrderId}`,
                )
                // The fills on a TP we are cancelling in order to RE-SIZE it
                // are a partial take profit, not a close: `tpHistory` already
                // carries them and the venue's CANCELED event books anything
                // it does not (`processCanceledOrder`). Letting
                // `cancelOrderOnExchange` promote the cancel to FILLED would
                // send it to `closeDeal` and close the deal on whatever
                // fraction had sold — 6% of the position, in #694.
                //
                // The argument is the CALLER'S INTENT and is therefore a
                // constant: reaching this line means the deal has an open
                // position, a safety order just filled, and the only reason we
                // are cancelling is to send a bigger replacement. That is never
                // a close, whatever our own copy of the order happens to say.
                //
                // It used to be `!(parseFloat(tp[0].executedQty) > 0)`, and
                // that re-read the one field `cancelOrderOnExchange` overwrites
                // from the venue's response two statements before it consults
                // this flag — the guard computed from the pre-cancel snapshot,
                // the promotion decided from the post-cancel answer, and the
                // fill appearing in the window between them. It also could not
                // ever be usefully `true`: the flag is only reachable inside
                // `+order.executedQty !== 0`, by which point `executedQty` IS
                // the venue's number, so the condition was either ignored (the
                // venue reports no fills) or wrong. Bug #694 follow-up, spec
                // `007.tp-resize-cancel-must-never-promote`: on 2026-09-06 at
                // 07:13:22Z — 83 minutes after #694 shipped — a worker restart
                // rebuilt D-TP-EaREzp4M… from Redis without its 03:43 partial
                // fill, the venue answered the re-size cancel with `base: 6012`,
                // the deal was closed on those 6,012, and `buyRemainder` then
                // market-sold the remaining 159,944 TURBO 3.06% under the
                // 0.0010254 take-profit it had been waiting for.
                const result = await this.cancelOrderOnExchange(
                  tp[0],
                  true,
                  true,
                  false,
                )
                if (result && result.status === 'FILLED') {
                  this.handleUnknownOrder(result)
                  this.endMethod(_id)
                  return
                }
              }
              if (
                tp.length > 0 &&
                restingTpQty > order.qty &&
                !settings.useMultiTp
              ) {
                this.handleLog('Deal already has a TP order with higher qty')
                continue
              }
            }
            const result = await this.sendGridToExchange(
              order,
              {
                dealId,
                type: order.market ? 'MARKET' : 'LIMIT',
                reduceOnly: this.futures
                  ? (this.isLong && order.side === OrderSideEnum.sell) ||
                    (!this.isLong && order.side === OrderSideEnum.buy)
                  : undefined,
                positionSide: this.hedge
                  ? this.isLong
                    ? PositionSide.LONG
                    : PositionSide.SHORT
                  : PositionSide.BOTH,
              },
              ed,
            )
            if (result && result.status === 'FILLED') {
              this.processFilledOrder(result)
            }
          } else {
            this.handleLog(
              `Order already exist qty: ${order.qty}, price: ${order.price}, side: ${order.side}, type: ${order.type}`,
            )
          }
        }

        const dealAfter = this.getDeal(dealId)
        const tpAfter = this.getOrdersByStatusAndDealId({
          dealId,
          status: 'FILLED',
        }).find((o) => o.typeOrder === TypeOrderEnum.dealTP && !o.reduceFundsId)
        if (
          ((dealAfter && dealAfter.deal.status === DCADealStatusEnum.closed) ||
            (tpAfter && !settings.useMultiTp && !settings.useMultiSl)) &&
          !(
            this.data.settings.type === DCATypeEnum.terminal &&
            this.data.settings.terminalDealType === TerminalDealTypeEnum.simple
          )
        ) {
          const toCancel = this.getOrdersByStatusAndDealId({
            dealId,
            defaultStatuses: true,
          }).filter((o) =>
            [TypeOrderEnum.dealRegular, TypeOrderEnum.dealGrid].includes(
              o.typeOrder,
            ),
          )
          this.handleLog(
            `Deal ${dealId} was closed during place orders. Cancel orders: ${toCancel.length}`,
          )
          for (const order of toCancel) {
            await this.cancelOrderOnExchange(order, false)
          }
        }
      }
      this.endMethod(_id)
    }
    /**
     * Find base order for deal
     */

    findBaseOrderByDeal(dealId: string) {
      const safeDealId = `${dealId}`
      const findDeal = this.getDeal(safeDealId)
      if (findDeal && findDeal.deal.parent) {
        const dealOrders = this.getOrdersByStatusAndDealId({
          dealId: safeDealId,
          status: 'FILLED',
        }).filter((o) => o.typeOrder === TypeOrderEnum.dealStart)
        if (dealOrders && dealOrders.length > 0) {
          return {
            ...dealOrders[0],
            executedQty: `${dealOrders.reduce(
              (acc, v) => (acc += +v.executedQty),
              0,
            )}`,
            origQty: `${dealOrders.reduce((acc, v) => (acc += +v.origQty), 0)}`,
            price: `${findDeal.deal.initialPrice}`,
          }
        }
      }
      const bo = this.getOrdersByStatusAndDealId({
        dealId: safeDealId,
        status: ['CANCELED', 'FILLED'],
      })
        .filter(
          (o) =>
            o.typeOrder === TypeOrderEnum.dealStart &&
            (o.status === 'FILLED' || +o.executedQty > 0),
        )
        .sort((a, b) => a.updateTime - b.updateTime)
      if (bo?.length && findDeal) {
        return {
          ...bo[0],
          executedQty: `${bo.reduce((acc, v) => (acc += +v.executedQty), 0)}`,
          origQty: `${bo.reduce((acc, v) => (acc += +v.origQty), 0)}`,
          price: `${findDeal.deal.initialPrice}`,
        }
      }
    }
    /**
     * Get TP order
     */

    async getTPOrder(
      _symbol: string,
      _price: number,
      _initialOrders: Grid[],
      avgPrice: number,
      boPrice: number,
      dealId: string,
      deal?: ExcludeDoc<Deal>,
      aggregate = false,
      sl = false,
      price?: number,
    ) {
      if (this.data) {
        const ed = await this.getExchangeInfo(_symbol)
        if (!ed) {
          return
        }
        const settings = await this.getAggregatedSettings(deal)
        const { orderSizeType } = settings
        let fee = await this.getUserFee(_symbol)
        if (!fee) {
          return
        }
        // The venue's real fee, captured BEFORE the futures zeroing below.
        // The zeroing exists only for the QUANTITY leg — futures charge margin
        // in quote and never take the fee out of the position — but the TP/SL
        // PRICE still has to clear the round trip on futures. Keep the two
        // apart; see `./dca/tpFees`.
        const priceFee = fee
        if (this.futures) {
          fee = {
            maker: 0,
            taker: 0,
          }
        }
        const kucoinSpot = this.kucoinSpot && this.isLong
        const tpPerc = +(settings.tpPerc ?? '0') / 100
        const slPerc = +(settings.slPerc ?? '0') / 100
        const symbol = ed
        const baseOrderSize = +(settings.baseOrderSize ?? '0')
        const precision = await this.baseAssetPrecision(_symbol)
        const orders = this.getOrdersByStatusAndDealId({
          status: 'FILLED',
          dealId,
        })
        // A safety order that partially filled and was then CANCELED still
        // holds every unit the venue executed before the cancel — the cancel
        // only withdraws what was still resting. `findBaseOrderByDeal` has
        // always counted the BASE order that way (`['CANCELED','FILLED']` +
        // `executedQty > 0`); the safety orders were counted `FILLED`-only, so
        // each partially-filled-then-cancelled one under-stated the position by
        // whatever it had already executed.
        const filledOrders = [
          ...orders.filter((o) => o.typeOrder === TypeOrderEnum.dealRegular),
          ...this.getOrdersByStatusAndDealId({
            status: 'CANCELED',
            dealId,
          }).filter(
            (o) =>
              o.typeOrder === TypeOrderEnum.dealRegular && +o.executedQty > 0,
          ),
        ]
        // Reduce-funds TP orders are excluded on purpose: their quantity is
        // already subtracted below via `reduceFundsBase` (deal.reduceFunds is
        // appended on fill, see updateDeal dealTP/isReduce). Counting them here
        // too subtracted the same base twice, driving the TP qty negative on
        // deals that used reduce funds more than once.
        const filledCloseOrders = [
          ...orders.filter(
            (o) => o.typeOrder === TypeOrderEnum.dealTP && !o.reduceFundsId,
          ),
        ]
        const findDeal = this.getDeal(dealId)
        const pendingReduceFunds = findDeal
          ? this.getPendingReduceFunds(findDeal)
          : { base: 0, quote: 0 }
        const reduceFundsBase = (
          findDeal?.deal.reduceFunds ??
          ([] as unknown as NonNullable<Deal['reduceFunds']>)
        ).reduce((acc, v) => acc + v.qty, 0)
        const long = this.isLong
        // Hoisted above the base-order fallback: `add` is (negated) the gross
        // quantity this deal has ALREADY closed, and the fallback needs it to
        // turn `deal.size` — which is net of those closes — back into the gross
        // entry volume this sum is expressed in. It does not depend on `boQty`.
        const add =
          -(
            deal?.tpHistory ?? ([] as unknown as NonNullable<Deal['tpHistory']>)
          )
            .filter(
              (dh) =>
                !filledCloseOrders
                  .map((fco) => fco.clientOrderId)
                  .includes(dh.id),
            )
            .reduce((acc, d) => acc + d.qty, 0) -
          filledCloseOrders.reduce((acc, v) => acc + +v.executedQty, 0) -
          pendingReduceFunds.base -
          reduceFundsBase
        const filledQty = filledOrders.reduce(
          (acc, v) => acc + +v.executedQty,
          0,
        )
        const bo = this.findBaseOrderByDeal(dealId)
        const boFromOrder =
          parseFloat(bo?.executedQty || '0') ||
          parseFloat(bo?.origQty || '0') ||
          0
        const dealSize = Math.abs(findDeal?.deal.size ?? deal?.size ?? 0)
        const resolvedBo = resolveBaseOrderQty({
          boFromOrder,
          filledQty,
          dealSize,
          grossEntry: grossEntryVolume(dealSize, add, pendingReduceFunds.base),
          floor: (n) => this.math.round(n, precision, !this.futures),
        })
        let boQty = resolvedBo.qty
        if (resolvedBo.source === 'nominal') {
          // The deal holds nothing yet because its opening order has not landed,
          // so re-derive the base order from settings. `getBaseOrder` floors the
          // size it actually placed at `baseAsset.minAmount`; re-deriving without
          // that floor under-states a base order worth less than one step (bug
          // #423: $1 on krakenUsdm BTC-USD, step 0.0001 ≈ $6), and on futures —
          // where every "too small" guard below is gated `!this.futures` — it
          // rounds to 0 and we send the venue a zero-qty TP it can only reject
          // (`invalidArgument: 0`).
          //
          // Mirror `getBaseOrder`'s own conversion, including its DEFAULT: an
          // unset `orderSizeType` means QUOTE there, and reading it as a base
          // quantity here made the two disagree. `percFree`/`percTotal` are a
          // percentage of a live balance this method cannot see, so there is no
          // honest conversion — 0 leaves the `minAmount` floor, which
          // under-states the stopgap rather than asking the venue to sell a
          // percentage as if it were coins (a `percTotal` BTC deal rested a
          // 0.537 BTC take-profit against 0.105 BTC held).
          boQty = Math.max(
            orderSizeType === OrderSizeTypeEnum.base
              ? baseOrderSize
              : orderSizeType === OrderSizeTypeEnum.usd
                ? baseOrderSize /
                  ((await this.getUsdRate(_symbol, 'quote')) * boPrice)
                : orderSizeType === OrderSizeTypeEnum.percFree ||
                    orderSizeType === OrderSizeTypeEnum.percTotal
                  ? 0
                  : (baseOrderSize *
                      (this.coinm ? symbol.quoteAsset.minAmount : 1)) /
                    boPrice,
            symbol.baseAsset.minAmount,
          )
        }
        if (resolvedBo.source !== 'order') {
          // `nominal` is the routine case: every deal whose opening order has
          // not landed yet passes through it, ~650 lines/min across the fleet,
          // and it is the one with nothing to diagnose. The two that say
          // something about a deal's own books stay at log level. `dealId` is
          // empty for a deal that does not exist yet, which is most of them.
          const line = `Deal ${dealId || '(new)'} has no base order on record, base order qty ${boQty} taken from ${resolvedBo.source} (size ${dealSize}, counted fills ${filledQty})`
          if (resolvedBo.source === 'nominal') {
            this.handleDebug(line)
          } else {
            this.handleLog(line)
          }
        }
        boQty = this.math.round(boQty, precision, !this.futures)
        const _qty = filledQty + boQty
        const maxFee = worstFee(fee)
        // The mirror of the base order's gross-up (bug #396): closing a LONG
        // SELLS base, so it sells `gross * (1 - fee)` — one fee less than the
        // entry bought. Closing a SHORT BUYS base back and that buy is itself
        // charged in base, so buying `_qty` credits only `_qty * (1 - fee)` and
        // the deal ends a fee short of base every cycle; buy `_qty / (1 - fee)`
        // so the fill returns the full amount sold. `add` (already-closed qty)
        // is gross on both sides, so it keeps composing correctly for partial
        // take profits.
        //
        // ⚠️ This used to be justified as "on SPOT the fee is taken out of the
        // asset received, so only what the entry credited can be sold". That
        // premise is venue-specific and is false on Kraken, where a BUY defaults
        // to `fciq` (fee in quote) and credits the FULL quantity. The `1 - fee`
        // here is still correct on Kraken, because its SELL defaults to `fcib`
        // and takes the close's fee in base — leaving the entry's extra fee
        // worth of base as exactly the headroom that pays for it. See the long
        // note on `feeFactor` in `createOrder` before changing either side; they
        // are one mechanism and only balance as a pair.
        let qty =
          _qty * (this.futures ? 1 : long ? 1 - maxFee : 1 / (1 - maxFee)) + add
        let origQty = qty
        const priceDisplacement = tpPriceDisplacement(priceFee, long)
        let tpPrice = this.math.round(
          settings.useFixedTPPrices && settings.fixedTpPrice
            ? +settings.fixedTpPrice
            : (price ??
                avgPrice *
                  (1 + (long ? 1 : -1) * (sl ? slPerc : tpPerc)) *
                  (settings.useFixedTPPrices ? 1 : priceDisplacement)),
          symbol.priceAssetPrecision,
        )
        if (tpPrice === avgPrice) {
          tpPrice = this.math.round(
            avgPrice +
              (this.isLong ? 1 : -1) *
                Number(`${1}e-${symbol.priceAssetPrecision}`),
            symbol.priceAssetPrecision,
          )
        }
        tpPrice = this.math.round(tpPrice, ed.priceAssetPrecision)
        if (this.combo) {
          if (findDeal) {
            this.updateDealBalances(findDeal)
          }
          const _deal = this.getDeal(dealId)?.deal || deal
          qty =
            (this.isLong
              ? (await this.profitBase(_deal))
                ? Math.min(
                    _deal?.currentBalances.base ?? qty,
                    ((_deal?.initialBalances.quote ?? qty) -
                      (_deal?.currentBalances.quote ?? qty)) /
                      ((_price || _deal?.avgPrice) ?? 1),
                  )
                : (_deal?.currentBalances.base ?? qty)
              : (await this.profitBase(_deal))
                ? (_deal?.currentBalances.quote ?? qty) /
                  ((_price || _deal?.avgPrice) ?? 1)
                : (_deal?.initialBalances.base ?? 0) -
                  (_deal?.currentBalances.base ?? 0)) +
            (this.isLong
              ? Math.max(
                  0,
                  this.kucoinSpot &&
                    this.data?.flags?.includes(BotFlags.kucoinNewFee) &&
                    _deal
                    ? (_deal?.feeBalance ?? 0) / _deal.initialPrice
                    : (_deal?.feeBalance ?? 0),
                )
              : 0)
          origQty = qty
          const filled = this.getOrdersByStatusAndDealId({
            status: ['FILLED', 'CANCELED', 'PARTIALLY_FILLED'],
            dealId,
          }).filter(
            (o) =>
              o.side === (this.isLong ? 'BUY' : 'SELL') &&
              (this.data?.exchange === ExchangeEnum.bybit
                ? +o.executedQty !== 0
                : o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED'),
          )
          const f = filled.reduce((acc, v) => acc + +v.executedQty * maxFee, 0)
          qty -= f
          if (qty < symbol.baseAsset.minAmount && !this.futures) {
            this.handleDebug(
              `Order amount less than base min amount. ${qty} qty, ${symbol.baseAsset.minAmount} base min`,
            )
            return []
          }
          if (qty * tpPrice < symbol.quoteAsset.minAmount && !this.futures) {
            this.handleDebug(
              `Order amount less than quote min amount. ${qty * tpPrice} qty, ${
                symbol.quoteAsset.minAmount
              } quote min`,
            )
            return []
          }
        }
        const tpOrder: Grid = {
          qty: this.math.round(
            qty,
            precision,
            this.futures || kucoinSpot || (this.zeroFee && !this.combo)
              ? false
              : true,
          ),
          price: tpPrice,
          side: this.isLong ? OrderSideEnum.sell : OrderSideEnum.buy,
          newClientOrderId: this.getOrderId(`D-TP`),
          number: 0,
          type: TypeOrderEnum.dealTP,
          dealId,
        }
        if (
          this.tpAr &&
          !sl &&
          settings.dealCloseCondition === CloseConditionEnum.dynamicAr &&
          settings.useTp &&
          deal
        ) {
          const indicator = this.data.settings.indicators.find(
            (ind) =>
              (ind.type === IndicatorEnum.atr ||
                ind.type === IndicatorEnum.adr) &&
              ind.indicatorAction === IndicatorAction.closeDeal &&
              ind.section !== IndicatorSection.sl,
          )
          if (indicator) {
            let value = (deal.dynamicAr ?? []).find(
              (d) => d.id === indicator.uuid,
            )?.value
            if (value && !isNaN(value) && isFinite(value)) {
              value *= +(indicator.dynamicArFactor || '1')
              tpOrder.price = this.math.round(
                avgPrice + value * (this.isLong ? 1 : -1),
                symbol?.priceAssetPrecision ?? 8,
              )
            }
          }
        }
        if (
          this.slAr &&
          sl &&
          settings.dealCloseConditionSL === CloseConditionEnum.dynamicAr &&
          settings.useSl &&
          deal
        ) {
          const indicator = this.data.settings.indicators.find(
            (ind) =>
              (ind.type === IndicatorEnum.atr ||
                ind.type === IndicatorEnum.adr) &&
              ind.indicatorAction === IndicatorAction.closeDeal &&
              ind.section === IndicatorSection.sl,
          )
          if (indicator) {
            let value = (deal.dynamicAr ?? []).find(
              (d) => d.id === indicator.uuid,
            )?.value
            if (value && !isNaN(value) && isFinite(value)) {
              value *= +(indicator.dynamicArFactor || '1')
              tpOrder.price = this.math.round(
                avgPrice + value * (this.isLong ? -1 : 1),
                symbol?.priceAssetPrecision ?? 8,
              )
            }
          }
        }
        let qtyBase = tpOrder.qty
        if ((await this.profitBase(deal)) && this.botType !== BotType.combo) {
          const hasNewRevTp = deal?.tags?.includes('TPrev150925')
          let qtyNew = this.math.round(
            (((long && !this.futures && hasNewRevTp ? _qty + add : origQty) *
              avgPrice) /
              tpOrder.price) *
              (long && !this.futures && hasNewRevTp ? 1 : 1 - maxFee),
            precision,
            !this.futures,
          )
          qtyBase = qtyNew
          if (
            !this.isLong &&
            !this.futures &&
            deal &&
            settings.useMultiTp &&
            !aggregate
          ) {
            const nqtyNew = Math.min(
              qtyNew,
              this.math.round(
                (deal?.currentBalances.quote ?? 0) / avgPrice,
                precision,
                !this.futures,
              ),
            )
            if (!isNaN(nqtyNew) && isFinite(nqtyNew) && nqtyNew > 0) {
              qtyNew = nqtyNew
            }
          }
          const startPrice =
            +(bo?.price || 0) ||
            +(bo?.origPrice || 0) ||
            +(deal?.initialPrice || 0)
          if (this.coinm && !this.isBitget && startPrice) {
            const contracts = Math.max(
              1,
              this.math.round(
                (filledOrders.reduce(
                  (acc, v) => acc + +v.executedQty * +v.price,
                  0,
                ) +
                  boQty * startPrice -
                  (
                    deal?.tpHistory ??
                    ([] as unknown as NonNullable<Deal['tpHistory']>)
                  )
                    .filter(
                      (dh) =>
                        !filledCloseOrders
                          .map((fco) => fco.clientOrderId)
                          .includes(dh.id),
                    )
                    .reduce((acc, d) => acc + d.qty * d.price, 0) -
                  filledCloseOrders.reduce(
                    (acc, v) => acc + +v.executedQty * +v.origQty,
                    0,
                  ) -
                  pendingReduceFunds.base * pendingReduceFunds.quote -
                  (
                    findDeal?.deal.reduceFunds ??
                    ([] as unknown as NonNullable<Deal['reduceFunds']>)
                  ).reduce((acc, v) => acc + v.qty * v.price, 0)) /
                  (ed?.quoteAsset.minAmount ?? 1),
                0,
              ),
            )
            if (!isNaN(contracts) && isFinite(contracts)) {
              const cqtyNew = this.math.round(
                (contracts * (ed?.quoteAsset.minAmount ?? 1)) / tpOrder.price,
                precision,
                true,
              )
              if (cqtyNew > 0 && !isNaN(cqtyNew) && isFinite(cqtyNew)) {
                qtyNew = cqtyNew
              }
            }
          }
          tpOrder.qty = this.coinm
            ? qtyNew
            : this.isLong
              ? Math.min(tpOrder.qty, qtyNew)
              : sl
                ? Math.min(tpOrder.qty, qtyNew)
                : Math.max(tpOrder.qty, qtyNew)
        }
        if (tpOrder.qty < symbol.baseAsset.minAmount && !this.futures) {
          tpOrder.qty = symbol.baseAsset.minAmount
        }
        if (
          tpOrder.price * tpOrder.qty < symbol.quoteAsset.minAmount &&
          !this.futures &&
          !settings.useFixedTPPrices
        ) {
          if (this.isLong) {
            tpOrder.price = this.math.round(
              symbol.quoteAsset.minAmount / tpOrder.qty,
              symbol.priceAssetPrecision,
              false,
              true,
            )
          } else {
            tpOrder.qty = this.math.round(
              symbol.quoteAsset.minAmount / tpOrder.price,
              precision,
              false,
              true,
            )
          }
        }
        try {
          const mod = +new Big(tpOrder.qty)
            .mod(symbol.baseAsset.step)
            .toFixed(20)
          if (mod !== 0) {
            tpOrder.qty = this.math.round(
              tpOrder.qty - mod + symbol.baseAsset.step,
              precision,
              true,
            )
          }
        } catch (e) {
          this.handleErrors(
            `Big number error ${(e as Error).message || e}`,
            'getTPOrder',
            '',
            false,
            false,
            false,
          )
        }
        this.handleDebug(
          `TP order. Base order size: ${boQty}, qty: ${tpOrder.qty}, origQty: ${origQty}, qtyBase: ${qtyBase}, price: ${tpOrder.price}`,
        )
        let tpOrders = [tpOrder]
        if (aggregate) {
          return tpOrders
        }
        if (!sl && settings.useMultiTp) {
          let restQty = tpOrder.qty
          let end = false
          tpOrders = []
          const usedTp = (settings.multiTp ?? [])
            .filter((mtp) =>
              ((deal?.tpSlTargetFilled ?? []) as string[]).includes(mtp.uuid),
            )
            .reduce((acc, tp) => acc + +tp.amount, 0)
          ;(settings.multiTp ?? [])
            .filter(
              (tp) =>
                !((deal?.tpSlTargetFilled ?? []) as string[]).includes(tp.uuid),
            )
            .sort((a, b) => +a.target - +b.target)
            .map((tp) => {
              if (end || deal?.tpSlTargetFilled?.includes(tp.uuid)) {
                return null
              }
              let price = this.math.round(
                tp.fixed && settings.useFixedTPPrices
                  ? +tp.fixed
                  : avgPrice *
                      (1 + (long ? 1 : -1) * (+tp.target / 100)) *
                      (settings.useFixedTPPrices ? 1 : priceDisplacement),
                symbol.priceAssetPrecision,
              )
              if (price === avgPrice) {
                price = this.math.round(
                  avgPrice +
                    (this.isLong ? 1 : -1) *
                      Number(`${1}e-${symbol.priceAssetPrecision}`),
                  symbol.priceAssetPrecision,
                )
              }
              price = this.math.round(price, ed.priceAssetPrecision)

              let qty = this.math.round(
                tpOrder.qty * (+tp.amount / (100 - usedTp)),
                precision,
                true,
              )
              if (qty > restQty) {
                qty = this.math.round(restQty, precision, true)
              }
              if (qty < symbol.baseAsset.minAmount) {
                qty = this.math.round(
                  symbol.baseAsset.minAmount,
                  precision,
                  true,
                )
              }
              if (
                price * qty < symbol.quoteAsset.minAmount &&
                !this.futures &&
                !settings.useFixedTPPrices
              ) {
                const newQty = this.math.round(
                  symbol.quoteAsset.minAmount / price,
                  precision,
                  true,
                )
                const quote = newQty * price
                if (qty === newQty || quote < symbol.quoteAsset.minAmount) {
                  price = this.math.round(
                    symbol.quoteAsset.minAmount / qty,
                    symbol.priceAssetPrecision,
                    false,
                    true,
                  )
                  if (quote < symbol.quoteAsset.minAmount) {
                    qty = newQty
                  }
                } else {
                  qty = newQty
                }
              }
              try {
                const modQty = +new Big(qty)
                  .mod(symbol.baseAsset.step)
                  .toFixed(20)
                if (modQty !== 0) {
                  qty = this.math.round(
                    qty - modQty + symbol.baseAsset.step,
                    precision,
                    true,
                  )
                }
              } catch (e) {
                this.handleErrors(
                  `Big number error ${(e as Error).message || e}`,
                  'getTPOrder',
                  'multi tp',
                  false,
                  false,
                  false,
                )
              }
              restQty -= qty
              if (
                restQty < symbol.baseAsset.minAmount ||
                restQty * price < symbol.quoteAsset.minAmount ||
                restQty < 0
              ) {
                end = true
                qty =
                  restQty > 0 && restQty > symbol.baseAsset.step
                    ? this.math.round(qty + restQty, precision, true)
                    : qty
              }
              return {
                ...tpOrder,
                qty,
                price,
                newClientOrderId: this.getOrderId(`D-MTP`),
                tpSlTarget: tp.uuid,
              }
            })
            .forEach((o) => {
              if (o) {
                tpOrders.push(o)
              }
            })
        }
        if (
          sl &&
          settings.useMultiSl &&
          settings.dealCloseConditionSL === CloseConditionEnum.tp
        ) {
          let restQty = tpOrder.qty
          let end = false
          tpOrders = []
          const usedSl = (settings.multiSl ?? [])
            .filter((mtp) =>
              ((deal?.tpSlTargetFilled ?? []) as string[]).includes(mtp.uuid),
            )
            .reduce((acc, tp) => acc + +tp.amount, 0)
          ;(settings.multiSl ?? [])
            .filter(
              (tp) =>
                !((deal?.tpSlTargetFilled ?? []) as string[]).includes(tp.uuid),
            )
            .sort((a, b) => +b.target - +a.target)
            .map((tp) => {
              if (end || deal?.tpSlTargetFilled?.includes(tp.uuid)) {
                return null
              }
              let price = this.math.round(
                tp.fixed && settings.useFixedSLPrices
                  ? +tp.fixed
                  : avgPrice *
                      (1 + (long ? 1 : -1) * (+tp.target / 100)) *
                      (settings.useFixedSLPrices ? 1 : priceDisplacement),
                symbol.priceAssetPrecision,
              )
              if (price === avgPrice) {
                price = this.math.round(
                  avgPrice +
                    (this.isLong ? 1 : -1) *
                      Number(`${1}e-${symbol.priceAssetPrecision}`),
                  symbol.priceAssetPrecision,
                )
              }
              price = this.math.round(price, ed.priceAssetPrecision)

              let qty = this.math.round(
                tpOrder.qty * (+tp.amount / (100 - usedSl)),
                precision,
                true,
              )
              if (qty > restQty) {
                qty = this.math.round(restQty, precision, true)
              }
              if (qty < symbol.baseAsset.minAmount) {
                qty = this.math.round(
                  symbol.baseAsset.minAmount,
                  precision,
                  true,
                )
              }
              if (
                price * qty < symbol.quoteAsset.minAmount &&
                !this.futures &&
                !settings.useFixedSLPrices
              ) {
                const newQty = this.math.round(
                  symbol.quoteAsset.minAmount / price,
                  precision,
                  true,
                )
                const quote = newQty * price
                if (qty === newQty || quote < symbol.quoteAsset.minAmount) {
                  price = this.math.round(
                    symbol.quoteAsset.minAmount / qty,
                    symbol.priceAssetPrecision,
                    false,
                    true,
                  )
                  if (quote < symbol.quoteAsset.minAmount) {
                    qty = newQty
                  }
                } else {
                  qty = newQty
                }
              }
              try {
                const modQty = +new Big(qty)
                  .mod(symbol.baseAsset.step)
                  .toFixed(20)
                if (modQty !== 0) {
                  qty = this.math.round(
                    qty - modQty + symbol.baseAsset.step,
                    precision,
                    true,
                  )
                }
              } catch (e) {
                this.handleErrors(
                  `Big number error ${(e as Error).message || e}`,
                  'getTPOrder',
                  'multi sl',
                  false,
                  false,
                  false,
                )
              }
              restQty -= qty
              if (
                restQty < symbol.baseAsset.minAmount ||
                restQty * price < symbol.quoteAsset.minAmount ||
                restQty < 0
              ) {
                end = true
                qty =
                  restQty > 0 && restQty > symbol.baseAsset.step
                    ? this.math.round(qty + restQty, precision, true)
                    : qty
              }

              return {
                ...tpOrder,
                qty,
                price,
                newClientOrderId: this.getOrderId(`D-MSL`),
                tpSlTarget: tp.uuid,
                sl,
              }
            })
            .forEach((o) => {
              if (o) {
                tpOrders.push(o)
              }
            })
        }
        return tpOrders
      }
    }
    /** Get balance perc qty */

    async getBalancePercQty(
      orderSizeType: OrderSizeTypeEnum,
      orderSize: number,
      dealId: string,
      symbol: string,
    ) {
      let balanceUseQty: number | undefined = 0
      if (this.exchange) {
        const long = this.isLong
        const safeDealId = `${dealId}`
        const d = this.getDeal(safeDealId)

        balanceUseQty = d?.deal.balanceStart || 0
        if (!balanceUseQty) {
          const balances = await this.getBalancesFromExchange()
          if (!balances || balances.status === StatusEnum.notok) {
            this.handleErrors(
              `Error getting user balances: ${balances?.reason}`,
              'create intial orders',
              'get balance for % qty',
            )
          }
          if (balances && balances.status === StatusEnum.ok) {
            const ed = await this.getExchangeInfo(symbol)
            if (ed) {
              const asset = this.futures
                ? this.coinm
                  ? ed.baseAsset.name
                  : ed.quoteAsset.name
                : ed[long ? 'quoteAsset' : 'baseAsset'].name
              const findBalance = balances.data.find((b) => b.asset === asset)
              if (!findBalance) {
                this.handleErrors(`Balances not found`, 'create intial orders')
              } else {
                balanceUseQty =
                  orderSizeType === OrderSizeTypeEnum.percFree
                    ? findBalance.free
                    : findBalance.free + findBalance.locked
              }
            }
          }
        }
        if (balanceUseQty) {
          balanceUseQty = (balanceUseQty as number) * (orderSize / 100)
          if (this.futures) {
            ;(balanceUseQty as number) *= await this.getLeverageMultipler(
              d?.deal,
            )
          }
          if (safeDealId !== '') {
            const d = this.getDeal(safeDealId)
            if (d) {
              d.deal.settings.orderSizePercQty = balanceUseQty
              this.saveDeal(d, {
                'settings.orderSizePercQty': d.deal.settings.orderSizePercQty,
              })
            }
          }
        }
      }
      return balanceUseQty ?? 0
    }
    /** Getter for deal initial orders */

    getDealInitialOrders(dealId: string) {
      return this.getDeal(`${dealId}`)?.initialOrders ?? []
    }
    /** Aggregate breakpoint */

    async aggregateBreakpoint(
      breakpoint: { price: number; displacedPrice: number },
      deal: ExcludeDoc<Deal>,
    ) {
      const settings = await this.getAggregatedSettings(deal)
      if (
        settings.dcaCondition === DCAConditionEnum.indicators ||
        settings.dcaByMarket
      ) {
        return deal.gridBreakpoints
      }
      const findBreakpoint = deal.gridBreakpoints?.find(
        (db) => db.displacedPrice === breakpoint.price,
      )
      if (findBreakpoint) {
        breakpoint.price = findBreakpoint.price
      }
      deal.gridBreakpoints = [
        ...(deal.gridBreakpoints ?? []).filter(
          (b) => b.price !== breakpoint.price,
        ),
        breakpoint,
      ]
      this.handleDebug(
        `Breakpoint created. Current price ${breakpoint.price}, next order price ${breakpoint.displacedPrice}.`,
      )
      return deal.gridBreakpoints
    }
    /**
     * Create initial deal orders
     *
     * @param {number} price Price from which to start
     * @param {string} dealId Id of the deal
     * @returns {Grid[]} Orders calculated for initial price
     */

    async createInitialDealOrders(
      _symbol: string,
      price: number,
      dealId: string,
      deal?: ExcludeDoc<Deal>,
      _price?: number,
    ): Promise<Grid[]> {
      this.handleLog('Generate initial deal orders')
      const ed = await this.getExchangeInfo(_symbol)
      if (this.data && ed) {
        const settings = await this.getAggregatedSettings(deal)
        const { orderSizeType } = settings
        const symbol = ed
        const _orderSize = +(settings.orderSize ?? '0')
        const baseOrderSize = +(settings.baseOrderSize ?? '0')
        const tpPerc = +(settings.tpPerc ?? '0') / 100
        const precision = await this.baseAssetPrecision(_symbol)
        const step = +(settings.step ?? '1') / 100
        const stepScale = +(settings.stepScale ?? '1')
        const minimumDeviation = +(settings.minimumDeviation ?? '0') / 100
        const volumeScale = +(settings.volumeScale ?? '1')
        const latestPrice = this.math.round(price, symbol.priceAssetPrecision)
        // getLatestPrice() returns 0 when the exchange call fails, and callers
        // pass that straight through. Without this bail baseQty becomes
        // Infinity (baseOrderSize / 0), new Big() throws "Invalid number" and
        // we still return a bogus TP order with an Infinity qty.
        if (!latestPrice || !Number.isFinite(latestPrice)) {
          this.handleErrors(
            `Latest price is 0`,
            'createInitialDealOrders',
            'Get latest price',
            false,
            false,
            false,
          )
          return []
        }
        const useDca = settings.useDca
        const ordersSide = this.isLong ? OrderSideEnum.buy : OrderSideEnum.sell
        const scaleAr = this.scaleAr && settings?.useDca
        const bo = this.findBaseOrderByDeal(dealId)
        let baseQty =
          parseFloat(bo?.origQty || '0') ||
          (orderSizeType === OrderSizeTypeEnum.quote
            ? (baseOrderSize * (this.coinm ? ed.quoteAsset.minAmount : 1)) /
              latestPrice
            : baseOrderSize)
        const baseQtyOrig = baseQty
        baseQty = this.math.round(baseQty, precision, true)
        let tpPrice = this.math.round(
          latestPrice * (1 + (this.isLong ? 1 : -1) * tpPerc),
          symbol.priceAssetPrecision,
        )
        if (tpPrice === latestPrice) {
          tpPrice = this.math.round(
            latestPrice +
              (this.isLong ? 1 : -1) *
                Number(`${1}e-${symbol.priceAssetPrecision}`),
            symbol.priceAssetPrecision,
          )
        }
        tpPrice = this.math.round(tpPrice, ed.priceAssetPrecision)
        const tpOrder: Grid = {
          qty: baseQty,
          price: tpPrice,
          side: this.isLong ? OrderSideEnum.sell : OrderSideEnum.buy,
          newClientOrderId: this.getOrderId(`D-TP`),
          number: 0,
          type: TypeOrderEnum.dealTP,
          dealId,
        }
        if (await this.profitBase(deal)) {
          const qty = this.math.round(
            (baseQtyOrig * latestPrice) / tpOrder.price,
            precision,
          )
          tpOrder.qty = this.isLong
            ? Math.min(tpOrder.qty, qty)
            : Math.max(tpOrder.qty, qty)
        }
        if (tpOrder.qty < symbol.baseAsset.minAmount) {
          tpOrder.qty = this.math.round(
            symbol.baseAsset.minAmount,
            precision,
            false,
            true,
          )
        }
        if (
          tpOrder.price * tpOrder.qty < symbol.quoteAsset.minAmount &&
          !this.coinm
        ) {
          tpOrder.qty = this.math.round(
            symbol.quoteAsset.minAmount / tpOrder.price,
            precision,
            false,
            true,
          )
        }
        try {
          const mod = +new Big(tpOrder.qty)
            .mod(symbol.baseAsset.step)
            .toFixed(20)
          if (mod !== 0) {
            tpOrder.qty = this.math.round(
              tpOrder.qty - mod + symbol.baseAsset.step,
              precision,
              false,
              true,
            )
          }
        } catch (e) {
          this.handleErrors(
            `Big number error ${(e as Error).message || e}`,
            'createInitialDealOrders',
            '',
            false,
            false,
            false,
          )
        }
        const gridStep = latestPrice * step
        const minGridStep =
          settings.dcaCondition === DCAConditionEnum.percentage &&
          (settings.scaleDcaType === ScaleDcaTypeEnum.atr ||
            settings.scaleDcaType === ScaleDcaTypeEnum.adr)
            ? latestPrice * minimumDeviation
            : 0
        const orders: Grid[] = []
        if (useDca) {
          const breakpoints = deal?.gridBreakpoints ?? []
          const long = this.isLong
          let balanceUseQty = 0

          const ordersCount =
            settings.dcaCondition === DCAConditionEnum.indicators
              ? (settings.indicators ?? []).filter(
                  (i) => i.indicatorAction === IndicatorAction.startDca,
                ).length
              : settings.dcaCondition === DCAConditionEnum.custom
                ? (settings.dcaCustom ?? []).length
                : parseInt(`${settings.ordersCount}`)
          const useVolumeChange =
            settings.dcaVolumeBaseOn === DCAVolumeType.change &&
            settings.useTp &&
            settings.dealCloseCondition === CloseConditionEnum.tp &&
            settings.tpPerc &&
            !settings.useMultiTp &&
            ![OrderSizeTypeEnum.percFree, OrderSizeTypeEnum.percTotal].includes(
              settings.orderSizeType ?? OrderSizeTypeEnum.percFree,
            )
          const volumeChangeValue =
            +(settings.dcaVolumeRequiredChange ?? tpPerc * 100) *
            (long ? 1 + Math.min(0.02, tpPerc) : 1 - Math.min(0.02, tpPerc))
          let maxVolumeSize = +(settings.dcaVolumeMaxValue ?? '-1')
          if (maxVolumeSize < 0) {
            maxVolumeSize = Infinity
          }
          for (let i = 1; i <= (ordersCount ?? 0); i++) {
            if (scaleAr && deal && !deal.dynamicAr?.length) {
              continue
            }
            const stepVal =
              settings.dcaCondition === DCAConditionEnum.indicators ||
              settings.dcaCondition === DCAConditionEnum.custom
                ? 1
                : stepScale ** (i - 1)
            const volumeVal =
              settings.dcaCondition === DCAConditionEnum.indicators ||
              settings.dcaCondition === DCAConditionEnum.custom ||
              useVolumeChange
                ? 1
                : volumeScale ** (i - 1)
            let price = this.math.round(
              (i === 1
                ? latestPrice
                : (orders[orders.length - 1]?.price ?? 0)) -
                (this.isLong ? 1 : -1) * gridStep * stepVal,
              symbol.priceAssetPrecision,
            )
            if (settings.dcaCondition === DCAConditionEnum.indicators) {
              const indicatorValue =
                +(
                  (settings.indicators ?? []).filter(
                    (ind) => ind.indicatorAction === IndicatorAction.startDca,
                  )[i - 1]?.minPercFromLast ?? '100'
                ) / 100
              price = this.math.round(
                (i === 1
                  ? latestPrice
                  : (orders[orders.length - 1]?.price ?? 0)) *
                  (settings.strategy === StrategyEnum.long
                    ? 1 - indicatorValue
                    : 1 + indicatorValue),
                symbol.priceAssetPrecision,
              )
            }
            if (settings.dcaCondition === DCAConditionEnum.custom) {
              const dcaCustomValue =
                +((settings.dcaCustom ?? [])[i - 1]?.step ?? '1') / 100
              price = this.math.round(
                (i === 1
                  ? latestPrice
                  : (orders[orders.length - 1]?.price ?? 0)) *
                  (settings.strategy === StrategyEnum.long
                    ? 1 - dcaCustomValue
                    : 1 + dcaCustomValue),

                symbol.priceAssetPrecision,
              )
            }
            if (scaleAr) {
              const indicator = (settings.indicators ?? []).find(
                (ind) => ind.indicatorAction === IndicatorAction.startDca,
              )
              if (indicator) {
                let value = (deal?.dynamicAr ?? []).find(
                  (d) => d.id === indicator.uuid,
                )?.value
                if (value && !isNaN(value) && isFinite(value)) {
                  const stepAr = i < 2 ? 1 : stepScale ** (i - 2)
                  value *= +(indicator.dynamicArFactor || '1') * stepAr
                  const lastPrice =
                    i === 1
                      ? latestPrice
                      : (orders[orders.length - 1]?.price ?? 0)
                  price = this.math.round(
                    lastPrice +
                      value *
                        (settings.strategy === StrategyEnum.long ? -1 : 1),
                    symbol.priceAssetPrecision,
                  )
                  const priceMinDeviation = minGridStep
                    ? this.math.round(
                        lastPrice +
                          (settings.strategy === StrategyEnum.long ? -1 : 1) *
                            minGridStep *
                            stepVal,
                        symbol.priceAssetPrecision,
                      )
                    : 0
                  if (priceMinDeviation) {
                    price =
                      settings.strategy === StrategyEnum.long
                        ? Math.min(price, priceMinDeviation)
                        : Math.max(price, priceMinDeviation)
                  }
                }
              } else {
                continue
              }
            }
            if (i === 1) {
              if (price === latestPrice) {
                price = this.math.round(
                  latestPrice +
                    (this.isLong ? -1 : 1) *
                      Number(`${1}e-${symbol.priceAssetPrecision}`),
                  symbol.priceAssetPrecision,
                )
              }
            }
            if (i > 1) {
              if (price === (orders[orders.length - 1]?.price ?? 0)) {
                price = this.math.round(
                  (orders[orders.length - 1]?.price ?? 0) +
                    (this.isLong ? -1 : 1) *
                      Number(`${1}e-${symbol.priceAssetPrecision}`),
                  symbol.priceAssetPrecision,
                )
              }
            }
            if (price <= 0) {
              break
            }
            price = this.math.round(price, ed.priceAssetPrecision)
            const findBreakpoint = breakpoints
              .sort((a, b) => (long ? b.price - a.price : a.price - b.price))
              .find((b) => price === b.price)
            if (findBreakpoint) {
              price = this.math.round(
                findBreakpoint.displacedPrice,
                symbol.priceAssetPrecision,
              )
            }
            let orderSize = _orderSize
            if (
              settings.dcaCondition === DCAConditionEnum.indicators &&
              !useVolumeChange
            ) {
              orderSize =
                +(
                  (settings.indicators ?? []).filter(
                    (ind) => ind.indicatorAction === IndicatorAction.startDca,
                  )[i - 1]?.orderSize ?? '0'
                ) || _orderSize
            }
            if (
              settings.dcaCondition === DCAConditionEnum.custom &&
              !useVolumeChange
            ) {
              orderSize =
                +((settings.dcaCustom ?? [])[i - 1]?.size ?? '0') || _orderSize
            }
            if (useVolumeChange) {
              const quote =
                latestPrice * baseQtyOrig +
                orders.reduce((acc, v) => acc + v.price * v.qty, 0)
              const base =
                baseQtyOrig + orders.reduce((acc, v) => acc + v.qty, 0)
              if (
                settings.dcaVolumeRequiredChangeRef ===
                DcaVolumeRequiredChangeRef.avg
              ) {
                const newAvg =
                  price * (1 + (volumeChangeValue / 100) * (long ? 1 : -1))
                const deno = long ? price - newAvg : newAvg - price
                orderSize = (newAvg * base - quote) / deno
              } else {
                const c =
                  ((volumeChangeValue / 100 + 1) * price) /
                  (1 + tpPerc * (long ? 1 : -1))
                const deno = long ? price - c : c - price
                orderSize = (c * base - quote) / deno
              }
              if (orderSizeType === OrderSizeTypeEnum.quote) {
                orderSize *= price
              }
              orderSize = Math.min(maxVolumeSize, orderSize)
            }
            if (
              orderSizeType === OrderSizeTypeEnum.percFree ||
              orderSizeType === OrderSizeTypeEnum.percTotal
            ) {
              if (
                settings.orderSizePercQty &&
                settings.orderSizePercQty !== 0 &&
                settings.dcaCondition !== DCAConditionEnum.indicators &&
                settings.dcaCondition !== DCAConditionEnum.custom
              ) {
                balanceUseQty = settings.orderSizePercQty
              } else {
                balanceUseQty = await this.getBalancePercQty(
                  orderSizeType,
                  orderSize,
                  dealId,
                  symbol.pair,
                )
              }
            }
            let qty = this.math.round(
              ((orderSize * (this.coinm ? ed.quoteAsset.minAmount : 1)) /
                (_price ?? price)) *
                volumeVal +
                (deal?.sizes?.dca?.[i - 1] ?? 0),
              precision,
            )
            if (orderSizeType === OrderSizeTypeEnum.base) {
              qty = this.math.round(
                orderSize * volumeVal + (deal?.sizes?.dca?.[i - 1] ?? 0),
                precision,
              )
            }
            if (orderSizeType === OrderSizeTypeEnum.usd) {
              qty = this.math.round(
                (orderSize * volumeVal) /
                  ((await this.getUsdRate(symbol.pair, 'quote')) *
                    latestPrice) +
                  (deal?.sizes?.dca?.[i - 1] ?? 0),
                precision,
              )
            }
            if (
              orderSizeType === OrderSizeTypeEnum.percFree ||
              orderSizeType === OrderSizeTypeEnum.percTotal
            ) {
              qty = this.futures
                ? this.coinm
                  ? this.math.round(balanceUseQty * volumeVal, precision)
                  : this.math.round(
                      (balanceUseQty / price) * volumeVal,
                      precision,
                    )
                : long
                  ? this.math.round(
                      (balanceUseQty / price) * volumeVal,
                      precision,
                    )
                  : this.math.round(balanceUseQty * volumeVal, precision)
            }
            if (
              symbol.baseAsset.maxAmount &&
              qty > symbol.baseAsset.maxAmount
            ) {
              break
            }
            if (qty < symbol.baseAsset.minAmount) {
              qty = symbol.baseAsset.minAmount
            }
            if (qty * price < symbol.quoteAsset.minAmount && !this.coinm) {
              qty = this.math.round(
                symbol.quoteAsset.minAmount / price,
                precision,
                false,
                true,
              )
            }
            if (settings.coinm && !this.isBitget) {
              const cont = (price * qty) / symbol.quoteAsset.minAmount
              if (cont < 1) {
                qty = this.math.round(
                  symbol.quoteAsset.minAmount / price,
                  precision,
                  false,
                  true,
                )
              } else if (cont % 1 > Number.EPSILON) {
                qty = this.math.round(
                  (this.math.round(cont, 0) * symbol.quoteAsset.minAmount) /
                    price,
                  precision,
                  false,
                  true,
                )
              }
            }
            try {
              const mod = +new Big(qty).mod(symbol.baseAsset.step).toFixed(20)
              if (mod !== 0) {
                qty = this.math.round(
                  qty - mod + symbol.baseAsset.step,
                  precision,
                  false,
                  true,
                )
              }
            } catch (e) {
              this.handleErrors(
                `Big number error ${(e as Error).message || e}`,
                'createInitialDealOrders',
                'dca',
                false,
                false,
                false,
              )
            }
            orders.push({
              qty,
              price,
              side: ordersSide,
              newClientOrderId: this.getOrderId(`D-RO`),
              number: i,
              type: TypeOrderEnum.dealRegular,
              dealId,
              levelNumber: i,
            })
          }
        }
        const result = [...orders, tpOrder].filter(
          (o) =>
            !(deal?.blockOrders ?? []).filter(
              (db) =>
                db.price === o.price && db.qty === o.qty && db.side === o.side,
            ).length,
        )

        return result
      }
      return []
    }
    /**
     * Create current deal orders
     *
     * @param {number} price Price from which to start
     * @param {Grid[]} initialOrders Initial orders of the deal
     * @param {number} avgPrice Average price
     * @param {number} boPrice Base order price
     * @param {string} dealId Id of the deal
     * @param {boolean} [all] Is need to generate all orders. Default = false
     * @returns {Grid[]} Orders calculated for current price
     */

    async createCurrentDealOrders(
      symbol: string,
      price: number,
      initialOrders: Grid[],
      avgPrice: number,
      boPrice: number,
      dealId: string,
      all = false,
      deal?: ExcludeDoc<Deal>,
      noCheck = true,
      filterSl = true,
    ): Promise<Grid[]> {
      if (this.data && this.orders) {
        this.handleLog(`Generate current deal orders @ ${price}`)
        if (initialOrders.length > 0) {
          const settings = await this.getAggregatedSettings(deal)
          initialOrders = [
            ...initialOrders.filter((o) =>
              settings.dcaCondition === DCAConditionEnum.indicators
                ? o.type !== TypeOrderEnum.dealRegular
                : true,
            ),
          ]

          const activeOrders = settings.activeOrdersCount
          const useSmartOrders = settings.useSmartOrders
          const dcaOrdersCount =
            settings.dcaCondition === DCAConditionEnum.custom
              ? (settings.dcaCustom?.length ?? 0)
              : +(settings.ordersCount || '0')
          const useTp =
            settings.useTp &&
            (settings.dealCloseCondition === CloseConditionEnum.tp ||
              settings.dealCloseCondition === CloseConditionEnum.dynamicAr) &&
            (!(
              settings.useTp &&
              settings.trailingTp &&
              settings.dealCloseCondition === CloseConditionEnum.tp
            ) ||
              (settings.trailingTp &&
                settings.useMultiTp &&
                settings.multiTp)) &&
            !this.data?.flags?.includes(BotFlags.externalTp)
          const tpOrders = await this.getTPOrder(
            symbol,
            price,
            initialOrders,
            avgPrice,
            boPrice,
            dealId,
            deal,
          )
          const orders = [
            ...initialOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ),
          ]
          let currentOrders: Grid[] = []
          const long = this.isLong
          const filledRegular = this.getOrdersByStatusAndDealId({
            status: ['FILLED', 'PARTIALLY_FILLED'],
            dealId,
          }).filter((o) => o.typeOrder === TypeOrderEnum.dealRegular)
          let left = 0
          try {
            left = dcaOrdersCount - filledRegular.length
          } catch (e) {
            this.handleErrors(
              `Cannot calculate left ${dealId} ${(e as Error).message || e}`,
              'createCurrentDealOrders',
              'left',
              false,
              false,
              false,
            )
          }
          if (long) {
            if (left && !isNaN(left)) {
              currentOrders = orders
                .sort((a, b) => a.price - b.price)
                .slice(0, left)
                .filter((o) => o.price < price)
                .sort((a, b) => b.price - a.price)
            } else {
              currentOrders = orders
                .filter((o) => o.price < price)
                .sort((a, b) => b.price - a.price)
            }
          }
          if (!long) {
            if (left && !isNaN(left)) {
              currentOrders = orders
                .sort((a, b) => b.price - a.price)
                .slice(0, left)
                .filter((o) => o.price > price)
                .sort((a, b) => a.price - b.price)
            } else {
              currentOrders = orders
                .filter((o) => o.price > price)
                .sort((a, b) => a.price - b.price)
            }
          }
          const [firstOrder] = currentOrders
          if (!noCheck) {
            if (
              firstOrder &&
              !this.getOrdersByStatusAndDealId({ defaultStatuses: true }).find(
                (o) =>
                  +o.price === firstOrder.price &&
                  +o.origQty === firstOrder.qty &&
                  o.side === firstOrder.side,
              ) &&
              left &&
              !isNaN(left)
            ) {
              const latestPrice = await this.getLatestPrice(symbol)
              if (
                firstOrder &&
                latestPrice !== 0 &&
                ((latestPrice < firstOrder.price && this.isLong) ||
                  (latestPrice > firstOrder.price && !this.isLong)) &&
                deal
              ) {
                const breakpoint = {
                  price: firstOrder.price,
                  displacedPrice: latestPrice,
                }
                deal.gridBreakpoints = await this.aggregateBreakpoint(
                  breakpoint,
                  deal,
                )
                const newInitialOrders = await this.createInitialDealOrders(
                  deal.symbol.symbol,
                  deal.initialPrice || price,
                  dealId,
                  deal,
                )
                const findDeal = this.getDeal(deal._id)
                if (findDeal) {
                  findDeal.initialOrders = newInitialOrders
                  const current = await this.createCurrentDealOrders(
                    deal.symbol.symbol,
                    breakpoint.price,
                    newInitialOrders,
                    avgPrice,
                    boPrice,
                    dealId,
                    all,
                    deal,
                  )
                  currentOrders = current
                  findDeal.currentOrders = current
                  findDeal.deal = deal
                  this.saveDeal(findDeal, {
                    gridBreakpoints: deal.gridBreakpoints,
                  })
                }
              }
            }
          }

          if (!all && useSmartOrders) {
            currentOrders = currentOrders.slice(
              0,
              (activeOrders ?? 0) > 0 ? activeOrders : 1,
            )
          }
          if (
            deal?.trailingLevel &&
            ((settings.useTp &&
              settings.trailingTp &&
              settings.dealCloseCondition === CloseConditionEnum.tp) ||
              (settings.useSl &&
                settings.trailingSl &&
                settings.dealCloseConditionSL === CloseConditionEnum.tp)) &&
            filterSl
          ) {
            currentOrders = currentOrders.filter((o) =>
              this.isLong
                ? o.price > (deal?.trailingLevel ?? 0)
                : o.price < (deal?.trailingLevel ?? Infinity),
            )
          }
          let result = [...currentOrders]
          if (tpOrders) {
            result = [...currentOrders, ...tpOrders]
              .filter((o) => (!useTp ? o.type !== TypeOrderEnum.dealTP : true))
              .filter((o) =>
                ((settings.useTp &&
                  settings.useMultiTp &&
                  settings.dealCloseCondition === CloseConditionEnum.tp) ||
                  (settings.useSl &&
                    settings.useMultiSl &&
                    settings.dealCloseConditionSL === CloseConditionEnum.tp)) &&
                (deal?.tpSlTargetFilled ?? []).length > 0
                  ? o.type !== TypeOrderEnum.dealRegular
                  : true,
              )
          }
          if (filterSl) {
            const useSl =
              settings.useSl && !settings.moveSL && checkNumber(settings.slPerc)
            if (
              useSl &&
              settings.dealCloseConditionSL === CloseConditionEnum.dynamicAr &&
              deal
            ) {
              const indicator = this.data.settings.indicators.find(
                (ind) =>
                  (ind.type === IndicatorEnum.atr ||
                    ind.type === IndicatorEnum.adr) &&
                  ind.indicatorAction === IndicatorAction.closeDeal &&
                  ind.section === IndicatorSection.sl,
              )
              if (indicator) {
                let value = (deal.dynamicAr ?? []).find(
                  (d) => d.id === indicator.uuid,
                )?.value
                if (value && !isNaN(value) && isFinite(value)) {
                  value *= +(indicator.dynamicArFactor || '1')
                  const slLevel = boPrice + value * (this.isLong ? -1 : 1)
                  if (!isNaN(slLevel)) {
                    return result.filter((r) =>
                      this.isLong ? r.price > slLevel : r.price < slLevel,
                    )
                  }
                }
              }
            }
            if (
              useSl &&
              settings.dealCloseConditionSL === CloseConditionEnum.tp
            ) {
              let perc = +(settings.slPerc ?? '0') / 100
              if (settings.useMultiSl) {
                const find = (settings.multiSl ?? [])
                  .filter(
                    (t) =>
                      !((deal?.tpSlTargetFilled ?? []) as string[]).includes(
                        t.uuid,
                      ),
                  )
                  .sort((a, b) => +a.target - +b.target)[0]
                if (find) {
                  perc = +(find.target ?? '0') / 100
                }
              }
              const ref =
                (await this.baseSlOn(deal)) === BaseSlOnEnum.avg
                  ? avgPrice
                  : boPrice
              const slLevel = this.math.round(
                ref * (1 + (this.isLong ? perc : -perc)),
                (await this.getExchangeInfo(symbol))?.priceAssetPrecision,
              )
              if (!isNaN(slLevel)) {
                return result.filter((r) =>
                  this.isLong ? r.price > slLevel : r.price < slLevel,
                )
              }
            }
          }
          return result
        }
      }
      return []
    }
    /**
     * Set bot status <br />
     *
     * If status closed - run {@link DCABotHelper#stop}<br />
     *
     * If status open - run {@link DCABotHelper#start}
     *
     * @param {BotStatusEnum} status Status to set for the bot
     * @param {CloseDCATypeEnum} [closeType] Close type
     */

    @IdMute(mutex, (botId: string) => `setStatusBot${botId}`)
    async setStatus(
      _botId: string,
      status: BotStatusEnum,
      _closeType?: CloseDCATypeEnum,
      webhook?: boolean,
      ignoreErrors?: boolean,
      indicators?: boolean,
      closeTypeFromWebhook?: CloseDCATypeEnum,
      skipAvailable?: boolean,
    ): Promise<boolean> {
      const _id = this.startMethod('setStatus')
      this.ignoreErrors = !!ignoreErrors
      const currentStatus = this.data?.status
      this.handleLog(`Set status ${status}, current status ${currentStatus}`)
      if (status === currentStatus) {
        this.endMethod(_id)
        return false
      }
      const setMonitoring =
        this.isMonitoring &&
        (currentStatus === BotStatusEnum.closed ||
          (currentStatus === BotStatusEnum.error &&
            this.data?.previousStatus === BotStatusEnum.monitoring))
      if (
        (webhook || indicators) &&
        status === BotStatusEnum.open &&
        (currentStatus === BotStatusEnum.error ||
          currentStatus === BotStatusEnum.open ||
          (setMonitoring && currentStatus === BotStatusEnum.monitoring))
      ) {
        this.endMethod(_id)
        return false
      }

      const settings = await this.getAggregatedSettings()

      if (status === 'closed') {
        let closeType = _closeType
        if (webhook || indicators) {
          closeType = webhook
            ? (closeTypeFromWebhook ?? settings.stopType)
            : settings.stopType
        }
        // Forward the flag `setStatus` just set on the instance. `stop()`
        // assigns `this.ignoreErrors = ignoreErrors` as its first statement, so
        // calling it without the argument silently resets the flag to `false`
        // and every teardown failure is reported to the user — which is why the
        // caller-side "ignore errors while deleting/resetting" attempts never
        // took effect.
        await this.stop(closeType, undefined, this.ignoreErrors)
      } else if (status === 'open') {
        await this.start(undefined, undefined, undefined, skipAvailable)
      } else {
        await this.stop(undefined, undefined, this.ignoreErrors)
      }

      if (this.shouldProceed()) {
        const postFix = `${
          indicators ? ' (bot controller)' : webhook ? ' (webhook)' : ''
        }`
        if (
          !this.data?.parentBotId ||
          (this.data.parentBotId &&
            this.data.settings.strategy === StrategyEnum.long)
        ) {
          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event: BOT_STATUS_EVENT,
            botType: this.botType,
            description: currentStatus
              ? `${currentStatus} -> ${status}${postFix}`
              : `${
                  setMonitoring ? BotStatusEnum.monitoring : status
                } status is set${postFix}`,
            paperContext: !!this.data?.paperContext,
          })
        }
      }

      this.endMethod(_id)
      return true
    }

    async handleUnknownOrder(order: Order): Promise<void> {
      if (order && order.status === 'FILLED') {
        await this.processFilledOrder(order)
      }
      if (
        order &&
        order.status === 'PARTIALLY_FILLED' &&
        order.typeOrder === TypeOrderEnum.dealTP
      ) {
        await this.processPartiallyFilledOrder(order)
      }
    }
    /**
     * How much of a `FILLED` take-profit was never sold. Thin delegate; the
     * predicate and its regression tests live in `./dca/partialTp`.
     */
    protected underfilledTpQty(order: Order): number {
      return underfilledTpQty(order)
    }

    /**
     * ⚠️ The `underfilledTpQty` branch below CANNOT FIRE, verified against prod
     * 2026-08-30. The only caller is `cancelOrderOnExchange`, which reaches it
     * inside `if (+order.executedQty !== 0 && order.status === 'CANCELED')` and
     * assigns `order.status = 'FILLED'` only *after* this returns — while
     * `underfilledTpQty()` returns 0 unless `status === 'FILLED'`. So `unsold`
     * is always 0 and this always returns `true`. Over 25.5h post-deploy the log
     * line below appeared 0 times fleet-wide while underfilled TPs kept arriving,
     * and dealTP orders left CANCELED-with-partial-fill went 23 (7.3d) -> 0.
     *
     * Left inert deliberately rather than "repaired": the actual stranding fix is
     * `buyRemainder`'s reduce-only gate (`main.ts`), and making this branch live
     * is a separate behaviour change that needs its own measurement first. Do not
     * make it reachable without one.
     */
    override async setFilledInsteadOfCanceled(order: Order): Promise<boolean> {
      if (
        order.typeOrder === TypeOrderEnum.dealTP &&
        // NOTE: this reads like an exclusion of D-SR (re-placed remainder) TPs
        // but is always true — a clientOrderId cannot contain both patterns, so
        // one disjunct always holds. Deliberately left as-is: "fixing" it to
        // `&&` would genuinely exclude D-SR orders, and those are exactly the
        // re-placed remainder TPs that underfill again and strand the rest.
        (order.clientOrderId.indexOf('D-SR') === -1 ||
          order.clientOrderId.indexOf('DSR') === -1) &&
        !order.tpSlTarget &&
        this.botType === BotType.dca
      ) {
        const unsold = this.underfilledTpQty(order)
        if (unsold > 0) {
          this.handleLog(
            `TP order ${order.clientOrderId} reported FILLED but sold only ${order.executedQty} of ${order.origQty} (${unsold} unsold). Recording it as a partial fill instead of closing the deal.`,
          )
          // Record what the venue should have told us, so the remainder is
          // carried in tpHistory and a new TP is placed for it on the next
          // cycle — the same path a PARTIALLY_FILLED event would have taken.
          await this.updatePartiallyFilledTP(order)
          return false
        }
        return true
      }
      return true
    }
    /**
     * Base quantity this deal still has to close, or `null` when it could not
     * be determined. Spec `specs/009…` (issue #658).
     *
     * `getTPOrder`'s `aggregate` mode is the un-split take-profit — the whole
     * remaining position — and is the same code that sizes the orders the deal
     * actually places, so the two answers cannot drift. Returning `undefined`
     * there means an exchange-info or fee lookup came back empty, which is not
     * a deal that holds nothing: it maps to `null`, and the caller re-arms.
     *
     * `order` is subtracted only when the order map has not already booked it.
     * `getOrders`' stream path calls `setOrder` before `onFilled`, but
     * `checkTPLevel` hands its own close straight to `processFilledOrder`, and
     * an uncounted fill would over-state what is left by exactly the amount
     * that just closed the position — the one case this whole check exists for.
     */
    private async remainingCloseQty(
      deal: FullDeal<ExcludeDoc<Deal>>,
      order: Order,
    ): Promise<number | null> {
      const dealId = `${deal.deal._id}`
      const aggregate = await this.getTPOrder(
        deal.deal.symbol.symbol,
        deal.deal.lastPrice,
        deal.initialOrders,
        deal.deal.avgPrice,
        deal.deal.initialPrice,
        dealId,
        deal.deal,
        true,
      )
      const qty = aggregate?.[0]?.qty
      if (typeof qty !== 'number' || !Number.isFinite(qty)) {
        return null
      }
      const counted = this.getOrdersByStatusAndDealId({
        status: 'FILLED',
        dealId,
      }).some((o) => o.clientOrderId === order.clientOrderId)
      return counted ? qty : qty - (+order.executedQty || 0)
    }
    /**
     * Process filled order from queue<br />
     *
     * @param {Order} order Order data
     */

    @IdMute(
      mutex,
      (order: Order) =>
        `${order.botId}process${order.symbol}${order.dealId ?? ''}`,
    )
    async processFilledOrder(order: Order): Promise<void> {
      if (!this.shouldProceed()) {
        this.handleLog(
          this.notProceedMessage(`processFilledOrder ${order.clientOrderId}`),
        )
        return
      }
      if (!this.loadingComplete) {
        if (
          this.data?.status === BotStatusEnum.open ||
          this.data?.status === BotStatusEnum.error ||
          this.data?.status === BotStatusEnum.range ||
          this.data?.status === BotStatusEnum.monitoring ||
          this.data?.deals.active
        ) {
          this.runAfterLoadingQueue.push(() =>
            this.processFilledOrder.bind(this)(order),
          )
          return this.handleLog('Loading not complete yet')
        } else {
          return this.handleLog(
            `Bot already closed. Wont process ${order.clientOrderId} order`,
          )
        }
      }
      const { dealId, clientOrderId } = order
      const getSet = dealId
        ? (this.processedFilled.get(dealId) ?? new Set<string>())
        : new Set<string>()
      if (dealId && !getSet.has(clientOrderId)) {
        this.processedFilled.set(dealId, getSet.add(clientOrderId))
        if (order.typeOrder === TypeOrderEnum.dealTP && order.reduceFundsId) {
          return this.updateDeal(this.botId, order)
        }
        if (
          order.typeOrder === TypeOrderEnum.dealTP &&
          (order.clientOrderId.indexOf('D-SR') === -1 ||
            order.clientOrderId.indexOf('DSR') === -1)
        ) {
          if (this.data && order.tpSlTarget) {
            const deal = this.getDeal(dealId)
            const { useMultiSl, useMultiTp, multiSl, multiTp } =
              await this.getAggregatedSettings(deal?.deal)
            if ((useMultiSl || useMultiTp) && deal) {
              const filled = new Set([
                ...(deal.deal.tpSlTargetFilled ?? []),
                order.tpSlTarget ?? '',
              ]).size
              const total =
                useMultiSl && order.sl
                  ? (multiSl ?? []).length
                  : useMultiTp && !order.sl
                    ? (multiTp ?? []).length
                    : 0
              // `total` counts the targets the user CONFIGURED, and the engine
              // cannot always arm one order per target: `getTPOrder`'s splitter
              // rounds each slice up to the venue's minimum, so five 20 %
              // targets on a 0.02 XAUTUSDT position arm exactly two orders of
              // 0.01. Once both filled the deal held nothing and still waited
              // for three more fills — see spec 009 / issue #658. Ask how much
              // is actually left to close before re-arming.
              if (
                shouldRearmTpTargets({
                  configuredTargets: total,
                  filledTargets: filled,
                  remainingQty: await this.remainingCloseQty(deal, order),
                })
              ) {
                const price = +order.price
                const { symbol } = deal.deal.symbol
                if (!isNaN(price)) {
                  this.setLastStreamData(symbol, {
                    price,
                    time: order.updateTime,
                  })
                  if (!useMultiSl) {
                    await this.checkDealsMoveSL(this.botId, symbol)
                  }
                }
                return this.updateDeal(this.botId, order)
              }
            }
          }
          this.allowToPlaceOrders.delete(dealId)
          this.closeDeal(this.botId, dealId, order)
        }

        if (order.typeOrder === TypeOrderEnum.dealStart) {
          this.startDeal(order)
        }
        if (order.typeOrder === TypeOrderEnum.dealRegular) {
          this.ordersInBetweenUpdates.add(order.clientOrderId)
          this.updateDeal(this.botId, order)
        }
      } else {
        this.handleLog(`Order ${clientOrderId} was already processed`)
      }
    }

    @IdMute(mutex, (order: Order) => `${order.botId}${order.dealId}update`)
    private async updatePartiallyFilledTP(order: Order) {
      const price = parseFloat(order.price)
      const qty = parseFloat(order.executedQty)
      const { dealId } = order
      const findDeal = this.getDeal(dealId)
      if (
        findDeal &&
        dealId &&
        this.orders &&
        findDeal.deal.status === DCADealStatusEnum.open
      ) {
        findDeal.deal.tpHistory = [
          ...(findDeal.deal.tpHistory ?? []).filter(
            (h) => h.id !== order.clientOrderId,
          ),
          { qty, price, id: order.clientOrderId },
        ]
        findDeal.deal.updateTime = order.updateTime
        this.handleDebug('TP order PARTIALLY FILLED')
        this.saveDeal(findDeal, {
          tpHistory: findDeal.deal.tpHistory,
          updateTime: findDeal.deal.updateTime,
        })
      }
    }
    /**
     * Process partially filled order from queue<br />
     *
     * @param {Order} order Order data
     */

    async processPartiallyFilledOrder(order: Order): Promise<void> {
      if (order.typeOrder === TypeOrderEnum.dealTP) {
        this.updatePartiallyFilledTP(order)
      }
    }

    async processNewOrder(_order: Order): Promise<void> {
      return
    }

    async processLiquidationOrder(order: Order): Promise<void> {
      if (!this.futures) {
        return
      }
      const { symbol } = order
      const activeDeals = this.getOpenDeals(false, symbol)
      if (activeDeals.length === 0) {
        return
      }
      this.handleLog(
        `Liquidation order ${order.clientOrderId}/${order.orderId} for ${symbol}`,
      )
      const compareSide = this.kucoinFullFutures
        ? true
        : this.isLong
          ? order.side === OrderSideEnum.sell
          : order.side === OrderSideEnum.buy

      const price = +order.price
      if (compareSide && !isNaN(price) && isFinite(price)) {
        await this.closeAllDeals(
          undefined,
          symbol,
          false,
          undefined,
          true,
          true,
          price > 0 ? price : await this.getLatestPrice(symbol),
          DCACloseTriggerEnum.liquidation,
        )
      }
      this.handleErrors(
        `Deals on ${
          order.symbol
        } closed due to position liquidation at ${new Date(
          order.updateTime,
        ).toUTCString()}`,
        'processLiquidationOrder',
        '',
        false,
        true,
      )
    }
    /**
     * Process canceled order from queue<br />
     *
     * @param {Order} order Order data
     */

    async processCanceledOrder(
      order: Order,
      _updateTime: number,
      _expired: boolean,
    ): Promise<void> {
      // A resting TP can take some size and then be canceled — by us, when a
      // safety order fills and the TP has to be re-sized, or by the venue. The
      // executed part is a real sale, and the cancel message carries it. If it
      // is not recorded the deal keeps counting base it no longer owns: every
      // later TP is sized above the free balance, the venue rejects it, and the
      // deal is left with no TP and no way to close.
      //
      // `updatePartiallyFilledTP` normally records this off the
      // PARTIALLY_FILLED event, but not every venue emits one (Coinbase keeps
      // such an order OPEN), so the cancel is the only report that is
      // guaranteed to arrive. It keys on clientOrderId, so seeing both events
      // records the qty once.
      if (order.typeOrder !== TypeOrderEnum.dealTP) {
        return
      }
      const executed = +order.executedQty
      const original = +order.origQty
      if (!isFinite(executed) || executed <= 0) {
        return
      }
      // A fully executed order is the FILLED path's to close, not ours.
      if (isFinite(original) && executed >= original) {
        return
      }
      // Only trust a quantity we can also date. Cancel records written from a
      // REST response rather than a stream event can carry a bogus
      // `executedQty` alongside `updateTime: -1` — prod has such rows, and one
      // of them looks exactly like a 1.29 partial fill on an order the venue
      // never filled at all. Booking that would invent a sale and under-size
      // every later TP by the phantom amount, which fails silently and in the
      // opposite direction to the bug this method exists to fix. A stream
      // event always carries a real timestamp, so this costs us nothing real.
      if (!(order.updateTime > 0)) {
        this.handleWarn(
          `Ignoring partial fill on canceled TP ${order.clientOrderId}: executedQty ${order.executedQty} with no usable updateTime (${order.updateTime})`,
        )
        return
      }
      await this.updatePartiallyFilledTP(order)
    }
    /**
     * Sort function for order queue
     */

    sortQueue(a: ExecutionReport, b: ExecutionReport) {
      if (a.orderTime === b.orderTime) {
        if (a.orderStatus === 'FILLED' && a.orderStatus === b.orderStatus) {
          if (
            ((a.side === OrderSideEnum.buy && this.isLong) ||
              (a.side === OrderSideEnum.sell && this.isLong)) &&
            a.side === b.side
          ) {
            return parseFloat(a.price) - parseFloat(b.price)
          } else if (
            ((a.side === OrderSideEnum.sell && !this.isLong) ||
              (a.side === OrderSideEnum.buy && this.isLong)) &&
            a.side === b.side
          ) {
            return parseFloat(b.price) - parseFloat(a.price)
          }
          return parseFloat(b.price) - parseFloat(a.price)
        }
      }
      return a.orderTime - b.orderTime
    }
    /**
     * Cancel all orders<br />
     *
     * Update data in {@link DCABotHelper#orders}, save to orders collection in db, emit via {@link DCABotHelper#ioUpdate}<br />
     *
     * After each request run {@link DCABotHelper#countBalances}<br />
     *
     * @param {string} [dealId] If specify - cancel order for specifi deal
     * @param {boolean} [cancelPartiallyFilled] cancel order with status PARTIALLY FILLED. Default = false
     */

    async cancelAllOrder(
      latestPrice?: number,
      dealId?: string,
      cancelPartiallyFilled = false,
      excludeTP = false,
      side?: OrderSideEnum,
    ): Promise<void> {
      if (this.exchange && this.data && this.orders) {
        let newOrders = this.getOrdersByStatusAndDealId({
          status: cancelPartiallyFilled ? this.orderStatuses : 'NEW',
        }).filter((order) => (side ? order.side === side : true))
        if (latestPrice) {
          newOrders = newOrders.sort(
            (a, b) =>
              Math.abs(latestPrice - +a.price) -
              Math.abs(latestPrice - +b.price),
          )
        }
        if (excludeTP) {
          newOrders = newOrders.filter(
            (o) => o.typeOrder !== TypeOrderEnum.dealTP,
          )
        }
        if (dealId) {
          newOrders = newOrders.filter((o) => o.dealId === dealId)
        }
        for (const order of newOrders.sort((a) =>
          a.typeOrder === TypeOrderEnum.dealTP ? -1 : 1,
        )) {
          const result = await this.cancelOrderOnExchange(order)
          if (result?.status === 'FILLED') {
            this.handleUnknownOrder(result)
          }
        }
      }
    }

    setEquityTimer() {
      if (this.data?.ignoreStats) {
        return
      }
      const newTime = new Date()
      newTime.setHours(0, 0, 0, 0)
      newTime.setDate(newTime.getDate() + 1)
      this.equityTimer = setTimeout(
        () => this.updateEquityStats.bind(this)(this.botId),
        +newTime - +new Date(),
      )
    }

    setStatsTimer() {
      const newTime = new Date()
      newTime.setMinutes(newTime.getMinutes() + 1)
      newTime.setSeconds(15, 0)
      this.statsTimer = setTimeout(
        () => this.updateLiveStats.bind(this)(this.botId, +newTime),
        +newTime - +new Date(),
      )
    }

    async setClassProperties() {
      const settings = await this.getAggregatedSettings()
      if (this.data) {
        this.data.settings = settings
      }
      this.isMonitoring = !!(
        settings.useBotController &&
        (settings.botActualStart === BotStartTypeEnum.indicators ||
          settings.botActualStart === BotStartTypeEnum.price)
      )
      this.scaleAr = !!(
        (settings.dcaCondition === DCAConditionEnum.percentage ||
          !settings.dcaCondition) &&
        [ScaleDcaTypeEnum.adr, ScaleDcaTypeEnum.atr].includes(
          settings.scaleDcaType ?? ScaleDcaTypeEnum.percentage,
        ) &&
        settings.useDca
      )
      this.tpAr = !!(
        settings.useTp &&
        settings.dealCloseCondition === CloseConditionEnum.dynamicAr
      )
      this.useCompountReduce = !!(
        settings.orderSizeType &&
        [OrderSizeTypeEnum.base, OrderSizeTypeEnum.quote].includes(
          settings.orderSizeType,
        ) &&
        ((settings.strategy === StrategyEnum.long &&
          settings.profitCurrency === 'quote') ||
          (settings.strategy === StrategyEnum.short &&
            settings.profitCurrency === 'base') ||
          settings.futures) &&
        (settings.useRiskReduction || settings.useReinvest)
      )
      this.slAr = !!(
        settings.useSl &&
        settings.dealCloseConditionSL === CloseConditionEnum.dynamicAr
      )
      this.isLong = settings.strategy === StrategyEnum.long
    }

    async isDealForMoveSl(d: FullDeal<ExcludeDoc<Deal>>) {
      const settings = await this.getAggregatedSettings(d.deal)
      return (
        !(
          settings.trailingSl ||
          (settings.useMultiSl &&
            settings.dealCloseConditionSL === CloseConditionEnum.tp) ||
          settings.useFixedSLPrices
        ) &&
        settings.useSl &&
        settings.moveSL &&
        settings.moveSLTrigger &&
        settings.moveSLValue &&
        !settings.slChangedByUser &&
        (settings.dealCloseConditionSL === CloseConditionEnum.tp ||
          !d.deal.moveSlActivated) &&
        settings.slPerc !== settings.moveSLValue
      )
    }

    async getDealMoveSlPrice(d: FullDeal<ExcludeDoc<Deal>>) {
      const settings = await this.getAggregatedSettings(d.deal)
      const { avgPrice, moveSLTrigger } = settings
      const avgToUse = dealRefPrice(avgPrice, d.deal.avgPrice)
      const feeFactor =
        ((await this.getUserFee(d.deal.symbol.symbol))?.taker ?? 0) * 2
      const trigger = +(moveSLTrigger ?? '0') / 100 + feeFactor
      const required = this.isLong
        ? avgToUse * (trigger + 1)
        : avgToUse * (1 - trigger)

      const get = this.dealsForMoveSl.get(d.deal._id)
      if (get !== required) {
        this.handleLog(
          `Set new move sl start price for ${d.deal._id} ${get} to ${required}`,
        )
      }

      return required
    }

    async triggerMoveSl(dealId: string, trigger: number, current: number) {
      const d = this.getDeal(dealId)
      if (!d) {
        this.handleErrors(
          `Cannot find deal in trigger move sl`,
          'triggerMoveSl',
          '',
          false,
          false,
          false,
        )
        return
      }
      const settings = await this.getAggregatedSettings(d.deal)
      this.handleLog(
        `Deal: ${dealId} move sl trigger. SL trigger: ${trigger}, current price: ${current}, new SL: ${settings.moveSLValue}`,
      )
      if (settings.moveSLValue) {
        d.deal.settings.slPerc = settings.moveSLValue
      }
      d.deal.moveSlActivated = true
      // The stop level is only being set now, so no tick has been observed
      // against it yet — `checkDealsStopLoss` re-arms from the live price.
      d.deal.moveSlArmed = false
      this.saveDeal(d, {
        'settings.slPerc': d.deal.settings.slPerc,
        moveSlActivated: d.deal.moveSlActivated,
        moveSlArmed: d.deal.moveSlArmed,
      })
      await this.setDealForStopLoss(d)
      this.checkDealsPriceExtremum()
    }

    async checkDealsForMoveStopLoss() {
      const activeDeals: [string, number][] = []

      for (const d of this.allDealsData) {
        if (await this.isDealForMoveSl(d)) {
          activeDeals.push([
            `${d.deal._id}`,
            await this.getDealMoveSlPrice(d),
          ] as [string, number])
        }
      }

      this.dealsForMoveSl = new Map(activeDeals)
    }

    async getTrailingSettings(
      d: FullDeal<ExcludeDoc<Deal>>,
      price = false,
    ): Promise<TrailingDeal> {
      const settings = await this.getAggregatedSettings(d.deal)
      const {
        trailingSl,
        trailingTp,
        trailingTpPerc,
        useMultiTp,
        useMultiSl,
        useTp,
        useSl,
        slPerc,
        dealCloseConditionSL,
        dealCloseCondition,
        tpPerc,
        fixedTpPrice,
        useFixedTPPrices,
        avgPrice,
      } = settings

      const skipSl = !(
        useSl &&
        trailingSl &&
        dealCloseConditionSL === CloseConditionEnum.tp &&
        checkNumber(slPerc) &&
        !useMultiSl
      )
      const skipTp = !(
        useTp &&
        dealCloseCondition === CloseConditionEnum.tp &&
        trailingTp &&
        checkNumber(trailingTpPerc) &&
        checkNumber(tpPerc) &&
        !useMultiTp
      )
      const fixed =
        useFixedTPPrices &&
        fixedTpPrice &&
        !isNaN(+fixedTpPrice) &&
        isFinite(+fixedTpPrice)

      let trailingTpPrice = 0
      if (price && trailingTp && !skipTp) {
        if (fixed) {
          trailingTpPrice = +fixedTpPrice as number
        } else {
          const fee = await this.getUserFee(d.deal.symbol.symbol)
          const sellDisplacement = (fee?.taker ?? 0) * 2
          const avgToUse = dealRefPrice(avgPrice, d.deal.avgPrice)
          const trigger = +(tpPerc ?? '0') / 100 + sellDisplacement
          trailingTpPrice = this.isLong
            ? avgToUse * (trigger + 1)
            : avgToUse * (1 - trigger)
        }
        if (trailingTpPrice && trailingTp && !skipTp) {
          const get = this.dealsForTrailing.get(d.deal._id)
          if (get?.trailingTpPrice !== trailingTpPrice) {
            this.handleDebug(
              `Set new trailing price for ${d.deal._id} ${get?.trailingTpPrice} to ${trailingTpPrice}`,
            )
          }
        }
      }
      return {
        trailingTp: !!trailingTp,
        skipTp,
        trailingSl: !!trailingSl,
        skipSl,
        trailingTpPrice,
      }
    }

    async isDealForTrailing(d: FullDeal<ExcludeDoc<Deal>>) {
      const { trailingTp, skipTp, trailingSl, skipSl } =
        await this.getTrailingSettings(d)
      return (trailingSl && !skipSl) || (trailingTp && !skipTp)
    }

    async triggerTrailing(dealId: string, price: number) {
      const d = this.getDeal(dealId)
      if (!d) {
        this.handleErrors(
          `Cannot find deal in trigger trailing`,
          'triggerMoveSl',
          '',
          false,
          false,
          false,
        )
        return
      }
      this.handleDebug(
        `Trailing: Set trailing level, deal: ${d.deal._id}, level: ${d.deal.trailingLevel}, price: ${price}, symbol: ${d.deal.symbol.symbol}`,
      )
      this.saveDeal(d, {
        trailingLevel: d.deal.trailingLevel,
        trailingMode: d.deal.trailingMode,
        bestPrice: d.deal.bestPrice,
      })

      await this.setDealForStopLoss(d)
      this.checkDealsPriceExtremum()
      if (d.deal.bestPrice) {
        if (this.isLong) {
          const lowestHigh = this.lowestHigh.get(d.deal.symbol.symbol)
          this.lowestHigh.set(
            d.deal.symbol.symbol,
            Math.min(lowestHigh ?? 0, d.deal.bestPrice),
          )
        } else {
          const highestLow = this.highestLow.get(d.deal.symbol.symbol)
          this.highestLow.set(
            d.deal.symbol.symbol,
            Math.max(highestLow ?? Infinity, d.deal.bestPrice),
          )
        }
      }

      if (d.deal.trailingLevel && d.deal.trailingLevel > 0) {
        const orders = this.getOrdersByStatusAndDealId({
          defaultStatuses: true,
          dealId: d.deal._id,
        }).filter((o) =>
          this.isLong
            ? +o.price < (d.deal.trailingLevel ?? 0)
            : +o.price > (d.deal.trailingLevel ?? Infinity),
        )
        if (orders.length > 0) {
          this.handleLog(
            `Trailing: will cancel ${orders.length} orders, deal: ${d.deal._id}, level: ${d.deal.trailingLevel}, price: ${price} `,
          )
        }
        for (const o of orders) {
          this.cancelOrderOnExchange(o)
        }
      }
    }

    async checkDealsForTrailing() {
      const activeDeals: [string, TrailingDeal][] = []
      for (const d of this.allDealsData) {
        if (await this.isDealForTrailing(d)) {
          activeDeals.push([
            `${d.deal._id}`,
            await this.getTrailingSettings(d, true),
          ])
        }
      }

      this.dealsForTrailing = new Map(activeDeals)
    }
    private getIndicatorUnpnlValues() {
      const foundInSl =
        this.data?.settings.dealCloseConditionSL === CloseConditionEnum.techInd
          ? (this.data?.settings.indicators ?? []).find(
              (i) =>
                i.type === IndicatorEnum.unpnl &&
                i.section === IndicatorSection.sl,
            )
          : undefined
      const foundInTp =
        this.data?.settings.dealCloseCondition === CloseConditionEnum.techInd
          ? (this.data?.settings.indicators ?? []).find(
              (i) =>
                i.type === IndicatorEnum.unpnl &&
                i.section !== IndicatorSection.sl,
            )
          : undefined
      const slGroups = this.data?.settings.indicatorGroups.filter(
        (g) =>
          g.action === IndicatorAction.closeDeal &&
          g.section === IndicatorSection.sl,
      )
      const tpGroups = this.data?.settings.indicatorGroups.filter(
        (g) =>
          g.action === IndicatorAction.closeDeal &&
          g.section !== IndicatorSection.sl,
      )
      const slGroup = foundInSl
        ? slGroups?.find((g) => g.id === foundInSl?.groupId)
        : undefined
      const tpGroup = foundInTp
        ? tpGroups?.find((g) => g.id === foundInTp?.groupId)
        : undefined
      const slIndicatorsInGroup = slGroup
        ? this.data?.settings.indicators.filter(
            (i) =>
              i.indicatorAction === IndicatorAction.closeDeal &&
              i.section === IndicatorSection.sl &&
              i.groupId === slGroup.id,
          )
        : undefined
      const tpIndicatorsInGroup = tpGroup
        ? this.data?.settings.indicators.filter(
            (i) =>
              i.indicatorAction === IndicatorAction.closeDeal &&
              i.section !== IndicatorSection.sl &&
              i.groupId === tpGroup.id,
          )
        : undefined
      const slGroupLogicOr = slGroup?.logic === IndicatorsLogicEnum.or
      const tpGroupLogicOr = tpGroup?.logic === IndicatorsLogicEnum.or
      const slLogicOr =
        this.data?.settings.stopDealSlLogic === IndicatorsLogicEnum.or
      const tpLogicOr =
        this.data?.settings.stopDealLogic === IndicatorsLogicEnum.or
      const slInidcators = foundInSl
        ? (this.data?.settings.indicators ?? []).filter(
            (i) =>
              i.indicatorAction === IndicatorAction.closeDeal &&
              i.section === IndicatorSection.sl,
          )
        : undefined
      const tpInidcators = foundInTp
        ? (this.data?.settings.indicators ?? []).filter(
            (i) =>
              i.indicatorAction === IndicatorAction.closeDeal &&
              i.section !== IndicatorSection.sl,
          )
        : undefined
      const slConditionGt =
        (foundInSl
          ? (foundInSl?.unpnlCondition ?? this.defaultUnpnlCondition)
          : null) === IndicatorStartConditionEnum.gt
      const tpConditionGt =
        (foundInTp
          ? (foundInTp?.unpnlCondition ?? this.defaultUnpnlCondition)
          : null) === IndicatorStartConditionEnum.gt
      return {
        foundInSl,
        foundInTp,
        slLogicOr,
        tpLogicOr,
        slInidcators,
        tpInidcators,
        slConditionGt,
        tpConditionGt,
        slIndicatorsInGroup,
        slGroupLogicOr,
        tpIndicatorsInGroup,
        tpGroupLogicOr,
        slGroups,
        tpGroups,
      }
    }
    get isBotForIndicatorUnpnl() {
      if (this.combo) {
        return false
      }
      const {
        foundInSl,
        foundInTp,
        slLogicOr,
        tpLogicOr,
        slInidcators,
        tpInidcators,
        slGroupLogicOr,
        slIndicatorsInGroup,
        tpGroupLogicOr,
        tpIndicatorsInGroup,
        slGroups,
        tpGroups,
      } = this.getIndicatorUnpnlValues()

      if (foundInSl || foundInTp) {
        return (
          (foundInSl &&
            ((slInidcators?.length ?? 0) === 1 ||
              ((slIndicatorsInGroup?.length ?? 0) === 1 && slLogicOr) ||
              ((slGroups?.length ?? 0) === 1 && slGroupLogicOr) ||
              (slLogicOr && slGroupLogicOr))) ||
          (foundInTp &&
            ((tpInidcators?.length ?? 0) === 1 ||
              ((tpIndicatorsInGroup?.length ?? 0) === 1 && tpLogicOr) ||
              ((tpGroups?.length ?? 0) === 1 && tpGroupLogicOr) ||
              (tpLogicOr && tpGroupLogicOr)))
        )
      }
      return false
    }

    async isDealForStopLoss(d: FullDeal<ExcludeDoc<Deal>>) {
      const settings = await this.getAggregatedSettings(d.deal)

      return (
        ((((settings.trailingSl &&
          !settings.useMultiSl &&
          settings.useSl &&
          settings.dealCloseConditionSL === CloseConditionEnum.tp) ||
          (settings.trailingTp &&
            settings.useTp &&
            settings.dealCloseCondition === CloseConditionEnum.tp)) &&
          d.deal.trailingMode &&
          d.deal.trailingLevel) ||
          (settings.useSl &&
            (!settings.trailingSl || settings.useMultiSl) &&
            (settings.dealCloseConditionSL === CloseConditionEnum.tp ||
              (settings.moveSL &&
                d.deal.moveSlActivated &&
                +(settings.slPerc ?? 0) === +(settings.moveSLValue ?? 0)))) ||
          (this.slAr &&
            settings.useSl &&
            settings.dealCloseConditionSL === CloseConditionEnum.dynamicAr)) &&
        !this.data?.flags?.includes(BotFlags.externalSl)
      )
    }

    /**
     * The price a percentage stop loss is measured from — the deal average or
     * its initial price, per `baseSlOn`. Single source of truth so the level
     * and the checks that compare against it cannot drift apart.
     */
    private async getDealSlRefPrice(
      deal: ExcludeDoc<Deal>,
      avgPrice?: number,
    ): Promise<number> {
      return (await this.baseSlOn(deal)) === BaseSlOnEnum.avg
        ? dealRefPrice(avgPrice, deal.avgPrice)
        : deal.initialPrice
    }

    async getDealStopLossPrice(d: FullDeal<ExcludeDoc<Deal>>): Promise<number> {
      const settings = await this.getAggregatedSettings(d.deal)
      const {
        trailingSl,
        useSl,
        dealCloseConditionSL,
        trailingTp,
        useTp,
        dealCloseCondition,
        avgPrice,
        useMultiSl,
        multiSl,
        moveSL,
        useFixedSLPrices,
        fixedSlPrice,
      } = settings
      let { slPerc } = settings
      const dealId = d.deal._id
      const get = this.dealsForStopLoss.get(d.deal._id)

      if (
        ((trailingSl &&
          !useMultiSl &&
          useSl &&
          dealCloseConditionSL === CloseConditionEnum.tp) ||
          (trailingTp &&
            useTp &&
            dealCloseCondition === CloseConditionEnum.tp)) &&
        d.deal.trailingMode &&
        d.deal.trailingLevel
      ) {
        if (get !== d.deal.trailingLevel) {
          this.handleDebug(
            `Set new trailing stop loss price for ${d.deal._id} ${get} to ${d.deal.trailingLevel}`,
          )
        }
        return d.deal.trailingLevel
      } else if (
        useSl &&
        (!trailingSl || useMultiSl) &&
        (dealCloseConditionSL === CloseConditionEnum.tp ||
          (moveSL &&
            d.deal.moveSlActivated &&
            +(slPerc ?? 0) === +(settings.moveSLValue ?? 0)))
      ) {
        if (
          useMultiSl &&
          multiSl?.length &&
          dealCloseConditionSL === CloseConditionEnum.tp
        ) {
          const inUseSl = multiSl.filter(
            (t) => !d.deal.tpSlTargetFilled?.includes(t.uuid),
          )
          if (inUseSl.length === 0) {
            d.deal.status = DCADealStatusEnum.closed
            d.closeBySl = true
            this.saveDeal(d, {
              status: d.deal.status,
            })
            const stop = await this.processDealClose(this.botId, dealId, {
              total: 0,
              totalUsd: 0,
            })
            if (stop) {
              this.stop()
            }
            if (get !== d.deal.trailingLevel) {
              this.handleLog(`Deal ${d.deal._id} no SL levels. Closing deal`)
            }
            return 0
          }
          if (inUseSl.length >= 1) {
            slPerc = inUseSl.sort((a, b) => +b.target - +a.target)[0].target
          }
        }
        if (
          useFixedSLPrices &&
          fixedSlPrice &&
          !isNaN(+fixedSlPrice) &&
          isFinite(+fixedSlPrice)
        ) {
          if (get !== +fixedSlPrice) {
            this.handleDebug(
              `Set new fixed stop loss price for ${
                d.deal._id
              } ${get} to ${+fixedSlPrice}`,
            )
          }
          return +fixedSlPrice as number
        } else {
          const sl =
            parseFloat(slPerc ?? '0') / 100 +
            (useFixedSLPrices
              ? 0
              : ((await this.getUserFee(d.deal.symbol.symbol))?.taker ?? 0) * 2)

          if (!isNaN(sl) && slPerc !== undefined) {
            const ref = await this.getDealSlRefPrice(d.deal, avgPrice)
            const price = this.isLong ? ref * (sl + 1) : ref * (1 - sl)
            if (get !== price) {
              this.handleDebug(
                `Set new stop loss price for ${d.deal._id} ${get} to ${price}`,
              )
            }
            return price
          }
        }
      } else if (
        this.slAr &&
        settings.useSl &&
        settings.dealCloseConditionSL === CloseConditionEnum.dynamicAr
      ) {
        const indicator = (this.data?.settings.indicators ?? []).find(
          (ind) =>
            (ind.type === IndicatorEnum.atr ||
              ind.type === IndicatorEnum.adr) &&
            ind.indicatorAction === IndicatorAction.closeDeal &&
            ind.section === IndicatorSection.sl,
        )
        if (indicator) {
          let value = (d.deal.dynamicAr ?? []).find(
            (d) => d.id === indicator.uuid,
          )?.value
          if (value && !isNaN(value) && isFinite(value)) {
            value *= +(indicator.dynamicArFactor || '1')
            const price = d.deal.avgPrice + value * (this.isLong ? -1 : 1)
            if (get !== price) {
              this.handleDebug(
                `Set new stop loss AR price for ${d.deal._id} ${get} to ${price}`,
              )
            }
            return price
          }
        }
      }
      return 0
    }
    async getDealIndicatorUnpnlPrice(
      d: FullDeal<ExcludeDoc<Deal>>,
    ): Promise<DealIndicatorUnpnlVal> {
      if (!this.isBotForIndicatorUnpnl) {
        return { min: NaN, max: NaN }
      }
      const { foundInSl, foundInTp, slConditionGt, tpConditionGt } =
        this.getIndicatorUnpnlValues()
      const slValue = (foundInSl?.unpnlValue ?? this.defaultUnpnl) / 100
      const tpValue = (foundInTp?.unpnlValue ?? this.defaultUnpnl) / 100
      const min = Math.max(
        foundInSl && !slConditionGt ? slValue : -Infinity,
        foundInTp && !tpConditionGt ? tpValue : -Infinity,
      )
      const max = Math.min(
        foundInSl && slConditionGt ? slValue : Infinity,
        foundInTp && tpConditionGt ? tpValue : Infinity,
      )
      const fee = await this.getUserFee(d.deal.symbol.symbol)
      const returnVal = (val: number) =>
        ((val + (fee?.taker ?? 0) * 2) * (this.isLong ? 1 : -1) + 1) *
        (d.deal.settings.avgPrice || d.deal.avgPrice)
      return {
        min: returnVal(min),
        max: returnVal(max),
      }
    }

    triggerStopLoss(
      dealId: string,
      closeBySl: boolean,
      notCheckSl: boolean,
      closeByMulti: boolean,
      closeTrigger: DCACloseTriggerEnum,
    ) {
      const d = this.getDeal(dealId)
      if (!d) {
        this.handleErrors(
          `Cannot find deal in trigger stop loss`,
          'triggerMoveSl',
          '',
          false,
          false,
          false,
        )
        return
      }
      d.closeBySl = closeBySl
      d.notCheckSl = notCheckSl
      this.saveDeal(d)
      this.closeDealById(
        this.botId,
        dealId,
        CloseDCATypeEnum.closeByMarket,
        undefined,
        undefined,
        closeByMulti,
        undefined,
        undefined,
        undefined,
        true,
        closeTrigger,
      )
    }

    async checkDealsForStopLoss() {
      const activeDeals: [string, number][] = []
      for (const d of this.allDealsData) {
        if (await this.isDealForStopLoss(d)) {
          activeDeals.push([
            `${d.deal._id}`,
            await this.getDealStopLossPrice(d),
          ])
        }
      }
      this.dealsForStopLoss = new Map(activeDeals)
    }
    async checkDealsForIndicatorUnpnl() {
      if (!this.isBotForIndicatorUnpnl) {
        return
      }
      const activeDeals: [string, DealIndicatorUnpnlVal][] = []
      for (const d of this.allDealsData) {
        activeDeals.push([
          `${d.deal._id}`,
          await this.getDealIndicatorUnpnlPrice(d),
        ])
      }

      this.dealsForIndicatorUnpnl = new Map(activeDeals)
    }

    removeDealFromStopLossMethods(dealId: string) {
      this.dealsForMoveSl.delete(dealId)
      this.dealsForTrailing.delete(dealId)
      this.dealsForStopLoss.delete(dealId)
      this.dealsForStopLossCombo.delete(dealId)
      this.dealsDCALevelCheck.delete(dealId)
      this.dealsForIndicatorUnpnl.delete(dealId)
      this.dealsForTPLevelCheck.delete(dealId)
      this.dealsDCAByMarket.delete(dealId)
      this.dealsByMarketProcessing.forEach((key) => {
        if (key.includes(dealId)) {
          this.dealsByMarketProcessing.delete(key)
        }
      })
    }

    async checkDealsForStopLossMethods() {
      await this.checkDealsForMoveStopLoss()
      await this.checkDealsForTrailing()
      await this.checkDealsForStopLoss()
      await this.checkDealsForIndicatorUnpnl()
      this.checkDealsForDCALevelCheck()
      await this.checkDealsForDCAByMarketCheck()
      await this.checkDealsForTPLevelCheck()
    }
    async isDealForDCAByMarketCheck(d: FullDeal<ExcludeDoc<Deal>>) {
      const settings = await this.getAggregatedSettings(d.deal)
      return (
        !!settings.dcaByMarket &&
        d.deal.action !== ActionsEnum.useOppositeBalance
      )
    }
    async checkDealsForDCAByMarketCheck() {
      const activeDeals: [string, number][] = []
      for (const d of this.allDealsData) {
        if (await this.isDealForDCAByMarketCheck(d)) {
          activeDeals.push([
            `${d.deal._id}`,
            this.getDealDCAByMarketToCheck(d),
          ] as [string, number])
        } else {
          this.handleDebug(`Deal ${d.deal._id} is not for DCA By Market Check`)
        }
      }

      this.dealsDCAByMarket = new Map(activeDeals)
    }
    async isDealForTPLevelCheck(d: FullDeal<ExcludeDoc<Deal>>) {
      const settings = await this.getAggregatedSettings(d.deal)
      return (
        settings.closeOrderType === OrderTypeEnum.market &&
        d.deal.action !== ActionsEnum.useOppositeBalance
      )
    }
    async checkDealsForTPLevelCheck() {
      const activeDeals: [string, number][] = []
      for (const d of this.allDealsData) {
        if (await this.isDealForTPLevelCheck(d)) {
          activeDeals.push([`${d.deal._id}`, this.getDealTPLevelToCheck(d)] as [
            string,
            number,
          ])
        } else {
          this.handleDebug(`Deal ${d.deal._id} is not for TP Level Check`)
        }
      }

      this.dealsForTPLevelCheck = new Map(activeDeals)
    }
    isDealForDCALevelCheck(d: FullDeal<ExcludeDoc<Deal>>) {
      return (
        d.deal.action === ActionsEnum.useOppositeBalance &&
        d.deal.levels.complete < d.deal.levels.all &&
        d.deal.levels.all > 1
      )
    }
    checkDealsForDCALevelCheck() {
      const activeDeals: [string, number][] = []
      for (const d of this.allDealsData) {
        if (this.isDealForDCALevelCheck(d)) {
          activeDeals.push([
            `${d.deal._id}`,
            this.getDealDCALevelToCheck(d),
          ] as [string, number])
        }
      }

      this.dealsDCALevelCheck = new Map(activeDeals)
    }
    setDealForDCALevelCheck(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (this.isDealForDCALevelCheck(deal)) {
        this.dealsDCALevelCheck.set(
          deal.deal._id,
          this.getDealDCALevelToCheck(deal),
        )
        this.allowedMethods.add('checkDCALevel')
      }
    }
    async setDealForDCAByMarketCheck(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (await this.isDealForDCAByMarketCheck(deal)) {
        this.dealsDCAByMarket.set(
          deal.deal._id,
          this.getDealDCAByMarketToCheck(deal),
        )
        this.allowedMethods.add('checkDCAByMarketLevel')
      }
    }
    async setDealForTPLevelCheck(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (await this.isDealForTPLevelCheck(deal)) {
        this.dealsForTPLevelCheck.set(
          deal.deal._id,
          this.getDealTPLevelToCheck(deal),
        )
        this.allowedMethods.add('checkTPLevel')
      }
    }
    private getDealDCAByMarketToCheck(d: FullDeal<ExcludeDoc<Deal>>): number {
      const def = this.isLong ? 0 : Infinity
      const closestPrice = +[...d.currentOrders]
        .filter(
          (o) =>
            o.type === TypeOrderEnum.dealRegular &&
            (o.levelNumber || 0) >
              d.deal.levels.complete - 1 - (d.deal.funds?.length || 0),
        )
        .sort((a, b) =>
          this.isLong ? +b.price - +a.price : +a.price - +b.price,
        )[0]?.price
      this.handleDebug(
        `Deal ${d.deal._id} DCA By Market Check Price: ${closestPrice}`,
      )
      return closestPrice || def
    }
    private getDealTPLevelToCheck(d: FullDeal<ExcludeDoc<Deal>>): number {
      const def = this.isLong ? Infinity : 0
      const filledIds = (d.deal.tpFilledHistory ?? []).map((o) => o.id)
      const tpPrice = +[...d.currentOrders]
        .filter(
          (o) =>
            o.type === TypeOrderEnum.dealTP &&
            !filledIds.includes(o.tpSlTarget ?? ''),
        )
        .sort((a, b) =>
          this.isLong ? +a.price - +b.price : +b.price - +a.price,
        )[0]?.price
      // Info, not debug: which target the level check is armed on — and which
      // ones it considers already filled — is the other half of the picture,
      // and it was equally absent from prod. It rides the same trigger as the
      // `Lowest high` / `Highest low` pair logged just after it.
      this.handleLog(
        `Deal ${d.deal._id} TP Level Check Price: ${tpPrice || def}, Filled IDs: ${filledIds.join(', ')}`,
      )
      return tpPrice || def
    }
    private getDealDCALevelToCheck(d: FullDeal<ExcludeDoc<Deal>>): number {
      const def = this.isLong ? 0 : Infinity
      const lastLevel =
        'lastFilledLevel' in d.deal
          ? (d.deal as CleanComboDealsSchema).lastFilledLevel
          : d.deal.levels.complete
      if (!lastLevel) {
        return def
      }
      return (
        +[...d.currentOrders]
          .filter(
            (o) =>
              o.type === TypeOrderEnum.dealRegular &&
              o.dcaLevel &&
              o.dcaLevel > lastLevel,
          )
          .sort((a, b) =>
            this.isLong ? +b.price - +a.price : +a.price - +b.price,
          )[0]?.price || def
      )
    }

    async setDealForStopLoss(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (await this.isDealForStopLoss(deal)) {
        this.dealsForStopLoss.set(
          deal.deal._id,
          await this.getDealStopLossPrice(deal),
        )
        this.allowedMethods.add('checkDealsStopLoss')
      }
    }
    async setDealForIndicatorUnpnl(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (this.isBotForIndicatorUnpnl) {
        this.dealsForIndicatorUnpnl.set(
          deal.deal._id,
          await this.getDealIndicatorUnpnlPrice(deal),
        )
        this.allowedMethods.add('checkIndicatorUnpnl')
      }
    }

    async setDealForTrailing(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (await this.isDealForTrailing(deal)) {
        this.dealsForTrailing.set(
          deal.deal._id,
          await this.getTrailingSettings(deal, true),
        )
        this.allowedMethods.add('checkTrailing')
      }
    }

    async setDealForMoveSl(deal: FullDeal<ExcludeDoc<Deal>>) {
      if (await this.isDealForMoveSl(deal)) {
        this.dealsForMoveSl.set(
          deal.deal._id,
          await this.getDealMoveSlPrice(deal),
        )
        this.allowedMethods.add('checkDealsMoveSL')
      }
    }

    checkDealsPriceExtremum() {
      if (this.combo) {
        const values = [...this.dealsForStopLossCombo.values()]
        const min = this.isLong
          ? values.sort((a, b) => b.sl - a.sl)?.[0]?.sl
          : values.sort((a, b) => b.tp - a.tp)?.[0]?.tp
        const max = this.isLong
          ? values.filter((v) => !!v.tp).sort((a, b) => a.tp - b.tp)?.[0]?.tp
          : values.filter((v) => !!v.sl).sort((a, b) => a.sl - b.sl)?.[0]?.sl
        this.highestLow.set(this.data?.settings.pair[0] ?? '', min ?? 0)
        this.lowestHigh.set(this.data?.settings.pair[0] ?? '', max || Infinity)

        const valuesDCACheck = [...this.dealsDCALevelCheck.values()]
        const valuesDCAByMarketCheck = [...this.dealsDCAByMarket.values()]
        const minDCACheck = this.isLong
          ? Math.max(
              valuesDCAByMarketCheck.sort((a, b) => b - a)?.[0] ?? 0,
              valuesDCACheck.sort((a, b) => b - a)?.[0] ?? 0,
            )
          : 0
        const maxDCACheck = this.isLong
          ? Infinity
          : Math.min(
              valuesDCAByMarketCheck.sort((a, b) => a - b)?.[0] || Infinity,
              valuesDCACheck.sort((a, b) => a - b)?.[0] || Infinity,
            )
        this.highestLow.set(
          this.data?.settings.pair[0] ?? '',
          Math.max(min ?? 0, minDCACheck),
        )
        this.lowestHigh.set(
          this.data?.settings.pair[0] ?? '',
          Math.min(max || Infinity, maxDCACheck),
        )
      } else {
        const dealsForMoveSlMin = [...this.dealsForMoveSl.entries()].reduce(
          (acc, [k, v]) => {
            const deal = this.getDeal(k)
            const symbol = deal?.deal.symbol.symbol ?? ''
            acc.set(
              symbol,
              this.isLong
                ? Math.min(acc.get(symbol) || Infinity, v)
                : Math.max(acc.get(symbol) ?? 0, v),
            )
            return acc
          },
          new Map<string, number>(),
        )

        const trailingTpMin = [...this.dealsForTrailing.entries()].reduce(
          (acc, [k, v]) => {
            const deal = this.getDeal(k)
            const symbol = deal?.deal.symbol.symbol ?? ''
            acc.set(
              symbol,
              this.isLong
                ? Math.max(acc.get(symbol) ?? 0, v.trailingTpPrice)
                : Math.min(acc.get(symbol) ?? Infinity, v.trailingTpPrice),
            )
            return acc
          },
          new Map<string, number>(),
        )
        const bestPrices = [...this.dealsForTrailing.keys()].reduce(
          (acc, k) => {
            const deal = this.getDeal(k)
            const symbol = deal?.deal.symbol.symbol ?? ''
            acc.set(
              symbol,
              this.isLong
                ? Math.min(
                    acc.get(symbol) ?? Infinity,
                    deal?.deal.bestPrice ?? 0,
                  )
                : Math.max(
                    acc.get(symbol) ?? 0,
                    deal?.deal.bestPrice ?? Infinity,
                  ),
            )
            return acc
          },
          new Map<string, number>(),
        )

        const stopLossMin = [...this.dealsForStopLoss.entries()].reduce(
          (acc, [k, v]) => {
            const deal = this.getDeal(k)
            const symbol = deal?.deal.symbol.symbol ?? ''
            acc.set(
              symbol,
              this.isLong
                ? Math.max(acc.get(symbol) ?? 0, v)
                : Math.min(acc.get(symbol) ?? Infinity, v),
            )
            return acc
          },
          new Map<string, number>(),
        )
        const indicatorUnpnlMin = [
          ...this.dealsForIndicatorUnpnl.entries(),
        ].reduce((acc, [k, v]) => {
          const deal = this.getDeal(k)
          const symbol = deal?.deal.symbol.symbol ?? ''
          acc.set(
            symbol,
            this.isLong
              ? Math.max(acc.get(symbol) ?? 0, v.min)
              : Math.min(acc.get(symbol) ?? Infinity, v.min),
          )
          return acc
        }, new Map<string, number>())
        const indicatorUnpnlMax = [
          ...this.dealsForIndicatorUnpnl.entries(),
        ].reduce((acc, [k, v]) => {
          const deal = this.getDeal(k)
          const symbol = deal?.deal.symbol.symbol ?? ''
          acc.set(
            symbol,
            this.isLong
              ? Math.max(acc.get(symbol) ?? 0, v.max)
              : Math.min(acc.get(symbol) ?? Infinity, v.max),
          )
          return acc
        }, new Map<string, number>())
        const tpLevelMin = [...this.dealsForTPLevelCheck.entries()].reduce(
          (acc, [k, v]) => {
            const deal = this.getDeal(k)
            const symbol = deal?.deal.symbol.symbol ?? ''
            acc.set(
              symbol,
              this.isLong
                ? Math.min(acc.get(symbol) ?? Infinity, v)
                : Math.max(acc.get(symbol) ?? 0, v),
            )
            return acc
          },
          new Map<string, number>(),
        )
        const dcaByMarketMax = [...this.dealsDCAByMarket.entries()].reduce(
          (acc, [k, v]) => {
            const deal = this.getDeal(k)
            const symbol = deal?.deal.symbol.symbol ?? ''
            acc.set(
              symbol,
              this.isLong
                ? Math.max(acc.get(symbol) ?? 0, v)
                : Math.min(acc.get(symbol) ?? Infinity, v),
            )
            return acc
          },
          new Map<string, number>(),
        )
        if (this.isLong) {
          const slKeys = [
            ...stopLossMin.keys(),
            ...indicatorUnpnlMin.keys(),
            ...dcaByMarketMax.keys(),
          ]
          for (const key of slKeys) {
            this.highestLow.set(
              key,
              Math.max(
                stopLossMin.get(key) ?? 0,
                indicatorUnpnlMin.get(key) ?? 0,
                dcaByMarketMax.get(key) ?? 0,
              ),
            )
          }
          this.highestLow.forEach((_, k) => {
            if (!slKeys.includes(k)) {
              this.handleDebug(`Remove ${k} from highest low`)
              this.highestLow.delete(k)
            }
          })
          const otherKeys = [
            ...bestPrices.keys(),
            ...dealsForMoveSlMin.keys(),
            ...trailingTpMin.keys(),
            ...indicatorUnpnlMax.keys(),
            ...tpLevelMin.keys(),
          ]
          for (const key of otherKeys) {
            this.lowestHigh.set(
              key,
              Math.min(
                bestPrices.get(key) ?? Infinity,
                dealsForMoveSlMin.get(key) ?? Infinity,
                trailingTpMin.get(key) ?? Infinity,
                indicatorUnpnlMax.get(key) ?? Infinity,
                tpLevelMin.get(key) ?? Infinity,
              ),
            )
          }
          this.lowestHigh.forEach((_, k) => {
            if (!otherKeys.includes(k)) {
              this.handleDebug(`Remove ${k} from lowest high`)
              this.lowestHigh.delete(k)
            }
          })
          this.handleLog(
            `Lowest high: ${[...this.lowestHigh.entries()]
              .map(([k, v]) => `${k}: ${v.toFixed(8)}`)
              .join(', ')}`,
          )
          this.handleLog(
            `Highest low: ${[...this.highestLow.entries()]
              .map(([k, v]) => `${k}: ${v.toFixed(8)}`)
              .join(', ')}`,
          )
        } else {
          const slKeys = [
            ...stopLossMin.keys(),
            ...indicatorUnpnlMin.keys(),
            ...dcaByMarketMax.keys(),
          ]
          for (const key of slKeys) {
            this.lowestHigh.set(
              key,
              Math.min(
                dcaByMarketMax.get(key) ?? Infinity,
                stopLossMin.get(key) ?? Infinity,
                indicatorUnpnlMin.get(key) ?? Infinity,
              ),
            )
          }
          this.lowestHigh.forEach((_, k) => {
            if (!slKeys.includes(k)) {
              this.handleDebug(`Remove ${k} from lowest high`)
              this.lowestHigh.delete(k)
            }
          })
          const otherKeys = [
            ...bestPrices.keys(),
            ...dealsForMoveSlMin.keys(),
            ...trailingTpMin.keys(),
            ...indicatorUnpnlMax.keys(),
            ...tpLevelMin.keys(),
          ]
          for (const key of otherKeys) {
            this.highestLow.set(
              key,
              Math.max(
                bestPrices.get(key) ?? 0,
                dealsForMoveSlMin.get(key) ?? 0,
                trailingTpMin.get(key) ?? 0,
                indicatorUnpnlMax.get(key) ?? 0,
                tpLevelMin.get(key) ?? 0,
              ),
            )
          }
          this.highestLow.forEach((_, k) => {
            if (!otherKeys.includes(k)) {
              this.handleDebug(`Remove ${k} from highest low`)
              this.highestLow.delete(k)
            }
          })
          this.handleLog(
            `Lowest high: ${[...this.lowestHigh.entries()]
              .map(([k, v]) => `${k}: ${v.toFixed(8)}`)
              .join(', ')}`,
          )
          this.handleLog(
            `Highest low: ${[...this.highestLow.entries()]
              .map(([k, v]) => `${k}: ${v.toFixed(8)}`)
              .join(', ')}`,
          )
        }
      }
    }

    async checkDealSlMethods(deal: FullDeal<ExcludeDoc<Deal>>) {
      await this.setDealForMoveSl(deal)
      await this.setDealForTrailing(deal)
      await this.setDealForStopLoss(deal)
      await this.setDealForIndicatorUnpnl(deal)
      this.setDealForDCALevelCheck(deal)
      await this.setDealForDCAByMarketCheck(deal)
      await this.setDealForTPLevelCheck(deal)
    }

    async checkDealsAllowedMethods() {
      if (this.isBotForIndicatorUnpnl) {
        this.allowedMethods.add('checkIndicatorUnpnl')
      } else {
        this.allowedMethods.delete('checkIndicatorUnpnl')
      }

      const activeDeals = this.getOpenDeals()
      let sl = 0
      let countDCALevelCheck = 0
      let tp = 0
      let dcaByMarket = 0
      for (const d of activeDeals) {
        if (await this.isDealForStopLoss(d)) {
          sl++
        }
        if (this.isDealForDCALevelCheck(d)) {
          countDCALevelCheck++
        }
        if (await this.isDealForTPLevelCheck(d)) {
          tp++
        }
        if (await this.isDealForDCAByMarketCheck(d)) {
          dcaByMarket++
        }
      }
      if (activeDeals.length && sl) {
        this.allowedMethods.add('checkDealsStopLoss')
      } else {
        this.allowedMethods.delete('checkDealsStopLoss')
      }
      let msl = 0
      for (const d of activeDeals) {
        if (await this.isDealForMoveSl(d)) {
          msl++
        }
      }
      if (activeDeals.length && msl) {
        this.allowedMethods.add('checkDealsMoveSL')
      } else {
        this.allowedMethods.delete('checkDealsMoveSL')
      }
      let trailing = 0
      for (const d of activeDeals) {
        if (await this.isDealForTrailing(d)) {
          trailing++
        }
      }
      if (activeDeals.length && trailing) {
        this.allowedMethods.add('checkTrailing')
      } else {
        this.allowedMethods.delete('checkTrailing')
      }
      if (activeDeals.length && countDCALevelCheck) {
        this.allowedMethods.add('checkDCALevel')
      } else {
        this.allowedMethods.delete('checkDCALevel')
      }
      if (activeDeals.length && tp) {
        this.allowedMethods.add('checkTPLevel')
      } else {
        this.allowedMethods.delete('checkTPLevel')
      }
      if (activeDeals.length && dcaByMarket) {
        this.allowedMethods.add('checkDCAByMarketLevel')
      } else {
        this.allowedMethods.delete('checkDCAByMarketLevel')
      }
      this.handleDebug(
        `Check deals allowed methods: ${[...this.allowedMethods].join(', ')}`,
      )
      await this.checkDealsForStopLossMethods()
      this.checkDealsPriceExtremum()
    }

    hasAllowedStopLossMethods() {
      return (
        this.allowedMethods.has('checkDealsMoveSL') ||
        this.allowedMethods.has('checkTrailing') ||
        this.allowedMethods.has('checkDealsStopLoss') ||
        this.allowedMethods.has('checkIndicatorUnpnl') ||
        this.allowedMethods.has('checkTPLevel') ||
        this.allowedMethods.has('checkDCAByMarketLevel')
      )
    }

    async checkAllowedMethods() {
      const settingsCommon = await this.getAggregatedSettings()
      if (
        ((settingsCommon.useCloseAfterX &&
          settingsCommon.closeAfterX &&
          checkNumber(settingsCommon.closeAfterX)) ||
          (settingsCommon.useCloseAfterXloss &&
            settingsCommon.closeAfterXloss &&
            checkNumber(settingsCommon.closeAfterXloss)) ||
          (settingsCommon.useCloseAfterXwin &&
            settingsCommon.closeAfterXwin &&
            checkNumber(settingsCommon.closeAfterXwin)) ||
          (settingsCommon.useCloseAfterXprofit &&
            settingsCommon.closeAfterXprofitCond &&
            settingsCommon.closeAfterXprofitValue &&
            checkNumber(settingsCommon.closeAfterXprofitValue))) &&
        settingsCommon.useBotController &&
        this.data?.status !== BotStatusEnum.closed
      ) {
        this.allowedMethods.add('checkClosedDeals')
      } else {
        this.allowedMethods.delete('checkClosedDeals')
      }
      if (
        this.data &&
        !this.data?.paperContext &&
        !(
          this.data.settings.type === DCATypeEnum.terminal &&
          this.data.settings.terminalDealType === TerminalDealTypeEnum.simple
        )
      ) {
        this.allowedMethods.add('sendDealClosedAlert')
        this.allowedMethods.add('sendDealOpenedAlert')
        this.allowedMethods.add('sendEightyAlert')
        this.allowedMethods.add('sendHundredAlert')
      } else {
        this.allowedMethods.delete('sendDealClosedAlert')
        this.allowedMethods.delete('sendDealOpenedAlert')
        this.allowedMethods.delete('sendEightyAlert')
        this.allowedMethods.delete('sendHundredAlert')
      }
      if (
        settingsCommon.useDynamicPriceFilter &&
        settingsCommon.dynamicPriceFilterDeviation &&
        !isNaN(+settingsCommon.dynamicPriceFilterDeviation) &&
        isFinite(+settingsCommon.dynamicPriceFilterDeviation)
      ) {
        this.allowedMethods.add('checkInDynamicRange')
      } else {
        this.allowedMethods.delete('checkInDynamicRange')
      }
      if (!(settingsCommon.useMulti && !settingsCommon.useDynamicPriceFilter)) {
        this.allowedMethods.add('checkInRange')
      } else {
        this.allowedMethods.delete('checkInRange')
      }
      if (
        settingsCommon.useMulti &&
        settingsCommon.maxDealsPerPair &&
        settingsCommon.maxDealsPerPair !== '' &&
        !isNaN(+settingsCommon.maxDealsPerPair) &&
        +settingsCommon.maxDealsPerPair > 0
      ) {
        this.allowedMethods.add('checkMaxDealsPerPair')
      } else {
        this.allowedMethods.delete('checkMaxDealsPerPair')
      }
      if (
        (settingsCommon.maxNumberOfOpenDeals &&
          settingsCommon.maxNumberOfOpenDeals !== '' &&
          !isNaN(+settingsCommon.maxNumberOfOpenDeals) &&
          +settingsCommon.maxNumberOfOpenDeals > 0) ||
        this.allowedMethods.has('checkMaxDealsPerPair')
      ) {
        this.allowedMethods.add('checkMaxDeals')
      } else {
        this.allowedMethods.delete('checkMaxDeals')
      }
      if (
        settingsCommon.useMinTP &&
        settingsCommon.dealCloseCondition &&
        [CloseConditionEnum.techInd, CloseConditionEnum.webhook].includes(
          settingsCommon.dealCloseCondition,
        ) &&
        settingsCommon.minTp &&
        checkNumber(settingsCommon.minTp)
      ) {
        this.allowedMethods.add('checkMinTp')
      } else {
        this.allowedMethods.delete('checkMinTp')
      }
      if (
        !this.allowedMethods.has('checkMinTp') &&
        this.isBotForIndicatorUnpnl
      ) {
        this.allowedMethods.add('checkMinTp')
      } else {
        const { foundInSl, foundInTp } = this.getIndicatorUnpnlValues()
        if (foundInSl || foundInTp) {
          this.allowedMethods.add('checkMinTp')
        }
      }
      if (
        settingsCommon.useBotController &&
        settingsCommon.useCloseAfterXopen &&
        settingsCommon.closeAfterXopen &&
        !checkNumber(settingsCommon.closeAfterXopen) &&
        this.data?.status !== BotStatusEnum.closed
      ) {
        this.allowedMethods.add('checkOpenedDeals')
      } else {
        this.allowedMethods.delete('checkOpenedDeals')
      }
      if (
        settingsCommon.useMulti &&
        (settingsCommon.useVolumeFilter ||
          settingsCommon.useRelativeVolumeFilter) &&
        settingsCommon.useVolumeFilterAll
      ) {
        this.allowedMethods.add('filterCoinsByVolume')
      } else {
        this.allowedMethods.delete('filterCoinsByVolume')
      }

      if (
        settingsCommon.useDynamicPriceFilter &&
        settingsCommon.dynamicPriceFilterDeviation &&
        !settingsCommon.useRiskReward &&
        settingsCommon.startCondition === StartConditionEnum.asap
      ) {
        this.allowedMethods.add('checkDynamic')
      } else {
        this.allowedMethods.delete('checkDynamic')
      }
      await this.checkDealsAllowedMethods()
      this.handleDebug(
        `Allowed methods: ${Array.from(this.allowedMethods).join(', ')}`,
      )
    }
    protected async checkSettingsPairs() {
      if (!this.data || !this.shouldContinueLoad() || !this.shouldProceed()) {
        return
      }
      const notFound: string[] = []
      let first = false
      let i = 0
      for (const pair of this.data.settings.pair) {
        if (await this.confirmPairMissing(pair)) {
          // Never strip a pair that still has an open deal. Exchange info can go
          // missing transiently (resume-herd DB blip) or permanently (delist);
          // either way a live position must keep its pair — orphaning it drops
          // the deal's fee/price display in the UI and desyncs settings.pair
          // from reality. A user may delete a pair and leave its deal running,
          // and the engine must respect the same invariant, not do it silently.
          if (this.getOpenDeals(false, pair).length) {
            this.handleWarn(
              `Pair ${pair} missing from exchange info but has an open deal — keeping it in settings`,
            )
          } else {
            first = i === 0
            this.handleLog(`Pair ${pair} not found in exchange info`)
            notFound.push(pair)
          }
        }
        i++
      }
      if (notFound.length) {
        this.handleLog(`Removing pairs not found: ${notFound.join(', ')}`)
        this.data.settings.pair = this.data.settings.pair.filter(
          (p) => !notFound.includes(p),
        )
        this.updateData({ settings: this.data.settings })
        notFound.forEach((p) => this.pairsNotFound.add(p))
        if (first) {
          this.calculateUsage()
        }
      }
    }
    /**
     * Start bot<br />
     *
     * Call {@link DCABotHelper#loadData} to load bot data from db, create exchange provider<br />
     *
     * Call {@link DCABotHelper#loadOrders} to load bot order from db<br />
     *
     * Call {@link DCABotHelper#fillExchangeInfo} to get symbol data from exchange<br />
     *
     * Call {@link DCABotHelper#cancelAllOrder} to cancel all previous orders to prevent overwriting new orders<br />
     *
     * Call {@link DCABotHelper#getUserFees} to get current fee for user for bot pair<br />
     *
     * Call {@link DCABotHelper#getActiveOrders} to get active orders for bot pair, to check if bot not exceed the limit of orders<br />
     *
     * Call {@link DCABotHelper#connectAccountStream} to set callback to user account stream<br />
     *
     * Call {@link DCABotHelper#checkAssets} to set user asstes to {@link DCABotHelper#userFee}<br />
     *
     * If bot status open - if working shift not started - run new working shift, save changes to db, send update via {@link DCABotHelper#ioUpdate}  <br />
     */

    async start(
      reload = false,
      restart = false,
      realStatus?: BotStatusEnum,
      _skipAvailable?: boolean,
    ): Promise<void> {
      const _id = this.startMethod('start')
      if (this.botId && this.db) {
        await this.db.updateData({ _id: this.botId }, { locked: true })
      }
      this.finishLoad = false
      this.startTime = +new Date()
      this.clearClassProperties(undefined, true)

      const data = await this.loadData(
        (data: DCABotSchema) => data.deals.active > 0,
        realStatus,
      )
      const wasServiceRestart = !!this.serviceRestart
      this.ignoreRestartStats = false
      const unlock = async () => {
        if (this.botId && this.db) {
          await this.db.updateData({ _id: this.botId }, { locked: false })
        }
      }
      if (data) {
        this.serviceRestart = false
        this.loadingComplete = true
        this.finishLoad = true
        // `loadData` refused to start (pre-start position checks: leverage,
        // margin type or side of an existing venue position disagrees with the
        // settings). It has already reported the reason, but the bot is now
        // stopped and nothing said so — the event log's last line stayed
        // "open status is set" while the bot sat closed and never retried, so
        // a hedge leg that never opened a single deal looked merely idle.
        // Record the transition; the preceding warning carries the reason.
        if (this.shouldProceed()) {
          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event: BOT_STATUS_EVENT,
            botType: this.botType,
            description: `${this.data?.status ?? 'open'} -> ${
              BotStatusEnum.closed
            }: the bot could not start, see the preceding warning for the reason. It will not retry on its own - fix the cause and start it again.`,
            paperContext: !!this.data?.paperContext,
            type: MessageTypeEnum.warning,
          })
        }
        await unlock()
        this.endMethod(_id)
        return await this.stop()
      }
      if (this.data) {
        //@ts-ignore
        this.data =
          this.botType === BotType.dca
            ? convertDCABot(this.data)
            : //@ts-ignore
              convertComboBot(this.data)
        this.setStatsTimer()
      }
      if (this.data?.status === BotStatusEnum.archive) {
        this.loadingComplete = true
        this.serviceRestart = false
        this.finishLoad = true
        this.endMethod(_id)
        return await this.stop()
      }
      if (this.data?.exchangeUnassigned) {
        this.handleErrors(`Bot exchange unassigned. Bot will stop`, 'start')
        this.loadingComplete = true
        this.serviceRestart = false
        this.finishLoad = true
        await unlock()
        this.endMethod(_id)
        return await this.stop()
      }
      try {
        await this.setClassProperties()
        this.useMonitoring =
          this.isMonitoring &&
          (((wasServiceRestart || restart) &&
            this.data?.status === BotStatusEnum.monitoring) ||
            this.data?.status === BotStatusEnum.closed ||
            (this.data?.status === BotStatusEnum.error &&
              this.data.previousStatus === BotStatusEnum.monitoring))
        this.handleLog(`Bot use monitoring ${this.useMonitoring}`)
        const settings = await this.getAggregatedSettings()
        if (settings.limitTimeout && settings.useLimitTimeout) {
          let timeout = parseFloat(settings.limitTimeout || '0') * 1000
          timeout = isNaN(timeout) ? 0 : timeout
          this.enterMarketTimeout = timeout
          if (
            this.enterMarketTimeout < this.orderLimitRepositionTimeout &&
            this.enterMarketTimeout !== 0
          ) {
            this.orderLimitRepositionTimeout = 0
          }
        }
        if (this.data) {
          if (this.data.status === BotStatusEnum.closed && reload) {
            this.data.status = BotStatusEnum.closed
          } else if (
            this.data.status === BotStatusEnum.error &&
            reload &&
            this.data.previousStatus
          ) {
            this.data.status = this.data.previousStatus ?? this.data.status
            this.updateData({ status: this.data.status })
            this.emit('bot settings update', { status: this.data.status })
          } else {
            this.data.status = this.useMonitoring
              ? BotStatusEnum.monitoring
              : BotStatusEnum.open
          }
        }
        await this.fillExchangeInfo()

        await this.getUserFees()
        await this.loadOrders()
        await this.checkAllowedMethods()
        await this.checkSettingsPairs()
        if (this.pairsNotFound.size) {
          // A pair with an open deal must never be auto-removed or have its
          // deals force-closed here — a live position keeps its pair even when
          // the exchange info is missing (transient blip or genuine delist). A
          // delisted pair with an open deal simply won't have a live price,
          // which is inherent; orphaning or cancelling it is the worse outcome.
          // Only pairs with no open deal are eligible for removal / bot-stop.
          const removablePairs = [...this.pairsNotFound].filter(
            (p) => this.getOpenDeals(false, p).length === 0,
          )
          for (const p of this.pairsNotFound) {
            if (!removablePairs.includes(p)) {
              this.handleWarn(
                `Exchange info missing for ${p} but it has an open deal — keeping pair and deal`,
              )
            }
          }
          if (removablePairs.length) {
            if (
              this.data?.settings.useMulti &&
              this.data.settings.pair.length > 1 &&
              removablePairs.length < this.data.settings.pair.length
            ) {
              for (const p of removablePairs) {
                this.handleWarn(
                  `Exchange info not found for ${p}. Will close all deals`,
                )
                this.data.settings.pair = this.data.settings.pair.filter(
                  (d) => d !== p,
                )
                this.ignoreErrors = true
                this.loadingComplete = true
                await this.updateData({ settings: this.data.settings })
                await this.closeAllDeals(
                  CloseDCATypeEnum.cancel,
                  p,
                  undefined,
                  undefined,
                  true,
                  undefined,
                  undefined,
                  DCACloseTriggerEnum.auto,
                )
                this.pairs.delete(p)
                this.loadingComplete = false
                this.ignoreErrors = false
              }
            } else {
              this.handleWarn(`Exchange info not found. Bot will stop`)
              this.loadingComplete = true
              await this.stop(CloseDCATypeEnum.cancel)
              this.loadingComplete = false
              this.serviceRestart = false
              if (this.data) {
                this.data.status = BotStatusEnum.closed
                this.ignoreErrors = true
                await this.updateData({ status: this.data.status })
                this.emit('bot settings update', { status: this.data.status })
                this.ignoreErrors = false
                this.finishLoad = true
                this.endMethod(_id)
                return
              }
            }
          }
        }
        this.loadingComplete = true
        await this.runAfterLoading()
        await this.restoreWork()
        if (
          this.data &&
          (this.data.status === 'open' || this.data?.status === 'monitoring')
        ) {
          const lastShift =
            this.data.workingShift[this.data.workingShift.length - 1]
          if (lastShift && lastShift.end) {
            this.data.workingShift = [
              ...this.data.workingShift,
              { start: new Date().getTime() },
            ]
          }
          if (!lastShift) {
            this.data.workingShift = [
              {
                start: new Date().getTime(),
              },
            ]
          }
          const data = {
            status: this.data.status,
            workingShift: this.trimWorkingShift(this.data.workingShift),
            workingTimeNumber: this.getWorkingTimeNumber(),
          }
          this.updateData(data)
          this.emit('bot settings update', data)
        }
        this.startPriceTimer()
        this.startConsumerHeartbeat()
        this.finishLoad = true
      } catch (e) {
        this.serviceRestart = false
        this.handleErrors(
          `Get error during bot start ${(e as Error)?.message}`,
          'start',
          '',
          false,
          false,
          false,
        )
        logger.error(e)
      }
      this.finishLoad = true
      this.secondRestart = true
      this.reload = false
      this.keepOrders = false
      await unlock()
      this.endMethod(_id)
    }

    async afterBotStop() {
      this.stopPriceTimer()
      this.stopConsumerHeartbeat()
      this.stopQuantRulesRetries()
      return
    }
    /**
     * Stop work<br />
     *
     * Call {@link DCABotHelper#cancelAllOrder} to cancel all active orders<br />
     *
     * If swap order not filled - cancel swap order<br/>
     *
     * Close bot working shift<br />
     *
     * Send update via {@link DCABotHelper#ioUpdate}
     *
     * Unsubscribe from {@link DCABotHelper#ioUser} & {@link DCABotHelper#ioPrice}
     *
     * @param {CloseDCATypeEnum} [closeType] Close type
     */

    async stop(
      closeType?: CloseDCATypeEnum,
      forceClose = false,
      ignoreErrors = false,
    ): Promise<void> {
      try {
        this.ignoreErrors = ignoreErrors
        if (closeType) {
          this.handleLog(`Close by ${closeType}`)
        }
        if (closeType !== CloseDCATypeEnum.leave) {
          this.blockPriceCheck = true
        }
        for (const [id, timer] of this.openNewDealTimer.entries()) {
          clearInterval(timer)
          this.openNewDealTimer.delete(id)
        }
        let openDeals = this.getOpenDeals()
        for (const d of openDeals) {
          await this.clearDealTimer(d.deal._id)
        }

        const startDeals = openDeals.filter(
          (d) => d.deal.status === DCADealStatusEnum.start,
        )
        this.closeAfterTpFilled = true
        for (const d of startDeals) {
          await this.closeDealById(
            this.botId,
            d.deal._id,
            CloseDCATypeEnum.cancel,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            DCACloseTriggerEnum.bot,
          )
        }
        if (closeType && openDeals.length > 0) {
          if (closeType !== CloseDCATypeEnum.leave) {
            const activeDeals = openDeals.filter(
              (d) => d.deal.status === DCADealStatusEnum.open,
            )
            for (const d of activeDeals) {
              await this.closeDealById(
                this.botId,
                d.deal._id,
                closeType,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                DCACloseTriggerEnum.bot,
              )
            }
          }
        }
        let userStreamClosed = false
        if (!closeType || openDeals.length === 0) {
          if (this.redisSubGlobal) {
            for (const pair of await this.redisSubKeys([...this.pairs])) {
              this.redisSubGlobal.unsubscribe(pair, this.redisSubCb)
            }
          }
          this.closeUserStream()
          userStreamClosed = true
          this.deals = new Map()
          for (const i of this.indicators.values()) {
            await this.sendIndicatorUnsubscribeEvent(i.id, i.room, i.cb, false)
          }
          if (this.data) {
            this.data.status = BotStatusEnum.closed
          }
        }
        if (this.timer) {
          clearTimeout(this.timer)
        }
        if (this.equityTimer && closeType !== CloseDCATypeEnum.leave) {
          clearTimeout(this.equityTimer)
        }
        if (this.statsTimer && closeType !== CloseDCATypeEnum.leave) {
          clearTimeout(this.statsTimer)
        }
        if (closeType === CloseDCATypeEnum.cancel) {
          await this.afterBotStop()
        }
        openDeals = this.getOpenDeals()
        if (
          this.data?.status === BotStatusEnum.closed &&
          openDeals.length === 0
        ) {
          if (!userStreamClosed) {
            // The bot had an open deal when it was stopped, so the branch
            // above skipped the stream teardown; the deal has now closed and
            // the instance is about to be dropped by the worker. Release the
            // account channel listeners with it (core spec 002 §4.7).
            this.closeUserStream()
            userStreamClosed = true
          }
          for (const pair of this.pairs) {
            await this.unsubscribeFromExchangeInfo(pair)
            await this.unsubscribeFromUserFee(pair)
            await this.unsubscribeFromUser()
            await this.unsubscribeFromLastUsdData(`${pair}_base`)
            await this.unsubscribeFromLastUsdData(`${pair}_quote`)
            await this.unsubscribeFromLastStreamData(pair)
          }
          for (const _var of this.data.vars?.list ?? []) {
            await this.unsubscribeFromGlobalVars(_var)
          }
          this.clearClassProperties(true)
          this.sendBotClosed()
        }
        if (this.data) {
          const lastShift =
            this.data.workingShift[this.data.workingShift.length - 1]
          if (lastShift && !lastShift.end) {
            this.data.workingShift = [
              ...this.data.workingShift.filter(
                (w) => w.start !== lastShift.start,
              ),
              { ...lastShift, end: new Date().getTime() },
            ]
          }
          const data = {
            workingShift: this.trimWorkingShift(this.data.workingShift),
            workingTimeNumber: this.getWorkingTimeNumber(),
            status: BotStatusEnum.closed,
            action: undefined,
            previousStatus: undefined,
          }
          if (!forceClose) {
            this.data = { ...this.data, ...data }
          }
          await this.updateData({ ...data })
          this.emit('bot settings update', data)
        }
      } catch (e) {
        this.handleErrors(
          `Get error during bot stop ${(e as Error)?.message}`,
          'stop',
          '',
          false,
          false,
          false,
        )
      }
    }

    private async baseSlOn(deal?: ExcludeDoc<Deal>) {
      if (this.combo) {
        return BaseSlOnEnum.avg
      }
      const key = deal?._id ?? 'bot'
      if (this.baseSlOnMap.has(key)) {
        return this.baseSlOnMap.get(key)
      }
      const settings = await this.getAggregatedSettings(deal)
      const result =
        (settings.trailingSl && !settings.useMultiSl) || settings.moveSL
          ? BaseSlOnEnum.avg
          : (settings.baseSlOn ?? BaseSlOnEnum.avg)
      this.baseSlOnMap.set(key, result)
      return result
    }
    /**
     * Check deals SL
     */

    @IdMute(mutex, (botId: string, symbol) => `${botId}sl${symbol}`)
    async checkDealsStopLoss(_botId: string, symbol: string) {
      if (!this.allowedMethods.has('checkDealsStopLoss')) {
        return
      }
      if (this.lockSLCheck) {
        return
      }
      this.lockSLCheck = true
      for (const [deal, priceToClose] of this.dealsForStopLoss) {
        const d = this.getDeal(deal)
        if (
          !d ||
          d.closeBySl ||
          d.deal.blockSl ||
          d.notCheckSl ||
          d.deal.symbol.symbol !== symbol ||
          d.deal.status !== DCADealStatusEnum.open
        ) {
          continue
        }
        const lastStreamData = this.getLastStreamData(d.deal.symbol.symbol)
        const last = lastStreamData?.price
        if (!last) {
          continue
        }
        const {
          trailingSl,
          useSl,
          dealCloseConditionSL,
          trailingTp,
          useTp,
          dealCloseCondition,
          moveSL,
          useMultiSl,
          multiSl,
          useFixedSLPrices,
          fixedSlPrice,
          multiTp,
          slPerc,
          moveSLValue,
        } = await this.getAggregatedSettings(d.deal)
        const dealId = d.deal._id
        let closeBySl = true
        let notCheckSl = false
        let closeByMulti = false
        // Once moveSL has fired, `slPerc` is the move value — and a positive one
        // puts the stop on the PROFIT side of the average, so it can only be hit
        // by price coming BACK from profit. That makes it an EVENT (price trades
        // through the level), not a state (price is on the wrong side of it).
        // The bare level test below cannot tell the two apart, so whenever the
        // check resumes with the market already past the level — a worker
        // restart, a deal re-registered, a close that never completed — it is
        // true on the very first tick and closes the deal at whatever price is
        // current, booking a loss from a stop whose whole job was to lock a
        // profit. So remember which side of the level the last observed tick was
        // on, persisted on the deal so a restart cannot forget it, and require a
        // real crossing. Arming is always earned from a live tick: it is cleared
        // wherever the level can move (see `triggerMoveSl` and the settings
        // paths that touch `moveSlActivated`).
        const slMovedIntoProfit =
          !!moveSL &&
          !!d.deal.moveSlActivated &&
          +(slPerc ?? 0) === +(moveSLValue ?? 0) &&
          +(slPerc ?? 0) > 0
        const levelHit =
          (this.isLong && last <= priceToClose) ||
          (!this.isLong && last >= priceToClose)
        const close = slMovedIntoProfit
          ? levelHit && !!d.deal.moveSlArmed
          : levelHit
        if (slMovedIntoProfit && !!d.deal.moveSlArmed === levelHit) {
          d.deal.moveSlArmed = !levelHit
          await this.saveDeal(d, { moveSlArmed: d.deal.moveSlArmed }, false)
        }
        let trailing = false
        if (
          close &&
          ((trailingSl &&
            !useMultiSl &&
            !moveSL &&
            useSl &&
            dealCloseConditionSL === CloseConditionEnum.tp) ||
            (trailingTp &&
              useTp &&
              !multiTp &&
              dealCloseCondition === CloseConditionEnum.tp))
        ) {
          this.handleLog(
            `Trailing trigger mode: ${(
              d.deal.trailingMode ?? ''
            ).toUpperCase()}, level: ${
              d.deal.trailingLevel
            }, price: ${last}, deal: ${dealId}`,
          )
          trailing = true
        } else if (
          close &&
          useSl &&
          (!trailingSl || useMultiSl) &&
          (dealCloseConditionSL === CloseConditionEnum.tp ||
            (moveSL &&
              d.deal.moveSlActivated &&
              +(slPerc ?? 0) === +(moveSLValue ?? 0)))
        ) {
          if (
            useMultiSl &&
            multiSl?.length &&
            dealCloseConditionSL === CloseConditionEnum.tp
          ) {
            const inUseSl = multiSl.filter(
              (t) => !d.deal.tpSlTargetFilled?.includes(t.uuid),
            )
            if (inUseSl.length > 1) {
              closeBySl = false
              notCheckSl = true
            }
            closeByMulti = true
          }
          const lastStreamData = this.getLastStreamData(d.deal.symbol.symbol)
          const last = lastStreamData?.price
          if (close && useFixedSLPrices && fixedSlPrice) {
            this.handleLog(
              `Deal: ${dealId} closing by stop loss. SL set: ${fixedSlPrice}, Price current : ${last}`,
            )
          } else {
            this.handleLog(
              `Deal: ${dealId} closing by stop loss. SL set: ${priceToClose}, SL surrent : ${last}`,
            )
          }
        } else if (
          close &&
          this.slAr &&
          useSl &&
          dealCloseConditionSL === CloseConditionEnum.dynamicAr
        ) {
          this.handleLog(
            `Deal: ${dealId} closing by stop loss. SL price: ${priceToClose}, current price : ${last}`,
          )
        }
        if (close) {
          this.triggerStopLoss(
            dealId,
            closeBySl,
            notCheckSl,
            closeByMulti,
            trailing ? DCACloseTriggerEnum.trailing : DCACloseTriggerEnum.sl,
          )
        }
      }
      this.lockSLCheck = false
    }

    @IdMute(mutex, (botId: string, symbol) => `${botId}indicatorUnpnl${symbol}`)
    async checkDealsIndicatorUnpnl(_botId: string, symbol: string) {
      if (!this.allowedMethods.has('checkIndicatorUnpnl')) {
        return
      }
      if (this.lockSLCheck) {
        return
      }
      this.lockSLCheck = true
      for (const [deal, { min, max }] of this.dealsForIndicatorUnpnl) {
        const d = this.getDeal(deal)
        if (
          !d ||
          d.closeBySl ||
          d.deal.blockSl ||
          d.notCheckSl ||
          d.deal.symbol.symbol !== symbol ||
          d.deal.status !== DCADealStatusEnum.open
        ) {
          continue
        }
        const lastStreamData = this.getLastStreamData(d.deal.symbol.symbol)
        const last = lastStreamData?.price
        if (!last) {
          continue
        }
        const dealId = d.deal._id
        const close =
          (this.isLong && (last >= max || last <= min)) ||
          (!this.isLong && (last <= max || last >= min))
        if (close) {
          this.handleLog(
            `Close deal by indicator unpnl required min: ${min}, required max: ${max}, current price: ${last}`,
          )
        }
        if (close) {
          d.closeBySl = true
          d.notCheckSl = true
          this.saveDeal(d)
          this.closeDealById(
            this.botId,
            dealId,
            CloseDCATypeEnum.closeByMarket,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            DCACloseTriggerEnum.indicator,
          )
        }
      }
      this.lockSLCheck = false
    }

    @IdMute(mutex, (botId: string, symbol: string) => `${botId}moveSl${symbol}`)
    async checkDealsMoveSL(_botId: string, symbol: string) {
      if (!this.allowedMethods.has('checkDealsMoveSL')) {
        return
      }
      if (this.lockSLCheck) {
        return
      }
      this.lockSLCheck = true
      for (const [d, required] of this.dealsForMoveSl) {
        const deal = this.getDeal(d)
        if (
          !deal ||
          deal.closeBySl ||
          deal.deal.symbol.symbol !== symbol ||
          deal.deal.status !== DCADealStatusEnum.open
        ) {
          continue
        }
        const lastStreamData = this.getLastStreamData(deal.deal.symbol.symbol)
        const last = lastStreamData?.price
        if (!last) {
          continue
        }
        if (
          (this.isLong && last >= required) ||
          (!this.isLong && last <= required)
        ) {
          this.dealsForMoveSl.delete(d)
          await this.triggerMoveSl(d, required, last)
        }
      }

      this.lockSLCheck = false
    }
    /** Set price timer */

    startPriceTimer() {
      if (this.priceTimer) {
        clearTimeout(this.priceTimer)
      }
      this.priceTimer = setInterval(
        () => this.priceTimerFn(this.data?.exchange),
        this.priceTimeout,
      )
    }
    /** Stop price timer */

    stopPriceTimer() {
      if (this.priceTimer) {
        clearTimeout(this.priceTimer)
      }
    }
    /** Check if price not update */

    @IdMute(
      mutex,
      (exchange?: ExchangeEnum) =>
        `${removePaperFormExchangeName(
          exchange ?? ExchangeEnum.binance,
        )}priceTimerFn`,
    )
    async priceTimerFn(_exchange?: ExchangeEnum) {
      const symbols: Set<string> = new Set()
      for (const d of this.getDealsByStatusAndSymbol({
        status: DCADealStatusEnum.open,
      }).filter((d) => !d.closeBySl && !d.deal.blockSl && !d.notCheckSl)) {
        const symbol = d.deal.symbol.symbol
        const lastStreamData = this.getLastStreamData(d.deal.symbol.symbol)
        const time = lastStreamData?.time ?? 0
        if (+new Date() - time < this.priceTimeout) {
          continue
        }
        this.handleDebug(
          `Last update time for ${symbol} is ${new Date(
            time,
          ).toISOString()}, more then ${this.priceTimeout / 1000 / 60}m`,
        )
        symbols.add(symbol)
      }
      if (this.exchange && symbols.size) {
        this.handleDebug(
          `Required prices for ${symbols.size} symbols in price timer`,
        )
        const allPrices = await this.exchange?.getAllPrices(true)
        this.handleDebug(`Get all prices in price timer`)
        if (allPrices.status === StatusEnum.ok) {
          const prices = allPrices.data.filter((p) => symbols.has(p.pair))
          for (const p of prices) {
            this.priceUpdateCallback(this.botId, {
              symbol: p.pair,
              price: p.price,
              time: +new Date(),
              volume: 0,
            })
          }
        }
      }
    }
    /** Check trailing conditions */
    @IdMute(
      mutex,
      (botId: string, symbol: string) => `${botId}trailing${symbol}`,
    )
    async checkTrailing(_botId: string, _symbol: string) {
      if (!this.allowedMethods.has('checkTrailing')) {
        return
      }
      if (!this.data) {
        return
      }
      for (const [deal, data] of this.dealsForTrailing) {
        const { trailingTp, skipTp, trailingSl, skipSl, trailingTpPrice } = data
        const d = this.getDeal(deal)
        if (
          !d ||
          d.closeBySl ||
          d.deal.blockSl ||
          d.notCheckSl ||
          d.deal.status !== DCADealStatusEnum.open
        ) {
          continue
        }
        const lastStreamData = this.getLastStreamData(d.deal.symbol.symbol)
        const last = lastStreamData?.price
        if (!last) {
          continue
        }
        const settings = await this.getAggregatedSettings(d.deal)
        const { trailingTpPerc, slPerc } = settings

        const old = {
          price: d.deal.bestPrice,
          mode: d.deal.trailingMode,
          level: d.deal.trailingLevel,
        }
        if (!d.deal.bestPrice) {
          d.deal.bestPrice = last
          this.handleDebug(
            `Trailing: Set initial best price: ${last}, deal: ${d.deal._id} `,
          )
        } else {
          if (
            (this.isLong && last > d.deal.bestPrice) ||
            (!this.isLong && last < d.deal.bestPrice)
          ) {
            d.deal.bestPrice = last
          }
        }
        if (!d.deal.trailingMode && trailingSl && !skipSl) {
          d.deal.trailingMode = TrailingModeEnum.tsl
          this.handleDebug(
            `Trailing: Set TSL trailing mode, deal: ${d.deal._id}, price: ${last} `,
          )
        }
        if (
          d.deal.trailingMode !== TrailingModeEnum.ttp &&
          trailingTp &&
          !skipTp &&
          trailingTpPrice
        ) {
          if (
            (this.isLong && last >= trailingTpPrice) ||
            (!this.isLong && last <= trailingTpPrice)
          ) {
            d.deal.trailingMode = TrailingModeEnum.ttp
            this.handleDebug(
              `Trailing: Set TTP trailing mode, deal: ${d.deal._id}, price : ${last}, deal trailing tp price %: ${trailingTpPrice}, price ${last} `,
            )
          }
        }
        if (
          old.price !== d.deal.bestPrice ||
          old.mode !== d.deal.trailingMode
        ) {
          const longMult = this.isLong ? 1 : -1
          d.deal.trailingLevel =
            d.deal.trailingMode === TrailingModeEnum.tsl && slPerc
              ? last * (1 + (+slPerc / 100) * longMult)
              : d.deal.trailingMode === TrailingModeEnum.ttp && trailingTpPerc
                ? last * (1 - (+trailingTpPerc / 100) * longMult)
                : 0
        }
        if (
          d.deal.trailingLevel !== old.level ||
          old.price !== d.deal.bestPrice
        ) {
          await this.triggerTrailing(deal, last)
        }
      }
    }

    @IdMute(
      mutex,
      (botId: string, symbol: string) => `${botId}checkDynamic${symbol}`,
    )
    async checkDynamic(_botId: string, symbol: string, price: number) {
      if (this.data?.status === BotStatusEnum.closed) {
        return
      }
      if (
        !this.allowedMethods.has('checkDynamic') ||
        isNaN(price) ||
        !isFinite(price)
      ) {
        return
      }
      const settings = await this.getAggregatedSettings()
      const useDynamic = !!(
        settings.useDynamicPriceFilter &&
        settings.dynamicPriceFilterDeviation &&
        !settings.useRiskReward
      )
      if (useDynamic && settings.startCondition === StartConditionEnum.asap) {
        if (await this.checkInRange(symbol, price)) {
          const lastData = (this.data?.lastPricesPerSymbol ?? []).find(
            (d) => d.symbol === symbol,
          )
          this.handleDebug(
            `Price ${price} in range for ${symbol}. Last data: avg - ${lastData?.avg}, entry - ${lastData?.entry}, time - ${lastData?.time}`,
          )
          await this.openNewDeal(this.botId, symbol, true, true, +new Date())
        }
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}checkDCALevel`)
    public async checkDCALevel(_botId: string, price: number, symbol: string) {
      if (!this.allowedMethods.has('checkDCALevel')) {
        return
      }
      for (const [d, v] of this.dealsDCALevelCheck) {
        if (!(this.isLong ? price <= v : price >= v)) {
          continue
        }
        const deal = this.getDeal(d)
        if (!deal || deal.deal.symbol.symbol !== symbol) {
          continue
        }
        const value = this.dealsDCALevelCheck.get(deal.deal._id)
        if (value) {
          const trigger = this.isLong ? price <= value : price >= value
          if (trigger) {
            this.handleDebug(
              `Deal: ${deal.deal._id} adding DCA level by DCA level check`,
            )
            const order = deal.currentOrders.find((o) => +o.price === value)
            if (!order) {
              return this.handleErrors(
                `Cannot find order for DCA level check`,
                'checkDCALevel',
                '',
                false,
                false,
                false,
              )
            }
            const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
            if (ed) {
              const fullOrder = this.convertGridToOrder(
                order,
                {
                  dealId: deal.deal._id,
                  type: 'LIMIT',
                },
                ed,
              )
              if (fullOrder) {
                fullOrder.status = 'FILLED'
                fullOrder.executedQty = fullOrder.origQty
                this.setOrder(fullOrder)
                this.ordersDb.createData(fullOrder)
                return await this.updateDeal(this.botId, fullOrder)
              }
            }
          }
        }
      }
    }

    @IdMute(mutex, (botId: string) => `${botId}checkDCAByMarketLevel`)
    public async checkDCAByMarketLevel(
      _botId: string,
      price: number,
      symbol: string,
    ) {
      if (!this.allowedMethods.has('checkDCAByMarketLevel')) {
        return
      }
      for (const [d, v] of this.dealsDCAByMarket) {
        const key = `${v}@${d}`
        if (this.dealsByMarketProcessing.has(key)) {
          this.handleDebug(
            `DCA By Market level ${v} for deal ${d} already processing`,
          )
          continue
        }
        if (!(this.isLong ? price <= v : price >= v)) {
          continue
        }
        const deal = this.getDeal(d)
        if (!deal || deal.deal.symbol.symbol !== symbol) {
          continue
        }
        const value = this.dealsDCAByMarket.get(deal.deal._id)
        if (value) {
          const trigger = this.isLong ? price <= value : price >= value
          if (trigger) {
            this.handleDebug(
              `Deal: ${deal.deal._id} adding DCA level by DCA By Market check`,
            )
            const order = deal.currentOrders.find((o) => +o.price === value)
            if (!order) {
              this.handleErrors(
                `Cannot find order for DCA By Market level check ${value}, deal ${deal.deal._id}, orders count ${deal.currentOrders.length}`,
                'checkDCAByMarketLevel',
                '',
                false,
                false,
                false,
              )
              continue
            }
            const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
            if (ed) {
              this.dealsByMarketProcessing.add(key)
              const orderPrepared = this.convertGridToOrder(
                order,
                {
                  dealId: deal.deal._id,
                  type: 'MARKET',
                  // A hedge-mode futures account rejects an order whose
                  // position side does not name the leg. Omitting positionSide
                  // here left it undefined through `convertGridToOrder`, so the
                  // connector fell back to the one-way default ('net' on OKX)
                  // and the venue rejected this DCA-by-market safety order —
                  // OKX 51000 "Parameter posSide error", Binance USDM -4061
                  // "Order's position side does not match user's setting" —
                  // while the base order and TP, which do pass it, filled
                  // normally, so the deal opened and then stopped averaging
                  // down. Same expression the regular safety-order path uses
                  // (`sendGridToExchange` in `checkOrders`) and the sibling
                  // TP-by-market call below. Non-hedge accounts are unaffected:
                  // BOTH maps to the same 'net' that undefined did.
                  positionSide: this.hedge
                    ? this.isLong
                      ? PositionSide.LONG
                      : PositionSide.SHORT
                    : PositionSide.BOTH,
                },
                ed,
              )
              if (!orderPrepared) {
                this.handleDebug(
                  `DCA By Market level ${value} for deal ${d} cannot prepare order. Skipping remove from processing set.`,
                )
                continue
              }
              const orderResult = await this.sendOrderToExchange(
                orderPrepared,
                true,
              )
              if (!orderResult || typeof orderResult === 'string') {
                this.handleDebug(
                  `DCA By Market level ${value} for deal ${d} processed with error ${orderResult}. Skipping remove from processing set.`,
                )
                if (typeof orderResult === 'string') {
                  const setError = this.needToSendOrder(orderPrepared)
                  this.handleOrderErrors(
                    orderResult,
                    orderPrepared,
                    'limitOrders()',
                    `Send new order request ${orderPrepared.clientOrderId}, qty ${orderPrepared.origQty}, price ${orderPrepared.price}, side ${orderPrepared.side}`,
                    setError,
                    setError,
                  )
                  continue
                }
              }
              if (orderResult && typeof orderResult !== 'string') {
                this.dealsByMarketProcessing.delete(key)
              }
              if (
                orderResult &&
                typeof orderResult !== 'string' &&
                orderResult.status === 'FILLED'
              ) {
                this.processFilledOrder(orderResult)
              }
            }
          }
        }
      }
    }

    /**
     * Settle a deal whose venue position has vanished. Spec
     * `specs/005.zombie-deal-venue-position-reconciliation.md` (issue #630).
     *
     * `closeDealById` has reconciled this since the combo base-minigrid case
     * (the `isPositionAlreadyClosedReason` branch below), but a multi-TP deal
     * never goes through it — it closes target by target from `checkTPLevel`,
     * which could only ever schedule another attempt. Three deals on bot
     * 69de6e9e10716872ece23ce8 stayed `open` from 2026-04-29 to 2026-09-04 that
     * way, re-arming every ~15 s against positions `paperFutures` had closed on
     * the day they opened.
     *
     * @returns true when the deal was booked closed and the caller must stop
     *   working it.
     */
    private async reconcileDealPosition(
      deal: FullDeal<ExcludeDoc<Deal>>,
      outcome: string,
    ): Promise<boolean> {
      const dealId = `${deal.deal._id}`
      const symbol = deal.deal.symbol.symbol
      if (!this.futures || !this.exchange) {
        // Spot has no position to reconcile against.
        return false
      }
      // One venue round trip per deal per cooldown, and only for a deal sitting
      // at a take-profit level it could not close. The probe — not a rejection —
      // is what opens the window here; that is safe because the window gates no
      // order, and a probe that finds the position clears it below.
      const probeCooldown = await positionProbeBackoff.check([
        this.botId,
        dealId,
      ])
      if (probeCooldown.suppressed) {
        return false
      }
      const probe = await positionProbeBackoff.record(
        [this.botId, dealId],
        outcome,
      )
      const positions = await this.exchange.futures_getPositions(symbol)
      const verdict = reconcileDealAgainstVenue(
        positions?.status === StatusEnum.ok && positions.data
          ? { kind: 'positions', positions: positions.data }
          : // A venue that did not answer must never settle a deal: closing one
            // whose position is in fact still open abandons it with no take
            // profit and no stop loss, which is worse than the deal being stuck.
            { kind: 'unavailable' },
        symbol,
        this.isLong ? 'LONG' : 'SHORT',
        !!this.hedge,
      )
      if (!verdict.closeDeal) {
        if (positions?.status === StatusEnum.ok) {
          // The position is there — any window opened by an earlier probe is
          // stale, so this cannot slide forward forever.
          await positionProbeBackoff.clear([this.botId, dealId])
        }
        this.handleDebug(
          `Deal ${dealId} TP level close ${outcome}; ${verdict.verdict} — leaving the deal open`,
        )
        return false
      }
      if (probe.attempt < 2) {
        // Two agreeing probes, five minutes apart, before booking a deal
        // closed. The cost is asymmetric: these deals have been gone for
        // months, so waiting one more window costs nothing, while acting on a
        // single `{status: ok, data: []}` from a venue mid-outage would abandon
        // a live position with no take profit and no stop loss. `clear()` above
        // resets the count the moment the position is seen again, so a real
        // divergence still converges on the next window.
        this.handleLog(
          `Deal ${dealId} TP level close ${outcome} and ${verdict.verdict} on ${this.data?.exchange} — waiting for a second reading before closing the deal`,
        )
        return false
      }
      this.handleLog(
        `Deal ${dealId} TP level close ${outcome} and ${verdict.verdict} on ${this.data?.exchange} (${probe.attempt} readings) — closing the deal instead of re-arming against a position that is gone`,
      )
      if (this.shouldProceed()) {
        this.botEventDb.createData({
          userId: this.userId,
          botId: this.botId,
          event: 'Deal',
          botType: this.botType,
          description: dealPositionGoneMessage({
            dealId,
            symbol,
            exchange: `${this.data?.exchange ?? ''}`,
          }),
          paperContext: !!this.data?.paperContext,
          deal: dealId,
          symbol,
          type: MessageTypeEnum.warning,
        })
      }
      await positionProbeBackoff.clear([this.botId, dealId])
      // The same primitive `closeDealById` uses for this condition: books the
      // deal closed keeping the P&L the filled targets already realised, with
      // no closing order — there is nothing to send one for.
      await this.closeDeal(this.botId, dealId)
      return true
    }

    @IdMute(mutex, (botId: string) => `${botId}checkTPLevel`)
    public async checkTPLevel(_botId: string, price: number, symbol: string) {
      if (!this.allowedMethods.has('checkTPLevel')) {
        return
      }
      for (const [d] of [...this.dealsForTPLevelCheck]) {
        const v = this.dealsForTPLevelCheck.get(d)
        if (!v) {
          continue
        }
        if (!(this.isLong ? price >= v : price <= v)) {
          this.handleDebug(
            `Price ${price} not reached TP level check value ${v}`,
          )
          continue
        }
        const deal = this.getDeal(d)
        if (!deal || deal.deal.symbol.symbol !== symbol) {
          this.handleDebug(`Deal not found or symbol mismatch for deal ${d}`)
          continue
        }
        if (deal.closeByTp) {
          // Info, not debug: this is the line that names a stuck `closeByTp`,
          // and debug is off on prod — the latch below was invisible in every
          // archived log. It only fires once the price has reached the target,
          // so the volume is bounded by real trigger events.
          this.handleLog(
            `Deal ${deal.deal._id} already closing by TP, skip TP level ${v} at price ${price}`,
          )
          continue
        }
        if (v) {
          const trigger = this.isLong ? price >= v : price <= v
          this.handleDebug(
            `Checking TP level for deal ${deal.deal._id}: price ${price}, target ${v}, trigger ${trigger}`,
          )
          if (trigger) {
            // A terminal refusal of the last close on this deal (the venue
            // saying the position is not there) puts the whole trigger behind a
            // growing cooldown. Without it the next price tick — throttled only
            // to 2/s per symbol — re-sends the identical reduce-only order, and
            // production ran one order id 1031 times in ~2h that way. Checked
            // before the log line on purpose: all three lines an attempt writes
            // are inside this block, and the log flood is the same flood.
            const tpCooldown = await tpCloseBackoff.check([
              this.botId,
              `${deal.deal._id}`,
            ])
            if (tpCooldown.suppressed) {
              this.handleDebug(
                `Deal ${deal.deal._id} TP level close suppressed until ${new Date(
                  tpCooldown.until,
                ).toISOString()} (attempt ${tpCooldown.attempt}) — exchange refused it: ${
                  tpCooldown.reason
                }`,
              )
              continue
            }
            this.handleLog(
              `Deal: ${deal.deal._id} adding TP order by TP level check`,
            )
            const settings = await this.getAggregatedSettings(deal.deal)
            if (!settings.useMultiTp) {
              this.handleDebug(
                `Deal ${deal.deal._id} is not multi TP, close deal completely`,
              )
              deal.closeByTp = true
              this.saveDeal(deal)
              return await this.closeDealById(
                this.botId,
                deal.deal._id,
                CloseDCATypeEnum.closeByMarket,
                undefined,
                undefined,
                undefined,
                false,
                undefined,
                undefined,
                false,
                DCACloseTriggerEnum.tp,
              )
            }
            const order = deal.currentOrders.find(
              (o) =>
                (settings.useMultiTp ? +o.price === v : true) &&
                o.type === TypeOrderEnum.dealTP,
            )
            if (!order) {
              return this.handleErrors(
                `Cannot find order for TP level check`,
                'checkTPLevel',
                '',
                false,
                false,
                false,
              )
            }
            deal.closeByTp = true
            this.saveDeal(deal)
            const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
            // `closeByTp` means "a close is in flight in this process" and is
            // cleared only by the fill-processing paths, so track here whether
            // this attempt actually left one in flight.
            let closeInFlight = false
            let outcome = 'no exchange info'
            let terminalRejection: string | null = null
            if (ed) {
              // `returnError: true` so a venue refusal comes back as its own
              // text instead of collapsing to `undefined`. Everything below is
              // what `sendGridToExchange` does internally — split apart only to
              // hold the prepared order, which `handleOrderErrors` needs and
              // which `returnError` suppresses inside `sendOrderToExchange`.
              // Same idiom as the sibling `checkDCAByMarketLevel` above.
              const orderPrepared = this.convertGridToOrder(
                order,
                {
                  dealId: deal.deal._id,
                  type: 'MARKET',
                  reduceOnly: !!this.futures,
                  positionSide: this.hedge
                    ? this.isLong
                      ? PositionSide.LONG
                      : PositionSide.SHORT
                    : PositionSide.BOTH,
                },
                ed,
              )
              const result = orderPrepared
                ? await this.sendOrderToExchange(orderPrepared, true)
                : undefined
              const decision = classifyTpCloseAttempt(
                typeof result === 'string'
                  ? { kind: 'refused', reason: result }
                  : result
                    ? {
                        kind: 'order',
                        status: result.status,
                        // The venue echoed a target that was already filled and
                        // booked — `processFilledOrder` would short-circuit it
                        // as "already processed" and never reach the reset
                        // below.
                        alreadyProcessed: !!this.processedFilled
                          .get(deal.deal._id)
                          ?.has(result.clientOrderId),
                      }
                    : { kind: 'nothing' },
                (reason) => this.getErrorSubType(reason),
              )
              outcome = decision.outcome
              closeInFlight = decision.inFlight
              if (decision.bookFill && result && typeof result !== 'string') {
                this.processFilledOrder(result)
              }
              if (typeof result === 'string' && orderPrepared) {
                if (decision.terminal) {
                  terminalRejection = result
                }
                // `returnError: true` returns before `sendOrderToExchange`'s own
                // reporting, so the refusal has to be raised here or it stops
                // being visible at all. Same call, same arguments as the branch
                // it bypassed.
                const setError = this.needToSendOrder(orderPrepared)
                // Not awaited, exactly as the branch it replaces: reporting must
                // not add a round trip to the price-tick path.
                this.handleOrderErrors(
                  result,
                  orderPrepared,
                  'limitOrders()',
                  `Send new order request ${orderPrepared.clientOrderId}, qty ${orderPrepared.origQty}, price ${orderPrepared.price}, side ${orderPrepared.side}`,
                  setError,
                  setError,
                )
              }
            }
            if (closeInFlight) {
              // A close the venue accepted proves the position is there again,
              // so no stale cooldown may outlive it.
              await tpCloseBackoff.clear([this.botId, `${deal.deal._id}`])
            }
            if (!closeInFlight) {
              // Nothing is in flight, so a `closeByTp` left true here is a
              // one-way latch: every later tick skips this deal at the
              // `already closing by TP` guard above and `placeOrders` refuses
              // every settings edit ("closing by TP. Skip place orders"), so
              // the remaining take-profit targets can never arm until an
              // unrelated fill or a worker restart clears it. Seen in
              // production for 2h56m on a Coinbase multi-TP deal after a
              // re-send of an already-filled target. Release the flag either
              // way — re-latching it is the #617 defect, and the cooldown
              // below, not the flag, is what stops the resend loop.
              deal.closeByTp = false
              this.saveDeal(deal)
              // Neither ending below can terminate: the backoff retries to 15
              // min forever, and everything else re-arms on the next tick. So
              // before choosing between them, settle whether there is anything
              // left to close at all — the question nothing in this engine ever
              // asked, which left deal 69f1b27faeba7a4880365abb open from April
              // to September against a position the venue closed on day one.
              // Driven from "nothing in flight" rather than from the refusal
              // text on purpose: the loop actually running in production today
              // reports `not placed` and never reaches the venue, so a guard
              // hung off `terminalRejection` would miss exactly these deals.
              if (await this.reconcileDealPosition(deal, outcome)) {
                continue
              }
              if (terminalRejection) {
                // The venue did not miss the order, it answered it: there is
                // no position to reduce. Re-arming against the price tick asks
                // the same impossible question ~2x/second forever (1031 sends
                // of one client order id in ~2h on deal
                // 69f1b27faeba7a4880365abb). Back off instead, and — because
                // `Futures position` is `showUser: false` and so reaches the
                // user nowhere — say it on the deal, once per run of refusals.
                const state = await tpCloseBackoff.record(
                  [this.botId, `${deal.deal._id}`],
                  terminalRejection,
                )
                this.handleLog(
                  `Deal ${deal.deal._id} TP level close ${outcome} — position not reducible on ${this.data?.exchange}; backing off until ${new Date(
                    state.until,
                  ).toISOString()} (attempt ${state.attempt}) instead of re-arming on the next tick`,
                )
                if (state.attempt === 1 && this.shouldProceed()) {
                  this.botEventDb.createData({
                    userId: this.userId,
                    botId: this.botId,
                    event: 'Deal',
                    botType: this.botType,
                    description: tpCloseBlockedMessage({
                      dealId: `${deal.deal._id}`,
                      symbol: deal.deal.symbol.symbol,
                      reason: terminalRejection,
                      retryAfter: state.until,
                    }),
                    paperContext: !!this.data?.paperContext,
                    deal: `${deal.deal._id}`,
                    symbol: deal.deal.symbol.symbol,
                    type: MessageTypeEnum.warning,
                  })
                }
                continue
              }
              // Anything else may genuinely succeed next tick — keep the #617
              // immediate re-arm on the targets that are still open, so the
              // stale one cannot re-fire.
              this.handleLog(
                `Deal ${deal.deal._id} TP level close left nothing in flight (${outcome}) — releasing closeByTp and re-arming TP level check`,
              )
              await this.checkDealSlMethods(deal)
              this.checkDealsPriceExtremum()
            }
          }
        }
      }
    }
    /**
     * Price update callback<br />
     *
     */
    @IdMute(
      mutex,
      (botId: string, msg: PriceMessage) => `${botId}price${msg.symbol}`,
      50,
    )
    @IdMute(
      mutexPriceConcurrently,
      (botId: string) => `${botId}priceUpdateCallback`,
    )
    override async priceUpdateCallback(
      _botId: string,
      msg: PriceMessage,
    ): Promise<void> {
      if (!this.finishLoad) {
        return
      }
      if (
        this.data?.status === BotStatusEnum.closed &&
        this.data?.deals.active === 0
      ) {
        return
      }

      if (this.blockPriceCheck) {
        return
      }
      if (+new Date() - (this.lastPriceCheck.get(msg.symbol) ?? 0) < 500) {
        return
      }
      this.lastPriceCheck.set(msg.symbol, +new Date())
      const time = msg.time ? msg.time : (msg.eventTime ?? msg.time)
      const lastStreamData = this.getLastStreamData(msg.symbol)
      if (time < (lastStreamData?.time ?? 0)) {
        return
      }
      this.setLastStreamData(msg.symbol, { price: msg.price, time })
      if (msg.price === lastStreamData?.price) {
        return
      }
      const hasAllowed = this.hasAllowedStopLossMethods()
      const lastCheck =
        +new Date() - (this.lastCheckPerSymbol.get(msg.symbol) ?? 0) >
        (this.data?.parentBotId ? 30 * 1000 : 60 * 1000)
      const needProcess = lastCheck || hasAllowed
      if (needProcess) {
        if (lastCheck) {
          const _activeDeals = this.getOpenDeals(false, msg.symbol)
          this.lastCheckPerSymbol.set(msg.symbol, +new Date())
          for (const d of _activeDeals) {
            if (this.data) {
              const data: BotParentProcessStatsEventDtoDcaCombo = {
                event: 'processStats',
                botId: this.botId,
                botType: this.combo ? BotType.combo : BotType.dca,
                payload: {
                  combo: this.combo,
                  data: msg,
                  deal: {
                    _id: d.deal._id,
                    settings: {
                      futures: d.deal.settings.futures,
                      marginType: d.deal.settings.marginType,
                      leverage: d.deal.settings.leverage,
                      comboTpBase: d.deal.settings.comboTpBase,
                      coinm: d.deal.settings.coinm,
                      profitCurrency: d.deal.settings.profitCurrency,
                    },
                    currentBalances: d.deal.currentBalances,
                    initialBalances: d.deal.initialBalances,
                    profit: {
                      total: d.deal.profit.total,
                      pureBase: 0,
                      pureQuote: 0,
                    },
                    feePaid: d.deal.feePaid,
                    avgPrice: d.deal.avgPrice,
                    strategy: d.deal.strategy,
                    usage: d.deal.usage,
                    stats: d.deal.stats,
                    flags: d.deal.flags,
                    tpFilledHistory: d.deal.tpFilledHistory,
                    reduceFunds: d.deal.reduceFunds,
                    botId: this.botId,
                  },
                  fee:
                    (await this.getUserFee(d.deal.symbol.symbol))?.maker ?? 0,
                  usdRate: (await this.getUsdRate(d.deal.symbol.symbol)) ?? 0,
                },
              }
              try {
                DealStats.getInstance().updateStats(data)
              } catch (e) {
                this.handleErrors(
                  `Cannot send deal ${d.deal._id} stats to parent process ${e}`,
                  'priceUpdateCallback',
                  '',
                  false,
                  false,
                  false,
                )
              }
            }
          }
          await this.checkDynamic(this.botId, msg.symbol, +msg.price)
        }
        if (hasAllowed) {
          if (
            msg.price >= (this.lowestHigh.get(msg.symbol) ?? Infinity) ||
            msg.price <= (this.highestLow.get(msg.symbol) ?? 0)
          ) {
            await this.checkDealsMoveSL(this.botId, msg.symbol)
            await this.checkTrailing(this.botId, msg.symbol)
            await this.checkDealsStopLoss(this.botId, msg.symbol)
            await this.checkDealsIndicatorUnpnl(this.botId, msg.symbol)
            await this.checkDCALevel(this.botId, msg.price, msg.symbol)
            await this.checkDCAByMarketLevel(this.botId, msg.price, msg.symbol)
            await this.checkTPLevel(this.botId, msg.price, msg.symbol)
          }
        }
      }
      if (this.data?.status === 'range') {
        if (await this.checkInRange(msg.symbol, msg.price)) {
          this.restoreFromRangeOrError()
          if (
            this.data.settings.startCondition === StartConditionEnum.asap &&
            this.getOpenDeals().length === 0
          ) {
            this.openNewDeal(this.botId, msg.symbol)
          }
        }
      }
      if (
        this.data &&
        this.data.settings.useBotController &&
        (this.data.settings.botStart === BotStartTypeEnum.price ||
          this.data.settings.botActualStart === BotStartTypeEnum.price)
      ) {
        if (
          (this.data.status === BotStatusEnum.monitoring ||
            (this.data.status === BotStatusEnum.error &&
              this.data.previousStatus === BotStatusEnum.monitoring)) &&
          this.data?.settings.botActualStart === BotStartTypeEnum.price &&
          !this.startSent
        ) {
          if (
            this.data.settings.startBotPriceCondition ===
            IndicatorStartConditionEnum.gt
              ? msg.price > +(this.data.settings.startBotPriceValue ?? Infinity)
              : msg.price < +(this.data.settings.startBotPriceValue ?? 0)
          ) {
            this.startSent = true
            this.handleLog(
              `Start bot by price condition ${msg.price} ${this.data.settings.startBotPriceCondition} ${this.data.settings.startBotPriceValue}`,
            )
            this.setStatus(
              this.botId,
              BotStatusEnum.open,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true,
            )
          }
        }
        if (
          (this.data.status === BotStatusEnum.open ||
            this.data.status === BotStatusEnum.range ||
            (this.data.status === BotStatusEnum.error &&
              (this.data.previousStatus === BotStatusEnum.open ||
                this.data.previousStatus === BotStatusEnum.range))) &&
          this.data?.settings.botStart === BotStartTypeEnum.price &&
          !this.stopSent
        ) {
          if (
            this.data.settings.stopBotPriceCondition ===
            IndicatorStartConditionEnum.gt
              ? msg.price > +(this.data.settings.stopBotPriceValue ?? Infinity)
              : msg.price < +(this.data.settings.stopBotPriceValue ?? 0)
          ) {
            this.stopSent = true
            const setMonitoring =
              this.data.settings.stopStatus === BotStatusEnum.monitoring &&
              (this.data.settings.botActualStart ===
                BotStartTypeEnum.indicators ||
                this.data.settings.botActualStart === BotStartTypeEnum.price)
            this.handleLog(
              `Stop bot by price condition ${msg.price} ${this.data.settings.stopBotPriceCondition} ${this.data.settings.stopBotPriceValue}, set monitoring ${setMonitoring} (${this.data.settings.stopStatus}, ${this.data.settings.botActualStart})`,
            )
            await this.setStatus(
              this.botId,
              BotStatusEnum.closed,
              this.data.settings.stopType,
            )
            if (setMonitoring) {
              this.setStatus(this.botId, BotStatusEnum.open)
            }
          }
        }
      }
    }

    clearClassProperties(clearRedis = false, start = false) {
      mutex.clear(this.botId)
      mutexConcurrently.clear(this.botId)
      mutexPriceConcurrently.clear(this.botId)
      this.pendingClose = new Set()
      this.lastLogs = []
      this.lastMethods = []
      this.currentMethods = new Map()
      this.afterIndicatorsConnected = []
      this.ordersInBetweenUpdates = new Set()
      this.dealsByMarketProcessing = new Set()
      this.zeroFee = false
      this.startSent = false
      this.stopSent = false
      this.indicatorConfigIdMap = new Map()
      this.indicatorRoomConfigMap = new Map()
      this.indicatorSubscribedRooms = new Set()
      for (const [id, timer] of this.closeDealTimer.entries()) {
        if (timer) {
          clearTimeout(timer)
        }
        this.closeDealTimer.delete(id)
      }
      if (this.equityTimer) {
        clearTimeout(this.equityTimer)
      }
      if (this.statsTimer) {
        clearTimeout(this.statsTimer)
      }
      this.lastStatsCheck = 0
      for (const [id, timer] of this.openNewDealTimer.entries()) {
        if (timer) {
          clearTimeout(timer)
        }
        this.openNewDealTimer.delete(id)
      }
      for (const [id, timer] of this.dealTimersMap.entries()) {
        if (timer.enterMarketTimer) {
          clearTimeout(timer.enterMarketTimer)
        }
        if (timer.limitTimer) {
          clearTimeout(timer.limitTimer)
        }
        this.dealTimersMap.delete(id)
      }
      this.indicatorsIntervalActionMap = new Map()
      try {
        for (const timer of Object.values(this.indicatorCheckTimers)) {
          if (timer) {
            clearInterval(timer)
          }
        }
        this.indicatorCheckTimers = {}
        this.indicatorCheckTimersFired = {}
      } catch (e) {
        this.handleErrors(
          `Cannot clear intervals ${e}`,
          'stop',
          '',
          false,
          false,
          false,
        )
      }
      if (this.saveIndicatorTimer) {
        clearInterval(this.saveIndicatorTimer)
      }
      if (this.timer) {
        clearInterval(this.timer)
      }
      this.stopSessionCheckTimer()
      if (start) {
        this.setEquityTimer()
      }
      this.indicatorActions = {
        startDeal: new Map<string, number>(),
        stopBot: new Map<string, number>(),
        startBot: new Map<string, number>(),
        closeDealTp: new Map<string, number>(),
        closeDealSl: new Map<string, number>(),
        dcaOrder: new Map<string, number>(),
      }
      this.profitBaseDealMap = new Map()
      this.leverageMap = new Map()
      this.baseSlOnMap = new Map()
      this.dealStatusMap = new Map()
      this.dealSymbolMap = new Map()
      this.orderStatusMap = new Map()
      this.orderDealMap = new Map()
      this.orders = new Map()
      this.minigridDealMap = new Map()
      this.checkIndicatorsQueue = new Map()
      this.dcaOrdersBySignal = new Set()
      this.lastIndicatorsDataMap = new Map()
      this.allowToPlaceOrders = new Map()
      this.pendingDeals = 0
      this.pendingDealsOver = 0
      this.pendingDealsUnder = 0
      this.pendingDealsPerPair = new Map()
      this.loadingComplete = false
      this.runAfterLoadingQueue = []
      this.lockProcessQueueMethod = false
      this.userStreamInitialStart = true
      this.blockCheck = false
      this.ignoreErrors = false
      this.stopList = new Set()
      this.pendingOrdersList = new Map()
      this.closeAfterTpFilled = false
      this.runAfterLoadingQueue = []
      this.pairsNotFound = new Set()
      this.coinsMemory = new Set()
      this.coinsLastRequest = 0
      this.relativeCoinsLastRequest = 0
      this.relativeCoinsMemory = new Set()
      this.stopPriceTimer()
      if (clearRedis) {
        this.clearRedis()
      }
      this.dealTimersMap = new Map()
      this.dealsForMoveSl = new Map()
      this.dealsForStopLoss = new Map()
      this.dealsForTrailing = new Map()
      this.dealsForStopLossCombo = new Map()
      this.ordersKeys = new Set()
      this.highestLow = new Map()
      this.lowestHigh = new Map()
      this.lastPriceCheck = new Map()
      this.blockCheck = false
      this.blockPriceCheck = false
      if (start) {
        if (this.closeTimer) {
          this.handleLog(`Clear close timer`)
          clearTimeout(this.closeTimer)
          this.closeTimer = null
        }
      }
      this.blockCheck = false
      this.precisions = new Map()
      this.lastStreamData = new Map()
    }
    /**
     * Reload bot after settings changed
     */

    @IdMute(mutex, (botId: string) => `reload${botId}`)
    override async reloadBot(
      _botId: string,
      replaceOrders = true,
      // A bot-settings save arrives with replaceOrders=false: running deals and
      // their resting orders must survive untouched. But the bot's indicator
      // set is DERIVED from the settings that just changed, and the
      // keep-indicators path reconciles by SYMBOL only — it retains any
      // subscription whose symbol is still in use and then drops that symbol
      // from the to-subscribe set. Swapping one indicator for another on the
      // same pair would therefore leave the old one live and never subscribe
      // the new one, i.e. the save would silently not apply to new deals
      // either. Settings saves pass true here to force a clean rebuild.
      rebuildIndicators = false,
    ) {
      try {
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer)
          this.reloadTimer = null
        }
        this.handleLog(`Reload bot`)
        const _id = this.startMethod('reloadBot')
        for (const [id, timer] of this.openNewDealTimer.entries()) {
          clearInterval(timer)
          this.openNewDealTimer.delete(id)
        }
        const stopped =
          this.data?.status === BotStatusEnum.closed ||
          (this.data?.status === BotStatusEnum.error &&
            this.data.previousStatus === BotStatusEnum.closed)
        if (replaceOrders) {
          await this.cancelAllOrder()
        }
        // Record the intent for the rest of the reload. Skipping the cancel
        // here is NOT enough on its own: `restoreWork` further down `start()`
        // cancels the whole book again for any reload it does not recognise as
        // a cold service restart, and the flags below deliberately make this
        // one not look like a cold restart.
        this.keepOrders = !replaceOrders
        if (!replaceOrders) {
          this.serviceRestart = true
          this.secondRestart = true
          this.ignoreRestartStats = true
          this.saveIndicators = !rebuildIndicators
          this.reload = true
        }
        for (const d of this.getOpenDeals()) {
          await this.clearDealTimer(d.deal._id)
          this.allowToPlaceOrders.set(d.deal._id, false)
        }
        if (!this.saveIndicators) {
          for (const i of [...this.indicators.values()]) {
            await this.sendIndicatorUnsubscribeEvent(i.id, i.room, i.cb)
          }
        }

        if (this.timer) {
          clearTimeout(this.timer)
        }
        this.endMethod(_id)
        await this.start(false, true)
        if (stopped && this.data) {
          const data = { status: BotStatusEnum.closed }
          this.data = { ...this.data, ...data }
          this.updateData(data)
          this.emit('bot settings update', data)
        }
      } catch (e) {
        this.handleErrors(
          `Error on reload bot ${e}`,
          'reloadBot',
          '',
          false,
          false,
          false,
        )
      }
    }

    /**
     * Update deal balances
     */

    async updateDealBalances(findDeal: FullDeal<ExcludeDoc<Deal>>) {
      const orderBo = this.findBaseOrderByDeal(findDeal.deal._id)
      if (orderBo) {
        const long = this.isLong
        const qty = parseFloat(orderBo.executedQty)
        const price = parseFloat(orderBo.price)
        const fundsBase = (
          findDeal.deal.funds ?? ([] as unknown as NonNullable<Deal['funds']>)
        ).reduce((acc, v) => acc + v.qty, 0)
        const fundsQuote = (
          findDeal.deal.funds ?? ([] as unknown as NonNullable<Deal['funds']>)
        ).reduce((acc, v) => acc + v.qty * v.price, 0)
        const pending = this.getPendingAddFunds(findDeal)
        const reduceFundsBase = (
          findDeal.deal.reduceFunds ??
          ([] as unknown as NonNullable<Deal['reduceFunds']>)
        ).reduce((acc, v) => acc + v.qty, 0)
        const reduceFundsQuote = (
          findDeal.deal.reduceFunds ??
          ([] as unknown as NonNullable<Deal['reduceFunds']>)
        ).reduce((acc, v) => acc + v.qty * v.price, 0)
        findDeal.deal.initialBalances = {
          base: long
            ? 0
            : findDeal.initialOrders
                .filter((o) => o.side === OrderSideEnum.sell)
                .reduce((acc, v) => acc + v.qty, 0) +
              qty +
              fundsBase +
              pending.base -
              reduceFundsBase,
          quote: long
            ? findDeal.initialOrders
                .filter((o) => o.side === OrderSideEnum.buy)
                .reduce((acc, v) => acc + v.qty * v.price, 0) +
              qty * price +
              fundsQuote +
              pending.quote -
              reduceFundsQuote
            : 0,
        }
        const filled = this.getOrdersByStatusAndDealId({
          dealId: findDeal.deal._id,
          status: ['FILLED', 'CANCELED'],
        })
          .filter(
            (o) =>
              (o.status === 'FILLED' || +o.executedQty !== 0) &&
              ![
                TypeOrderEnum.fee,
                TypeOrderEnum.br,
                TypeOrderEnum.rebalance,
              ].includes(o.typeOrder),
          )
          .filter((o) =>
            findDeal.deal.parent
              ? o.typeOrder !== TypeOrderEnum.dealStart
              : true,
          )
        const filledBase =
          filled.reduce(
            (acc, v) =>
              acc +
              (v.executedQty &&
              !isNaN(+v.executedQty) &&
              isFinite(+v.executedQty) &&
              +v.executedQty
                ? +v.executedQty
                : v.typeOrder === TypeOrderEnum.dealStart
                  ? +v.executedQty
                  : +v.origQty) *
                (v.side === 'BUY' ? 1 : -1),
            0,
          ) +
          (findDeal.deal.parent ? qty : 0) * (orderBo.side === 'BUY' ? 1 : -1)
        const filledQuote =
          filled.reduce(
            (acc, v) =>
              acc +
              (v.executedQty &&
              !isNaN(+v.executedQty) &&
              isFinite(+v.executedQty) &&
              +v.executedQty
                ? +v.executedQty * +v.price
                : v.typeOrder === TypeOrderEnum.dealStart
                  ? +v.executedQty * +v.price
                  : +v.origQty * +v.price) *
                (v.side === 'BUY' ? -1 : 1),
            0,
          ) +
          (findDeal.deal.parent ? qty * price : 0) *
            (orderBo.side === 'BUY' ? -1 : 1)
        findDeal.deal.currentBalances = {
          base: findDeal.deal.initialBalances.base + filledBase,
          quote: findDeal.deal.initialBalances.quote + filledQuote,
        }
        if (this.combo) {
          this.handleDebug(
            `Deal ${findDeal.deal._id} balances ${
              findDeal.deal.currentBalances.base
            } base, ${
              findDeal.deal.currentBalances.quote
            } quote, filled ${filledBase} base ${filledQuote} quote, sells - ${
              filled.filter((o) => o.side === 'SELL').length
            } buys - ${filled.filter((o) => o.side === 'BUY').length}, initial ${
              findDeal.deal.initialBalances.base
            } base ${findDeal.deal.initialBalances.quote} quote`,
          )
        }
        if (this.combo) {
          const initOrdersMap: Map<number, Grid> = new Map()
          findDeal.initialOrders
            .filter((o) => o.type === TypeOrderEnum.dealRegular)
            .map((o) => {
              if (o.dcaLevel) {
                initOrdersMap.set(o.dcaLevel, o)
              }
            })
          findDeal.deal.levels.all = Math.max(
            findDeal.deal.levels.complete,
            initOrdersMap.size + 1,
          )
        } else {
          findDeal.deal.levels.all = Math.max(
            findDeal.deal.levels.complete,
            findDeal.initialOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ).length +
              1 +
              (findDeal.deal.pendingAddFunds ?? []).length +
              (findDeal.deal.funds ?? []).length,
          )
          if (
            findDeal.currentOrders.filter(
              (o) => o.type === TypeOrderEnum.dealRegular,
            ).length === 0
          ) {
            findDeal.deal.levels.all = Math.max(
              findDeal.deal.levels.complete,
              1 +
                findDeal.initialOrders.filter(
                  (o) => o.type === TypeOrderEnum.dealRegular,
                ).length,
              1 + (findDeal.deal.funds ?? []).length,
            )
          }
        }
        this.saveDeal(findDeal, {
          initialBalances: findDeal.deal.initialBalances,
          currentBalances: findDeal.deal.currentBalances,
          levels: findDeal.deal.levels,
        })
      }
    }
    /**
     * Reset deal settings to global bot
     */

    async resetDealSettings(dealId: string) {
      const findDeal = this.getDeal(dealId)
      if (
        findDeal &&
        findDeal.deal.status === DCADealStatusEnum.open &&
        this.data
      ) {
        const dealSettings = this.getInitalDealSettings()
        if (dealSettings) {
          await this.updateDealSettings(
            dealId,
            {
              ...dealSettings,
              avgPrice: findDeal.deal.settings.avgPrice,
              orderSizePercQty: findDeal.deal.settings.orderSizePercQty,
              slChangedByUser: findDeal.deal.settings.slChangedByUser,
              updatedComboAdjustments:
                findDeal.deal.settings.updatedComboAdjustments,
              fixedSlPrice: findDeal.deal.settings.fixedSlPrice,
              fixedTpPrice: findDeal.deal.settings.fixedTpPrice,
              useFixedSLPrices: findDeal.deal.settings.useFixedSLPrices,
              useFixedTPPrices: findDeal.deal.settings.useFixedTPPrices,
              useTp:
                this.data.settings.dealCloseCondition ===
                  CloseConditionEnum.dynamicAr && this.data.settings.useTp
                  ? true
                  : findDeal.deal.settings.fixedTpPrice &&
                      findDeal.deal.settings.useFixedTPPrices
                    ? findDeal.deal.settings.useTp
                    : dealSettings.useTp,
              useSl:
                this.data.settings.dealCloseConditionSL ===
                  CloseConditionEnum.dynamicAr && this.data.settings.useSl
                  ? true
                  : findDeal.deal.settings.fixedSlPrice &&
                      findDeal.deal.settings.useFixedSLPrices
                    ? findDeal.deal.settings.useSl
                    : dealSettings.useSl,
              baseSlOn: this.data.settings.baseSlOn,
              profitCurrency: this.combo
                ? findDeal.deal.settings.profitCurrency
                : dealSettings.profitCurrency,
              closeOrderType: dealSettings.closeOrderType,
            },
            true,
          )
        }
      }
    }

    async getOrdersToRestartAfterSettingsUpdate(dealId: string) {
      const findDeal = this.getDeal(dealId)
      return this.findDiff(findDeal?.currentOrders ?? [], [])
    }

    async afterDealUpdate(_dealId: string) {
      return
    }

    async setNewTp(tp?: string, sl?: string) {
      if (!this.data) {
        return
      }
      if (!tp && !sl) {
        return
      }
      if (tp) {
        this.data.settings.tpPerc = tp
      }
      if (sl) {
        this.data.settings.slPerc = sl
      }
      for (const d of this.getOpenDeals()) {
        if (tp) {
          d.deal.settings.tpPerc = tp
        }
        if (sl) {
          d.deal.settings.slPerc = sl
        }
        this.setDeal(d)
        await this.setDealForStopLoss(d)
      }
      this.setDealToRedis(
        this.botId,
        this.serviceRestart && !this.secondRestart,
      )
    }
    /**
     * Update deal settings
     */

    async updateDealSettings(
      dealId: string,
      settings: Partial<Deal['settings']>,
      reset = false,
    ) {
      // A settings patch must never zero the deal's reference price. Every
      // percentage exit is measured from it, so a `0` does not weaken them —
      // it removes them (see `dealRefPrice.ts`). Clients send one anyway: the
      // dashboard's mass deal-edit diffs the bot-form defaults, which carry
      // `avgPrice: 0`, against each selected deal. Drop it here so the fix
      // holds for every caller and the zero is never persisted.
      settings = withoutUnusableAvgPrice(settings)
      const keys = Object.keys(settings)
      if (keys.length > 0) {
        const findDeal = this.getDeal(dealId)
        if (
          findDeal &&
          (findDeal.deal.status === DCADealStatusEnum.open ||
            findDeal.deal.status === DCADealStatusEnum.start ||
            findDeal.deal.status === DCADealStatusEnum.error)
        ) {
          const currentSlPerc = findDeal.deal.settings.slPerc
          const changeTrailingTp =
            (settings.trailingTpPerc &&
              `${settings.trailingTpPerc}` !==
                `${findDeal.deal.settings.trailingTpPerc}`) ||
            (!settings.trailingTp && findDeal.deal.settings.trailingTp)
          const changeTrailingSl =
            !settings.trailingSl && findDeal.deal.settings.trailingSl
          if (
            (changeTrailingTp &&
              findDeal.deal.trailingMode === TrailingModeEnum.ttp) ||
            (changeTrailingSl &&
              findDeal.deal.trailingMode === TrailingModeEnum.tsl)
          ) {
            findDeal.deal.trailingLevel = 0
            findDeal.deal.trailingMode = undefined
          }
          findDeal.deal.settings = {
            ...findDeal.deal.settings,
            ...settings,
            changed: reset
              ? false
              : keys.length === 1 && keys[0] === 'avgPrice'
                ? false
                : true,
          }
          const keysToCheck = Object.keys(findDeal.deal.settings).map((k) => {
            if (
              (!findDeal.deal.settings.useDca &&
                !this.data?.settings.useDca &&
                [
                  'ordersCount',
                  'orderSize',
                  'useSmartOrders',
                  'activeOrdersCount',
                  'stepScale',
                  'volumeScale',
                ].includes(k)) ||
              k === 'avgPrice' ||
              k === 'changed' ||
              (findDeal.deal.settings.useDca &&
                this.data?.settings.useDca &&
                !findDeal.deal.settings.useSmartOrders &&
                !this.data?.settings.useSmartOrders &&
                ['activeOrdersCount'].includes(k)) ||
              (!findDeal.deal.settings.useTp &&
                !this.data?.settings.useTp &&
                [
                  'tpPerc',
                  'trailingTp',
                  'trailingTpPerc',
                  'useMinTP',
                  'minTp',
                  'multiTp',
                  'useMultiTp',
                ].includes(k)) ||
              (!findDeal.deal.settings.useSl &&
                !this.data?.settings.useSl &&
                [
                  'slPerc',
                  'trailingSl',
                  'moveSL',
                  'moveSLTrigger',
                  'moveSLValue',
                  'useMultiSl',
                  'multiSl',
                ].includes(k))
            ) {
              return true
            }
            if (this.data) {
              if (Object.prototype.hasOwnProperty.call(this.data.settings, k)) {
                // @ts-ignore
                return this.data.settings[k] === findDeal.deal.settings[k]
              }
            }
            if (k === 'avgPrice' || k === 'changed') {
              return true
            }
            return false
          })
          if (findDeal.deal.moveSlActivated && !settings.moveSL) {
            findDeal.deal.moveSlActivated = false
          }
          if (!findDeal.deal.moveSlActivated && settings.moveSL) {
            findDeal.deal.moveSlActivated =
              (settings.moveSLValue ?? findDeal.deal.settings.moveSLValue) ===
              (settings.slPerc ?? findDeal.deal.settings.slPerc)
          }
          // These settings can move the stop level, so the crossing state that
          // was earned against the old one no longer means anything.
          findDeal.deal.moveSlArmed = false
          findDeal.deal.settings = {
            ...findDeal.deal.settings,
            ...settings,
            changed: reset ? false : keysToCheck.filter((k) => !k).length !== 0,
            slChangedByUser: reset ? false : currentSlPerc !== settings.slPerc,
          }
          await this.cancelAllOrder(findDeal.deal.lastPrice, dealId, true)
          if (findDeal.deal.status !== DCADealStatusEnum.start) {
            findDeal.initialOrders = await this.createInitialDealOrders(
              findDeal.deal.symbol.symbol,
              findDeal.deal.initialPrice,
              dealId,
              findDeal.deal,
            )
            findDeal.currentOrders = await this.createCurrentDealOrders(
              findDeal.deal.symbol.symbol,
              findDeal.deal.lastPrice,
              findDeal.initialOrders,
              findDeal.deal.settings.avgPrice || findDeal.deal.avgPrice,
              findDeal.deal.initialPrice,
              dealId,
              false,
              findDeal.deal,
              false,
            )
            findDeal.initialOrders = this.getDealInitialOrders(dealId)

            const completeLevels =
              (this.getOrdersByStatusAndDealId({
                dealId: findDeal.deal._id,
                status: ['FILLED', 'CANCELED'],
              }).filter(
                (o) =>
                  (o.typeOrder === TypeOrderEnum.dealRegular ||
                    (!findDeal.deal.parent &&
                      o.typeOrder === TypeOrderEnum.dealStart)) &&
                  (this.data?.exchange === ExchangeEnum.bybit
                    ? (o.status === 'FILLED' || o.status === 'CANCELED') &&
                      +o.executedQty !== 0
                    : o.status === 'FILLED'),
              ).length ?? 1) + (findDeal.deal.parent ? 1 : 0)
            findDeal.deal.levels = {
              complete: completeLevels,
              all: Math.max(
                completeLevels,
                findDeal.initialOrders.filter(
                  (o) => o.type === TypeOrderEnum.dealRegular,
                ).length +
                  1 +
                  (findDeal.deal.pendingAddFunds ?? []).length +
                  (findDeal.deal.funds ?? []).length,
              ),
            }
            if (
              findDeal.currentOrders.filter(
                (o) => o.type === TypeOrderEnum.dealRegular,
              ).length === 0
            ) {
              findDeal.deal.levels.all = Math.max(
                findDeal.deal.levels.complete,
                1 +
                  findDeal.initialOrders.filter(
                    (o) => o.type === TypeOrderEnum.dealRegular,
                  ).length,
                1 + (findDeal.deal.funds ?? []).length,
              )
            }
            findDeal.deal.fullFee = await this.getCommDeal(findDeal.deal)
          }
          this.updateDealBalances(findDeal)
          this.saveDeal(findDeal, {
            settings: findDeal.deal.settings,
            levels: findDeal.deal.levels,
            moveSlActivated: findDeal.deal.moveSlActivated,
            moveSlArmed: findDeal.deal.moveSlArmed,
            fullFee: findDeal.deal.fullFee,
            trailingLevel: findDeal.deal.trailingLevel,
            trailingMode: findDeal.deal.trailingMode,
          }).then(async () => {
            this.removeDealFromStopLossMethods(dealId)
            await this.checkAllowedMethods()
            await this.setClassProperties()
            this.updateUsage(dealId)
            this.updateAssets(dealId)
            await this.setCloseByTimer(findDeal.deal)
            // Re-arming above only updates the price the level check watches.
            // The check itself runs from `priceUpdateCallback`, so a target the
            // user has just moved below the market sits armed but unevaluated
            // until the next price tick — and that cadence is the venue's, not
            // ours: Coinbase pairs tick once every five minutes, which is how
            // an already-in-the-money target went unfilled for minutes after
            // the edit that put it in the money. Evaluate it against the last
            // known price straight away.
            const lastPrice =
              this.getLastStreamData(findDeal.deal.symbol.symbol)?.price ||
              findDeal.deal.lastPrice
            if (lastPrice) {
              await this.checkTPLevel(
                this.botId,
                lastPrice,
                findDeal.deal.symbol.symbol,
              )
            }
          })

          if (findDeal.deal.status !== DCADealStatusEnum.start) {
            await this.placeOrders(
              this.botId,
              findDeal.deal.symbol.symbol,
              dealId,
              await this.getOrdersToRestartAfterSettingsUpdate(dealId),
            )
            const pendingAddFunds = findDeal.deal.pendingAddFunds ?? []
            if (pendingAddFunds.length) {
              findDeal.deal.pendingAddFunds = []
              this.saveDeal(findDeal, { pendingAddFunds: [] })
              for (const pending of pendingAddFunds) {
                const { id: _id, ...settings } = pending
                this.addDealFunds(this.botId, findDeal.deal._id, settings)
              }
            }
            const pendingReduceFunds = findDeal.deal.pendingReduceFunds ?? []
            if (pendingReduceFunds.length) {
              findDeal.deal.pendingReduceFunds = []
              this.saveDeal(findDeal, { pendingReduceFunds: [] })
              for (const pending of pendingReduceFunds) {
                const { id: _id, ...settings } = pending
                this.reduceDealFunds(this.botId, findDeal.deal._id, settings)
              }
            }
          } else {
            await this.placeBaseOrder(
              this.botId,
              findDeal.deal.symbol.symbol,
              findDeal.deal._id,
            )
          }
        }
      }
      await this.afterDealUpdate(dealId)
    }
    /**
     * Merge deals
     * @param {string[]} _deals Id of deals to merge
     * @param {(botId: string, dealId: string, close?: CloseDCATypeEnum, reopen?: boolean) => Promise<{status: StatusEnum.ok, reason: null, data: string} | undefined}> closeFn Closed deal funstion
     */

    async mergeDeals(_deals: string[]) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('merge deals'))
        return
      }
      const _id = this.startMethod('mergeDeals')
      const prefix = `Merge Deals | `
      if (this.data) {
        const dealsFromDB = await this.dealsDb.readData(
          {
            _id: { $in: _deals },
            status: DCADealStatusEnum.open,
            userId: this.userId,
          } as any,
          undefined,
          {},
          true,
        )
        if (dealsFromDB.status === StatusEnum.notok) {
          this.endMethod(_id)
          return this.handleErrors(
            `Read deals error. ${dealsFromDB.reason}`,
            'mergeDeals()',
            'read data',
          )
        } else {
          this.handleLog(
            `${prefix} Found ${dealsFromDB.data.result.length} deals`,
          )
        }
        const deals = dealsFromDB.data.result
        if (deals.length < _deals.length) {
          this.endMethod(_id)
          return this.handleErrors(
            `Cannot find all deals`,
            'mergeDeals()',
            'deals length',
            false,
            false,
            false,
          )
        }
        const botsId: Set<string> = new Set()
        deals.forEach((d) => botsId.add(d.botId))
        let bots: Schema[] = []
        if (this.db && botsId.size > 0) {
          const botsFromDb = await this.db.readData(
            { _id: { $in: Array.from(botsId) }, userId: this.userId },
            undefined,
            {},
            true,
          )
          if (botsFromDb.status === StatusEnum.notok) {
            this.endMethod(_id)
            return this.handleErrors(
              `Cannot get bots from db. ${botsFromDb.reason}`,
              'mergeDeals()',
              'get bots',
              false,
              false,
              false,
            )
          } else {
            this.handleLog(
              `${prefix} Found ${botsFromDb.data.result.length} bots`,
            )
          }
          bots = [...bots, ...botsFromDb.data.result]
        }
        if (bots.length === 0) {
          this.endMethod(_id)
          return this.handleErrors(
            `Found 0 bots`,
            'mergeDeals()',
            'bots length',
            false,
            false,
            false,
          )
        }
        const strategy = bots[0].settings.strategy
        const pair = dealsFromDB.data.result[0].symbol.symbol
        let sameStrategy = true
        let samePair = true
        dealsFromDB.data.result.forEach((b) => {
          if (b.strategy !== strategy) {
            sameStrategy = false
          }
          if (b.symbol.symbol !== pair) {
            samePair = false
          }
        })
        if (!sameStrategy) {
          this.endMethod(_id)
          return this.handleErrors(
            `All bots must be the same strategy`,
            'mergeDeals()',
            'strategy check',
            false,
            false,
            false,
          )
        }
        if (!samePair) {
          this.endMethod(_id)
          return this.handleErrors(
            `All bots must be the same pair`,
            'mergeDeals()',
            'pair check',
            false,
            false,
            false,
          )
        }
        const ordersFromDb = await this.ordersDb.readData(
          {
            userId: this.userId,
            dealId: { $in: _deals },
            status: { $in: ['FILLED', 'PARTIALLY_FILLED'] },
            typeOrder: {
              $in: [
                TypeOrderEnum.dealStart,
                TypeOrderEnum.dealRegular,
                TypeOrderEnum.dealTP,
              ],
            },
          },
          undefined,
          {},
          true,
        )
        if (ordersFromDb.status === StatusEnum.notok) {
          this.endMethod(_id)
          return this.handleErrors(
            `Cannot get orders from db. ${ordersFromDb.reason}`,
            'mergeDeals()',
            'get orders',
            false,
            false,
            false,
          )
        } else {
          this.handleLog(
            `${prefix} Found ${ordersFromDb.data.result.length} orders`,
          )
        }
        const orders = ordersFromDb.data.result
        if (orders.length === 0) {
          this.endMethod(_id)
          return this.handleErrors(
            `Found 0 orders`,
            'mergeDeals()',
            'orders length',
            false,
            false,
            false,
          )
        }
        const ed = await this.getExchangeInfo(pair)
        if (ed) {
          const initialQuote = orders.reduce(
            (acc, o) =>
              acc +
              (o.typeOrder !== TypeOrderEnum.dealTP
                ? +o.price * +o.executedQty
                : 0),
            0,
          )
          const initialBase = orders.reduce(
            (acc, o) =>
              acc + (o.typeOrder !== TypeOrderEnum.dealTP ? +o.executedQty : 0),
            0,
          )
          const currentQuote =
            (this.isLong ? initialQuote : 0) +
            orders.reduce(
              (acc, o) =>
                acc + +o.price * +o.executedQty * (o.side === 'BUY' ? -1 : 1),
              0,
            )
          const curentBase =
            (this.isLong ? 0 : initialBase) +
            orders.reduce(
              (acc, o) => acc + +o.executedQty * (o.side === 'BUY' ? 1 : -1),
              0,
            )
          const time = new Date().getTime()
          const avgPrice = initialQuote / initialBase
          this.handleLog(
            `Merge deals ${_deals.join(
              ', ',
            )}, initial quote: ${initialQuote}, initial base: ${initialBase}, current quote: ${currentQuote}, current base: ${curentBase}, avg price: ${avgPrice}, found orders ${
              orders.length
            }`,
          )
          const rate = await this.getUsdRate(
            this.data.settings.pair[0],
            this.futures
              ? this.coinm
                ? 'base'
                : 'quote'
              : this.isLong
                ? 'quote'
                : 'base',
          )
          const usageCurrentBase = this.futures
            ? this.coinm
              ? initialBase
              : 0
            : this.isLong
              ? 0
              : initialBase
          const usageCurrentQuote = this.futures
            ? this.coinm
              ? 0
              : initialQuote
            : this.isLong
              ? initialQuote
              : 0
          const usageMaxBase = this.futures
            ? this.coinm
              ? initialBase
              : 0
            : this.isLong
              ? 0
              : initialBase
          const usageMaxQuote = this.futures
            ? this.coinm
              ? 0
              : initialQuote
            : this.isLong
              ? initialQuote
              : 0
          const maxUsd = this.futures
            ? this.coinm
              ? usageMaxBase * rate
              : usageMaxQuote * rate
            : this.isLong
              ? usageMaxQuote * rate
              : usageMaxBase * rate
          const currentUsd = this.futures
            ? this.coinm
              ? usageCurrentBase * rate
              : usageCurrentQuote * rate
            : this.isLong
              ? usageCurrentQuote * rate
              : usageCurrentBase * rate
          let relative = currentUsd / maxUsd
          if (isNaN(relative) || !isFinite(relative)) {
            relative = 0
          }
          const mergedDeals: Omit<CleanDCADealsSchema, '_id'> = {
            botId: this.botId,
            userId: this.userId,
            status: DCADealStatusEnum.open,
            initialBalances: {
              base: this.isLong ? 0 : initialBase,
              quote: this.isLong ? initialQuote : 0,
            },
            currentBalances: {
              base: curentBase,
              quote: currentQuote,
            },
            initialPrice: avgPrice,
            avgPrice,
            displayAvg: avgPrice,
            profit: {
              pureBase: 0,
              pureQuote: 0,
              total: 0,
              totalUsd: 0,
            },
            feePaid: {
              base: 0,
              quote: 0,
            },
            lastPrice: avgPrice,
            commission: 0,
            createTime: time,
            updateTime: time,
            levels: {
              all: 1,
              complete: 1,
            },
            usage: {
              current: {
                base: usageCurrentBase,
                quote: usageCurrentQuote,
              },
              max: {
                base: usageMaxBase,
                quote: usageMaxQuote,
              },
              maxUsd,
              currentUsd,
              relative,
            },
            assets: {
              used: {
                base: this.isLong ? 0 : initialBase,
                quote: this.isLong ? initialQuote : 0,
              },
              required: {
                base: 0,
                quote: 0,
              },
            },
            settings: {
              changed: true,
              ordersCount: 1,
              tpPerc: this.data.settings.tpPerc,
              profitCurrency: this.data.settings.profitCurrency,
              avgPrice: avgPrice,
              baseOrderSize: `${initialQuote}`,
              orderSize: `${initialQuote}`,
              useTp:
                this.data.settings.useTp &&
                (this.data.settings.dealCloseCondition ===
                  CloseConditionEnum.techInd ||
                  this.data.settings.dealCloseCondition ===
                    CloseConditionEnum.webhook),
              useSl:
                this.data.settings.useSl &&
                (this.data.settings.dealCloseConditionSL ===
                  CloseConditionEnum.techInd ||
                  this.data.settings.dealCloseConditionSL ===
                    CloseConditionEnum.webhook),
              slPerc: this.data.settings.slPerc,
              useDca: false,
              useSmartOrders: false,
              activeOrdersCount: 1,
              orderSizePercQty: 0,
              trailingSl: false,
              moveSL: false,
              moveSLTrigger: this.data.settings.moveSLTrigger,
              moveSLValue: this.data.settings.moveSLValue,
              trailingTp: false,
              trailingTpPerc: this.data.settings.trailingTpPerc,
              useMinTP: this.data.settings.useMinTP,
              minTp: this.data.settings.minTp,
              orderSizeType: this.data.settings.orderSizeType,
              useMultiSl: false,
              multiSl: [],
              useMultiTp: false,
              multiTp: [],
              useLimitPrice: false,
              startOrderType: this.data.settings.startOrderType,
              volumeScale: '1',
              stepScale: '1',
              minimumDeviation: '0',
              step: '1',
              futures: this.futures,
              coinm: this.coinm,
              marginType: this.data.settings.marginType,
              leverage: this.data.settings.leverage,
            },
            parent: true,
            child: false,
            childIds: _deals,
            parentId: null,
            // Carry the hedge wrapper id (undefined for non-hedge bots) so the
            // merged deal is classified as a hedge-leg deal exactly like every
            // other deal on this leg. Without it the hedge*DealList queries —
            // which select hedge-leg deals via `parentBotId: { $exists: true }`
            // — silently drop the merged deal, so it never shows in the hedge
            // bot's Deals view.
            parentBotId: this.data.parentBotId,
            gridBreakpoints: [],
            paperContext: this.data.paperContext,
            strategy: this.data.settings.strategy,
            exchange: this.data.exchange,
            exchangeUUID: this.data.exchangeUUID,
            symbol: {
              symbol: ed.pair,
              baseAsset: ed.baseAsset.name,
              quoteAsset: ed.quoteAsset.name,
            },
            stats: {
              drawdownPercent: 0,
              runUpPercent: 0,
              timeInProfit: 0,
              timeInLoss: 0,
              trackTime: 0,
              timeCountStart: Date.now(),
              unrealizedProfit: 0,
              usage: 0,
              maxUsage: 0,
            },
            type: this.data.settings.type,
            tpHistory: deals.map((d) => d.tpHistory ?? []).flat(),
          }
          const newDeal = await this.dealsDb.createData(mergedDeals as any)
          if (newDeal.status === StatusEnum.notok) {
            this.endMethod(_id)
            return this.handleErrors(
              `Error saving merged deal: ${newDeal.reason}`,
              'mergeDeals()',
              'save merged deal',
            )
          } else {
            this.handleLog(`${prefix} Created parent deal ${newDeal.data._id}`)
          }
          const botInstance = new Bot(false)
          for (const d of deals) {
            if (this.combo) {
              await botInstance.closeComboDeal(
                this.userId,
                d.botId,
                `${d._id}`,
                CloseDCATypeEnum.cancel,
                false,
                !!this.data.paperContext,
              )
            } else {
              await botInstance.closeDCADeal(
                this.userId,
                d.botId,
                `${d._id}`,
                CloseDCATypeEnum.cancel,
                false,
                !!this.data.paperContext,
              )
            }
            this.handleLog(`${prefix} Closing deal ${d._id}`)
          }
          this.handleLog(`${prefix} Waiting for 2 seconds`)
          await sleep(2 * 1000)
          await this.dealsDb.updateManyData({ _id: { $in: _deals } } as any, {
            $set: { child: true, parentId: `${newDeal.data._id}` },
          })
          const dealData = {
            ...mergedDeals,
            _id: `${newDeal.data._id}`,
          } as ExcludeDoc<Deal>
          for (const o of orders) {
            const data = {
              dealId: dealData._id,
              typeOrder:
                o.typeOrder === TypeOrderEnum.dealTP
                  ? o.typeOrder
                  : TypeOrderEnum.dealStart,
              botId: this.botId,
            }
            const changedOrder = { ...o, data }

            if (this.shouldProceed()) {
              await this.ordersDb.updateData(
                { clientOrderId: changedOrder.clientOrderId },
                {
                  $set: {
                    ...data,
                  },
                },
              )
            }

            this.emit('bot update', changedOrder)
          }

          const initialOrders = await this.createInitialDealOrders(
            dealData.symbol.symbol,
            dealData.initialPrice,
            dealData._id,
            dealData,
          )
          const currentOrders = await this.createCurrentDealOrders(
            dealData.symbol.symbol,
            dealData.lastPrice,
            initialOrders,
            dealData.settings.avgPrice || dealData.avgPrice,
            dealData.initialPrice,
            dealData._id,
            false,
            dealData,
          )
          const full: FullDeal<ExcludeDoc<Deal>> = {
            initialOrders,
            currentOrders,
            previousOrders: [],
            deal: dealData,
            closeBySl: false,
            notCheckSl: false,
            closeByTp: false,
          }
          await this.checkDealSlMethods(full)
          this.setDeal(full)
          this.emit('bot deal update', dealData)
          await this.setCloseByTimer(full.deal)
          this.reloadBot(this.botId)
        } else {
          this.handleErrors(
            `Cannot find exchange info`,
            'mergeDeals()',
            'exchange',
            false,
            false,
            false,
          )
        }
      }
      this.endMethod(_id)
    }

    async getLeverageMultipler(deal?: ExcludeDoc<Deal>) {
      const key = deal?._id ?? 'bot'
      if (this.leverageMap.has(key)) {
        return this.leverageMap.get(key) ?? 1
      }
      const settings = await this.getAggregatedSettings(deal)
      const result = settings.futures
        ? settings.marginType !== BotMarginTypeEnum.inherit
          ? settings.leverage || 1
          : 1
        : 1
      this.leverageMap.set(key, result)
      return result
    }

    /**
     * Base quantity that a 100% add/reduce-funds request resolves to — i.e.
     * the position the deal currently holds.
     *
     * `usage.current.quote` is the deal's cost basis, accumulated as quote
     * spent (net of realised profit). The only price that turns a cost basis
     * back into the quantity it bought is the price it was bought at, so the
     * divisor is `avgPrice` — the deal's VWAP over its filled orders — and
     * `costBasis / avgPrice` is the base acquired, by construction.
     *
     * It used to divide by `deal.lastPrice`, which reads like a live price but
     * is a running MINIMUM (long) / MAXIMUM (short) of fill prices — see the
     * assignment in `updateDeal`. Cost basis over the *lowest* fill resolves to
     * more base than the deal holds, by exactly the deal's drawdown ratio
     * `avgPrice/lastPrice`, so a long over-sized further the deeper its ladder
     * had filled and a futures short under-sized. That was never the intended
     * quantity: the help article has documented this as "the percentage of the
     * current position" — 1 ETH, 20% => 0.2 ETH — since 2024-10-08. It became
     * wrong when `lastPrice` was redefined into an extreme (2025-01-08) without
     * revisiting the consumers that were reading it as a price.
     *
     * The branches that hold a base amount already (spot short, coin-M) never
     * needed a price and are unchanged.
     *
     * Shared by `addDealFunds` and `reduceDealFunds` deliberately: the two
     * copies of this expression drifted apart for five months once already.
     */
    async percentFundsBasis(deal: ExcludeDoc<Deal>) {
      // A deal with no filled orders has no avgPrice; it also has no position,
      // so the caller's existing zero/finite guards reject it either way.
      const costPrice = deal.avgPrice || deal.lastPrice
      return this.futures
        ? (this.coinm
            ? deal.usage.current.base
            : deal.usage.current.quote / costPrice) *
            (await this.getLeverageMultipler(deal))
        : this.isLong
          ? deal.usage.current.quote / costPrice
          : deal.usage.current.base
    }

    async addFundsForAllDeals(
      qty: string,
      asset: OrderSizeTypeEnum,
      _symbol?: string,
      type?: AddFundsTypeEnum,
      fromWebhook = false,
      limitPrice = false,
      convert = true,
      dealId?: string,
    ) {
      const symbol = convert ? await this.convertSymbol(_symbol, true) : _symbol
      if (_symbol && !symbol) {
        return this.handleWarn(`Signal for ${symbol} cannot be passed`)
      }
      const deals = this.getOpenDeals(false, symbol ?? undefined)
      for (const d of deals.filter((_d) =>
        dealId ? _d.deal._id === dealId : true,
      )) {
        this.addDealFunds(
          this.botId,
          d.deal._id,
          {
            qty,
            asset,
            useLimitPrice: limitPrice,
            type,
          },
          fromWebhook,
        )
      }
    }

    async reduceFundsInAllDeals(
      qty: string,
      asset: OrderSizeTypeEnum,
      _symbol?: string,
      type?: AddFundsTypeEnum,
      fromWebhook = false,
      limitPrice = false,
      convert = true,
      dealId?: string,
    ) {
      const symbol = convert ? await this.convertSymbol(_symbol, true) : _symbol
      if (_symbol && !symbol) {
        return this.handleWarn(`Signal for ${symbol} cannot be passed`)
      }
      const deals = this.getOpenDeals(false, symbol ?? undefined)
      for (const d of deals.filter((_d) =>
        dealId ? _d.deal._id === dealId : true,
      )) {
        this.reduceDealFunds(
          this.botId,
          d.deal._id,
          {
            qty,
            asset,
            useLimitPrice: limitPrice,
            type,
          },
          fromWebhook,
        )
      }
    }

    @IdMute(
      mutex,
      (botId: string, dealId: string) => `addFunds${botId}${dealId}`,
    )
    async addDealFunds(
      _botId: string,
      dealId: string,
      settings: AddFundsSettings,
      fromWebhook = false,
    ) {
      const _id = this.startMethod('addDealFunds')
      this.handleDebug(
        `Add funds | Received add funds for ${dealId}, use limit price: ${settings.useLimitPrice}, price: ${settings.limitPrice}, size: ${settings.qty}, asset: ${settings.asset}, type: ${settings.type}`,
      )
      if (this.combo) {
        this.endMethod(_id)
        return
      }
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot find deal to add funds`, '')
      }
      if (deal.deal.status !== DCADealStatusEnum.open) {
        this.endMethod(_id)
        return this.handleErrors(
          `Funds can only be added to deals with status open`,
          '',
          '',
          false,
          true,
        )
      }
      let price = 0
      if (settings.useLimitPrice && settings.limitPrice) {
        price = +settings.limitPrice
        if (isNaN(price)) {
          price = 0
        }
      }
      if (price === 0) {
        price = await this.getLatestPrice(deal.deal.symbol.symbol)
      }
      if (price === 0) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot get price`, '')
      }
      let origQty = `${this.math.round(
        settings.asset === OrderSizeTypeEnum.base
          ? +settings.qty
          : +settings.qty / price,
        await this.baseAssetPrecision(deal.deal.symbol.symbol),
        false,
        fromWebhook && settings.asset === OrderSizeTypeEnum.quote,
      )}`
      const requiredQty = this.math.round(
        settings.asset === OrderSizeTypeEnum.base
          ? +settings.qty
          : +settings.qty / price,
        await this.baseAssetPrecision(deal.deal.symbol.symbol),
      )
      if (fromWebhook && requiredQty !== 0) {
        origQty = `${requiredQty}`
      }
      if (
        fromWebhook &&
        requiredQty !== +origQty &&
        requiredQty === 0 &&
        settings.type !== AddFundsTypeEnum.perc
      ) {
        this.handleErrors(
          `Order qty was increased from ${requiredQty} ${deal.deal.symbol.baseAsset} to ${origQty} ${deal.deal.symbol.baseAsset} due to exchange minimum requirements`,
          'addDealFunds',
          '',
          false,
        )
      }
      const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
      price =
        typeof ed?.priceAssetPrecision !== 'undefined'
          ? this.math.round(price, ed.priceAssetPrecision)
          : price
      if (settings.type === AddFundsTypeEnum.perc) {
        const qtyPerc = await this.percentFundsBasis(deal.deal)
        this.handleDebug(`Add funds | qtyPerc ${qtyPerc}`)
        origQty = `${this.math.round(
          qtyPerc * (+settings.qty / 100),
          await this.baseAssetPrecision(deal.deal.symbol.symbol),
        )}`
        if (
          +origQty < (ed?.baseAsset.minAmount ?? 0) ||
          +origQty * price < (ed?.quoteAsset.minAmount ?? 0)
        ) {
          const old = origQty
          origQty = `${this.math.round(
            Math.max(
              ed?.baseAsset.minAmount ?? 0,
              (ed?.quoteAsset.minAmount ?? 0) / price,
            ),
            await this.baseAssetPrecision(deal.deal.symbol.symbol),
            false,
            true,
          )}`
          this.handleErrors(
            `Order qty was increased from ${old} ${deal.deal.symbol.baseAsset} to ${origQty} ${deal.deal.symbol.baseAsset} due to exchange minimum requirements`,
            'addDealFunds',
            '',
            false,
          )
        }
      }

      if (+origQty === 0) {
        this.endMethod(_id)
        return this.handleErrors(`Add funds order qty is 0`, '', '', false)
      }
      if (isNaN(+origQty) || !isFinite(+origQty)) {
        this.endMethod(_id)
        return this.handleErrors(`Order qty is not a number`, '', '', false)
      }

      if (
        +origQty < (ed?.baseAsset.minAmount ?? 0) ||
        +origQty * price < (ed?.quoteAsset.minAmount ?? 0)
      ) {
        this.endMethod(_id)
        return this.handleErrors(
          `Add funds order qty is less than exchange minimum requirements`,
          '',
          '',
          false,
        )
      }
      const addFundsId = v4()
      const order: Order = {
        symbol: deal.deal.symbol.symbol,
        orderId: '-1',
        clientOrderId: this.getOrderId(`D-ROA`),
        updateTime: +new Date(),
        price: `${price}`,
        origQty,
        executedQty: '0',
        status: 'NEW',
        origPrice: `${price}`,
        cummulativeQuoteQty: `${price * +origQty}`,
        side: this.isLong ? 'BUY' : 'SELL',
        baseAsset: deal.deal.symbol.baseAsset,
        quoteAsset: deal.deal.symbol.quoteAsset,
        exchange: this.data.exchange,
        exchangeUUID: this.data.exchangeUUID,
        typeOrder: TypeOrderEnum.dealRegular,
        botId: this.botId,
        userId: this.userId,
        type:
          settings.useLimitPrice && settings.limitPrice ? 'LIMIT' : 'MARKET',
        transactTime: new Date().getTime(),
        fills: [],
        dealId,
        positionSide: this.hedge
          ? this.isLong
            ? PositionSide.LONG
            : PositionSide.SHORT
          : PositionSide.BOTH,
        addFundsId,
      }
      this.handleDebug(`Add funds | create order ${order.clientOrderId}`)
      const result = await this.sendOrderToExchange(order)
      if (result && result.status === 'FILLED') {
        this.processFilledOrder(result)
      }
      if (result && result.status !== 'FILLED') {
        deal.deal.pendingAddFunds = [
          ...(deal.deal.pendingAddFunds ?? []),
          { ...settings, id: addFundsId, limitPrice: price },
        ] as Deal['pendingAddFunds']
        deal.deal.levels.all += 1
        this.saveDeal(deal, {
          pendingAddFunds: deal.deal.pendingAddFunds,
          levels: deal.deal.levels,
        }).then(() => {
          this.updateUsage(dealId)
          this.updateAssets(dealId, deal)
          this.updateDealBalances(deal)
        })
      }
      this.endMethod(_id)
    }

    @IdMute(
      mutex,
      (botId: string, dealId: string) => `reduceFunds${botId}${dealId}`,
    )
    async reduceDealFunds(
      _botId: string,
      dealId: string,
      settings: AddFundsSettings,
      fromWebhook = false,
    ) {
      const _id = this.startMethod('reduceDealFunds')
      this.handleDebug(
        `Reduce funds | Received reduce funds for ${dealId}, use limit price: ${settings.useLimitPrice}, price: ${settings.limitPrice}, size: ${settings.qty}, asset: ${settings.asset}, type: ${settings.type}`,
      )
      if (this.combo) {
        this.endMethod(_id)
        return
      }
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot find deal to reduce funds`, '')
      }
      if (deal.deal.status !== DCADealStatusEnum.open) {
        this.endMethod(_id)
        return this.handleErrors(
          `Funds can only be reduced in deal with status open`,
          '',
          '',
          false,
          true,
        )
      }
      let price = 0
      if (settings.useLimitPrice && settings.limitPrice) {
        price = +settings.limitPrice
        if (isNaN(price)) {
          price = 0
        }
      }
      if (price === 0) {
        price = await this.getLatestPrice(deal.deal.symbol.symbol)
      }
      if (price === 0) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot get price`, '')
      }
      let origQty = `${this.math.round(
        settings.asset === OrderSizeTypeEnum.base
          ? +settings.qty
          : +settings.qty / price,
        await this.baseAssetPrecision(deal.deal.symbol.symbol),
        false,
        fromWebhook && settings.asset === OrderSizeTypeEnum.quote,
      )}`
      const requiredQty = this.math.round(
        settings.asset === OrderSizeTypeEnum.base
          ? +settings.qty
          : +settings.qty / price,
        await this.baseAssetPrecision(deal.deal.symbol.symbol),
      )
      if (fromWebhook && requiredQty !== 0) {
        origQty = `${requiredQty}`
      }
      if (
        fromWebhook &&
        requiredQty !== +origQty &&
        requiredQty === 0 &&
        settings.type !== AddFundsTypeEnum.perc
      ) {
        this.handleErrors(
          `Order qty was increased from ${requiredQty} ${deal.deal.symbol.baseAsset} to ${origQty} ${deal.deal.symbol.baseAsset} due to exchange minimum requirements`,
          'reduceDealFunds',
          '',
          false,
        )
      }
      const ed = await this.getExchangeInfo(deal.deal.symbol.symbol)
      price =
        typeof ed?.priceAssetPrecision !== 'undefined'
          ? this.math.round(price, ed.priceAssetPrecision)
          : price
      if (settings.type === AddFundsTypeEnum.perc) {
        const qtyPerc = await this.percentFundsBasis(deal.deal)
        this.handleDebug(`Reduce funds | qtyPerc ${qtyPerc}`)
        origQty = `${this.math.round(
          qtyPerc * (+settings.qty / 100),
          await this.baseAssetPrecision(deal.deal.symbol.symbol),
        )}`

        if (
          +origQty < (ed?.baseAsset.minAmount ?? 0) ||
          +origQty * price < (ed?.quoteAsset.minAmount ?? 0)
        ) {
          const old = origQty
          origQty = `${this.math.round(
            Math.max(
              ed?.baseAsset.minAmount ?? 0,
              (ed?.quoteAsset.minAmount ?? 0) / price,
            ),
            await this.baseAssetPrecision(deal.deal.symbol.symbol),
            false,
            true,
          )}`
          this.handleErrors(
            `Order qty was increased from ${old} ${deal.deal.symbol.baseAsset} to ${origQty} ${deal.deal.symbol.baseAsset} due to exchange minimum requirements`,
            'reduceDealFunds',
            '',
            false,
          )
        }
      }

      if (+origQty === 0) {
        this.endMethod(_id)
        return this.handleErrors(`Reduce funds order qty is 0`, '', '', false)
      }
      if (isNaN(+origQty) || !isFinite(+origQty)) {
        this.endMethod(_id)
        return this.handleErrors(`Reduce qty is not a number`, '', '', false)
      }

      if (
        +origQty < (ed?.baseAsset.minAmount ?? 0) ||
        +origQty * price < (ed?.quoteAsset.minAmount ?? 0)
      ) {
        this.endMethod(_id)
        return this.handleErrors(
          `Reduce funds order qty is less than exchange minimum requirements`,
          '',
          '',
          false,
        )
      }
      const tpOrder = await this.getTPOrder(
        deal.deal.symbol.symbol,
        price,
        deal.initialOrders,
        deal.deal.avgPrice,
        deal.deal.initialPrice,
        dealId,
        deal.deal,
        true,
        false,
        price,
      )
      const tpQty = tpOrder?.[0]?.qty ?? 0
      if (tpQty <= +origQty) {
        // Nothing is left to keep, so the reduce is fulfilled by closing the
        // deal below. The message must say so: it used to claim the requested
        // qty was "more than" the position even when the two were equal (a
        // 100% reduce), and that the order size "will be reduced" when in fact
        // no reduce order is placed at all.
        this.handleErrors(
          tpQty === +origQty
            ? `Reduce funds order qty ${origQty} ${ed?.baseAsset.name} covers the whole remaining position ${tpQty} ${ed?.baseAsset.name}. The deal will be closed`
            : `Reduce funds order qty ${origQty} ${ed?.baseAsset.name} is more than the remaining position ${tpQty} ${ed?.baseAsset.name}. The deal will be closed`,
          '',
          '',
          false,
        )

        this.endMethod(_id)
        return this.closeDealById(
          this.botId,
          dealId,
          settings.useLimitPrice
            ? CloseDCATypeEnum.closeByLimit
            : CloseDCATypeEnum.closeByMarket,
          undefined,
          undefined,
          undefined,
          false,
          `${price}`,
          undefined,
          undefined,
          DCACloseTriggerEnum.auto,
        )
      }
      const orders = this.getOrdersByStatusAndDealId({
        status: 'NEW',
        dealId,
      }).filter((o) => o.typeOrder === TypeOrderEnum.dealTP && !o.reduceFundsId)
      for (const o of orders) {
        this.handleDebug(`Reduce funds | Cancel order ${o.clientOrderId}`)
        await this.cancelOrderOnExchange(o)
      }
      const reduceFundsId = v4()
      const order: Order = {
        symbol: deal.deal.symbol.symbol,
        orderId: '-1',
        clientOrderId: this.getOrderId(`D-TPR`),
        updateTime: +new Date(),
        price: `${price}`,
        origQty,
        executedQty: '0',
        status: 'NEW',
        origPrice: `${price}`,
        cummulativeQuoteQty: `${price * +origQty}`,
        side: this.isLong ? 'SELL' : 'BUY',
        baseAsset: deal.deal.symbol.baseAsset,
        quoteAsset: deal.deal.symbol.quoteAsset,
        exchange: this.data.exchange,
        exchangeUUID: this.data.exchangeUUID,
        typeOrder: TypeOrderEnum.dealTP,
        botId: this.botId,
        userId: this.userId,
        type:
          settings.useLimitPrice && settings.limitPrice ? 'LIMIT' : 'MARKET',
        transactTime: new Date().getTime(),
        fills: [],
        dealId,
        positionSide: this.hedge
          ? this.isLong
            ? PositionSide.LONG
            : PositionSide.SHORT
          : PositionSide.BOTH,
        reduceFundsId,
      }
      this.handleDebug(`Reduce funds | create order ${order.clientOrderId}`)
      const result = await this.sendOrderToExchange(order)
      if (result && result.status === 'FILLED') {
        this.processFilledOrder(result)
      }
      if (result && result.status !== 'FILLED') {
        deal.deal.pendingReduceFunds = [
          ...(deal.deal.pendingReduceFunds ?? []),
          { ...settings, id: reduceFundsId, limitPrice: price },
        ] as Deal['pendingReduceFunds']
        this.saveDeal(deal, {
          pendingReduceFunds: deal.deal.pendingReduceFunds,
          levels: deal.deal.levels,
        }).then(() => {
          this.updateUsage(dealId)
          this.updateAssets(dealId, deal)
          this.updateDealBalances(deal)
        })
      }
      this.endMethod(_id)
    }

    @IdMute(
      mutex,
      (botId: string, dealId: string) =>
        `cancelTerminalDealOrder${botId}${dealId}`,
    )
    async cancelTerminalDealOrder(
      _botId: string,
      dealId: string,
      orderId: string,
    ) {
      const _id = this.startMethod('cancelTerminalDealOrder')
      this.handleDebug(
        `Cancel terminal deal order | Received cancel for ${dealId}, order: ${orderId}`,
      )
      if (this.combo) {
        this.endMethod(_id)
        return
      }
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot find deal to cancel order`, '')
      }
      if (deal.deal.status !== DCADealStatusEnum.open) {
        this.endMethod(_id)
        return this.handleErrors(
          `Cannot find deal to cancel order in deal with status open`,
          '',
        )
      }
      let order = this.getOrderFromMap(orderId)
      if (!order) {
        order = (await this.ordersDb.readData({ clientOrderId: orderId })).data
          ?.result
      }
      if (!order) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot find order to cancel`, '')
      }
      if (order.status !== 'NEW') {
        this.endMethod(_id)
        return this.handleErrors(`Cannot cancel processing order`, '')
      }

      if (order.typeOrder !== TypeOrderEnum.dealTP) {
        deal.deal.pendingAddFunds = (deal.deal.pendingAddFunds ?? []).filter(
          (paf) => order && paf.id !== order.addFundsId,
        )
        deal.deal.levels.all -= 1
        deal.deal.blockOrders = [
          ...(deal.deal.blockOrders ?? []),
          {
            price: +order.price,
            qty: +order.origQty,
            side: order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
          },
        ]
      }
      if (order.typeOrder === TypeOrderEnum.dealTP) {
        deal.deal.pendingReduceFunds = (
          deal.deal.pendingReduceFunds ?? []
        ).filter((paf) => order && paf.id !== order.addFundsId)
      }
      deal.initialOrders = await this.createInitialDealOrders(
        deal.deal.symbol.symbol,
        deal.deal.initialPrice,
        dealId,
        deal.deal,
      )
      deal.previousOrders = deal.currentOrders
      deal.currentOrders = await this.createCurrentDealOrders(
        deal.deal.symbol.symbol,
        deal.deal.lastPrice,
        deal.initialOrders,
        deal.deal.avgPrice,
        deal.deal.initialPrice,
        dealId,
        undefined,
        deal.deal,
        undefined,
        undefined,
      )
      this.saveDeal(deal, {
        pendingAddFunds: deal.deal.pendingAddFunds,
        pendingReduceFunds: deal.deal.pendingReduceFunds,
        levels: deal.deal.levels,
        blockOrders: deal.deal.blockOrders,
      })
      await this.cancelOrderOnExchange(order)
      this.placeOrders(
        this.botId,
        deal.deal.symbol.symbol,
        dealId,
        this.findDiff(
          deal.currentOrders,
          deal.previousOrders.filter(
            (o) =>
              order &&
              (order.reduceFundsId
                ? !(
                    o.type === TypeOrderEnum.dealTP &&
                    o.price === +order.origPrice &&
                    o.qty === +order.origQty
                  )
                : !(
                    o.type === TypeOrderEnum.dealRegular &&
                    o.price === +order.origPrice &&
                    o.qty === +order.origQty
                  )),
          ),
        ),
      )
    }

    @IdMute(
      mutex,
      (botId: string, dealId: string) =>
        `cancelPendingAddFundsDealOrder${botId}${dealId}`,
    )
    async cancelPendingAddFundsDealOrder(
      _botId: string,
      dealId: string,
      orderId: string,
    ) {
      const _id = this.startMethod('cancelPendingAddFundsDealOrder')
      this.handleDebug(
        `Cancel pending add funds deal order | Received cancel for ${dealId}, order: ${orderId}`,
      )
      if (this.combo) {
        this.endMethod(_id)
        return
      }
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      const deal = this.getDeal(dealId)
      if (!deal) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot find deal to cancel order`, '')
      }
      if (deal.deal.status !== DCADealStatusEnum.open) {
        this.endMethod(_id)
        return this.handleErrors(
          `Cannot find deal to cancel order in deal with status open`,
          '',
        )
      }
      let reduce = false
      let order = (deal.deal.pendingAddFunds ?? []).find(
        (o) => o.id === orderId,
      )
      if (!order) {
        order = (deal.deal.pendingReduceFunds ?? []).find(
          (o) => o.id === orderId,
        )
        if (order) {
          reduce = true
        }
      }
      if (!order) {
        this.endMethod(_id)
        return this.handleErrors(`Cannot find order to cancel`, '')
      }

      if (!reduce) {
        deal.deal.pendingAddFunds = (deal.deal.pendingAddFunds ?? []).filter(
          (paf) => paf.id !== orderId,
        )
      }
      if (reduce) {
        deal.deal.pendingReduceFunds = (
          deal.deal.pendingReduceFunds ?? []
        ).filter((paf) => paf.id !== orderId)
      }
      deal.initialOrders = await this.createInitialDealOrders(
        deal.deal.symbol.symbol,
        deal.deal.initialPrice,
        dealId,
        deal.deal,
      )
      deal.currentOrders = await this.createCurrentDealOrders(
        deal.deal.symbol.symbol,
        deal.deal.lastPrice,
        deal.initialOrders,
        deal.deal.avgPrice,
        deal.deal.initialPrice,
        dealId,
        undefined,
        deal.deal,
        undefined,
        undefined,
      )
      this.saveDeal(deal, {
        pendingAddFunds: deal.deal.pendingAddFunds,
        pendingReduceFunds: deal.deal.pendingReduceFunds,
        levels: deal.deal.levels,
        blockOrders: deal.deal.blockOrders,
      })
      const realOrder = this.allOrders.find((o) =>
        reduce ? o.reduceFundsId === orderId : o.addFundsId === orderId,
      )
      if (realOrder) {
        await this.cancelOrderOnExchange(realOrder)
      }
      if (realOrder && reduce) {
        this.reloadBot(this.botId)
      }
    }

    private getEmptyStats(): {
      stats: BotStats
      symbolStats: BotSymbolsStats[]
    } {
      const usdAsset = () => ({
        usd: 0,
        asset: 0,
      })
      const series = () => ({
        count: 0,
        max: 0,
        value: usdAsset(),
        minValue: usdAsset(),
        maxValue: usdAsset(),
        perc: 0,
      })
      return {
        stats: {
          numerical: {
            profit: {
              grossProfit: usdAsset(),
              grossProfitPerc: 0,
              maxDealProfit: usdAsset(),
              maxDealProfitPerc: 0,
              avgDealProfit: usdAsset(),
              avgDealProfitPerc: 0,
              maxRunUp: usdAsset(),
              maxRunUpPerc: 0,
              maxConsecutiveWins: 0,
              standardDeviationOfPositiveReturns: 0,
              series: series(),
            },
            loss: {
              grossLoss: usdAsset(),
              grossLossPerc: 0,
              maxDealLoss: usdAsset(),
              maxDealLossPerc: 0,
              avgDealLoss: usdAsset(),
              avgDealLossPerc: 0,
              maxDrawdown: usdAsset(),
              maxDrawdownPerc: 0,
              maxEquityDrawdown: usdAsset(),
              maxEquityDrawdownPerc: 0,
              maxConsecutiveLosses: 0,
              standardDeviationOfNegativeReturns: 0,
              standardDeviationOfDownside: 0,
              series: series(),
              seriesEquity: {
                value: 0,
                min: 0,
                max: 0,
                perc: 0,
              },
            },
            general: {
              netProfitPerc: 0,
              avgDaily: usdAsset(),
              avgDailyPerc: 0,
              annualizedReturn: 0,
              startBalance: usdAsset(),
              maxDCAOrdersTriggered: 0,
              avgDCAOrdersTriggered: 0,
              coveredPriceDeviation: 0,
              actualPriceDeviation: 0,
              confidenceGrade: '',
            },
            ratios: {
              profitFactor: 0,
              sharpeRatio: 0,
              sortinoRatio: 0,
              cwr: 0,
              buyAndHold: {
                result: 0,
                perc: 0,
                symbol: '',
                startPrice: 0,
              },
            },
            usage: {
              maxTheoreticalUsage: 0,
              maxActualUsage: 0,
              avgDealUsage: 0,
            },
            deals: {
              profit: 0,
              loss: 0,
            },
          },
          duration: {
            profit: {
              avgWinningTradeDuration: 0,
              maxWinningTradeDuration: 0,
              totalTime: 0,
            },
            loss: {
              avgLosingTradeDuration: 0,
              maxLosingTradeDuration: 0,
              totalTime: 0,
            },
            general: {
              maxDealDuration: 0,
              avgDealDuration: 0,
              dealsPerDay: 0,
              workingTime: 0,
              totalTime: 0,
            },
          },
          chart: [],
        },
        symbolStats: (this.data?.settings.pair ?? []).map((symbol) => ({
          numerical: {
            deals: {
              profit: 0,
              loss: 0,
            },
            general: {
              startBalance: usdAsset(),
              netProfit: usdAsset(),
              netProfitPerc: 0,
              dailyProfit: usdAsset(),
              dailyProfitPerc: 0,
              winRate: 0,
              profitFactor: 0,
            },
          },
          duration: {
            maxDealDuration: 0,
            avgDealDuration: 0,
            totalTime: 0,
            measuredDeals: 0,
          },
          symbol,
        })),
      }
    }

    /**
     * Latest price of the buy & hold REFERENCE pair, or 0 when there is none.
     *
     * The reference is pinned once and never revisited, so it routinely
     * outlives the bot's interest in the pair: `checkSettingsPairs()` prunes a
     * delisted pair out of `settings.pair`, and the benchmark keeps pointing at
     * it. Asking the venue for a pair the platform has no exchange info for
     * cannot return a price — it returns a rejection, once per stats tick, for
     * the life of the bot (`Not supported symbols` on `XIONUSDT`, 1619 times on
     * one bot; spec 006).
     *
     * So gate on exchange info first, the same way `placeOrders` does. A
     * transient miss costs nothing here: the caller keeps the previous
     * benchmark instead of writing a wrong one, which is why this uses the
     * plain cached read rather than `confirmPairMissing`'s forced re-reads —
     * those exist for the destructive "drop the pair and stop the bot"
     * decision, not for skipping one benchmark tick.
     */
    private async benchmarkRate(pair: string): Promise<number> {
      if (!pair || !(await this.getExchangeInfo(pair))) {
        return 0
      }
      return await this.getLatestPrice(pair)
    }

    @IdMute(mutex, (botId: string) => `${botId}updateBotStats`)
    @IdMute(mutexConcurrently, () => 'updateEquityStats')
    async updateEquityStats(_botId: string) {
      const _id = this.startMethod('updateEquityStats')
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      if (this.equityTimer) {
        clearTimeout(this.equityTimer)
      }
      if (this.data?.ignoreStats) {
        this.endMethod(_id)
        return
      }
      this.handleLog(`Update equity stats`)
      this.setEquityTimer()
      let { stats, symbolStats } = this.data
      const emptyStats = this.getEmptyStats()
      if (!stats) {
        stats = emptyStats.stats
      }
      if (!symbolStats) {
        symbolStats = emptyStats.symbolStats
      }
      const time = new Date()
      time.setHours(0, 0, 0, 0)
      time.setDate(time.getDate() - 1)
      const settings = await this.getAggregatedSettings()
      if (!settings.pair?.length) {
        this.endMethod(_id)
        return
      }
      let stop = false
      const pairToUse =
        stats.numerical.ratios.buyAndHold.symbol || settings.pair[0]
      if (
        !stats.numerical.general.startBalance.asset &&
        (this.data.usage.max.quote || this.data.usage.max.base)
      ) {
        const profitBase = await this.profitBase()
        const latestPrice = await this.getLatestPrice(pairToUse)
        const use = this.futures
          ? this.coinm
            ? this.data.usage.max.base
            : this.data.usage.max.quote
          : this.isLong
            ? this.data.usage.max.quote / (profitBase ? latestPrice : 1)
            : this.data.usage.max.base * (profitBase ? 1 : latestPrice)
        const usdRate = await this.getUsdRate(
          pairToUse,
          this.futures
            ? this.coinm
              ? 'base'
              : 'quote'
            : profitBase
              ? 'base'
              : 'quote',
        )
        if (!stats.numerical.general.startBalance.asset) {
          stats.numerical.general.startBalance.asset = use
          stats.numerical.general.startBalance.usd =
            stats.numerical.general.startBalance.asset * usdRate
          stats.numerical.ratios.buyAndHold.symbol = pairToUse
          stats.numerical.ratios.buyAndHold.startPrice = latestPrice
        }
      }
      if (!stats.numerical.general.startBalance.asset) {
        this.endMethod(_id)
        return
      }
      if (!stats.chart.length) {
        stats.chart.push({
          time: +time,
          equity: stats.numerical.general.startBalance.usd,
          buyAndHold: stats.numerical.general.startBalance.usd,
          realizedProfit: stats.numerical.general.startBalance.usd,
        })
        stop = true
      }
      const prev = [...stats.chart]
        .filter((c) => c.time < +time)
        .sort((a, b) => b.time - a.time)[0]
      if (!stop) {
        const rates: Map<string, number> = new Map()
        const prices: Map<string, number> = new Map()
        let equity = 0
        let bnh = 0
        for (const d of this.getOpenDeals(true)) {
          const symbol = d.deal.symbol.symbol
          const baseName = d.deal.symbol.baseAsset
          const baseRate =
            rates.get(baseName) ?? (await this.getUsdRate(symbol, 'base'))
          const quoteName = d.deal.symbol.quoteAsset
          const quoteRate =
            rates.get(quoteName) ?? (await this.getUsdRate(symbol, 'quote'))
          rates.set(baseName, baseRate)
          rates.set(quoteName, quoteRate)
          if (this.futures && !prices.has(symbol)) {
            prices.set(symbol, await this.getLatestPrice(symbol))
          }

          const used = this.futures
            ? this.coinm
              ? d.deal.usage.max.base * baseRate
              : d.deal.usage.max.quote * quoteRate
            : this.isLong
              ? d.deal.usage.max.quote * quoteRate
              : d.deal.usage.max.base * baseRate
          equity += this.futures
            ? this.coinm
              ? (d.deal.currentBalances.base +
                  d.deal.currentBalances.quote /
                    (prices.get(symbol) ?? d.deal.lastPrice) -
                  (d.deal.initialBalances.base +
                    d.deal.initialBalances.quote / d.deal.initialPrice)) *
                (this.isLong ? 1 : -1) *
                baseRate
              : (d.deal.currentBalances.base *
                  (prices.get(symbol) ?? d.deal.lastPrice) +
                  d.deal.currentBalances.quote -
                  (d.deal.initialBalances.base * d.deal.initialPrice +
                    d.deal.initialBalances.quote)) *
                (this.isLong ? 1 : -1) *
                quoteRate
            : (d.deal.currentBalances.base * baseRate +
                d.deal.currentBalances.quote * quoteRate) /
                (await this.getLeverageMultipler()) -
              used
        }
        const usdRate = await this.getUsdRate(
          pairToUse,
          this.futures
            ? this.coinm
              ? 'base'
              : 'quote'
            : (await this.profitBase())
              ? 'base'
              : 'quote',
        )
        const balanceUsd = settings.useMulti
          ? stats.numerical.general.startBalance.usd + this.data.profit.totalUsd
          : this.futures ||
              (this.isLong && !(await this.profitBase())) ||
              ((await this.profitBase()) && !this.isLong)
            ? (stats.numerical.general.startBalance.asset +
                this.data.profit.total) *
              usdRate
            : stats.numerical.general.startBalance.usd +
              this.data.profit.total * usdRate
        equity = balanceUsd + equity
        let bnhUsdRate = 1
        let bnhPriced = false
        if (
          stats.numerical.ratios.buyAndHold.startPrice &&
          stats.numerical.general.startBalance.usd
        ) {
          const bnhRate = await this.benchmarkRate(pairToUse)
          bnhUsdRate = await this.getUsdRate(
            pairToUse,
            (await this.profitBase()) ? 'base' : 'quote',
          )
          const outcome = buyAndHoldOutcome({
            startBalanceAsset: stats.numerical.general.startBalance.asset,
            startBalanceUsd: stats.numerical.general.startBalance.usd,
            startPrice: stats.numerical.ratios.buyAndHold.startPrice,
            rate: bnhRate,
            usdRate: bnhUsdRate,
          })
          if (outcome) {
            bnhPriced = true
            bnh = outcome.asset
            stats.numerical.ratios.buyAndHold.result = outcome.result
            stats.numerical.ratios.buyAndHold.perc = outcome.perc
          }
        }
        const current = stats.chart.find((c) => c.time === +time)
        stats.chart = stats.chart.filter((c) => c.time !== +time)
        stats.chart.push({
          time: +time,
          equity: equity,
          // Without a rate there is no benchmark to plot. Writing `0 * 1` here
          // is what flattened the buy & hold line to zero for the whole 90-day
          // window while equity moved normally — carry the last point forward
          // instead, same rule as `realizedProfit` below.
          buyAndHold: bnhPriced
            ? bnh * bnhUsdRate
            : carryForwardBenchmark(
                current?.buyAndHold,
                prev?.buyAndHold,
                stats.numerical.general.startBalance.usd,
              ),
          // `??` only skips null/undefined, so a point that was once written
          // with a NaN realized profit carried that NaN forward on every later
          // tick and blocked the whole stats write for good. `equity` above is
          // recomputed from scratch each tick and self-heals; make this do the
          // same by falling through a non-finite carry-forward.
          realizedProfit:
            [
              current?.realizedProfit,
              prev?.realizedProfit,
              stats.numerical.general.startBalance.usd,
            ].find((v) => Number.isFinite(v)) ?? 0,
        })
      }
      if (stats.chart.length > 90) {
        stats.chart.shift()
      }
      if (stats.chart.length >= 1) {
        const last = stats.chart[stats.chart.length - 1]
        const secondToLast = stats.chart[stats.chart.length - 2]
        if (!secondToLast) {
          stats.numerical.loss.seriesEquity = {
            value: 0,
            min: last.equity,
            max: last.equity,
            perc: 0,
          }
        }
        if (last.equity > stats.numerical.loss.seriesEquity.max) {
          stats.numerical.loss.seriesEquity.max = last.equity
          stats.numerical.loss.seriesEquity.min = last.equity
        }
        if (last.equity < stats.numerical.loss.seriesEquity.max) {
          const tempValue = stats.numerical.loss.seriesEquity.max - last.equity
          if (tempValue > stats.numerical.loss.seriesEquity.value) {
            stats.numerical.loss.seriesEquity.value = tempValue
            stats.numerical.loss.seriesEquity.min = last.equity
            stats.numerical.loss.seriesEquity.perc =
              tempValue / stats.numerical.loss.seriesEquity.max
            stats.numerical.loss.maxEquityDrawdown.usd = tempValue
            stats.numerical.loss.maxEquityDrawdownPerc =
              stats.numerical.loss.seriesEquity.perc
          }
        }
      }
      if (stats.chart.length >= 2) {
        const last = stats.chart[stats.chart.length - 1]
        const profit = last.realizedProfit
        if (profit > (stats.numerical.general.bestDay?.value ?? 0)) {
          stats.numerical.general.bestDay = {
            time: last.time,
            value: profit,
            percentage:
              profit / (stats.numerical.general.startBalance.usd || 1),
          }
        }
        if (profit < (stats.numerical.general.worstDay?.value ?? 0)) {
          stats.numerical.general.worstDay = {
            time: last.time,
            value: profit,
            percentage:
              profit / (stats.numerical.general.startBalance.usd || 1),
          }
        }
      }
      this.data.stats = stats
      this.data.symbolStats = symbolStats
      this.updateData({ stats, symbolStats })
      this.emit('bot stats update', { stats, symbolStats })
      this.endMethod(_id)
    }

    @IdMute(mutex, (botId: string) => `${botId}updateBotStats`)
    async botUpdateStats(_botId: string, d: FullDeal<ExcludeDoc<Deal>>) {
      if (!this.shouldProceed()) {
        this.handleLog(this.notProceedMessage('Bot update stats'))
        return
      }
      const _id = this.startMethod('botUpdateStats')
      if (!this.data) {
        this.endMethod(_id)
        return
      }
      if (this.data.settings.type === DCATypeEnum.terminal) {
        this.endMethod(_id)
        return
      }
      if (this.data?.ignoreStats) {
        this.endMethod(_id)
        return
      }
      const readResetTime = (
        await this.db?.readData<{ resetStatsAfter?: number }>(
          { _id: this.botId },
          { resetStatsAfter: 1 },
        )
      )?.data?.result?.resetStatsAfter as number | undefined
      const { deal } = d
      if (readResetTime && deal.createTime < readResetTime) {
        this.endMethod(_id)
        return
      }
      const settings = await this.getAggregatedSettings(deal)
      const emptyStats = this.getEmptyStats()
      let { stats, symbolStats } = this.data
      if (!stats) {
        stats = emptyStats.stats
      }
      if (!symbolStats?.length) {
        symbolStats = emptyStats.symbolStats
      }
      const combo = this.combo
      const comboBasedOn = await this.comboBasedOn(deal)
      const _usdRate = await this.getUsdRate(deal.symbol.symbol)
      const usdRate =
        _usdRate *
        (this.futures
          ? this.coinm
            ? deal.lastPrice
            : 1
          : this.isLong
            ? 1
            : deal.lastPrice)
      const profitBase = await this.profitBase(deal)
      const baseUsage = combo
        ? comboBasedOn === ComboTpBase.full
          ? deal.usage.max.base
          : deal.usage.current.base
        : deal.usage.current.base
      const quoteUsage = combo
        ? comboBasedOn === ComboTpBase.full
          ? deal.usage.max.quote
          : deal.usage.current.quote
        : deal.usage.current.quote
      const usage = this.futures
        ? this.coinm
          ? baseUsage
          : quoteUsage
        : this.isLong
          ? quoteUsage
          : baseUsage
      if (usage > stats.numerical.usage.maxActualUsage) {
        stats.numerical.usage.maxActualUsage = usage
      }
      const end = deal.closeTime ?? deal.updateTime
      if (deal.profit.total !== 0) {
        const multipltyUsage = this.futures
          ? 1
          : this.isLong
            ? (await this.profitBase(deal))
              ? 1 / deal.avgPrice
              : 1
            : (await this.profitBase(deal))
              ? 1
              : deal.avgPrice
        const perc = deal.profit.total / (usage * multipltyUsage)
        this.botProfitDb
          .createData({
            userId: this.userId,
            botId: this.botId,
            type: this.botType,
            value: perc,
            time: end,
          })
          .then(async () => {
            const count =
              (await this.botProfitDb.countData({ botId: this.botId }))?.data
                ?.result ?? 0
            if (count > 600) {
              this.handleDebug(
                `Bot update stats | Clear profit db. Profit count: ${count}`,
              )
              const last = await this.botProfitDb.readData(
                { botId: this.botId },
                {},
                { sort: { time: -1 }, limit: 1, skip: 500 },
              )
              if (last.data?.result) {
                try {
                  this.handleDebug(
                    `Bot update stats | Clear profit db. Found last record ${new Date(
                      last.data.result.time,
                    ).toISOString()}`,
                  )
                  await this.botProfitDb
                    .deleteManyData({
                      botId: this.botId,
                      time: { $lt: last.data.result.time },
                    })
                    .then((r) => {
                      this.handleDebug(
                        `Bot update stats | Clear profit db. Deleted records result: ${r.reason}`,
                      )
                    })
                } catch (e) {
                  logger.error(
                    `Error clearing profit db: ${e}, ${JSON.stringify(last)}`,
                  )
                }
              }
            }
          })
      }

      const isProfit = isFinite(deal.profit.total) && deal.profit.total > 0
      const isLoss = isFinite(deal.profit.total) && deal.profit.total < 0

      const workingTime = this.data.workingShift.reduce(
        (acc, ws) => acc + (ws.end ?? +new Date()) - ws.start,
        0,
      )
      const workingDays = workingTime / (24 * 60 * 60 * 1000)

      const use = this.futures
        ? this.coinm
          ? deal.usage.max.base
          : deal.usage.max.quote
        : this.isLong
          ? deal.usage.max.quote / (profitBase ? deal.initialPrice : 1)
          : deal.usage.max.base * (profitBase ? 1 : deal.initialPrice)
      const multiply = this.futures
        ? 1
        : this.isLong
          ? profitBase
            ? deal.initialPrice
            : 1
          : profitBase
            ? 1
            : 1 / deal.initialPrice
      // A deal canceled before its base order ever filled carries no price:
      // `initialPrice`, `lastPrice` and `usage.max` are all 0. There is nothing
      // to seed a start balance from, and seeding anyway poisons the stats —
      // `use` is 0 while `multiply` is `1 / deal.initialPrice` = Infinity on a
      // spot SHORT bot taking profit in quote, so `startBalance.usd` becomes
      // `0 * Infinity` = NaN (spot LONG taking profit in base divides by the
      // same 0 and lands on the same NaN). Mongoose rejects the whole `$set` on
      // that NaN, so the bot silently stops persisting ANY stats until its
      // process restarts.
      const dealHasPrice =
        Number.isFinite(deal.initialPrice) && deal.initialPrice > 0
      if (dealHasPrice && !stats.numerical.general.startBalance.asset) {
        const maxDeals = Math.max(
          1,
          settings.maxNumberOfOpenDeals &&
            +settings.maxNumberOfOpenDeals &&
            !isNaN(+settings.maxNumberOfOpenDeals) &&
            isFinite(+settings.maxNumberOfOpenDeals)
            ? +settings.maxNumberOfOpenDeals
            : 1,
        )
        stats.numerical.general.startBalance.asset = use * maxDeals
        stats.numerical.general.startBalance.usd =
          stats.numerical.general.startBalance.asset * usdRate * multiply
      }
      if (
        (isProfit && !!stats.numerical.loss.series.count) ||
        (isLoss && !!stats.numerical.profit.series.count)
      ) {
        stats.numerical.loss.series.count = 0
        stats.numerical.profit.series.count = 0
      }
      if (isProfit) {
        stats.numerical.deals.profit += 1
        stats.numerical.profit.grossProfit.usd += d.deal.profit.totalUsd
        stats.numerical.profit.grossProfit.asset += d.deal.profit.total
        stats.numerical.profit.grossProfitPerc =
          stats.numerical.profit.grossProfit.usd /
          stats.numerical.general.startBalance.usd
        stats.numerical.profit.avgDealProfit.usd =
          stats.numerical.profit.grossProfit.usd / stats.numerical.deals.profit
        if (isNaN(stats.numerical.profit.avgDealProfit.usd)) {
          stats.numerical.profit.avgDealProfit.usd = 0
        }
        stats.numerical.profit.avgDealProfit.asset =
          stats.numerical.profit.grossProfit.asset /
          stats.numerical.deals.profit
        if (isNaN(stats.numerical.profit.avgDealProfit.asset)) {
          stats.numerical.profit.avgDealProfit.asset = 0
        }
        stats.numerical.profit.avgDealProfitPerc =
          stats.numerical.profit.avgDealProfit.usd /
          stats.numerical.general.startBalance.usd
        stats.numerical.profit.series.count += 1
        if (
          stats.numerical.profit.series.count >
          stats.numerical.profit.maxConsecutiveWins
        ) {
          stats.numerical.profit.maxConsecutiveWins =
            stats.numerical.profit.series.count
        }
        if (!(stats.numerical.deals.loss + stats.numerical.deals.profit - 1)) {
          stats.numerical.profit.series.value.asset = deal.profit.total
          stats.numerical.profit.series.value.usd = deal.profit.totalUsd
          stats.numerical.profit.series.minValue.asset =
            stats.numerical.general.startBalance.asset
          stats.numerical.profit.series.minValue.usd =
            stats.numerical.general.startBalance.usd
          stats.numerical.profit.series.maxValue.asset =
            stats.numerical.general.startBalance.asset + deal.profit.total
          stats.numerical.profit.series.maxValue.usd =
            stats.numerical.general.startBalance.usd + deal.profit.totalUsd
          stats.numerical.profit.series.perc =
            deal.profit.totalUsd / stats.numerical.general.startBalance.usd
        }
      }
      if (isLoss) {
        stats.numerical.deals.loss += 1
        stats.numerical.loss.grossLoss.usd += d.deal.profit.totalUsd
        stats.numerical.loss.grossLoss.asset += d.deal.profit.total
        stats.numerical.loss.grossLossPerc =
          stats.numerical.loss.grossLoss.usd /
          stats.numerical.general.startBalance.usd
        stats.numerical.loss.avgDealLoss.usd =
          stats.numerical.loss.grossLoss.usd / stats.numerical.deals.loss
        if (isNaN(stats.numerical.loss.avgDealLoss.usd)) {
          stats.numerical.loss.avgDealLoss.usd = 0
        }
        stats.numerical.loss.avgDealLoss.asset =
          stats.numerical.loss.grossLoss.asset / stats.numerical.deals.loss
        if (isNaN(stats.numerical.loss.avgDealLoss.asset)) {
          stats.numerical.loss.avgDealLoss.asset = 0
        }
        stats.numerical.loss.avgDealLossPerc =
          stats.numerical.loss.avgDealLoss.usd /
          stats.numerical.general.startBalance.usd
        stats.numerical.loss.series.count += 1
        if (
          stats.numerical.loss.series.count >
          stats.numerical.loss.maxConsecutiveLosses
        ) {
          stats.numerical.loss.maxConsecutiveLosses =
            stats.numerical.loss.series.count
        }
        if (!(stats.numerical.deals.loss + stats.numerical.deals.profit - 1)) {
          stats.numerical.loss.series.value.asset = deal.profit.total * -1
          stats.numerical.loss.series.value.usd = deal.profit.totalUsd * -1
          stats.numerical.loss.series.minValue.asset =
            stats.numerical.general.startBalance.asset + deal.profit.total
          stats.numerical.loss.series.minValue.usd =
            stats.numerical.general.startBalance.usd + deal.profit.totalUsd
          stats.numerical.loss.series.maxValue.asset =
            stats.numerical.general.startBalance.asset
          stats.numerical.loss.series.maxValue.usd =
            stats.numerical.general.startBalance.usd
          stats.numerical.loss.series.perc =
            (deal.profit.totalUsd * -1) /
            stats.numerical.general.startBalance.usd
        }
      }
      if (isLoss) {
        stats.numerical.loss.maxDealLoss.usd = Math.min(
          stats.numerical.loss.maxDealLoss.usd,
          d.deal.profit.totalUsd,
        )
        stats.numerical.loss.maxDealLoss.asset = Math.min(
          stats.numerical.loss.maxDealLoss.asset,
          d.deal.profit.total,
        )
        stats.numerical.loss.maxDealLossPerc =
          stats.numerical.loss.maxDealLoss.usd /
          stats.numerical.general.startBalance.usd
      }
      if (isProfit) {
        stats.numerical.profit.maxDealProfit.usd = Math.max(
          stats.numerical.profit.maxDealProfit.usd,
          d.deal.profit.totalUsd,
        )

        stats.numerical.profit.maxDealProfit.asset = Math.max(
          stats.numerical.profit.maxDealProfit.asset,
          d.deal.profit.total,
        )
        stats.numerical.profit.maxDealProfitPerc =
          stats.numerical.profit.maxDealProfit.usd /
          stats.numerical.general.startBalance.usd
      }
      if (deal.profit.totalUsd !== 0) {
        const balanceUsd =
          stats.numerical.general.startBalance.usd + this.data.profit.totalUsd
        const balance =
          stats.numerical.general.startBalance.asset + this.data.profit.total
        if (balanceUsd > stats.numerical.profit.series.maxValue.usd) {
          stats.numerical.profit.series.maxValue.usd = balanceUsd
          stats.numerical.profit.series.maxValue.asset = balance
          if (stats.numerical.profit.series.minValue.asset === 0) {
            stats.numerical.profit.series.minValue.asset =
              stats.numerical.loss.series.minValue.asset === 0
                ? stats.numerical.general.startBalance.asset
                : Math.min(
                    stats.numerical.loss.series.minValue.asset,
                    stats.numerical.general.startBalance.asset,
                  )
            stats.numerical.profit.series.minValue.usd =
              stats.numerical.loss.series.minValue.asset === 0
                ? stats.numerical.general.startBalance.usd
                : Math.min(
                    stats.numerical.loss.series.minValue.usd,
                    stats.numerical.general.startBalance.usd,
                  )
          }
          const tempValueUsd =
            stats.numerical.profit.series.maxValue.usd -
            stats.numerical.profit.series.minValue.usd
          if (tempValueUsd > stats.numerical.profit.series.value.usd) {
            stats.numerical.profit.series.perc = Math.abs(
              tempValueUsd / stats.numerical.profit.series.minValue.usd,
            )
            stats.numerical.profit.series.value.usd = tempValueUsd
            stats.numerical.profit.series.value.asset =
              stats.numerical.profit.series.maxValue.asset -
              stats.numerical.profit.series.minValue.asset
          }
        }
        if (balanceUsd < stats.numerical.profit.series.minValue.usd) {
          stats.numerical.profit.series.minValue.asset = balance
          stats.numerical.profit.series.maxValue.asset = balance
          stats.numerical.profit.series.minValue.usd = balanceUsd
          stats.numerical.profit.series.maxValue.usd = balanceUsd
        }
        if (balanceUsd < stats.numerical.loss.series.minValue.usd) {
          stats.numerical.loss.series.minValue.usd = balanceUsd
          stats.numerical.loss.series.minValue.asset = balance
          if (stats.numerical.loss.series.maxValue.asset === 0) {
            stats.numerical.loss.series.maxValue.asset =
              stats.numerical.profit.series.maxValue.asset === 0
                ? stats.numerical.general.startBalance.asset
                : Math.min(
                    stats.numerical.profit.series.maxValue.asset,
                    stats.numerical.general.startBalance.asset,
                  )
            stats.numerical.loss.series.maxValue.usd =
              stats.numerical.profit.series.maxValue.asset === 0
                ? stats.numerical.general.startBalance.usd
                : Math.min(
                    stats.numerical.profit.series.maxValue.usd,
                    stats.numerical.general.startBalance.usd,
                  )
          }
          const tempValueUsd =
            stats.numerical.loss.series.maxValue.usd -
            stats.numerical.loss.series.minValue.usd
          if (tempValueUsd > stats.numerical.loss.series.value.usd) {
            stats.numerical.loss.series.perc = Math.abs(
              tempValueUsd / stats.numerical.loss.series.maxValue.usd,
            )
            stats.numerical.loss.series.value.usd = tempValueUsd
            stats.numerical.loss.series.value.asset =
              stats.numerical.loss.series.maxValue.asset -
              stats.numerical.loss.series.minValue.asset
          }
        }
        if (balanceUsd > stats.numerical.loss.series.maxValue.usd) {
          stats.numerical.loss.series.minValue.asset = balance
          stats.numerical.loss.series.maxValue.asset = balance
          stats.numerical.loss.series.minValue.usd = balanceUsd
          stats.numerical.loss.series.maxValue.usd = balanceUsd
        }
        if (
          stats.numerical.loss.series.value.usd >
          stats.numerical.loss.maxDrawdown.usd
        ) {
          stats.numerical.loss.maxDrawdown.usd =
            stats.numerical.loss.series.value.usd
          stats.numerical.loss.maxDrawdown.asset =
            stats.numerical.loss.series.value.asset
          stats.numerical.loss.maxDrawdownPerc =
            stats.numerical.loss.series.perc
        }
        if (
          stats.numerical.profit.series.value.usd >
          stats.numerical.profit.maxRunUp.usd
        ) {
          stats.numerical.profit.maxRunUp.usd =
            stats.numerical.profit.series.value.usd
          stats.numerical.profit.maxRunUp.asset =
            stats.numerical.profit.series.value.asset
          stats.numerical.profit.maxRunUpPerc =
            stats.numerical.profit.series.perc
        }
        stats.numerical.general.netProfitPerc =
          this.data.profit.totalUsd / stats.numerical.general.startBalance.usd

        stats.numerical.general.avgDaily.asset =
          this.data.profit.total / workingDays
        stats.numerical.general.avgDaily.usd =
          this.data.profit.totalUsd / workingDays
        stats.numerical.general.avgDailyPerc =
          this.data.profit.totalUsd /
          stats.numerical.general.startBalance.usd /
          workingDays
        if (
          !isNaN(stats.numerical.general.avgDailyPerc) &&
          isFinite(stats.numerical.general.avgDailyPerc) &&
          stats.numerical.general.avgDailyPerc
        ) {
          const compound =
            [OrderSizeTypeEnum.percFree, OrderSizeTypeEnum.percTotal].includes(
              this.data.settings.orderSizeType,
            ) || this.data.settings.useReinvest
          stats.numerical.general.annualizedReturn = compound
            ? (1 + stats.numerical.general.avgDailyPerc) ** 365 - 1
            : stats.numerical.general.avgDailyPerc * 365
          if (
            stats.numerical.general.annualizedReturn > Number.MAX_SAFE_INTEGER
          ) {
            stats.numerical.general.annualizedReturn = Infinity
          }
        }
      }
      if (
        settings.useDca &&
        deal.levels.complete - 1 > stats.numerical.general.maxDCAOrdersTriggered
      ) {
        stats.numerical.general.maxDCAOrdersTriggered = deal.levels.complete - 1
      }
      if (!stats.numerical.general.coveredPriceDeviation) {
        const lastOrder = d.initialOrders
          .filter((o) => o.type === TypeOrderEnum.dealRegular)
          .sort((a, b) =>
            this.isLong ? a.price - b.price : b.price - a.price,
          )[0]
        if (lastOrder) {
          stats.numerical.general.coveredPriceDeviation =
            Math.abs(lastOrder.price - deal.initialPrice) / deal.initialPrice
        }
      }
      const actualPriceDeviationOrder = d.initialOrders
        .filter((o) => o.type === TypeOrderEnum.dealRegular)
        .sort((a, b) => (this.isLong ? a.price - b.price : b.price - a.price))
        .slice(0, deal.levels.complete - 1)[0]
      if (actualPriceDeviationOrder) {
        stats.numerical.general.actualPriceDeviation =
          Math.abs(actualPriceDeviationOrder.price - deal.initialPrice) /
          deal.initialPrice
      }
      const totalDeals =
        stats.numerical.deals.profit + stats.numerical.deals.loss
      stats.numerical.general.confidenceGrade =
        totalDeals < 107
          ? 'F'
          : totalDeals >= 107 && totalDeals < 133
            ? 'E'
            : totalDeals >= 133 && totalDeals < 164
              ? 'D'
              : totalDeals >= 164 && totalDeals < 208
                ? 'C'
                : totalDeals >= 208 && totalDeals < 273
                  ? 'B'
                  : totalDeals >= 273 && totalDeals < 385
                    ? 'A'
                    : 'A+'
      stats.numerical.ratios.profitFactor =
        stats.numerical.deals.profit / stats.numerical.deals.loss
      if (!isFinite(stats.numerical.ratios.profitFactor)) {
        stats.numerical.ratios.profitFactor = -1
      }
      if (isNaN(stats.numerical.ratios.profitFactor)) {
        stats.numerical.ratios.profitFactor = 0
      }

      const maxUsage = this.futures
        ? this.coinm
          ? deal.usage.max.base
          : deal.usage.max.quote
        : this.isLong
          ? deal.usage.max.quote
          : deal.usage.max.base
      if (maxUsage > stats.numerical.usage.maxTheoreticalUsage) {
        stats.numerical.usage.maxTheoreticalUsage = maxUsage
      }
      const duration = end - deal.createTime
      if (isProfit) {
        if (duration > stats.duration.profit.maxWinningTradeDuration) {
          stats.duration.profit.maxWinningTradeDuration = duration
        }
        stats.duration.profit.totalTime =
          (stats.duration.profit.totalTime ?? 0) + duration
        stats.duration.profit.avgWinningTradeDuration =
          stats.duration.profit.totalTime / stats.numerical.deals.profit
      }
      if (isLoss) {
        if (duration > stats.duration.loss.maxLosingTradeDuration) {
          stats.duration.loss.maxLosingTradeDuration = duration
        }
        stats.duration.loss.totalTime =
          (stats.duration.loss.totalTime ?? 0) + duration
        stats.duration.loss.avgLosingTradeDuration =
          stats.duration.loss.totalTime / stats.numerical.deals.loss
      }
      if (duration > stats.duration.general.maxDealDuration) {
        stats.duration.general.maxDealDuration = duration
      }
      stats.duration.general.totalTime =
        (stats.duration.general.totalTime ?? 0) + duration
      if (totalDeals) {
        stats.duration.general.avgDealDuration =
          stats.duration.general.totalTime / totalDeals
      }

      if (workingDays) {
        stats.duration.general.dealsPerDay = totalDeals / workingDays
      }
      stats.duration.general.workingTime = workingTime
      // The buy & hold reference is seeded once and never revisited, so a
      // priceless deal (see `dealHasPrice` above) pinned `startPrice` to 0 for
      // the rest of the bot's life — `startBalance.asset / 0` is Infinity, and
      // Infinity times a 0 rate is the NaN that blocked every later stats
      // write. Take the reference only from a deal that has a price, and
      // re-seed a `startPrice` an earlier run already zeroed.
      if (
        dealHasPrice &&
        (!stats.numerical.ratios.buyAndHold.symbol ||
          !(stats.numerical.ratios.buyAndHold.startPrice > 0))
      ) {
        stats.numerical.ratios.buyAndHold.symbol = deal.symbol.symbol
        stats.numerical.ratios.buyAndHold.startPrice = deal.initialPrice
      }
      if (stats.numerical.ratios.buyAndHold.startPrice > 0) {
        const bnhUsdRate =
          deal.symbol.symbol === stats.numerical.ratios.buyAndHold.symbol
            ? _usdRate
            : await this.getUsdRate(stats.numerical.ratios.buyAndHold.symbol)
        const bnhRate =
          deal.symbol.symbol === stats.numerical.ratios.buyAndHold.symbol
            ? deal.lastPrice
            : await this.benchmarkRate(stats.numerical.ratios.buyAndHold.symbol)
        // No rate means no answer: keep the last computable benchmark rather
        // than booking `getLatestPrice`'s 0-on-failure as the reference price,
        // which reads as a flat -100% and is indistinguishable from the asset
        // genuinely going to zero.
        const outcome = buyAndHoldOutcome({
          startBalanceAsset: stats.numerical.general.startBalance.asset,
          startBalanceUsd: stats.numerical.general.startBalance.usd,
          startPrice: stats.numerical.ratios.buyAndHold.startPrice,
          rate: bnhRate,
          usdRate: bnhUsdRate,
        })
        if (outcome) {
          stats.numerical.ratios.buyAndHold.result = outcome.result
          stats.numerical.ratios.buyAndHold.perc = outcome.perc
        }
      }
      const chartTime = new Date(end)
      chartTime.setHours(0, 0, 0, 0)
      if (!stats.chart.length) {
        stats.chart.push({
          realizedProfit: stats.numerical.general.startBalance.usd,
          buyAndHold: stats.numerical.general.startBalance.usd,
          equity: stats.numerical.general.startBalance.usd,
          time: +chartTime,
        })
      }
      const find = stats.chart.find((c) => c.time === +chartTime)
      if (find) {
        // `??` lets a NaN through, and NaN + anything is NaN forever after —
        // same self-healing rule as the equity chart point above.
        find.realizedProfit =
          (Number.isFinite(find.realizedProfit) ? find.realizedProfit : 0) +
          deal.profit.totalUsd
        find.equity = find.equity + deal.profit.totalUsd
        stats.chart = stats.chart.filter((c) => c.time !== +chartTime)
        stats.chart.push(find)
        if (stats.chart.length > 90) {
          stats.chart.shift()
        }
      } else {
        const last = stats.chart[stats.chart.length - 1]
        stats.chart.push({
          realizedProfit:
            (last?.realizedProfit ?? stats.numerical.general.startBalance.usd) +
            deal.profit.totalUsd,
          buyAndHold: last.buyAndHold,
          equity: last?.equity + deal.profit.totalUsd,
          time: +chartTime,
        })
      }
      if (settings.useMulti) {
        let findSymbol = symbolStats.find(
          (s) => s.symbol === deal.symbol.symbol,
        )
        if (!findSymbol) {
          findSymbol = {
            ...emptyStats.symbolStats[0],
            symbol: deal.symbol.symbol,
          }
        }
        if (isProfit) {
          findSymbol.numerical.deals.profit += 1
        }
        if (isLoss) {
          findSymbol.numerical.deals.loss += 1
        }
        // Same `use * multiply` arithmetic as the bot-wide start balance, so
        // the same priceless deal turns this into NaN too.
        if (dealHasPrice && !findSymbol.numerical.general.startBalance.asset) {
          const maxDeals = Math.max(
            1,
            settings.maxDealsPerPair &&
              +settings.maxDealsPerPair &&
              !isNaN(+settings.maxDealsPerPair) &&
              isFinite(+settings.maxDealsPerPair)
              ? +settings.maxDealsPerPair
              : 1,
          )
          findSymbol.numerical.general.startBalance.asset = use * maxDeals
          findSymbol.numerical.general.startBalance.usd =
            findSymbol.numerical.general.startBalance.asset * usdRate * multiply
        }
        findSymbol.numerical.general.netProfit.asset += d.deal.profit.total

        findSymbol.numerical.general.netProfit.usd += d.deal.profit.totalUsd
        if (findSymbol.numerical.general.startBalance.usd) {
          findSymbol.numerical.general.netProfitPerc =
            findSymbol.numerical.general.netProfit.usd /
            findSymbol.numerical.general.startBalance.usd
          findSymbol.numerical.general.dailyProfit.asset =
            findSymbol.numerical.general.netProfit.asset / workingDays
          findSymbol.numerical.general.dailyProfit.usd =
            findSymbol.numerical.general.netProfit.usd / workingDays
          findSymbol.numerical.general.dailyProfitPerc =
            findSymbol.numerical.general.dailyProfit.usd /
            findSymbol.numerical.general.startBalance.usd /
            workingDays
        }
        const totalSymbolDeals =
          findSymbol.numerical.deals.profit + findSymbol.numerical.deals.loss
        if (totalSymbolDeals) {
          findSymbol.numerical.general.winRate =
            findSymbol.numerical.deals.profit / totalSymbolDeals
        }
        findSymbol.numerical.general.profitFactor =
          findSymbol.numerical.deals.profit / findSymbol.numerical.deals.loss
        if (!isFinite(findSymbol.numerical.general.profitFactor)) {
          findSymbol.numerical.general.profitFactor = -1
        }
        if (isNaN(findSymbol.numerical.general.profitFactor)) {
          findSymbol.numerical.general.profitFactor = 0
        }
        if (duration > findSymbol.duration.maxDealDuration) {
          findSymbol.duration.maxDealDuration = duration
        }

        // Per-pair average deal duration. This used to be a self-assignment
        // guarded by `isNaN`, which never fired because `getEmptyStats` seeds
        // the field to 0 — so every pair of every multi-pair bot reported a
        // 0 average while `maxDealDuration` right above filled in normally.
        // Accumulate the same way the bot-wide block does, but against a
        // counter of our own: `numerical.deals` predates `totalTime` on every
        // bot already trading, so dividing by it would turn the first close
        // after this ships into a fraction of the real average.
        findSymbol.duration.totalTime =
          (findSymbol.duration.totalTime ?? 0) + duration
        findSymbol.duration.measuredDeals =
          (findSymbol.duration.measuredDeals ?? 0) + 1
        findSymbol.duration.avgDealDuration =
          findSymbol.duration.totalTime / findSymbol.duration.measuredDeals
        symbolStats = symbolStats.filter((s) => s.symbol !== findSymbol?.symbol)
        symbolStats.push(findSymbol)
        symbolStats = symbolStats.sort((a, b) =>
          a.symbol.localeCompare(b.symbol),
        )
      }
      this.data.stats = stats
      this.data.symbolStats = symbolStats
      this.updateData({ stats, symbolStats })
      this.emit('bot stats update', {
        stats: this.data.stats,
        symbolStats: this.data.symbolStats,
      })
      this.endMethod(_id)
    }

    @IdMute(mutex, (botId: string) => `${botId}updateLiveStats`)
    async updateLiveStats(_botId: string, time: number) {
      if (!this.data || !this.shouldProceed()) {
        this.handleDebug(`No data or shouldn't proceed for live stats update`)
        return
      }
      if (time < this.lastStatsCheck) {
        this.handleDebug(
          `Time ${time} is before last stats check ${this.lastStatsCheck}`,
        )
        return
      }
      if (this.statsTimer) {
        clearTimeout(this.statsTimer)
      }
      this.handleDebug(`Updating live stats at time ${time}`)
      this.lastStatsCheck = time
      const botStats: CalculateDCALiveStatsParams = {
        bot: {
          _id: this.botId,
          exchange: this.data.exchange,
          workingShift: this.data.workingShift,
          profit: this.data.profit,
          symbol: this.data.symbol,
          usage: this.data.usage,
          currentBalances: this.data.currentBalances,
          initialBalances: this.data.initialBalances,
          dealsStatsForBot: (this.data as unknown as ExcludeDoc<ComboBotSchema>)
            .dealsStatsForBot,
          dealsReduceForBot: this.data.dealsReduceForBot,
          deals: this.data.deals,
          settings: {
            strategy: this.data.settings.strategy,
            futures: this.data.settings.futures,
            coinm: this.data.settings.coinm,
            orderSizeType: this.data.settings.orderSizeType,
            useReinvest: this.data.settings.useReinvest,
            profitCurrency: this.data.settings.profitCurrency,
          },
          stats: {
            numerical: {
              general: {
                netProfitPerc:
                  this.data.stats?.numerical.general.netProfitPerc ?? 0,
              },
            },
          },
        },
        combo: this.combo,
        fee: (await this.getUserFee(this.data.settings.pair[0]))?.maker ?? 0,
      }
      await botMonitor.calculateDCALiveStats(botStats)
      this.setStatsTimer()
    }
  }

  return DCABotHelper as new (
    id: string,
    exchange: ExchangeEnum,
    log?: boolean,
    serviceRestart?: boolean,
    ignoreStats?: boolean,
  ) => DCABotHelper & InstanceType<TBaseClass>
}

export default createDCABotHelper
