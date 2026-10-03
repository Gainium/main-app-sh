process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `128` — a settled part-filled base entry left out
 * of the deal's average price.
 *
 * Driven over the REAL `settlePartialBaseEntry`, `cancelOrderOnExchange` and
 * `getAvgPrice`. Quantities and prices are the production ones; identifiers
 * are synthetic because this file is public.
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

const DEAL_ID = '000000000000000000000d28'
const BOT_ID = '000000000000000000000b28'
const USER_ID = '000000000000000000000428'
const SYMBOL = 'KTA-USDC'
const BO_ID = 'D-BO-0000000000000000000000000128'
const VENUE_ID = '00000000-0000-0000-0000-000000000128'

const baseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: VENUE_ID,
    clientOrderId: BO_ID,
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '0.0711',
    origPrice: '0.0711',
    origQty: '1407.8',
    executedQty: '1405.4',
    status: 'PARTIALLY_FILLED',
    updateTime: Date.now() - 10_000,
    transactTime: Date.now() - 11_000,
    ...over,
  }) as any

/** The six safety orders that filled on the production deal. */
const safetyFills: [string, string][] = [
  ['468.8', '0.0704'],
  ['497.1', '0.0697'],
  ['527.3', '0.069'],
  ['559.3', '0.0683'],
  ['594.2', '0.0675'],
  ['630.5', '0.0668'],
]
const safetyRows = () =>
  safetyFills.map(
    ([qty, price], i) =>
      ({
        symbol: SYMBOL,
        clientOrderId: `D-RO-00000000000000000000000000${i}`,
        dealId: DEAL_ID,
        typeOrder: 'dealRegular',
        type: 'LIMIT',
        side: 'BUY',
        price,
        origQty: qty,
        executedQty: qty,
        status: 'FILLED',
        updateTime: Date.now() + i,
      }) as any,
  )

const SAFETY_BASE = safetyFills.reduce((a, [q]) => a + +q, 0)
const SAFETY_QUOTE = safetyFills.reduce((a, [q, p]) => a + +q * +p, 0)
/** Base order 1405.4 @ 0.0711 plus the safety fills: 4682.6 held. */
const WITH_BASE_AVG = (SAFETY_QUOTE + 1405.4 * 0.0711) / (SAFETY_BASE + 1405.4)

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (orders: any[], cancelAnswer = 'CANCELED') => {
  const raised = {
    booked: [] as any[],
    persisted: [] as { order: any; force?: boolean }[],
    warns: [] as string[],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.start,
      symbol: { symbol: SYMBOL, baseAsset: 'KTA', quoteAsset: 'USDC' },
      settings: {},
      profit: { total: 0 },
      levels: { all: 31, complete: 0 },
      initialBalances: { base: 0, quote: 2292.40313 },
      currentBalances: { base: 4682.6, quote: 1968.01801 },
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
  bot.isLong = true
  bot.data = {
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    paperContext: false,
    settings: {},
  }
  bot.orders = new Map<string, any>(orders.map((o) => [o.clientOrderId, o]))
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.dealTimersMap = new Map()
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
    // The cancel completed by the time the connector read the order back:
    // CANCELED, carrying the fill.
    async cancelOrder() {
      return {
        status: StatusEnum.ok,
        reason: '',
        data: {
          symbol: SYMBOL,
          orderId: VENUE_ID,
          clientOrderId: VENUE_ID,
          transactTime: Date.now() - 11_000,
          updateTime: Date.now(),
          price: '0.0711',
          origQty: '1407.8',
          executedQty: '1405.4',
          status: cancelAnswer,
          type: 'LIMIT',
          side: 'BUY',
        },
      }
    },
  }
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOrdersByStatusAndDealId = ({
    status,
    dealId,
  }: {
    status?: string | string[]
    dealId?: string
  }) =>
    [...bot.orders.values()].filter(
      (o: any) =>
        (!dealId || o.dealId === dealId) &&
        (!status ||
          (Array.isArray(status) ? status : [status]).includes(o.status)),
    )
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 4,
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
  bot.profitBase = async () => false
  bot.getUserFee = async () => ({ maker: 0.006, taker: 0.012 })
  bot.emit = () => true
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.handleWarn = (log: string) => raised.warns.push(log)
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return bot
}

describe('a settled part-filled base entry and the deal average (spec 128)', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('§4.1 a cancel that answers FILLED persists the promotion with force', async () => {
    const bot = buildBot([baseOrder()])
    await bot.settlePartialBaseEntry(bot.orders.get(BO_ID), DEAL_ID)
    const { booked, persisted, warns } = bot.raised
    expect(warns, warns.join('\n')).to.have.length(0)
    expect(booked, 'deal opened').to.have.length(1)
    expect(booked[0].status).to.equal('FILLED')
    expect(booked[0].executedQty).to.equal('1405.4')
    const promoted = persisted.filter(
      (p: any) => p.order.status === 'FILLED',
    )
    // The venue's own CANCELED event usually reaches the orders collection
    // first, and the default write filter refuses to go over it.
    expect(
      promoted.some((p: any) => p.force === true),
      'a forced FILLED write',
    ).to.equal(true)
  })

  it('§4.2 a CANCELED base row with a fill is part of the average (spot)', async () => {
    const bot = buildBot([
      baseOrder({ status: 'CANCELED' }),
      ...safetyRows(),
    ])
    const { avg } = await bot.getAvgPrice(DEAL_ID)
    // Without the base row this is SAFETY_QUOTE / SAFETY_BASE =
    // 0.06849175515684121, the value the production deal stored.
    expect(avg).to.be.closeTo(WITH_BASE_AVG, 1e-12)
  })

  it('§4.2 a CANCELED base row with a fill is part of the average (futures)', async () => {
    const bot = buildBot([
      baseOrder({ status: 'CANCELED' }),
      ...safetyRows(),
    ])
    bot.data.settings.futures = true
    bot.calculateAbstractPosition = async (
      o: { qty: number; price: number },
      pos: { qty: number; price: number },
    ) => ({
      ...pos,
      qty: pos.qty + o.qty,
      price: (pos.qty * pos.price + o.qty * o.price) / (pos.qty + o.qty),
    })
    const { avg } = await bot.getAvgPrice(DEAL_ID)
    expect(avg).to.be.closeTo(WITH_BASE_AVG, 1e-12)
  })

  it('§4.2 a CANCELED base row with no fill contributes nothing', async () => {
    const bot = buildBot([
      baseOrder({ status: 'CANCELED', executedQty: '0' }),
      ...safetyRows(),
    ])
    const { avg } = await bot.getAvgPrice(DEAL_ID)
    expect(avg).to.be.closeTo(SAFETY_QUOTE / SAFETY_BASE, 1e-12)
  })

  it('§4.2 a FILLED base row is counted once', async () => {
    const bot = buildBot([baseOrder({ status: 'FILLED' }), ...safetyRows()])
    const { avg } = await bot.getAvgPrice(DEAL_ID)
    expect(avg).to.be.closeTo(WITH_BASE_AVG, 1e-12)
  })
})
