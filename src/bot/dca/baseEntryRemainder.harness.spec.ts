process.env.NODE_ENV = 'testing'

/**
 * Tests for spec `111`. A part-filled LIMIT base entry on a bot that may not
 * enter at market opens the deal on what filled and rests its remainder as a
 * LIMIT add-funds order, repositioned when the price moves, and bought at
 * market only when the user asks.
 *
 * Production case: a Coinbase bot with a LIMIT entry and the "Enter Market
 * Timeout" switch off. Its base order for 341.2 at 0.2935 filled 4.1, and the
 * deal opened on those 4.1 with nothing placed for the other 337.1.
 *
 * Two layers: the pure §4.1 decision, and the REAL dcaHelper methods driven
 * over the mixin with a minimal base class. The fixture shape follows
 * `baseEntryReposition.harness.spec.ts`.
 *
 * Fixture ids are synthetic: this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  baseEntryRemainderQty,
  remainderKeepsResting,
} from './baseEntryRemainder'
import { MathHelper } from '../../utils/math'
import {
  AddFundsTypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StartConditionEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d11'
const BOT_ID = '000000000000000000000b11'
const USER_ID = '000000000000000000000411'
const SYMBOL = 'JUP-USDC'
const BASE_ID = 'D-BO-0000000000000000000000000111'
const REMAINDER_ID = 'D-ROA-000000000000000000000000111'
const ENTRY_ID = '00000000-0000-4000-8000-000000000111'

/** The production entry: 4.1 of 341.2 at 0.2935. */
const baseRow = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'base-1',
    clientOrderId: BASE_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '0.2935',
    origPrice: '0.2935',
    origQty: '341.2',
    executedQty: '4.1',
    status: 'FILLED',
    updateTime: Date.now() - 2_000,
    transactTime: Date.now() - 12_000,
    ...over,
  }) as any

const remainderEntry = (over: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  qty: '337.1',
  asset: OrderSizeTypeEnum.base,
  useLimitPrice: true,
  limitPrice: '0.2935',
  type: AddFundsTypeEnum.fixed,
  baseRemainder: true,
  baseTotal: '341.2',
  ...over,
})

const remainderRow = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'rem-1',
    clientOrderId: REMAINDER_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '0.2935',
    origPrice: '0.2935',
    origQty: '337.1',
    executedQty: '0',
    status: 'NEW',
    addFundsId: ENTRY_ID,
    updateTime: Date.now() - 2_000,
    transactTime: Date.now() - 12_000,
    ...over,
  }) as any

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  data: any = {
    settings: {
      type: 'regular',
      pair: [SYMBOL],
      notUseLimitReposition: false,
    },
    exchange: ExchangeEnum.coinbase,
    paperContext: false,
    flags: [],
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  added: any[]
  cancelled: any[]
  booked: any[]
  errors: string[]
  saved: any[]
  sentOrders: any[]
  events: any[]
}

const buildBot = (
  opts: {
    status?: DCADealStatusEnum
    pending?: any[]
    orders?: any[]
    latestPrice?: number
    startOrderType?: OrderTypeEnum
    /** `0` = the "Enter Market Timeout" switch is off (spec `100`). */
    enterMarketTimeout?: number
    cancelAnswer?: (o: any) => any
    combo?: boolean
    coinm?: boolean
    /** Drive the real `addDealFunds`; the venue answers `sent`. */
    sent?: (o: any) => any
    terminalDealType?: string
  } = {},
) => {
  const {
    status = DCADealStatusEnum.open,
    pending = [],
    orders = [],
    latestPrice = 0.2935,
    startOrderType = OrderTypeEnum.limit,
    enterMarketTimeout = 0,
    cancelAnswer = (o: any) => ({ ...o, status: 'CANCELED' }),
    combo = false,
    coinm = false,
    sent,
    terminalDealType,
  } = opts
  const raised: Raised = {
    added: [],
    cancelled: [],
    booked: [],
    errors: [],
    saved: [],
    sentOrders: [],
    events: [],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status,
      symbol: { symbol: SYMBOL, baseAsset: 'JUP', quoteAsset: 'USDC' },
      createTime: Date.now() - 60_000,
      settings: {},
      profit: {},
      levels: { all: 3, complete: 1 },
      pendingAddFunds: pending,
      funds: [] as any[],
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  const orderMap = new Map<string, any>(orders.map((o) => [o.clientOrderId, o]))
  class TestBot extends Helper {
    raised = raised
    deal = deal
    combo = combo
    coinm = coinm
    math = new MathHelper()
    orderLimitRepositionTimeout = 10_000
    enterMarketTimeout = enterMarketTimeout
    limitFallbackTimeout = enterMarketTimeout || 35_000
    orders = orderMap
    dealTimersMap = new Map<string, any>()
    botEventDb = {
      createData: async (e: any) => {
        raised.events.push(e)
        return { status: 'OK' }
      },
    }
    getOrderFromMap(id: string) {
      return orderMap.get(id)
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId(args: { status?: string | string[] }) {
      const want = args?.status
        ? Array.isArray(args.status)
          ? args.status
          : [args.status]
        : undefined
      return [...orderMap.values()].filter(
        (o) => !want || want.includes(o.status),
      )
    }
    async getLatestPrice() {
      return latestPrice
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 4,
        baseAsset: { name: 'JUP', minAmount: 0.1 },
        quoteAsset: { name: 'USDC', minAmount: 1 },
      }
    }
    async baseAssetPrecision() {
      return 1
    }
    async getAggregatedSettings() {
      return {
        type: 'regular',
        startOrderType,
        startCondition: StartConditionEnum.asap,
        terminalDealType,
      }
    }
    getOrderId(prefix: string) {
      return `${prefix}-${raised.sentOrders.length}`
    }
    async sendOrderToExchange(o: any) {
      raised.sentOrders.push({ ...o })
      return sent?.(o)
    }
    updateUsage() {}
    updateAssets() {}
    updateDealBalances() {}
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push({ ...o })
      const answer = cancelAnswer(o)
      if (answer) {
        orderMap.set(o.clientOrderId, answer)
      }
      return answer
    }
    async handleUnknownOrder(o: any) {
      raised.booked.push({ ...o })
      // The add-funds fill path removes the entry it filled.
      deal.deal.pendingAddFunds = deal.deal.pendingAddFunds.filter(
        (p: any) => p.id !== o.addFundsId,
      )
    }
    saveDeal(_d: any, update: any) {
      raised.saved.push(update)
      return Promise.resolve()
    }
    async updateOrderOnDb() {}
    setOrder(o: any) {
      orderMap.set(o.clientOrderId, o)
    }
    emit() {
      return true
    }
    handleErrors(msg: string) {
      raised.errors.push(msg)
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  if (!sent) {
    bot.addDealFunds = async (
      _botId: string,
      dealId: string,
      settings: any,
    ) => {
      raised.added.push({ dealId, ...settings })
    }
  }
  return bot
}

const clearTimers = (bot: any) => {
  for (const t of (bot.baseRemainderTimers ?? new Map()).values()) {
    clearTimeout(t)
  }
}

describe('a part-filled LIMIT base entry rests its remainder (spec 111)', () => {
  describe('§4.1 the decision', () => {
    const live = {
      marketEntryAllowed: false,
      unitSafe: true,
      executedQty: '4.1',
      origQty: '341.2',
    }
    it('§4.1 the unfilled part of a short entry on a no-market bot', () => {
      expect(baseEntryRemainderQty(live)).to.be.closeTo(337.1, 1e-9)
    })
    it('§4.1 nothing for a bot that may enter at market (spec 057 tops it up)', () => {
      expect(
        baseEntryRemainderQty({ ...live, marketEntryAllowed: true }),
      ).to.equal(0)
    })
    it('§4.1 nothing where the two quantities may be in different units', () => {
      expect(baseEntryRemainderQty({ ...live, unitSafe: false })).to.equal(0)
    })
    it('§4.1 nothing for a whole entry, an empty one, or unreadable sizes', () => {
      expect(baseEntryRemainderQty({ ...live, executedQty: '341.2' })).to.equal(
        0,
      )
      expect(baseEntryRemainderQty({ ...live, executedQty: '0' })).to.equal(0)
      for (const origQty of ['', 'NaN', undefined, null]) {
        expect(
          baseEntryRemainderQty({ ...live, origQty }),
          `${origQty}`,
        ).to.equal(0)
      }
    })
    it('§4.3.2 a part-filled remainder at an unchanged price is still resting', () => {
      const same = {
        orderStatus: 'PARTIALLY_FILLED',
        orderType: OrderTypeEnum.limit,
        restingPrice: '0.2935',
        repositionPrice: 0.2935,
      }
      expect(remainderKeepsResting(same)).to.equal(true)
      expect(remainderKeepsResting({ ...same, orderStatus: 'NEW' })).to.equal(
        true,
      )
      expect(
        remainderKeepsResting({ ...same, repositionPrice: 0.2944 }),
      ).to.equal(false)
      expect(
        remainderKeepsResting({ ...same, orderStatus: 'CANCELED' }),
      ).to.equal(false)
    })
  })

  describe('the real engine methods', () => {
    before(function () {
      // One ts-node compile of a 26k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    let bot: any
    afterEach(() => bot && clearTimers(bot))

    it('§1.1.2/§4.1 the deal opened on 4.1 of 341.2 rests 337.1 as a LIMIT at the latest price', async () => {
      bot = buildBot({})
      await bot.restBaseEntryRemainder(baseRow())
      const { added } = bot.raised as Raised
      expect(added).to.have.length(1)
      expect(added[0]).to.include({
        dealId: DEAL_ID,
        qty: '337.1',
        asset: OrderSizeTypeEnum.base,
        useLimitPrice: true,
        limitPrice: '0.2935',
        baseRemainder: true,
        baseTotal: '341.2',
      })
      expect(bot.baseRemainderTimers.has(DEAL_ID), 'tick armed').to.equal(true)
      const { events } = bot.raised as Raised
      expect(events, 'the deal says what the pending order is').to.have.length(
        1,
      )
      expect(events[0].description).to.contain('337.1 of 341.2')
    })

    it('§4.1/§4.8 a bot that may enter at market rests nothing', async () => {
      bot = buildBot({ enterMarketTimeout: 35_000 })
      await bot.restBaseEntryRemainder(baseRow())
      expect((bot.raised as Raised).added).to.have.length(0)
      bot = buildBot({ startOrderType: OrderTypeEnum.market })
      await bot.restBaseEntryRemainder(baseRow())
      expect((bot.raised as Raised).added).to.have.length(0)
    })

    it('§4.1 nothing below the venue minimum, on combo, coin-m, or a deal not open', async () => {
      bot = buildBot({})
      await bot.restBaseEntryRemainder(baseRow({ executedQty: '338' }))
      expect((bot.raised as Raised).added, 'below min').to.have.length(0)
      bot = buildBot({ combo: true })
      await bot.restBaseEntryRemainder(baseRow())
      expect((bot.raised as Raised).added, 'combo').to.have.length(0)
      bot = buildBot({ coinm: true })
      await bot.restBaseEntryRemainder(baseRow())
      expect((bot.raised as Raised).added, 'coinm').to.have.length(0)
      bot = buildBot({ status: DCADealStatusEnum.closed })
      await bot.restBaseEntryRemainder(baseRow())
      expect((bot.raised as Raised).added, 'closed').to.have.length(0)
    })

    it('§4.3.2 an unchanged price keeps the remainder and re-arms', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [
          remainderRow({ status: 'PARTIALLY_FILLED', executedQty: '20' }),
        ],
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(0)
      expect(raised.added).to.have.length(0)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(true)
    })

    it('§1.1.3/§4.3.3 a moved price re-places the unfilled rest as a LIMIT at the new price', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [remainderRow()],
        latestPrice: 0.29441,
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(1)
      expect(raised.booked, 'nothing had filled').to.have.length(0)
      expect(bot.deal.deal.pendingAddFunds, 'old entry removed').to.have.length(
        0,
      )
      expect(raised.added).to.have.length(1)
      expect(raised.added[0]).to.include({
        qty: '337.1',
        useLimitPrice: true,
        limitPrice: '0.2944',
        baseRemainder: true,
        baseTotal: '341.2',
      })
    })

    it('§4.3.3 a fill the cancel reports is booked and only the rest re-placed', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [
          remainderRow({ status: 'PARTIALLY_FILLED', executedQty: '100' }),
        ],
        latestPrice: 0.2944,
        cancelAnswer: (o) => ({ ...o, status: 'FILLED', executedQty: '100' }),
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.booked).to.have.length(1)
      expect(raised.booked[0].executedQty).to.equal('100')
      expect(raised.added).to.have.length(1)
      expect(raised.added[0].qty).to.equal('237.1')
    })

    it('§4.3.3 (spec 059) a cancel answer that drops the fill does not lose it', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [
          remainderRow({ status: 'PARTIALLY_FILLED', executedQty: '100' }),
        ],
        latestPrice: 0.2944,
        // Kraken-style cancel response: no fill report at all.
        cancelAnswer: (o) => ({
          ...o,
          status: 'CANCELED',
          executedQty: '0',
          price: '0',
        }),
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.booked, 'observed fill booked').to.have.length(1)
      expect(raised.booked[0]).to.include({
        status: 'FILLED',
        executedQty: '100',
      })
      expect(raised.added[0].qty).to.equal('237.1')
    })

    it('§4.3.4 no terminal cancel answer: nothing re-placed, tick re-armed', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [remainderRow()],
        latestPrice: 0.2944,
        cancelAnswer: () => undefined,
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.added).to.have.length(0)
      expect(bot.deal.deal.pendingAddFunds, 'entry kept').to.have.length(1)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(true)
    })

    it('§4.3.1 the tick stops on a deal that is no longer open, or has no remainder', async () => {
      bot = buildBot({
        status: DCADealStatusEnum.closed,
        pending: [remainderEntry()],
        orders: [remainderRow()],
        latestPrice: 0.2944,
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      expect((bot.raised as Raised).cancelled).to.have.length(0)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(false)
      bot = buildBot({
        pending: [remainderEntry({ baseRemainder: undefined })],
        orders: [remainderRow()],
        latestPrice: 0.2944,
      })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      expect((bot.raised as Raised).cancelled, 'user add funds').to.have.length(
        0,
      )
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(false)
    })

    it('§4.3.5 no resting order yet: nothing sent, tick re-armed', async () => {
      bot = buildBot({ pending: [remainderEntry()], latestPrice: 0.2944 })
      await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
      expect((bot.raised as Raised).added).to.have.length(0)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(true)
    })

    it('§4.2 no path of the tick sends a MARKET order', async () => {
      for (const latestPrice of [0.2935, 0.2944, 0.25]) {
        bot = buildBot({
          pending: [remainderEntry()],
          orders: [remainderRow()],
          latestPrice,
        })
        await bot.checkBaseEntryRemainder(BOT_ID, DEAL_ID, SYMBOL)
        for (const a of (bot.raised as Raised).added) {
          expect(a.useLimitPrice, `${latestPrice}`).to.equal(true)
        }
        clearTimers(bot)
      }
    })

    it('§1.1.4/§4.6 buy the rest at market: cancel, book the fill, MARKET the rest', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [
          remainderRow({ status: 'PARTIALLY_FILLED', executedQty: '100' }),
        ],
        cancelAnswer: (o) => ({ ...o, status: 'FILLED', executedQty: '100' }),
      })
      bot.armBaseRemainderTick(DEAL_ID, SYMBOL)
      await bot.buyBaseEntryRemainder(BOT_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(1)
      expect(raised.booked).to.have.length(1)
      expect(raised.added).to.have.length(1)
      expect(raised.added[0]).to.include({
        qty: '237.1',
        asset: OrderSizeTypeEnum.base,
        useLimitPrice: false,
      })
      expect(raised.added[0].baseRemainder, 'a plain market add').to.equal(
        undefined,
      )
      expect(bot.deal.deal.pendingAddFunds).to.have.length(0)
      expect(bot.baseRemainderTimers.has(DEAL_ID), 'tick stopped').to.equal(
        false,
      )
    })

    it('§4.6 buy at market with no terminal cancel answer buys nothing', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [remainderRow()],
        cancelAnswer: () => undefined,
      })
      await bot.buyBaseEntryRemainder(BOT_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.added).to.have.length(0)
      expect(raised.errors).to.have.length(1)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(true)
    })

    it('§4.6 buy at market on a deal with no remainder reports an error', async () => {
      bot = buildBot({ pending: [remainderEntry({ baseRemainder: false })] })
      await bot.buyBaseEntryRemainder(BOT_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.added).to.have.length(0)
      expect(raised.errors).to.have.length(1)
    })

    it('§4.4 restore arms the tick for a deal with a resting remainder only', async () => {
      bot = buildBot({ pending: [remainderEntry()] })
      bot.resumeBaseEntryRemainder(bot.deal)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(true)
      clearTimers(bot)
      bot = buildBot({
        pending: [remainderEntry({ baseRemainder: undefined })],
      })
      bot.resumeBaseEntryRemainder(bot.deal)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(false)
    })

    it('§4.3 repositioning off: no tick is armed', async () => {
      bot = buildBot({})
      bot.data.settings.notUseLimitReposition = true
      await bot.restBaseEntryRemainder(baseRow())
      expect((bot.raised as Raised).added).to.have.length(1)
      expect(bot.baseRemainderTimers.has(DEAL_ID)).to.equal(false)
    })

    it('§3.1/§4.1 the real addDealFunds rests a LIMIT and records the remainder on the deal', async () => {
      bot = buildBot({ sent: (o) => ({ ...o, orderId: 'v-1', status: 'NEW' }) })
      await bot.restBaseEntryRemainder(baseRow())
      const raised = bot.raised as Raised
      expect(raised.sentOrders).to.have.length(1)
      expect(raised.sentOrders[0]).to.include({
        type: 'LIMIT',
        side: 'BUY',
        origQty: '337.1',
        price: '0.2935',
        typeOrder: TypeOrderEnum.dealRegular,
        dealId: DEAL_ID,
      })
      const pending = bot.deal.deal.pendingAddFunds
      expect(pending).to.have.length(1)
      expect(pending[0]).to.include({
        id: raised.sentOrders[0].addFundsId,
        qty: '337.1',
        baseRemainder: true,
        baseTotal: '341.2',
      })
    })

    it('§4.4 (spec 110) a reload re-send keeps the remainder marking', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        sent: (o) => ({ ...o, orderId: 'v-2', status: 'NEW' }),
      })
      bot.resendPendingFunds(bot.deal)
      // `resendPendingFunds` does not await the re-send.
      await new Promise((r) => setTimeout(r, 50))
      const pending = bot.deal.deal.pendingAddFunds
      expect(pending).to.have.length(1)
      expect(pending[0]).to.include({ baseRemainder: true, baseTotal: '341.2' })
      expect(bot.baseRemainderTimers.has(DEAL_ID), 'tick armed').to.equal(true)
    })

    it('§4.6 the real addDealFunds sends the bought rest as a MARKET order', async () => {
      bot = buildBot({
        pending: [remainderEntry()],
        orders: [remainderRow()],
        sent: (o) => ({ ...o, orderId: 'v-3', status: 'NEW' }),
      })
      await bot.buyBaseEntryRemainder(BOT_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.sentOrders).to.have.length(1)
      expect(raised.sentOrders[0]).to.include({
        type: 'MARKET',
        origQty: '337.1',
      })
    })

    it('§3.2 startDeal opens the deal on 4.1 and then rests the remainder', async () => {
      bot = buildBot({ status: DCADealStatusEnum.start })
      const calls: string[] = []
      Object.assign(bot, {
        clearDealTimer: async () => undefined,
        createInitialDealOrders: async () => [],
        createCurrentDealOrders: async () => [],
        getAvgPrice: async () => ({ avg: 0.2935, display: 0.2935 }),
        computeObservedFeeLedger: async () => null,
        saveDeal: () => Promise.resolve(),
        placeOrders: async () => {
          calls.push('placeOrders')
        },
        findDiff: () => ({ new: [], cancel: [] }),
        checkOpenedDeals: async () => undefined,
        updateDealLastPrices: async () => undefined,
        checkDealSlMethods: async () => undefined,
        checkDealsAllowedMethods: async () => undefined,
        setCloseByTimer: async () => undefined,
        updateUsage: () => undefined,
        sendDealOpenedAlert: () => undefined,
        updateAssets: () => undefined,
        addDealFunds: async (_b: string, dealId: string, settings: any) => {
          calls.push('addDealFunds')
          ;(bot.raised as Raised).added.push({
            dealId,
            status: bot.deal.deal.status,
            ...settings,
          })
        },
      })
      await bot.startDeal(baseRow())
      const { added } = bot.raised as Raised
      expect(bot.deal.deal.status).to.equal(DCADealStatusEnum.open)
      expect(added).to.have.length(1)
      expect(added[0]).to.include({
        status: DCADealStatusEnum.open,
        qty: '337.1',
        baseRemainder: true,
      })
      expect(calls, 'TP/SO placed first').to.deep.equal([
        'placeOrders',
        'addDealFunds',
      ])
    })

    it('§3.2 startDeal on a whole entry rests nothing', async () => {
      bot = buildBot({ status: DCADealStatusEnum.start })
      Object.assign(bot, {
        clearDealTimer: async () => undefined,
        createInitialDealOrders: async () => [],
        createCurrentDealOrders: async () => [],
        getAvgPrice: async () => ({ avg: 0.2935, display: 0.2935 }),
        computeObservedFeeLedger: async () => null,
        saveDeal: () => Promise.resolve(),
        placeOrders: async () => undefined,
        findDiff: () => ({ new: [], cancel: [] }),
        checkOpenedDeals: async () => undefined,
        updateDealLastPrices: async () => undefined,
      })
      await bot.startDeal(baseRow({ executedQty: '341.2' }))
      expect((bot.raised as Raised).added).to.have.length(0)
    })

    it('§4.1 startDeal on a terminal "simple" deal rests nothing before closing it', async () => {
      bot = buildBot({
        status: DCADealStatusEnum.start,
        terminalDealType: 'simple',
      })
      const calls: string[] = []
      Object.assign(bot, {
        clearDealTimer: async () => undefined,
        createInitialDealOrders: async () => [],
        createCurrentDealOrders: async () => [],
        getAvgPrice: async () => ({ avg: 0.2935, display: 0.2935 }),
        computeObservedFeeLedger: async () => null,
        saveDeal: () => Promise.resolve(),
        placeOrders: async () => undefined,
        findDiff: () => ({ new: [], cancel: [] }),
        checkOpenedDeals: async () => undefined,
        updateDealLastPrices: async () => undefined,
        processDealClose: async () => {
          calls.push('processDealClose')
        },
        stop: () => undefined,
        ordersDb: { countData: async () => ({ data: { result: 1 } }) },
        addDealFunds: async () => {
          calls.push('addDealFunds')
        },
      })
      await bot.startDeal(baseRow())
      expect(bot.deal.deal.status).to.equal(DCADealStatusEnum.closed)
      expect(calls).to.deep.equal(['processDealClose'])
    })
  })
})
