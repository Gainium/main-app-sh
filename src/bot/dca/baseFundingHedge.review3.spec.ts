process.env.NODE_ENV = 'testing'

/**
 * Engine checks for main-app spec 044 phase 3 (§8) — the legs of a hedge DCA /
 * hedge combo on spot fund themselves.
 *
 * Drives the REAL `placeBaseOrder` hedge branch, `fundHedgeLegEntry`,
 * `startFundedDeal`, `fundAddedSafetyOrders` and `processFilledOrder` of BOTH
 * the DCA helper and the combo helper (stacked on it, as in production), over
 * the REAL ladder, the REAL planner, the REAL `FundingReservation` and the
 * REAL `FundingLock`. No stack, DB, Redis or exchange: one shared fake account
 * holds the balances the funding trades move and the deals whose reservations
 * the next plan reads; the lock runs over an in-memory store with Redis
 * semantics.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { FundingLock, MemoryFundingLockStore } from '../fundingLock'
import {
  ActionsEnum,
  BaseFundingEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const SYMBOL = 'SOLUSDT'
const PRICE = 100

/** 1 SOL base order, two 1 SOL safety orders 1% apart. */
const LEG: any = {
  startOrderType: 'MARKET',
  orderSizeType: 'base',
  baseOrderSize: '1',
  orderSize: '1',
  ordersCount: 2,
  activeOrdersCount: 2,
  useSmartOrders: false,
  useDca: true,
  dcaCondition: 'percentage',
  step: '1',
  stepScale: '1',
  volumeScale: '1',
  gridLevel: '5',
  baseGridLevels: '5',
  indicators: [],
  dcaCustom: [],
  useTp: true,
  tpPerc: '2',
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  useSl: false,
  multiTp: [],
  multiSl: [],
}

const EXCHANGE_INFO: any = {
  pair: SYMBOL,
  baseAsset: { minAmount: 0.001, step: 0.001, name: 'SOL' },
  quoteAsset: { minAmount: 5, step: 0.01, name: 'USDT' },
  priceAssetPrecision: 2,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One exchange account two legs share: balances and its funded deals. */
class Account {
  deals = new Map<string, any>()
  events: string[] = []
  constructor(
    public uuid: string,
    public base: number,
    public quote: number,
  ) {}
  /** What the account's deals reserve, as the reservation would sum it. */
  reserved() {
    let base = 0
    let quote = 0
    for (const d of this.deals.values()) {
      if (!['start', 'open', 'error'].includes(d.status)) {
        continue
      }
      const bf = d.botFunding
      const hold = d.fundingHold
      quote +=
        (bf?.virtualEntry?.quoteReserved ?? 0) +
        (hold?.asset === 'quote' ? hold.remaining : 0)
      base +=
        (bf?.virtualEntry?.baseReserved ?? 0) +
        (hold?.asset === 'base' ? hold.remaining : 0)
    }
    return { base, quote }
  }
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  kucoinSpot = false
  zeroFee = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  orders = new Map()
  ordersDb = { createData: () => undefined }
  data: any = {}
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any
let ComboHelper: any
const lots: any[] = []
let accounts: Account[] = []
const lockStore = new MemoryFundingLockStore()
/** Resting orders the E3 reservation read sees (`orderDb`). */
const restingOrders: any[] = []
/** `dealStart` client ids the E3 base-minigrid lookup finds. */
const baseStarts: string[] = []
/** Unique client ids: lots are looked up by them. */
let orderSeq = 0
const dbInit = loadModule('../../db/dbInit')
// Captured in `before`: put back whatever was installed when this ran.
let saved: Record<string, any> = {}

type Setup = {
  /** Spec 044 beta gate: a user without the BaseFundingBeta role. */
  nonBeta?: boolean
  account: Account
  long?: boolean
  combo?: boolean
  action?: ActionsEnum
  settings?: any
  status?: string
  dealId?: string
  /** No parent hedge bot: a plain DCA / combo bot. */
  plain?: boolean
  botFunding?: any
  fundingHold?: any
  resting?: any[]
  sendFails?: boolean
  /** Delay inside the funding trade, to widen a race. */
  tradeDelayMs?: number
}

const buildBot = (o: Setup) => {
  const long = !!o.long
  const dealId = o.dealId ?? `${long ? 'long' : 'short'}-deal`
  const settings = {
    ...LEG,
    strategy: long ? 'LONG' : 'SHORT',
    ...(o.settings ?? {}),
  }
  const action = o.action ?? (long ? ActionsEnum.sellDiff : ActionsEnum.buyDiff)
  const account = o.account
  const findDeal: any = {
    deal: {
      // Spec 044 beta gate: deals are created stamped for a beta user.
      ...(o.nonBeta ? {} : { baseFundingBeta: true }),
      _id: dealId,
      botId: `${dealId}-bot`,
      exchangeUUID: account.uuid,
      symbol: { symbol: SYMBOL, baseAsset: 'SOL', quoteAsset: 'USDT' },
      status: o.status ?? 'start',
      action,
      initialPrice: PRICE,
      lastPrice: PRICE,
      avgPrice: PRICE,
      levels: { all: 3, complete: 1 },
      funds: [],
      pendingAddFunds: [],
      reduceFunds: [],
      flags: [],
      settings: { ...settings },
      ...(o.botFunding ? { botFunding: o.botFunding } : {}),
    },
    initialOrders: [],
    currentOrders: [],
  }
  if (o.botFunding || o.fundingHold) {
    findDeal.deal.fundingHold = o.fundingHold
    account.deals.set(dealId, {
      status: findDeal.deal.status,
      botFunding: o.botFunding,
      fundingHold: o.fundingHold,
    })
  }
  const rows = [...(o.resting ?? [])]
  const Helper = o.combo ? ComboHelper : DcaHelper
  class TestBot extends Helper {
    sent: any[] = []
    savedPatches: any[] = []
    closed: any[] = []
    errors: string[] = []
    started: any[] = []
    stored: any[] = []
    feeOrders: any[] = []
    loadingComplete = true
    processedFilled = new Map()
    latestDealFillTime = new Map()
    lastFilledOrderMap = new Map()
    exchange = {}
    db = { updateData: async () => undefined }
    getDeal(id: string) {
      return id === dealId ? findDeal : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      defaultStatuses,
    }: {
      status?: string | string[]
      defaultStatuses?: boolean
    }) {
      const wanted = defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : status
          ? [status].flat()
          : undefined
      return rows.filter((r) => !wanted || wanted.includes(r.status))
    }
    // Spec 044 beta gate: the user's role, asked live (no DB here).
    async baseFundingAllowed() {
      return !o.nonBeta
    }
    async getAggregatedSettings(deal?: any) {
      return { ...settings, ...(deal?.settings ?? {}) }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async baseAssetPrecision() {
      return 3
    }
    async getLatestPrice() {
      return PRICE
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async checkAssets() {
      account.events.push(`${dealId}:plan`)
      return new Map([
        ['SOL', { free: account.base, locked: 0 }],
        ['USDT', { free: account.quote, locked: 0 }],
      ])
    }
    async profitBase() {
      return false
    }
    async getTPOrder() {
      return []
    }
    getOrderId(prefix: string) {
      return `${prefix}-${++orderSeq}`
    }
    async sendOrderToExchange(order: any) {
      this.sent.push(order)
      if (o.sendFails) {
        return 'Account has insufficient balance for requested action.'
      }
      if (o.tradeDelayMs) {
        await sleep(o.tradeDelayMs)
      }
      if (order.typeOrder === TypeOrderEnum.funding) {
        const qty = +order.origQty
        if (order.side === OrderSideEnum.buy) {
          account.base += qty
          account.quote -= qty * PRICE
        } else {
          account.base -= qty
          account.quote += qty * PRICE
        }
      }
      return {
        ...order,
        status: 'FILLED',
        orderId: '42',
        executedQty: order.origQty,
        cummulativeQuoteQty: `${+order.origQty * PRICE}`,
      }
    }
    async saveDeal(d: any, patch: any) {
      this.savedPatches.push(patch)
      if ('botFunding' in patch || 'fundingHold' in patch) {
        if ('botFunding' in patch) {
          account.events.push(`${dealId}:save`)
        }
        const prev = account.deals.get(d.deal._id) ?? {}
        account.deals.set(d.deal._id, {
          ...prev,
          status: d.deal.status,
          ...('botFunding' in patch ? { botFunding: patch.botFunding } : {}),
          ...('fundingHold' in patch ? { fundingHold: patch.fundingHold } : {}),
        })
      }
    }
    async closeDealById(...args: any[]) {
      this.closed.push(args)
      findDeal.deal.status = 'canceled'
      const prev = account.deals.get(dealId)
      if (prev) {
        account.deals.set(dealId, { ...prev, status: 'canceled' })
      }
    }
    setOrder(order: any) {
      this.stored.push(order)
    }
    async getBaseOrder() {
      return marketBase(dealId, long)
    }
    async createDeal() {
      return dealId
    }
    async startDeal(order: any) {
      // Still holding what the safety orders need while they are placed.
      this.started.push({
        order: { ...order },
        hold: findDeal.deal.fundingHold && { ...findDeal.deal.fundingHold },
      })
      for (const r of this.placeOnStart) {
        rows.push(r)
      }
    }
    placeOnStart: any[] = []
    rows = rows
    async _placeFeeOrder(...args: any[]) {
      this.feeOrders.push(args)
    }
    getMinigridByDealId() {
      return [{ currentOrders: [{ side: 'SELL', qty: 1 }], schema: {} }]
    }
    async createCurrentDealOrders() {
      return []
    }
    // Combo: the minigrids each DCA level carries are not under test.
    async generateBasicGrids() {
      return []
    }
    async generateGridsOnPrice() {
      return []
    }
    standingConditionLatch = { clear() {}, has() {}, set() {} }
    async getLeverageMultipler() {
      return 1
    }
    async pooledMarginOrKeep(_a: string, available: number) {
      return available
    }
    shouldProceed() {
      return true
    }
    resetPending() {}
    updateDealLastPrices() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    errorArgs: any[][] = []
    handleErrors(msg: string, ...rest: any[]) {
      this.errors.push(msg)
      this.errorArgs.push([msg, ...rest])
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new (TestBot as any)('bot', ExchangeEnum.binance)
  bot.botId = `${dealId}-bot`
  bot.userId = 'user'
  bot.orders = new Map()
  bot.ordersDb = { createData: () => undefined }
  bot.data = {
    exchange: ExchangeEnum.binance,
    exchangeUUID: account.uuid,
    flags: [],
    paperContext: true,
    parentBotId: o.plain ? undefined : 'hedge',
    settings,
  }
  // The helper's own fields (set at load) shadow FakeBase's.
  bot.isLong = long
  bot.futures = false
  bot.combo = !!o.combo
  return { bot, findDeal, dealId, rows }
}

const marketBase = (dealId: string, long: boolean): any => ({
  clientOrderId: 'D-BO-x',
  dealId,
  typeOrder: TypeOrderEnum.dealStart,
  status: 'NEW',
  type: 'MARKET',
  side: long ? OrderSideEnum.buy : OrderSideEnum.sell,
  // Priced when the deal was created; the virtual entry re-prices it.
  price: '97',
  origPrice: '97',
  origQty: '1',
  executedQty: '0',
  symbol: SYMBOL,
})

let n = 0
const newAccount = (base: number, quote: number) => {
  const a = new Account(`uuid-review3-${++n}`, base, quote)
  accounts.push(a)
  return a
}

const fundingSent = (bot: any) =>
  bot.sent.filter((s: any) => s.typeOrder === TypeOrderEnum.funding)

/*
 * Adversarial review, PASS 3 (spec 044 phase 3, fix round 2 — 2026-10-18).
 * Harness above copied from `baseFundingHedge.harness.spec.ts`. `[BUG]` cases
 * FAIL on purpose (phase3-review.md, "Pass 3").
 */
describe('Spec 044 phase 3 — adversarial review pass 3', () => {
  before(function () {
    this.timeout(240000)
    if (!DcaHelper) {
      DcaHelper = loadModule('../dcaHelper').default(FakeBase as any)
      ComboHelper = loadModule('../comboHelper').default(DcaHelper)
    }
    saved = {
      dcaRead: dbInit.dcaDealsDb.readData,
      comboRead: dbInit.comboDealsDb.readData,
      lot: dbInit.fundingLotDb.createData,
      lotRead: dbInit.fundingLotDb.readData,
      orderRead: dbInit.orderDb.readData,
    }
    // Fix round 2 plumbing: the lot writer first looks a lot up by its
    // client id (restart after the lot was written) — read the same `lots`.
    dbInit.fundingLotDb.readData = async (filter: any) => {
      const i = lots.findIndex((l) => l.clientOrderId === filter.clientOrderId)
      return {
        status: StatusEnum.ok,
        data: {
          result: i < 0 ? undefined : { ...lots[i], _id: `lot${i + 1}` },
        },
      }
    }
    dbInit.fundingLotDb.createData = async (lot: any) => {
      lots.push(lot)
      return {
        status: StatusEnum.ok,
        data: { ...lot, _id: `lot${lots.length}` },
      }
    }
    // The REAL FundingReservation reads the deals collections: answer from
    // the fake accounts' deals.
    const read = async (filter: any) => {
      const acc = accounts.find((a) => a.uuid === filter.exchangeUUID)
      const result = acc
        ? [...acc.deals.entries()]
            .map(([_id, d]) => ({ _id, ...d }))
            .filter((d) => filter.status.$in.includes(d.status))
        : []
      return { status: StatusEnum.ok, data: { result } }
    }
    dbInit.dcaDealsDb.readData = read
    dbInit.comboDealsDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: [] },
    })
    // E3: resting orders that already lock a deal's reserved asset, and
    // the base-order rows minigrids are built on.
    dbInit.orderDb.readData = async (filter: any) => ({
      status: StatusEnum.ok,
      data: {
        result: filter.clientOrderId
          ? baseStarts
              .filter((c) => filter.clientOrderId.$in.includes(c))
              .map((clientOrderId) => ({ clientOrderId }))
          : restingOrders.filter(
              (r) =>
                filter.dealId.$in.includes(r.dealId) && r.side === filter.side,
            ),
      },
    })
    FundingLock.getInstance().setStore(lockStore)
  })
  after(() => {
    dbInit.dcaDealsDb.readData = saved.dcaRead
    dbInit.comboDealsDb.readData = saved.comboRead
    dbInit.fundingLotDb.readData = saved.lotRead
    dbInit.fundingLotDb.createData = saved.lot
    dbInit.orderDb.readData = saved.orderRead
    accounts = []
  })

  describe('restoreWork — non-ASAP start deal funded before the restart (fix round 2, item 6)', () => {
    /** Thin harness: only what `restoreWork` touches on the start-deal path. */
    const restoreBot = (opts: {
      account: Account
      botFunding?: any
      startCondition: string
    }) => {
      const b = buildBot({
        account: opts.account,
        botFunding: opts.botFunding,
        fundingHold: { asset: 'base', committed: 2, remaining: 2 },
        settings: { startCondition: opts.startCondition },
      })
      const bot = b.bot
      bot.serviceRestart = true
      bot.secondRestart = false
      bot.getSymbolsToOpenAsapDeals = async () => []
      bot.checkOrders = async () => undefined
      bot.getOpenDeals = () => [b.findDeal]
      bot.startIndicatorInit = async () => undefined
      bot.startTimeBasedTrigger = () => undefined
      bot.calculateBotBalances = () => undefined
      bot.calculateUsage = () => undefined
      bot.updateDealLastPrices = () => undefined
      return b
    }

    it('pendingTrade, funding order filled: resumed and started, not cancelled as stale', async () => {
      const account = newAccount(2, 800)
      const clientOrderId = `D-FND-review3-${Date.now()}`
      const { bot, findDeal } = restoreBot({
        account,
        startCondition: 'TradingviewSignals',
        botFunding: {
          mode: BaseFundingEnum.auto,
          virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
          lotIds: [],
          sourcedByBot: true,
          pendingTrade: {
            clientOrderId,
            side: OrderSideEnum.buy,
            qty: 2,
            at: 1,
          },
        },
      })
      const filled = {
        clientOrderId,
        side: OrderSideEnum.buy,
        status: 'FILLED',
        origQty: '2',
        executedQty: '2',
        cummulativeQuoteQty: '200',
        price: '100',
        orderId: '7',
      }
      // No dealStart row (the restore's own read), the funding row by client id.
      bot.ordersDb.readData = async (filter: any) => ({
        status: StatusEnum.ok,
        data: {
          result:
            filter?.clientOrderId === clientOrderId
              ? filled
              : filter?.typeOrder
                ? []
                : null,
        },
      })
      await bot.restoreWork()
      expect(bot.closed).to.have.length(0)
      expect(bot.sent).to.have.length(0)
      expect(bot.started).to.have.length(1)
      expect(findDeal.deal.botFunding.pendingTrade).to.equal(undefined)
      expect(findDeal.deal.botFunding.lotIds).to.have.length(1)
    })

    it('an action but no funding record (crash before the intent): cancelled as stale, nothing sent', async () => {
      const account = newAccount(1.5, 1000)
      const { bot } = restoreBot({
        account,
        startCondition: 'TradingviewSignals',
      })
      bot.ordersDb.readData = async () => ({
        status: StatusEnum.ok,
        data: { result: [] },
      })
      await bot.restoreWork()
      expect(bot.sent).to.have.length(0)
      expect(bot.closed).to.have.length(1)
    })
  })

  describe('partial funding fills (fix round 2, item 7)', () => {
    /** A quote-sized market buy (Bybit / Coinbase / Bitget spot: main.ts sends `qty × price` in quote). */
    const quoteSizedFill = (askOverLast: number) =>
      async function (this: any, order: any) {
        this.sent.push(order)
        if (order.typeOrder !== TypeOrderEnum.funding) {
          return { ...order, status: 'FILLED', executedQty: order.origQty }
        }
        const quote = +order.origQty * PRICE
        const ask = PRICE * askOverLast
        const executed = Math.floor((quote / ask) * 1000) / 1000
        return {
          ...order,
          status: 'FILLED',
          orderId: '42',
          executedQty: `${executed}`,
          cummulativeQuoteQty: `${executed * ask}`,
        }
      }

    it('a quote-sized market buy filled 0.1% above the last price retires the deal (false retirement, bought base orphaned)', async () => {
      const account = newAccount(0, 1000)
      const { bot, dealId } = buildBot({ account })
      bot.sendOrderToExchange = quoteSizedFill(1.001)
      const r = await bot.fundHedgeLegEntry(
        SYMBOL,
        dealId,
        marketBase(dealId, false),
        ActionsEnum.buyDiff,
      )
      // 1.998 of 2 SOL bought (0.1% short, the spread): fund, don't retire.
      expect(r).to.equal('virtual')
    })

    it('a fill short by exactly one step still funds', async () => {
      const account = newAccount(0, 1000)
      const { bot, dealId } = buildBot({ account })
      bot.sendOrderToExchange = quoteSizedFill(1.0004)
      const r = await bot.fundHedgeLegEntry(
        SYMBOL,
        dealId,
        marketBase(dealId, false),
        ActionsEnum.buyDiff,
      )
      expect(r).to.equal('virtual')
    })

    it('a venue that acknowledges the market buy as NEW (fills a moment later) is retired without a re-query', async () => {
      const account = newAccount(0, 1000)
      const { bot, dealId } = buildBot({ account })
      bot.sendOrderToExchange = async function (this: any, order: any) {
        this.sent.push(order)
        return { ...order, status: 'NEW', orderId: '42', executedQty: '0' }
      }
      bot.getOrder = async (id: string) => ({
        status: StatusEnum.ok,
        data: {
          clientOrderId: id,
          side: OrderSideEnum.buy,
          status: 'FILLED',
          origQty: '2',
          executedQty: '2',
          cummulativeQuoteQty: '200',
          price: '100',
          orderId: '42',
        },
      })
      const r = await bot.fundHedgeLegEntry(
        SYMBOL,
        dealId,
        marketBase(dealId, false),
        ActionsEnum.buyDiff,
      )
      expect(r).to.equal('virtual')
    })
  })
})

void fundingSent
