import { isMainThread, parentPort, threadId } from 'worker_threads'
import { v4 } from 'uuid'
import type DB from '../db'
import type {
  CleanMainBot as IMainBot,
  ClearOrderSchema,
  ExcludeDoc,
  FreeAsset,
  Grid,
  Order,
  OrderQuarantine,
  OrderTypeT,
  UserDataStreamEvent,
  CommonOrder,
  ExecutionReport,
  ClearPairsSchema,
  GridType,
  DCABotSettings,
  Currency,
  PositionInBot,
  WorkingShift,
  CoinbaseKeysType,
  SpotUpdate,
  OrderAdditionalParams,
  OrderStatusType,
  OKXSource,
  BotVars,
  ClearDCABotSchema,
  BaseReturn,
  PriceMessage,
  BybitHost,
  BotSchema,
} from '../../types'
import {
  PositionSide,
  MarginType,
  BotMarginTypeEnum,
  StrategyEnum,
  FuturesStrategyEnum,
  serviceLogRedis,
  setToRedisDelay,
  liveupdate,
  rabbitUsersStreamKey,
} from '../../types'
import {
  BotStatusEnum,
  BotType,
  ExchangeEnum,
  MessageTypeEnum,
  OrderSideEnum,
  OrderTypeEnum,
  StatusEnum,
  TypeOrderEnum,
  DCATypeEnum,
  getSellBuyCountReturn,
} from '../../types'
import ExchangeChooser from '../exchange/exchangeChooser'
import Exchange from '../exchange'
import { MathHelper } from '../utils/math'
import utils, { isPaper } from '../utils'
import { resolveConnection } from '../utils/credentials'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import * as crypto from 'crypto'
import {
  complianceRestriction,
  convertComboBotToObject,
  convertDCABotToObject,
  exchangeRules,
  futuresLiquidation,
  futuresPosition,
  getErrorSubType,
  indicatorsError,
} from './utils'
import {
  getSubTypeBehavior,
  getSubTypeLogPolicy,
  logPolicyBucket,
  noteErrorRuleHit,
} from './errorRulesCache'
import QuantRulesGuard from './quantRulesGuard'
import ComplianceGuard from './complianceGuard'
import AuthFailureGuard, { isHardAuthFailure } from './authGuard'
import RetryBackoff from './retryBackoff'
import { paperExchanges } from '../exchange/paper/utils'
import type { InitialGrid } from './helper'
import { updateUserSteps } from '../utils/user'
import { QueryFilter, Types } from 'mongoose'
import { removePaperFormExchangeName } from '../exchange/helpers'
import { getIntersection } from '../utils/set'
import RedisClient, { RedisWrapper } from '../db/redis'
import {
  balanceDb,
  botEventDb,
  reconcileSweepDb,
  botMessageDb,
  brokerCodesDb,
  comboBotDb,
  dcaBotDb,
  orderDb,
  rateDb,
  userProfitByHourDb,
} from '../db/dbInit'
import Rabbit from '../db/rabbit'
import { RunWithDelay } from '../utils/delay'
import BotSharedData, { type StreamData } from './shared'
import SharedStream from './sharedStream'
import FundingStream, { fundingChannel } from './fundingStream'
import FundingStore from './fundingStore'
import {
  computeFunding,
  type SignedFill,
  type FundingComputeResult,
} from './fundingProcessor'
import Bot from '.'
import { SKIP_REDIS } from '../config'

type AccountCBFunctions = {
  sort: (a: ExecutionReport, b: ExecutionReport) => number
  onFilled?: (order: Order, updateTime: number) => Promise<void>
  onPartiallyFilled?: (order: Order, updateTime: number) => Promise<void>
  onCanceled?: (
    order: Order,
    updateTime: number,
    expired: boolean,
  ) => Promise<void>
  onNew?: (order: Order, updateTime: number) => Promise<void>
  onLiquidation?: (order: Order, updateTime: number) => Promise<void>
}

const { findUSDRate, sleep, id } = utils

/**
 * Return from findDiff function
 */
type findDiffReturn = {
  /**
   * Grids needed to cancel
   */
  cancel: Grid[]
  /**
   * Grids needed to place
   */
  new: Grid[]
}

const unknownOrderMessages = [
  'Unknown order',
  'order_not_exist_or_not_allow_to_cancel',
  'order_status_not_allow_to_cancel',
  'Order does not exist',
  'Order not found',
  'Order already closed',
  'Order cannot be canceled',
  'Order has been filled',
  'Order has been canceled',
  'Order being cancelled. Operation not supported',
  "Data sent for paramter 'qty' is not valid",
  'order not exists or too late to cancel',
  'Order cancellation failed as the order has been filled, canceled or does not exist',
  'validation.queryOrder.orderNotExist',
  'error.getOrder.orderNotExist',
  'Cannot find order to cancel',
  'UNKNOWN_CANCEL_ORDER',
  'UNKNOWN_CANCEL_FAILURE_REASON',
  'ORDER_IS_FULLY_FILLED',
  'Cannot cancel processing order',
  '订单不存在',
  'The order does not exist',
  'Order does not exist',
  'Order filled.',
  'Order cancelled.',
  'unknownOid',
  'order was never placed, already canceled, or filled',
  'EOrder:Unknown order',
  'EOrder:Order not found',
  'EOrder:Order already canceled',
  'EOrder:Order already closed',
  'EOrder:Cannot cancel order',
]

const mutex = new IdMutex()

const mutexEmit = new IdMutex(30)

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

type AllowedMethods =
  | 'checkClosedDeals'
  | 'sendDealClosedAlert'
  | 'sendDealOpenedAlert'
  | 'checkInDynamicRange'
  | 'checkInRange'
  | 'checkMaxDealsPerPair'
  | 'checkMaxDeals'
  | 'checkMinTp'
  | 'checkOpenedDeals'
  | 'filterCoinsByVolume'
  | 'checkDealsStopLoss'
  | 'checkDealsMoveSL'
  | 'checkTrailing'
  | 'checkDynamic'
  | 'checkIndicatorUnpnl'
  | 'sendEightyAlert'
  | 'sendHundredAlert'
  | 'checkDCALevel'
  | 'checkTPLevel'
  | 'checkDCAByMarketLevel'

export type RedisKeys =
  | 'usedOrderId'
  | 'minigrids'
  | 'deals'
  | 'dealsHistory'
  | 'orders'
  | 'lastFilled'
  | 'botData'
  | 'exchangeInfo'
  | 'userFee'
export const notEnoughErrors = [
  'The purchase amount of each order exceeds the estimated maximum purchase amount',
  'The sell quantity per order exceeds the estimated maximum sell quantity',
  'balance',
  'Margin is insufficient.',
  'Order quantity exceeded upper limit',
  'Order quantity exceeded lower limit',
  'ab not enough for new order',
  'InsufficientAB',
  'Order failed. Insufficient',
  'Insufficient balance',
  'Insufficient position',
  'insufficientAvailableFunds',
]

export const eventMap: { [x: string]: string } = {
  'bot update': 'data update',
  'bot message': 'bot sends message',
  'bot settings update': 'bot sends settings',
}
const maxLogs = 30
const maxMethods = 30
/**
 * How long a pooled-margin read stays good for. Long enough to cover one order
 * attempt (the latch check plus the error message it produces), short enough
 * that the next attempt re-asks the venue.
 */
const pooledMarginMemoTtl = 5_000
/**
 * Wall-clock a single bot may spend probing the exchange inside the
 * restart-time order check before it stops asking and lets the normal
 * reconcile path finish the job. `0` disables the budget entirely.
 *
 * Why this exists: `checkOrders` walks a bot's open orders and does one
 * serial `getOrder()` per order, so its cost is unbounded in the number of
 * orders the exchange will not resolve. Re-hydration is the one moment where
 * that cost is paid by everybody, because a restart's wall-clock is set by
 * its slowest bot — one bot holding a long tail of orders that no longer
 * exist on the venue can stretch a restart by minutes on its own.
 *
 * Two things make the tail expensive. Orders can sit in a local `NEW` state
 * indefinitely once their venue-side counterpart is gone, and some venue
 * clients deliberately sleep-and-retry on "order not found" — correct when
 * confirming an order that was just placed, very wrong when reconciling a
 * months-old one. The budget does not fix either; it is the guarantee that
 * no single bot, for any reason, can set the restart's wall-clock.
 */
const restartProbeBudgetMs = Number(
  process.env.BOT_RESTART_PROBE_BUDGET_MS ?? 60_000,
)

/**
 * Consecutive order-check runs that must each produce a *definitive* not-found
 * before an order is quarantined. `0` disables quarantine entirely.
 *
 * Strikes are counted per run, not per lookup, deliberately: an order probed
 * three times inside one loop has told us one thing once. Requiring distinct
 * runs means a venue outage — however long it lasts — contributes at most one
 * strike per restart, and a real order that the venue is merely being slow
 * about is never quarantined by a single bad afternoon.
 */
const orderQuarantineStrikes = Number(
  process.env.BOT_ORDER_QUARANTINE_STRIKES ?? 3,
)

/**
 * How old an order must be before a not-found is allowed to count against it.
 *
 * This is the guard against the case that matters most: **an exchange that has
 * just been handed an order does not always know about it yet.** Ask for it a
 * second later and some venues answer "unknown order id" — that is the venue
 * describing its own propagation lag, not the order. Hyperliquid is explicit
 * about this: its client retries `unknownOid` up to four times with a sleep
 * when it knows an order was just placed. The reconcile path does not get that
 * retry, so without an age floor a freshly-placed, entirely real order could
 * take a strike.
 *
 * An order that has been sitting untouched for a day and is *still* unknown to
 * the venue is a different claim entirely. That asymmetry is what makes the
 * ambiguous venue answers safe to act on.
 */
const orderQuarantineMinAgeMs = Number(
  process.env.BOT_ORDER_QUARANTINE_MIN_AGE_MS ?? 24 * 60 * 60 * 1000,
)

/**
 * Does this failed lookup mean "the venue says this order does not exist", as
 * opposed to "the call did not succeed"?
 *
 * This distinction is the whole safety argument for quarantine, and it was
 * being thrown away: every venue reports a missing order as
 * `{status: notok, reason: '<venue> order not found…', data: null}`, but every
 * call site tested `!res.data` first and `returnBad` always nulls `data`, so
 * the `status === notok` branch that reads `reason` was unreachable. A timeout,
 * a rate-limit and a genuinely absent order all arrived as the same
 * "Not enough data" warning.
 *
 * Matching is deliberately narrow. `Symbol not found`, `Fee not found`,
 * `Account not found` and `Balances not found` are all real reason strings on
 * these paths and none of them says anything about the order — quarantining on
 * those would be exactly the "transient failure rendered as a definitive
 * negative" mistake, with money attached.
 */
export function isDefinitiveOrderNotFound(res?: {
  status: StatusEnum
  reason?: string | null
  data?: unknown
}) {
  if (!res || res.status !== StatusEnum.notok) return false
  const reason = `${res.reason ?? ''}`.toLowerCase()
  if (!reason) return false
  // Coinbase: "Coinbase order not found after execution."
  // OKX / Bitget: "Order not found"   Bybit: "Order not found after execution"
  // Kraken: "Order not found in active orders" / "in history" / "in open orders"
  // Binance passes through -2013 "Order does not exist".
  // Hyperliquid: the raw `unknownOid` status, via `HyperliquidError`.
  //
  // `unknownOid` is the ambiguous one, and it is only safe to act on because of
  // the age floor: Hyperliquid returns it both for an order that never existed
  // and for one placed moments ago that has not propagated yet. Its own client
  // retries `unknownOid` four times when it knows an order was just placed; the
  // reconcile path gets no such retry, so age is what separates the two cases.
  // Matched exactly rather than as a substring — it is a bare status token.
  return (
    /\border not found\b/.test(reason) ||
    /\border does not exist\b/.test(reason) ||
    reason === 'unknownoid'
  )
}
/**
 * The placeholder an {@link Order} carries in `orderId` from the moment it is
 * constructed until the venue hands back a real exchange order id. Already
 * guarded on the duplicate / not-found branches of `sendOrderToExchange`; the
 * `byId` lookup branches did not, which is what this constant names.
 *
 * Module-level rather than a static member — see `notEnoughBalanceKeyVersion`.
 */
const noExchangeOrderId = '-1'
/**
 * How many times `_handleUnknownOrder` re-asks the venue about an order it
 * cannot resolve before it gives up and marks the local order CANCELED.
 * Named so the early-exit below can hand control to that terminal branch by
 * saturating the counter instead of duplicating its map/DB resolution.
 */
const unknownOrderMaxAttempts = 5
/**
 * The answer for an order on a venue that can only be queried BY exchange
 * order id (coinbase / kraken / kucoin full futures) when we never received
 * one. Asking is guaranteed to fail — `'-1'` is not an id, so kraken burns a
 * `getOpenOrders` + a `getClosedOrders` (userref `parseInt('-1', 16)` = NaN)
 * and logs an ERROR, per order, per poll. A grid bot re-probing 17 such orders
 * on every user-stream reconnect produced 39 connector errors in 63s.
 *
 * The reason is worded so {@link isDefinitiveOrderNotFound} still matches it:
 * every venue in that branch answers an unresolvable id with a definitive
 * not-found today, so callers see exactly what they saw before — minus the
 * round trip.
 */
const orderNeverReachedExchange = 'Order not found: no exchange order id'
/** Key-scheme version for `MainBot.getNotEnoughOrdersIdByOrder`. Bump when the
 *  key shape changes so counters written under the old scheme are discarded.
 *  Module-level rather than a static member: adding statics to `MainBot`
 *  changes `typeof MainBot` and breaks the mixin casts in helper.ts/dcaHelper.ts. */
const notEnoughBalanceKeyVersion = 2
/**
 * Cooldown for orders the account cannot fund. Shares its mechanism with
 * {@link ComplianceGuard} — same shape of problem: the venue keeps rejecting
 * for a reason that will not change in the next few seconds, and nothing in the
 * engine gates the next attempt.
 *
 * A transient shortfall recovers within `minMs`; a chronically unfundable order
 * (the common case — a deal whose base left the account months ago) settles at
 * one attempt per `maxMs` instead of ~15/min.
 */
const notEnoughBalanceBackoff = new RetryBackoff({
  namespace: 'nb',
  minMs: 5 * 60 * 1000,
  maxMs: 60 * 60 * 1000,
})
type LastLog = {
  time: number
  message: string
  type: 'info' | 'warning' | 'error'
}
type LastMethod = {
  name: string
  start: number
  end: number
}
/**
 * Common functions for bot
 */
class MainBot<T extends IMainBot> {
  exchangeChooser = ExchangeChooser
  brokerCode = ''
  notEnoughBalanceLogPrefix = 'NOB |'
  notEnoughBalanceThreshold = 10
  /**
   * Last pooled-margin answer, memoised for one order attempt so the latch
   * check and the error message it goes on to build cost one venue call, not
   * two. `null` records "the venue has no opinion" — see
   * {@link MainBot#spendableForNotEnoughBalance}.
   */
  private pooledMarginMemo?: { value: number | null; at: number }
  botService = new Bot()
  sharedStream = SharedStream.getInstance()
  finishLoad = false
  sharedData = BotSharedData.getInstance()
  startTime = 0
  /** Bot id */
  botId: string
  /** User id */
  userId: string
  /** Marker to show if logging is enabled */
  log: boolean
  /** Bot data */
  data: ExcludeDoc<T> | null
  /** DB instance to work with bot collection */
  db: DB | null
  balancesDb = balanceDb
  ratesDb = rateDb
  ordersDb = orderDb
  /** DB instance to work with bot messages */
  messagesDb = botMessageDb
  /** DB instance to work with bot events */
  botEventDb = botEventDb
  /** DB instance recording reconciliation-sweep catches (user-stream health) */
  reconcileSweepDb = reconcileSweepDb
  /** Exchange instance */
  exchange: Exchange | null
  lastCheckPerSymbol: Map<string, number> = new Map()
  blockPriceCheck = false
  priceTimeout = 2.5 * 60 * 1000
  priceTimer: NodeJS.Timeout | null = null
  /** Periodic reconciliation-sweep timer (opt-in). See startReconcileSweep. */
  consumerHeartbeatTimer: NodeJS.Timeout | null = null
  /**
   * Deferred re-sends of orders soft-skipped by a Binance Quantitative Rules
   * (-4400) cooldown, keyed by clientOrderId so a given order has at most one
   * pending retry (clear-and-replace on reschedule). See the pre-send gate in
   * sendOrderToExchange.
   */
  quantRulesRetryTimers: Map<string, NodeJS.Timeout> = new Map()
  /** True while a reconcile is running because the sweep timer fired it
   *  (vs a real user-stream reconnect), for distinct logging. */
  reconcileViaSweep = false
  /** Math helper instance */
  math: MathHelper
  /** Service restart flag */
  serviceRestart = false
  /** When the current restart-time order check started probing the exchange.
   *  `0` = no budget running, so every non-restart path is unaffected. */
  private restartProbeStartedAt = 0
  /** Orders skipped because the budget ran out, reported once at the end. */
  private restartProbeSkipped = 0
  /** Identifies the current order-check run so repeat strikes within it count once. */
  private orderCheckRunId = ''
  /** Orders newly quarantined in this run — coalesced into one user message. */
  private newlyQuarantined: string[] = []
  /** Quarantined orders skipped in this run, reported once at the end. */
  private quarantineSkipped = 0
  secondRestart = false
  reload = false
  /** Array to store list of orders that in work */
  orders: Map<string, Order> = new Map()
  ordersKeys: Set<string> = new Set()
  /** Map status to order */
  orderStatusMap: Map<OrderStatusType, Set<string>> = new Map()
  /** Map deal to order */
  orderDealMap: Map<string, Set<string>> = new Map()
  /** Order statuses used for filter orders */
  orderStatuses: OrderStatusType[] = ['NEW', 'PARTIALLY_FILLED']
  /** Marker to show if queue processing method is already running, to prevent multiple methods run at the same time */
  lockProcessQueueMethod: boolean
  /** Order queue to process */
  orderQueue: ExecutionReport[] = []
  /** Timeout for limit reposition */
  orderLimitRepositionTimeout = 10000
  /** Timeout for enter Market */
  enterMarketTimeout = 35000
  /** Array of processed orders */
  processedOrders: Map<string, { id: string; status: string; qty: number }> =
    new Map()
  /** Store last order time, side and price */
  lastOrder: {
    time: number
    side: OrderSideEnum.buy | OrderSideEnum.sell
    price: number
  }
  botType: BotType
  /** Canceled orders queue */
  private canceledMap: Map<string, number> = new Map()
  /** Used pairs */
  pairs: Set<string> = new Set()
  /** Run after loading */
  runAfterLoadingQueue: (() => Promise<void>)[] = []
  /** Loading complete */
  loadingComplete = false
  /** Callback after user stream connected */
  callbackAfterUserStream: ((botId: string) => Promise<void>) | null = null
  /** User stream initial start */
  userStreamInitialStart = true
  /** Hedge mode */
  hedge = false
  /** pairs not found during load */
  pairsNotFound: Set<string> = new Set()
  /** ignore errors */
  ignoreErrors = false
  /** restart process */
  restartProcess = false
  /**
   *
   *
   * Prepare DB instaces<br />
   *
   * Connect to socket io streams
   *
   * @param {string} botId Bot id
   * @param {boolean} [log=true] Set logging. Default = true
   */
  private errorsMap: Map<string, number> = new Map()
  partiallyFilledFilledSet: Set<string> = new Set()
  allowedMethods: Set<AllowedMethods> = new Set()
  redisDb: RedisWrapper | null = null
  redisSubGlobal: RedisWrapper | null = null
  redisSubIndicators: RedisWrapper | null = null
  rabbitClient: Rabbit | null = null
  userStreamChannel: string | null = null
  cbFunctions?: AccountCBFunctions
  userProfitByHourDb = userProfitByHourDb
  lastPriceCheck: Map<string, number> = new Map()
  highestLow: Map<string, number> = new Map()
  lowestHigh: Map<string, number> = new Map()
  closeTimer: NodeJS.Timeout | null = null
  precisions: Map<string, number> = new Map()
  basePrecisions: Map<string, number> = new Map()
  lastStreamData: Map<string, StreamData> = new Map()
  lastLogs: LastLog[] = []
  lastMethods: LastMethod[] = []
  currentMethods: Map<string, Omit<LastMethod, 'end'>> = new Map()
  reloadTimer: NodeJS.Timeout | null = null
  zeroFee = false
  constructor(botId: string, _exchange: ExchangeEnum, log = true) {
    this.pushLogs = this.pushLogs.bind(this)
    this.startMethod = this.startMethod.bind(this)
    this.endMethod = this.endMethod.bind(this)
    this.getStats = this.getStats.bind(this)
    this.botId = botId
    this.userId = ''
    this.log = log
    this.data = null
    this.exchange = null
    this.db = null
    this.rabbitClient = new Rabbit()
    this.math = new MathHelper()
    this.lockProcessQueueMethod = false
    this.processOrderQueue = this.processOrderQueue.bind(this)
    this.accountCallback = this.accountCallback.bind(this)
    this.lastOrder = {
      time: 0,
      price: 0,
      side: OrderSideEnum.buy,
    }
    this.botType = BotType.grid
    this.connectRedis()
    this.priceUpdateCallback = this.priceUpdateCallback.bind(this)
    this.redisSubCb = this.redisSubCb.bind(this)
    this.userStreamInfoCb = this.userStreamInfoCb.bind(this)
    this.processServiceLog = this.processServiceLog.bind(this)
    this.updateExchangeInfo = this.updateExchangeInfo.bind(this)
    this.updateExchangeCredentials = this.updateExchangeCredentials.bind(this)
    this.botUpdateGlobalVars = this.botUpdateGlobalVars.bind(this)
    this.connectRedisSub()
  }

  /**
   * Arm the restart-time exchange-probe budget. No-op outside a service
   * restart, so normal running behaviour is byte-identical.
   */
  protected beginRestartProbeBudget() {
    this.restartProbeStartedAt =
      this.serviceRestart && restartProbeBudgetMs > 0 ? +new Date() : 0
    this.restartProbeSkipped = 0
  }

  /**
   * True once this bot has spent its whole budget asking the exchange about
   * orders during re-hydration. Callers skip the remaining lookups; the
   * orders keep their local state and are picked up by the mechanisms that
   * already own that job — the user stream, the reconcile sweep and the
   * fill-failsafe. Nothing is lost that was not already being lost: the
   * lookups this trips on are the ones returning no data anyway.
   */
  protected restartProbeExhausted() {
    if (!this.restartProbeStartedAt) return false
    if (+new Date() - this.restartProbeStartedAt < restartProbeBudgetMs) {
      return false
    }
    this.restartProbeSkipped += 1
    return true
  }

  /** Disarm the budget and report the shortfall, if any, exactly once. */
  protected endRestartProbeBudget(context: string) {
    if (this.restartProbeStartedAt && this.restartProbeSkipped) {
      this.handleWarn(
        `Restart order check gave up after ${restartProbeBudgetMs}ms in ${context}: ${this.restartProbeSkipped} order(s) left unprobed — reconcile will pick them up`,
      )
    }
    this.restartProbeStartedAt = 0
    this.restartProbeSkipped = 0
  }

  /**
   * Open an order-check run. Everything quarantine-related is scoped to a run:
   * strikes are counted once per run, and the end-of-run summary is what the
   * user sees, rather than one message per order.
   */
  protected beginOrderCheckRun() {
    this.orderCheckRunId = v4()
    this.newlyQuarantined = []
    this.quarantineSkipped = 0
  }

  /** Close the run and report both halves once. */
  protected endOrderCheckRun() {
    if (this.quarantineSkipped) {
      this.handleLog(
        `Skipped ${this.quarantineSkipped} quarantined order(s) — not polled. Restart the bot to re-check them.`,
      )
    }
    if (this.newlyQuarantined.length) {
      const n = this.newlyQuarantined.length
      this.handleWarn(
        `Quarantined ${n} order(s) the exchange reports as non-existent after ${orderQuarantineStrikes} checks: ${this.newlyQuarantined
          .slice(0, 10)
          .join(', ')}${n > 10 ? ' …' : ''}`,
      )
      // `cbEmit` is the core-safe user-alert hook (main-app maps it to a bot
      // warning). Grid's override suppresses alerts before `finishLoad`, so on
      // a restart the log line above is the reliable half.
      this.cbEmit(
        false,
        `${n} order${
          n === 1 ? '' : 's'
        } could not be found on the exchange after ${orderQuarantineStrikes} checks and will no longer be polled. Trading is unaffected — the bot still receives live updates for them. Restarting the bot re-checks them.`,
      )
    }
    this.orderCheckRunId = ''
    this.newlyQuarantined = []
    this.quarantineSkipped = 0
  }

  /** Should this order be skipped by the polling loops? */
  protected isOrderQuarantined(order: Order) {
    if (!orderQuarantineStrikes) return false
    if (!order.quarantine?.since) return false
    this.quarantineSkipped += 1
    return true
  }

  /**
   * Record one definitive not-found for an order and quarantine it once the
   * strikes add up. Called only when {@link isDefinitiveOrderNotFound} is true
   * — never on a timeout, a rate-limit or any other transient failure.
   */
  protected noteOrderNotFound(order: Order, reason: string) {
    if (!orderQuarantineStrikes) return
    const now = +new Date()
    const runId = this.orderCheckRunId || `${now}`
    // Too young to judge. A venue that says "unknown order id" about an order
    // placed minutes ago is describing its own propagation lag. Use the most
    // recent timestamp we have, and refuse to judge at all when we have none —
    // both choices err towards leaving the order alone.
    const lastKnownAt = Math.max(order.transactTime ?? 0, order.updateTime ?? 0)
    if (!lastKnownAt || now - lastKnownAt < orderQuarantineMinAgeMs) return
    const current = order.quarantine
    // Already quarantined, or already struck in this run: nothing new was learned.
    if (current?.since || (current && current.runId === runId)) return
    const next: OrderQuarantine = {
      strikes: (current?.strikes ?? 0) + 1,
      firstAt: current?.firstAt ?? now,
      lastAt: now,
      reason,
      runId,
    }
    if (next.strikes >= orderQuarantineStrikes) {
      next.since = now
      this.newlyQuarantined.push(order.clientOrderId)
    }
    order.quarantine = next
    this.setOrder(order)
    this.updateOrderOnDb(order)
  }

  /**
   * Drop quarantine for every order this bot holds. Called on a user-initiated
   * start — the manual escape hatch, so a user who believes their orders are
   * real can always force a fresh look without an operator.
   */
  protected async clearAllOrderQuarantine(why: string) {
    if (!orderQuarantineStrikes) return
    const cleared = this.allOrders.filter((o) => o.quarantine)
    if (!cleared.length) return
    for (const o of cleared) {
      delete o.quarantine
      this.setOrder(o, false)
    }
    this.setOrdersToRedis(this.botId, false)
    // Explicit `$unset`, not `updateOrderOnDb`: that spreads the order into a
    // `$set`, so a key deleted from the JS object is merely absent from the
    // update and Mongo keeps the old value. The flag would then come back the
    // next time orders were loaded from the DB — an escape hatch that only
    // worked until the next restart is worse than none.
    await this.ordersDb
      .updateData(
        { clientOrderId: { $in: cleared.map((o) => o.clientOrderId) } },
        { $unset: { quarantine: '' } },
      )
      .catch((e) =>
        this.handleWarn(`Cannot clear order quarantine in DB: ${e}`),
      )
    this.handleLog(
      `Cleared order quarantine on ${cleared.length} order(s) (${why}) — they will be polled again`,
    )
  }

  /**
   * The venue answered for this order, so whatever we had counted against it is
   * void. Strikes are documented as *consecutive* not-founds and this is what
   * makes that true: without it they accumulate for the life of the order, so
   * three unrelated propagation blips months apart would quarantine a live
   * order. The merge path drops the flag on its own, but only on the branches
   * that write the order back — an order that resolves *unchanged* takes
   * neither `setOrder` nor `updateOrderOnDb`, which is the common case for a
   * resting limit order and exactly where strikes would go stale.
   */
  protected clearOrderStrikes(order: Order) {
    if (!order.quarantine) return
    delete order.quarantine
    this.setOrder(order, false)
    this.ordersDb
      .updateData(
        { clientOrderId: order.clientOrderId },
        { $unset: { quarantine: '' } },
      )
      .catch(() => undefined)
  }

  /** How many of this bot's orders are currently not being polled. */
  get quarantinedOrderCount() {
    return this.allOrders.filter((o) => o.quarantine?.since).length
  }

  startMethod(name: string) {
    const id = v4()
    this.currentMethods.set(id, { name, start: +new Date() })
    return id
  }

  endMethod(id: string) {
    const method = this.currentMethods.get(id)
    if (method) {
      this.lastMethods.push({ ...method, end: +new Date() })
      this.currentMethods.delete(id)
      if (this.lastMethods.length > maxMethods) {
        this.lastMethods.shift()
      }
    }
  }

  getStats() {
    return {
      status: this.data?.status,
      lastLogs: this.lastLogs,
      lastMethods: this.lastMethods,
      currentMethods: Array.from(this.currentMethods),
    }
  }

  saveProfitToDb(usd: number, time: number) {
    const hours = new Date(time)
    hours.setMinutes(0, 0, 0)
    const terminal =
      (this.data?.settings as DCABotSettings).type === DCATypeEnum.terminal
    this.userProfitByHourDb.updateData(
      {
        userId: this.userId,
        time: +hours,
        botType: this.data?.parentBotId
          ? this.botType === BotType.combo
            ? BotType.hedgeCombo
            : BotType.hedgeDca
          : this.botType,
        terminal,
        paperContext: !!this.data?.paperContext,
      },
      { $inc: { profitUsd: usd } },
      undefined,
      true,
      true,
    )
  }
  async beforeDelete() {
    return
  }

  async sendBotClosed(process = false) {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
    }
    if (!process) {
      this.handleLog(`Set timer 60s to send close bot signal`)
      this.closeTimer = setTimeout(
        () => this.sendBotClosed.bind(this)(true),
        60 * 1000,
      )
      return
    }
    if (
      this.data?.status !== BotStatusEnum.closed &&
      this.data?.status !== BotStatusEnum.archive
    ) {
      this.handleLog(`Bot closed signal, status ${this.data?.status}`)
      return
    }
    if (!isMainThread) {
      this.redisSubGlobal?.unsubscribe(serviceLogRedis, this.processServiceLog)
      this.redisSubGlobal?.unsubscribe(
        `botUpdateExchangeInfo${threadId}`,
        this.updateExchangeInfo,
      )
      this.redisSubGlobal?.unsubscribe(
        `botUpdateUserExchange${threadId}`,
        this.updateExchangeCredentials,
      )
      await this.beforeDelete()
      if (this.data.parentBotId) {
        this.handleLog(`Bot has parent bot, checking siblings`)
        const findOther = await this.db?.readData<{
          _id: string
          status: BotStatusEnum
          deals: ClearDCABotSchema['deals'] | null
        }>(
          {
            parentBotId: this.data.parentBotId,
            _id: { $ne: new Types.ObjectId(this.botId ?? '') },
          },
          { _id: 1, deals: 1, status: 1 },
          {},
          true,
        )
        if (findOther?.status === StatusEnum.notok) {
          this.handleErrors(
            `Cannot find other bots with parent ${this.data.parentBotId}`,
            'sendBotClosed',
            '',
            false,
            false,
            false,
          )
          return
        }
        const allClosed = findOther?.data?.result?.every(
          (b) =>
            b.status === BotStatusEnum.closed &&
            (!b.deals || b.deals.active === 0),
        )
        if (allClosed) {
          this.handleLog(`All siblings closed, closing parent bot`)
          await this.botService.callBotFunctionFromMeta(
            this.data.parentBotId,
            this.botType === BotType.dca
              ? BotType.hedgeDca
              : BotType.hedgeCombo,
            'stopFromChildBot',
            this.data.parentBotId,
          )
        }
      }
      parentPort?.postMessage({
        event: 'botClosed',
        botId: this.botId,
        botType: this.botType,
      })
    }
  }

  async connectRedis() {
    this.redisDb = await RedisClient.getInstance()
  }

  async processServiceLog(msg: string) {
    try {
      const service = JSON.parse(msg)?.restart
      if (service === 'userStream') {
        this.connectRabbitUserStream()
      }
      return service
    } catch (e) {
      this.handleErrors(
        `${(e as Error)?.message ?? e}`,
        'redisSubCb',
        '',
        false,
        false,
        false,
      )
    }
  }

  async connectRedisSub() {
    this.redisSubGlobal = await RedisClient.getInstance(true, 'global')
    this.redisSubGlobal.subscribe(serviceLogRedis, this.processServiceLog)
    this.redisSubGlobal.subscribe(
      `botUpdateExchangeInfo${threadId}`,
      this.updateExchangeInfo,
    )
    this.redisSubGlobal.subscribe(
      `botUpdateUserExchange${threadId}`,
      this.updateExchangeCredentials,
    )
    this.redisSubGlobal.subscribe(
      `botUpdateGlobalVars${threadId}`,
      this.botUpdateGlobalVars,
    )
  }

  async rawFromRedis<T>(key: string, property: string): Promise<T | null> {
    try {
      if (this.redisDb) {
        const maxTime = 2 * 60 * 1000
        return await new Promise<T | null>(async (resolve, reject) => {
          setTimeout(() => {
            reject(new Error(`Redis Internal timeout ${maxTime}ms exceeded`))
          }, maxTime)
          try {
            const result = await this.redisDb?.hGet(key, property)
            if (result) {
              resolve(JSON.parse(result) as T)
            }
            resolve(null)
          } catch (e) {
            reject(e)
          }
        })
      }
      return null
    } catch (e) {
      this.handleErrors(
        `Cannot get from redis ${key} ${property} ${e}`,
        'getFromRedis',
        '',
        false,
        false,
        false,
      )
      return null
    }
  }

  async getFromRedis<T>(key: RedisKeys): Promise<T | null> {
    return await this.rawFromRedis(this.botId, key)
  }

  async setToRedis<T>(key: RedisKeys, data: T) {
    try {
      if (this.redisDb && this.redisDb.isReady) {
        this.redisDb.hSet(this.botId, key, JSON.stringify(data))
      }
    } catch (e) {
      this.handleErrors(
        `Cannot set to redis ${key} ${e}`,
        'setToRedis',
        '',
        false,
        false,
        false,
      )
    }
  }

  async removeFromRedis(key: RedisKeys) {
    try {
      if (this.redisDb && this.redisDb.isReady) {
        this.redisDb.hDel(this.botId, key)
      }
    } catch (e) {
      this.handleErrors(
        `Cannot remove from redis ${key} ${e}`,
        'removeFromRedis',
        '',
        false,
        false,
        false,
      )
    }
  }

  async clearRedis() {
    try {
      if (this.redisDb && this.redisDb.isReady) {
        this.redisDb.del(this.botId)
      }
      return null
    } catch (e) {
      this.handleErrors(
        `Cannot clear redis ${e}`,
        'clearToRedis',
        '',
        false,
        false,
        false,
      )
      return null
    }
  }

  removeOrderByStatus(id: string, skipStatus?: OrderStatusType) {
    for (const s of [...this.orderStatusMap.keys()]) {
      if (skipStatus && s === skipStatus) {
        continue
      }
      const get = this.orderStatusMap.get(s)
      if (get) {
        get.delete(id)
      }
    }
  }

  removeOrderByDeal(dealId: string, id: string) {
    const get = this.orderDealMap.get(dealId)
    if (get) {
      get.delete(id)
    }
  }

  setOrderByStatus(status: OrderStatusType, id: string) {
    if (!id) {
      return
    }
    this.orderStatusMap.set(
      status,
      (this.orderStatusMap.get(status) ?? new Set()).add(id),
    )
    this.removeOrderByStatus(id, status)
  }

  setOrderByDeal(dealId: string, id: string) {
    if (!id) {
      return
    }
    this.orderDealMap.set(
      dealId,
      (this.orderDealMap.get(dealId) ?? new Set()).add(id),
    )
  }

  getOrdersByStatusAndDealId({
    status,
    dealId,
    defaultStatuses,
  }: {
    status?: OrderStatusType | OrderStatusType[]
    dealId?: string | string[]
    defaultStatuses?: boolean
  }) {
    const statusIds: Set<string> = new Set()
    if (status || defaultStatuses) {
      for (const s of defaultStatuses
        ? this.orderStatuses
        : status
          ? [status].flat()
          : []) {
        const getByStatus = this.orderStatusMap.get(s)
        if (getByStatus) {
          for (const id of getByStatus) {
            statusIds.add(id)
          }
        }
      }
    }
    const dealIds: Set<string> = new Set()
    if (dealId) {
      for (const s of [dealId].flat()) {
        const getByDeal = this.orderDealMap.get(s)
        if (getByDeal) {
          for (const id of getByDeal) {
            dealIds.add(id)
          }
        }
      }
    }
    const ids =
      dealId && (status || defaultStatuses)
        ? getIntersection(dealIds, statusIds)
        : dealId
          ? dealIds
          : status || defaultStatuses
            ? statusIds
            : new Set<string>()
    const result: Order[] = []
    for (const id of ids) {
      const order = this.orders.get(id)
      if (order) {
        result.push(order)
      }
    }
    return result
  }

  @RunWithDelay(
    (botId: string) => `${botId}setOrdersToRedis`,
    (_botId: string, restart: boolean) => setToRedisDelay * (restart ? 5 : 2),
  )
  setOrdersToRedis(_botId: string, _restart: boolean) {
    if (this.orders.size > 500) {
      this.removeFromRedis('orders')
      return
    }
    this.setToRedis('orders', [...this.orders.values()])
  }

  setOrder(order: Order, setToRedis = true) {
    const key = order.clientOrderId
    this.orders.set(key, order)
    if (order.dealId) {
      this.setOrderByDeal(order.dealId, key)
    }
    this.ordersKeys.add(key)
    this.setOrderByStatus(order.status, key)
    if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
      this.sharedStream.addOrder(this.botId, order.clientOrderId)
    }
    if (setToRedis) {
      this.setOrdersToRedis(
        this.botId,
        this.serviceRestart && !this.secondRestart,
      )
    }
  }

  getOrderFromMap(key?: string) {
    if (!key) {
      return
    }
    return this.orders.get(key)
  }

  deleteOrder(key: string, setToRedis = true) {
    const get = this.orders.get(key)
    this.orders.delete(key)
    if (get?.dealId) {
      this.removeOrderByDeal(get.dealId, key)
    }
    this.ordersKeys.delete(key)
    this.removeOrderByStatus(key)
    this.sharedStream.removeOrder(this.botId, key)
    if (setToRedis) {
      this.setOrdersToRedis(
        this.botId,
        this.serviceRestart && !this.secondRestart,
      )
    }
  }
  get allOrders() {
    return [...this.orders.values()]
  }
  async changeName(name: string) {
    this.handleLog(`Change bot name to ${this.data?.settings.name} -> ${name}`)
    if (this.data) {
      this.data.settings.name = name
      this.saveBotDataToRedis(this.botId, false)
    }
  }

  public async afterUpdateExchangeInfo(_pairs: Set<string>) {
    return
  }

  public updateExchangeInfo(msg: string) {
    try {
      const data = JSON.parse(msg) as {
        exchange: ExchangeEnum
        pairs: string[]
      }
      if (
        data.exchange !==
        removePaperFormExchangeName(this.data?.exchange ?? ExchangeEnum.binance)
      ) {
        return
      }
      let count = 0
      const updatedPairs = new Set<string>()
      for (const i of data.pairs) {
        if (this.pairs.has(i)) {
          updatedPairs.add(i)
          count++
        }
      }
      if (count) {
        this.handleLog(
          `Update exchange info for ${count} pairs ${this.data?.exchange}`,
        )
        this.afterUpdateExchangeInfo(updatedPairs)
      }
    } catch (e) {
      this.handleErrors(
        `Cannot update exchange info ${e}`,
        'updateExchangeInfo',
        '',
        false,
        false,
        false,
      )
    }
  }
  public async reloadBot(_botId: string) {
    return
  }

  public botUpdateGlobalVars(msg: string) {
    try {
      const data = JSON.parse(msg) as {
        _id: string
      }
      if (!(this.data?.vars?.list ?? [])?.includes(data._id)) {
        return
      }
      const findPath = this.data?.vars?.paths?.find(
        (i) => i.variable === data._id,
      )
      const isIndicatorsPath = findPath?.path.includes('indicators')
      const isDcaCustomPath = findPath?.path.includes('dcaCustom')
      const isMultiTpPath = findPath?.path.includes('multiTp')
      const isMultiSlPath = findPath?.path.includes('multiSl')
      if (
        isIndicatorsPath ||
        isDcaCustomPath ||
        isMultiTpPath ||
        isMultiSlPath
      ) {
        if (this.reloadTimer) {
          clearTimeout(this.reloadTimer)
          this.reloadTimer = null
        }
        this.handleLog(
          `Set timer to restart bot after 30s after variable ${data._id} changed`,
        )
        this.reloadTimer = setTimeout(
          () => this.reloadBot(this.botId),
          30 * 1000,
        )
      } else {
        this.handleLog(
          `Variable ${data._id} is not from indicators or dca custom or multi tp/sl, skip reload`,
        )
        if (this.botType === BotType.combo || this.botType === BotType.dca) {
          const resetStats =
            findPath?.path.includes('orderSize') ||
            findPath?.path.includes('baseOrderSize') ||
            findPath?.path.includes('ordersCount') ||
            findPath?.path.includes('volumeScale') ||
            findPath?.path.includes('maxNumberOfOpenDeals')
          if (resetStats || (this.data as BotSchema | null)?.stats) {
            this.handleLog(
              `Reset bot ${this.botId} stats after variable ${data._id} changed`,
            )
            this.updateData({
              stats: null,
              symbolStats: null,
              resetStatsAfter: +new Date(),
            })
          }
        }
      }
    } catch (e) {
      this.handleErrors(
        `Cannot update global vars ${e}`,
        'botUpdateGlobalVars',
        '',
        false,
        false,
        false,
      )
    }
  }

  closeUserStream() {
    const uuid = this.data?.exchangeUUID
    this.rabbitClient?.send(rabbitUsersStreamKey, {
      event: 'close stream',
      uuid,
    })
    this.redisSubGlobal?.unsubscribe(
      `userStreamInfo${uuid}`,
      this.userStreamInfoCb,
    )

    if (this.userStreamChannel) {
      this.sharedStream.removeListener(this.userStreamChannel, this.botId)
    }
    this.stopFunding()
  }

  async getExchangeData() {
    const exchange = (await this.getUser())?.exchanges.find(
      (e) => e.uuid === this.data?.exchangeUUID,
    )
    if (!exchange) {
      this.handleErrors(
        `No exchange data in connect rabbit ${this.data?.exchangeUUID}`,
        '',
        '',
        false,
        false,
        false,
      )
      return
    }
    const { uuid, keysType, provider, okxSource, bybitHost, subaccount } =
      exchange
    const { key, secret, passphrase } = await resolveConnection(exchange)
    return {
      uuid,
      key,
      secret,
      passphrase,
      keysType,
      okxSource,
      bybitHost,
      provider,
      subaccount,
    }
  }

  async connectRabbitUserStream() {
    const exchangeData = await this.getExchangeData()
    if (!exchangeData) {
      return
    }
    const { uuid, ...data } = exchangeData
    this.rabbitClient
      ?.send(rabbitUsersStreamKey, {
        event: 'open stream',
        data: {
          api: data,
          userId: this.userId,
        },
        uuid,
      })
      .then(() => {
        if (this.userStreamInitialStart) {
          this.handleLog(`User stream initial start from connect rabbit`)
          this.userStreamInitialStart = false
        }
      })
  }

  private async updateExchangeCredentials(msg: string) {
    try {
      const uuid = msg
      if (uuid !== this.data?.exchangeUUID) {
        return
      }
      const exchange = (await this.getUser())?.exchanges.find(
        (e) => e.uuid === uuid,
      )
      if (!exchange) {
        this.handleErrors(
          `Not found exchange data in update exchange credentials`,
          'updateExchangeCredentials',
          '',
          false,
          false,
          false,
        )
        return
      }
      await this.setExchangeCredentials(
        uuid,
        exchange.key,
        exchange.secret,
        exchange.passphrase,
        exchange.keysType,
        exchange.okxSource,
        exchange.bybitHost,
        exchange.subaccount,
        true,
      )
    } catch (e) {
      this.handleErrors(
        `Cannot update exchange credentials ${e}`,
        'updateExchangeCredentials',
        '',
        false,
        false,
        false,
      )
    }
  }

  protected userStreamInfoCb(msg: string) {
    this.handleLog(`${msg}`)
    if ((msg ?? '').includes('Subscribed to user')) {
      if (
        this.callbackAfterUserStream &&
        (!this.userStreamInitialStart ||
          (this.data?.exchange &&
            [
              ExchangeEnum.bybit,
              ExchangeEnum.bybitCoinm,
              ExchangeEnum.bybitUsdm,
            ].includes(this.data.exchange)))
      ) {
        this.callbackAfterUserStream(this.botId)
      }
      if (this.userStreamInitialStart) {
        this.handleLog(`User stream initial start`)
        this.userStreamInitialStart = false
      }
    }
    if ((msg ?? '').includes('RECONCILE VIA SWEEP')) {
      this.reconcileViaSweep = true
      void Promise.resolve(this.callbackAfterUserStream?.(this.botId))
        .catch((e) =>
          this.handleWarn(`reconcile-sweep failed: ${(e as Error).message}`),
        )
        .finally(() => {
          this.reconcileViaSweep = false
        })
    }
    if ((msg ?? '').includes('INFORM USERS')) {
      reconcileSweepDb
        .countData({
          exchangeUUID: this.data?.exchangeUUID,
          created: { $gt: new Date(+new Date() - 60 * 60 * 1000) },
        })
        .then((res) => {
          if ((res.data?.result ?? 0) > 0) {
            const troubleshootingUrl =
              process.env.STREAM_TROUBLESHOOTING_URL ??
              'https://docs.gainium.io/troubleshooting/exchange-connection-updates'
            this.handleErrors(
              `We're having trouble keeping your exchange connection up to date. Gainium is not receiving live updates for this account right now. We've attempted to reconnect automatically, but the issue is still present. See ${troubleshootingUrl} for common causes and fixes (e.g. an outdated API key format or an exchange IP whitelist that's missing our servers).`,
              '',
              '',
            )
          }
        })
    }
  }

  public async setExchangeCredentials(
    exchangeUUID: string,
    key: string,
    secret: string,
    passphrase?: string,
    keysType?: CoinbaseKeysType,
    okxSource?: OKXSource,
    bybitHost?: BybitHost,
    subaccount?: boolean,
    update?: boolean,
  ) {
    if (!this.data) {
      return
    }
    if (exchangeUUID !== this.data.exchangeUUID) {
      return
    }

    const exchange = this.exchangeChooser.chooseExchangeFactory(
      this.data.exchange,
    )
    if (exchange) {
      const shouldCheckAffiliate =
        !this.data.paperContext &&
        this.data.exchange.indexOf('hyperliquid') !== -1 &&
        (await this.getUser())?.exchanges.find((e) => e.uuid === exchangeUUID)
          ?.affiliate
      this.exchange = exchange(
        key || '',
        secret || '',
        passphrase || '',
        undefined,
        keysType,
        okxSource,
        bybitHost,
        subaccount,
        shouldCheckAffiliate,
      )
      this.handleLog('Load exchange provider')
      if (update) {
        return
      }

      if (this.cbFunctions) {
        this.userStreamChannel = exchangeUUID
        if (!this.redisSubGlobal) {
          this.redisSubGlobal = await RedisClient.getInstance(true, 'global')
        }
        await this.redisSubGlobal.unsubscribe(
          `userStreamInfo${exchangeUUID}`,
          this.userStreamInfoCb,
        )
        this.redisSubGlobal?.subscribe(
          `userStreamInfo${exchangeUUID}`,
          this.userStreamInfoCb,
        )
        this.sharedStream.addListener(
          this.userStreamChannel,
          this.botId,
          this.accountCallback,
        )

        this.connectRabbitUserStream()
      }
    }
  }

  public async getUserFee(symbol: string, force = false) {
    if (this.zeroFee) {
      return {
        maker: 0,
        taker: 0,
      }
    }
    return await this.sharedData.getUserFee(
      this.data?.exchangeUUID ?? '',
      symbol,
      this.userId,
      this.botId,
      force,
    )
  }

  public async unsubscribeFromUserFee(symbol: string) {
    return await this.sharedData.unsubscribeFromUserFee(
      this.data?.exchangeUUID ?? '',
      symbol,
      this.botId,
    )
  }

  public async getGlobalVarById(_id: string, force = false) {
    return await this.sharedData.getGlobalVars(
      _id,
      this.userId,
      this.botId,
      force,
    )
  }

  public async replaceInputVars<T>(
    botVars: BotVars | null | undefined,
    path: string,
    value: T,
  ): Promise<T> {
    if (!botVars) {
      return value
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      return value
    }
    const findPath = botVars?.paths.find((p) => p.path === path)
    if (findPath) {
      const get = await this.getGlobalVarById(findPath.variable)
      if (typeof value === 'number') {
        const num = +(get?.value ?? value) as number
        if (isNaN(num) || !isFinite(num)) {
          return value
        }
        value = num as unknown as T
      }
      if (typeof value === 'string') {
        value = (get?.value ?? value) as unknown as T
      }
    }
    return value
  }

  public async unsubscribeFromGlobalVars(_id: string) {
    return await this.sharedData.unsubscribeFromGlobalVars(_id, this.botId)
  }

  public async unsubscribeFromUser() {
    return await this.sharedData.unsubscribeFromUser(this.userId, this.botId)
  }

  public async getExchangeInfo(symbol: string, force = false) {
    return await this.sharedData.getExchangeInfo(
      removePaperFormExchangeName(this.data?.exchange ?? ExchangeEnum.binance),
      symbol,
      this.botId,
      force,
    )
  }

  /**
   * Authoritative "is this pair genuinely missing?" check.
   *
   * {@link MainBot#getExchangeInfo} can transiently return undefined even for a
   * valid, listed pair: the exchangeInfo store falls back to a `pairs` DB read
   * on a cache miss, and on a worker restart / resume herd many bots hit that
   * collection at once (cold cache) so an individual read can time out. Callers
   * that feed {@link MainBot#pairsNotFound} treat a miss as "pair no longer
   * exists" and then drop it from settings and silently stop/close the bot — so
   * a transient blip closes live bots. Re-verify with forced reads (bypassing
   * the cold/stale cache), an active re-fill, and a short backoff before
   * concluding the pair is really gone. Only genuinely-absent pairs return true.
   */
  async confirmPairMissing(
    symbol: string,
    attempts = 3,
    delayMs = 500,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      // force only on retries: the first read reuses whatever is already
      // loaded; retries bypass the cache to re-read the authoritative record.
      if (await this.getExchangeInfo(symbol, i > 0)) {
        return false
      }
      if (i < attempts - 1) {
        // Actively repopulate exchange info for this pair, then back off so a
        // resume-herd DB blip has a chance to recover before the next read.
        await this.fillExchangeInfo(symbol)
        await utils.sleep(delayMs)
      }
    }
    return true
  }

  public async unsubscribeFromExchangeInfo(symbol: string) {
    return await this.sharedData.unsubscribeFromExchange(
      removePaperFormExchangeName(this.data?.exchange ?? ExchangeEnum.binance),
      symbol,
      this.botId,
    )
  }

  @IdMute(mutex, (botId: string) => `${botId}placeFeeOrder`)
  async _placeFeeOrder(
    _botId: string,
    symbol: string,
    side: OrderSideEnum,
    orderSizeRef: number,
    dealId?: string,
  ) {
    if (!this.data) {
      return
    }
    if (this.futures) {
      this.handleLog(`Fee order | Skip fee order for futures`)
      return
    }
    const fee = await this.getUserFee(symbol)
    if (!fee) {
      this.handleLog(
        `Fee order | Skip fee order for ${symbol}, cannot find fee`,
      )
      return
    }
    if (fee?.maker === 0) {
      this.handleLog(`Fee order | Skip fee order for ${symbol}, user fee 0`)
      return
    }
    const ed = await this.getExchangeInfo(symbol)
    if (!ed) {
      this.handleLog(`Fee order | Skip fee order for ${symbol}, ed not found`)
      return
    }
    const price = await this.getLatestPrice(symbol)
    if (price === 0) {
    }
    const size =
      orderSizeRef !== 0
        ? Math.max(
            ed.baseAsset.minAmount,
            (ed.quoteAsset.minAmount / price) * 1.05,
            orderSizeRef * fee.maker * 10,
          )
        : Math.max(
            ed.baseAsset.minAmount,
            (ed.quoteAsset.minAmount / price) * 1.05,
          )
    const qty = this.math.round(
      size,
      await this.baseAssetPrecision(ed.pair),
      false,
      true,
    )
    return await this.sendOrderToExchange(
      {
        clientOrderId: this.getOrderId('GA-F'),
        status: 'NEW' as 'NEW',
        executedQty: '0',
        price: `${this.math.round(price, ed.priceAssetPrecision)}`,
        origPrice: `${price}`,
        cummulativeQuoteQty: `${price * qty}`,
        orderId: '-1',
        origQty: `${qty}`,
        side: side,
        symbol: ed.pair,
        baseAsset: ed.baseAsset.name,
        quoteAsset: ed.quoteAsset.name,
        updateTime: new Date().getTime(),
        exchange: this.data.exchange,
        exchangeUUID: this.data.exchangeUUID,
        typeOrder: TypeOrderEnum.fee,
        botId: this.botId,
        userId: this.userId,
        transactTime: new Date().getTime(),
        fills: [],
        dealId,
        type: 'MARKET',
      },
      false,
    )
  }

  async runAfterLoading() {
    this.handleLog(`Run after loading`)
    for (const q of this.runAfterLoadingQueue) {
      await q()
    }
    this.runAfterLoadingQueue = []
    // Arm the reconciliation sweep on every load (fresh start AND service
    // reload), so a bot restored after a restart is also protected.
    this.startConsumerHeartbeat()
  }

  async priceUpdateCallback(_botId: string, _msg: PriceMessage) {
    return
  }

  cbEmit(_setError: boolean, _message: string) {
    return
  }

  @IdMute(mutex, (botId: string) => `${botId}processError`)
  async processError(
    _botId: string,
    subType: string,
    terminal: boolean,
    setError: boolean,
    sendError: boolean,
    message: string,
    time: number,
    _messageToSet?: string,
    // User-initiated actions (e.g. a manual add/reduce funds) must always be
    // reported back, even if an identical-subType message is already active or
    // was throttled. When true, bypass the de-dup / throttle gates below.
    force = false,
  ) {
    if (this.ignoreErrors) {
      return
    }
    const messageToSet = _messageToSet ?? message
    const isMaxDeals = messageToSet === 'Max open deals limit for the bot'
    const debug = process.env.LOG_LEVEL === 'debug'
    const errorText = setError ? `Error | ${message}` : `Warn | ${message}`
    if (!isMaxDeals && debug) {
      if (setError) {
        this.handleError(errorText)
      } else {
        this.handleWarn(errorText)
      }
    }
    this.pushLogs(message, setError ? 'error' : 'warning')
    let botName = terminal ? '' : this.data?.settings?.name
    const nameVar = this.data?.vars?.paths?.find((p) => p.path === 'name')
    if (nameVar) {
      const get = await this.getGlobalVarById(nameVar?.variable)
      if (get) {
        botName = `${get.value}`
      }
    }
    let _id = v4()
    if (
      force ||
      !(
        this.data?.status === BotStatusEnum.error &&
        this.data?.previousStatus !== BotStatusEnum.error &&
        this.data?.statusReason === subType
      )
    ) {
      // How many rows this occurrence is allowed to occupy — see
      // `getSubTypeLogPolicy`. This REPLACES the count-then-insert gate that used
      // to live here. That gate asked "does a live visible row already exist?",
      // which is the right question asked in a way that cannot hold: the answer
      // is stale the moment it returns, it read a failed query as "no" and wrote
      // anyway, and it filtered on `showUser:true` so no hidden row was ever
      // covered by it. Uniqueness is now the database's job
      // (`botMessageCoalesceKey`), and repeats become a `count` instead of a row.
      let policy = getSubTypeLogPolicy(subType, sendError)
      if (
        !getSubTypeBehavior(subType)?.logMode &&
        (subType === 'Not enough balance' ||
          (subType === 'Uncategorized' && isMaxDeals))
      ) {
        // These two carried a bespoke "at most one per 24h" branch. Expressed as
        // a policy it is just a daily coalesce window, and an admin can now
        // change it without a deploy. The window is calendar-aligned where the
        // old branch was rolling — one row per UTC day rather than one per 24h
        // since the last — which is the only behaviour change here.
        policy = { mode: 'coalesce', windowMs: 24 * 60 * 60 * 1000 }
      }
      const bucket = logPolicyBucket(policy, time)

      if (!debug) {
        if (setError) {
          this.handleError(errorText)
        } else {
          this.handleWarn(errorText)
        }
      }
      this.errorsMap.set(subType, +new Date())

      const messageBotId = this.data?.parentBotId || this.botId
      const messageType = setError
        ? MessageTypeEnum.error
        : MessageTypeEnum.warning
      const symbol = this.data?.settings.pair[0]
      const exchange = this.data?.exchange
      // Immutable identity of the row, applied only when one is created.
      const onInsert = {
        userId: this.userId,
        botId: messageBotId,
        botType: this.data?.parentBotId
          ? this.botType === BotType.dca
            ? BotType.hedgeDca
            : BotType.hedgeCombo
          : this.botType,
        subType,
        showUser: sendError,
        // A suppressed message is born dismissed: it is kept only so the admin
        // Bot Errors page can count it, and the tombstone TTL reaps it on age.
        isDeleted: !sendError,
        paperContext: !!this.data?.paperContext,
        terminal,
        firstTime: time,
        created: new Date(),
      }
      // Refreshed on every occurrence, so a coalesced row reports the LATEST
      // state of the condition rather than a snapshot of the first time it fired.
      const onEvery = {
        botName,
        type: messageType,
        message: messageToSet,
        fullMessage: message,
        time,
        symbol,
        exchange,
        updated: new Date(),
      }

      let firstOccurrence = true
      let savedId: string | null = null

      if (bucket === null) {
        const savedMessage = await this.messagesDb.createData({
          ...onInsert,
          ...onEvery,
        })
        if (savedMessage.status === StatusEnum.ok && savedMessage.data) {
          savedId = `${savedMessage.data._id}`
        }
      } else {
        const key = {
          userId: this.userId,
          botId: messageBotId,
          subType,
          showUser: sendError,
          bucket,
        }
        // `$inc` makes "is this the first occurrence in this window?" a property
        // of the write itself rather than of a separate read: count===1 means
        // this call created the row. Nothing else can observe a different answer.
        const upserted = await this.messagesDb.updateData(
          key,
          {
            // `bucket` rides in $setOnInsert rather than the key spread so the
            // `always` path above can share `onInsert` without carrying a null.
            $setOnInsert: { ...onInsert, bucket },
            $set: onEvery,
            $inc: { count: 1 },
          },
          true,
          false,
          true,
        )
        if (upserted.status === StatusEnum.ok && upserted.data) {
          savedId = `${upserted.data._id}`
          firstOccurrence = (upserted.data.count ?? 1) <= 1
        } else {
          // Two legs of the same bot can reach an unset key together and one
          // loses on E11000. The row it wanted now exists, so fold into it —
          // never re-raise, or a race would become the notification the whole
          // coalescing exists to prevent.
          firstOccurrence = false
          const folded = await this.messagesDb.updateData(key, {
            $set: onEvery,
            $inc: { count: 1 },
          })
          if (folded.status === StatusEnum.notok) {
            this.handleWarn(
              `Cannot record bot message ${subType} | ${upserted.reason}`,
            )
          }
        }
      }

      if (savedId && sendError && firstOccurrence) {
        _id = savedId
        this.emit('bot message', {
          botName,
          _id,
          type: messageType,
          message: messageToSet,
          time,
          terminal,
          symbol,
          exchange,
          // Additive: lets the dashboard recognise e.g. a Quantitative Rules
          // cooldown warning without parsing the message text. No event rename.
          subType,
        })
        this.cbEmit(setError, messageToSet)
      }
    }

    if (setError) {
      if (this.data) {
        const data = {
          statusReason: subType,
        }
        this.data = { ...this.data, ...data }
        this.updateData(data as any)
        this.emit('bot settings update', data)
      }
      this.setRangeOrError(BotStatusEnum.error)
    }
  }

  get isBitget() {
    return (
      this.data?.exchange === ExchangeEnum.bitget ||
      this.data?.exchange === ExchangeEnum.bitgetUsdm ||
      this.data?.exchange === ExchangeEnum.bitgetCoinm
    )
  }

  protected getErrorSubType(errorString: string): string {
    return getErrorSubType(errorString)
  }

  /**
   * Prepare message
   *
   * Send it via socket to subscribers
   *
   * Log message
   *
   * @param {Error | string} e Error instance
   * @param {string} method Method on which error was received
   * @param {string} [step] Step of the method
   * @param {boolean} [setError] Set error status to the bot. Default = true
   */

  async handleErrors(
    e: Error | string,
    method: string,
    step?: string,
    setError = true,
    sendError = true,
    setEvent = true,
    // Propagated to processError: when true the error is always reported to
    // the user, even if a same-subType message is already active/throttled.
    force = false,
  ): Promise<void> {
    if (this.ignoreErrors) {
      return
    }
    const errorString =
      typeof e === 'string' ? e : (e?.message ?? 'Unknown error')
    // @ts-ignore
    const terminal = this.data?.settings.type === DCATypeEnum.terminal
    const message = `${
      !terminal ? `Bot ${this.botId} ` : ''
    }Reason ${errorString} ${method ? `Method ${method}` : ''} ${
      step ? `Step ${step}` : ''
    }`
    let messageToSet = errorString
    const time = new Date().getTime()
    const subType = this.getErrorSubType(errorString)

    if (message.indexOf('PERCENT_PRICE') !== -1) {
      return
    }

    // Count this occurrence against its classification rule (once per real
    // error) so the admin page shows a meaningful fire count. No-op when the
    // subType came from the static errorDict rather than a DB rule.
    noteErrorRuleHit(errorString)

    // Dynamic message normalisation that cannot be expressed as a static
    // userMessage: strip our internal "Indicators error: " prefix so the user
    // sees the underlying indicator message.
    if (subType === indicatorsError) {
      messageToSet = messageToSet.replace('Indicators error: ', '')
    }

    // Data-driven per-subType behaviour (boterrorsubtypes, admin-managed):
    // whether the error is shown to the user, whether it flips the bot into an
    // error state, and an optional user-facing message rewrite. This replaces
    // the previously-hardcoded per-subType branches (exchangeProblems /
    // orderPrice / orderProcessing / futuresPosition / exchangeRateLimit /
    // exchangeRules / exchangeOrdersLimits / apiError …). FAIL-SAFE: an
    // unclassified subType keeps today's defaults (shown, errors bot, raw
    // message) — only explicitly-classified subTypes deviate.
    //
    // Leverage-misconfig surfaces as the benign 'Futures position' subType but
    // IS user-actionable, so it must stay a visible hard error. Exclude it from
    // the data-driven path (treat as unclassified) so it keeps the defaults.
    const isLeverageFuturesPos =
      subType === futuresPosition &&
      errorString.toLowerCase().indexOf('leverage') !== -1
    const behavior = isLeverageFuturesPos ? null : getSubTypeBehavior(subType)
    if (behavior) {
      if (behavior.errorsBot === false) {
        setError = false
      }
      if (behavior.showUser === false) {
        sendError = false
        setEvent = false
      }
      if (behavior.userMessage) {
        messageToSet = behavior.userMessage
      }
    }

    const type = setError ? MessageTypeEnum.error : MessageTypeEnum.warning
    if (setEvent) {
      this.botEventDb
        .createData({
          userId: this.userId,
          botId: this.botId,
          event: `Bot ${setError ? 'error' : 'warning'}`,
          botType: this.botType,
          description: `${setError ? 'Error' : 'Warning'}: ${messageToSet}`,
          paperContext: !!this.data?.paperContext,
          type,
        })
        .then((res) => {
          if (res.status === StatusEnum.ok) {
            if (type !== MessageTypeEnum.warning) {
              const update = { showErrorWarning: type }
              this.updateData(update)
              this.emit('bot settings update', update)
            }
          }
        })
    }

    this.processError(
      this.botId,
      subType,
      terminal,
      setError,
      sendError,
      message,
      time,
      messageToSet,
      force,
    )
  }

  private isErrorNotEnoughBalance(errorString: string): boolean {
    for (const e of notEnoughErrors) {
      if (errorString.toLowerCase().indexOf(e.toLowerCase()) !== -1) {
        return true
      }
    }
    return false
  }

  @IdMute(mutex, (botId: string) => `checkNotEnoughBalanceErrors${botId}`)
  async checkNotEnoughBalanceErrors(_botId: string) {
    if (
      !this.data ||
      !this.data.notEnoughBalance ||
      !this.data.notEnoughBalance.orders
    ) {
      return
    }
    const isThresholdBypassed = Object.values(
      this.data.notEnoughBalance.orders,
    ).some((v) => v >= this.notEnoughBalanceThreshold)
    let needUpdate = false
    if (
      !isThresholdBypassed &&
      (this.data.notEnoughBalance.thresholdPassed ||
        this.data.notEnoughBalance.thresholdPassedTime !== 0)
    ) {
      this.handleLog(
        `${this.notEnoughBalanceLogPrefix} Reset not enough balance errors`,
      )
      this.data.notEnoughBalance.thresholdPassed = false
      this.data.notEnoughBalance.thresholdPassedTime = 0
      needUpdate = true
    }
    if (
      isThresholdBypassed &&
      (!this.data.notEnoughBalance.thresholdPassed ||
        this.data.notEnoughBalance.thresholdPassedTime === 0)
    ) {
      this.handleLog(
        `${this.notEnoughBalanceLogPrefix} Not enough balance errors threshold passed, set thresholdPassed to true`,
      )
      this.data.notEnoughBalance.thresholdPassed = true
      this.data.notEnoughBalance.thresholdPassedTime = +new Date()
      // Persist + broadcast this transition too. It previously relied on the
      // caller's earlier `updateData` happening to flush the same mutated
      // object, so the arming edge was never announced to subscribers the way
      // the disarming edge was.
      needUpdate = true
    }
    if (needUpdate) {
      this.updateData({
        notEnoughBalance: this.data.notEnoughBalance,
      })
      this.emit('bot settings update', {
        notEnoughBalance: {
          thresholdPassed: this.data.notEnoughBalance.thresholdPassed,
        },
      })
    }
  }

  /**
   * Counter key for the not-enough-balance guard.
   *
   * Keyed on the RESOURCE that is actually exhausted — the (asset, side) pair —
   * not on the individual order. A spot balance is shared by every deal and
   * every grid level on that symbol, so if one sell is unfundable they all are.
   *
   * The previous scheme included `order.price`, which defeated the guard
   * entirely: ~88% of spot orders are MARKET and carry the live market price,
   * so consecutive retries each landed on a fresh counter starting at 0 and
   * never reached `notEnoughBalanceThreshold`. Measured on prod, that was 3.3
   * attempts per key against a threshold of 10 — 75% of retries reached the
   * exchange with the guard permanently disarmed. It also made the map
   * unbounded (one entry per price tick ever seen; one prod bot held 1,110
   * keys accumulated over 10 months).
   *
   * Blocking is still gated on a real balance check at the call site, so
   * collapsing distinct orders onto one counter cannot wrongly reject a
   * fundable order — it only decides when the check is worth doing.
   */
  private getNotEnoughOrdersIdByOrder(order: Order) {
    return `${order.symbol}@${order.side}`
  }

  @IdMute(mutex, (order: Order) => `notEnoughBalance${order.botId}`)
  private async updateNotEnoughBalanceErrors(
    order: Order,
    inc = 1,
    reset = false,
  ) {
    if (!this.data) {
      return
    }
    const id = this.getNotEnoughOrdersIdByOrder(order)
    if (!this.data.notEnoughBalance) {
      this.data.notEnoughBalance = {
        orders: {},
        thresholdPassed: false,
        thresholdPassedTime: 0,
      }
    }
    if (!this.data.notEnoughBalance.orders) {
      this.data.notEnoughBalance.orders = {}
    }
    // Counters written under an older key scheme can never be matched by the
    // current one, so they would sit in the doc forever (and keep
    // `thresholdPassed` latched on evidence that no longer applies). Drop them
    // the first time a bot writes under the new scheme.
    if (this.data.notEnoughBalance.keyVersion !== notEnoughBalanceKeyVersion) {
      this.data.notEnoughBalance.orders = {}
      this.data.notEnoughBalance.thresholdPassed = false
      this.data.notEnoughBalance.thresholdPassedTime = 0
      this.data.notEnoughBalance.keyVersion = notEnoughBalanceKeyVersion
    }
    if (!this.data.notEnoughBalance.orders[id] && inc > 0) {
      this.data.notEnoughBalance.orders[id] = 0
    }
    this.data.notEnoughBalance.orders[id] += inc
    // Cap the counter. It is a trip-wire, not a tally: without a ceiling a
    // stuck order reaches five figures (16,987 was observed on prod), and the
    // `-1` decrement on a recovered balance would then need thousands of
    // successes to fall back under the threshold — the guard could never
    // disarm itself.
    if (
      this.data.notEnoughBalance.orders[id] >
      this.notEnoughBalanceThreshold + 1
    ) {
      this.data.notEnoughBalance.orders[id] = this.notEnoughBalanceThreshold + 1
    }
    if (this.data.notEnoughBalance.orders[id] <= 0 || reset) {
      delete this.data.notEnoughBalance.orders[id]
      // The constraint is gone (an order filled, or the balance covered it), so
      // drop the cooldown too — the next shortfall should start a fresh window
      // at `minMs` rather than resume a wide one.
      notEnoughBalanceBackoff.clear([this.botId, id])
    }
    this.updateData({
      notEnoughBalance: this.data.notEnoughBalance,
    })
    this.checkNotEnoughBalanceErrors(this.botId)
  }

  /**
   * Prepare order message
   *
   * Send it via socket to subscribers
   *
   * Log message
   *
   * @param {Error | string} e Error instance
   * @param {boolean} [setError] Set error status to the bot. Default = true
   */

  async handleOrderErrors(
    e: Error | string,
    order: Order,
    method: string,
    step?: string,
    setError = true,
    sendError = true,
  ): Promise<void> {
    const errorString = typeof e === 'string' ? e : e.message
    // A manual add/reduce-funds order carries addFundsId / reduceFundsId;
    // automatic safety orders don't. Such a user-initiated failure must always
    // be reported, never collapsed into an existing same-subType message.
    const isManualFunds = !!(order.addFundsId || order.reduceFundsId)
    if (!this.isErrorNotEnoughBalance(errorString)) {
      return this.handleErrors(
        e,
        method,
        step,
        setError,
        sendError,
        true,
        isManualFunds,
      )
    }
    this.updateNotEnoughBalanceErrors(order)
    let message = `Not enough balance Order id: ${order.clientOrderId}, side: ${
      order.side === 'BUY' ? 'buy' : 'sell'
    }, price - ${order.price} , order type: ${
      order.typeOrder === TypeOrderEnum.dealRegular
        ? 'DCA'
        : order.typeOrder === TypeOrderEnum.dealStart
          ? 'deal base order'
          : order.typeOrder === TypeOrderEnum.dealTP
            ? 'deal close'
            : order.typeOrder === TypeOrderEnum.regular
              ? 'grid order'
              : order.typeOrder === TypeOrderEnum.stop
                ? 'grid close'
                : order.typeOrder === TypeOrderEnum.stab
                  ? 'stabilization order'
                  : order.typeOrder === TypeOrderEnum.dealGrid
                    ? 'deal grid order'
                    : 'grid base order'
    }`
    // @ts-ignore
    const terminal = this.data?.settings.type === DCATypeEnum.terminal
    const time = new Date().getTime()
    const subType = 'Not enough balance'
    const { asset, balance, required } =
      await this.getAssetBalanceAndRequiredByOrder(order)
    // Report what the venue will actually let the bot commit. On a pooled
    // account the wallet quantity is not that number, and printing it is how
    // this message came to read "free - 50 USD" on an order the venue had just
    // refused for insufficient funds. Unchanged for every non-pooled venue.
    const free = await this.spendableForNotEnoughBalance(
      asset,
      balance?.free ?? 0,
    )
    message = `${message}, balance total - ${
      (balance?.free ?? 0) + (balance?.locked ?? 0)
    } ${asset}, free - ${free} ${asset}, required - ${required} ${asset}`
    if (order.typeOrder !== TypeOrderEnum.stab) {
      if (setError || sendError) {
        this.botEventDb
          .createData({
            userId: this.userId,
            botId: this.botId,
            event: 'Order error',
            botType: this.botType,
            description: `Error: ${message}`,
            paperContext: !!this.data?.paperContext,
            type: MessageTypeEnum.error,
            deal: order.dealId,
            symbol: order.symbol,
          })
          .then((res) => {
            if (res.status === StatusEnum.ok) {
              const update = { showErrorWarning: MessageTypeEnum.error }
              this.updateData(update)
              this.emit('bot settings update', update)
            }
          })
      }
      this.processError(
        this.botId,
        subType,
        terminal,
        setError,
        sendError,
        message,
        time,
        message,
        isManualFunds,
      )
    }
  }
  pushLogs(message: string, type: (typeof this.lastLogs)[0]['type'] = 'info') {
    this.lastLogs.push({ message, time: +new Date(), type })
    if (this.lastLogs.length > maxLogs) {
      this.lastLogs.shift()
    }
  }
  /**
   * Log message
   * @param {string} log Message to log
   */

  _handleLog(type: 'info' | 'debug' | 'warn' | 'error', log: string): void {
    if (this.log) {
      logger[type](
        `${loggerPrefix} Bot (${this.botType}) ${this.botId}${
          this.data?.parentBotId ? ` (${this.data.parentBotId})` : ''
        } | ${log}`,
      )
      this.pushLogs(log)
    }
  }

  handleLog(log: string): void {
    this._handleLog('info', log)
  }

  handleWarn(log: string): void {
    this._handleLog('warn', log)
  }

  handleDebug(log: string): void {
    this._handleLog('debug', log)
  }

  handleError(log: string): void {
    this._handleLog('error', log)
  }

  /**
   * Emit updates to {@link MainBot#ioUpdate}
   *
   * @param {string} event Event name
   * @param {any} data Data to send
   */

  @IdMute(mutexEmit, (botId: string) => `${botId}emit`)
  emit(event: string, data: any) {
    if (data.stats && event === 'bot sends settings') {
      data = { ...data }
      delete data.stats
    }
    const fullData = {
      botId: this.botId,
      parentBotId: this.data?.parentBotId,
      data,
      botType: this.botType,
      paperContext: !!this.data?.paperContext,
    }
    if (event === 'bot message') {
      fullData.botId = this.data?.parentBotId || this.botId
      fullData.botType = this.data?.parentBotId
        ? this.botType === BotType.dca
          ? BotType.hedgeDca
          : BotType.hedgeCombo
        : this.botType
    }
    this.redisDb?.publish(
      `${liveupdate}${this.userId}`,
      JSON.stringify({ data: fullData, event: eventMap[event] ?? event }),
    )
  }

  async updateUserProfitStep() {
    const userData = await this.getUser()
    if (
      userData &&
      !userData.onboardingSteps.earnProfit &&
      !this.data?.paperContext
    ) {
      userData.onboardingSteps.earnProfit = true
      updateUserSteps(this.userId, 'earnProfit')
    }
  }

  get isKraken() {
    return (
      this.data?.exchange === ExchangeEnum.kraken ||
      this.data?.exchange === ExchangeEnum.krakenUsdm ||
      this.data?.exchange === ExchangeEnum.krakenCoinm
    )
  }

  async redisSubKeys(pairs: string[]) {
    if (this.hyperliquid) {
      pairs = await Promise.all(
        pairs.map(async (p) => {
          const find = await this.getExchangeInfo(p)
          return this.isKraken ? p : (find?.code ?? p)
        }),
      )
    }
    return pairs.map(
      (p) =>
        `trade@${p}@${removePaperFormExchangeName(
          this.data?.exchange ?? ExchangeEnum.binance,
        )}`,
    )
  }

  // ---------------------------------------------------------------------------
  // Funding fees
  //
  // The funding store (keyed by the real exchange + universal symbol) is the
  // source of truth; FundingStream pub/sub is only a wake-up. Subclasses react
  // in `onFundingNotify` — Grid per-bot, DCA/Combo per open deal. Catch-up after
  // a restart / on deal-open is the same path: just call `onFundingNotify`.
  // ---------------------------------------------------------------------------

  /** Real exchange name (paper bots accrue real rates). */
  protected fundingExchangeName() {
    return removePaperFormExchangeName(
      this.data?.exchange ?? ExchangeEnum.binance,
    )
  }

  protected fundingChannelFor(symbol: string) {
    return fundingChannel(this.fundingExchangeName(), symbol)
  }

  private onFundingNotifyBound = (_msg: string, channelKey: string) =>
    this.onFundingNotify(channelKey)

  protected async subscribeFunding(symbol: string) {
    if (!this.futures) {
      return
    }
    await FundingStream.getInstance().addListener(
      this.fundingChannelFor(symbol),
      this.botId,
      this.onFundingNotifyBound,
    )
  }

  protected async unsubscribeFunding(symbol: string) {
    await FundingStream.getInstance().removeListener(
      this.fundingChannelFor(symbol),
      this.botId,
    )
  }

  /** Symbol carried in a `funding@<exchange>@<symbol>` channel key. */
  protected fundingSymbolFromChannel(channelKey: string) {
    return channelKey.split('@')[2] ?? ''
  }

  /**
   * Symbol used on the funding channel/registry/store. Kraken & Hyperliquid
   * pass the exchange code through their connectors, so we subscribe by code
   * (cheap lookup from shared exchange info); everyone else uses the pair.
   *
   * Returns `null` when the code can't be resolved. Falling back to the raw
   * pair looks harmless but poisons the registry permanently: the subscription
   * heartbeat re-writes that member every 60s, so it never ages out of the
   * cron's stale window, and the connector rejects it on every hourly poll
   * (Kraken `Argument invalid: symbol`, Hyperliquid unknown coin). Because
   * {@link MainBot#getExchangeInfo} can miss transiently on a cold cache /
   * resume herd, retry once forced before giving up.
   */
  protected async toFundingSymbol(pair: string): Promise<string | null> {
    if (this.isKraken || this.hyperliquid) {
      const ed =
        (await this.getExchangeInfo(pair)) ??
        (await this.getExchangeInfo(pair, true))
      if (!ed?.code) {
        this.handleWarn(
          `[funding] no exchange code for ${pair}; skipping funding subscription`,
        )
        return null
      }
      return ed.code
    }
    return pair
  }

  /** Reverse of {@link toFundingSymbol}: funding symbol → the bot's pair. */
  protected async fromFundingSymbol(fundingSym: string): Promise<string> {
    if (this.isKraken || this.hyperliquid) {
      const pair = await this.sharedData.getPairByCode(
        this.fundingExchangeName() as ExchangeEnum,
        fundingSym,
      )
      return pair ?? fundingSym
    }
    return fundingSym
  }

  /**
   * React to a settled-funding notify (or a catch-up call) for one symbol.
   * Default no-op; overridden by Grid (per-bot) and DCA/Combo (per deal).
   */
  protected async onFundingNotify(_channelKey: string): Promise<void> {
    return
  }

  /**
   * Start funding tracking on bot load (futures only). Subclasses subscribe
   * their symbols and run a catch-up. Default no-op.
   */
  protected async startFunding(): Promise<void> {
    return
  }

  /** Tear down all funding subscriptions for this bot. */
  protected async stopFunding(): Promise<void> {
    await FundingStream.getInstance().removeAllForBot(this.botId)
  }

  /**
   * Signed fills (buy +, sell −) for a deal from in-memory orders — no DB
   * round-trip, no full scan (uses the status+deal index). DCA/Combo keep all
   * deal orders in RAM, so this is complete for them. Ascending by time.
   */
  protected getSignedFillsFromMemory(dealId: string): SignedFill[] {
    return this.getOrdersByStatusAndDealId({ status: 'FILLED', dealId })
      .map((o) => ({
        time: +o.updateTime,
        signedQty:
          +(o.executedQty ?? o.origQty ?? 0) * (o.side === 'BUY' ? 1 : -1),
      }))
      .sort((a, b) => a.time - b.time)
  }

  /**
   * Shared store-read + funding math. `storeSymbol` keys the funding store
   * (code for kraken/HL); `pair` is the bot's pair (for exchange info / usd
   * rate). `getQtyAt` resolves the signed position at a settlement from RAM.
   */
  protected async computeFundingFor(
    storeSymbol: string,
    pair: string,
    offset: number,
    getQtyAt: (eventTime: number) => number,
  ): Promise<FundingComputeResult> {
    const events = await FundingStore.getEventsAfter(
      this.fundingExchangeName(),
      storeSymbol,
      offset,
    )
    if (!events.length) {
      return {
        deltaQuote: 0,
        deltaUsd: 0,
        maxTime: offset,
        lastTime: offset,
        applied: 0,
        entries: [],
      }
    }
    const inverse = this.coinm
    const ed = await this.getExchangeInfo(pair)
    const contractMultiplier = inverse ? ((ed as any)?.contractSize ?? 1) : 1
    const usdRate = (await this.getUsdRate(pair)) || 1
    return computeFunding({
      events,
      offset,
      getQtyAt,
      inverse,
      contractMultiplier,
      usdRate,
    })
  }

  redisSubCb(msg: string) {
    try {
      return this.priceUpdateCallback(this.botId, JSON.parse(msg))
    } catch (e) {
      this.handleErrors(
        `${(e as Error)?.message ?? e}`,
        'redisSubCb',
        '',
        false,
        false,
        false,
      )
    }
  }
  protected shouldContinueLoad(): boolean {
    return true
  }
  protected async updatePairs(): Promise<undefined> {
    return
  }
  /**
   * Read bot data from {@link MainBot#db}<br />
   *
   * Set data to {@link MainBot#data}<br />
   *
   * Set user id to {@link MainBot#userId}<br />
   *
   * Read user data from user collection<br />
   *
   * Set user timezone to {@link MainBot#userTz}<br />
   *
   * Get exchange provider for bot, based on bot settings<br />
   *
   * Emit message to {@link MainBot#ioUser} to connect to current user stream<br />
   *
   * Emit message to {@link MainBot#ioPrice} to connect to current bot symbol<br />
   */

  async loadData(
    _skipFuturesError?: boolean | ((data: any) => boolean),
    realStatus?: BotStatusEnum,
  ): Promise<void | boolean> {
    const id = this.startMethod('loadData')
    this.handleLog('Load data start')
    if (this.serviceRestart && !this.secondRestart && !SKIP_REDIS) {
      const botData = await this.getFromRedis<typeof this.data>('botData')
      if (botData) {
        if (realStatus && botData.status !== realStatus) {
          this.handleLog(
            `Skip load from redis, redis status ${botData.status}, real status ${realStatus}`,
          )
        } else {
          this.data = botData
          this.handleLog('Read bot data from redis')
        }
      }
    }
    if (SKIP_REDIS) {
      this.handleLog(`Skipping loading data from redis`)
    }
    if (!(this.serviceRestart && !this.secondRestart) || !this.data) {
      if (this.db) {
        const dbData = await this.db.readData(
          {
            _id: this.botId,
            status: { $ne: BotStatusEnum.archive },
            isDeleted: { $ne: true },
          } as any,
          undefined,
          {},
          false,
          false,
        )
        if (dbData.status === StatusEnum.notok) {
          this.handleErrors(dbData.reason, 'loadData()', 'Load bot data')
          this.endMethod(id)
          return true
        }
        if (!dbData.data || !dbData.data.result) {
          this.handleErrors(`Bot not found`, 'loadData()', 'Load bot data')
          this.endMethod(id)
          return true
        }
        this.handleLog('Read bot data')
        if (dbData.status === StatusEnum.ok) {
          this.data = dbData.data.result
        }
      }
    }
    if (this.data) {
      const skipFuturesError =
        typeof _skipFuturesError === 'function'
          ? _skipFuturesError(this.data)
          : !!_skipFuturesError
      this.userId = this.data.userId
      const userDataRaw = await this.getUser(
        !(this.serviceRestart && !this.secondRestart),
      )
      if (userDataRaw) {
        const userData = userDataRaw
        const keys = userData.exchanges.find(
          (e) => e.uuid === this.data?.exchangeUUID,
        )
        if (
          !this.data.paperContext &&
          !userData.onboardingSteps.deployLiveBot
        ) {
          updateUserSteps(this.userId, 'deployLiveBot')
          userData.onboardingSteps.deployLiveBot = true
        }
        if (!keys) {
          this.handleErrors('Exchange not found', 'Load data')
          this.endMethod(id)
          return true
        }
        if (
          keys.zeroFee &&
          !this.data.paperContext &&
          ![
            ExchangeEnum.okx,
            ExchangeEnum.okxInverse,
            ExchangeEnum.okxLinear,
            ExchangeEnum.bybit,
            ExchangeEnum.bybitCoinm,
            ExchangeEnum.bybitUsdm,
          ].includes(keys.provider)
        ) {
          this.handleLog(`Zero fee exchange`)
          this.zeroFee = true
        }
        const paper =
          (isPaper(keys.provider) || isPaper(this.data.exchange)) &&
          !this.data.paperContext
        const notPaper =
          (!isPaper(keys.provider) || !isPaper(this.data.exchange)) &&
          this.data.paperContext
        if (paper || notPaper) {
          this.handleErrors(
            paper
              ? 'Cannot start bot on paper exchange'
              : 'Cannot start bot on real exchange',
            'Load data',
          )
          this.endMethod(id)
          return true
        }
        await this.setExchangeCredentials(
          this.data.exchangeUUID,
          keys?.key ?? '',
          keys?.secret ?? '',
          keys?.passphrase ?? '',
          keys.keysType,
          keys.okxSource,
          keys.bybitHost,
          keys.subaccount,
        )
        if (!this.shouldContinueLoad()) {
          this.handleLog('Should not continue load')
          this.endMethod(id)
          return true
        }
        this.handleLog('Choose exchange provider')
        if (this.exchange) {
          this.handleLog('Load broker code')
          const code = await brokerCodesDb.readData({
            exchange: this.data.exchange,
          })
          if (code.status === StatusEnum.ok && code.data?.result) {
            this.brokerCode = code.data.result.code
            this.handleLog(`Broker code: ${this.brokerCode}`)
          }
          await this.updatePairs()
          ;[this.data.settings.pair].flat().forEach((p) => this.pairs.add(p))
          if (
            this.botType === BotType.dca &&
            !(this.data.settings as DCABotSettings).useMulti
          ) {
            const first =
              this.pairs.values().next().value || this.data.settings.pair?.[0]
            this.pairs.clear()
            this.pairs.add(first)
          }
          if (this.redisSubGlobal) {
            for (const pair of await this.redisSubKeys([...this.pairs])) {
              this.redisSubGlobal.subscribe(pair, this.redisSubCb)
            }
          }
          const skipFutures = this.serviceRestart && !this.secondRestart
          if (skipFutures) {
            this.handleLog(`Skip futures positions check`)
          }
          if (this.futures) {
            const bitgetFutures =
              this.data.exchange === ExchangeEnum.bitgetCoinm ||
              this.data.exchange === ExchangeEnum.bitgetUsdm
            const allPositions =
              this.data.exchange.startsWith('paper') ||
              this.data.exchange.toLowerCase().includes('binance') ||
              this.data.exchange.toLowerCase().includes('okx') ||
              this.kucoinFullFutures ||
              bitgetFutures
            let positionsRequest =
              !skipFutures && allPositions
                ? await this.exchange.futures_getPositions()
                : null
            if (allPositions) {
              this.handleLog(`Get hedge`)
            }
            let hedge = allPositions
              ? skipFutures
                ? { data: !!keys.hedge, status: StatusEnum.ok }
                : await this.exchange.getHedge()
              : null
            if (allPositions) {
              this.handleLog(`Got hedge: ${hedge?.data}`)
            }
            for (const symbol of [this.data.settings.pair].flat()) {
              const hedgeNull = hedge === null
              if (hedgeNull) {
                this.handleLog(`Get hedge ${symbol}`)
              }
              hedge = hedge ?? (await this.exchange.getHedge(symbol))
              if (hedgeNull) {
                this.handleLog(`Got hedge ${symbol}: ${hedge?.data}`)
              }
              if (hedge.status === StatusEnum.ok) {
                this.hedge = hedge.data
              }
              if (this.data.parentBotId) {
                let shouldCheck = true
                const findOther =
                  this.botType === BotType.dca
                    ? await dcaBotDb.readData({
                        parentBotId: this.data.parentBotId,
                        _id: { $ne: new Types.ObjectId(this.botId) },
                      })
                    : await comboBotDb.readData({
                        parentBotId: this.data.parentBotId,
                        _id: { $ne: new Types.ObjectId(this.botId) },
                      })
                // `readData` is a findOne: a miss returns `status: ok` with
                // `result: undefined`, so gating on the status alone is not
                // enough. A hedge child whose sibling leg has been deleted
                // dereferenced undefined here and threw out of loadData() —
                // and start() awaits loadData() OUTSIDE its try/catch, so the
                // rejection escaped the bot entirely: no `restartFinished` to
                // the parent (silent restart straggler), `locked` never
                // cleared, bot inert until the next restart, which failed
                // identically. Two orphaned combo bots were the recurring
                // "N-2" combo shortfall on every restart up to 2026-08-06.
                const other =
                  findOther.status === StatusEnum.ok
                    ? findOther.data.result
                    : undefined
                if (other) {
                  shouldCheck =
                    this.data.exchangeUUID === other.exchangeUUID &&
                    [this.data.settings.pair]
                      .flat()
                      .some((p) => [other.settings?.pair].flat().includes(p))
                }
                if (shouldCheck) {
                  if (!this.hedge) {
                    if (
                      (this.data as unknown as ClearDCABotSchema).deals
                        ?.active === 0
                    ) {
                      if (this.data.settings.strategy === StrategyEnum.long) {
                        this.handleErrors(
                          `Cannot start hedge bot when hedge mode not enabled.`,
                          'load data',
                          'check hedge',
                          false,
                        )
                        this.botService.callBotFunctionFromMeta(
                          this.data.parentBotId,
                          this.botType === BotType.dca
                            ? BotType.hedgeDca
                            : BotType.hedgeCombo,
                          'stopFromChildBot',
                          this.data.parentBotId,
                        )
                      }
                      this.endMethod(id)
                      return true
                    } else {
                      this.handleLog(
                        `Cannot start hedge bot when hedge mode not enabled. Bot ${this.data.parentBotId} is active`,
                      )
                    }
                  }
                }
              }
              if (skipFutures) {
                continue
              }
              positionsRequest =
                positionsRequest ??
                (await this.exchange.futures_getPositions(symbol))
              const requiredSide =
                //@ts-ignore
                this.data.settings.futuresStrategy === FuturesStrategyEnum.long
                  ? 'LONG'
                  : //@ts-ignore
                    this.data.settings.futuresStrategy ===
                      FuturesStrategyEnum.short
                    ? 'SHORT'
                    : this.data.settings.strategy === StrategyEnum.long
                      ? 'LONG'
                      : 'SHORT'
              const findPosition = (positionsRequest?.data ?? []).find(
                (p) =>
                  p.symbol === symbol &&
                  +p.positionAmt !== 0 &&
                  (this.hedge
                    ? requiredSide ===
                      (p.positionSide === 'BOTH'
                        ? +p.positionAmt > 0
                          ? 'LONG'
                          : 'SHORT'
                        : p.positionSide)
                    : true),
              )
              if (findPosition) {
                const activeMargin = findPosition.isolated
                  ? BotMarginTypeEnum.isolated
                  : BotMarginTypeEnum.cross
                const requiredMargin =
                  this.data.settings.marginType === BotMarginTypeEnum.cross
                    ? BotMarginTypeEnum.cross
                    : BotMarginTypeEnum.isolated
                if (
                  activeMargin !== requiredMargin &&
                  !paperExchanges.includes(this.data.exchange) &&
                  !this.kucoinFullFutures &&
                  !this.isKraken
                ) {
                  this.handleErrors(
                    `Cannot start when existing position not met bot settings. Margin type in active position is ${activeMargin}, but required is ${requiredMargin}. Symbol: ${symbol}`,
                    'load data',
                    'check positions',
                    false,
                  )
                  if (!skipFuturesError) {
                    this.endMethod(id)
                    return true
                  }
                }
                if (
                  +findPosition.leverage !== this.currentLeverage &&
                  !this.kucoinFullFutures
                ) {
                  this.handleErrors(
                    `Cannot start when existing position not met bot settings. Leverage in active position is ${findPosition.leverage}, but in settings ${this.currentLeverage}. Symbol: ${symbol}`,
                    'load data',
                    'check positions',
                    false,
                  )
                  if (!skipFuturesError) {
                    this.endMethod(id)
                    return true
                  }
                }
                if (
                  !this.hedge &&
                  (this.botType === BotType.dca ||
                    (this.botType === BotType.grid &&
                      //@ts-ignore
                      this.data.settings.futuresStrategy !==
                        FuturesStrategyEnum.neutral &&
                      !paperExchanges.includes(this.data.exchange)))
                ) {
                  const side =
                    findPosition.positionSide === 'BOTH'
                      ? +findPosition.positionAmt > 0
                        ? 'LONG'
                        : 'SHORT'
                      : findPosition.positionSide
                  if (side !== requiredSide) {
                    this.handleErrors(
                      `Cannot start when existing position not met bot settings. Side in active position is ${side}, but bot will open ${requiredSide}. Symbol: ${symbol}`,
                      'load data',
                      'check positions',
                      false,
                    )
                    if (!skipFuturesError) {
                      this.endMethod(id)
                      return true
                    }
                  }
                }
              }
              const zeroPosition = (positionsRequest?.data ?? []).find(
                (p) =>
                  p.symbol === symbol &&
                  (this.hedge
                    ? requiredSide ===
                      (p.positionSide === 'BOTH'
                        ? +p.positionAmt > 0
                          ? 'LONG'
                          : 'SHORT'
                        : p.positionSide)
                    : true),
              )
              const leverage =
                this.data.settings.marginType !== BotMarginTypeEnum.inherit
                  ? (this.data.settings.leverage ?? 1)
                  : 1
              const margin =
                this.data.settings.marginType === BotMarginTypeEnum.cross
                  ? MarginType.CROSSED
                  : MarginType.ISOLATED

              if (
                !zeroPosition ||
                +zeroPosition.leverage !== this.currentLeverage
              ) {
                const leverageResult = await this.exchange.changeLeverage({
                  symbol,
                  leverage,
                  side: !hedge?.data
                    ? PositionSide.BOTH
                    : requiredSide === 'LONG'
                      ? PositionSide.LONG
                      : PositionSide.SHORT,
                })
                if (leverageResult.status === StatusEnum.notok) {
                  this.handleErrors(
                    `Cannot set leverage for ${symbol}: ${leverageResult.reason}`,
                    'load data',
                  )
                } else {
                  this.handleLog(`Set leverage ${leverage} for ${symbol}`)
                }
              } else {
                this.handleLog(
                  `No need to change leverage ${leverage} for ${symbol}`,
                )
              }

              if (
                !zeroPosition ||
                (zeroPosition.isolated && margin === MarginType.CROSSED) ||
                (!zeroPosition.isolated && margin === MarginType.ISOLATED)
              ) {
                const marginResult = await this.exchange.changeMargin({
                  symbol,
                  margin,
                  leverage,
                })
                if (
                  marginResult.status === StatusEnum.notok &&
                  marginResult.reason.indexOf('No need to change margin') ===
                    -1 &&
                  marginResult.reason.indexOf('Multi-Assets') === -1
                ) {
                  this.handleErrors(
                    `Cannot set margin for ${symbol}: ${marginResult.reason}`,
                    'load data',
                  )
                } else {
                  this.handleLog(`Set margin ${margin} for ${symbol}`)
                }
              } else {
                this.handleLog(
                  `No need to change margin ${margin} for ${symbol}`,
                )
              }
            }
          }
        } else {
          this.handleErrors('User not found', 'loadData()')
        }
      }
    } else {
      this.handleErrors('No DB instance found', 'loadData()')
    }
    this.endMethod(id)
    this.handleLog('Load data end')
  }

  /**
   * Read orders from {@link MainBot#ordersDb}<br />
   *
   * @returns {Promise<ClearOrderSchema[]>} Array of orders
   */

  async _loadOrders(
    query?: QueryFilter<ClearOrderSchema>,
    skipRedis = false,
  ): Promise<ClearOrderSchema[]> {
    const id = this.startMethod('loadOrders main')
    if (this.serviceRestart && !skipRedis) {
      const orders = await this.getFromRedis<Order[]>('orders')
      if (orders && orders.length) {
        this.handleLog(`Found in redis ${orders.length} orders`)
        this.endMethod(id)
        return orders.map((o) => ({ ...o, _id: o._id }))
      }
    }
    this.handleLog('Load orders start')
    const orderData = await this.ordersDb.readData(
      query ?? {
        botId: this.botId,
        status: { $nin: ['CANCELED', 'EXPIRED'] },
        typeOrder: { $nin: [TypeOrderEnum.liquidation, TypeOrderEnum.br] },
      },
      undefined,
      {},
      true,
      true,
    )
    if (orderData.status === StatusEnum.notok) {
      this.handleErrors(orderData.reason, 'loadOrders()', 'Load orders data')
      this.endMethod(id)
      return []
    }
    if (orderData.data.count > 0) {
      this.handleLog(`Found ${orderData.data.count} orders`)
      this.endMethod(id)
      return orderData.data.result
    }
    this.handleLog('No orders found')
    this.handleLog('Load orders end')
    this.endMethod(id)
    return []
  }

  /**
   * Get info about current bot pair from exchange where bot supposted to work<br />
   *
   * Using {@link MainBot#exchange}<br />
   *
   * Set received information to {@link MainBot#exchangeInfo}
   */

  async fillExchangeInfo(pair?: string | string[]): Promise<void> {
    this.handleLog('Fill exchange info start')
    const pairs = pair ? [pair].flat() : [...this.pairs.values()]
    for (const p of pairs) {
      const d = await this.getExchangeInfo(
        p,
        !(this.serviceRestart && !this.secondRestart) || this.reload,
      )
      if (d) {
        this.precisions.set(p, d.priceAssetPrecision)
        this.basePrecisions.set(p, await this.baseAssetPrecision(p))
      }
    }
    this.handleLog('Fill exchange info end')
  }

  /**
   * Get user fee for current bot pair<br />
   *
   * Using {@link MainBot#exchange}<br />
   *
   *Set received information to {@link MainBot#userFees}
   */

  async getUserFees(pair?: string | string[]): Promise<void> {
    this.handleLog('Get user fee start')
    const pairs = pair ? [pair].flat() : [...this.pairs.values()]
    for (const p of pairs) {
      await this.getUserFee(p, !(this.serviceRestart && !this.secondRestart))
    }
    this.handleLog('Get user fee end')
  }

  async getUser(force = false) {
    return await this.sharedData.getUserSchema(this.userId, this.botId, force)
  }

  async getBalancesFromExchange() {
    if (!this.data || !this.exchange) {
      return null
    }
    const result = await this.exchange.getBalance()
    if (result.status === StatusEnum.notok) {
      return result
    }
    const bnfcr = await this.isBNFCR()
    if (bnfcr) {
      const bnfcrVal = result.data.find((r) => r.asset === 'BNFCR')
      if (bnfcrVal) {
        result.data = result.data.map((r) => {
          if (r.asset === 'USDT' || r.asset === 'USDC') {
            return {
              asset: 'USDT',
              free: bnfcrVal.free,
              locked: bnfcrVal.locked,
            }
          }
          return r
        })
      }
    }
    return result
  }

  /**
   * Get user balances for current pair<br />
   *
   * Using {@link MainBot#exchange}<br />
   *
   * Set result in {@link MainBot#userFees}
   */

  async checkAssets(
    returnData = false,
    direct = false,
  ): Promise<Map<string, FreeAsset[0]> | undefined> {
    this.handleLog('Check assets start')
    const asset: Map<string, FreeAsset[0]> = new Map()
    let finish = false
    const bnfcr = await this.isBNFCR()
    if (this.exchange) {
      const user = await this.getUser()
      const linkedExchange: string | undefined = user?.exchanges.find(
        (ue) => ue.uuid === this.data?.exchangeUUID,
      )?.linkedTo
      if (
        !direct &&
        this.data?.exchange !== ExchangeEnum.ftx &&
        this.data?.exchange !== ExchangeEnum.coinbase
      ) {
        const balancesFromDb = await this.balancesDb.readData<{
          asset: string
          free: number
          locked: number
        }>(
          {
            userId: this.userId,
            exchange: this.data?.exchange,
            exchangeUUID: !!linkedExchange
              ? linkedExchange
              : this.data?.exchangeUUID,
          },
          { asset: 1, free: 1, locked: 1 },
          {},
          true,
        )
        if (balancesFromDb.status === StatusEnum.ok) {
          const b = balancesFromDb?.data?.result ?? []
          const find: string[] = []
          for (const p of this.pairs) {
            const ed = await this.getExchangeInfo(p)
            const assets: string[] = []
            if (ed) {
              assets.push(ed.baseAsset.name)
              assets.push(ed.quoteAsset.name)
            }
            if (bnfcr) {
              assets.push('BNFCR')
            }
            const findAssets = b.filter((balance) =>
              assets.includes(balance.asset),
            )
            if (findAssets.length === 2) {
              find.push(p)
            }
            findAssets.forEach((balance) => {
              asset.set(balance.asset, {
                asset: balance.asset,
                free: balance.free,
                locked: balance.locked,
              })
            })
          }

          if (find.length === this.pairs.size) {
            finish = true
          }
        } else if (balancesFromDb.status === StatusEnum.notok) {
          this.handleErrors(
            `Cannot read balances from db. ${balancesFromDb.reason}. Fallback to get from exchange`,
            'checkAssets()',
            'read balances from db',
            false,
            false,
            false,
          )
        }
      }
      if (!finish) {
        // Hard-auth short-circuit. An expired / revoked key is a PERMANENT
        // account condition, but `BotStatusEnum.error` is a soft status the
        // price-update path clears via `restoreFromRangeOrError()`, so nothing
        // gated the next attempt: one bot re-asked a dead Bybit key ~2/min for
        // 2.2h+ while sitting at `status: 'open'`. Serve the exchange's OWN
        // last rejection from a short Redis cooldown instead of calling the
        // venue again. Downstream is unchanged — callers already handle the
        // empty/undefined result an auth failure produces today.
        const authUUID = `${this.data?.exchangeUUID ?? ''}`
        if (authUUID) {
          const cooldown = await AuthFailureGuard.check(authUUID)
          if (cooldown.failed && cooldown.reason) {
            // debug, not info: the actionable error is already reported on
            // every re-probe, so a per-tick line here would just move the
            // flood from the error log to the out log.
            this.handleDebug(
              `Balance check skipped, exchange auth cooldown until ${new Date(
                cooldown.until ?? 0,
              ).toISOString()}: ${cooldown.reason}`,
            )
            if (returnData) {
              return asset
            }
            return
          }
        }
        const balances = await this.exchange.getBalance()
        this.handleDebug('Get balance')
        if (balances.status === StatusEnum.notok) {
          // Open/widen the cooldown only for a real, venue-returned hard-auth
          // rejection. Everything else stays exactly as transient as it is now.
          if (authUUID && isHardAuthFailure(`${balances.reason}`)) {
            await AuthFailureGuard.record({
              exchangeUUID: authUUID,
              reason: `${balances.reason}`,
            })
          }
          this.handleErrors(balances.reason, 'checkAssets()', 'getBalance')
          if (returnData) {
            return asset
          }
          return
        }
        for (const p of this.pairs) {
          const ed = await this.getExchangeInfo(p)
          const assets: string[] = []
          if (ed) {
            assets.push(ed.baseAsset.name)
            assets.push(ed.quoteAsset.name)
          }
          if (bnfcr) {
            assets.push('BNFCR')
          }
          ;(balances.data ?? [])
            .filter((balance) => assets.includes(balance.asset))
            .forEach((balance) => {
              asset.set(balance.asset, {
                asset: balance.asset,
                free: balance.free,
                locked: balance.locked,
              })
            })
        }
      }
    }
    this.handleDebug('Check assets end')
    if (bnfcr) {
      this.handleDebug(`Found BNFCR asset, set USDT and USDC amounts`)
      const bnfcrVal = asset.get('BNFCR')
      if (bnfcrVal) {
        asset.set('USDT', bnfcrVal)
        asset.set('USDC', bnfcrVal)
      }
    }

    return asset
  }

  getLastStreamData(symbol: string) {
    return this.lastStreamData.get(symbol)
  }

  setLastStreamData(symbol: string, data: StreamData) {
    this.lastStreamData.set(symbol, data)
  }

  async getLastUsdData(symbol: string) {
    return this.sharedData.usdCache.getData(
      `${removePaperFormExchangeName(
        this.data?.exchange ?? ExchangeEnum.binance,
      )}${symbol}`,
      this.botId,
    )
  }

  async unsubscribeFromLastStreamData(symbol: string) {
    return this.sharedData.streamData.unsubscribeFrom(
      `${removePaperFormExchangeName(
        this.data?.exchange ?? ExchangeEnum.binance,
      )}${symbol}`,
      this.botId,
    )
  }

  async setLastUsdData(symbol: string, data: StreamData) {
    return this.sharedData.usdCache.setData(
      `${removePaperFormExchangeName(
        this.data?.exchange ?? ExchangeEnum.binance,
      )}${symbol}`,
      this.botId,
      data,
    )
  }

  async unsubscribeFromLastUsdData(symbol: string) {
    return this.sharedData.usdCache.unsubscribeFrom(
      `${removePaperFormExchangeName(
        this.data?.exchange ?? ExchangeEnum.binance,
      )}${symbol}`,
      this.botId,
    )
  }

  /**
   * Get latest price for current bot pair<br />
   *
   * If set {@link MainBot#lastStreamPrice} return it, if not - make request using {@link MainBot#exchange}<br />
   * @returns {Promise<number>} Latest price or 0 if catch an error
   */

  async getLatestPrice(symbol: string): Promise<number> {
    const lastStreamData = this.getLastStreamData(symbol)
    const lastStreamPrice = lastStreamData?.price
    const lastStreamTime = lastStreamData?.time
    if (
      lastStreamPrice &&
      lastStreamPrice !== 0 &&
      +new Date() - (lastStreamTime ?? 0) < this.priceTimeout
    ) {
      return lastStreamPrice
    }
    if (this.exchange) {
      const start = +new Date()
      const result = await this.exchange.latestPrice(symbol || '', true)
      const end = +new Date()
      if (end - start > 20 * 1000) {
        this.handleDebug(`Get latest price for ${symbol} took ${end - start}ms`)
      }
      if (result.status === StatusEnum.ok) {
        const price = result.data
        this.setLastStreamData(symbol, { price, time: +new Date() })
        return price
      }
      this.handleErrors(
        result.reason,
        'getLatestPrice()',
        'Get latest price',
        false,
        false,
        false,
      )
    }
    return 0
  }

  /**
   * Get active orders for bot pair on exchange where bot supposted to work<br />
   *
   * On error returns 0 — the permissive value, so the max-orders check in the
   * caller does not block a deal because of a failed lookup.
   */

  async getActiveOrders(symbol: string): Promise<number> {
    if (this.data?.paperContext) {
      return 0
    }
    if (this.exchange && this.data) {
      // Same hard-auth short-circuit as `checkAssets()` above. Gating only the
      // balance call was not enough: the combo open-a-deal path calls this
      // once per tick, so a dead key kept re-asking the venue every single
      // minute (236 rejections in 3.9h on one bot on 2026-08-10) while the
      // balance path was already correctly backed off to hourly. Serve the
      // exchange's OWN last rejection from the shared cooldown instead.
      const authUUID = `${this.data.exchangeUUID ?? ''}`
      if (authUUID) {
        const cooldown = await AuthFailureGuard.check(authUUID)
        if (cooldown.failed && cooldown.reason) {
          // debug, not warn: the re-probe still reports normally, so a
          // per-tick line here would just move the flood to the out log.
          this.handleDebug(
            `Active orders check skipped, exchange auth cooldown until ${new Date(
              cooldown.until ?? 0,
            ).toISOString()}: ${cooldown.reason}`,
          )
          // 0 = exactly what the error path below already returns, so
          // downstream behaviour is unchanged by the suppression.
          return 0
        }
      }
      const result = await this.exchange.getAllOpenOrders(symbol)
      if (result.status === StatusEnum.ok) {
        return result.data
      }
      // Open/widen the cooldown only for a real, venue-returned hard-auth
      // rejection. Everything else stays exactly as transient as it is now.
      if (authUUID && isHardAuthFailure(`${result.reason}`)) {
        await AuthFailureGuard.record({
          exchangeUUID: authUUID,
          reason: `${result.reason}`,
        })
      }
      this.handleErrors(
        `Cannot get active orders: ${result.reason}`,
        'getActiveOrders()',
        'Get active orders',
        false,
        false,
        false,
      )
    }
    return 0
  }

  /**
   * Base asset precision according to exchange requirments
   *
   * @returns {number} base asset precision
   */

  async baseAssetPrecision(symbol: string): Promise<number> {
    const data = await this.getExchangeInfo(symbol)
    if (!data) {
      return 8
    }
    let use = `${data.baseAsset.step}`
    if (`${data.baseAsset.step}`.indexOf('e-') !== -1) {
      const split = `${data.baseAsset.step}`.split('e-')[1]
      use = Number(data.baseAsset.step).toFixed(parseFloat(split))
    }
    if (use.indexOf('1') === -1) {
      const dec = use.replace('0.', '')
      const numbers = dec.replace(/0/g, '')
      const place = dec.indexOf(numbers)
      if (place <= 1) {
        return place
      }
      use = `0.${'0'.repeat(place)}1`
    }
    return use.indexOf('1') === 0 ? 0 : use.replace('0.', '').indexOf('1') + 1
  }

  /**
   * Find difference between old grids and ne grids<br />
   *
   * Compare 2 arrays, and return what's new and what's missing in new array
   *
   * @return {findDiffReturn} cancel and new array
   */

  findDiff(
    newGrids: Grid[] | null,
    oldGrids: Grid[] | null,
    ignoreQty = false,
  ): findDiffReturn {
    if (newGrids) {
      if (oldGrids) {
        /** new grids */
        const newInGrids: Grid[] = newGrids.filter(
          (newGrid) =>
            !oldGrids.find(
              (oldGrid) =>
                newGrid.price === oldGrid.price &&
                newGrid.side === oldGrid.side &&
                (ignoreQty ? true : newGrid.qty === oldGrid.qty) &&
                newGrid.dealId === oldGrid.dealId &&
                newGrid.minigridId === oldGrid.minigridId,
            ),
        )
        /** cancled grids */
        const cancel: Grid[] = oldGrids.filter(
          (oldGrid) =>
            !newGrids.find(
              (newGrid) =>
                newGrid.price === oldGrid.price &&
                newGrid.side === oldGrid.side &&
                (ignoreQty ? true : newGrid.qty === oldGrid.qty) &&
                newGrid.dealId === oldGrid.dealId &&
                newGrid.minigridId === oldGrid.minigridId,
            ),
        )
        return {
          cancel,
          new: newInGrids,
        }
      }
      return {
        cancel: [],
        new: newGrids,
      }
    }
    return {
      cancel: [],
      new: [],
    }
  }
  /** Get order */

  async getOrder(id: string, symbol: string, fromCache: boolean) {
    const _id = this.startMethod('getOrder')
    try {
      if (fromCache && this.redisDb && this.redisDb.isReady) {
        const order = await this.redisDb.hGet('orders', id)
        if (order) {
          this.handleLog(`Get order from redis ${id}`)
          const parsedOrder = await this.convertExecutionReportToOrder(
            JSON.parse(order) as ExecutionReport,
          )
          if (parsedOrder) {
            this.endMethod(_id)
            return { status: StatusEnum.ok, data: parsedOrder, reason: null }
          }
          this.handleLog(`Cannot parse order from redis ${id}`)
        }
      }
    } catch (e) {
      this.handleErrors(
        `Cannot get order from redis ${e}`,
        'getOrder',
        '',
        false,
        false,
        false,
      )
    }
    if (this.exchange && this.data) {
      if (
        this.data.exchange === ExchangeEnum.coinbase ||
        this.kucoinFullFutures ||
        this.data.exchange === ExchangeEnum.kraken
      ) {
        const local = this.getOrderFromMap(id)
        if (local) {
          if (local.orderId === noExchangeOrderId) {
            this.endMethod(_id)
            return this.exchange.returnBad()(
              new Error(orderNeverReachedExchange),
            )
          }
          id = `${local.orderId}`
        }
      }
      const result = await this.exchange.getOrder({
        symbol,
        newClientOrderId: id,
      })
      if (!result.data) {
        this.endMethod(_id)
        return result
      }
      if (this.kucoinFullFutures) {
        const cummulativeQuoteQty =
          +result.data.executedQty * +result.data.price
        if (!isNaN(cummulativeQuoteQty) && isFinite(cummulativeQuoteQty)) {
          result.data.cummulativeQuoteQty = `${cummulativeQuoteQty}`
        }
      }
      result.data.executedQty = await this.convertOrderExecutedQty(result.data)
      if (
        this.kucoinFutures &&
        result.data.cummulativeQuoteQty &&
        +result.data.cummulativeQuoteQty &&
        !isNaN(+result.data.cummulativeQuoteQty) &&
        isFinite(+result.data.cummulativeQuoteQty) &&
        result.data.executedQty &&
        +result.data.executedQty &&
        !isNaN(+result.data.executedQty) &&
        isFinite(+result.data.executedQty)
      ) {
        result.data.price = `${
          +result.data.cummulativeQuoteQty / +result.data.executedQty
        }`
      }
      if (result.data.status === 'CANCELED' && +result.data.executedQty !== 0) {
        result.data.status = 'FILLED'
      }
      this.endMethod(_id)
      return result
    }
  }
  /**
   * Update order information previously return as 'unknown order' error <br />
   *
   * Get order by id from exchange using {@link MainBot#exchange}<br />
   *
   * Update order information in {@link MainBot#orders} and orders collection in DB, send update via {@link MainBot#ioUpdate}<br />
   *
   * @param {string} id id of the order that needed to find
   * @returns {Promise<null | Order>} null or order
   */

  async _handleUnknownOrder(id: string, symbol: string): Promise<null | Order> {
    const origId = id
    if (this.data && this.exchange && this.orders) {
      this.handleLog(`Send request to unknow order ${id}`)
      const getCount = this.canceledMap.get(id) ?? 0
      this.canceledMap.set(id, getCount + 1)
      const byId =
        this.data?.exchange === ExchangeEnum.coinbase ||
        this.data?.exchange === ExchangeEnum.kraken ||
        this.kucoinFullFutures
      if ((this.canceledMap.get(id) ?? 0) > unknownOrderMaxAttempts) {
        this.canceledMap.delete(id)
        const get = this.getOrderFromMap(id)
        let find = get && get.status === 'NEW' ? get : undefined
        if (find && this.orders) {
          this.handleLog(
            `Order not found after 5 attempts 2000 ms, order ${id} status set to CANCELED`,
          )
          find.status = 'CANCELED'
          this.deleteOrder(find.clientOrderId)
          this.updateOrderOnDb(find)
          return find
        }
        if (!find) {
          this.handleLog(`Order not found in handle unknow order ${id}`)
          find = (await this.ordersDb.readData({ clientOrderId: id })).data
            ?.result
          if (find) {
            this.handleLog(
              `Order found in DB in handle unknow order ${id} set to CANCELED`,
            )
            find.status = 'CANCELED'
            this.deleteOrder(find.clientOrderId)
            this.updateOrderOnDb(find)
            return find
          }
        }

        return null
      }

      // The order as we still hold it. Its `orderId` is the only thing that
      // says whether the order ever reached the venue, and that is worth
      // knowing on EVERY venue — not just the `byId` ones — so the lookup is
      // hoisted out of the branch below. The in-memory map is free; the DB
      // fallback stays inside `byId`, which is the only path that actually
      // needs `orderId` to build the request.
      let local = this.getOrderFromMap(id)
      let neverReachedExchange = false
      if (byId) {
        if (!local) {
          local = (await this.ordersDb.readData({ clientOrderId: id })).data
            ?.result
        }
        if (local) {
          neverReachedExchange = local.orderId === noExchangeOrderId
          id = `${local.orderId}`
        }
      }
      const request = neverReachedExchange
        ? this.exchange.returnBad()(new Error(orderNeverReachedExchange))
        : await this.exchange.getOrder({
            symbol,
            newClientOrderId: id,
          })
      if (request.status === StatusEnum.notok) {
        this.handleLog(
          `${request.reason}, handleUnknownOrder(), Send get order request ${origId}, ${symbol}, ${id}`,
        )

        // An order still carrying the `-1` placeholder never got an exchange
        // order id, so the venue answering "I do not know this order" is the
        // FINAL answer, not a race we can wait out — re-asking four more times
        // over ~14s cannot change it. Bug #369: a krakenUsdm combo bot held 37
        // such grid orders (all rejected days earlier for insufficient funds,
        // left at status NEW), and reconciling them on restart cost 222 Kraken
        // round trips and 11 minutes of connector ERRORs where 37 would do.
        //
        // Deliberately narrow on BOTH conditions:
        //  - `isDefinitiveOrderNotFound` (the venue said "no such order"), so a
        //    timeout / rate-limit / auth failure still gets the full ladder —
        //    the "transient failure rendered as a definitive negative" mistake
        //    that helper exists to prevent.
        //  - `orderId === '-1'`, so an order that DOES hold an exchange id
        //    keeps retrying, which is what covers propagation lag.
        // The first round trip is deliberately kept: on a venue queried by
        // client order id the order may exist there under that id even though
        // we never recorded the response, and that call is the only thing that
        // would find it. This drops the 5 redundant retries, not the lookup.
        if (
          isDefinitiveOrderNotFound(request) &&
          local?.orderId === noExchangeOrderId
        ) {
          this.canceledMap.set(origId, unknownOrderMaxAttempts)
          return this._handleUnknownOrder(origId, symbol)
        }

        await sleep(1000 * (getCount + 1))
        return this._handleUnknownOrder(origId, symbol)
      }
      if (request.status === StatusEnum.ok) {
        this.handleLog(`Real order ${origId} status: ${request.data.status}`)
        this.canceledMap.delete(origId)
        let find = this.getOrderFromMap(origId)
        if (!find) {
          find = (await this.ordersDb.readData({ clientOrderId: id })).data
            ?.result
        }
        if (find) {
          if (find.status !== request.data.status) {
            find.status = request.data.status
            find.updateTime = request.data.updateTime
            find.executedQty = await this.convertOrderExecutedQty(find)
            this.ordersDb
              .updateData({ clientOrderId: origId }, find)
              .then((res) => {
                if (res.status === StatusEnum.notok) {
                  this.handleErrors(
                    res.reason,
                    'handleUnknownOrder()',
                    'Save regular order',
                    false,
                    false,
                    false,
                  )
                }
              })
            this.emit('bot update', find)
            this.deleteOrder(find.clientOrderId)
            if (request.data.status !== 'CANCELED') {
              this.setOrder(find)
            }

            this.handleLog(
              `Save order ${find.clientOrderId} with status ${find.status}`,
            )
            if (request.data.status === 'FILLED') {
              return find
            }
          } else {
            this.handleLog(
              `Order ${origId} already processed while request was in progress`,
            )
            if (request.data.status === 'FILLED') {
              return find
            }
          }
        }
      }
    }
    return null
  }

  /**
   * Check is given order newer than saved one<br />
   *
   * Check by time<br />
   *
   * If time is the same - by side and price <br />
   *
   * If given order is newer - set it to {@link MainBot#lastOrder}
   *
   * @param {number} time Order update time
   * @param {number} price Order price
   * @param {OrderSideEnum} side Order side
   * @return {boolean} if given order is newer
   */

  isLastOrder(time: number, price: number, side: OrderSideEnum): boolean {
    if (this.lastOrder.price === 0) {
      this.lastOrder = {
        time,
        price,
        side,
      }
      return true
    }
    if (side === this.lastOrder.side && side === OrderSideEnum.sell) {
      if (price > this.lastOrder.price) {
        this.lastOrder = {
          time,
          price,
          side,
        }
        return true
      }
    } else if (side === this.lastOrder.side && side === OrderSideEnum.buy) {
      if (price < this.lastOrder.price) {
        this.lastOrder = {
          time,
          price,
          side,
        }
        return true
      }
    } else if (side !== this.lastOrder.side) {
      this.lastOrder = {
        time,
        price,
        side,
      }
      return true
    }
    return false
  }

  /**
   * Check new order in array of placed/pending orders
   *
   * @param {Grid} n order to find
   * @returns {boolean} Indicates order exist or not
   */

  isOrderExist(n: Grid, type: TypeOrderEnum): boolean {
    if (this.orders && this.orders.size > 0) {
      return Boolean(
        this.getOrdersByStatusAndDealId({
          status: this.orderStatuses,
        }).find(
          (o) =>
            parseFloat(o.price) === n.price &&
            o.side === n.side &&
            parseFloat(o.origQty) === n.qty &&
            o.typeOrder === type,
        ),
      )
    }
    return false
  }

  /**
   * Get order status from stream msg
   *
   * @param {ExecutionReport}
   */

  getOrderStatus(msg: ExecutionReport) {
    return msg.eventType === 'executionReport'
      ? msg.orderStatus === 'CANCELED'
        ? (msg.originalClientOrderId as string)
        : msg.newClientOrderId
      : msg.clientOrderId
  }

  async convertExecutionReportToOrder(
    _msg: ExecutionReport,
    process?: boolean,
  ): Promise<Order | null> {
    const msg = this.convertCoinbaseOrder(_msg)
    if (this.hyperliquid && this.data?.exchange) {
      const pair = await this.sharedData.getPairByCode(
        this.data.exchange,
        msg.symbol,
      )
      if (pair) {
        msg.symbol = pair
      }
    }
    const ed = await this.getExchangeInfo(msg.symbol)
    const orderId = this.getOrderStatus(msg)
    const base = parseFloat(msg.totalTradeQuantity)
    const updateTime = msg.orderTime || msg.eventTime || new Date().getTime()
    const quote =
      msg.eventType === 'executionReport'
        ? parseFloat(msg.totalQuoteTradeQuantity)
        : 0
    let price =
      msg.eventType === 'executionReport'
        ? quote !== 0 && base !== 0
          ? this.math.round(quote / base, ed?.priceAssetPrecision)
          : parseFloat(msg.price)
        : +msg.averagePrice || +msg.price
    price = isNaN(price) ? 0 : price
    price = price || +msg.price
    if (msg.liquidation && this.futures) {
      const liquidationOrder: Order = {
        symbol: msg.symbol,
        orderId: `${msg.orderId}` || `${this.data?.exchange}_liq_${v4()}`,
        clientOrderId: orderId || `${this.data?.exchange}_liq_${v4()}`,
        updateTime: msg.eventTime,
        price: this.kucoinFullFutures ? msg.price : `${price}`,
        origQty: '0',
        executedQty: '0',
        status: 'FILLED',
        type: 'LIMIT',
        side: msg.side,
        botId: this.botId,
        exchange: this.data?.exchange ?? ExchangeEnum.binanceUsdm,
        exchangeUUID: this.data?.exchangeUUID ?? '',
        typeOrder: TypeOrderEnum.liquidation,
        userId: this.userId,
        baseAsset: ed?.baseAsset.name ?? '',
        quoteAsset: ed?.quoteAsset.name ?? '',
        origPrice: `${price}`,
        reduceOnly: true,
        positionSide: this.hedge
          ? msg.side === 'SELL'
            ? PositionSide.LONG
            : PositionSide.SHORT
          : PositionSide.BOTH,
        liquidation: true,
      }
      return liquidationOrder
    }
    let find = this.getOrderFromMap(orderId)
    if (!find) {
      const findInDb = await this.ordersDb.readData({
        clientOrderId: orderId,
        botId: this.botId,
        userId: this.userId,
      })
      if (findInDb.status === StatusEnum.ok) {
        if (!findInDb.data.result) {
          this.handleDebug(`Order ${orderId} not found in DB`)
        } else {
          find = {
            ...findInDb.data.result,
            _id: `${findInDb.data.result._id}`,
          }
        }
      }
      if (findInDb.status === StatusEnum.notok) {
        this.handleErrors(
          `Cannot get order from DB: ${findInDb.reason}`,
          'process orders',
          'get order from db',
          false,
          false,
          false,
        )
      }
    }
    if (!find && this.krakenSpot && msg.orderId) {
      // Kraken spot has no cl_ord_id: the user-stream execution report carries
      // the Kraken txid as its clientOrderId, so the lookups above (keyed by our
      // "D-…"/"GRID-…" client id) never match and the fill was silently dropped
      // (forum #4890). Fall back to the exchange orderId (txid) — which we DO
      // store on the local order — so resting-limit fills register in real time.
      const byOrderId =
        this.allOrders.find((o) => o.orderId && o.orderId === msg.orderId) ||
        undefined
      if (byOrderId) {
        find = byOrderId
      } else {
        const findByOrderId = await this.ordersDb.readData({
          orderId: msg.orderId,
          botId: this.botId,
          userId: this.userId,
        })
        if (
          findByOrderId.status === StatusEnum.ok &&
          findByOrderId.data.result
        ) {
          find = {
            ...findByOrderId.data.result,
            _id: `${findByOrderId.data.result._id}`,
          }
        }
      }
    }
    if (!find) {
      return null
    }
    if (
      process &&
      find.status === 'FILLED' &&
      msg.orderStatus !== 'FILLED' &&
      (([
        ExchangeEnum.binance,
        ExchangeEnum.binanceUsdm,
        ExchangeEnum.binanceCoinm,
        ExchangeEnum.binanceUS,
      ].includes(find.exchange) &&
        find.type === 'MARKET') ||
        [
          ExchangeEnum.bitget,
          ExchangeEnum.bitgetCoinm,
          ExchangeEnum.bitgetUsdm,
        ].includes(find.exchange))
    ) {
      this.handleDebug(`Order ${orderId} already filled`)
      return null
    }
    const order = { ...find }
    // The venue just told us about this order, so it demonstrably exists and
    // any decision to stop polling it is void. This is the push half of the
    // quarantine invariant, and it has to be explicit: `{ ...find }` copies the
    // whole order, so without this a quarantined order that started filling
    // would keep its flag and stay unpolled while it was visibly alive.
    // (The pull half is free — `mergeCommonOrderWithOrder` rebuilds from the
    // exchange payload and never re-adds `quarantine`.)
    delete order.quarantine
    if (
      msg.orderStatus === 'CANCELED' ||
      msg.orderStatus === 'FILLED' ||
      msg.orderStatus === 'PARTIALLY_FILLED' ||
      msg.orderStatus === 'NEW' ||
      msg.orderStatus === 'EXPIRED'
    ) {
      order.status = msg.orderStatus
    }
    order.orderId = msg.orderId
    order.executedQty = this.coinm
      ? order.exchange === ExchangeEnum.bybitCoinm || this.isBitget
        ? msg.totalTradeQuantity
        : `${
            (+msg.totalTradeQuantity * (ed?.quoteAsset.minAmount ?? 1)) / price
          }`
      : (this.okx || this.kucoinFutures) && this.futures
        ? `${this.math.round(
            +msg.totalTradeQuantity /
              (await this.getOKXDenominator(msg.symbol)),
            await this.baseAssetPrecision(order.symbol),
          )}`
        : msg.totalTradeQuantity
    order.cummulativeQuoteQty = this.kucoinFutures
      ? `${+msg.price * +order.executedQty}`
      : msg.eventType === 'executionReport'
        ? msg.totalQuoteTradeQuantity
        : `${(+msg.averagePrice || +msg.price) * +order.executedQty}`
    if (this.hyperliquid) {
      order.type = find.type
    }
    if (`${price}` !== order.price && price !== 0) {
      order.type === OrderTypeEnum.market
    }
    order.updateTime = updateTime
    if (price !== 0) {
      order.price = `${price}`
    }
    return order
  }

  async mergeCommonOrderWithOrder(co: CommonOrder, o: Order): Promise<Order> {
    const quote =
      co.cummulativeQuoteQty &&
      !((this.okx || this.kucoinFutures) && this.futures)
        ? +co.cummulativeQuoteQty
        : +co.price * +co.executedQty
    const base = +co.executedQty
    let price = this.coinm
      ? +(o.avgPrice || '0') || +o.price
      : +quote !== 0 && base !== 0
        ? this.math.round(
            quote / base,
            (await this.getExchangeInfo(o.symbol))?.priceAssetPrecision,
          )
        : +o.price
    price = isNaN(price) ? 0 : price
    return {
      ...co,
      _id: o._id,
      // Our local order id is authoritative — never let the exchange's echoed
      // clientOrderId win. For most exchanges co.clientOrderId === o.clientOrderId
      // so this is a no-op, but on Kraken spot the connector resolves orders by
      // txid (there's no cl_ord_id), so co.clientOrderId is the txid; keeping it
      // would rekey/duplicate the order in the map and corrupt the DB row on the
      // reconcile path (forum #4890).
      clientOrderId: o.clientOrderId,
      exchange: o.exchange,
      exchangeUUID: o.exchangeUUID,
      typeOrder: o.typeOrder,
      botId: o.botId,
      userId: o.userId,
      dealId: o.dealId,
      baseAsset: o.baseAsset,
      quoteAsset: o.quoteAsset,
      origPrice: o.origPrice,
      price: `${price}` || o.price,
      tpSlTarget: o.tpSlTarget,
      minigridId: o.minigridId,
      minigridBudget: o.minigridBudget,
      dcaLevel: o.dcaLevel,
      addFundsId: o.addFundsId,
      liquidation: o.liquidation,
    }
  }

  getOrderId(prefix: string) {
    if (this.hyperliquid) {
      return '0x' + crypto.randomBytes(16).toString('hex')
    }
    const maxLength = this.okx || this.mexc ? 32 : 36
    const exchangePrefix =
      this.okx ||
      this.data?.exchange === ExchangeEnum.binance ||
      this.data?.exchange === ExchangeEnum.binanceUsdm ||
      this.data?.exchange === ExchangeEnum.binanceCoinm
        ? this.brokerCode
        : ''
    let idString = `${exchangePrefix}${prefix}-${id(
      maxLength - exchangePrefix.length - (prefix.length + 1) - 1,
    )}`
    if (this.okx) {
      idString = idString.replace(/-/g, '')
      idString =
        idString.length < maxLength
          ? `${idString}${id(maxLength - idString.length)}`
          : idString
    }

    return idString
  }

  async calculateAbstractPosition(
    order: { qty: number; price: number; side: Order['side']; symbol: string },
    position: PositionInBot,
  ) {
    const current = { ...position }
    const { qty, price, side, symbol } = order
    const ed = await this.getExchangeInfo(symbol)
    const baseAssetPricision = await this.baseAssetPrecision(symbol)
    if (!ed) {
      this.handleErrors(
        `Cannot find exchange info for ${symbol}`,
        'calculate position',
      )
    }
    const orderCoinm = this.math.round(
      (qty * price) / (ed?.quoteAsset.minAmount ?? 1),
      0,
    )
    const positionCoinm = this.math.round(
      (current.qty * current.price) / (ed?.quoteAsset.minAmount ?? 1),
      0,
    )
    if (
      (current.side === PositionSide.LONG && side === 'BUY') ||
      (current.side === PositionSide.SHORT && side === 'SELL')
    ) {
      const totalQty =
        this.coinm && !this.isBitget
          ? positionCoinm + orderCoinm
          : qty + current.qty
      current.price =
        this.coinm && !this.isBitget
          ? this.math.round(
              (positionCoinm * current.price + orderCoinm * price) / totalQty,
              ed?.priceAssetPrecision,
            )
          : this.math.round(
              (current.qty * current.price + price * qty) / totalQty,
              ed?.priceAssetPrecision,
            )
      current.qty =
        this.coinm && !this.isBitget
          ? (totalQty * (ed?.quoteAsset.minAmount ?? 1)) / current.price
          : totalQty
    } else {
      const totalQty =
        this.coinm && !this.isBitget
          ? positionCoinm - orderCoinm
          : current.qty - qty
      if (
        Math.abs(totalQty) <= Number.EPSILON ||
        (this.coinm && !this.isBitget && totalQty < 1 && current.qty !== 0)
      ) {
        current.qty = 0
        current.price = 0
      } else if (totalQty < 0) {
        current.side =
          order.side === 'BUY' ? PositionSide.LONG : PositionSide.SHORT
        current.qty =
          this.coinm && !this.isBitget
            ? Math.abs((totalQty * (ed?.quoteAsset.minAmount ?? 1)) / price)
            : Math.abs(totalQty)
        current.price = price
      } else {
        current.qty =
          this.coinm && !this.isBitget
            ? Math.abs(
                (totalQty * (ed?.quoteAsset.minAmount ?? 1)) / current.price,
              )
            : totalQty
      }
    }
    return { ...current, qty: this.math.round(current.qty, baseAssetPricision) }
  }

  allowToProcessBr(_orderId: string, _type?: TypeOrderEnum) {
    return true
  }

  private async buyRemainder(order: Order, count = 1): Promise<Order> {
    if (count >= 20) {
      return order
    }
    if (order.reduceOnly) {
      return order
    }
    if (order.typeOrder === TypeOrderEnum.rebalance) {
      return order
    }
    if (
      !isNaN(+order.executedQty) &&
      isFinite(+order.executedQty) &&
      +order.executedQty !== 0 &&
      +order.executedQty < +order.origQty &&
      (order.status === 'FILLED' ||
        ([ExchangeEnum.bybit].includes(order.exchange) &&
          order.type === 'MARKET' &&
          order.status === 'CANCELED')) &&
      !this.coinm
    ) {
      const fullAmount =
        count === 1 &&
        this.botType === BotType.dca &&
        (this.data?.settings as DCABotSettings).remainderFullAmount &&
        order.typeOrder === TypeOrderEnum.dealStart
      this.partiallyFilledFilledSet.add(order.clientOrderId)
      const ed = await this.getExchangeInfo(order.symbol)
      let diff = +order.origQty - +order.executedQty
      const price = await this.getLatestPrice(order.symbol)
      let diffMore =
        diff > (ed?.baseAsset.minAmount ?? Infinity) &&
        diff * price > (ed?.quoteAsset.minAmount ?? Infinity)
      if (!diffMore && fullAmount && ed?.baseAsset.minAmount) {
        this.handleLog(
          `Order ${order.clientOrderId} not ${order.side} full qty: executed - ${order.executedQty}, total - ${order.origQty}, diff - ${diff}, remainder is less than allowed on exchange and will be increased to exchange minimum ${ed.baseAsset.minAmount}, count ${count}`,
        )
        diff = ed?.baseAsset.minAmount ?? +order.origQty
        diffMore = true
      }
      if (diffMore) {
        this.handleLog(
          `Order ${order.clientOrderId} not ${order.side} full qty: executed - ${order.executedQty}, total - ${order.origQty}, diff - ${diff}, count ${count}`,
        )
        if (ed) {
          const buyRemainderOrder = await this.sendGridToExchange(
            {
              price: this.math.round(
                await this.getLatestPrice(ed.pair),
                ed?.priceAssetPrecision,
              ),
              qty: this.math.round(
                diff,
                await this.baseAssetPrecision(ed.pair),
                false,
                true,
              ),
              number: 1,
              side:
                order.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
              newClientOrderId: this.getOrderId('GA-BR'),
              type: TypeOrderEnum.br,
            },
            {
              type: 'MARKET',
              dealId: order.dealId,
              positionSide: order.positionSide
                ? order.positionSide === 'BOTH'
                  ? PositionSide.BOTH
                  : order.positionSide === 'LONG'
                    ? PositionSide.LONG
                    : PositionSide.SHORT
                : undefined,
              reduceOnly: order.reduceOnly,
            },
            ed,
            false,
            false,
            true,
          )

          if (
            buyRemainderOrder &&
            (buyRemainderOrder.status === 'FILLED' ||
              ([ExchangeEnum.bybit].includes(order.exchange) &&
                order.type === 'MARKET' &&
                buyRemainderOrder.status === 'CANCELED' &&
                +buyRemainderOrder.executedQty > 0))
          ) {
            this.handleLog(
              `Buy remainder executed - ${buyRemainderOrder.clientOrderId}, ${
                buyRemainderOrder.side
              }, base - ${buyRemainderOrder.executedQty}, quote - ${
                +buyRemainderOrder.executedQty * +buyRemainderOrder.price
              }, price - ${buyRemainderOrder.price}, time ${
                buyRemainderOrder.transactTime
              }, count ${count}`,
            )
            const totalBase = this.math.round(
              +order.executedQty + +buyRemainderOrder.executedQty,
              await this.baseAssetPrecision(ed.pair),
            )
            const totalQuote =
              +order.executedQty * +order.price +
              +buyRemainderOrder.executedQty * +buyRemainderOrder.price
            const price = this.math.round(
              totalQuote / totalBase,
              ed?.priceAssetPrecision,
            )
            if (!isNaN(price)) {
              order.price = `${price}`
              order.executedQty = `${totalBase}`
              order.cummulativeQuoteQty = `${totalQuote}`
              order.status = 'FILLED'
            }
            this.handleLog(
              `Total order ${order.clientOrderId}, ${order.price}, base: ${order.executedQty}, quote: ${order.cummulativeQuoteQty} ${order.side}, ${order.updateTime}, count ${count}`,
            )
            order = await this.buyRemainder(order, count + 1)
          }
        }
      } else {
        this.handleLog(
          `Order ${order.clientOrderId} not ${order.side} full qty: executed - ${order.executedQty}, total - ${order.origQty}, diff - ${diff}, but remainder is less than allowed on exchange, count ${count}`,
        )
      }
    }
    return order
  }

  @IdMute(
    mutex,
    (order: Order) =>
      `${order.botId}${order.clientOrderId}fillPartiallyFilledOrder`,
  )
  async fillPartiallyFilledOrder(order: Order): Promise<Order> {
    if (!this.allowToProcessBr(order.clientOrderId, order.typeOrder)) {
      return order
    }
    if (this.data?.exchange === ExchangeEnum.coinbase) {
      return order
    }
    if (this.partiallyFilledFilledSet.has(order.clientOrderId)) {
      const processed = this.getOrderFromMap(order.clientOrderId)
      return processed ?? order
    }
    order = await this.buyRemainder(order)
    this.orders.set(order.clientOrderId, order)
    return order
  }

  private convertCoinbaseOrder(order: ExecutionReport): ExecutionReport {
    if (this.data?.exchange !== ExchangeEnum.coinbase) {
      return order
    }
    const findOrder = this.getOrderFromMap(
      (order as SpotUpdate).newClientOrderId,
    )
    if (!findOrder) {
      return order
    }
    const price = order.price || findOrder.price
    const totalQuoteTradeQuantity = +price * +order.totalTradeQuantity
    const result = {
      ...order,
      price,
      quantity: findOrder.origQty,
      totalQuoteTradeQuantity:
        !isNaN(totalQuoteTradeQuantity) && isFinite(totalQuoteTradeQuantity)
          ? totalQuoteTradeQuantity
          : order.totalTradeQuantity,
    } as SpotUpdate
    return result
  }

  protected needToSendOrder(order: Order) {
    return (
      order.clientOrderId.indexOf('CMBH') === -1 &&
      order.clientOrderId.indexOf('CMB-H') === -1 &&
      order.clientOrderId.indexOf('GABR') === -1 &&
      order.clientOrderId.indexOf('DSR') === -1 &&
      order.clientOrderId.indexOf('D-SR') === -1 &&
      order.clientOrderId.indexOf('GA-BR') === -1 &&
      order.clientOrderId.indexOf('4b1c2ba2186cBCDEGABR') === -1 &&
      order.clientOrderId.indexOf('4b1c2ba2186cBCDEDSR') === -1 &&
      order.typeOrder !== TypeOrderEnum.fee &&
      order.typeOrder !== TypeOrderEnum.stab
    )
  }
  /**
   * Is this order eligible for the `Compliance restriction` cooldown gate?
   *
   * Only orders that OPEN/INCREASE exposure are ever suppressed. Closing orders
   * (TP, grid stop, liquidation, anything reduceOnly) always go to the exchange
   * — a jurisdiction block that lifts must never leave a position stranded
   * behind a cooldown of ours. Same principle as the Quantitative Rules gate.
   */
  protected isComplianceGateable(order: Order): boolean {
    return (
      this.needToSendOrder(order) &&
      !order.reduceOnly &&
      order.typeOrder !== TypeOrderEnum.dealTP &&
      order.typeOrder !== TypeOrderEnum.stop &&
      order.typeOrder !== TypeOrderEnum.liquidation
    )
  }
  /**
   * Process order from queue<br />
   *
   * Get first order from queue<br />
   *
   * Update order data in {@link MainBot#orders}, save to order collection in db, emit update vie {@link MainBot#ioUpdate}<br />
   *
   * If order is filled run onFilled callback<br />
   *
   * Remove order from {@link MainBot#orderQueue} and run {@link MainBot#processOrderQueue}
   *
   * @param {(order: Order, updateTime: number) => Promise<void>} onFilled Callback on filled order
   * @param {(order: Order, updateTime: number) => Promise<void>} onPartiallyFilled Callback on partially filled order
   * @param {(order: Order, updateTime: number) => Promise<void>} onCanceled Callback on canceled order
   */
  @IdMute(mutex, (botId: string) => `${botId}processQueue`)
  async processOrderQueue(
    _botId: string,
    onFilled?: (order: Order, updateTime: number) => Promise<void>,
    onPartiallyFilled?: (order: Order, updateTime: number) => Promise<void>,
    onCanceled?: (
      order: Order,
      updateTime: number,
      expired: boolean,
    ) => Promise<void>,
    onNew?: (order: Order, updateTime: number) => Promise<void>,
    onLiquidation?: (order: Order, updateTime: number) => Promise<void>,
  ): Promise<void> {
    if (!this.lockProcessQueueMethod && this.orderQueue.length === 0) {
      this.lockProcessQueueMethod = true
      this.processedOrders = new Map()
      this.lockProcessQueueMethod = false
    }
    if (!this.lockProcessQueueMethod && this.orderQueue.length > 0) {
      const next = () => {
        this.orderQueue.shift()
        this.lockProcessQueueMethod = false
        this.processOrderQueue(
          this.botId,
          onFilled,
          onPartiallyFilled,
          onCanceled,
          onNew,
          onLiquidation,
        )
      }
      this.lockProcessQueueMethod = true
      const msg = this.orderQueue[0]
      const ed = await this.getExchangeInfo(msg.symbol)
      const orderId = this.getOrderStatus(msg)
      const base = parseFloat(msg.totalTradeQuantity)
      const key = `${orderId}${msg.orderStatus}${base}`
      if (!this.processedOrders.has(key)) {
        this.processedOrders.set(key, {
          id: orderId,
          status: msg.orderStatus,
          qty: base,
        })
        let order = await this.convertExecutionReportToOrder(msg, true)
        if (!order) {
          this.handleDebug(`${orderId} not found in orders and in DB`)
          return next()
        }
        this.handleLog(
          `Processing msg ${order.symbol} ${order.clientOrderId}, ${
            order.status
          }, ${order.price}, base: ${order.executedQty}, quote: ${
            order.cummulativeQuoteQty
          } ${order.side}, ${order.updateTime}${
            order.liquidation && this.futures ? ' !LIQUIDATION!' : ''
          }`,
        )
        if (order.liquidation && onLiquidation && this.futures) {
          await this.saveOrderToDb(order).catch((e) =>
            this.handleWarn(
              `Cannot save liquidation order ${(e as Error).message}`,
            ),
          )
          this.lockProcessQueueMethod = false
          onLiquidation(order, msg.eventTime)
          return next()
        }
        if (
          [ExchangeEnum.bybit].includes(order.exchange) &&
          order.type === 'MARKET'
        ) {
          if (
            order.cummulativeQuoteQty &&
            ['CANCELED'].includes(order.status) &&
            +order.cummulativeQuoteQty > 0
          ) {
            order.status = 'FILLED'
          }
          if (
            !this.coinm &&
            order.status === 'PARTIALLY_FILLED' &&
            Math.abs(
              +order.price * +order.executedQty -
                +order.origPrice * +order.origQty,
            ) < (ed?.quoteAsset.minAmount ?? 0)
          ) {
            order.status = 'FILLED'
          }
        }
        const origExecutedQty = +order.executedQty
        order = await this.fillPartiallyFilledOrder(order)
        const newExecutedQty = +order.executedQty
        this.updateOrderOnDb(order, origExecutedQty < newExecutedQty)
        if (this.needToSendOrder(order)) {
          this.emit('bot update', order)
        }
        this.deleteOrder(order.clientOrderId)
        if (
          (order.status !== 'CANCELED' ||
            (order.status === 'CANCELED' && +order.executedQty > 0)) &&
          order.status !== 'EXPIRED'
        ) {
          this.setOrder(order)
        }
        if (order.status === 'FILLED' && onFilled) {
          this.botEventDb.createData({
            userId: this.userId,
            botId: this.botId,
            event: 'Order',
            botType: this.botType,
            description: `Order filled: ${orderId}`,
            paperContext: !!this.data?.paperContext,
            deal: order.dealId,
            symbol: order.symbol,
          })
          onFilled(order, order.updateTime)
        }
        if (order.status === 'PARTIALLY_FILLED' && onPartiallyFilled) {
          await onPartiallyFilled(order, order.updateTime)
        }
        if (order.status === 'NEW' && onNew) {
          await onNew(order, order.updateTime)
        }
        if (
          (order.status === 'CANCELED' || order.status === 'EXPIRED') &&
          onCanceled
        ) {
          await onCanceled(order, order.updateTime, order.status === 'EXPIRED')
        }
      }
      next()
    }
  }

  private async heartbeatConsumer() {
    try {
      if (!this.redisDb || !this.data) {
        return
      }
      const accountId = `${this.data.exchangeUUID}`
      const pipeline = this.redisDb.instance?.multi()
      if (!pipeline) {
        return
      }
      pipeline.set(`stream:hasConsumer:${accountId}`, '1', {
        EX: 30,
      })
      pipeline.zAdd(
        'stream:lastEventTime',
        { score: 0, value: accountId },
        { comparison: 'GT' },
      )
      await pipeline
        .execAsPipeline()
        .catch((e) =>
          this.handleError(
            `Failed to heartbeat consumer for ${accountId}: ${
              (e as Error)?.message ?? e
            }`,
          ),
        )
    } catch (e) {
      this.handleError(
        `Failed to heartbeat consumer: ${(e as Error)?.message ?? e}`,
      )
    }
  }

  startConsumerHeartbeat() {
    if (this.consumerHeartbeatTimer) {
      clearInterval(this.consumerHeartbeatTimer)
    }
    const interval = 30_000
    this.consumerHeartbeatTimer = setInterval(() => {
      this.heartbeatConsumer()
    }, interval)
    // Greppable: confirms the sweep is enabled+armed for this bot (once on load).
    this.handleLog(`Consumer hearbeat armed (every ${interval}ms)`)
  }

  /** Stop the reconciliation sweep. */
  stopConsumerHeartbeat() {
    if (this.consumerHeartbeatTimer) {
      clearInterval(this.consumerHeartbeatTimer)
      this.consumerHeartbeatTimer = null
    }
  }

  /**
   * Cancel all pending Quantitative Rules deferred retries. MUST be called on
   * bot stop (afterBotStop) — a retry firing after the bot stopped would place
   * a rogue order on the exchange for a bot the user believes is stopped.
   */
  stopQuantRulesRetries() {
    for (const timer of this.quantRulesRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.quantRulesRetryTimers.clear()
  }

  /**
   * Is a Quantitative Rules deferred retry still wanted when its timer fires?
   * If the order belongs to a deal, the deal must still be open — a reduceOnly
   * TP can close a deal DURING a cooldown, and re-sending one of its orders
   * afterwards would create an orphan on the exchange. DCA/combo helpers hold
   * a `deals` Map keyed by dealId; grid bots have no such map (their orders
   * are perpetual while the bot runs), so default to true.
   */
  protected isOrderStillWanted(order: Order): boolean {
    const deals = (this as { deals?: Map<string, unknown> }).deals
    if (order.dealId && deals instanceof Map) {
      return deals.has(order.dealId)
    }
    return true
  }

  /**
   * Schedule a bounded, deduped re-send of an order soft-skipped by a Binance
   * Quantitative Rules (-4400) cooldown. The order was NOT sent to the exchange
   * (delay, don't fail), so nothing else will re-place it reliably during normal
   * running; this timer is the self-heal path. It fires shortly after the
   * cooldown expires, re-checks (so an escalation extends the wait via the gate
   * inside sendOrderToExchange), and re-sends. Keyed by clientOrderId so a given
   * order has at most one pending retry (clear-and-replace on reschedule).
   */
  protected scheduleQuantRulesRetry(
    order: Order,
    returnError: boolean | undefined,
    cooldown: {
      until: number | null
      level: number | null
      scope: string | null
    },
  ): void {
    const key = order.clientOrderId
    const existing = this.quantRulesRetryTimers.get(key)
    if (existing) {
      clearTimeout(existing)
    }
    const now = +new Date()
    // Small buffer past expiry to avoid a re-send landing on the exact boundary.
    const delayMs = Math.max(1000, (cooldown.until ?? now) - now + 1000)
    const untilIso = cooldown.until
      ? new Date(cooldown.until).toISOString()
      : 'unknown'
    this.handleLog(
      `Order ${key} delayed by Binance Quantitative Rules cooldown (level ${
        cooldown.level ?? '?'
      }, ${cooldown.scope ?? '?'}) until ${untilIso}. Reduce-only orders continue to work. Will retry in ${Math.ceil(
        delayMs / 1000,
      )}s`,
    )
    const timer = setTimeout(() => {
      this.quantRulesRetryTimers.delete(key)
      // Re-check inside sendOrderToExchange's gate; if still restricted it will
      // re-schedule another retry. Fire-and-forget with guards against a
      // stopped/torn-down bot and against a deal that closed during the
      // cooldown (a reduceOnly TP can fill while restricted — re-sending its
      // order would orphan it on the exchange).
      if (this.ignoreErrors || !this.data || !this.exchange) {
        return
      }
      if (!this.isOrderStillWanted(order)) {
        this.handleLog(
          `Quantitative Rules deferred retry dropped for ${key}: deal ${order.dealId} no longer open`,
        )
        return
      }
      void this.sendOrderToExchange(order, returnError as any).catch((e) =>
        this.handleWarn(
          `Quantitative Rules deferred retry failed for ${key}: ${
            (e as Error)?.message ?? e
          }`,
        ),
      )
    }, delayMs)
    // Don't keep the event loop alive solely for a cooldown retry.
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.quantRulesRetryTimers.set(key, timer)
  }

  /**
   * Persist a reconciliation-sweep catch (a fill the user stream dropped that
   * the periodic sweep recovered). Fire-and-forget — never block or throw into
   * the order-check path. Powers the admin user-stream health page: a rising
   * per-account catch rate means that account's user stream is silently dead.
   */
  protected recordReconcileSweepCatch(missedFills: number) {
    void this.reconcileSweepDb
      .createData({
        botId: this.botId,
        botType: this.botType,
        userId: this.userId,
        exchange: `${this.data?.exchange ?? this.exchange ?? ''}`,
        exchangeUUID: `${this.data?.exchangeUUID ?? ''}`,
        paperContext: !!this.data?.paperContext,
        pair: this.data?.settings?.pair?.[0],
        missedFills,
      })
      .catch((e) =>
        this.handleWarn(
          `reconcile-sweep record failed: ${(e as Error).message}`,
        ),
      )
  }

  /**
   * Callback on account update event<br />
   *
   * If event = 'executionReport' - find order in {@link MainBot#orders}<br />
   *
   * If find - add order to {@link MainBot#orderQueue} and sort it by - time, side, price<br />
   *
   * Run {@link MainBot#processOrderQueue}
   *
   * @param {UserDataStreamEvent} msg Message from stream
   * @param {(a: ExecutionReport, b: ExecutionReport) => number} sort Sort function
   * @param {(order: Order, updateTime: number) => Promise<void>} onFilled Callback on filled order
   * @param {(order: Order, updateTime: number) => Promise<void>} onPartiallyFilled Callback on partially filled order
   * @param {(order: Order, updateTime: number) => Promise<void>} onCanceled Callback on canceled order
   */

  async accountCallback(msg: UserDataStreamEvent): Promise<void> {
    if (!this.cbFunctions) {
      return
    }
    if (
      msg.eventType === 'executionReport' ||
      msg.eventType === 'ORDER_TRADE_UPDATE'
    ) {
      const {
        sort,
        onFilled,
        onPartiallyFilled,
        onCanceled,
        onNew,
        onLiquidation,
      } = this.cbFunctions
      const clientOrderId =
        msg.eventType === 'executionReport'
          ? msg.newClientOrderId || (msg.liquidation ? `liq_${v4()}` : '')
          : msg.clientOrderId || (msg.liquidation ? `liq_${v4()}` : '')
      if (!clientOrderId) {
        return
      }
      if (!this.ordersKeys.has(clientOrderId) && !msg.liquidation) {
        return
      }
      const isHyperliquidOrder =
        clientOrderId.startsWith('0x') &&
        clientOrderId.length === 34 &&
        this.hyperliquid

      if (clientOrderId.indexOf('GA-BR') !== -1 && !isHyperliquidOrder) {
        return
      }
      if (
        !isHyperliquidOrder &&
        !msg.liquidation &&
        ((this.botType === BotType.grid &&
          !clientOrderId.includes('GRID-TP') &&
          !clientOrderId.includes('GRIDTP') &&
          !clientOrderId.includes('GRID-STAB') &&
          !clientOrderId.includes('GRIDSTAB') &&
          !clientOrderId.includes('GRID-BO') &&
          !clientOrderId.includes('GRIDBO') &&
          !clientOrderId.includes('GRID-RO') &&
          !clientOrderId.includes('GRIDRO') &&
          !clientOrderId.includes('GA-F') &&
          !clientOrderId.includes('GAF')) ||
          (this.botType === BotType.dca &&
            !clientOrderId.includes('D-ROA') &&
            !clientOrderId.includes('DROA') &&
            !clientOrderId.includes('D-SR') &&
            !clientOrderId.includes('DSR') &&
            !clientOrderId.includes('D-BO') &&
            !clientOrderId.includes('DBO') &&
            !clientOrderId.includes('D-TP') &&
            !clientOrderId.includes('DTP') &&
            !clientOrderId.includes('D-MTP') &&
            !clientOrderId.includes('DMTP') &&
            !clientOrderId.includes('D-MSL') &&
            !clientOrderId.includes('DMSL') &&
            !clientOrderId.includes('D-RO') &&
            !clientOrderId.includes('DRO')) ||
          (this.botType === BotType.combo &&
            !clientOrderId.includes('D-SR') &&
            !clientOrderId.includes('DSR') &&
            !clientOrderId.includes('CMB-BO') &&
            !clientOrderId.includes('CMBBO') &&
            !clientOrderId.includes('D-TP') &&
            !clientOrderId.includes('DTP') &&
            !clientOrderId.includes('CMB-GR') &&
            !clientOrderId.includes('CMBGR') &&
            !clientOrderId.includes('D-MSL') &&
            !clientOrderId.includes('DMSL') &&
            !clientOrderId.includes('CMB-RO') &&
            !clientOrderId.includes('CMB-H') &&
            !clientOrderId.includes('CMBH') &&
            !clientOrderId.includes('CMBRO') &&
            !clientOrderId.includes('GA-F') &&
            !clientOrderId.includes('GAF')))
      ) {
        return
      }
      const orderId = this.getOrderStatus(msg)
      const find = this.getOrderFromMap(orderId)
      const liquidation =
        this.futures &&
        (msg.eventType === 'executionReport' ||
          msg.eventType === 'ORDER_TRADE_UPDATE') &&
        msg.liquidation &&
        [this.data?.settings.pair ?? []].flat().includes(msg.symbol) &&
        msg.orderStatus === 'FILLED'
      if (msg.liquidation) {
        this[liquidation ? 'handleLog' : 'handleDebug'](
          `Received liquidation order for ${msg.symbol} ${
            liquidation
              ? 'will be processed in bot'
              : 'wont be processed in bot'
          }`,
        )
      }
      if (find || liquidation) {
        const tmp = [...this.orderQueue]
        tmp.push(msg)
        this.orderQueue = [...tmp.sort(sort)]
        this.processOrderQueue(
          this.botId,
          onFilled,
          onPartiallyFilled,
          onCanceled,
          onNew,
          onLiquidation,
        )
      }
    }
  }

  async getUsdRate(symbol: string, asset: 'base' | 'quote' = 'quote') {
    return this._getUsdRate(
      this.data?.exchange ?? ExchangeEnum.binance,
      symbol,
      asset,
    )
  }

  /**
   * Get USD rate from quote asset to usd<br />
   *
   * Find rate to convert quote asset to USDT/BTC/BUSD<br />
   *
   * Convert finded rate to USD
   *
   * @returns {Promise<number>} USD rate
   */
  @IdMute(
    mutex,
    (
      exchange: ExchangeEnum,
      symbol: string,
      asset: 'base' | 'quote' = 'quote',
    ) =>
      `getUsdRate:${removePaperFormExchangeName(exchange)}_${symbol}_${asset}`,
    100,
  )
  async _getUsdRate(
    _exchange: ExchangeEnum,
    symbol: string,
    asset: 'base' | 'quote' = 'quote',
  ): Promise<number> {
    const key = `${symbol}_${asset}`
    const usdCache = await this.getLastUsdData(key)
    if (usdCache && +new Date() - (usdCache?.time ?? 0) < this.priceTimeout) {
      return usdCache?.price as number
    }
    const ed = await this.getExchangeInfo(symbol)
    if (ed && this.exchange) {
      const quote = asset === 'quote' ? ed.quoteAsset.name : ed.baseAsset.name
      const prices = await this.exchange.getAllPrices(true)
      if (prices.status === StatusEnum.ok) {
        const usdRequest = await this.ratesDb.readData<{ usdRate: number }>(
          {},
          { usdRate: 1 },
          {
            limit: 1,
            sort: { created: -1 },
          },
        )
        let price = 1
        if (
          usdRequest.status === StatusEnum.ok &&
          usdRequest.data?.result?.usdRate
        ) {
          price = usdRequest.data.result.usdRate
        }
        const rate = findUSDRate(
          quote,
          [
            ...prices.data.map((p) => ({ ...p, exchange: 'all' })),
            {
              pair: 'USDTZUSD',
              price,
              exchange: 'all',
            },
          ],
          this.data?.exchange,
        )
        if (rate) {
          this.setLastUsdData(key, { price: rate, time: +new Date() })
        }
        return rate
      } else {
        this.handleErrors(
          `Cannot get prices ${prices.reason}`,
          'getUsdRate()',
          undefined,
          false,
          false,
          false,
        )
      }
    }
    return 1
  }

  @RunWithDelay(
    (botId: string) => `${botId}saveBotDataToRedis`,
    (_botId: string, restart: boolean) => setToRedisDelay * (restart ? 5 : 2),
  )
  saveBotDataToRedis(_botId: string, _restart: boolean) {
    if (this.data) {
      this.setToRedis(
        'botData',
        this.botType === BotType.dca
          ? //@ts-ignore
            convertDCABotToObject(this.data)
          : this.botType === BotType.combo
            ? //@ts-ignore
              convertComboBotToObject(this.data)
            : this.data,
      )
    }
  }

  /**
   * Update data in db
   * @param {Partial<T>} data Data to update
   */

  async updateData(data: any) {
    await this.db
      ?.updateData({ _id: this.botId } as any, { $set: { ...data } })
      .then((res) => {
        if (res.status === StatusEnum.notok) {
          this.handleErrors(
            res.reason,
            'updateData()',
            'save updated data',
            false,
            false,
            false,
          )
        }
      })
      .then(() =>
        this.saveBotDataToRedis.bind(this)(
          this.botId,
          this.serviceRestart && !this.secondRestart,
        ),
      )
  }
  getWorkingTimeNumber() {
    return (this.data?.workingShift ?? ([] as WorkingShift[])).reduce(
      (acc, v) => acc + ((v.end ? v.end : +new Date()) - v.start),
      0,
    )
  }
  /**
   * Set range status
   * @param {BotStatusEnum.range | BotStatusEnum.error} [status] Status to set Range or Error. Default = Range
   */

  setRangeOrError(
    status: BotStatusEnum.range | BotStatusEnum.error = BotStatusEnum.range,
  ) {
    if (
      status === BotStatusEnum.range &&
      this.data?.status === BotStatusEnum.monitoring
    ) {
      return
    }
    if (this.data) {
      const lastShift =
        this.data.workingShift[this.data.workingShift.length - 1]
      if (lastShift && !lastShift.end) {
        this.data.workingShift = [
          ...this.data.workingShift.filter((w) => w.start !== lastShift.start),
          { ...lastShift, end: new Date().getTime() },
        ]
      }
      const data = {
        status,
        workingShift: this.trimWorkingShift(this.data.workingShift),
        workingTimeNumber: this.getWorkingTimeNumber(),
        previousStatus: [
          BotStatusEnum.range,
          BotStatusEnum.error,
          BotStatusEnum.monitoring,
        ].includes(this.data.status)
          ? this.data.previousStatus
          : this.data.status,
      } as Partial<T>
      this.data = { ...this.data, ...data }
      this.emit('bot settings update', data)
      this.updateData({ ...data })
    }
  }

  trimWorkingShift(_workingShift: WorkingShift[]) {
    let workingShift = _workingShift
    if ((workingShift ?? []).length > 10) {
      const duration = workingShift.reduce(
        (acc, v) => acc + (v.end ? v.end - v.start : 0),
        0,
      )
      const lastShift = workingShift[workingShift.length - 1]
      workingShift = [{ start: 0, end: duration }]
      if (!lastShift.end) {
        workingShift.push(lastShift)
      }
    }
    return workingShift
  }
  /**
   * Restore from range status
   */

  restoreFromRangeOrError() {
    if (this.data && this.data.status !== BotStatusEnum.closed) {
      if (
        this.data.previousStatus &&
        this.data.previousStatus === BotStatusEnum.open
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
      }
      this.data.workingShift = this.trimWorkingShift(this.data.workingShift)
      if (this.data.status === BotStatusEnum.error) {
        // Same key as processError writes and counts under. Clearing by
        // `this.botId` never matched a hedge bot's rows (they are filed under the
        // parent), so recovery could not reopen the per-subType throttle and the
        // bot fell silent on that subType for good. The message stream is
        // parent-scoped by construction — every leg files into it — so a leg
        // recovering clears the parent's set; a leg still in error simply
        // re-raises on its next occurrence, which is the non-hedge behaviour too.
        // The futuresLiquidation exemption below is deliberate — leave it.
        this.messagesDb.updateManyData(
          {
            botId: this.data?.parentBotId || this.botId,
            isDeleted: false,
            subType: { $ne: futuresLiquidation },
          },
          // `$unset bucket` drops these rows out of `botMessageCoalesceKey`, so
          // the next occurrence inserts a fresh visible row. Without it the
          // recovery clear would hide the row while leaving it as the coalescing
          // target, and the error could never be raised again — exactly the
          // "bot fell silent on that subType for good" failure this clear exists
          // to prevent.
          { $set: { isDeleted: true }, $unset: { bucket: '' } },
        )
        const update = { showErrorWarning: 'none' }
        this.updateData(update)
        this.emit('bot settings update', update)
      }
      const status = this.data.previousStatus ?? BotStatusEnum.open
      const data = {
        status,
        workingShift: this.data.workingShift,
        workingTimeNumber: this.getWorkingTimeNumber(),
        previousStatus: undefined,
      } as Partial<T>
      if (data.status === BotStatusEnum.open) {
        data.statusReason = ''
      }
      this.data = { ...this.data, ...data }
      this.emit('bot settings update', data)
      this.updateData({ ...data })
    }
  }

  /**
   * Clean heavy class property
   */

  clean() {
    this.orders = new Map()
  }
  convertGridToOrder(
    order: Grid,
    additionalParams: OrderAdditionalParams,
    ed: ClearPairsSchema,
  ): Order | null {
    if (!this.data) {
      return null
    }
    const response: Order = {
      clientOrderId: order.newClientOrderId,
      status: 'NEW' as 'NEW',
      executedQty: '0',
      price: `${order.price}`,
      origPrice: `${order.price}`,
      cummulativeQuoteQty: `${order.price * order.qty}`,
      orderId: '-1',
      origQty: `${order.qty}`,
      side: order.side,
      symbol: ed.pair,
      baseAsset: ed.baseAsset.name,
      quoteAsset: ed.quoteAsset.name,
      updateTime: new Date().getTime(),
      exchange: this.data.exchange,
      exchangeUUID: this.data.exchangeUUID,
      typeOrder: order.type,
      botId: this.botId,
      userId: this.userId,
      transactTime: new Date().getTime(),
      fills: [],
      tpSlTarget: order.tpSlTarget,
      dcaLevel: order.dcaLevel,
      minigridId: order.minigridId,
      minigridBudget: order.minigridBudget,
      sl: order.sl,
      ...additionalParams,
    }
    if (response.price.indexOf('e') !== -1) {
      response.price = this.math.convertFromExponential(
        response.price,
        ed.priceAssetPrecision,
      )
      response.origPrice = this.math.convertFromExponential(
        response.origPrice,
        ed.priceAssetPrecision,
      )
    }
    return response
  }

  /**
   * Send grid to exchange
   */
  async sendGridToExchange(
    order: Grid,
    additionalParams: OrderAdditionalParams,
    ed: ClearPairsSchema,
    returnError: true,
    force?: boolean,
    skipBr?: boolean,
  ): Promise<Order | string | void>
  async sendGridToExchange(
    order: Grid,
    additionalParams: OrderAdditionalParams,
    ed: ClearPairsSchema,
    returnError?: boolean,
    force?: boolean,
    skipBr?: boolean,
  ): Promise<Order | void>

  async sendGridToExchange(
    order: Grid,
    additionalParams: OrderAdditionalParams,
    ed: ClearPairsSchema,
    returnError = false,
    force?: boolean,
    skipBr?: boolean,
  ): Promise<Order | string | void> {
    if (this.data && this.exchange) {
      const orderPrepared = this.convertGridToOrder(order, additionalParams, ed)
      if (orderPrepared) {
        const result = await this.sendOrderToExchange(
          orderPrepared,
          returnError,
          undefined,
          force,
          skipBr,
        )
        return result
      }
    }
  }

  async convertOrderExecutedQty(order: Order | CommonOrder) {
    const ed = await this.getExchangeInfo(order.symbol)
    let executedQty = order.executedQty
    if (ed) {
      executedQty =
        this.coinm && !this.isBitget
          ? `${
              (+order.executedQty * (ed.quoteAsset.minAmount ?? 1)) /
              (+order.price || +(order.avgPrice ?? '0') || +order.origQty)
            }`
          : (this.okx || this.kucoinFutures) && this.futures
            ? `${this.math.round(
                +order.executedQty /
                  (await this.getOKXDenominator(order.symbol)),
                await this.baseAssetPrecision(ed.pair),
              )}`
            : executedQty
    }
    if (
      order.status === 'FILLED' &&
      (+executedQty === 0 || isNaN(+executedQty) || !isFinite(+executedQty))
    ) {
      // A FILLED order whose executedQty is 0/NaN usually just means the exchange
      // didn't echo the filled size, so historically we trusted origQty. But
      // Hyperliquid can return a genuinely (near-)empty fill as FILLED — e.g. an
      // IOC market buy that barely fills due to insufficient balance comes back
      // status FILLED with executedQty 0 and fills []. Promoting that to origQty
      // books a PHANTOM fill and silently inflates the deal's tracked position.
      // So derive the REAL filled size from the actual fills first, and only fall
      // back to origQty for other exchanges where FILLED reliably means filled.
      const fillsQty = (order.fills ?? []).reduce(
        (acc, f) => acc + (+f.qty || 0),
        0,
      )
      if (fillsQty > 0) {
        executedQty = `${fillsQty}`
      } else if (!this.hyperliquid) {
        executedQty = order.origQty
      } else {
        this.handleLog(
          `HL ${order.type} order ${order.clientOrderId} came back FILLED with no real fill (executedQty 0, empty fills) — keeping real qty instead of booking origQty ${order.origQty} to avoid a phantom fill`,
        )
      }
    }
    return executedQty
  }

  async isBNFCR(): Promise<boolean> {
    if (!this.data) {
      return false
    }
    if (
      ![
        ExchangeEnum.binanceCoinm,
        ExchangeEnum.binanceUsdm,
        ExchangeEnum.paperBinanceUsdm,
        ExchangeEnum.paperBinanceCoinm,
      ].includes(this.data.exchange)
    ) {
      return false
    }
    const user = await this.getUser()
    const linkedExchange = user?.exchanges.find(
      (ue) => ue.uuid === this.data?.exchangeUUID,
    )?.linkedTo
    const balances = await this.balancesDb.countData({
      userId: this.userId,
      exchange: this.data?.exchange,
      exchangeUUID: !!linkedExchange ? linkedExchange : this.data?.exchangeUUID,
      asset: 'BNFCR',
    })
    return balances.status === StatusEnum.ok && !!balances.data?.result
  }
  private async getAssetBalanceAndRequiredByOrder(order: Order) {
    const asset = this.futures
      ? this.coinm
        ? order.baseAsset
        : order.quoteAsset
      : order.side === 'BUY'
        ? order.quoteAsset
        : order.baseAsset
    const balance = await this.checkAssets(true)
    return {
      asset,
      balance: balance?.get(asset),
      required:
        (+order.origQty *
          (this.futures
            ? this.coinm
              ? 1
              : +order.price
            : order.side === 'BUY'
              ? +order.price
              : 1)) /
        this.currentLeverage,
    }
  }
  /**
   * Send order to exchange
   */

  async sendOrderToExchange(
    order: Order,
    returnError: true,
    count?: number,
    force?: boolean,
    skipBr?: boolean,
  ): Promise<Order | string | void>
  async sendOrderToExchange(
    order: Order,
    returnError?: boolean,
    count?: number,
    force?: boolean,
    skipBr?: boolean,
  ): Promise<Order | void>

  async sendOrderToExchange(
    order: Order,
    returnError = false,
    count = 0,
    force?: boolean,
    skipBr?: boolean,
  ): Promise<Order | string | void> {
    const _id = this.startMethod('sendOrderToExchange')
    const ed = await this.getExchangeInfo(order.symbol)
    if (
      this.isBitget &&
      this.futures &&
      typeof ed?.priceMultiplier?.decimals !== 'undefined' &&
      ed?.priceMultiplier?.decimals !== null
    ) {
      const mod = this.math.remainder(+order.price, ed.priceMultiplier.decimals)
      if (mod > Number.EPSILON) {
        order.price = `${this.math.round(
          +order.price - mod + ed.priceMultiplier.decimals,
          ed.priceAssetPrecision,
        )}`
      }
    }
    const fee = await this.getUserFee(order.symbol)
    if (this.data && this.exchange && fee) {
      this.setOrder(order)
      if (count === 0) {
        await this.saveOrderToDb(order)
      }
      const requestData = {
        symbol: order.symbol,
        side: order.side as
          | typeof OrderSideEnum.buy
          | typeof OrderSideEnum.sell,
        quantity:
          this.coinm && count === 0 && !this.isBitget
            ? Math.max(
                1,
                this.math.round(
                  (+order.origQty * +order.price) /
                    (ed?.quoteAsset.minAmount ?? 1),
                  0,
                ),
              )
            : (this.okx || this.kucoinFutures) && this.futures
              ? Math.max(
                  this.data.exchange === ExchangeEnum.okxLinear ? 0 : 1,
                  this.math.round(
                    +order.origQty *
                      (await this.getOKXDenominator(order.symbol)),
                    this.data.exchange === ExchangeEnum.okxLinear
                      ? /* await this.baseAssetPrecision(order.symbol) */ 8
                      : 0,
                  ),
                )
              : parseFloat(order.origQty),
        price: Math.max(
          ed?.priceAssetPrecision === 0
            ? 1
            : +`0.${`0`.repeat((ed?.priceAssetPrecision ?? 1) - 1)}1`,
          parseFloat(order.price),
        ),
        newClientOrderId: order.clientOrderId,
        type: order.type,
        reduceOnly: order.reduceOnly,
        positionSide: order.positionSide,
        marginType: this.futures
          ? this.data.settings.marginType === BotMarginTypeEnum.cross
            ? MarginType.CROSSED
            : MarginType.ISOLATED
          : undefined,
        leverage: this.data.settings.leverage ?? 1,
      }
      if (
        [
          ExchangeEnum.bybit,
          ExchangeEnum.coinbase,
          ExchangeEnum.bitget,
        ].includes(this.data.exchange) &&
        requestData.side === OrderSideEnum.buy &&
        requestData.type === 'MARKET'
      ) {
        requestData.quantity = this.math.round(
          requestData.quantity * requestData.price,
          this.data.exchange === ExchangeEnum.bitget
            ? (ed?.quoteAsset.precision ?? 0)
            : (ed?.priceAssetPrecision ?? 0),
        )
      }
      let processedOrder: CommonOrder | null = null
      if (
        ed &&
        order.type === 'MARKET' &&
        [
          ExchangeEnum.binance,
          ExchangeEnum.binanceCoinm,
          ExchangeEnum.binanceUsdm,
          ExchangeEnum.binanceUS,
        ].includes(order.exchange) &&
        +order.origQty > ed.baseAsset.maxMarketAmount
      ) {
        this.handleLog(
          `Binance MARKET_LOT_SIZE order ${order.clientOrderId}, size: ${order.origQty}, max market size: ${ed.baseAsset.maxMarketAmount}`,
        )
        let remainder = +order.origQty
        const count = Math.ceil(+order.origQty / ed.baseAsset.maxMarketAmount)
        if (count > 1) {
          this.handleLog(
            `Binance MARKET_LOT_SIZE order ${order.clientOrderId} split into ${count}`,
          )
          let filledQty = 0
          let filledQuote = 0
          for (const i of [...Array(count).keys()]) {
            const size = Math.min(
              Math.max(
                this.math.round(
                  +order.origQty / count,
                  await this.baseAssetPrecision(ed.pair),
                ),
                ed.baseAsset.minAmount,
              ),
              remainder,
            )
            remainder -= size
            this.handleLog(
              `Binance MARKET_LOT_SIZE order ${order.clientOrderId} split ${
                i + 1
              } / ${count} size ${size}`,
            )
            const split = await this.sendOrderToExchange(
              {
                ...order,
                origQty: `${size}`,
                typeOrder: TypeOrderEnum.split,
                clientOrderId: `${order.clientOrderId.slice(
                  0,
                  order.clientOrderId.length - (`${count}`.length + 1),
                )}${i}`,
              },
              false,
              count,
            )
            if (split) {
              filledQty += +split.executedQty
              filledQuote += +split.executedQty * +split.price
            }
          }
          if (filledQty !== 0 && filledQuote !== 0) {
            const price = filledQty * filledQuote
            processedOrder = {
              ...order,
              price: `${price}`,
              executedQty: `${filledQty}`,
              cummulativeQuoteQty: `${filledQuote}`,
              status: 'FILLED',
            }
          }
        }
      }
      if (!processedOrder) {
        let request: BaseReturn<CommonOrder> | undefined
        const notEnoughBalanceId = this.getNotEnoughOrdersIdByOrder(order)
        // Tripped = the failure counter for this key has passed the threshold,
        // so this order is in the suppression regime. Only rejections from that
        // regime widen the cooldown: the counter trips within seconds (the
        // engine retries fast), so escalating on every raw rejection would
        // reach the ceiling before the guard ever engaged and a shortfall that
        // clears in a minute would still be held for an hour.
        //
        // It deliberately does NOT also require our own balance arithmetic to
        // agree that the order is unaffordable. `required` is one order's bare
        // notional, while the venue prices the whole ladder plus its fees and
        // margin buffer, so the two disagree in the direction that matters: on
        // prod a Kraken Futures bot was refused `insufficientAvailableFunds`
        // for 12.75 USD while the venue's OWN availableMargin read 13.40 USD.
        // Gating the cooldown on that comparison meant the disagreement case —
        // the only one where the engine cannot see why it is being refused —
        // was the one case that never backed off.
        let notEnoughBalanceTripped = false
        // Set when THIS attempt was served from the local cooldown rather than
        // the venue. A suppressed attempt must never widen the window, or it
        // would slide forever and the bot could not self-heal.
        let notEnoughBalanceShortCircuit = false
        if (this.data.notEnoughBalance?.thresholdPassed) {
          if (
            (this.data.notEnoughBalance.orders?.[notEnoughBalanceId] ?? 0) >
            this.notEnoughBalanceThreshold
          ) {
            notEnoughBalanceTripped = true
            this.handleDebug(
              `${this.notEnoughBalanceLogPrefix} Not enough balance threshold passed for order id ${notEnoughBalanceId} ${order.clientOrderId}. Checking balance`,
            )
            const { asset, balance, required } =
              await this.getAssetBalanceAndRequiredByOrder(order)
            // On a pooled-collateral venue the cached per-asset `free` is not
            // the figure the venue enforces, so confirm against its own before
            // CLEARING the latch — otherwise the guard resets on a number
            // Kraken rejects and the bot loops. The short branch needs no extra
            // call: its probe below already lets the venue break the tie.
            const spendable =
              (balance?.free ?? 0) < required
                ? (balance?.free ?? 0)
                : await this.spendableForNotEnoughBalance(
                    asset,
                    balance?.free ?? 0,
                  )
            // Suppress on a widening window rather than continuously. The
            // block decision above reads `checkAssets` WITHOUT `direct`, i.e.
            // the cached `balances` collection, which can lag badly (two
            // weeks was observed on prod for a thinly-traded asset). Letting
            // one attempt through per window makes the exchange — the only
            // authority — break the tie, so an under-reporting cache can
            // never latch a bot off permanently.
            //
            // The window is consulted whichever way the comparison below falls.
            // A cooldown only exists because the VENUE refused this key for
            // funds, and the venue outranks our arithmetic: when our figures
            // say the order is affordable and the venue keeps saying it is not,
            // re-asking on the strength of our own number is exactly the
            // rejection loop the cooldown exists to stop.
            const cooldown = await notEnoughBalanceBackoff.check([
              this.botId,
              notEnoughBalanceId,
            ])
            if (cooldown.suppressed) {
              notEnoughBalanceShortCircuit = true
              this.handleDebug(
                `${this.notEnoughBalanceLogPrefix} Not enough balance for order id ${notEnoughBalanceId} ${order.clientOrderId}. Balance: ${spendable}, required: ${required}. Suppressed until ${new Date(cooldown.until).toISOString()} (attempt ${cooldown.attempt})`,
              )
              request = {
                status: StatusEnum.notok,
                reason: `Not enough balance`,
                data: null,
              }
            } else if (spendable < required) {
              // Window elapsed (or never opened): let this one reach the
              // exchange. If it is rejected, the error path widens the
              // window; if it fills, the success path clears it.
              this.handleDebug(
                `${this.notEnoughBalanceLogPrefix} Probing exchange for order id ${notEnoughBalanceId} ${order.clientOrderId}. Cached balance: ${spendable}, required: ${required}`,
              )
            } else {
              // Our figures say it is affordable and no window is open, so this
              // one goes to the venue on their say-so. The decrement is the
              // self-heal path for a counter left latched by a shortfall that
              // has since cleared; it is only reached when nothing is
              // suppressing, so it can no longer erode the counter underneath
              // an active cooldown.
              this.handleDebug(
                `${this.notEnoughBalanceLogPrefix} Balance is enough for order id ${notEnoughBalanceId} ${order.clientOrderId}. Balance: ${spendable}, required: ${required}. Reset not enough balance orders`,
              )
              this.updateNotEnoughBalanceErrors(order, -1)
            }
          }
        }
        // Binance Futures Quantitative Rules (-4400) pre-send gate. Only for
        // real Binance USD-M/COIN-M futures, and only for orders that would
        // OPEN/INCREASE exposure (reduceOnly orders + cancels still work under
        // a restriction, so they are never gated). When the account/symbol is
        // in a cooldown we do NOT hit the exchange — hammering it would escalate
        // Binance's penalty (L1 -> L2 -> L3). We DELAY, never fail: the bot must
        // not enter error status and the deal must not be marked failed.
        if (
          !request &&
          this.isRealBinanceFutures &&
          !requestData.reduceOnly &&
          this.needToSendOrder(order)
        ) {
          const cooldown = await QuantRulesGuard.check(
            `${this.data.exchangeUUID}`,
            requestData.symbol,
          )
          if (cooldown.restricted && cooldown.until) {
            const remainingMs = cooldown.until - +new Date()
            if (remainingMs > 0 && remainingMs <= 60_000) {
              // Short tail: wait it out inline, then re-check once and proceed.
              this.handleLog(
                `Order ${order.clientOrderId} waiting ${Math.ceil(
                  remainingMs / 1000,
                )}s for Binance Quantitative Rules cooldown (level ${
                  cooldown.level
                }, ${cooldown.scope}) before sending`,
              )
              await sleep(remainingMs)
              const recheck = await QuantRulesGuard.check(
                `${this.data.exchangeUUID}`,
                requestData.symbol,
              )
              if (recheck.restricted) {
                this.endMethod(_id)
                return this.scheduleQuantRulesRetry(order, returnError, recheck)
              }
            } else if (remainingMs > 60_000) {
              // Long cooldown: soft-skip (no exchange call, no error) and let a
              // bounded deferred retry re-attempt after the cooldown expires.
              // NOTE: the engine's own reconciliation (checkOrders /
              // reconcile-sweep) only reliably re-places missing orders on
              // service restart or on the next fill, and the sweep is opt-in
              // (RECONCILE_SWEEP_ENABLED), so we cannot rely on it to re-send an
              // order that was never placed. The deferred retry below is the
              // self-heal path; it dedups on clientOrderId.
              this.endMethod(_id)
              return this.scheduleQuantRulesRetry(order, returnError, cooldown)
            }
          }
        }
        // Compliance / jurisdiction restriction short-circuit. A
        // `Compliance restriction` rejection (e.g. Kraken
        // "EAccount:Invalid permissions:USDT trading restricted for DE.") is a
        // PERMANENT account condition — no retry can ever succeed. The engine
        // still re-attempts every few minutes because BotStatusEnum.error is a
        // soft status that placeOrders clears via restoreFromRangeOrError(), so
        // one account produced 82 openOrder calls in 4h. Replay the exchange's
        // OWN last rejection from a short Redis cooldown instead of calling the
        // venue again: everything downstream (bot status, user message, order
        // cleanup) runs exactly as before — only the pointless REST call is gone.
        let complianceShortCircuit = false
        if (!request && this.isComplianceGateable(order)) {
          const cooldown = await ComplianceGuard.check(
            `${this.data.exchangeUUID}`,
            requestData.symbol,
          )
          if (cooldown.restricted && cooldown.reason) {
            complianceShortCircuit = true
            this.handleLog(
              `Order ${order.clientOrderId} not sent: ${
                requestData.symbol
              } is under a compliance restriction cooldown until ${new Date(
                cooldown.until ?? 0,
              ).toISOString()}. Exchange reason: ${cooldown.reason}`,
            )
            request = {
              status: StatusEnum.notok,
              reason: cooldown.reason,
              data: null,
            }
          }
        }
        request = request ?? (await this.exchange.openOrder(requestData))
        if (
          request.status === StatusEnum.notok &&
          notEnoughBalanceTripped &&
          !notEnoughBalanceShortCircuit &&
          this.isErrorNotEnoughBalance(request.reason)
        ) {
          // A REAL rejection of a probe opens/widens the window. Suppressed
          // attempts are excluded so the window can always expire.
          await notEnoughBalanceBackoff.record(
            [this.botId, notEnoughBalanceId],
            request.reason,
          )
        }
        if (
          request.status === StatusEnum.notok &&
          !complianceShortCircuit &&
          this.isComplianceGateable(order) &&
          this.getErrorSubType(request.reason) === complianceRestriction
        ) {
          // A REAL rejection from the venue (never a replayed one, or the window
          // would slide forever and never self-heal) opens/refreshes the window.
          await ComplianceGuard.record({
            exchangeUUID: `${this.data.exchangeUUID}`,
            symbol: requestData.symbol,
            reason: request.reason,
          })
        }
        if (
          request.status === StatusEnum.notok &&
          request.reason === 'Order not found after execution'
        ) {
          this.handleLog(
            `Order ${order.clientOrderId} not found after execution. Try again in 2s`,
          )
          await sleep(2000)
          request = await this.exchange.getOrder({
            symbol: requestData.symbol,
            newClientOrderId: requestData.newClientOrderId,
          })
        }
        if (request.status === StatusEnum.notok) {
          // Binance Futures Quantitative Rules (-4400) detection. Track the
          // violation per account+symbol, compute/refresh the cooldown, and
          // route to the DELAY path (soft-skip + deferred retry) instead of
          // hard-erroring the bot — repeatedly hammering Binance during a
          // restriction escalates the penalty (L1 -> L2 -> L3).
          if (
            this.isRealBinanceFutures &&
            !order.reduceOnly &&
            this.needToSendOrder(order) &&
            (this.getErrorSubType(request.reason) === exchangeRules ||
              request.reason.indexOf('-4400') !== -1)
          ) {
            const violation = await QuantRulesGuard.recordViolation({
              userId: this.userId,
              exchangeUUID: `${this.data.exchangeUUID}`,
              exchange: `${this.data.exchange}`,
              symbol: order.symbol,
              botId: this.data?.parentBotId || this.botId,
              botType: `${this.botType}`,
              dealId: order.dealId,
              reason: request.reason,
            })
            // Alert the user once per window (escalations alert again). The
            // handleErrors exchangeRules branch keeps this a non-erroring
            // warning; `force` bypasses the 24h same-subType de-dup so an
            // escalation still surfaces.
            if (violation.isNew) {
              await this.handleErrors(
                request.reason,
                'sendOrderToExchange()',
                `Send new order request ${order.clientOrderId}, qty ${order.origQty}, price ${order.price}, side ${order.side}`,
                false,
                true,
                true,
                true,
              )
            }
            // Clean up the local order record and defer a bounded retry that
            // re-checks the cooldown before re-sending (self-heals the skip).
            if (this.orders && this.orders.size > 0) {
              this.deleteOrder(order.clientOrderId)
              this.updateOrderOnDb({ ...order, status: 'CANCELED' })
            }
            this.endMethod(_id)
            if (returnError) {
              return request.reason
            }
            return this.scheduleQuantRulesRetry(order, returnError, {
              scope: violation.scope,
              level: violation.level,
              until: violation.until,
            })
          }
          if (
            request.reason.toLowerCase().indexOf('MARKET_LOT_SIZE') !== -1 &&
            order.type === 'MARKET' && [
              ExchangeEnum.paperBinance,
              ExchangeEnum.binance,
              ExchangeEnum.paperBinanceCoinm,
              ExchangeEnum.binanceCoinm,
              ExchangeEnum.paperBinanceUsdm,
              ExchangeEnum.binanceUsdm,
              ExchangeEnum.binanceUS,
            ] &&
            count <= 1
          ) {
            this.handleLog(
              `Binance MARKET_LOT_SIZE order ${order.clientOrderId} count ${count}`,
            )

            this.handleLog(
              `Binance MARKET_LOT_SIZE order ${order.clientOrderId} count ${count} update exchange info`,
            )
            await this.getExchangeInfo(order.symbol, true)
            this.handleLog(
              `Binance MARKET_LOT_SIZE order ${order.clientOrderId} count ${count} send order again`,
            )
            this.endMethod(_id)
            return this.sendOrderToExchange(order, returnError, count)
          }
          if (
            (request.reason.toLowerCase().indexOf('duplicate') !== -1 ||
              request.reason
                .toLowerCase()
                .indexOf('Client order id is not valid'.toLowerCase()) !== -1 ||
              request.reason
                .toLowerCase()
                .indexOf('Client order ID already exists'.toLowerCase()) !==
                -1 ||
              request.reason
                .toLowerCase()
                .indexOf('Duplicate clientOrderId'.toLowerCase()) !== -1 ||
              request.reason
                .toLowerCase()
                .indexOf('clientOid parameter repeated'.toLowerCase()) !==
                -1) &&
            count == 0
          ) {
            this.handleLog(`Order ${order.clientOrderId} is duplicate`)
            const findInCurrent = this.getOrderFromMap(order.clientOrderId)
            if (findInCurrent && findInCurrent?.orderId !== '-1') {
              this.handleLog(
                `${order.clientOrderId} returned as duplicate, but was received through stream`,
              )
              this.endMethod(_id)
              return findInCurrent
            }
            this.deleteOrder(order.clientOrderId)
            this.updateOrderOnDb({ ...order, status: 'CANCELED' })
            order.clientOrderId = `${order.clientOrderId.slice(
              0,
              order.clientOrderId.length - 1,
            )}2`
            this.endMethod(_id)
            return this.sendOrderToExchange(order, returnError, 1)
          }
          if (
            (((order.exchange === ExchangeEnum.kucoin ||
              order.exchange === ExchangeEnum.coinbase) &&
              count < 5) ||
              (order.exchange === ExchangeEnum.bybit && count < 2)) &&
            request.reason.toLowerCase().indexOf('balance') !== -1 &&
            !order.clientOrderId.includes('D-SR')
          ) {
            const timeout = order.exchange === ExchangeEnum.kucoin ? 500 : 1000
            this.handleLog(
              `${order.exchange} not enough balance, retry - ${
                count + 1
              } in ${timeout}ms, ${order.clientOrderId}`,
            )
            await sleep(timeout)
            this.endMethod(_id)
            return this.sendOrderToExchange(order, returnError, count + 1)
          }
          if (
            (order.exchange === ExchangeEnum.coinbase &&
              request.reason
                .toLocaleLowerCase()
                .indexOf('order not found after execution')) ||
            (order.exchange === ExchangeEnum.kucoin &&
              request.reason
                .toLocaleLowerCase()
                .indexOf('order does not exist. | 400100'))
          ) {
            const get = this.getOrderFromMap(order.clientOrderId)
            const findInCurrent = get && get.orderId !== '-1' ? get : undefined
            if (findInCurrent) {
              this.handleLog(
                `${order.clientOrderId} returned as not found, but was received through stream`,
              )
              this.endMethod(_id)
              return findInCurrent
            }
          }
          if (this.orders && this.orders.size > 0) {
            this.deleteOrder(order.clientOrderId)
            // Only persist a CANCELED record for an order that actually
            // reached the venue. When a local guard served the rejection the
            // order never existed anywhere but in this process, and
            // `updateOrderOnDb` UPSERTS on a clientOrderId that is freshly
            // minted per attempt — so every suppressed retry created a brand
            // new row describing an order that never was. Production carried
            // ~6.6k-10.7k such rows/hour, and 2.5M of them from ten bots
            // accounted for 20.3% of the whole `orders` collection.
            if (!notEnoughBalanceShortCircuit && !complianceShortCircuit) {
              this.updateOrderOnDb({ ...order, status: 'CANCELED' })
            }
          }
          if (returnError) {
            this.endMethod(_id)
            return request.reason
          }
          const setError = this.needToSendOrder(order)
          this.handleOrderErrors(
            request.reason,
            order,
            'limitOrders()',
            `Send new order request ${order.clientOrderId}, qty ${order.origQty}, price ${order.price}, side ${order.side}`,
            setError,
            setError,
          )
        }
        if (request.status === StatusEnum.ok) {
          processedOrder = request.data
          if (
            this.data.notEnoughBalance?.thresholdPassed &&
            (this.data.notEnoughBalance.orders?.[notEnoughBalanceId] ?? 0) > 0
          ) {
            this.updateNotEnoughBalanceErrors(order, 0, true)
          }
        }
      }
      if (processedOrder) {
        const find = this.getOrderFromMap(processedOrder?.clientOrderId)
        const ord = find || order

        if (this.kucoinFullFutures) {
          const cummulativeQuoteQty = `${
            +processedOrder.executedQty * +processedOrder.price
          }`
          if (!isNaN(+cummulativeQuoteQty) && isFinite(+cummulativeQuoteQty)) {
            processedOrder.cummulativeQuoteQty = cummulativeQuoteQty
          }
        }
        if (this.kucoinFutures) {
          processedOrder.executedQty =
            await this.convertOrderExecutedQty(processedOrder)
        }
        const orderType =
          processedOrder.type === 'MARKET' ||
          (processedOrder.fills?.length || 0) > 0 ||
          (processedOrder.price &&
            order.origPrice &&
            !isNaN(+processedOrder.price) &&
            isFinite(+processedOrder.price) &&
            !isNaN(+order.origPrice) &&
            isFinite(+order.origPrice) &&
            +processedOrder.price !== +order.origPrice) ||
          (processedOrder.cummulativeQuoteQty &&
            !isNaN(+processedOrder.cummulativeQuoteQty) &&
            isFinite(+processedOrder.cummulativeQuoteQty) &&
            order.origPrice &&
            !isNaN(+order.origPrice) &&
            isFinite(+order.origPrice) &&
            processedOrder.executedQty &&
            !isNaN(+processedOrder.executedQty) &&
            isFinite(+processedOrder.executedQty) &&
            +processedOrder.cummulativeQuoteQty &&
            +processedOrder.executedQty &&
            +order.origPrice &&
            this.math.round(
              +processedOrder.cummulativeQuoteQty / +processedOrder.executedQty,
              ed?.priceAssetPrecision,
            ) !== +order.origPrice)
            ? OrderTypeEnum.market
            : OrderTypeEnum.limit
        let price =
          orderType === OrderTypeEnum.limit
            ? ord.price
            : processedOrder.cummulativeQuoteQty &&
                processedOrder.cummulativeQuoteQty !== '0' &&
                processedOrder.executedQty &&
                processedOrder.executedQty !== '0'
              ? `${
                  (processedOrder.cummulativeQuoteQty
                    ? parseFloat(processedOrder.cummulativeQuoteQty)
                    : +processedOrder.price * +processedOrder.executedQty) /
                  parseFloat(processedOrder.executedQty)
                }`
              : processedOrder.avgPrice && processedOrder.avgPrice !== '0'
                ? processedOrder.avgPrice
                : processedOrder.fills && processedOrder.fills.length > 0
                  ? `${
                      processedOrder.fills.reduce(
                        (acc, f) =>
                          acc + parseFloat(f.price) * parseFloat(f.qty),
                        0,
                      ) /
                      processedOrder.fills.reduce(
                        (acc, f) => acc + parseFloat(f.qty),
                        0,
                      )
                    }`
                  : (processedOrder.price ?? ord.price)
        if (isNaN(parseFloat(price)) || price === '0') {
          price = ord.price
        }
        let forceUpdate = false
        if (
          !skipBr &&
          !(this.kucoinFutures || this.okx || (this.coinm && !this.isBitget)) &&
          [ExchangeEnum.bybit].includes(this.data.exchange) &&
          requestData.type === 'MARKET' &&
          ['CANCELED'].includes(processedOrder.status) &&
          +processedOrder.price * +processedOrder.executedQty > 0
        ) {
          const origExecutedQty = +processedOrder.executedQty
          processedOrder = await this.fillPartiallyFilledOrder({
            ...processedOrder,
            exchange: order.exchange,
            exchangeUUID: order.exchangeUUID,
            typeOrder: order.typeOrder,
            botId: order.botId,
            userId: order.userId,
            baseAsset: order.baseAsset,
            quoteAsset: order.quoteAsset,
            origPrice: order.origPrice,
            dealId: order.dealId,
            minigridBudget: order.minigridBudget,
            tpSlTarget: order.tpSlTarget,
            dcaLevel: order.dcaLevel,
            minigridId: order.minigridId,
            addFundsId: order.addFundsId,
            liquidation: order.liquidation,
            sl: order.sl,
          })
          const newExecutedQty = +processedOrder.executedQty
          forceUpdate = origExecutedQty < newExecutedQty
        }
        const orderToPush: Order = {
          ...ord,
          ...processedOrder,
          status:
            ord.status !== 'NEW'
              ? ord.status === 'FILLED' || processedOrder.status === 'FILLED'
                ? 'FILLED'
                : ord.status
              : processedOrder.status,
          updateTime: Math.max(
            ord.updateTime,
            processedOrder.updateTime ||
              processedOrder.transactTime ||
              new Date().getTime(),
          ),
          transactTime: processedOrder.transactTime || ord.transactTime,
          type: orderType,
          price,
          origQty: order.origQty,
        }
        if (
          [ExchangeEnum.bybit].includes(order.exchange) &&
          order.type === 'MARKET' &&
          ((+order.executedQty !== 0 && order.status === 'CANCELED') ||
            (!this.coinm &&
              order.status === 'PARTIALLY_FILLED' &&
              Math.abs(
                +order.price * +order.executedQty -
                  +order.origPrice * +order.origQty,
              ) < (ed?.quoteAsset.minAmount ?? 0)))
        ) {
          order.status = 'FILLED'
        }
        if (!this.kucoinFutures) {
          orderToPush.executedQty =
            await this.convertOrderExecutedQty(orderToPush)
        }
        this.setOrder(orderToPush)
        this.handleLog(`Save order ${order.clientOrderId}`)
        this.botEventDb.createData({
          userId: this.userId,
          botId: this.botId,
          event: 'Order',
          botType: this.botType,
          description: `Order created, orderId: ${
            orderToPush.clientOrderId
          }, symbol: ${requestData.symbol}, side: ${
            requestData.side
          }, quantity: ${requestData.quantity}, price: ${
            requestData.price
          }, type: ${requestData.type}${
            this.futures
              ? `, reduce: ${
                  requestData.reduceOnly ? 'true' : 'false'
                }, position side: ${requestData.positionSide}`
              : ''
          }`,
          paperContext: !!this.data?.paperContext,
          deal: orderToPush.dealId,
          symbol: orderToPush.symbol,
        })
        this.emit('bot update', orderToPush)

        this.updateOrderOnDb(orderToPush, force || forceUpdate)
        this.endMethod(_id)
        return orderToPush
      }
      this.endMethod(_id)
    }
  }

  /**
   * Cancel grid on exchange
   */

  async cancelGridOnExchange(
    order: Grid,
    cancelPartiallyFilled = false,
    removeFromLocal = true,
  ) {
    const find = this.getOrdersByStatusAndDealId({
      status: cancelPartiallyFilled ? ['NEW', 'PARTIALLY_FILLED'] : 'NEW',
      dealId: order.dealId,
    })?.find(
      (orderT) =>
        parseFloat(orderT.price) === order.price &&
        (parseFloat(orderT.origQty) === order.qty ||
          (orderT.tpSlTarget &&
            order.tpSlTarget &&
            orderT.tpSlTarget === order.tpSlTarget)) &&
        orderT.side === order.side,
    )
    if (find) {
      const result = await this.cancelOrderOnExchange(
        find,
        true,
        removeFromLocal,
      )
      return result
    }
  }

  async setFilledInsteadOfCanceled(_order: Order): Promise<boolean> {
    return true
  }

  /**
   * Cancel order on exchange
   */

  async cancelOrderOnExchange(
    order: Order,
    setErrors = true,
    removeFromLocal = true,
  ) {
    const _id = this.startMethod('cancelOrderOnExchange')
    if (this.exchange) {
      const request = await this.exchange.cancelOrder({
        symbol: order.symbol,
        newClientOrderId:
          this.data?.exchange === ExchangeEnum.coinbase ||
          this.kucoinFullFutures
            ? `${order.orderId}`
            : order.clientOrderId,
      })
      if (request.status === StatusEnum.notok) {
        for (const m of unknownOrderMessages) {
          if (request.reason.toLowerCase().indexOf(m.toLowerCase()) !== -1) {
            this.handleLog(
              `Send cancel request ${order.clientOrderId}. Order not found`,
            )
            this.endMethod(_id)
            return await this._handleUnknownOrder(
              order.clientOrderId,
              order.symbol,
            )
          }
        }
        if (
          request.reason.indexOf('Order cancellation in progress') !== -1 ||
          request.reason.indexOf(
            'Cancellation failed as the order is already under cancelling status',
          ) !== -1 ||
          request.reason.indexOf('DUPLICATE_CANCEL_REQUEST') !== -1
        ) {
          this.handleDebug(
            `Cancellation in progress ${order.clientOrderId}. Sleep 5s`,
          )
          await sleep(5000)
          this.endMethod(_id)
          return await this._handleUnknownOrder(
            order.clientOrderId,
            order.symbol,
          )
        }
        this.handleErrors(
          request.reason,
          'limitOrders()',
          `Send cancel request ${order.clientOrderId}`,
          setErrors,
          setErrors,
        )
      }
      if (request.status === StatusEnum.ok) {
        if (this.orders) {
          Object.keys(order).map((key) => {
            if (Object.prototype.hasOwnProperty.call(request.data, key)) {
              if (
                key !== 'clientOrderId' &&
                key !== 'origQty' &&
                key !== 'origPrice'
              ) {
                //@ts-ignore
                order[key] = request.data[key]
              }
            }
          })
          if (+order.executedQty !== 0 && order.status === 'CANCELED') {
            if (await this.setFilledInsteadOfCanceled(order)) {
              order.status = 'FILLED'
            }
            order.executedQty = await this.convertOrderExecutedQty(order)
          }
          if (order.updateTime === -1) {
            order.updateTime = request.data.updateTime
          }
          if (order.transactTime === -1) {
            order.transactTime = request.data.transactTime
          }
          this.emit('bot update', order)
          this.setOrder(order)
          if (removeFromLocal && +request.data.executedQty === 0) {
            this.deleteOrder(order.clientOrderId)
          }
          this.updateOrderOnDb(order)
          this.endMethod(_id)
          return order
        }
      }
    }
    this.endMethod(_id)
  }

  /**
   * Save order to db
   */

  async saveOrderToDb(order: Order) {
    await this.ordersDb
      .createData({
        ...order,
        paperContext: Boolean(this.data?.paperContext),
        leverage: this.futures ? this.currentLeverage : undefined,
      })
      .then((res) => {
        if (res.status === StatusEnum.notok) {
          if ((`${res.reason}` || '').indexOf('E11000') !== -1) {
            this.handleDebug(`Order ${order.clientOrderId} already saved`)
          } else {
            this.handleErrors(
              res.reason,
              'limitOrders()',
              `Error saving order ${order.clientOrderId}`,
              false,
              false,
              false,
            )
          }
        }
      })
  }

  /**
   * Update order on db
   */

  async updateOrderOnDb(order: Order, force?: boolean) {
    const o: Partial<Order> = { ...order }
    delete o._id
    delete o.origQty
    delete o.origPrice
    const filter: Record<string, unknown> = {
      clientOrderId: o.clientOrderId,
      $and: [{ status: { $ne: 'FILLED' } }, { status: { $ne: 'CANCELED' } }],
    }
    if (force) {
      delete filter.$and
    }
    // An order whose in-memory copy has no quarantine must not keep one in the
    // DB. Both paths that clear it — `mergeCommonOrderWithOrder` rebuilding
    // from a successful lookup, and the user-stream converter — produce an
    // object with the key simply absent, which a `$set`-shaped update leaves
    // untouched. Without the explicit `$unset`, an order that recovered would
    // be re-quarantined the next time orders were loaded from Mongo.
    const update = o.quarantine
      ? { ...o }
      : { ...o, $unset: { quarantine: '' as const } }
    await this.ordersDb.updateData(filter, update, false, true).then((res) => {
      if (res.status === StatusEnum.notok) {
        return this.handleErrors(
          res.reason,
          'limitOrders()',
          `Error saving order ${o.clientOrderId}`,
          false,
          false,
          false,
        )
      }
    })
  }
  /** Map order to grid */

  mapOrderToGrid(o: Order, updateId = true): Grid {
    return {
      number: 1,
      price: +o.price,
      side: o.side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
      newClientOrderId: updateId
        ? this.getOrderId(
            o.dealId
              ? o.typeOrder === TypeOrderEnum.dealTP
                ? 'D-TP'
                : this.botType === BotType.combo
                  ? o.typeOrder === TypeOrderEnum.dealRegular
                    ? 'CMB-RO'
                    : 'CMB-GR'
                  : 'D-RO'
              : 'GRID-RO',
          )
        : o.clientOrderId,
      type: o.typeOrder,
      qty: +o.origQty,
      dealId: o.dealId,
      minigridId: o.minigridId,
      dcaLevel: o.dcaLevel,
      minigridBudget: o.minigridBudget,
    }
  }

  mapGridToOrder(
    g: Grid,
    additionalParams: {
      dealId?: string
      type: OrderTypeT
      reduceOnly?: boolean
      positionSide?: PositionSide
    },
    ed: ClearPairsSchema,
  ): Order {
    const response: Order = {
      clientOrderId: g.newClientOrderId,
      status: 'NEW' as 'NEW',
      executedQty: '0',
      price: `${g.price}`,
      origPrice: `${g.price}`,
      cummulativeQuoteQty: `${g.price * g.qty}`,
      orderId: '-1',
      origQty: `${g.qty}`,
      side: g.side,
      symbol: ed.pair,
      baseAsset: ed.baseAsset.name,
      quoteAsset: ed.quoteAsset.name,
      updateTime: new Date().getTime(),
      exchange: this.data?.exchange ?? ExchangeEnum.binance,
      exchangeUUID: this.data?.exchangeUUID ?? '',
      typeOrder: g.type,
      botId: this.botId,
      userId: this.userId,
      transactTime: new Date().getTime(),
      fills: [],
      tpSlTarget: g.tpSlTarget,
      dcaLevel: g.dcaLevel,
      minigridId: g.minigridId,
      ...additionalParams,
    }
    if (response.price.indexOf('e') !== -1) {
      response.price = this.math.convertFromExponential(
        response.price,
        ed.priceAssetPrecision,
      )
      response.origPrice = this.math.convertFromExponential(
        response.origPrice,
        ed.priceAssetPrecision,
      )
    }
    return response
  }

  /** Convert order to event message */

  convertOrderToEventMessage(order: Order): ExecutionReport {
    return {
      ...order,
      eventType: 'executionReport',
      eventTime: order.updateTime,
      creationTime: order.updateTime,
      newClientOrderId: order.clientOrderId,
      orderStatus: order.status,
      orderType: order.type,
      orderTime: order.updateTime,
      originalClientOrderId: order.clientOrderId,
      totalQuoteTradeQuantity: order.cummulativeQuoteQty
        ? order.cummulativeQuoteQty
        : `${+order.price * +order.executedQty}`,
      totalTradeQuantity: order.executedQty,
      quantity: order.executedQty,
    }
  }

  /**
   * Some venues pool every collateral currency into ONE cross-margin account
   * (Kraken Futures' flex account), so the quote asset can read 0 while the
   * account is perfectly able to open the deal — a wallet funded only in EUR
   * still margins a USD-quoted perpetual off that EUR. Sizing off the quote
   * balance alone rejects those deals with "available: 0 USD".
   *
   * Consulted ONLY after the plain quote-balance check has already failed, so
   * the common path costs no extra request. Returns `available` unchanged for
   * every non-pooled venue and on any error: a venue with no opinion must
   * never widen or block sizing. The pooled figure is USD-denominated, so it
   * is trusted only when USD actually is the quote asset.
   */
  protected async pooledMarginOrKeep(
    quoteAsset: string,
    available: number,
  ): Promise<number> {
    if (!this.futures || this.coinm || quoteAsset !== 'USD' || !this.exchange) {
      return available
    }
    const res = await this.exchange.getMarginAvailableUsd()
    if (res.status !== StatusEnum.ok || typeof res.data !== 'number') {
      return available
    }
    // The venue already nets margin committed to open positions, so this is
    // what can actually be committed now. Never shrink what the caller found.
    return Math.max(available, res.data)
  }

  /**
   * Spendable quote for the not-enough-balance latch on a pooled-collateral
   * futures account (Kraken Futures' flex account).
   *
   * The cached `balances` doc carries a per-asset `free`/`locked` split, and on
   * a pooled account that split cannot represent anything the venue enforces:
   * every collateral currency margins every contract, so no writer can derive a
   * per-asset reservation from what Kraken publishes. Both writers of that doc
   * invented one anyway, in opposite directions — the REST path reports the
   * whole wallet quantity as free, the user stream reported
   * `quantity - available` as locked — so the latch's answer depended on which
   * write landed last. On prod that flip-flopped between "50 USD free" and
   * "4.64 USD free" for the same 50 USD account.
   *
   * `availableMargin` is the venue's own figure and the only one it enforces at
   * order time, so here it REPLACES the per-asset `free` instead of widening
   * it. `pooledMarginOrKeep`'s `Math.max` is right for deal sizing — a venue
   * with no opinion must never shrink it — but wrong for a latch: a figure that
   * only ever widens would clear the guard on a number the venue goes on to
   * reject, which is exactly the rejection loop this replaces.
   *
   * Returns the cached `free` unchanged for every non-pooled venue and on any
   * error, so nothing outside Kraken Futures changes behaviour.
   */
  protected async spendableForNotEnoughBalance(
    quoteAsset: string,
    cachedFree: number,
  ): Promise<number> {
    if (!this.futures || this.coinm || quoteAsset !== 'USD' || !this.exchange) {
      return cachedFree
    }
    const now = +new Date()
    const memo = this.pooledMarginMemo
    if (memo && now - memo.at < pooledMarginMemoTtl) {
      return memo.value ?? cachedFree
    }
    const res = await this.exchange.getMarginAvailableUsd()
    if (res.status !== StatusEnum.ok || typeof res.data !== 'number') {
      // No opinion: remember that too, so the error message this attempt goes
      // on to build doesn't re-ask a venue that just declined to answer.
      this.pooledMarginMemo = { value: null, at: now }
      return cachedFree
    }
    this.pooledMarginMemo = { value: res.data, at: now }
    return res.data
  }

  get futures() {
    return !!this.data?.settings.futures
  }

  get coinm() {
    return !!this.data?.settings.coinm
  }

  get currentLeverage() {
    return this.futures
      ? this.data?.settings.marginType !== BotMarginTypeEnum.inherit
        ? (this.data?.settings.leverage ?? 1)
        : 1
      : 1
  }

  get okx() {
    return (
      this.data?.exchange === ExchangeEnum.okx ||
      this.data?.exchange === ExchangeEnum.okxInverse ||
      this.data?.exchange === ExchangeEnum.okxLinear
    )
  }

  get hyperliquid() {
    return (
      this.data?.exchange === ExchangeEnum.hyperliquid ||
      this.data?.exchange === ExchangeEnum.hyperliquidLinear
    )
  }

  get mexc() {
    return this.data?.exchange === ExchangeEnum.mexc
  }

  get kucoinFutures() {
    return this.data?.exchange === ExchangeEnum.kucoinLinear
  }

  get kucoinFullFutures() {
    return (
      this.data?.exchange === ExchangeEnum.kucoinLinear ||
      this.data?.exchange === ExchangeEnum.kucoinInverse
    )
  }

  get kucoinSpot() {
    return this.data?.exchange === ExchangeEnum.kucoin
  }

  get krakenSpot() {
    return this.data?.exchange === ExchangeEnum.kraken
  }

  /**
   * True only for REAL Binance USD-M / COIN-M futures — the accounts Binance's
   * Quantitative Rules (-4400) actually restrict. Excludes spot Binance and all
   * paper variants (paper never trips -4400), so the cooldown guard never gates
   * simulated or spot orders.
   */
  get isRealBinanceFutures() {
    return (
      this.data?.exchange === ExchangeEnum.binanceUsdm ||
      this.data?.exchange === ExchangeEnum.binanceCoinm
    )
  }

  async getOKXDenominator(symbol: string) {
    const ed = await this.getExchangeInfo(symbol)
    const toUse =
      this.data?.exchange === ExchangeEnum.okxLinear
        ? (ed?.baseAsset.multiplier ?? ed?.baseAsset.step)
        : ed?.baseAsset.step
    return toUse !== undefined && toUse > 1
      ? 1 / toUse
      : +`1${'0'.repeat(this.math.getPricePrecision(`${toUse}`))}`
  }

  async generateBasicGrids({
    pair,
    topPrice,
    lowPrice,
    sellDisplacement,
    gridType,
    levels,
  }: {
    levels: number
    pair: string
    topPrice: number
    lowPrice: number
    sellDisplacement: number
    gridType: GridType
  }): Promise<InitialGrid[] | null> {
    const grids: InitialGrid[] = []
    if (!this.data) {
      this.handleWarn(`Data not found in generate basic grids`)
      return null
    }
    const exchangeInfo = await this.getExchangeInfo(pair)
    if (!exchangeInfo) {
      this.handleWarn(
        `Exchange info not found in generate basic grids for ${pair}`,
      )
      return null
    }
    let currentGrid = 0
    const prices: { buy: number; sell: number }[] = []
    if (gridType === 'arithmetic') {
      const step = (topPrice - lowPrice) / levels
      for (let i = 0; i <= levels; i++) {
        const p = this.math.round(
          Math.max(
            lowPrice + step * i,
            exchangeInfo.priceAssetPrecision === 0
              ? 1
              : +`0.${'0'.repeat(exchangeInfo.priceAssetPrecision - 1)}1`,
          ),
          exchangeInfo.priceAssetPrecision,
        )
        prices.push({
          buy: this.math.round(p, exchangeInfo.priceAssetPrecision),
          sell: this.math.round(
            p * (1 + sellDisplacement),
            exchangeInfo.priceAssetPrecision,
          ),
        })
      }
    } else if (gridType === 'geometric') {
      const newGS = Math.pow(topPrice / lowPrice, 1 / levels) - 1
      for (
        let i = this.math.round(
          Math.max(
            lowPrice,
            exchangeInfo.priceAssetPrecision === 0
              ? 1
              : +`0.${'0'.repeat(exchangeInfo.priceAssetPrecision - 1)}1`,
          ),
          exchangeInfo.priceAssetPrecision,
        );
        i <= topPrice * (1 + newGS / 2);
        i = i * (1 + newGS)
      ) {
        prices.push({
          buy: this.math.round(i, exchangeInfo.priceAssetPrecision),
          sell: this.math.round(
            i * (1 + sellDisplacement),
            exchangeInfo.priceAssetPrecision,
          ),
        })
      }
    }
    prices.map((p) => {
      grids.push({
        number: currentGrid,
        price: p,
        type: TypeOrderEnum.regular,
      })
      currentGrid++
    })
    return grids
  }

  getSellBuyCount(
    latestPrice: number,
    _grids: InitialGrid[] | null,
    levels: number,
  ): getSellBuyCountReturn {
    const grids = _grids || []
    const prices = grids.map((g) => g.price)
    const newLogic =
      this.data?.created &&
      new Date(this.data.created).getTime() > 1691020800000
    const sells = prices.filter((p) =>
      newLogic ? p.buy >= latestPrice : p.sell > latestPrice,
    )
    const buys = prices.filter((p) => p.buy < latestPrice)
    let sellCount = sells.length
    let buyCount = buys.length
    if (sellCount > 0 && buyCount > 0) {
      if (
        Math.abs(sells[0].sell - latestPrice) >
        Math.abs(buys[buys.length - 1].buy - latestPrice)
      ) {
        buys.splice(buys.length - 1, 1)
      } else {
        sells.splice(0, 1)
      }
    }
    if (sellCount > 0 && buyCount === 0 && sellCount > levels) {
      sells.splice(0, 1)
    }
    if (buyCount > 0 && sellCount === 0 && buyCount > levels) {
      buys.splice(buys.length - 1, 1)
    }
    sellCount = sells.length
    buyCount = buys.length
    return { sellCount, buyCount, buys, sells }
  }
  /**
   * Find closest grids to current price <br />
   *
   * Used in use smart orders case<br />
   *
   * Amount of closest grids fixed by bot settings ordersInAdvance <br />
   *
   * If ordersInAdvance is even buy and sell orders amount must be equal <br />
   *
   * If not equal, e.g. ordersInAdvance = 8, buy = 5, sell = 3, check if there is enough orders to fill result array and replce orders in result array, e.g. left sell orders > 3, if it is enough remove the last from buy array and place another one from sell array
   * @param {Grid[]} grids all grids
   * @param {number} latestPrice price for which need to find closeset grids
   * @returns {Grid[]} closest grids to current price
   */

  findClosestGrids({
    grids,
    latestPrice,
    ordersInAdvance,
    useOrderInAdvance,
    initialGrids,
  }: {
    useOrderInAdvance?: boolean
    ordersInAdvance?: number
    grids: Grid[]
    latestPrice: number
    initialGrids: InitialGrid[] | null
  }): Grid[] {
    if (ordersInAdvance && useOrderInAdvance && initialGrids) {
      let arrayResult: Grid[] = []
      let copyArray = [...grids].sort((a, b) => a.price - b.price)
      const maxNumber =
        ordersInAdvance > copyArray.length ? copyArray.length : ordersInAdvance
      do {
        const result = copyArray.sort((a, b) => {
          return (
            Math.abs(latestPrice - a.price) - Math.abs(latestPrice - b.price)
          )
        })
        copyArray = copyArray.filter((v) => v !== result[0])
        arrayResult.push(result[0])
      } while (arrayResult.length < maxNumber)
      let sellCount = 0
      let buyCount = 0
      arrayResult = arrayResult.sort((a, b) => a.price - b.price)
      arrayResult.map((r) => {
        if (r.side === OrderSideEnum.sell) {
          sellCount++
        } else {
          buyCount++
        }
      })
      const prices = initialGrids.map((g) => ({ ...g.price }))
      let num =
        (ordersInAdvance % 2 === 0 ? ordersInAdvance : ordersInAdvance - 1) / 2
      copyArray = copyArray.sort((a, b) => a.price - b.price)
      if ((buyCount < num || sellCount < num) && prices.length > num) {
        const sellLeft = prices.filter((p) => p.buy > latestPrice).length
        const buyLeft = prices.filter((p) => p.buy < latestPrice).length
        num = Math.min(sellLeft, num)
        if (
          prices[prices.length - num] &&
          prices[prices.length - num].buy > latestPrice &&
          sellCount < num
        ) {
          const neededSell = num - sellCount
          const sellArray = copyArray.filter(
            (o) => o.side === OrderSideEnum.sell,
          )
          arrayResult.splice(0, neededSell)
          arrayResult = [...arrayResult, ...sellArray.splice(0, neededSell)]
        }
        num = Math.min(buyLeft, num)
        if (prices[num] && prices[num].buy < latestPrice && buyCount < num) {
          const neededBuy = num - buyCount
          const buyArray = copyArray.filter((o) => o.side === OrderSideEnum.buy)
          arrayResult.splice(arrayResult.length - neededBuy, neededBuy)
          arrayResult = [
            ...arrayResult,
            ...buyArray.splice(buyArray.length - neededBuy, neededBuy),
          ]
        }
      }
      return arrayResult.sort((a, b) => a.price - b.price)
    }
    return grids
  }

  async generateGridsOnPrice(
    {
      pair,
      initialGrids,
      lowPrice,
      topPrice,
      levels,
      updatedBudget,
      _budget,
      _lastPrice,
      _initialPriceStart,
      _side,
      noslice,
      all,
      ordersInAdvance,
      useOrderInAdvance,
      profitCurrency,
      orderFixedIn,
    }: {
      pair: string
      initialGrids: InitialGrid[] | null
      lowPrice: number
      topPrice: number
      levels: number
      updatedBudget?: boolean
      _budget: number
      _lastPrice: number
      _initialPriceStart?: number
      _side: OrderSideEnum
      noslice?: boolean
      all?: boolean
      useOrderInAdvance?: boolean
      ordersInAdvance?: number
      profitCurrency: Currency
      orderFixedIn: Currency
    },
    feeToSell = false,
    newBalance = false,
    overrideRound?: boolean,
    newSell = false,
  ) {
    if (!this.data) {
      return
    }
    const { futures } = this.data.settings
    const ed = await this.getExchangeInfo(pair)
    const fee = await this.getUserFee(pair)
    if (initialGrids && ed && this.data && fee) {
      const budget = updatedBudget ? _budget : _budget / (1 + fee.maker * 100)
      const f = this.futures
        ? 1
        : typeof overrideRound !== 'undefined'
          ? 1
          : 1 + fee.maker
      const grids: Grid[] = []
      let qty = 0
      let buyQty = 0
      let sellQty = 0
      const symbol = ed
      const quotedAssetPrecision = await this.baseAssetPrecision(pair)
      const gs = Math.pow(topPrice / lowPrice, 1 / levels) - 1
      const updateTime = 1655821200000
      const combo = this.botType === BotType.combo
      let lastPrice = _lastPrice
      if (
        this.data.created &&
        new Date(this.data.created).getTime() > updateTime
      ) {
        let initialPriceStart = _initialPriceStart
        if (!initialPriceStart) {
          initialPriceStart = lastPrice
        }
        const { sellCount, buyCount, buys, sells } = this.getSellBuyCount(
          initialPriceStart,
          initialGrids,
          levels,
        )
        let quoteAmount = 0
        let baseAmount = 0
        if (profitCurrency === 'base') {
          if (orderFixedIn === 'base') {
            let tempSellQty = this.math.round(
              budget /
                (initialPriceStart * sellCount +
                  buys.reduce((acc, v) => (acc += v.buy), 0) * (1 + gs)),
              quotedAssetPrecision,
              true,
            )
            if (
              tempSellQty <
              symbol.quoteAsset.minAmount / initialGrids[0].price.buy
            ) {
              tempSellQty = this.math.round(
                (symbol.quoteAsset.minAmount * 1.1) / initialGrids[0].price.buy,
                quotedAssetPrecision,
                false,
                true,
              )
            }
            sellQty = tempSellQty
            if (sellQty < symbol.baseAsset.minAmount) {
              sellQty = symbol.baseAsset.minAmount
            }
            buyQty = this.math.round(
              tempSellQty * (1 + gs) * f,
              quotedAssetPrecision,
              false,
              true,
            )
            if (buyQty < symbol.baseAsset.minAmount) {
              buyQty = this.math.round(
                symbol.baseAsset.minAmount * f,
                quotedAssetPrecision,
                false,
                true,
              )
            }
          }
        }
        const baseQuote = profitCurrency === 'base' && orderFixedIn === 'quote'
        if (
          (profitCurrency === 'quote' && orderFixedIn === 'quote') ||
          baseQuote
        ) {
          quoteAmount =
            budget /
            (sells.reduce((acc, v) => (acc += 1 / v.sell), 0) *
              (sellCount && newSell && baseQuote
                ? sells.reduce((acc, a) => acc + a.sell, 0) / sellCount
                : initialPriceStart) +
              buyCount * f)
          if (isNaN(quoteAmount) || !isFinite(quoteAmount) || !quoteAmount) {
            quoteAmount =
              budget /
              (sells.reduce((acc, v) => (acc += 1 / v.sell), 0) *
                initialPriceStart +
                buyCount * f)
          }
          if (quoteAmount < symbol.quoteAsset.minAmount) {
            quoteAmount = symbol.quoteAsset.minAmount * f
          }
        }
        if (profitCurrency === 'quote') {
          if (orderFixedIn === 'base') {
            const lowest =
              [...initialGrids].sort((a, b) => a.price.buy - b.price.buy)[0]
                ?.price?.buy || 0
            baseAmount = futures
              ? budget /
                (buys.reduce((acc, v) => acc + v.buy, 0) +
                  sells.reduce((acc, v) => acc + v.sell, 0))
              : budget /
                (sellCount * initialPriceStart +
                  buys.reduce((acc, v) => acc + v.buy, 0))
            const round = this.math.round(
              baseAmount,
              quotedAssetPrecision,
              combo,
            )
            if (round < symbol.quoteAsset.minAmount / lowest) {
              baseAmount = this.math.round(
                symbol.quoteAsset.minAmount / lowest,
                quotedAssetPrecision,
                false,
                true,
              )
            }
          }
        }
        if (this.coinm && !this.isBitget) {
          baseAmount = budget / +levels
        }
        const basicInitialGrid = initialGrids.find((g) =>
          _side === OrderSideEnum.buy
            ? lastPrice === g.price.buy
            : lastPrice === g.price.sell,
        )
        lastPrice = basicInitialGrid?.price?.buy ?? _lastPrice
        let i = 0
        for (const g of initialGrids) {
          if (initialGrids) {
            const side =
              g.price.buy > lastPrice ? OrderSideEnum.sell : OrderSideEnum.buy
            const p = side === OrderSideEnum.buy ? g.price.buy : g.price.sell
            const same =
              (this.botType === BotType.combo ? !futures : true) &&
              (profitCurrency === orderFixedIn ||
                (profitCurrency === 'base' && orderFixedIn === 'quote'))
            if (profitCurrency === 'base') {
              if (orderFixedIn === 'quote') {
                buyQty = this.math.round(
                  (quoteAmount / p) * f,
                  quotedAssetPrecision,
                  false,
                  overrideRound ?? !this.futures,
                )
                if (buyQty < symbol.baseAsset.minAmount) {
                  buyQty = this.math.round(
                    symbol.baseAsset.minAmount * f,
                    quotedAssetPrecision,
                    false,
                    overrideRound ?? !this.futures,
                  )
                }
                if (i !== 0) {
                  const prevBuyQty = this.math.round(
                    quoteAmount / initialGrids[i - 1].price.buy,
                    quotedAssetPrecision,
                    false,
                    overrideRound ?? !this.futures,
                  )
                  sellQty = this.math.round(
                    (prevBuyQty * initialGrids[i - 1].price.buy) / p,
                    quotedAssetPrecision,
                  )
                  if (prevBuyQty - sellQty < symbol.baseAsset.step) {
                    sellQty = this.math.round(
                      prevBuyQty - symbol.baseAsset.step,
                      quotedAssetPrecision,
                    )
                  }
                  if (sellQty < symbol.baseAsset.minAmount) {
                    sellQty = symbol.baseAsset.minAmount
                  }
                }
              }
            }
            if (profitCurrency === 'quote') {
              if (orderFixedIn === 'quote') {
                buyQty = this.math.round(
                  (quoteAmount / p) * (feeToSell ? 1 : f),
                  quotedAssetPrecision,
                  overrideRound ?? (!futures && feeToSell),
                  overrideRound ?? !futures,
                )
                if (buyQty * p < symbol.quoteAsset.minAmount) {
                  buyQty = this.math.round(
                    (symbol.quoteAsset.minAmount / p) * (feeToSell ? 1 : f),
                    quotedAssetPrecision,
                    overrideRound ?? (!futures && feeToSell),
                    overrideRound ?? !futures,
                  )
                }
                if (buyQty < symbol.baseAsset.minAmount) {
                  buyQty = this.math.round(
                    symbol.baseAsset.minAmount * (feeToSell ? 1 : f),
                    quotedAssetPrecision,
                    overrideRound ?? (!futures && feeToSell),
                    overrideRound ?? !futures,
                  )
                }
                if (i !== 0) {
                  sellQty = this.math.round(
                    (quoteAmount / initialGrids[i - 1].price.buy) *
                      (feeToSell ? 2 - f : 1),
                    quotedAssetPrecision,
                    overrideRound ?? !futures,
                  )
                  if (sellQty * p < symbol.quoteAsset.minAmount) {
                    sellQty = this.math.round(
                      (symbol.quoteAsset.minAmount /
                        initialGrids[i - 1].price.buy) *
                        (feeToSell ? 2 - f : 1),
                      quotedAssetPrecision,
                      overrideRound ?? !futures,
                    )
                  }
                } else {
                  sellQty = this.math.round(
                    ((buyQty * (1 + gs)) / (feeToSell ? 1 : f)) *
                      (feeToSell ? 2 - f : 1),
                    quotedAssetPrecision,
                    overrideRound ?? !futures,
                  )
                }
                if (sellQty < symbol.baseAsset.minAmount) {
                  sellQty = symbol.baseAsset.minAmount
                }
              }
            }

            if (profitCurrency === 'quote') {
              if (orderFixedIn === 'base') {
                qty = this.math.round(
                  baseAmount,
                  quotedAssetPrecision,
                  combo,
                  overrideRound ?? !this.futures,
                )
              }
            }
            if (this.coinm && !this.isBitget) {
              qty = this.math.round(baseAmount, quotedAssetPrecision)
            }
            if (qty < symbol.baseAsset.minAmount) {
              qty = symbol.baseAsset.minAmount
            }
            if (side === OrderSideEnum.buy && !this.futures) {
              qty = this.math.round(
                qty * f,
                quotedAssetPrecision,
                false,
                overrideRound ?? !this.futures,
              )
            }
            let gridQty = same
              ? side === OrderSideEnum.sell
                ? sellQty
                : buyQty
              : qty
            const mod = newBalance
              ? this.math.remainder(gridQty, symbol.baseAsset.step)
              : gridQty % symbol.baseAsset.step
            if (mod > Number.EPSILON) {
              gridQty = this.math.round(
                gridQty - mod + symbol.baseAsset.step,
                quotedAssetPrecision,
                false,
                overrideRound ?? true,
              )
            }
            const grid = {
              ...g,
              price: p,
              side,
              qty: gridQty,
              newClientOrderId: this.getOrderId(`GRID-RO`),
            }
            if (grid.qty * grid.price < symbol.quoteAsset.minAmount) {
              grid.qty = this.math.round(
                symbol.quoteAsset.minAmount / grid.price,
                await this.baseAssetPrecision(pair),
                false,
                true,
              )
            }
            if (grid.qty < symbol.baseAsset.minAmount) {
              grid.qty = symbol.baseAsset.minAmount
            }
            if (this.coinm && !this.isBitget) {
              const cont = (grid.price * grid.qty) / symbol.quoteAsset.minAmount
              if (cont < 1) {
                grid.qty = this.math.round(
                  symbol.quoteAsset.minAmount / grid.price,
                  quotedAssetPrecision,
                  false,
                  true,
                )
              } else if (cont % 1 > Number.EPSILON) {
                grid.qty = this.math.round(
                  (this.math.round(cont, 0) * symbol.quoteAsset.minAmount) /
                    grid.price,
                  quotedAssetPrecision,
                  false,
                  true,
                )
              }
            }
            grids.push(grid)
          }
          i++
        }
      } else {
        const same =
          profitCurrency === orderFixedIn ||
          (profitCurrency === 'base' && orderFixedIn === 'quote')
        if (profitCurrency === 'quote') {
          if (orderFixedIn === 'base') {
            qty = this.math.round(
              budget / initialGrids.reduce((acc, v) => (acc += v.price.buy), 0),
              quotedAssetPrecision,
              false,
              true,
            )
          }
        }
        if (profitCurrency === 'base') {
          if (orderFixedIn === 'base') {
            sellQty = this.math.round(
              budget / initialGrids.reduce((acc, v) => (acc += v.price.buy), 0),
              quotedAssetPrecision,
              true,
            )
            initialGrids.map((pr) => {
              if (sellQty * pr.price.buy < symbol.quoteAsset.minAmount) {
                sellQty = this.math.round(
                  symbol.quoteAsset.minAmount / pr.price.buy,
                  quotedAssetPrecision,
                  true,
                )
              }
            })
          }
        }
        /** fill base grids with id and side */
        let i = 0
        for (const g of initialGrids) {
          {
            const side =
              g.price.buy > lastPrice ? OrderSideEnum.sell : OrderSideEnum.buy
            const p = side === OrderSideEnum.buy ? g.price.buy : g.price.sell
            if (profitCurrency === 'base') {
              if (orderFixedIn === 'quote') {
                buyQty = this.math.round(
                  budget / levels / p,
                  quotedAssetPrecision,
                  true,
                )
                if (i !== 0) {
                  sellQty = this.math.round(
                    (grids[i - 1].qty * grids[i - 1].price) / p,
                    quotedAssetPrecision,
                    false,
                    true,
                  )
                }
              }
            }

            if (profitCurrency === 'quote') {
              if (orderFixedIn === 'quote') {
                buyQty = this.math.round(
                  budget / levels / p,
                  quotedAssetPrecision,
                  true,
                )
                if (buyQty * p < symbol.quoteAsset.minAmount) {
                  buyQty = this.math.round(
                    symbol.quoteAsset.minAmount / p,
                    quotedAssetPrecision,
                    true,
                  )
                }
                if (i !== 0 && initialGrids) {
                  sellQty = this.math.round(
                    budget / levels / initialGrids[i - 1].price.buy,
                    quotedAssetPrecision,
                    true,
                  )
                  if (sellQty * p < symbol.quoteAsset.minAmount) {
                    sellQty = this.math.round(
                      symbol.quoteAsset.minAmount /
                        initialGrids[i - 1].price.buy,
                      quotedAssetPrecision,
                      false,
                      true,
                    )
                  }
                } else {
                  sellQty = this.math.round(
                    buyQty * (1 + gs),
                    quotedAssetPrecision,
                    true,
                  )
                }
              }
            }
            if (profitCurrency === 'base') {
              if (orderFixedIn === 'base') {
                if (initialGrids && i !== initialGrids.length - 1) {
                  buyQty = this.math.round(
                    (sellQty * initialGrids[i + 1].price.sell) / g.price.sell,
                    quotedAssetPrecision,
                    true,
                  )
                }
                if (buyQty === sellQty) {
                  buyQty = this.math.round(
                    sellQty + ed.baseAsset.step,
                    quotedAssetPrecision,
                    true,
                  )
                }
                if (buyQty * p < symbol.quoteAsset.minAmount) {
                  buyQty = this.math.round(
                    symbol.quoteAsset.minAmount / p,
                    quotedAssetPrecision,
                    true,
                  )
                }
              }
            }
            if (qty * p < symbol.quoteAsset.minAmount) {
              qty = this.math.round(
                symbol.quoteAsset.minAmount / p,
                quotedAssetPrecision,
                side === OrderSideEnum.sell,
                side === OrderSideEnum.buy,
              )
            }
            const grid = {
              ...g,
              price: p,
              side,
              qty: same
                ? side === OrderSideEnum.sell
                  ? sellQty
                  : buyQty
                : qty,
              newClientOrderId: this.getOrderId(`GRID-RO`),
            }
            if (grid.qty * grid.price < symbol.quoteAsset.minAmount) {
              grid.qty = this.math.round(
                symbol.quoteAsset.minAmount / grid.price,
                await this.baseAssetPrecision(pair),
                false,
                true,
              )
            }
            if (grid.qty < symbol.baseAsset.minAmount) {
              grid.qty = symbol.baseAsset.minAmount
            }
            grids.push(grid)
          }
          i++
        }
        const lastGrid = grids[grids.length - 1]
        const price =
          lastGrid.side === OrderSideEnum.sell
            ? lastGrid.price
            : this.math.round(topPrice, ed.priceAssetPrecision)
        if (profitCurrency === 'base') {
          if (orderFixedIn === 'quote') {
            buyQty = this.math.round(
              budget / levels / price,
              quotedAssetPrecision,
              true,
            )
            sellQty = this.math.round(
              (lastGrid.qty * lastGrid.price) / price,
              quotedAssetPrecision,
              false,
              true,
            )
          }
        }
        if (qty * price < symbol.quoteAsset.minAmount) {
          qty = this.math.round(
            symbol.quoteAsset.minAmount / topPrice,
            quotedAssetPrecision,
            false,
            true,
          )
        }
        grids[grids.length - 1] = {
          ...lastGrid,
          price,
          qty: same
            ? lastGrid.side === OrderSideEnum.sell
              ? sellQty
              : buyQty
            : qty,
        }
      }
      if (!noslice) {
        /** find nearest grid to latest price */
        let diff = Infinity
        let gridIndex = -1
        grids.map((grid, index) => {
          if (Math.abs(grid.price - lastPrice) < diff) {
            diff = Math.abs(grid.price - lastPrice)
            gridIndex = index
          }
        })
        /** remove nearest  */
        grids.splice(gridIndex, 1)
      }

      if (all) {
        return grids
      } else {
        return this.findClosestGrids({
          grids,
          latestPrice: _lastPrice,
          initialGrids,
          ordersInAdvance,
          useOrderInAdvance,
        })
      }
    }
    return []
  }
  protected shouldProceed(): boolean {
    return true
  }
  protected notProceedMessage(_method: string): string {
    return ''
  }
}

export default MainBot
