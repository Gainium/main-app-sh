process.env.NODE_ENV = 'testing'

/**
 * A Binance spot placement answer (FULL response) states the fee of every
 * trade the order made by then, in `fills[]`. The user stream states the same
 * fee again, per trade, in `executionReport.n`/`N`/`t`. Both reach the engine
 * for the same trades, in either order, and the order's `feePaid` must count
 * each trade exactly once.
 *
 * Before this change nothing told the stream that the answer had already
 * counted a trade: the per-trade high-water mark `feeTradeId` was only ever
 * advanced by the stream itself. An answer that arrived first therefore had
 * its trades added a second time by the stream reports that followed, and the
 * deal's fee ledger, which is recomputed from the held order rows, booked the
 * fee twice.
 *
 * Run: `npm test` (mocha). No network / DB — the real `sendOrderToExchange`,
 * `processOrderQueue` and `mergeCommonOrderWithOrder` run off the prototype
 * against a fake venue whose placement answer the test releases by hand.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'
import { feeAfterAnswerFills, fillsTradeIdMark } from './orderFee'

const CLIENT_ID = 'x-TEST-BO-feeCountedOncePerTrade01'
const VENUE_ID = '3301000456'
const DEAL_ID = '6ad9520ac16413c9c6f1c3d1'
const AT = 1792800000000

type Trade = { id: string; qty: string; quote: string; fee: string }

/** Three trades of one MARKET buy, as the venue numbers them. */
const T1: Trade = { id: '90001', qty: '50', quote: '50.0', fee: '0.00005' }
const T2: Trade = { id: '90002', qty: '30', quote: '30.0', fee: '0.00003' }
const T3: Trade = { id: '90003', qty: '20', quote: '20.0', fee: '0.00002' }

const sum = (xs: string[]) => xs.reduce((a, x) => a + +x, 0)

function order(over: Record<string, unknown> = {}) {
  return {
    symbol: 'ALTUSDT',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    price: '1',
    origPrice: '1',
    origQty: '100',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'MARKET',
    typeOrder: 'dealStart',
    dealId: DEAL_ID,
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    updateTime: AT - 1000,
    transactTime: AT - 1000,
    ...over,
  } as any
}

/** The placement answer as the connector hands it over: fills + their fee. */
function answer(
  trades: Trade[],
  over: Record<string, unknown> = {},
  tradeIdOf: (t: Trade, i: number) => string = (t) => t.id,
) {
  const qty = sum(trades.map((t) => t.qty))
  return {
    status: qty >= 100 ? 'FILLED' : 'PARTIALLY_FILLED',
    executedQty: `${qty}`,
    cummulativeQuoteQty: `${sum(trades.map((t) => t.quote))}`,
    feePaid: `${sum(trades.map((t) => t.fee))}`,
    feeAsset: 'BNB',
    fills: trades.map((t, i) => ({
      price: '1',
      qty: t.qty,
      commission: t.fee,
      commissionAsset: 'BNB',
      tradeId: tradeIdOf(t, i),
    })),
    ...over,
  }
}

/** One user-stream report: cumulative quantities, THIS trade's commission. */
function report(upTo: Trade[], type = 'MARKET') {
  const last = upTo[upTo.length - 1]
  const qty = sum(upTo.map((t) => t.qty))
  return {
    eventType: 'executionReport',
    eventTime: AT,
    orderTime: AT,
    symbol: 'ALTUSDT',
    newClientOrderId: CLIENT_ID,
    originalClientOrderId: '',
    side: 'BUY',
    orderType: type,
    price: '1',
    quantity: '100',
    orderStatus: qty >= 100 ? 'FILLED' : 'PARTIALLY_FILLED',
    orderId: +VENUE_ID,
    totalTradeQuantity: `${qty}`,
    totalQuoteTradeQuantity: `${sum(upTo.map((t) => t.quote))}`,
    commission: last.fee,
    commissionAsset: 'BNB',
    tradeId: +last.id,
  } as any
}

function bot(
  venueAnswer: Record<string, unknown>,
  exchange = ExchangeEnum.binance,
) {
  const rec = { logs: [] as string[] }
  let release: () => void = () => undefined
  const placed = new Promise<void>((r) => (release = r))
  const b: any = Object.create((MainBot as any).prototype)
  b.botId = 'bot'
  b.userId = 'user'
  b.botType = 'dca'
  b.data = {
    exchange,
    exchangeUUID: '',
    paperContext: false,
    settings: { leverage: 1 },
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
  b.math = {
    round: (v: number, p = 8) => +(+v).toFixed(p),
    remainder: () => 0,
  }
  const good = (data: unknown) => ({
    status: StatusEnum.ok,
    reason: null,
    data,
  })
  b.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    returnGood: () => good,
    async openOrder() {
      await placed
      return good({
        ...order(),
        orderId: VENUE_ID,
        updateTime: -1,
        transactTime: AT,
        ...venueAnswer,
      })
    },
  }
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = (m: string) => rec.logs.push(m)
  b.handleDebug = () => undefined
  b.handleWarn = (m: string) => rec.logs.push(m)
  b.handleError = (m: string) => rec.logs.push(m)
  b.handleErrors = (m: string) => rec.logs.push(m)
  b.handleOrderErrors = async () => undefined
  b.emit = () => undefined
  b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  b.setOrdersToRedis = () => undefined
  b.setOrderByDeal = () => undefined
  b.setOrderByStatus = () => undefined
  b.removeOrderByDeal = () => undefined
  b.removeOrderByStatus = () => undefined
  b.getExchangeInfo = async () => ({
    pair: 'ALTUSDT',
    priceAssetPrecision: 4,
    baseAsset: { minAmount: 1, step: 1, name: 'ALT' },
    quoteAsset: { minAmount: 5, name: 'USDT', precision: 8 },
  })
  b.getUserFee = async () => ({ maker: 0.001, taker: 0.001 })
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
  return { bot: b, rec, release }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

/** Feed reports through the real queue and wait for it to drain. */
async function stream(b: any, reports: any[]) {
  b.orderQueue.push(...reports)
  b.processOrderQueue(b.botId, async () => undefined)
  for (let i = 0; i < 200 && b.orderQueue.length; i++) {
    await tick(1)
  }
  expect(b.orderQueue.length, 'stream drained').to.equal(0)
}

const feeOf = (b: any) => +b.orders.get(CLIENT_ID).feePaid

describe('placement fills and stream reports count each trade fee once', () => {
  it('answer first, then the stream reports the same trade: counted once', async () => {
    const { bot: b, release } = bot(answer([T1, T2, T3]))
    const sending = b.sendOrderToExchange(order())
    await tick()
    release()
    await sending
    expect(
      b.orders.get(CLIENT_ID).feeTradeId,
      'mark seeded from fills',
    ).to.equal(+T3.id)
    await stream(b, [report([T1, T2, T3])])
    expect(feeOf(b)).to.be.closeTo(0.0001, 1e-12)
    expect(b.orders.get(CLIENT_ID).feeTradeId).to.equal(+T3.id)
  })

  it('answer first, single trade: the streamed FILLED does not double it', async () => {
    const { bot: b, release } = bot(
      answer([{ ...T1, qty: '100', quote: '100.0', fee: '0.0001' }]),
    )
    const sending = b.sendOrderToExchange(order())
    await tick()
    release()
    await sending
    await stream(b, [
      report([{ ...T1, qty: '100', quote: '100.0', fee: '0.0001' }]),
    ])
    expect(feeOf(b)).to.be.closeTo(0.0001, 1e-12)
  })

  it('stream first for every trade, then the answer: counted once', async () => {
    const { bot: b, release } = bot(answer([T1, T2, T3]))
    const sending = b.sendOrderToExchange(order())
    await tick()
    await stream(b, [report([T1]), report([T1, T2]), report([T1, T2, T3])])
    expect(feeOf(b), 'stream total').to.be.closeTo(0.0001, 1e-12)
    release()
    await sending
    expect(feeOf(b)).to.be.closeTo(0.0001, 1e-12)
    expect(b.orders.get(CLIENT_ID).feeTradeId).to.equal(+T3.id)
  })

  it('stream first for part of the trades, answer, then the rest: counted once', async () => {
    const { bot: b, release } = bot(answer([T1, T2, T3]))
    const sending = b.sendOrderToExchange(order())
    await tick()
    await stream(b, [report([T1])])
    release()
    await sending
    expect(feeOf(b), 'answer covers every trade').to.be.closeTo(0.0001, 1e-12)
    expect(b.orders.get(CLIENT_ID).feeTradeId).to.equal(+T3.id)
    await stream(b, [report([T1, T2]), report([T1, T2, T3])])
    expect(feeOf(b)).to.be.closeTo(0.0001, 1e-12)
  })

  it('a LIMIT part-filled at placement keeps accruing later trades, once each', async () => {
    const { bot: b, release } = bot(answer([T1, T2]))
    const sending = b.sendOrderToExchange(order({ type: 'LIMIT' }))
    await tick()
    release()
    await sending
    expect(feeOf(b)).to.be.closeTo(0.00008, 1e-12)
    expect(b.orders.get(CLIENT_ID).feeTradeId).to.equal(+T2.id)
    // The stream's own reports of the trades the answer already stated, then
    // the one trade the resting remainder made afterwards.
    await stream(b, [
      report([T1], 'LIMIT'),
      report([T1, T2], 'LIMIT'),
      report([T1, T2, T3], 'LIMIT'),
    ])
    expect(feeOf(b)).to.be.closeTo(0.0001, 1e-12)
    expect(b.orders.get(CLIENT_ID).feeTradeId).to.equal(+T3.id)
  })

  it('a replayed stream report after the answer adds nothing', async () => {
    const { bot: b, release } = bot(answer([T1, T2, T3]))
    const sending = b.sendOrderToExchange(order())
    await tick()
    release()
    await sending
    await stream(b, [report([T1, T2, T3])])
    // processedOrders is reset once the queue drains, so this replay really
    // reaches the converter — only the trade-id mark stops it.
    await stream(b, [report([T1, T2, T3])])
    expect(feeOf(b)).to.be.closeTo(0.0001, 1e-12)
  })

  it('synthetic fill ids (older connector) keep the previous merge: no mark seeded', async () => {
    const { bot: b, release } = bot(
      answer([T1, T2, T3], {}, (_t, i) => `${VENUE_ID}-${i}`),
    )
    const sending = b.sendOrderToExchange(order())
    await tick()
    release()
    await sending
    const held = b.orders.get(CLIENT_ID)
    expect(held.feeTradeId).to.equal(undefined)
    expect(+held.feePaid).to.be.closeTo(0.0001, 1e-12)
  })

  it('SOR allocations (-1) keep the previous merge: no mark seeded', async () => {
    const { bot: b, release } = bot(answer([T1, T2, T3], {}, () => '-1'))
    const sending = b.sendOrderToExchange(order())
    await tick()
    release()
    await sending
    expect(b.orders.get(CLIENT_ID).feeTradeId).to.equal(undefined)
  })
})

describe('mergeCommonOrderWithOrder keeps the fee mark', () => {
  const held = () =>
    order({
      status: 'FILLED',
      orderId: VENUE_ID,
      executedQty: '100',
      cummulativeQuoteQty: '100',
      feePaid: '0.00005',
      feeAsset: 'BNB',
      feeTradeId: +T1.id,
    })

  it('a lookup without a fee keeps the accrued fee and its mark', async () => {
    const { bot: b } = bot({})
    const merged = await b.mergeCommonOrderWithOrder(
      {
        ...order(),
        status: 'FILLED',
        executedQty: '100',
        cummulativeQuoteQty: '100',
        orderId: VENUE_ID,
      },
      held(),
    )
    expect(merged.feePaid).to.equal('0.00005')
    expect(merged.feeTradeId).to.equal(+T1.id)
  })

  it('a lookup with real-id fills moves the mark to the fills', async () => {
    const { bot: b } = bot({})
    const merged = await b.mergeCommonOrderWithOrder(
      { ...order(), orderId: VENUE_ID, ...answer([T1, T2, T3]) },
      held(),
    )
    expect(+merged.feePaid).to.be.closeTo(0.0001, 1e-12)
    expect(merged.feeTradeId).to.equal(+T3.id)
  })

  it('another venue: the fills never move the mark', async () => {
    const { bot: b } = bot({}, ExchangeEnum.kucoin)
    const merged = await b.mergeCommonOrderWithOrder(
      {
        ...order({ exchange: ExchangeEnum.kucoin }),
        orderId: VENUE_ID,
        ...answer([T1, T2, T3]),
      },
      { ...held(), exchange: ExchangeEnum.kucoin },
    )
    expect(merged.feeTradeId).to.equal(+T1.id)
    expect(+merged.feePaid).to.be.closeTo(0.0001, 1e-12)
  })
})

describe('feeAfterAnswerFills / fillsTradeIdMark', () => {
  it('reads the highest id only when every fill carries a real one', () => {
    expect(fillsTradeIdMark([{ tradeId: '7' }, { tradeId: '12' }])).to.equal(12)
    expect(fillsTradeIdMark([{ tradeId: '7' }, { tradeId: '55-1' }])).to.equal(
      null,
    )
    expect(fillsTradeIdMark([{ tradeId: '-1' }])).to.equal(null)
    expect(fillsTradeIdMark([{ tradeId: '' }])).to.equal(null)
    expect(fillsTradeIdMark([{}])).to.equal(null)
    expect(fillsTradeIdMark([])).to.equal(null)
    expect(fillsTradeIdMark(undefined)).to.equal(null)
  })

  it('answers nothing for a venue other than Binance spot', () => {
    for (const ex of [
      ExchangeEnum.kucoin,
      ExchangeEnum.bybit,
      ExchangeEnum.binanceUsdm,
      ExchangeEnum.paperBinance,
    ]) {
      expect(feeAfterAnswerFills(ex, {}, answer([T1]) as any), ex).to.equal(
        null,
      )
    }
    expect(
      feeAfterAnswerFills(ExchangeEnum.binanceUS, {}, answer([T1]) as any),
    ).to.not.equal(null)
  })

  it('keeps the held fee when the stream has already counted beyond the answer', () => {
    const out = feeAfterAnswerFills(
      ExchangeEnum.binance,
      { feePaid: '0.0001', feeAsset: 'BNB', feeTradeId: +T3.id },
      answer([T1, T2]) as any,
    )
    expect(out?.feePaid).to.equal('0.0001')
    expect(out?.feeTradeId).to.equal(+T3.id)
  })

  it('takes the answer and its mark when the stream is at or behind it', () => {
    const out = feeAfterAnswerFills(
      ExchangeEnum.binance,
      { feePaid: '0.00005', feeAsset: 'BNB', feeTradeId: +T1.id },
      answer([T1, T2]) as any,
    )
    expect(+(out?.feePaid ?? 0)).to.be.closeTo(0.00008, 1e-12)
    expect(out?.feeTradeId).to.equal(+T2.id)
  })

  it('answers nothing when the answer states no fee', () => {
    expect(
      feeAfterAnswerFills(ExchangeEnum.binance, {}, {
        fills: [{ tradeId: '5' }],
      } as any),
    ).to.equal(null)
  })
})
