process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `133` — a LIMIT base order that part-fills while
 * the reposition tick is cancelling it, on a contract-sized account.
 *
 * Driven over the REAL `checkBaseOrder` reposition arm, `cancelOrderOnExchange`,
 * `getOrderForReconcile`, `getOrder`, `mergeCommonOrderWithOrder`, the settle
 * chain and `restBaseEntryRemainder`, with the venue replaced by a transport
 * that answers as the OKX connector does: the cancel is accepted, the
 * connector reads the order straight back, and the venue still lists it
 * `live` / `partially_filled` (mapped to `NEW` / `PARTIALLY_FILLED`). Only a
 * later read sees it `canceled`.
 *
 * Quantities are the production ones (40 of 1030 on an OKX USDT-margined
 * perpetual); identifiers are synthetic because this file is public.
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

const DEAL_ID = '000000000000000000000d33'
const BOT_ID = '000000000000000000000b33'
const USER_ID = '000000000000000000000433'
const SYMBOL = 'LIT-USDT-SWAP'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000133'
const VENUE_ID = '0000000000000000133'

/** The resting base order as the engine holds it when the tick fires. */
const restingBaseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: VENUE_ID,
    clientOrderId: CLIENT_ORDER_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '3.8834',
    origPrice: '3.8834',
    origQty: '1030',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    updateTime: Date.now() - 50_000,
    transactTime: Date.now() - 50_000,
    ...over,
  }) as any

/** The order as the OKX connector converts it, in a given venue state. */
const venueRow = (status: string, executedQty: string) => ({
  symbol: SYMBOL,
  orderId: VENUE_ID,
  clientOrderId: CLIENT_ORDER_ID,
  transactTime: Date.now() - 50_000,
  updateTime: Date.now(),
  price: '3.8834',
  origQty: '1030',
  executedQty,
  cummulativeQuoteQty: `${+executedQty * 3.8834}`,
  status,
  type: 'LIMIT',
  side: 'BUY',
})

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  booked: { row: any; settled: boolean }[]
  remainders: { qty: number; total: string }[]
  replaced: number
  persisted: { order: any; force?: boolean }[]
  warns: string[]
  reads: number
  cancels: number
}

/**
 * @param cancelAnswer what the connector's read-back after the cancel says
 * @param laterAnswer what every later `getOrder` says
 */
const buildBot = (opts: {
  cancelAnswer: [string, string]
  laterAnswer: [string, string]
}) => {
  const order = restingBaseOrder()
  const raised: Raised = {
    booked: [],
    remainders: [],
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
      symbol: { symbol: SYMBOL, baseAsset: 'LIT', quoteAsset: 'USDT' },
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
    exchange: ExchangeEnum.okxLinear,
    exchangeUUID: '',
    paperContext: false,
    settings: { futures: true, startOrderType: 'LIMIT' },
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
      // OKX: the cancel is accepted and the order read straight back.
      return {
        status: StatusEnum.ok,
        reason: '',
        data: venueRow(...opts.cancelAnswer),
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
  // The requested size as `saveOrderToDb` stored it (spec 111 §4.1.1).
  bot.ordersDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: { origQty: '1030', origPrice: '3.8834' } },
    }),
  }
  bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOrdersByStatusAndDealId = () => [...bot.orders.values()]
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 4,
    baseAsset: { minAmount: 1, step: 1 },
    quoteAsset: { minAmount: 1 },
  })
  // One contract is one LIT on this instrument.
  bot.getOKXDenominator = async () => 1
  bot.baseAssetPrecision = async () => 0
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.updateOrderOnDb = (o: any, force?: boolean) =>
    raised.persisted.push({ order: { ...o }, force })
  bot.getAggregatedSettings = async () => ({ startOrderType: 'LIMIT' })
  // The price moved since the order was placed: reposition it.
  bot.keepRestingBaseEntry = async () => false
  bot.fillPartiallyFilledOrder = async (o: any) => o
  bot.placeBaseOrder = () => {
    raised.replaced += 1
  }
  bot.processFilledOrder = async (o: any) => {
    raised.booked.push({
      row: { ...o },
      settled: !!bot.settledBaseEntries?.has(o.clientOrderId),
    })
    // `startDeal` opens the deal, then asks for the remainder (spec 111 §3.2).
    deal.deal.status = DCADealStatusEnum.open
    await bot.restBaseEntryRemainder(o)
  }
  bot.placeBaseEntryRemainder = async (
    _dealId: string,
    _symbol: string,
    qty: number,
    total: string,
  ) => {
    raised.remainders.push({ qty, total })
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

const tick = (bot: any) =>
  bot.checkBaseOrder(BOT_ID, SYMBOL, CLIENT_ORDER_ID, DEAL_ID)

describe('a reposition cancel that races a partial fill (spec 133)', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('§1.2/§4.1 the venue still lists it part-filled: wait, open on 40, rest the other 990', async () => {
    const bot = buildBot({
      cancelAnswer: ['PARTIALLY_FILLED', '40'],
      laterAnswer: ['CANCELED', '40'],
    })
    await tick(bot)
    const raised = bot.raised as Raised
    expect(raised.warns, raised.warns.join('\n')).to.have.length(0)
    expect(raised.replaced, 'no second base order').to.equal(0)
    expect(raised.booked, 'deal opened').to.have.length(1)
    expect(raised.booked[0].row.status).to.equal('FILLED')
    expect(raised.booked[0].row.executedQty).to.equal('40')
    expect(raised.booked[0].settled, 'marked engine-settled').to.equal(true)
    expect(raised.remainders).to.deep.equal([{ qty: 990, total: '1030' }])
    const promoted = raised.persisted.filter((p) => p.order.status === 'FILLED')
    expect(promoted, 'the promotion is persisted').to.have.length.greaterThan(0)
    expect(promoted[promoted.length - 1].force).to.equal(true)
  })

  it('§1.3/§4.2 the cancel answers CANCELED with the fill: open on 40, rest the other 990', async () => {
    const bot = buildBot({
      cancelAnswer: ['CANCELED', '40'],
      laterAnswer: ['CANCELED', '40'],
    })
    await tick(bot)
    const raised = bot.raised as Raised
    expect(raised.warns, raised.warns.join('\n')).to.have.length(0)
    expect(raised.replaced).to.equal(0)
    expect(raised.booked).to.have.length(1)
    expect(raised.booked[0].settled).to.equal(true)
    expect(raised.remainders).to.deep.equal([{ qty: 990, total: '1030' }])
    expect(raised.reads, 'a terminal answer is not re-read').to.equal(0)
  })

  it('§1.4/§4.3 the venue still lists it live and unfilled: wait, record it CANCELED, re-place', async () => {
    const bot = buildBot({
      cancelAnswer: ['NEW', '0'],
      laterAnswer: ['CANCELED', '0'],
    })
    await tick(bot)
    const raised = bot.raised as Raised
    expect(raised.booked).to.have.length(0)
    expect(raised.replaced, 'base order re-placed').to.equal(1)
    const last = raised.persisted[raised.persisted.length - 1]
    expect(last.order.status, 'the row does not stay NEW').to.equal('CANCELED')
    expect(bot.orders.has(CLIENT_ORDER_ID)).to.equal(false)
  })

  it('§4.4 a venue that never ends the order: bounded, marked for the venue event', async () => {
    const bot = buildBot({
      cancelAnswer: ['PARTIALLY_FILLED', '40'],
      laterAnswer: ['PARTIALLY_FILLED', '40'],
    })
    await tick(bot)
    const raised = bot.raised as Raised
    expect(raised.booked).to.have.length(0)
    expect(raised.reads).to.be.greaterThan(0)
    expect(raised.reads).to.be.lessThan(30)
    expect(bot.unsettledBaseEntries.has(CLIENT_ORDER_ID)).to.equal(true)
  })

  it('§4.5 a reconcile that finds our own cancelled base row FILLED short marks it engine-settled', async () => {
    const bot = buildBot({
      cancelAnswer: ['NEW', '0'],
      laterAnswer: ['NEW', '0'],
    })
    const before = restingBaseOrder()
    const after = restingBaseOrder({ status: 'FILLED', executedQty: '40' })
    bot.noteOwnCancel(CLIENT_ORDER_ID)
    bot.noteReconciledBaseEntry(before, after)
    expect(bot.settledBaseEntries.has(CLIENT_ORDER_ID)).to.equal(true)
    // Not ours: the venue's FILLED-short is not trusted (spec 111 §4.1.1).
    const other = buildBot({
      cancelAnswer: ['NEW', '0'],
      laterAnswer: ['NEW', '0'],
    })
    other.noteReconciledBaseEntry(before, after)
    expect(other.settledBaseEntries?.has(CLIENT_ORDER_ID) ?? false).to.equal(
      false,
    )
  })
})
