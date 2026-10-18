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
    // Fix round 1 harness plumbing: the hold moved from
    // `botFunding.pendingOrders` to `deal.fundingHold`, and a retired deal
    // holds nothing.
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
const dbInit = loadModule('../../db/dbInit')
// Captured in `before`: put back whatever was installed when this ran.
let saved: Record<string, any> = {}

type Setup = {
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
  if (o.botFunding) {
    account.deals.set(dealId, {
      status: findDeal.deal.status,
      botFunding: o.botFunding,
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
      return `${prefix}-x`
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
    async closeDealById(...args: any[]) {
      this.closed.push(args)
      findDeal.deal.status = 'canceled'
      const prev = account.deals.get(dealId)
      if (prev) {
        account.deals.set(dealId, { ...prev, status: 'canceled' })
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
        pending: findDeal.deal.botFunding?.pendingOrders,
      })
    }
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
    handleErrors(msg: string) {
      this.errors.push(msg)
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
  const a = new Account(`uuid-review-${++n}`, base, quote)
  accounts.push(a)
  return a
}

const fundingSent = (bot: any) =>
  bot.sent.filter((s: any) => s.typeOrder === TypeOrderEnum.funding)

/*
 * Adversarial review of spec 044 phase 3 (2026-10-18). The harness above is a
 * copy of `baseFundingHedge.harness.spec.ts`; the cases below are new. A
 * FAILING case here demonstrates a defect (see phase3-review.md).
 */
describe('Spec 044 phase 3 — adversarial review (engine)', () => {
  const lock = FundingLock.getInstance()
  let ttl = 0
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
    dbInit.dcaDealsDb.readData = async (filter: any) => {
      const acc = accounts.find((a) => a.uuid === filter.exchangeUUID)
      const result = acc
        ? [...acc.deals.entries()]
            .map(([_id, d]) => ({ _id, ...d }))
            .filter((d) => filter.status.$in.includes(d.status))
        : []
      return { status: StatusEnum.ok, data: { result } }
    }
    // E3 plumbing: no deal of this suite has a resting order.
    dbInit.orderDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: [] },
    })
    dbInit.comboDealsDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: [] },
    })
    lock.setStore(lockStore)
    ttl = lock.ttlMs
  })
  after(() => {
    dbInit.dcaDealsDb.readData = saved.dcaRead
    dbInit.comboDealsDb.readData = saved.comboRead
    dbInit.fundingLotDb.readData = saved.lotRead
    dbInit.fundingLotDb.createData = saved.lot
    dbInit.orderDb.readData = saved.orderRead
    lock.ttlMs = ttl
    lock.setStore(lockStore)
    accounts = []
  })

  // Fix round 1: the stub now makes the rested level visible to the engine
  // (an order row), as a real `startDeal` does — a placement nothing can see
  // cannot release anything. The expectation drops its "+ 1": under
  // coordinator decision 1 the unrested level's 1 SOL IS in `r.base` (the
  // short's `fundingHold`), so adding it again double-counted it.
  it('short safety orders not rested at startDeal (activeOrdersCount < ordersCount) keep their hold, and the long leg cannot back its entry with that base', async () => {
    const account = newAccount(0, 1000)
    const short = buildBot({
      account,
      settings: { activeOrdersCount: 1 },
    })
    // startDeal rests only `activeOrdersCount` (1 of 2) safety sells: 1 SOL
    // moves to the book; the second level's 1 SOL stays free until a level fills.
    short.bot.startDeal = async () => {
      account.base -= 1
      short.rows.push({
        clientOrderId: 'D-RO-1',
        typeOrder: TypeOrderEnum.dealRegular,
        side: OrderSideEnum.sell,
        status: 'NEW',
        origQty: '1',
        executedQty: '0',
        price: '101',
      })
    }
    await short.bot.placeBaseOrder(short.bot.botId, SYMBOL)
    expect(fundingSent(short.bot)).to.have.length(1)
    const long = buildBot({ account, long: true })
    await long.bot.fundHedgeLegEntry(
      SYMBOL,
      long.dealId,
      marketBase(long.dealId, true),
      ActionsEnum.sellDiff,
    )
    // Free base must still cover what is reserved, which includes the
    // short's unrested second safety sell (1 SOL).
    const r = account.reserved()
    expect(r.base).to.be.gte(1)
    expect(account.base + 1e-9).to.be.gte(r.base)
  })

  it('a funding trade slower than the lock TTL does not let the sibling leg plan on the same funds', async () => {
    lock.ttlMs = 20
    try {
      const account = newAccount(1.5, 500)
      const short = buildBot({ account, tradeDelayMs: 80 })
      const long = buildBot({ account, long: true, tradeDelayMs: 80 })
      await Promise.all([
        short.bot.fundHedgeLegEntry(
          SYMBOL,
          short.dealId,
          marketBase(short.dealId, false),
          ActionsEnum.buyDiff,
        ),
        long.bot.fundHedgeLegEntry(
          SYMBOL,
          long.dealId,
          marketBase(long.dealId, true),
          ActionsEnum.sellDiff,
        ),
      ])
      const r = account.reserved()
      expect(account.base + 1e-9).to.be.gte(r.base)
      expect(account.quote + 1e-9).to.be.gte(r.quote)
    } finally {
      lock.ttlMs = ttl
    }
  })

  describe('Redis (lock store) unavailable', () => {
    const down = {
      setNxPx: async () => undefined,
      delIfValue: async () => undefined,
    }
    const funded = (account: Account) =>
      buildBot({
        account,
        plain: true,
        status: 'open',
        settings: { baseFunding: BaseFundingEnum.auto },
        botFunding: {
          mode: BaseFundingEnum.auto,
          virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
          lotIds: [],
          sourcedByBot: true,
        },
        resting: [101, 102].map((price, i) => ({
          clientOrderId: `D-RO-${i}`,
          typeOrder: TypeOrderEnum.dealRegular,
          side: OrderSideEnum.sell,
          status: 'NEW',
          origQty: '1',
          executedQty: '0',
          price: `${price}`,
        })),
      })

    it('control: with the lock available, cutting a phase-2 funded short to 1 level needs no trade and applies', async () => {
      const { bot, findDeal, dealId } = funded(newAccount(0, 1000))
      expect(
        await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 1 }),
      ).to.equal(true)
      expect(bot.sent).to.have.length(0)
    })

    it('phase-2: a ladder edit that needs NO trade applies when the lock store is down', async () => {
      lock.setStore(down)
      try {
        const { bot, findDeal, dealId } = funded(newAccount(0, 1000))
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, {
            ordersCount: 1,
          }),
        ).to.equal(true)
      } finally {
        lock.setStore(lockStore)
      }
    })
  })

  it('deal gone while the funding trade filled: refused, not started', async () => {
    const account = newAccount(0, 1000)
    const { bot, dealId } = buildBot({ account })
    const send = bot.sendOrderToExchange.bind(bot)
    bot.sendOrderToExchange = async (order: any) => {
      const r = await send(order)
      // The user cancelled the deal while the market buy was in flight.
      bot.getDeal = () => undefined
      return r
    }
    const result = await bot.fundHedgeLegEntry(
      SYMBOL,
      dealId,
      marketBase(dealId, false),
      ActionsEnum.buyDiff,
    )
    expect(result).to.equal('refused')
  })

  it('stress: lock released and books consistent across 6 concurrent legs on one account', async () => {
    const account = newAccount(3, 1500)
    const legs = [0, 1, 2, 3, 4, 5].map((i) =>
      buildBot({
        account,
        long: i % 2 === 1,
        dealId: `stress-${i}`,
        tradeDelayMs: 5,
      }),
    )
    const results = await Promise.all(
      legs.map((l, i) =>
        l.bot.fundHedgeLegEntry(
          SYMBOL,
          l.dealId,
          marketBase(l.dealId, i % 2 === 1),
          i % 2 === 1 ? ActionsEnum.sellDiff : ActionsEnum.buyDiff,
        ),
      ),
    )
    // Fix round 1 (decision 5): a leg its held funds cover opens `held`
    // (real base order), not `virtual`; the property is that legs open.
    expect(results.filter((r) => r !== 'refused').length).to.be.gte(1)
    const r = account.reserved()
    expect(account.base + 1e-9).to.be.gte(r.base)
    expect(account.quote + 1e-9).to.be.gte(r.quote)
    expect(lockStore.held(lock.key(account.uuid))).to.equal(false)
  })
})
