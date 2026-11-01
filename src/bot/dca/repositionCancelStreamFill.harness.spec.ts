process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `217`: the venue's own CANCELED-with-fills report
 * reaches the bot while the reposition tick's cancel is in flight, and the
 * cancel answer says nothing about the fill.
 *
 * Driven over the REAL `checkBaseOrder` reposition arm, `cancelOrderOnExchange`
 * (its copy loop puts the stale row back into the order map), the DCA
 * `processCanceledOrder` stream callback, `bookCanceledBaseEntry`,
 * `awaitBaseEntryCancel` and the settle chain. The venue is a transport that
 * delivers the stream report from inside the cancel, the way
 * `processOrderQueue` does (`deleteOrder` + `setOrder` of a new row, then the
 * callback), and then answers.
 *
 * Quantities are the production ones (37.11 of 37.16 on a Hyperliquid spot
 * pair). Identifiers are synthetic because this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d17'
const BOT_ID = '000000000000000000000b17'
const USER_ID = '000000000000000000000417'
const SYMBOL = 'DRV-USDC'
const CLIENT_ORDER_ID = '0x00000000000000000000000000000217'
const VENUE_ID = '217217217'

/** The resting base order as the engine holds it when the tick fires. */
const restingBaseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: VENUE_ID,
    clientOrderId: CLIENT_ORDER_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    exchange: ExchangeEnum.hyperliquid,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '0.32314',
    origPrice: '0.32314',
    origQty: '37.16',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    updateTime: Date.now() - 10_000,
    transactTime: Date.now() - 10_000,
    ...over,
  }) as any

/** The order as the Hyperliquid connector converts it. */
const venueRow = (status: string, executedQty: string) => ({
  symbol: SYMBOL,
  orderId: VENUE_ID,
  clientOrderId: CLIENT_ORDER_ID,
  transactTime: Date.now() - 10_000,
  updateTime: Date.now(),
  price: '0.32314',
  origQty: '37.16',
  executedQty,
  cummulativeQuoteQty: `${+executedQty * 0.32314}`,
  status,
  type: 'LIMIT',
  side: 'BUY',
})

/** What the user stream delivers: the venue ended it, 37.11 executed. */
const streamReport = () =>
  restingBaseOrder({
    status: 'CANCELED',
    executedQty: '37.11',
    cummulativeQuoteQty: '11.9917254',
    updateTime: Date.now(),
  })

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  booked: any[]
  replaced: number
  persisted: { order: any; force?: boolean }[]
  warns: string[]
  reads: number
  cancels: number
}

/**
 * @param cancel what the cancel call answers: a venue row, or a refusal
 * @param laterAnswer what every later `getOrder` says
 * @param report whether the stream report arrives during the cancel
 */
const buildBot = (opts: {
  cancel: [string, string] | { refused: string }
  laterAnswer: [string, string]
  report: boolean
}) => {
  const order = restingBaseOrder()
  const raised: Raised = {
    booked: [],
    replaced: 0,
    persisted: [],
    warns: [],
    reads: 0,
    cancels: 0,
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.start,
      symbol: { symbol: SYMBOL, baseAsset: 'DRV', quoteAsset: 'USDC' },
      settings: {},
      profit: {},
      levels: { all: 9, complete: 0 },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  const bot: any = Object.create(Helper.prototype)
  bot.raised = raised
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = BotType.dca
  bot.data = {
    exchange: ExchangeEnum.hyperliquid,
    exchangeUUID: '',
    paperContext: false,
    settings: { futures: false, startOrderType: 'LIMIT' },
  }
  bot.orders = new Map<string, any>([[order.clientOrderId, order]])
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.dealTimersMap = new Map([
    [DEAL_ID, { limitTimer: null, enterMarketTimer: null }],
  ])
  bot.deals = new Map<string, any>([[DEAL_ID, deal]])
  bot.orderLimitRepositionTimeout = 10_000
  bot.enterMarketTimeout = 0
  bot.limitFallbackTimeout = 25_000
  bot.reconcileBatch = null
  bot.math = new MathHelper()
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    returnGood: () => (d: any) => ({ status: StatusEnum.ok, data: d }),
    async cancelOrder() {
      raised.cancels += 1
      if (opts.report) {
        // `processOrderQueue`: a NEW row replaces the held one, then the
        // cancel callback runs, all before the cancel call returns.
        const report = streamReport()
        bot.deleteOrder(report.clientOrderId)
        bot.setOrder(report)
        bot.updateOrderOnDb(report)
        await bot.processCanceledOrder(report, report.updateTime, false)
      }
      if ('refused' in opts.cancel) {
        return { status: StatusEnum.notok, reason: opts.cancel.refused }
      }
      return {
        status: StatusEnum.ok,
        reason: '',
        data: venueRow(...opts.cancel),
      }
    },
    async getOrder() {
      raised.reads += 1
      return {
        status: StatusEnum.ok,
        reason: '',
        data: venueRow(...opts.laterAnswer),
      }
    },
  }
  bot.ordersDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: { origQty: '37.16', origPrice: '0.32314' } },
    }),
  }
  bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOrdersByStatusAndDealId = () => [...bot.orders.values()]
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 5,
    baseAsset: { minAmount: 0.01, step: 0.01 },
    quoteAsset: { minAmount: 10 },
  })
  bot.baseAssetPrecision = async () => 2
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.updateOrderOnDb = (o: any, force?: boolean) =>
    raised.persisted.push({ order: { ...o }, force })
  bot.getAggregatedSettings = async () => ({ startOrderType: 'LIMIT' })
  // The price moved since the order was placed: reposition it.
  bot.keepRestingBaseEntry = async () => false
  // The top-up (spec 057) is not under test; the row is booked as settled.
  bot.topUpSettledBaseEntry = async (o: any) => o
  bot.reportBaseEntryCutShort = () => undefined
  bot.placeBaseOrder = () => {
    raised.replaced += 1
  }
  bot.processFilledOrder = async (o: any) => {
    raised.booked.push({ ...o })
    deal.deal.status = DCADealStatusEnum.open
  }
  bot.armCanceledBaseEntryDealCancel = () => undefined
  bot.emit = () => true
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.handleWarn = (log: string) => raised.warns.push(log)
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return bot
}

const tick = (bot: any) =>
  bot.checkBaseOrder(BOT_ID, SYMBOL, CLIENT_ORDER_ID, DEAL_ID)

const expectBookedOnStreamFill = (bot: any) => {
  const raised = bot.raised as Raised
  expect(raised.replaced, 'no second base order').to.equal(0)
  expect(raised.booked, 'deal opened').to.have.length(1)
  expect(raised.booked[0].status).to.equal('FILLED')
  expect(raised.booked[0].executedQty).to.equal('37.11')
  expect(raised.booked[0].price).to.equal('0.32314')
  const last = raised.persisted[raised.persisted.length - 1]
  expect(last.order.status, 'the row is written FILLED').to.equal('FILLED')
  expect(last.order.executedQty).to.equal('37.11')
  expect(last.force, 'over the CANCELED row').to.equal(true)
  expect(bot.repositionCancelReports?.size ?? 0, 'no record left').to.equal(0)
}

describe('a reposition cancel that loses the stream-reported fill (spec 217)', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('§4.2 the cancel answers CANCELED with nothing executed: open on 37.11', async () => {
    const bot = buildBot({
      cancel: ['CANCELED', '0'],
      laterAnswer: ['CANCELED', '0'],
      report: true,
    })
    await tick(bot)
    expectBookedOnStreamFill(bot)
  })

  it('§4.2 the cancel answer still lists it live, and so does every re-read: open on 37.11', async () => {
    const bot = buildBot({
      cancel: ['NEW', '0'],
      laterAnswer: ['NEW', '0'],
      report: true,
    })
    await tick(bot)
    expectBookedOnStreamFill(bot)
    expect(
      bot.unsettledBaseEntries.has(CLIENT_ORDER_ID),
      'not left for a venue event that has already come',
    ).to.equal(false)
  })

  it('§4.2 the cancel fails: open on 37.11', async () => {
    const bot = buildBot({
      cancel: { refused: 'Response timeout' },
      laterAnswer: ['CANCELED', '0'],
      report: true,
    })
    await tick(bot)
    expectBookedOnStreamFill(bot)
  })

  it('§4.3 nothing filled and no report: cancelled and re-placed, no extra read', async () => {
    const bot = buildBot({
      cancel: ['CANCELED', '0'],
      laterAnswer: ['CANCELED', '0'],
      report: false,
    })
    await tick(bot)
    const raised = bot.raised as Raised
    expect(raised.booked).to.have.length(0)
    expect(raised.replaced, 'base order re-placed').to.equal(1)
    expect(raised.cancels).to.equal(1)
    expect(raised.reads).to.equal(0)
    expect(bot.repositionCancelReports?.size ?? 0).to.equal(0)
  })

  it('§4.1 a report outside a reposition cancel is not recorded', async () => {
    const bot = buildBot({
      cancel: ['CANCELED', '0'],
      laterAnswer: ['CANCELED', '0'],
      report: false,
    })
    const report = streamReport()
    await bot.processCanceledOrder(report, report.updateTime, false)
    expect(bot.repositionCancelReports?.size ?? 0).to.equal(0)
  })
})
