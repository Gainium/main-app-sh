process.env.NODE_ENV = 'testing'

/**
 * A Kraken spot grid order was accepted by the venue, but the bot kept it at
 * the `'-1'` placeholder: the placement answer came back with the Kraken txid
 * as its `clientOrderId`, so the saved copy was filed under the txid and the
 * real client id kept the write-ahead object. After a worker restart, `getOrder`
 * answered that order with its own synthetic "no exchange order id" without
 * asking Kraken, the restart probe retired it as CANCELED, and its later fill
 * never reached the deal.
 *
 * Spec: `specs/184.a-placed-kraken-order-is-retired-as-never-placed.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB — the real `sendOrderToExchange`, `getOrder` and
 * `noteOrderNotFound` run off the prototype against a recording fake venue.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot, { isDefinitiveOrderNotFound } from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLIENT_ID = 'CMB-GR-aaaaaaaaaaa'
const TXID = 'OAAAAA-BBBBB-CCCCCC'
const DEAL_ID = '6ad1d980a12f18786353d630'
/** Old enough for every never-placed age floor (spec 177 §1.2). */
const LONG_AGO = Date.now() - 2 * 24 * 60 * 60 * 1000

function grid(over: Record<string, unknown> = {}) {
  return {
    symbol: 'SOL-USD',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    price: '106.26',
    origPrice: '106.26',
    origQty: '1.77499981',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'LIMIT',
    typeOrder: 'dealGrid',
    dealId: DEAL_ID,
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '',
    updateTime: LONG_AGO,
    transactTime: LONG_AGO,
    ...over,
  } as any
}

type Rec = {
  open: string[]
  getOrder: string[]
  openOrders: string[]
  db: any[]
  logs: string[]
}

type Venue = {
  /** What the placement answer echoes as `clientOrderId`. */
  echo?: string
  /** What a client-id lookup answers: the order, a not-found, or a failure. */
  byClientId?: 'open' | 'filled' | 'absent' | 'timeout'
  /** What the open-orders list holds (Coinbase / KuCoin futures). */
  openList?: { clientOrderId: string; orderId: string }[]
}

function bot(exchange: ExchangeEnum, venue: Venue = {}) {
  const rec: Rec = { open: [], getOrder: [], openOrders: [], db: [], logs: [] }
  const bad = (reason: string) => ({
    status: StatusEnum.notok,
    reason,
    data: null,
  })
  const good = (data: unknown) => ({ status: StatusEnum.ok, reason: null, data })
  const venueOrder = (status: string) => ({
    ...grid(),
    orderId: TXID,
    status,
    executedQty: status === 'FILLED' ? '1.77499981' : '0',
    cummulativeQuoteQty: status === 'FILLED' ? '188.61148' : '0',
  })
  const b: any = Object.create((MainBot as any).prototype)
  b.botId = 'bot'
  b.userId = 'user'
  b.botType = 'combo'
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
  b.newlyQuarantined = []
  b.math = {
    round: (v: number, p = 8) => +(+v).toFixed(p),
    remainder: () => 0,
  }
  b.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => good,
    async openOrder(req: { newClientOrderId: string }) {
      rec.open.push(req.newClientOrderId)
      return good({
        ...venueOrder('NEW'),
        clientOrderId: venue.echo ?? req.newClientOrderId,
      })
    },
    async getAllOpenOrders(symbol: string) {
      rec.openOrders.push(symbol)
      return good(
        (venue.openList ?? []).map((o) => ({ ...venueOrder('NEW'), ...o })),
      )
    },
    async getOrder(req: { newClientOrderId: string }) {
      rec.getOrder.push(req.newClientOrderId)
      if (req.newClientOrderId === TXID) {
        return good(
          venueOrder(venue.byClientId === 'filled' ? 'FILLED' : 'NEW'),
        )
      }
      if (req.newClientOrderId === CLIENT_ID) {
        switch (venue.byClientId) {
          case 'open':
            return good(venueOrder('NEW'))
          case 'filled':
            return good(venueOrder('FILLED'))
          case 'timeout':
            return bad('Response timeout')
          default:
            return bad('Order not found in history')
        }
      }
      return bad('Order not found')
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
    pair: 'SOL-USD',
    priceAssetPrecision: 2,
    baseAsset: { minAmount: 0.00000001, step: 0.00000001, name: 'SOL' },
    quoteAsset: { minAmount: 0.5, name: 'USD', precision: 5 },
  })
  b.getUserFee = async () => ({ maker: 0.0025, taker: 0.004 })
  b.saveOrderToDb = async () => undefined
  b.deleteOrderFromDb = async () => undefined
  b.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  b.getNotEnoughOrdersIdByOrder = () => 'nb'
  b.isComplianceGateable = () => false
  b.needToSendOrder = () => true
  b.markDealStartBlocked = async () => undefined
  b.isErrorNotEnoughBalance = () => false
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b.convertOrderQuoteQty = async (_s: string, q: string) => q
  b.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async () => ({ status: StatusEnum.ok }),
  }
  b.botEventDb = { createData: () => undefined }
  return { bot: b, rec }
}

describe('a placed Kraken order is not retired as never placed (spec 184)', () => {
  it('§4.1 an accepted placement is saved under the client id that was sent, whatever the answer echoes', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.kraken, { echo: TXID })
    const saved = await b.sendOrderToExchange(grid({ updateTime: Date.now() }))
    expect(rec.open).to.deep.equal([CLIENT_ID])
    expect(saved?.clientOrderId).to.equal(CLIENT_ID)
    expect(b.orders.get(CLIENT_ID)?.orderId, 'the order the bot tracks').to.equal(
      TXID,
    )
    expect(b.orders.has(TXID), 'no twin keyed by the txid').to.equal(false)
    expect(
      rec.db.map((d) => [d.clientOrderId, d.orderId]),
      'the row write addresses the real row',
    ).to.deep.equal([[CLIENT_ID, TXID]])
  })

  it('§4.1 control: a matching echo is saved exactly as before', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.kraken)
    const saved = await b.sendOrderToExchange(grid({ updateTime: Date.now() }))
    expect(saved?.clientOrderId).to.equal(CLIENT_ID)
    expect(b.orders.get(CLIENT_ID)?.orderId).to.equal(TXID)
    expect(rec.db.map((d) => d.orderId)).to.deep.equal([TXID])
  })

  it('§4.2/§4.3 Kraken: a -1 order is asked by client id, its txid adopted, and its fill returned', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.kraken, { byClientId: 'filled' })
    b.orders.set(CLIENT_ID, grid())
    const res = await b.getOrder(CLIENT_ID, 'SOL-USD', false)
    expect(rec.getOrder[0], 'asked by the client id, not -1').to.equal(CLIENT_ID)
    expect(res.status).to.equal(StatusEnum.ok)
    expect(res.data?.status).to.equal('FILLED')
    expect(res.data?.executedQty).to.equal('1.77499981')
    expect(b.orders.get(CLIENT_ID)?.orderId).to.equal(TXID)
    expect(rec.db.map((d) => d.orderId)).to.include(TXID)
  })

  it('§4.3 Kraken: the venue holds no such order — a not-found the venue gave, which still retires (§1.1.6)', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.kraken, { byClientId: 'absent' })
    const o = grid()
    b.orders.set(CLIENT_ID, o)
    const res = await b.getOrder(CLIENT_ID, 'SOL-USD', false)
    expect(rec.getOrder).to.deep.equal([CLIENT_ID])
    expect(isDefinitiveOrderNotFound(res)).to.equal(true)
    expect(res.reason).to.not.equal('Order not found: no exchange order id')
    expect(b.noteOrderNotFound(o, `${res.reason}`)).to.equal(true)
    expect(rec.db.map((d) => d.status)).to.deep.equal(['CANCELED'])
  })

  it('§1.1.4 Kraken: a failed lookup is not a not-found and retires nothing', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.kraken, { byClientId: 'timeout' })
    b.orders.set(CLIENT_ID, grid())
    const res = await b.getOrder(CLIENT_ID, 'SOL-USD', false)
    expect(rec.getOrder).to.deep.equal([CLIENT_ID])
    expect(res.status).to.equal(StatusEnum.notok)
    expect(isDefinitiveOrderNotFound(res)).to.equal(false)
    expect(b.orders.get(CLIENT_ID)?.orderId).to.equal('-1')
  })

  it('§4.4 the synthetic "no exchange order id" never retires an order', () => {
    const { bot: b, rec } = bot(ExchangeEnum.kraken)
    const o = grid()
    b.orders.set(CLIENT_ID, o)
    expect(
      b.noteOrderNotFound(o, 'Order not found: no exchange order id'),
    ).to.equal(false)
    expect(b.orders.get(CLIENT_ID)?.status).to.equal('NEW')
    expect(rec.db.filter((d) => d.status === 'CANCELED')).to.deep.equal([])
  })

  it('§4.2 KuCoin full futures: a -1 order resting on the venue is found in its open orders', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.kucoinLinear, {
      openList: [{ clientOrderId: CLIENT_ID, orderId: TXID }],
    })
    b.orders.set(CLIENT_ID, grid({ exchange: ExchangeEnum.kucoinLinear }))
    const res = await b.getOrder(CLIENT_ID, 'SOL-USD', false)
    expect(rec.openOrders).to.deep.equal(['SOL-USD'])
    expect(rec.getOrder).to.deep.equal([TXID])
    expect(res.status).to.equal(StatusEnum.ok)
    expect(b.orders.get(CLIENT_ID)?.orderId).to.equal(TXID)
  })

  it('§4.3 Coinbase: getOrder looks the -1 order up instead of answering for the venue', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.coinbase, {
      openList: [{ clientOrderId: CLIENT_ID, orderId: TXID }],
    })
    b.orders.set(CLIENT_ID, grid({ exchange: ExchangeEnum.coinbase }))
    const res = await b.getOrder(CLIENT_ID, 'SOL-USD', false)
    expect(rec.openOrders).to.deep.equal(['SOL-USD'])
    expect(res.status).to.equal(StatusEnum.ok)
    expect(b.orders.get(CLIENT_ID)?.orderId).to.equal(TXID)
  })

  it('control: a venue addressed by client id is untouched (one direct lookup)', async () => {
    const { bot: b, rec } = bot(ExchangeEnum.binance)
    b.orders.set(CLIENT_ID, grid({ exchange: ExchangeEnum.binance }))
    await b.getOrder(CLIENT_ID, 'SOL-USD', false)
    expect(rec.openOrders).to.deep.equal([])
    expect(rec.getOrder).to.deep.equal([CLIENT_ID])
  })
})
