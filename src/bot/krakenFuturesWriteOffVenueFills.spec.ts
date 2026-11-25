process.env.NODE_ENV = 'testing'

/**
 * Spec `270.kraken-futures-write-off-ignores-venue-fills`.
 *
 * 2026-10-30, Kraken Futures combo grid: resting grid sells filled
 * on the venue while Kraken Futures was answering 503 and the user stream
 * delivered nothing. By the time the deal closed they had aged out of
 * Kraken's events page, every lookup answered "Order not found in history",
 * and the unknown-order ladder wrote each one off as CANCELED with 0 executed.
 * The account fills, which carry our client order id, showed each one filled in full.
 *
 * The real `_handleUnknownOrder` runs off the prototype against a recording
 * fake venue. No network / DB. Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLI = 'CMB-GR-Jhep2E1vPStRJ1nRu6gY6XNlNSH5'
const UID = 'a319db7a-0000-4000-8000-000000000001'
const PLACED = +new Date('2026-10-29T22:55:17Z')
const FILLED_AT = +new Date('2026-10-30T04:47:12Z')

const row = (over: Record<string, unknown> = {}) =>
  ({
    symbol: 'ONDO-USD',
    orderId: UID,
    clientOrderId: CLI,
    price: '0.6871',
    origPrice: '0.6871',
    origQty: '13',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'SELL',
    type: 'LIMIT',
    typeOrder: 'dealGrid',
    dealId: 'deal',
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: '',
    updateTime: PLACED,
    transactTime: PLACED,
    ...over,
  }) as any

const fill = (over: Record<string, unknown> = {}) => ({
  fillId: `${Math.random()}`,
  orderId: UID,
  clientOrderId: CLI,
  symbol: 'ONDO-USD',
  side: 'SELL',
  price: '0.6871',
  quantity: '13',
  timestamp: FILLED_AT,
  ...over,
})

type Venue = {
  getOrder?: () => any
  /** Pages of fills, newest first; or a failure reason. */
  pages?: any[][]
  fillsFail?: string
}

function bot(exchange: ExchangeEnum, venue: Venue) {
  const rec = { db: [] as any[], logs: [] as string[], fillCalls: [] as any[] }
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
  b.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => good,
    async getOrder() {
      return venue.getOrder
        ? good(venue.getOrder())
        : bad('Order not found in history')
    },
    async getAccountFills(since?: number) {
      rec.fillCalls.push(since)
      if (venue.fillsFail) return bad(venue.fillsFail)
      const pages = venue.pages ?? []
      return good(pages[rec.fillCalls.length - 1] ?? [])
    },
  }
  b.handleLog = (m: string) => rec.logs.push(m)
  b.handleDebug = () => undefined
  b.handleWarn = (m: string) => rec.logs.push(m)
  b.emit = () => undefined
  b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  b.setOrdersToRedis = () => undefined
  b.setOrderByDeal = () => undefined
  b.setOrderByStatus = () => undefined
  b.removeOrderByDeal = () => undefined
  b.removeOrderByStatus = () => undefined
  b.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b.convertOrderQuoteQty = async (_s: string, q: string) => q
  b.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async (_q: unknown, o: any) => {
      rec.db.push({ ...o })
      return { status: StatusEnum.ok }
    },
  }
  return { b, rec }
}

/** Enter the ladder's terminal branch: the five lookups are already spent. */
async function exhaust(b: any) {
  b.canceledMap.set(CLI, 5)
  return b._handleUnknownOrder(CLI, 'ONDO-USD')
}

describe('Kraken Futures write-off reads the venue fills first (spec 270)', () => {
  it('§1/§4.1 the 2026-10-30 case: filled on the venue, aged out of history -> FILLED 13, not CANCELED 0', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      pages: [[fill(), fill({ clientOrderId: 'other', quantity: '99' })]],
    })
    b.orders.set(CLI, row())
    const res = await exhaust(b)
    expect(res?.status).to.equal('FILLED')
    expect(res?.executedQty).to.equal('13')
    expect(+res?.cummulativeQuoteQty).to.be.closeTo(13 * 0.6871, 1e-9)
    expect(rec.db.map((d) => [d.status, d.executedQty])).to.deep.equal([
      ['FILLED', '13'],
    ])
    expect(b.orders.has(CLI)).to.equal(false)
  })

  it('§4.1 pages back until the page reaches the order placement', async () => {
    const newer = Array.from({ length: 3 }, (_, i) =>
      fill({ clientOrderId: `x${i}`, timestamp: FILLED_AT + 3_600_000 }),
    )
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      pages: [
        newer,
        [fill(), fill({ clientOrderId: 'y', timestamp: PLACED - 1 })],
      ],
    })
    b.orders.set(CLI, row())
    const res = await exhaust(b)
    expect(rec.fillCalls).to.deep.equal([undefined, FILLED_AT + 3_600_000])
    expect(res?.status).to.equal('FILLED')
  })

  it('§4.2 part-filled then gone -> CANCELED keeping what executed', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      pages: [[fill({ quantity: '5' })]],
    })
    b.orders.set(CLI, row())
    const res = await exhaust(b)
    expect(res?.status).to.equal('CANCELED')
    expect(res?.executedQty).to.equal('5')
    expect(rec.db[0].status).to.equal('CANCELED')
  })

  it('§4.3 no fills for the id: really cancelled -> CANCELED 0 as before', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      pages: [[fill({ clientOrderId: 'other' })]],
    })
    b.orders.set(CLI, row())
    const res = await exhaust(b)
    expect(res?.status).to.equal('CANCELED')
    expect(res?.executedQty).to.equal('0')
    expect(rec.db[0].status).to.equal('CANCELED')
  })

  it('§4.4 fill history unreadable (transient) -> row kept, nothing written', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      fillsFail: 'Response timeout',
    })
    b.orders.set(CLI, row())
    const res = await exhaust(b)
    expect(res).to.equal(null)
    expect(rec.db).to.deep.equal([])
    expect(b.orders.get(CLI)?.status).to.equal('NEW')
  })

  it('§4.4 fill history refused for the key (permanent) -> written off as before', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      fillsFail: 'Failed to get fills. Result: error (authenticationError)',
    })
    b.orders.set(CLI, row())
    const res = await exhaust(b)
    expect(res?.status).to.equal('CANCELED')
    expect(rec.db[0].status).to.equal('CANCELED')
  })

  it('§4.5 other venues: no fill read, written off exactly as before', async () => {
    const { b, rec } = bot(ExchangeEnum.binanceUsdm, { pages: [[fill()]] })
    b.orders.set(CLI, row({ exchange: ExchangeEnum.binanceUsdm }))
    const res = await exhaust(b)
    expect(rec.fillCalls).to.deep.equal([])
    expect(res?.status).to.equal('CANCELED')
  })

  it('§3.3 a fills-only FILLED answer short of the row size is stored as a part-filled cancel', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      getOrder: () => ({
        ...row(),
        status: 'FILLED',
        origQty: '5',
        executedQty: '5',
        cummulativeQuoteQty: `${5 * 0.6871}`,
      }),
    })
    b.orders.set(CLI, row())
    await b._handleUnknownOrder(CLI, 'ONDO-USD')
    expect(rec.db.map((d) => [d.status, d.executedQty])).to.deep.equal([
      ['CANCELED', '5'],
    ])
  })

  it('§3.3 control: a venue FILLED carrying its own larger size is not reread as a cancel', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      getOrder: () => ({
        ...row(),
        status: 'FILLED',
        origQty: '13',
        executedQty: '5',
        cummulativeQuoteQty: `${5 * 0.6871}`,
      }),
    })
    b.orders.set(CLI, row())
    await b._handleUnknownOrder(CLI, 'ONDO-USD')
    expect(rec.db.map((d) => d.status)).to.deep.equal(['FILLED'])
  })

  it('§3.3 control: a full FILLED answer is stored FILLED', async () => {
    const { b, rec } = bot(ExchangeEnum.krakenUsdm, {
      getOrder: () => ({
        ...row(),
        status: 'FILLED',
        executedQty: '13',
        cummulativeQuoteQty: `${13 * 0.6871}`,
      }),
    })
    b.orders.set(CLI, row())
    const res = await b._handleUnknownOrder(CLI, 'ONDO-USD')
    expect(res?.status).to.equal('FILLED')
    expect(rec.db.map((d) => [d.status, d.executedQty])).to.deep.equal([
      ['FILLED', '13'],
    ])
  })
})
