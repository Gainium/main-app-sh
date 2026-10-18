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
/** `dealStart` client ids the E3 base-minigrid lookup finds. */
let baseStarts: string[] = []
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
  const a = new Account(`uuid-hedge-${++n}`, base, quote)
  accounts.push(a)
  return a
}

const fundingSent = (bot: any) =>
  bot.sent.filter((s: any) => s.typeOrder === TypeOrderEnum.funding)

for (const combo of [false, true]) {
  const kind = combo ? 'combo' : 'DCA'
  describe(`Hedge ${kind} leg funded by the bot (main-app spec 044 phase 3)`, () => {
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
        const i = lots.findIndex(
          (l) => l.clientOrderId === filter.clientOrderId,
        )
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
                  filter.dealId.$in.includes(r.dealId) &&
                  r.side === filter.side,
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

    describe('short leg — deal open', () => {
      it('buyDiff, part of the base held: buys the difference as a funding trade', async () => {
        const account = newAccount(1.5, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        const base = marketBase(dealId, false)
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            base,
            ActionsEnum.buyDiff,
          ),
        ).to.equal('virtual')
        const [trade] = fundingSent(bot)
        expect(bot.sent).to.have.length(1)
        expect(trade.typeOrder).to.equal(TypeOrderEnum.funding)
        expect(trade.dealId).to.equal(undefined)
        expect(trade.clientOrderId).to.match(/^D-FND/)
        expect(trade.side).to.equal(OrderSideEnum.buy)
        // Combo pads each DCA level by step × gridLevel (0.001 × 5).
        expect(+trade.origQty).to.equal(combo ? 0.51 : 0.5)
        // The intent (and the reservation) was saved BEFORE the trade.
        const intent = bot.savedPatches.find(
          (p: any) => p.botFunding?.pendingTrade,
        )
        expect(intent.botFunding.pendingTrade).to.deep.include({
          clientOrderId: trade.clientOrderId,
          side: OrderSideEnum.buy,
        })
        expect(lots.at(-1)).to.deep.include({
          dealId,
          asset: 'SOL',
          side: OrderSideEnum.buy,
        })
        // The virtual entry, re-priced to the latest price.
        expect(base).to.deep.include({
          status: 'FILLED',
          executedQty: '1',
          price: `${PRICE}`,
          cummulativeQuoteQty: `${PRICE}`,
          fundingSource: 'virtual',
        })
        expect(findDeal.deal.botFunding).to.deep.include({
          mode: BaseFundingEnum.auto,
          sourcedByBot: false,
        })
        expect(findDeal.deal.botFunding.pendingTrade).to.equal(undefined)
        expect(findDeal.deal.botFunding.virtualEntry).to.deep.equal({
          qty: 1,
          price: PRICE,
          quoteReserved: 100,
        })
        const need = combo ? 2.01 : 2
        expect(findDeal.deal.fundingHold).to.deep.equal({
          asset: 'base',
          committed: need,
          remaining: need,
        })
        expect(findDeal.deal.botFunding.lotIds).to.have.length(1)
        expect(bot.closed).to.have.length(0)
      })

      it('buyForAll: buys every safety order even with base held', async () => {
        const account = newAccount(50, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          action: ActionsEnum.buyForAll,
        })
        await bot.fundHedgeLegEntry(
          SYMBOL,
          dealId,
          marketBase(dealId, false),
          ActionsEnum.buyForAll,
        )
        expect(+fundingSent(bot)[0].origQty).to.equal(combo ? 2.01 : 2)
        expect(findDeal.deal.botFunding.mode).to.equal(BaseFundingEnum.botOnly)
        expect(findDeal.deal.botFunding.sourcedByBot).to.equal(true)
      })

      it('buyDiff with the whole deal covered by held base: no trade, real base order, need held', async () => {
        const account = newAccount(10, 0)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('held')
        expect(bot.sent).to.have.length(0)
        expect(findDeal.deal.botFunding).to.equal(undefined)
        const need = combo ? 3.01 : 3
        expect(findDeal.deal.fundingHold).to.deep.equal({
          asset: 'base',
          committed: need,
          remaining: need,
        })
      })

      it('unaffordable: refused, shown to the user, deal retired, nothing traded', async () => {
        const account = newAccount(0, 250)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(bot.sent).to.have.length(0)
        expect(bot.closed).to.have.length(1)
        expect(bot.closed[0][1]).to.equal(dealId)
        expect(bot.closed[0][2]).to.equal('cancel')
        expect(bot.errors[0]).to.match(/Not enough USDT to fund this hedge leg/)
        // E4: a bot warning the user sees (sendError + setEvent), no error state.
        expect(bot.errorArgs[0].slice(3, 6)).to.deep.equal([false, true, true])
        expect(findDeal.deal.botFunding).to.equal(undefined)
      })

      it('failed funding trade: reported, deal retired, its reservation released', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          sendFails: true,
        })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(bot.closed).to.have.length(1)
        expect(bot.errors[0]).to.match(/Cannot buy the SOL/)
        expect(bot.errorArgs[0].slice(3, 6)).to.deep.equal([false, true, true])
        // The intent stays as the record; the retired deal holds nothing.
        expect(findDeal.deal.botFunding.pendingTrade.clientOrderId).to.match(
          /^D-FND/,
        )
        expect(account.reserved()).to.deep.equal({ base: 0, quote: 0 })
      })

      it('records the funding on the deal object the map holds after the trade', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        const fresh = { ...findDeal, deal: { ...findDeal.deal } }
        const send = bot.sendOrderToExchange.bind(bot)
        bot.sendOrderToExchange = async (order: any) => {
          const r = await send(order)
          bot.getDeal = (id: string) => (id === dealId ? fresh : undefined)
          return r
        }
        await bot.fundHedgeLegEntry(
          SYMBOL,
          dealId,
          marketBase(dealId, false),
          ActionsEnum.buyDiff,
        )
        expect(fresh.deal.botFunding?.virtualEntry?.quoteReserved).to.equal(100)
        expect(fresh.deal.botFunding?.lotIds).to.have.length(1)
        expect(fresh.deal.botFunding?.pendingTrade).to.equal(undefined)
        // The pre-trade object only ever got the intent.
        expect(findDeal.deal.botFunding.pendingTrade).to.not.equal(undefined)
      })

      it('deal no longer in start after the fill: not started, the lot is the record', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        const send = bot.sendOrderToExchange.bind(bot)
        bot.sendOrderToExchange = async (order: any) => {
          const r = await send(order)
          findDeal.deal.status = 'closed'
          return r
        }
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(lots.at(-1).dealId).to.equal(dealId)
      })

      it('funding lock lost before the trade: refused and retired, nothing traded', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        const lock = FundingLock.getInstance()
        const stealing = {
          setNxPx: (k: string, v: string, t: number) =>
            lockStore.setNxPx(k, v, t),
          delIfValue: (k: string, v: string) => lockStore.delIfValue(k, v),
          pexpireIfValue: async () => false,
        }
        lock.setStore(stealing)
        try {
          expect(
            await bot.fundHedgeLegEntry(
              SYMBOL,
              dealId,
              marketBase(dealId, false),
              ActionsEnum.buyDiff,
            ),
          ).to.equal('refused')
        } finally {
          lock.setStore(lockStore)
        }
        expect(bot.sent).to.have.length(0)
        expect(bot.closed).to.have.length(1)
        expect(bot.errors[0]).to.match(/lock was lost before the trade/)
      })
    })

    describe('bounded and partial funding trades (fix round 2)', () => {
      it('a funding trade that never completes times out: refused, retired, lock released', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        bot.fundingTradeTimeoutMs = 50
        bot.sendOrderToExchange = () => new Promise(() => undefined)
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(bot.errors[0]).to.match(/did not complete within/)
        expect(bot.closed).to.have.length(1)
        expect(
          lockStore.held(FundingLock.getInstance().key(account.uuid)),
        ).to.equal(false)
      })

      const filledWith = (executed: number, status = 'FILLED') =>
        async function (this: any, order: any) {
          this.sent.push(order)
          return {
            ...order,
            status,
            orderId: '9',
            executedQty: `${executed}`,
            cummulativeQuoteQty: `${executed * PRICE}`,
          }
        }

      it('a fill short beyond the tolerance: booked as executed, deal retired', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        bot.sendOrderToExchange = filledWith(1)
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(lots.at(-1)).to.deep.include({ dealId, qty: 1 })
        expect(bot.errors[0]).to.match(/filled 1 of 2/)
        expect(bot.closed).to.have.length(1)
        expect(findDeal.deal.botFunding.virtualEntry).to.not.equal(undefined)
        expect(account.reserved()).to.deep.equal({ base: 0, quote: 0 })
      })

      it('a fill short within the tolerance funds the deal with what executed', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        // 0.75% short — more than one step, inside 1% + one step.
        const executed = combo ? 1.995 : 1.985
        bot.sendOrderToExchange = filledWith(executed)
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('virtual')
        expect(lots.at(-1)).to.deep.include({ dealId, qty: executed })
        expect(bot.closed).to.have.length(0)
        // The hold covers what was bought, not the plan.
        expect(findDeal.deal.fundingHold).to.deep.equal({
          asset: 'base',
          committed: executed,
          remaining: executed,
        })
      })

      it('a buy acknowledged NEW is re-queried until final, then judged', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        bot.fundingPollMs = 5
        bot.sendOrderToExchange = filledWith(0, 'NEW')
        const answers = ['PARTIALLY_FILLED', 'FILLED']
        let asked = 0
        bot.getOrder = async (id: string) => {
          const status = answers[Math.min(asked++, answers.length - 1)]
          const qty = combo ? 2.01 : 2
          return {
            status: StatusEnum.ok,
            data: {
              clientOrderId: id,
              side: OrderSideEnum.buy,
              status,
              origQty: `${qty}`,
              executedQty: status === 'FILLED' ? `${qty}` : '1',
              cummulativeQuoteQty: `${qty * PRICE}`,
              price: `${PRICE}`,
              orderId: '42',
            },
          }
        }
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('virtual')
        expect(asked).to.equal(2)
      })

      it('a buy still not final at the trade timeout takes the timeout path', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        bot.fundingPollMs = 5
        bot.fundingTradeTimeoutMs = 60
        bot.sendOrderToExchange = filledWith(0, 'NEW')
        bot.getOrder = async () => ({
          status: StatusEnum.ok,
          data: { status: 'NEW', executedQty: '0' },
        })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(bot.errors[0]).to.match(/did not complete within/)
        expect(bot.closed).to.have.length(1)
      })

      it('a restored start deal with a funding action and no record is funded under the lock', async () => {
        const account = newAccount(1.5, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
        expect(
          bot.sent.filter((o: any) => o.typeOrder === TypeOrderEnum.dealStart),
        ).to.have.length(0)
        expect(fundingSent(bot)).to.have.length(1)
        expect(bot.started).to.have.length(1)
      })
    })

    describe('long leg — deal open', () => {
      // Two buy levels at 99 and 98: 197 quote.
      const need = 197

      it('sellDiff: held quote first, sells base for the rest, reserves the entry base', async () => {
        const account = newAccount(5, 50)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          long: true,
        })
        const base = marketBase(dealId, true)
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            base,
            ActionsEnum.sellDiff,
          ),
        ).to.equal('virtual')
        const [trade] = fundingSent(bot)
        expect(trade.side).to.equal(OrderSideEnum.sell)
        expect(trade.dealId).to.equal(undefined)
        expect(+trade.origQty).to.equal(1.47)
        expect(lots.at(-1)).to.deep.include({
          dealId,
          asset: 'USDT',
          side: OrderSideEnum.sell,
          qty: 147,
          remaining: 147,
        })
        expect(base).to.deep.include({
          status: 'FILLED',
          price: `${PRICE}`,
          fundingSource: 'virtual',
        })
        expect(findDeal.deal.botFunding.virtualEntry).to.deep.equal({
          qty: 1,
          price: PRICE,
          quoteReserved: 0,
          baseReserved: 1,
        })
        expect(findDeal.deal.fundingHold).to.deep.equal({
          asset: 'quote',
          committed: need,
          remaining: need,
        })
        expect(findDeal.deal.botFunding.sourcedByBot).to.equal(false)
      })

      it('sellForAll: sells for the whole need even with quote held', async () => {
        const account = newAccount(5, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          long: true,
          action: ActionsEnum.sellForAll,
        })
        await bot.fundHedgeLegEntry(
          SYMBOL,
          dealId,
          marketBase(dealId, true),
          ActionsEnum.sellForAll,
        )
        expect(+fundingSent(bot)[0].origQty).to.equal(1.97)
        expect(findDeal.deal.botFunding.mode).to.equal(BaseFundingEnum.botOnly)
      })

      it('sellDiff with base order + safety orders covered by held quote: held, real base order', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          long: true,
        })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, true),
            ActionsEnum.sellDiff,
          ),
        ).to.equal('held')
        expect(bot.sent).to.have.length(0)
        expect(findDeal.deal.fundingHold).to.deep.include({
          asset: 'quote',
          committed: 100 + need,
        })
      })

      it('not enough held base behind the virtual entry: refused, retired', async () => {
        const account = newAccount(0.5, 200)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          long: true,
        })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, true),
            ActionsEnum.sellDiff,
          ),
        ).to.equal('refused')
        expect(bot.sent).to.have.length(0)
        expect(bot.closed).to.have.length(1)
        expect(bot.errors[0]).to.match(/Not enough SOL to fund this hedge leg/)
        expect(findDeal.deal.botFunding).to.equal(undefined)
      })

      it('base covers the entry but not the entry plus the sale: refused', async () => {
        const account = newAccount(1.5, 0)
        const { bot, dealId } = buildBot({ account, combo, long: true })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, true),
            ActionsEnum.sellDiff,
          ),
        ).to.equal('refused')
        expect(bot.sent).to.have.length(0)
      })

      it('failed sale: reported as a sale, deal retired', async () => {
        const account = newAccount(5, 0)
        const { bot, dealId } = buildBot({
          account,
          combo,
          long: true,
          sendFails: true,
        })
        expect(
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, true),
            ActionsEnum.sellDiff,
          ),
        ).to.equal('refused')
        expect(bot.errors[0]).to.match(/Cannot sell SOL for the USDT/)
        expect(bot.closed).to.have.length(1)
      })
    })

    describe('two legs on one account', () => {
      it("the short leg's reservation reduces the long leg's held quote", async () => {
        const account = newAccount(5, 350)
        const short = buildBot({
          account,
          combo,
          action: ActionsEnum.buyForAll,
        })
        await short.bot.fundHedgeLegEntry(
          SYMBOL,
          short.dealId,
          marketBase(short.dealId, false),
          ActionsEnum.buyForAll,
        )
        // The short spent 200 (201 combo) and holds 100 for its entry: of
        // the 150 (149) left only 50 (49) is the long's — without the
        // reservation it would sell for 47, not 147 (148).
        const long = buildBot({ account, combo, long: true })
        expect(
          await long.bot.fundHedgeLegEntry(
            SYMBOL,
            long.dealId,
            marketBase(long.dealId, true),
            ActionsEnum.sellDiff,
          ),
        ).to.equal('virtual')
        expect(+fundingSent(long.bot)[0].origQty).to.equal(combo ? 1.48 : 1.47)
      })

      it("the long leg's reservation reduces the short leg's held base", async () => {
        const account = newAccount(4, 1000)
        const long = buildBot({
          account,
          combo,
          long: true,
          action: ActionsEnum.sellForAll,
        })
        await long.bot.fundHedgeLegEntry(
          SYMBOL,
          long.dealId,
          marketBase(long.dealId, true),
          ActionsEnum.sellForAll,
        )
        // 4 − 1.97 sold = 2.03; 1 backs the long entry ⇒ 1.03 for the
        // short's 2 (2.01 combo).
        const short = buildBot({ account, combo })
        await short.bot.fundHedgeLegEntry(
          SYMBOL,
          short.dealId,
          marketBase(short.dealId, false),
          ActionsEnum.buyDiff,
        )
        expect(+fundingSent(short.bot)[0].origQty).to.equal(combo ? 0.98 : 0.97)
      })

      it('base the short leg committed to its safety orders cannot back the long entry', async () => {
        const account = newAccount(2.5, 1000)
        const short = buildBot({ account, combo })
        await short.bot.fundHedgeLegEntry(
          SYMBOL,
          short.dealId,
          marketBase(short.dealId, false),
          ActionsEnum.buyDiff,
        )
        const long = buildBot({
          account,
          combo,
          long: true,
          action: ActionsEnum.sellForAll,
        })
        expect(
          await long.bot.fundHedgeLegEntry(
            SYMBOL,
            long.dealId,
            marketBase(long.dealId, true),
            ActionsEnum.sellForAll,
          ),
        ).to.equal('refused')
        expect(long.bot.errors[0]).to.match(/Not enough SOL/)
        const r = account.reserved()
        expect(account.base + 1e-9).to.be.gte(r.base)
        expect(account.quote + 1e-9).to.be.gte(r.quote)
      })

      it('the lock serialises two legs starting together; the books never overcommit', async () => {
        const account = newAccount(1.5, 500)
        const short = buildBot({ account, combo, tradeDelayMs: 40 })
        const long = buildBot({ account, combo, long: true, tradeDelayMs: 40 })
        const results = await Promise.all([
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
        // Every event of the first leg precedes the second leg's plan.
        const ev = account.events
        const first = ev[0].split(':')[0]
        const lastOfFirst = ev
          .map((e) => e.startsWith(`${first}:`))
          .lastIndexOf(true)
        const secondPlan = ev.findIndex(
          (e) => !e.startsWith(`${first}:`) && e.endsWith(':plan'),
        )
        expect(secondPlan).to.be.greaterThan(lastOfFirst)
        expect(results.some((r) => r !== 'refused')).to.equal(true)
        const r = account.reserved()
        expect(account.base + 1e-9).to.be.gte(r.base)
        expect(account.quote + 1e-9).to.be.gte(r.quote)
        expect(
          lockStore.held(FundingLock.getInstance().key(account.uuid)),
        ).to.equal(false)
      })

      it('a leg that throws mid-plan releases the lock and is retired', async () => {
        const account = newAccount(0, 1000)
        const broken = buildBot({ account, combo })
        broken.bot.checkAssets = async () => {
          throw new Error('venue down')
        }
        expect(
          await broken.bot.fundHedgeLegEntry(
            SYMBOL,
            broken.dealId,
            marketBase(broken.dealId, false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('refused')
        expect(broken.bot.errors[0]).to.match(/venue down/)
        expect(broken.bot.closed).to.have.length(1)
        expect(lockStore.held(FundingLock.getInstance().key(account.uuid))).to
          .be.false
        const next = buildBot({ account, combo, long: false, dealId: 'next' })
        expect(
          await next.bot.fundHedgeLegEntry(
            SYMBOL,
            'next',
            marketBase('next', false),
            ActionsEnum.buyDiff,
          ),
        ).to.equal('virtual')
      })

      it('the take profit resting on the entry comes off its reserve; other buys do not (E3)', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        await bot.fundHedgeLegEntry(
          SYMBOL,
          dealId,
          marketBase(dealId, false),
          ActionsEnum.buyDiff,
        )
        const reservation = loadModule(
          '../fundingReservation',
        ).FundingReservation.getInstance()
        const tp = {
          dealId,
          side: 'BUY',
          typeOrder: TypeOrderEnum.dealTP,
          origQty: '0.6',
          executedQty: '0.1',
          price: '100',
        }
        // A level minigrid buy paid by that level's own sale proceeds.
        const levelGrid = {
          dealId,
          side: 'BUY',
          typeOrder: TypeOrderEnum.dealGrid,
          minigridId: 'mg-level',
          origQty: '1',
          executedQty: '0',
          price: '100',
        }
        restingOrders = [tp, levelGrid]
        try {
          // 100 reserved for the entry; the TP locks 50 of it.
          expect(
            await reservation.reservedQuote(account.uuid, 'USDT', true),
          ).to.equal(50)
          tp.origQty = '5'
          expect(
            await reservation.reservedQuote(account.uuid, 'USDT', true),
          ).to.equal(0)
        } finally {
          restingOrders = []
        }
      })

      it('the base level minigrid comes off the reserve (E3)', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({ account, combo })
        await bot.fundHedgeLegEntry(
          SYMBOL,
          dealId,
          marketBase(dealId, false),
          ActionsEnum.buyDiff,
        )
        const reservation = loadModule(
          '../fundingReservation',
        ).FundingReservation.getInstance()
        const savedGrid = dbInit.minigridDb.readData
        dbInit.minigridDb.readData = async () => ({
          status: StatusEnum.ok,
          data: {
            result: [
              { _id: 'mg-base', dcaOrderId: 'D-BO-x' },
              { _id: 'mg-level', dcaOrderId: 'D-RO-1' },
            ],
          },
        })
        baseStarts = ['D-BO-x']
        restingOrders = [
          {
            dealId,
            side: 'BUY',
            typeOrder: TypeOrderEnum.dealGrid,
            minigridId: 'mg-base',
            origQty: '0.3',
            executedQty: '0',
            price: '100',
          },
          {
            dealId,
            side: 'BUY',
            typeOrder: TypeOrderEnum.dealGrid,
            minigridId: 'mg-level',
            origQty: '0.5',
            executedQty: '0',
            price: '100',
          },
        ]
        try {
          expect(
            await reservation.reservedQuote(account.uuid, 'USDT', true),
          ).to.be.closeTo(70, 1e-9)
        } finally {
          restingOrders = []
          baseStarts = []
          dbInit.minigridDb.readData = savedGrid
        }
      })
    })

    describe('pending-order hold (decision 1)', () => {
      const level = (price: number, qty = 1) => ({
        clientOrderId: `D-RO-${price}`,
        typeOrder: TypeOrderEnum.dealRegular,
        side: OrderSideEnum.sell,
        status: 'NEW',
        origQty: `${qty}`,
        executedQty: '0',
        price: `${price}`,
      })

      it('levels not placed at startDeal stay held until each is placed', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, rows } = buildBot({
          account,
          combo,
          settings: { activeOrdersCount: 1 },
        })
        bot.placeOnStart = [level(101)]
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        const pad = combo ? 0.005 : 0
        // One of two levels rested: the other's need is still held.
        expect(findDeal.deal.fundingHold.remaining).to.be.closeTo(1 + pad, 1e-9)
        expect(account.reserved().base).to.be.closeTo(1 + pad, 1e-9)
        rows.push(level(102))
        await bot.syncFundingHold(findDeal.deal._id)
        expect(findDeal.deal.fundingHold.remaining).to.equal(0)
      })

      it('a closed deal holds nothing', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        await bot.fundHedgeLegEntry(
          SYMBOL,
          dealId,
          marketBase(dealId, false),
          ActionsEnum.buyDiff,
        )
        expect(findDeal.deal.fundingHold.remaining).to.be.greaterThan(0)
        await bot.closeDealById(bot.botId, dealId, 'cancel', false)
        const reservation = loadModule(
          '../fundingReservation',
        ).FundingReservation.getInstance()
        expect(
          await reservation.reservedBase(account.uuid, 'SOL', true),
        ).to.equal(0)
      })
    })

    describe('placeBaseOrder — the hedge branch', () => {
      it('funded leg: virtual entry started; the hold drops as its orders are placed', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({ account, combo })
        bot.placeOnStart = [
          {
            clientOrderId: 'D-RO-1',
            typeOrder: TypeOrderEnum.dealRegular,
            side: OrderSideEnum.sell,
            status: 'NEW',
            origQty: '1',
            executedQty: '0',
            price: '101',
          },
          {
            clientOrderId: 'D-RO-2',
            typeOrder: TypeOrderEnum.dealRegular,
            side: OrderSideEnum.sell,
            status: 'NEW',
            origQty: '1',
            executedQty: '0',
            price: '102',
          },
        ]
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(fundingSent(bot)).to.have.length(1)
        expect(bot.started).to.have.length(1)
        const { order, hold } = bot.started[0]
        expect(order).to.deep.include({
          dealId,
          typeOrder: TypeOrderEnum.dealStart,
          status: 'FILLED',
          fundingSource: 'virtual',
          price: `${PRICE}`,
        })
        // Held while startDeal placed the safety orders, released after.
        expect(hold.remaining).to.equal(combo ? 2.01 : 2)
        expect(findDeal.deal.fundingHold.remaining).to.equal(0)
        expect(findDeal.deal.botFunding.virtualEntry.quoteReserved).to.equal(
          100,
        )
        expect(account.reserved()).to.deep.equal({ base: 0, quote: 100 })
      })

      it('refused leg: retired, never started', async () => {
        const account = newAccount(0, 10)
        const { bot } = buildBot({ account, combo })
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(bot.started).to.have.length(0)
        expect(bot.closed).to.have.length(1)
      })

      it('useOppositeBalance: unchanged — virtual base, no trade, no lock, nothing held', async () => {
        const account = newAccount(0, 0)
        const { bot, findDeal } = buildBot({
          account,
          combo,
          action: ActionsEnum.useOppositeBalance,
        })
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(bot.sent).to.have.length(0)
        expect(bot.closed).to.have.length(0)
        expect(bot.started).to.have.length(1)
        expect(bot.started[0].order).to.deep.include({
          status: 'FILLED',
          fundingSource: 'virtual',
          price: '97',
        })
        expect(findDeal.deal.botFunding).to.equal(undefined)
        expect(findDeal.deal.fundingHold).to.equal(undefined)
      })

      it('noAction: unchanged — refused, nothing sent', async () => {
        const account = newAccount(0, 1000)
        const { bot } = buildBot({
          account,
          combo,
          action: ActionsEnum.noAction,
        })
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(bot.sent).to.have.length(0)
        expect(bot.started).to.have.length(0)
        expect(bot.errors[0]).to.match(/Action is noAction/)
      })

      it('buyDiff without DCA: the real base order is sent, checked and held under the lock', async () => {
        const account = newAccount(1, 0)
        const { bot, findDeal } = buildBot({
          account,
          combo,
          settings: { useDca: false },
        })
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(fundingSent(bot)).to.have.length(0)
        expect(bot.sent[0]?.typeOrder).to.equal(TypeOrderEnum.dealStart)
        expect(findDeal.deal.botFunding).to.equal(undefined)
        expect(findDeal.deal.fundingHold).to.deep.include({
          asset: 'base',
          committed: 1,
        })
      })

      it('useBalance: refused under the lock when held funds do not cover it, sent when they do', async () => {
        const poor = buildBot({
          account: newAccount(0, 0),
          combo,
          action: ActionsEnum.useBalance,
        })
        await poor.bot.placeBaseOrder(poor.bot.botId, SYMBOL)
        expect(poor.bot.sent).to.have.length(0)
        expect(poor.bot.closed).to.have.length(1)
        const rich = buildBot({
          account: newAccount(5, 0),
          combo,
          action: ActionsEnum.useBalance,
        })
        await rich.bot.placeBaseOrder(rich.bot.botId, SYMBOL)
        expect(rich.bot.sent[0]?.typeOrder).to.equal(TypeOrderEnum.dealStart)
      })
    })

    describe('restart while funding (decision 8)', () => {
      const funded = (account: Account, pendingTrade?: any) =>
        buildBot({
          account,
          combo,
          botFunding: {
            mode: BaseFundingEnum.auto,
            virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
            lotIds: [],
            sourcedByBot: true,
            ...(pendingTrade ? { pendingTrade } : {}),
          },
          fundingHold: { asset: 'base', committed: 2, remaining: 2 },
        })
      const intent = {
        clientOrderId: `D-FND-restart-${kind}`,
        side: OrderSideEnum.buy,
        qty: 2,
        at: 1,
      }

      it('funding order found filled: lot recorded, virtual entry resumed, no real base order', async () => {
        const account = newAccount(2, 800)
        const { bot, findDeal, dealId } = funded(account, intent)
        bot.ordersDb.readData = async () => ({
          status: StatusEnum.ok,
          data: {
            result: {
              ...intent,
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
        expect(bot.sent).to.have.length(0)
        expect(bot.started).to.have.length(1)
        expect(bot.started[0].order).to.deep.include({
          status: 'FILLED',
          fundingSource: 'virtual',
          price: `${PRICE}`,
        })
        expect(lots.at(-1)).to.deep.include({
          clientOrderId: intent.clientOrderId,
          dealId,
          qty: 2,
        })
        expect(findDeal.deal.botFunding.pendingTrade).to.equal(undefined)
        expect(findDeal.deal.botFunding.lotIds).to.have.length(1)
      })

      it('funding order not filled or not found: retired, no real base order', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = funded(account, intent)
        bot.ordersDb.readData = async () => ({
          status: StatusEnum.ok,
          data: { result: null },
        })
        bot.getOrder = async () => ({ status: StatusEnum.notok, data: null })
        await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
        expect(bot.sent).to.have.length(0)
        expect(bot.started).to.have.length(0)
        expect(bot.closed).to.have.length(1)
      })

      it('funding recorded but the base row lost: rebuilt from the record and started', async () => {
        const account = newAccount(2, 900)
        const { bot, dealId } = funded(account)
        await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
        expect(bot.sent).to.have.length(0)
        expect(bot.started).to.have.length(1)
        expect(bot.started[0].order).to.deep.include({
          status: 'FILLED',
          executedQty: '1',
          price: `${PRICE}`,
          fundingSource: 'virtual',
        })
      })
    })

    describe('beta gate (spec 044): deals created without base funding', () => {
      it('hedge funding action: the phase-1 send (dealStart + deal id), no lot, no re-price', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          nonBeta: true,
        })
        if (!combo) {
          // A non-beta DCA deal never records the action (it was always
          // dropped on DCA deals): exercise the phase-1 path as combo has it.
          findDeal.deal.action = ActionsEnum.buyDiff
        }
        const lotsBefore = lots.length
        let funded = 0
        bot.fundHedgeLegEntry = async () => {
          funded++
          return 'virtual'
        }
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(funded).to.equal(0)
        expect(fundingSent(bot)).to.have.length(0)
        const [send] = bot.sent
        expect(send).to.deep.include({
          typeOrder: TypeOrderEnum.dealStart,
          dealId,
          side: OrderSideEnum.buy,
          type: 'MARKET',
        })
        expect(send.clientOrderId).to.match(/^CMB-H/)
        expect(lots.length).to.equal(lotsBefore)
        expect(bot.started).to.have.length(1)
        // The virtual entry keeps the price it was built with.
        expect(bot.started[0].order).to.deep.include({
          status: 'FILLED',
          fundingSource: 'virtual',
          price: '97',
        })
        expect(findDeal.deal.botFunding).to.equal(undefined)
        expect(findDeal.deal.fundingHold).to.equal(undefined)
      })

      it('a DCA deal records no hedge action (plain base order), combo keeps it', async () => {
        const account = newAccount(0, 1000)
        const { bot } = buildBot({ account, combo, nonBeta: true })
        bot.data.action = ActionsEnum.buyDiff
        expect(bot.dealStartAction(false)).to.equal(
          combo ? ActionsEnum.buyDiff : undefined,
        )
        expect(bot.dealStartAction(true)).to.equal(ActionsEnum.buyDiff)
        bot.data.settings = { ...bot.data.settings, futures: true }
        expect(bot.dealStartAction(true)).to.equal(undefined)
      })

      it('a DCA hedge deal without an action sends its real base order', async () => {
        const account = newAccount(5, 1000)
        const { bot, findDeal } = buildBot({ account, combo, nonBeta: true })
        findDeal.deal.action = undefined
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(fundingSent(bot)).to.have.length(0)
        expect(bot.sent[0]?.typeOrder).to.equal(TypeOrderEnum.dealStart)
        expect(bot.sent[0]?.clientOrderId).to.equal('D-BO-x')
      })

      it('baseFunding auto is treated as require', async () => {
        const account = newAccount(0, 1000)
        const { bot, dealId } = buildBot({
          account,
          combo,
          nonBeta: true,
          plain: true,
          settings: { strategy: 'SHORT', baseFunding: BaseFundingEnum.auto },
        })
        bot.data.action = undefined
        expect(
          await bot.fundShortSpotEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
          ),
        ).to.equal('held')
        expect(
          bot.shortSpotFundingMode(await bot.getAggregatedSettings(), false),
        ).to.equal(null)
        expect(bot.sent).to.have.length(0)
      })

      it('a restored start deal never resumes or funds; it sends its base order as before', async () => {
        const account = newAccount(5, 1000)
        const { bot, dealId } = buildBot({
          account,
          combo,
          nonBeta: true,
          botFunding: {
            mode: BaseFundingEnum.auto,
            virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
            lotIds: [],
            sourcedByBot: true,
            pendingTrade: {
              clientOrderId: 'D-FND-nb',
              side: OrderSideEnum.buy,
              qty: 2,
              at: 1,
            },
          },
        })
        let entered = 0
        bot.resumeFundedEntry = async () => {
          entered++
          return 'none'
        }
        bot.fundHedgeLegEntry = async () => {
          entered++
          return 'virtual'
        }
        await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
        expect(entered).to.equal(0)
        expect(bot.sent[0]?.typeOrder).to.equal(TypeOrderEnum.dealStart)
      })

      it('add DCA on a hedge leg created without base funding never funds', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          nonBeta: true,
          status: 'open',
          botFunding: {
            mode: BaseFundingEnum.auto,
            virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
            lotIds: [],
            sourcedByBot: true,
          },
        })
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 4 }),
        ).to.equal(true)
        expect(bot.sent).to.have.length(0)
      })
    })

    describe('beta gate (spec 044): the stamp outlives the role', () => {
      it('a stamped deal is funded after the role was removed', async () => {
        const account = newAccount(0, 1000)
        const { bot } = buildBot({ account, combo })
        bot.baseFundingAllowed = async () => false
        await bot.placeBaseOrder(bot.botId, SYMBOL)
        expect(fundingSent(bot)).to.have.length(1)
        expect(bot.started).to.have.length(1)
      })

      it('a stamped deal resumes after the role was removed', async () => {
        const account = newAccount(2, 900)
        const { bot, dealId } = buildBot({
          account,
          combo,
          botFunding: {
            mode: BaseFundingEnum.auto,
            virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
            lotIds: [],
            sourcedByBot: true,
          },
        })
        bot.baseFundingAllowed = async () => false
        await bot.placeBaseOrder(bot.botId, SYMBOL, dealId)
        expect(bot.sent).to.have.length(0)
        expect(bot.started).to.have.length(1)
      })

      it('add DCA on a stamped funded leg still funds after the role was removed', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          status: 'open',
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
        bot.baseFundingAllowed = async () => false
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 4 }),
        ).to.equal(true)
        expect(fundingSent(bot)).to.have.length(1)
      })
    })

    describe('fills', () => {
      it('a filled funding order never reaches startDeal', async () => {
        const account = newAccount(0, 1000)
        const { bot } = buildBot({ account, combo })
        await bot.processFilledOrder({
          clientOrderId: 'D-FND-x',
          typeOrder: TypeOrderEnum.funding,
          status: 'FILLED',
          side: OrderSideEnum.buy,
          symbol: SYMBOL,
          price: `${PRICE}`,
          origQty: '2',
          executedQty: '2',
          updateTime: Date.now(),
          botId: bot.botId,
        })
        expect(bot.started).to.have.length(0)
      })
    })

    describe('add DCA levels on a funded hedge leg (D7)', () => {
      const restingAt = (side: OrderSideEnum, prices: number[]) =>
        prices.map((price, i) => ({
          clientOrderId: `D-RO-${i}`,
          typeOrder: TypeOrderEnum.dealRegular,
          side,
          status: 'NEW',
          origQty: '1',
          executedQty: '0',
          price: `${price}`,
        }))
      const shortFunding = {
        mode: BaseFundingEnum.auto,
        virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
        lotIds: [],
        sourcedByBot: true,
      }

      it('short: buys the base the new levels need; the hold grows with the ladder', async () => {
        const account = newAccount(0, 1000)
        const pad = combo ? 0.005 : 0
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          status: 'open',
          botFunding: shortFunding,
          fundingHold: { asset: 'base', committed: 2 + 2 * pad, remaining: 0 },
          resting: restingAt(OrderSideEnum.sell, [101, 102]),
        })
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 4 }),
        ).to.equal(true)
        const [trade] = fundingSent(bot)
        expect(trade.side).to.equal(OrderSideEnum.buy)
        // Combo pads every level, the resting ones included.
        expect(+trade.origQty).to.equal(combo ? 2.02 : 2)
        expect(findDeal.deal.botFunding.lotIds).to.have.length(1)
        expect(findDeal.deal.botFunding.virtualEntry.quoteReserved).to.equal(
          100,
        )
        // Two new levels, not on the book until the ladder is rebuilt.
        expect(findDeal.deal.fundingHold.committed).to.be.closeTo(
          4 + 4 * pad,
          1e-9,
        )
        expect(findDeal.deal.fundingHold.remaining).to.be.closeTo(
          2 + 2 * pad,
          1e-9,
        )
      })

      it('a cut needs no trade and never takes the lock', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          status: 'open',
          botFunding: shortFunding,
          resting: restingAt(OrderSideEnum.sell, [101, 102]),
        })
        const lock = FundingLock.getInstance()
        lock.setStore({
          setNxPx: async () => undefined,
          delIfValue: async () => undefined,
        })
        try {
          expect(
            await bot.fundAddedSafetyOrders(findDeal, dealId, {
              ordersCount: 1,
            }),
          ).to.equal(true)
        } finally {
          lock.setStore(lockStore)
        }
        expect(bot.sent).to.have.length(0)
      })

      it('long: sells base for the quote the new levels need', async () => {
        const account = newAccount(5, 0)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          long: true,
          status: 'open',
          botFunding: {
            mode: BaseFundingEnum.auto,
            virtualEntry: {
              qty: 1,
              price: PRICE,
              quoteReserved: 0,
              baseReserved: 1,
            },
            lotIds: [],
            sourcedByBot: false,
          },
          resting: restingAt(OrderSideEnum.buy, [99, 98]),
        })
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 4 }),
        ).to.equal(true)
        const [trade] = fundingSent(bot)
        expect(trade.side).to.equal(OrderSideEnum.sell)
        // Levels 3 and 4 at 97 and 96: 193 quote, nothing held.
        expect(+trade.origQty).to.equal(1.93)
        expect(lots.at(-1).asset).to.equal('USDT')
      })

      it('long: the entry base is not for sale', async () => {
        // 1 SOL backs the entry; selling for 193 needs 1.93 more.
        const account = newAccount(2.5, 0)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          long: true,
          status: 'open',
          botFunding: {
            mode: BaseFundingEnum.auto,
            virtualEntry: {
              qty: 1,
              price: PRICE,
              quoteReserved: 0,
              baseReserved: 1,
            },
            lotIds: [],
            sourcedByBot: false,
          },
          resting: restingAt(OrderSideEnum.buy, [99, 98]),
        })
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 4 }),
        ).to.equal(false)
        expect(bot.sent).to.have.length(0)
        expect(bot.errors[0]).to.match(/Not enough SOL to sell/)
      })

      it('a hedge leg the bot did not fund is not funded on add', async () => {
        const account = newAccount(0, 1000)
        const { bot, findDeal, dealId } = buildBot({
          account,
          combo,
          status: 'open',
          action: ActionsEnum.useOppositeBalance,
          resting: restingAt(OrderSideEnum.sell, [101, 102]),
        })
        expect(
          await bot.fundAddedSafetyOrders(findDeal, dealId, { ordersCount: 4 }),
        ).to.equal(true)
        expect(bot.sent).to.have.length(0)
      })
    })

    if (combo) {
      describe('combo fee order (D8)', () => {
        it('is placed on a bot-funded deal (its funds were planned at open)', async () => {
          const account = newAccount(0, 1000)
          const { bot, findDeal, dealId } = buildBot({ account, combo })
          bot.data.settings = { ...bot.data.settings, feeOrder: true }
          findDeal.deal.botFunding = {
            mode: BaseFundingEnum.auto,
            virtualEntry: { qty: 1, price: PRICE, quoteReserved: 100 },
            lotIds: [],
            sourcedByBot: true,
          }
          await bot.placeFeeOrder(bot.botId, dealId, 'D-BO-x')
          expect(bot.feeOrders).to.have.length(1)
        })

        it('its size is bought with the safety orders at open (short) …', async () => {
          const account = newAccount(0, 1000)
          const { bot, dealId } = buildBot({
            account,
            combo,
            action: ActionsEnum.buyForAll,
          })
          bot.data.settings = { ...bot.data.settings, feeOrder: true }
          bot.getUserFee = async () => ({ maker: 0.001, taker: 0 })
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, false),
            ActionsEnum.buyForAll,
          )
          // 2.01 + max(0.001, 5/100 × 1.05, 1 × 0.001 × 10) → 0.053
          expect(+fundingSent(bot)[0].origQty).to.equal(2.063)
        })

        it('… and raised with the safety quote (long)', async () => {
          const account = newAccount(5, 0)
          const { bot, findDeal, dealId } = buildBot({
            account,
            combo,
            long: true,
            action: ActionsEnum.sellForAll,
          })
          bot.data.settings = { ...bot.data.settings, feeOrder: true }
          bot.getUserFee = async () => ({ maker: 0.001, taker: 0 })
          await bot.fundHedgeLegEntry(
            SYMBOL,
            dealId,
            marketBase(dealId, true),
            ActionsEnum.sellForAll,
          )
          // 197 + 0.053 × 100 = 202.3 quote → 2.023 base
          expect(+fundingSent(bot)[0].origQty).to.equal(2.023)
          expect(findDeal.deal.fundingHold.committed).to.be.closeTo(202.3, 1e-9)
        })
      })
    }
  })
}
