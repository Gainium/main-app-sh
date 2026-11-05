process.env.NODE_ENV = 'testing'

/**
 * Spec `223.unknown-order-ladder-loses-a-filled-answer-on-by-id-venues`.
 *
 * On a venue queried by exchange order id (Kraken spot, Coinbase, KuCoin full
 * futures) the unknown-order ladder swaps the client order id for the stored
 * exchange id before asking. When the venue then answers, the DB fallback must
 * still look the row up by the CLIENT order id — the row is keyed by it.
 *
 * Sequence (§2): a market take-profit fills on the user stream, the deal
 * closes and drops the order from the map, then the placement read-back miss
 * reaches the ladder. The venue says FILLED; the ladder must return the order.
 *
 * Run: `npm test` (mocha). No network / DB — real methods off the prototype.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLIENT_ID = 'D-TP-mglAjDHsFjAhx'
const TXID = 'OLWDS7-ELDDL-TXZGAT'

const row = (over: Record<string, unknown> = {}) =>
  ({
    symbol: 'BTC-USD',
    orderId: TXID,
    clientOrderId: CLIENT_ID,
    price: '78384.9',
    origQty: '0.00089602',
    executedQty: '0.00089602',
    cummulativeQuoteQty: '70.23444',
    status: 'FILLED',
    side: 'SELL',
    type: 'MARKET',
    typeOrder: 'dealTP',
    updateTime: 1793782801213,
    ...over,
  }) as any

function bot(exchange: ExchangeEnum, dbRow: any) {
  const rec = { reads: [] as any[], getOrder: [] as string[], db: [] as any[] }
  const b: any = Object.create((MainBot as any).prototype)
  b.data = { exchange, exchangeUUID: '', paperContext: false }
  // The deal closed on the stream fill and dropped the order from the map.
  b.orders = new Map()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async getOrder(req: { newClientOrderId: string }) {
      rec.getOrder.push(req.newClientOrderId)
      return req.newClientOrderId === TXID
        ? { status: StatusEnum.ok, reason: null, data: row() }
        : {
            status: StatusEnum.notok,
            reason: 'Order not found',
            data: null,
          }
    },
  }
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = () => undefined
  b.handleDebug = () => undefined
  b.handleWarn = () => undefined
  b.handleErrors = () => undefined
  b.emit = () => undefined
  b.setOrder = (o: any) => b.orders.set(o.clientOrderId, o)
  b.deleteOrder = (id: string) => b.orders.delete(id)
  b.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b.convertOrderQuoteQty = async (_s: string, q: string) => q
  b.getOrderFromMap = (id: string) => b.orders.get(id)
  b.ordersDb = {
    readData: async (q: { clientOrderId: string }) => {
      rec.reads.push(q)
      return {
        data: {
          result: q.clientOrderId === CLIENT_ID ? { ...dbRow } : undefined,
        },
      }
    },
    updateData: async (q: any, d: any) => {
      rec.db.push({ q, d })
      return { status: StatusEnum.ok }
    },
  }
  return { b, rec }
}

describe('unknown-order ladder on a by-id venue keeps the venue answer (spec 223)', () => {
  it('§1.1 a FILLED answer for an order the deal already dropped is returned, not lost', async () => {
    const { b, rec } = bot(ExchangeEnum.kraken, row())
    const res = await b._handleUnknownOrder(CLIENT_ID, 'BTC-USD', true)
    expect(rec.getOrder, 'asked the venue by txid').to.deep.equal([TXID])
    expect(
      rec.reads.every((q) => q.clientOrderId === CLIENT_ID),
      `every row lookup is by client order id, saw ${JSON.stringify(rec.reads)}`,
    ).to.equal(true)
    expect(res, 'the ladder returns the filled order').to.not.equal(null)
    expect(res.clientOrderId).to.equal(CLIENT_ID)
    expect(res.status).to.equal('FILLED')
  })

  it('§1.2 a row that lags the venue is updated under its client order id', async () => {
    const { b, rec } = bot(
      ExchangeEnum.coinbase,
      row({ status: 'NEW', executedQty: '0' }),
    )
    const res = await b._handleUnknownOrder(CLIENT_ID, 'BTC-USD', true)
    expect(res?.status).to.equal('FILLED')
    const write = rec.db.find((w) => w.q)
    expect(write?.q).to.deep.equal({ clientOrderId: CLIENT_ID })
    expect(write?.d.status).to.equal('FILLED')
  })
})
