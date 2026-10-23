process.env.NODE_ENV = 'testing'

/**
 * A MARKET order is stamped at placement with the market price the engine
 * held (`refPrice`, with that price's own observation time `refPriceAt`) and
 * with the moment the request left this process (`sentAt`), and a rebuild
 * from a venue payload keeps the stamps (main-app spec 050 §3).
 *
 * Run: `npm test` (mocha). No network / DB — the real `sendOrderToExchange`
 * and `mergeCommonOrderWithOrder` run off the prototype against a fake venue.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLIENT_ID = 'x-TEST-BO-marketStamp000000000001'
const TICK_AT = 1_792_627_225_000

function order(over: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    // A regular DCA base order is sent at a protectively shifted price.
    price: '99500',
    origPrice: '99500',
    origQty: '0.01',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'MARKET',
    typeOrder: 'dealStart',
    dealId: 'deal',
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    updateTime: TICK_AT,
    transactTime: TICK_AT,
    ...over,
  } as any
}

function bot(opts: { last?: { price: number; time: number } } = {}) {
  const rec = {
    saved: [] as any[],
    stampWrites: [] as any[],
    sentAtWhenCalled: undefined as number | undefined,
    ackAtWhenCalled: undefined as number | undefined,
  }
  const b: any = Object.create((MainBot as any).prototype)
  b.botId = 'bot'
  b.userId = 'user'
  b.botType = 'dca'
  b.priceTimeout = 150_000
  b.data = {
    exchange: ExchangeEnum.binance,
    exchangeUUID: '',
    paperContext: false,
    settings: { leverage: 1 },
    flags: [],
  }
  b.orders = new Map()
  b.ordersKeys = new Set()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.math = {
    round: (v: number, p = 8) => +(+v).toFixed(p),
    remainder: () => 0,
  }
  b.lastStreamData = new Map(opts.last ? [['BTCUSDT', opts.last]] : [])
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
    async openOrder(req: any) {
      rec.sentAtWhenCalled = b.orders.get(req.newClientOrderId)?.sentAt
      rec.ackAtWhenCalled = b.orders.get(req.newClientOrderId)?.ackAt
      return good({
        ...order(),
        orderId: '777',
        status: 'FILLED',
        executedQty: '0.01',
        cummulativeQuoteQty: '1000.5',
        price: '100050',
        updateTime: TICK_AT + 900,
        transactTime: TICK_AT + 900,
      })
    },
  }
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = () => undefined
  b.handleDebug = () => undefined
  b.handleWarn = () => undefined
  b.handleErrors = () => undefined
  b.handleOrderErrors = async () => undefined
  b.emit = () => undefined
  b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  b.setOrdersToRedis = () => undefined
  b.setOrderByDeal = () => undefined
  b.setOrderByStatus = () => undefined
  b.removeOrderByDeal = () => undefined
  b.removeOrderByStatus = () => undefined
  b.getExchangeInfo = async () => ({
    pair: 'BTCUSDT',
    priceAssetPrecision: 2,
    baseAsset: {
      minAmount: 0.0001,
      step: 0.0001,
      name: 'BTC',
      maxMarketAmount: 1000,
    },
    quoteAsset: { minAmount: 5, name: 'USDT', precision: 8 },
  })
  b.getUserFee = async () => ({ maker: 0.001, taker: 0.001 })
  b.saveOrderToDb = async (o: any) => rec.saved.push({ ...o })
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
    updateData: async (filter: any, update: any) => {
      rec.stampWrites.push({ filter, update })
      return { status: StatusEnum.ok }
    },
  }
  b.botEventDb = { createData: () => undefined }
  return { b, rec }
}

describe('MARKET placement stamps (spec 050 §3)', () => {
  it('§3.1 refPrice is the held market price, stamped before the write-ahead row', async () => {
    const now = +new Date()
    const { b, rec } = bot({ last: { price: 100_000, time: now - 400 } })
    const placed = await b.sendOrderToExchange(order())
    expect(rec.saved[0].refPrice, 'write-ahead row').to.equal('100000')
    expect(rec.saved[0].refPriceAt, 'the tick’s own time').to.equal(now - 400)
    expect(placed.refPrice).to.equal('100000')
    // never the shifted send price
    expect(placed.refPrice).to.not.equal(placed.origPrice)
  })

  it('§3.1 no fresh price held → no refPrice (absent = not observed)', async () => {
    const { b, rec } = bot({
      last: { price: 100_000, time: +new Date() - 10 * 60_000 },
    })
    await b.sendOrderToExchange(order())
    expect(rec.saved[0]).to.not.have.property('refPrice')
    const { b: b2, rec: rec2 } = bot()
    await b2.sendOrderToExchange(order())
    expect(rec2.saved[0]).to.not.have.property('refPrice')
  })

  it('§3.1 a recorded refPrice is not replaced on a re-entry', async () => {
    const { b } = bot({ last: { price: 100_000, time: +new Date() } })
    const placed = await b.sendOrderToExchange(
      order({ refPrice: '99990', refPriceAt: 1 }),
    )
    expect(placed.refPrice).to.equal('99990')
    expect(placed.refPriceAt).to.equal(1)
  })

  it('§3.1 LIMIT orders are not stamped', async () => {
    const { b, rec } = bot({ last: { price: 100_000, time: +new Date() } })
    await b.sendOrderToExchange(order({ type: 'LIMIT' }))
    expect(rec.saved[0]).to.not.have.property('refPrice')
    expect(rec.stampWrites).to.have.length(0)
  })

  it('§3.2 sentAt before the venue call, ackAt after its answer, each written without a status guard', async () => {
    const before = +new Date()
    const { b, rec } = bot({ last: { price: 100_000, time: before } })
    const placed = await b.sendOrderToExchange(order())
    expect(rec.sentAtWhenCalled, 'set when the request leaves').to.be.a(
      'number',
    )
    expect(rec.sentAtWhenCalled!).to.be.at.least(before)
    expect(rec.ackAtWhenCalled, 'not yet answered').to.equal(undefined)
    expect(placed.sentAt).to.equal(rec.sentAtWhenCalled)
    expect(placed.ackAt).to.be.at.least(placed.sentAt)
    expect(rec.stampWrites).to.deep.equal([
      {
        filter: { clientOrderId: CLIENT_ID },
        update: { $set: { sentAt: placed.sentAt } },
      },
      {
        filter: { clientOrderId: CLIENT_ID },
        update: { $set: { ackAt: placed.ackAt } },
      },
    ])
  })

  it('§3.3 a rebuild from a venue payload keeps the stamps', async () => {
    const { b } = bot()
    const held = order({
      refPrice: '100000',
      refPriceAt: 5,
      sentAt: 6,
      ackAt: 7,
    })
    const merged = await b.mergeCommonOrderWithOrder(
      {
        ...order(),
        status: 'FILLED',
        executedQty: '0.01',
        cummulativeQuoteQty: '1000',
        price: '100000',
        updateTime: 9,
      },
      held,
    )
    expect(merged).to.include({
      refPrice: '100000',
      refPriceAt: 5,
      sentAt: 6,
      ackAt: 7,
    })
    const unstamped = await b.mergeCommonOrderWithOrder(
      {
        ...order(),
        status: 'FILLED',
        executedQty: '0.01',
        cummulativeQuoteQty: '1000',
        price: '100000',
        updateTime: 9,
      },
      order(),
    )
    expect(Object.keys(unstamped)).to.not.include('refPrice')
  })
})
