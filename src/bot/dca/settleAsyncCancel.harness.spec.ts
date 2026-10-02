process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `125` — a part-filled base-entry settle on a venue
 * whose cancel is asynchronous.
 *
 * Driven over the REAL `settlePartialBaseEntry`, `cancelOrderOnExchange`,
 * `getOrderForReconcile`, `getOrder` and `processCanceledOrder`, with the venue
 * replaced by a transport that answers as the Coinbase connector does: the
 * cancel succeeds, the connector reads the order straight back, and the venue
 * still lists it OPEN (mapped to `PARTIALLY_FILLED`). Only a later read sees it
 * `CANCELED` with its fill.
 *
 * Quantities are the production ones; identifiers are synthetic because this
 * file is public.
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

const DEAL_ID = '000000000000000000000d25'
const BOT_ID = '000000000000000000000b25'
const USER_ID = '000000000000000000000425'
const SYMBOL = 'NKN-USDC'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000125'
const VENUE_ID = '00000000-0000-0000-0000-000000000125'

const partFilledBaseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: VENUE_ID,
    clientOrderId: CLIENT_ORDER_ID,
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '0.006681',
    origPrice: '0.006681',
    origQty: '14913.5',
    executedQty: '12055.9',
    cummulativeQuoteQty: '80.5454679',
    status: 'PARTIALLY_FILLED',
    updateTime: Date.now() - 10_000,
    transactTime: Date.now() - 11_000,
    ...over,
  }) as any

/** The order as the Coinbase connector converts it, in a given venue state. */
const venueRow = (status: string) => ({
  symbol: SYMBOL,
  orderId: VENUE_ID,
  clientOrderId: VENUE_ID,
  transactTime: Date.now() - 11_000,
  updateTime: Date.now(),
  price: '0.006681',
  origQty: '14913.5',
  executedQty: '12055.9',
  cummulativeQuoteQty: '80.5454679',
  status,
  type: 'LIMIT',
  side: 'BUY',
})

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  booked: any[]
  persisted: { order: any; force?: boolean }[]
  warns: string[]
  reads: number
  cancels: number
}

/**
 * @param readsUntilCancelled how many `getOrder` reads still see the order
 *   OPEN after the cancel was accepted (`Infinity` = never ends)
 */
const buildBot = (
  opts: { readsUntilCancelled?: number; withTimers?: boolean } = {},
) => {
  const { readsUntilCancelled = 1, withTimers = true } = opts
  const order = partFilledBaseOrder()
  const raised: Raised = {
    booked: [],
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
      symbol: { symbol: SYMBOL, baseAsset: 'NKN', quoteAsset: 'USDC' },
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
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    paperContext: false,
    settings: {},
  }
  bot.orders = new Map<string, any>([[order.clientOrderId, order]])
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.dealTimersMap = new Map(
    withTimers ? [[DEAL_ID, { limitTimer: null, enterMarketTimer: null }]] : [],
  )
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
    async cancelOrder() {
      raised.cancels += 1
      // Coinbase: the cancel is accepted and the order read straight back.
      return {
        status: StatusEnum.ok,
        reason: '',
        data: venueRow('PARTIALLY_FILLED'),
      }
    },
    async getOrder() {
      raised.reads += 1
      return {
        status: StatusEnum.ok,
        reason: '',
        data: venueRow(
          raised.reads >= readsUntilCancelled ? 'CANCELED' : 'PARTIALLY_FILLED',
        ),
      }
    },
  }
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOrdersByStatusAndDealId = () => [...bot.orders.values()]
  // NKN-USDC on Coinbase: price increment 0.000001.
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 6,
    baseAsset: { minAmount: 0.1, step: 0.1 },
    quoteAsset: { minAmount: 1 },
  })
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.updateOrderOnDb = (o: any, force?: boolean) =>
    raised.persisted.push({ order: { ...o }, force })
  bot.getAggregatedSettings = async () => ({ startOrderType: 'LIMIT' })
  bot.fillPartiallyFilledOrder = async (o: any) => o
  bot.processFilledOrder = async (o: any) => {
    raised.booked.push({ ...o })
    deal.deal.status = DCADealStatusEnum.open
  }
  bot.checkUnfilledBaseEntryCancel = () => undefined
  bot.emit = () => true
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.handleWarn = (log: string) => raised.warns.push(log)
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return bot
}

describe('a settle on a venue whose cancel is asynchronous (spec 125)', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('§1.2/§4.1 opens the deal on the fill once the venue ends the order', async () => {
    const bot = buildBot({ readsUntilCancelled: 2 })
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.warns, raised.warns.join('\n')).to.have.length(0)
    expect(raised.booked, 'deal opened').to.have.length(1)
    expect(raised.booked[0].status).to.equal('FILLED')
    expect(raised.booked[0].executedQty).to.equal('12055.9')
    expect(raised.booked[0].price).to.equal('0.006681')
    expect(raised.reads, 're-read until terminal').to.equal(2)
    const promoted = raised.persisted.filter((p) => p.order.status === 'FILLED')
    expect(promoted, 'the promotion is persisted').to.have.length.greaterThan(0)
    expect(promoted[promoted.length - 1].force).to.equal(true)
  })

  it('§4.1 a venue that never ends the order still warns, bounded', async () => {
    const bot = buildBot({ readsUntilCancelled: Infinity })
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.booked, 'nothing opened').to.have.length(0)
    expect(raised.warns.join('\n')).to.contain('could not be settled')
    expect(raised.reads).to.be.greaterThan(0)
    expect(raised.reads).to.be.lessThan(30)
  })

  it('§1.3/§4.2 the venue CANCELED event settles a deal whose settle gave up', async () => {
    const bot = buildBot({ readsUntilCancelled: Infinity })
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.booked).to.have.length(0)
    // The deal still holds its LIMIT-entry timers.
    expect(bot.dealTimersMap.has(DEAL_ID)).to.equal(true)
    const cancelledEvent = partFilledBaseOrder({
      status: 'CANCELED',
      updateTime: Date.now(),
    })
    bot.setOrder(cancelledEvent)
    await bot.processCanceledOrder(cancelledEvent, Date.now(), false)
    expect(raised.booked, 'deal opened').to.have.length(1)
    expect(raised.booked[0].executedQty).to.equal('12055.9')
    // A second (duplicate) event books nothing more.
    await bot.processCanceledOrder(cancelledEvent, Date.now(), false)
    expect(raised.booked).to.have.length(1)
  })

  it('§4.2 an engine-owned cancel event is still left to the engine', async () => {
    const bot = buildBot()
    const cancelledEvent = partFilledBaseOrder({
      status: 'CANCELED',
      updateTime: Date.now(),
    })
    await bot.processCanceledOrder(cancelledEvent, Date.now(), false)
    expect((bot.raised as Raised).booked).to.have.length(0)
  })

  it('§4.3 a settle already running makes a second one a no-op', async () => {
    const bot = buildBot({ readsUntilCancelled: 2 })
    const row = bot.orders.get(CLIENT_ORDER_ID)
    await Promise.all([
      bot.settlePartialBaseEntry(row, DEAL_ID),
      bot.settlePartialBaseEntry(row, DEAL_ID),
    ])
    const raised = bot.raised as Raised
    expect(raised.cancels, 'one cancel').to.equal(1)
    expect(raised.booked, 'booked once').to.have.length(1)
  })
})
