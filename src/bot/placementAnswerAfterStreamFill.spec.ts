process.env.NODE_ENV = 'testing'

/**
 * A limit base entry trades against several resting orders the moment it
 * reaches the book, then fills its remainder a millisecond later. The user
 * stream delivers every report of that before the venue's answer to the
 * placement arrives, and the answer still describes the order as it was when it
 * reached the book: part-filled. The merge of that answer used to keep the
 * streamed `FILLED` status but take the answer's quantities, so the engine held
 * a `FILLED` row for the part-fill and booked the deal on it.
 *
 * The burst is the production one (Binance spot, 2026-10-22; identifiers
 * dropped, this file is public): `NEW`, eleven `PARTIALLY_FILLED` reports all
 * stamped with one venue time, then `FILLED` one millisecond later.
 *
 * Spec: `specs/193.a-placement-answer-rewinds-a-streamed-fill.md`.
 * Run: `npm test` (mocha). No network / DB — the real `processOrderQueue` and
 * `sendOrderToExchange` run off the prototype against a fake venue whose
 * placement answer the test releases by hand.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLIENT_ID = 'x-TEST-BO-burstOfPartialFills0001'
const VENUE_ID = '2911000123'
const DEAL_ID = '6ad9520ac16413c9c6f1c3c0'
const AT_BOOK = 1792627225846
const FILLED_AT = AT_BOOK + 1

/** [base, quote] of each streamed PARTIALLY_FILLED report, in arrival order. */
const PARTIALS: [string, string][] = [
  ['222.63000000', '90.23193900'],
  ['492.63000000', '199.68993900'],
  ['867.39000000', '351.61764300'],
  ['1038.70000000', '421.06671700'],
  ['1057.21000000', '428.57067100'],
  ['1327.21000000', '538.05567100'],
  ['1658.03000000', '672.20318100'],
  ['1907.96000000', '773.54979600'],
  ['2079.27000000', '843.01600100'],
  ['2097.78000000', '850.52180600'],
  ['2116.29000000', '858.02761100'],
]
const FILLED: [string, string] = ['3085.69000000', '1251.11931100']

function baseOrder(over: Record<string, unknown> = {}) {
  return {
    symbol: 'LDOUSDT',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    price: '0.4055',
    origPrice: '0.4055',
    origQty: '3085.69',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'LIMIT',
    typeOrder: 'dealStart',
    dealId: DEAL_ID,
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    updateTime: AT_BOOK - 3600,
    transactTime: AT_BOOK - 3600,
    ...over,
  } as any
}

function report(
  orderStatus: string,
  [base, quote]: [string, string],
  at: number,
) {
  return {
    eventType: 'executionReport',
    eventTime: at,
    orderTime: at,
    symbol: 'LDOUSDT',
    newClientOrderId: CLIENT_ID,
    originalClientOrderId: '',
    side: 'BUY',
    orderType: 'LIMIT',
    price: '0.40550000',
    quantity: '3085.69000000',
    orderStatus,
    orderId: +VENUE_ID,
    totalTradeQuantity: base,
    totalQuoteTradeQuantity: quote,
  } as any
}

/**
 * @param answer what the venue's placement answer states, as the exchange
 * layer hands it to `sendOrderToExchange`
 */
function binanceBot(answer: Record<string, unknown>) {
  const rec = { db: [] as any[], logs: [] as string[], filled: [] as any[] }
  let release: () => void = () => undefined
  const placed = new Promise<void>((r) => (release = r))
  const bot: any = Object.create((MainBot as any).prototype)
  bot.botId = 'bot'
  bot.userId = 'user'
  bot.botType = 'dca'
  bot.data = {
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    paperContext: false,
    settings: { leverage: 1 },
    flags: [],
  }
  bot.orders = new Map()
  bot.ordersKeys = new Set()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.partiallyFilledFilledSet = new Set()
  bot.orderQueue = []
  bot.processedOrders = new Map()
  bot.lockProcessQueueMethod = false
  bot.math = {
    round: (v: number, p = 8) => +(+v).toFixed(p),
    remainder: () => 0,
  }
  const bad = (reason: string) => ({
    status: StatusEnum.notok,
    reason,
    data: null,
  })
  const good = (data: unknown) => ({
    status: StatusEnum.ok,
    reason: null,
    data,
  })
  bot.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => good,
    async openOrder() {
      await placed
      return good({
        ...baseOrder(),
        orderId: VENUE_ID,
        updateTime: AT_BOOK,
        transactTime: AT_BOOK,
        ...answer,
      })
    },
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = (m: string) => rec.logs.push(m)
  bot.handleDebug = () => undefined
  bot.handleWarn = (m: string) => rec.logs.push(m)
  bot.handleError = (m: string) => rec.logs.push(m)
  bot.handleErrors = (m: string) => rec.logs.push(m)
  bot.handleOrderErrors = async () => undefined
  bot.emit = () => undefined
  bot.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  bot.setOrdersToRedis = () => undefined
  bot.setOrderByDeal = () => undefined
  bot.setOrderByStatus = () => undefined
  bot.removeOrderByDeal = () => undefined
  bot.removeOrderByStatus = () => undefined
  bot.getExchangeInfo = async () => ({
    pair: 'LDOUSDT',
    priceAssetPrecision: 4,
    baseAsset: { minAmount: 0.01, step: 0.01, name: 'LDO' },
    quoteAsset: { minAmount: 5, name: 'USDT', precision: 8 },
  })
  bot.getUserFee = async () => ({ maker: 0.001, taker: 0.001 })
  bot.saveOrderToDb = async () => undefined
  bot.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  bot.getNotEnoughOrdersIdByOrder = () => 'nb'
  bot.isComplianceGateable = () => false
  bot.needToSendOrder = () => true
  bot.markDealStartBlocked = async () => undefined
  bot.isErrorNotEnoughBalance = () => false
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.convertOrderQuoteQty = async (_s: string, q: string) => q
  bot.ordersDb = {
    readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
    updateData: async () => ({ status: StatusEnum.ok }),
  }
  bot.botEventDb = { createData: () => undefined }
  return { bot, rec, release }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

/** Feed the stream burst through the real queue and wait for it to drain. */
async function streamBurst(bot: any, rec: { filled: any[] }) {
  bot.orderQueue = [
    report('NEW', ['0.00000000', '0.00000000'], AT_BOOK),
    ...PARTIALS.map((p) => report('PARTIALLY_FILLED', p, AT_BOOK)),
    report('FILLED', FILLED, FILLED_AT),
  ]
  bot.processOrderQueue(bot.botId, async (o: any) => {
    rec.filled.push({ ...o })
  })
  for (let i = 0; i < 200 && bot.orderQueue.length; i++) {
    await tick(1)
  }
  expect(bot.orderQueue.length, 'stream burst drained').to.equal(0)
}

describe('placement answer after a streamed fill (spec 193)', () => {
  it('§4.1 a part-fill answer arriving after the streamed FILLED keeps the whole fill', async () => {
    const { bot, rec, release } = binanceBot({
      status: 'PARTIALLY_FILLED',
      executedQty: PARTIALS[PARTIALS.length - 1][0],
      cummulativeQuoteQty: PARTIALS[PARTIALS.length - 1][1],
    })
    const sending = bot.sendOrderToExchange(baseOrder())
    await tick()
    await streamBurst(bot, rec)
    expect(rec.filled.length, 'onFilled ran once').to.equal(1)
    expect(rec.filled[0].executedQty).to.equal(FILLED[0])

    release()
    const placedRow = await sending
    const held = bot.orders.get(CLIENT_ID)

    expect(held.status).to.equal('FILLED')
    expect(held.executedQty, 'engine row executed quantity').to.equal(FILLED[0])
    expect(held.cummulativeQuoteQty, 'engine row executed value').to.equal(
      FILLED[1],
    )
    expect(placedRow.executedQty, 'returned row').to.equal(FILLED[0])
    expect(held.orderId).to.equal(VENUE_ID)
    expect(
      rec.logs.some(
        (l) => l.includes('placement answer') && l.includes(CLIENT_ID),
      ),
      'the kept fill is logged',
    ).to.equal(true)
  })

  it('§4.2 an answer that arrives first is applied as before', async () => {
    const { bot, rec, release } = binanceBot({
      status: 'PARTIALLY_FILLED',
      executedQty: PARTIALS[PARTIALS.length - 1][0],
      cummulativeQuoteQty: PARTIALS[PARTIALS.length - 1][1],
    })
    const sending = bot.sendOrderToExchange(baseOrder())
    await tick()
    release()
    await sending
    const held = bot.orders.get(CLIENT_ID)
    expect(held.status).to.equal('PARTIALLY_FILLED')
    expect(held.executedQty).to.equal(PARTIALS[PARTIALS.length - 1][0])
    expect(held.cummulativeQuoteQty).to.equal(PARTIALS[PARTIALS.length - 1][1])
    expect(rec.logs.some((l) => l.includes('placement answer'))).to.equal(false)
  })

  it('§4.2 an answer stating the whole fill after the stream is applied as before', async () => {
    const { bot, rec, release } = binanceBot({
      status: 'FILLED',
      executedQty: FILLED[0],
      cummulativeQuoteQty: FILLED[1],
      updateTime: FILLED_AT,
    })
    const sending = bot.sendOrderToExchange(baseOrder())
    await tick()
    await streamBurst(bot, rec)
    release()
    await sending
    const held = bot.orders.get(CLIENT_ID)
    expect(held.status).to.equal('FILLED')
    expect(held.executedQty).to.equal(FILLED[0])
    expect(rec.logs.some((l) => l.includes('placement answer'))).to.equal(false)
  })
})
