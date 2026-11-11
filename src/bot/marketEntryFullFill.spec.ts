process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `235.a-filled-market-entry-waits-for-a-stream-report`.
 *
 * §4.1 / §4.2 drive the REAL `sendOrderToExchange` and `processOrderQueue`
 * off the `MainBot` prototype against a fake venue (harness shape from
 * `placementFillFeeOnce.spec.ts`). §4.3 drives the REAL Combo
 * `armMarketEntryRecheck` / `recheckMarketEntry`, and through them the REAL
 * `_handleUnknownOrder` → `handleUnknownOrder` → Combo `processFilledOrder`
 * chain; `startDeal` — the end of that chain — is recorded rather than run.
 * Quantities are the production shape: a Kraken Futures MARKET entry for 310
 * answered PARTIALLY_FILLED with all 310 executed.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import sinon from 'sinon'
import MainBot from './main'
import { ExchangeEnum, StatusEnum, TypeOrderEnum } from '../../types'
import {
  isFullyExecutedMarketPartial,
  marketEntryNeedsRecheck,
  marketEntryRecheckDelayMs,
  marketEntryRecheckMaxAttempts,
} from './marketEntryFill'

const CLIENT_ID = 'CMB-BO-000000000000000000235'
const VENUE_ID = '00000000-0000-0000-0000-000000000235'
const DEAL_ID = '000000000000000000000d35'
const BOT_ID = '000000000000000000000b35'
const SYMBOL = 'XRP-USD'
const AT = 1794000000000

const row = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    botId: BOT_ID,
    dealId: DEAL_ID,
    price: '1.1056',
    origPrice: '1.1056',
    origQty: '310',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'MARKET',
    typeOrder: TypeOrderEnum.dealStart,
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: '',
    updateTime: AT - 1000,
    transactTime: AT - 1000,
    ...over,
  }) as any

const good = (data: unknown) => ({ status: StatusEnum.ok, reason: null, data })

describe('the pure predicates (spec 235)', () => {
  it('a MARKET report PARTIALLY_FILLED for its whole size is filled', () => {
    expect(
      isFullyExecutedMarketPartial({
        type: 'MARKET',
        status: 'PARTIALLY_FILLED',
        executedQty: '310',
        origQty: '310',
      }),
    ).to.equal(true)
  })
  it('compares numbers, not strings', () => {
    // '99' > '310' lexicographically
    expect(
      isFullyExecutedMarketPartial({
        type: 'MARKET',
        status: 'PARTIALLY_FILLED',
        executedQty: '99',
        origQty: '310',
      }),
    ).to.equal(false)
  })
  it('§1.3 leaves a real part-fill, a LIMIT, and bad figures alone', () => {
    const base = { type: 'MARKET', status: 'PARTIALLY_FILLED' }
    expect(
      isFullyExecutedMarketPartial({ ...base, executedQty: '200', origQty: '310' }),
    ).to.equal(false)
    expect(
      isFullyExecutedMarketPartial({
        ...base,
        type: 'LIMIT',
        executedQty: '310',
        origQty: '310',
      }),
    ).to.equal(false)
    expect(
      isFullyExecutedMarketPartial({ ...base, executedQty: 'NaN', origQty: '310' }),
    ).to.equal(false)
    expect(
      isFullyExecutedMarketPartial({ ...base, executedQty: '0', origQty: '0' }),
    ).to.equal(false)
  })
  it('re-checks only a live MARKET entry the venue accepted, of a start deal', () => {
    const live = { type: 'MARKET', status: 'NEW', orderId: VENUE_ID }
    expect(marketEntryNeedsRecheck({ order: live, dealStatus: 'start' })).to.equal(true)
    expect(marketEntryNeedsRecheck({ order: live, dealStatus: 'open' })).to.equal(false)
    expect(
      marketEntryNeedsRecheck({ order: { ...live, orderId: '-1' }, dealStatus: 'start' }),
    ).to.equal(false)
    expect(
      marketEntryNeedsRecheck({ order: { ...live, type: 'LIMIT' }, dealStatus: 'start' }),
    ).to.equal(false)
    expect(
      marketEntryNeedsRecheck({ order: { ...live, status: 'FILLED' }, dealStatus: 'start' }),
    ).to.equal(false)
  })
})

/** A `MainBot` off the prototype whose venue answers the placement with `answer`. */
function mainBot(answer: Record<string, unknown>) {
  const logs: string[] = []
  const b: any = Object.create((MainBot as any).prototype)
  b.botId = BOT_ID
  b.userId = 'user'
  b.botType = 'combo'
  b.data = {
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: '',
    paperContext: false,
    settings: { leverage: 1, futures: true },
    flags: [],
  }
  b.orders = new Map()
  b.ordersKeys = new Set()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.partiallyFilledFilledSet = new Set()
  b.orderQueue = []
  b.processedOrders = new Map()
  b.lockProcessQueueMethod = false
  b.math = { round: (v: number, p = 8) => +(+v).toFixed(p), remainder: () => 0 }
  b.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    returnGood: () => good,
    async openOrder() {
      return good({
        ...row(),
        orderId: VENUE_ID,
        transactTime: AT,
        updateTime: AT,
        price: '1.1058',
        ...answer,
      })
    },
  }
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = (m: string) => logs.push(m)
  b.handleDebug = () => undefined
  b.handleWarn = (m: string) => logs.push(m)
  b.handleError = (m: string) => logs.push(m)
  b.handleErrors = (m: string) => logs.push(m)
  b.handleOrderErrors = async () => undefined
  b.emit = () => undefined
  b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  b.setOrdersToRedis = () => undefined
  b.setOrderByDeal = () => undefined
  b.setOrderByStatus = () => undefined
  b.removeOrderByDeal = () => undefined
  b.removeOrderByStatus = () => undefined
  b.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 4,
    baseAsset: { minAmount: 1, step: 1, name: 'XRP' },
    quoteAsset: { minAmount: 5, name: 'USD', precision: 8 },
  })
  b.getUserFee = async () => ({ maker: 0.0002, taker: 0.0005 })
  b.saveOrderToDb = async () => undefined
  b.updateOrderOnDb = async () => undefined
  b.getNotEnoughOrdersIdByOrder = () => 'nb'
  b.isComplianceGateable = () => false
  b.needToSendOrder = () => true
  b.markDealStartBlocked = async () => undefined
  b.isErrorNotEnoughBalance = () => false
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b.convertOrderQuoteQty = async (_s: string, q: string) => q
  b.ordersDb = {
    readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
    updateData: async () => ({ status: StatusEnum.ok }),
  }
  b.botEventDb = { createData: () => undefined }
  return { bot: b, logs }
}

describe('§4.1 the placement answer (spec 235)', () => {
  it('§1.1 a MARKET answered PARTIALLY_FILLED 310/310 is saved FILLED', async () => {
    const { bot } = mainBot({ status: 'PARTIALLY_FILLED', executedQty: '310' })
    const result = await bot.sendOrderToExchange(row(), true)
    expect(result.status).to.equal('FILLED')
    expect(result.executedQty).to.equal('310')
    expect(bot.orders.get(CLIENT_ID).status).to.equal('FILLED')
  })
  it('§1.3 a MARKET answered PARTIALLY_FILLED 200/310 stays part-filled', async () => {
    const { bot } = mainBot({ status: 'PARTIALLY_FILLED', executedQty: '200' })
    const result = await bot.sendOrderToExchange(row(), true)
    expect(result.status).to.equal('PARTIALLY_FILLED')
  })
  it('§1.3 a LIMIT answered PARTIALLY_FILLED 310/310 is not touched', async () => {
    const { bot } = mainBot({
      status: 'PARTIALLY_FILLED',
      executedQty: '310',
      type: 'LIMIT',
      // At its own limit price: a reply that traded away from it is classed
      // MARKET by `placedOrderType`, which is not this control.
      price: '1.1056',
    })
    const result = await bot.sendOrderToExchange(row({ type: 'LIMIT' }), true)
    expect(result.status).to.equal('PARTIALLY_FILLED')
  })
})

describe('§4.2 the user-stream report (spec 235)', () => {
  const report = (qty: string, orderType = 'MARKET') =>
    ({
      eventType: 'executionReport',
      eventTime: AT,
      orderTime: AT,
      symbol: SYMBOL,
      newClientOrderId: CLIENT_ID,
      originalClientOrderId: '',
      side: 'BUY',
      orderType,
      price: '1.1058',
      quantity: '310',
      orderStatus: 'PARTIALLY_FILLED',
      orderId: VENUE_ID,
      totalTradeQuantity: qty,
      totalQuoteTradeQuantity: `${+qty * 1.1058}`,
    }) as any

  const drain = async (b: any, onFilled: any, onPartial: any) => {
    b.processOrderQueue(b.botId, onFilled, onPartial)
    for (let i = 0; i < 200 && b.orderQueue.length; i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
  }

  it('§1.1 a report PARTIALLY_FILLED for the whole size reaches onFilled', async () => {
    const { bot } = mainBot({})
    bot.orders.set(CLIENT_ID, row({ orderId: VENUE_ID }))
    const filled: any[] = []
    const partial: any[] = []
    bot.orderQueue.push(report('310'))
    await drain(
      bot,
      (o: any) => filled.push(o),
      async (o: any) => partial.push(o),
    )
    expect(filled.map((o) => o.status)).to.deep.equal(['FILLED'])
    expect(partial).to.have.length(0)
  })
  it('§1.3 a real part-fill report still reaches onPartiallyFilled', async () => {
    const { bot } = mainBot({})
    bot.orders.set(CLIENT_ID, row({ orderId: VENUE_ID }))
    const filled: any[] = []
    const partial: any[] = []
    bot.orderQueue.push(report('200'))
    await drain(
      bot,
      (o: any) => filled.push(o),
      async (o: any) => partial.push(o),
    )
    expect(filled).to.have.length(0)
    expect(partial.map((o) => o.status)).to.deep.equal(['PARTIALLY_FILLED'])
  })
})

let Combo: any

type Raised = {
  started: any[]
  lookups: number
  placed: number
  canceled: number
}

const comboBot = (opts: {
  dealStatus?: string
  held?: any
  venue?: any
}) => {
  const { dealStatus = 'start', held, venue } = opts
  const raised: Raised = { started: [], lookups: 0, placed: 0, canceled: 0 }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'XRP', quoteAsset: 'USD' },
      settings: {},
      profit: {},
      levels: { all: 1, complete: 0 },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  class TestBot extends (Combo as any) {
    raised = raised
    botId = BOT_ID
    userId = '000000000000000000000a35'
    botType = 'combo'
    combo = true
    loadingComplete = true
    hyperliquid = false
    serviceRestart = false
    secondRestart = false
    data: any = {
      exchange: ExchangeEnum.krakenUsdm,
      exchangeUUID: '',
      settings: { name: 'bot', pair: [SYMBOL], futures: true },
      status: 'open',
      flags: [],
      paperContext: false,
    }
    orders = new Map<string, any>(held ? [[held.clientOrderId, held]] : [])
    canceledMap = new Map()
    unknownOrderInFlight = new Map()
    dealTimersMap = new Map<string, any>()
    processedFilled = new Map<string, Set<string>>()
    lastFilledOrderMap = new Map<string, any>()
    exchange = {
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
      getOrder: async () => {
        raised.lookups++
        return venue
      },
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
      updateData: async () => ({ status: StatusEnum.ok }),
    }
    botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
    shouldProceed() {
      return true
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOpenDeals() {
      return [deal]
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    deleteOrder(id: string) {
      this.orders.delete(id)
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async convertOrderExecutedQty(o: any) {
      return o.executedQty
    }
    async convertOrderQuoteQty(_s: string, q: string) {
      return q
    }
    async startDeal(o: any) {
      raised.started.push({ ...o })
    }
    async placeBaseOrder() {
      raised.placed++
    }
    async cancelOrderOnExchange() {
      raised.canceled++
    }
    async fillPartiallyFilledOrder(o: any) {
      return o
    }
    updateOrderOnDb() {}
    emit() {
      return true
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

const liveEntry = (over: Record<string, unknown> = {}) =>
  row({ orderId: VENUE_ID, status: 'PARTIALLY_FILLED', executedQty: '200', ...over })

const venueAnswer = (status: string, executedQty: string) =>
  good({ ...row(), orderId: VENUE_ID, status, executedQty, updateTime: AT + 5000 })

describe('§4.3 the Combo market-entry re-check (spec 235)', () => {
  before(function () {
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  let clock: sinon.SinonFakeTimers | undefined
  afterEach(() => {
    clock?.restore()
    clock = undefined
  })

  it('§1.1 a venue FILLED answer opens the deal through the fill path', async () => {
    const bot = comboBot({
      held: liveEntry(),
      venue: venueAnswer('FILLED', '310'),
    })
    await bot.recheckMarketEntry(CLIENT_ID, SYMBOL, DEAL_ID, 1)
    const raised = bot.raised as Raised
    expect(raised.lookups).to.equal(1)
    expect(raised.started, 'deal opened').to.have.length(1)
    expect(raised.started[0].status).to.equal('FILLED')
    expect(raised.started[0].executedQty).to.equal('310')
    expect(raised.placed + raised.canceled, 'nothing placed or cancelled').to.equal(0)
  })

  it('arms after the delay and runs the check once it elapses', async () => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bot = comboBot({
      held: liveEntry(),
      venue: venueAnswer('FILLED', '310'),
    })
    bot.armMarketEntryRecheck(liveEntry())
    expect(bot.marketEntryRecheckTimers.size).to.equal(1)
    clock.tick(marketEntryRecheckDelayMs - 1)
    expect((bot.raised as Raised).lookups).to.equal(0)
    clock.restore()
    clock = undefined
    // Fire the armed callback for real.
    const timer = [...bot.marketEntryRecheckTimers.values()][0]
    expect(timer).to.not.equal(undefined)
    bot.marketEntryRecheckTimers.clear()
    await bot.recheckMarketEntry(CLIENT_ID, SYMBOL, DEAL_ID, 1)
    expect((bot.raised as Raised).started).to.have.length(1)
  })

  it('§1.3 does not arm for a LIMIT, a placeholder id, or a deal already open', () => {
    const a = comboBot({ held: liveEntry() })
    a.armMarketEntryRecheck(liveEntry({ type: 'LIMIT' }))
    a.armMarketEntryRecheck(liveEntry({ orderId: '-1' }))
    expect(a.marketEntryRecheckTimers.size).to.equal(0)
    const b = comboBot({ held: liveEntry(), dealStatus: 'open' })
    b.armMarketEntryRecheck(liveEntry())
    expect(b.marketEntryRecheckTimers.size).to.equal(0)
  })

  it('§1.3 asks nothing when the stream already settled the row', async () => {
    const bot = comboBot({ held: liveEntry({ status: 'FILLED', executedQty: '310' }) })
    await bot.recheckMarketEntry(CLIENT_ID, SYMBOL, DEAL_ID, 1)
    expect((bot.raised as Raised).lookups).to.equal(0)
  })

  it('re-arms while the venue still reports a part-fill, up to the cap', async () => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bot = comboBot({
      held: liveEntry(),
      venue: venueAnswer('PARTIALLY_FILLED', '250'),
    })
    await bot.recheckMarketEntry(CLIENT_ID, SYMBOL, DEAL_ID, 1)
    expect((bot.raised as Raised).started).to.have.length(0)
    expect(bot.marketEntryRecheckTimers.size, 'next check armed').to.equal(1)
    bot.clearClassProperties()
    expect(bot.marketEntryRecheckTimers.size, 'cleared on stop').to.equal(0)
    bot.armMarketEntryRecheck(liveEntry(), marketEntryRecheckMaxAttempts + 1)
    expect(bot.marketEntryRecheckTimers.size, 'cap respected').to.equal(0)
  })
})
