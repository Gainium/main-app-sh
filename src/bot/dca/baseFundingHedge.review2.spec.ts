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
let restingOrders: any[] = []
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
  const a = new Account(`uuid-review2-${++n}`, base, quote)
  accounts.push(a)
  return a
}

const fundingSent = (bot: any) =>
  bot.sent.filter((s: any) => s.typeOrder === TypeOrderEnum.funding)

/*
 * Adversarial review, PASS 2 (spec 044 phase 3, fix round 1 — 2026-10-18).
 * The harness above is a copy of `baseFundingHedge.harness.spec.ts`. A case
 * named `[BUG]` FAILS on purpose and demonstrates a defect (phase3-review.md,
 * "Pass 2").
 */
import { FundingReservation } from '../fundingReservation'

describe('Spec 044 phase 3 — adversarial review pass 2', () => {
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
      // Like the real collection: clientOrderId is a unique index.
      if (lots.some((l) => l.clientOrderId === lot.clientOrderId)) {
        return { status: StatusEnum.notok, reason: 'E11000 duplicate key' }
      }
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
    dbInit.comboDealsDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: [] },
    })
    dbInit.orderDb.readData = async (filter: any) => ({
      status: StatusEnum.ok,
      data: {
        result: restingOrders.filter(
          (r) =>
            filter.dealId.$in.includes(r.dealId) &&
            r.side === filter.side &&
            filter.status.$in.includes(r.status),
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
    restingOrders = []
    accounts = []
  })

  it('restart while the leg waited for the lock / planned: the restore sends an unplanned REAL base sell', async () => {
    // The bot's `action` is unset before funding starts; the deal keeps it.
    // A restart before `pendingTrade` is saved (lock wait ≤ 300 s, the plan)
    // leaves a `start` deal with an action and no funding record.
    const account = newAccount(1.5, 1000)
    const { bot, dealId } = buildBot({ account, action: ActionsEnum.buyDiff })
    await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
    const realBase = bot.sent.filter(
      (s: any) => s.typeOrder === TypeOrderEnum.dealStart,
    )
    // 1.5 SOL cannot cover 1 + 2: the leg must be funded (or refused), not
    // sell 1 of the 1.5 SOL its safety orders need.
    expect(realBase).to.have.length(0)
  })

  it('restart after the lot was written but before the final save: the lot is not linked to the deal', async () => {
    const account = newAccount(2, 800)
    const intent = {
      clientOrderId: 'D-FND-review2',
      side: OrderSideEnum.buy,
      qty: 2,
      at: 1,
    }
    const { bot, findDeal, dealId } = buildBot({
      account,
      botFunding: {
        mode: BaseFundingEnum.auto,
        virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
        lotIds: [],
        sourcedByBot: true,
        pendingTrade: intent,
      },
      fundingHold: { asset: 'base', committed: 2, remaining: 2 },
    })
    // The live path wrote this lot, then the process died.
    lots.push({ clientOrderId: intent.clientOrderId, dealId, qty: 2 })
    const existingId = `lot${lots.length}`
    bot.ordersDb.readData = async () => ({
      status: StatusEnum.ok,
      data: {
        result: {
          clientOrderId: intent.clientOrderId,
          side: OrderSideEnum.buy,
          status: 'FILLED',
          origQty: '2',
          executedQty: '2',
          cummulativeQuoteQty: '200',
          price: '100',
          orderId: '7',
        },
      },
    })
    await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
    expect(bot.started).to.have.length(1)
    expect(findDeal.deal.botFunding.lotIds).to.include(existingId)
  })

  it('fundingHold: a safety order partly filled then cancelled and re-placed for the rest stays held forever', async () => {
    const account = newAccount(0, 1000)
    const sell = (status: string, orig: number, exec: number, i: number) => ({
      clientOrderId: `D-RO-${i}`,
      dealId: 'short-deal',
      typeOrder: TypeOrderEnum.dealRegular,
      side: OrderSideEnum.sell,
      status,
      origQty: `${orig}`,
      executedQty: `${exec}`,
      price: `${101 + i}`,
    })
    const { bot, dealId } = buildBot({
      account,
      status: 'open',
      resting: [
        // Level 1: 0.5 of 1 filled, then cancelled by a ladder rebuild …
        sell('CANCELED', 1, 0.5, 0),
        // … and re-placed for the 0.5 left. Level 2 rests whole.
        sell('NEW', 0.5, 0, 1),
        sell('NEW', 1, 0, 2),
      ],
    })
    // Every unit of the 2 committed is sold or on the book.
    expect(await bot.fundingHoldRemaining(dealId, 'base', 2)).to.equal(0)
  })

  it("E3: resting buys funded by a safety sale's proceeds (combo level minigrid) zero the entry reserve", async () => {
    const account = newAccount(0, 0)
    // Short leg: entry 1 @ 100 reserves 100 USDT. Level 1 sold 1 @ 101 (101
    // USDT of proceeds); its minigrid rests a buy of 1 @ 100.5 out of them.
    // No take profit rests yet: the entry's 100 USDT is still free.
    account.deals.set('mg-deal', {
      status: 'open',
      botFunding: {
        mode: BaseFundingEnum.auto,
        virtualEntry: { qty: 1, price: 100, quoteReserved: 100 },
        lotIds: [],
        sourcedByBot: true,
      },
    })
    restingOrders = [
      {
        dealId: 'mg-deal',
        side: 'BUY',
        status: 'NEW',
        typeOrder: TypeOrderEnum.dealGrid,
        origQty: '1',
        executedQty: '0',
        price: '100.5',
      },
    ]
    try {
      const reserved = await FundingReservation.getInstance().reservedQuote(
        account.uuid,
        'USDT',
        true,
      )
      expect(reserved).to.be.gte(100)
    } finally {
      restingOrders = []
    }
  })
})

// Keep the copied harness helper referenced (noUnusedLocals).
void fundingSent
