process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `308.a-never-confirmed-order-of-a-finished-deal-stays-open`.
 *
 * An order row whose placement answer was never recorded keeps the `'-1'`
 * placeholder. Every reconcile path asks about such a row only while its deal
 * is held and open, so once the deal closed or was canceled the row stayed
 * NEW in Mongo for good: never asked about again, never written off.
 *
 * Drives the REAL `retireFinishedDealUnplacedOrders` of MainBot with the REAL
 * DCA `finishedOrMissingDealIds`, through the REAL `getOrderForReconcile` /
 * `getOrder` / `retireNeverPlacedOrder`. Mongo and the venue are recorded
 * stubs.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { DCADealStatusEnum, StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b08'
const DEAL_ID = '000000000000000000000d08'
const SYMBOL = 'TESTUSDT'
const CLIENT_ID = 'D-TP-000000000000000000000308'
const PLACED_AT = Date.now() - 30 * 24 * 60 * 60 * 1000
/** Binance's answer for a client id it never received. */
const ABSENT = 'Order does not exist.'

const row = (over: Record<string, unknown> = {}) =>
  ({
    _id: 'row-308',
    botId: BOT_ID,
    dealId: DEAL_ID,
    symbol: SYMBOL,
    clientOrderId: CLIENT_ID,
    orderId: '-1',
    typeOrder: TypeOrderEnum.dealTP,
    type: 'LIMIT',
    side: 'SELL',
    price: '1.25',
    origPrice: '1.25',
    origQty: '10',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    transactTime: PLACED_AT,
    updateTime: PLACED_AT,
    ...over,
  }) as any

class Base {
  constructor(..._a: any[]) {}
}
Object.setPrototypeOf(Base.prototype, (MainBot as any).prototype)

let Dca: any

type Opts = {
  rows?: any[]
  /** Status of the deal in Mongo; `null` = no record. */
  dealStatus?: DCADealStatusEnum | null
  /** This process holds the deal. */
  held?: boolean
  /** The venue's answer to a lookup. */
  venue?: (q: any) => any
}

const buildBot = (opts: Opts = {}) => {
  const {
    rows = [row()],
    dealStatus = DCADealStatusEnum.closed,
    held = false,
    venue = () => ({ status: StatusEnum.notok, reason: ABSENT, data: null }),
  } = opts
  const rec = {
    lookups: [] as any[],
    persisted: [] as any[],
    placed: [] as any[],
    filled: [] as any[],
    warns: [] as string[],
  }
  const bot: any = Object.create(Dca.prototype)
  Object.assign(bot, {
    botId: BOT_ID,
    data: {
      _id: BOT_ID,
      exchange: 'binance',
      exchangeUUID: '',
      paperContext: false,
      settings: { pair: [SYMBOL] },
    },
    reconcileBatch: null,
    math: { round: (v: number) => v },
    getExchangeInfo: async () => ({ priceAssetPrecision: 8 }),
    orders: new Map(),
    ordersKeys: new Set(),
    orderStatusMap: new Map(),
    orderDealMap: new Map(),
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    setOrdersToRedis: () => undefined,
    startMethod: () => '1',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleWarn: (m: string) => rec.warns.push(m),
    handleErrors: (m: string) => rec.warns.push(m),
    emit: () => true,
    paceReconcileLookup: async () => true,
    awaitPlacementInFlight: async () => undefined,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    convertOrderQuoteQty: async (_s: string, q: string) => q,
    getDeal: (id?: string) =>
      held && id === DEAL_ID ? { deal: { _id: DEAL_ID, status: 'open' } } : undefined,
    updateOrderOnDb: (o: any) => rec.persisted.push({ ...o }),
    processFilledOrder: async (o: any) => rec.filled.push(o),
    handleUnknownOrder: async (o: any) => rec.filled.push(o),
    placeOrders: async (...a: any[]) => rec.placed.push(a),
    ordersDb: {
      readData: async (q: any, _p: any, o: any) => {
        const result = rows
          .filter(
            (r) =>
              r.botId === q.botId &&
              `${r.orderId}` === q.orderId &&
              q.status.$in.includes(r.status) &&
              !q.dealId.$nin.includes(r.dealId),
          )
          .slice(0, o.limit)
          .map((r) => ({ ...r }))
        return { status: StatusEnum.ok, data: { result, count: result.length } }
      },
    },
    dealsDb: {
      readData: async (q: any) => {
        const result =
          dealStatus !== null && q._id.$in.includes(DEAL_ID)
            ? [{ _id: DEAL_ID, status: dealStatus }]
            : []
        return { status: StatusEnum.ok, data: { result, count: result.length } }
      },
    },
    exchange: {
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
      async getOrder(q: any) {
        rec.lookups.push(q)
        return venue(q)
      },
    },
  })
  return { bot, rec }
}

describe('spec 308 — a never-confirmed order of a finished deal is asked about once', () => {
  before(function () {
    this.timeout(240000)
    Dca = createRequire(__filename)('./dcaHelper').default(Base as any)
  })

  for (const status of [DCADealStatusEnum.closed, DCADealStatusEnum.canceled]) {
    it(`§4.1 a '-1' NEW row on a ${status} deal: one lookup by client id, then retired as CANCELED`, async () => {
      const { bot, rec } = buildBot({ dealStatus: status })
      await bot.retireFinishedDealUnplacedOrders()
      expect(rec.lookups).to.have.length(1)
      expect(rec.lookups[0]).to.include({
        symbol: SYMBOL,
        newClientOrderId: CLIENT_ID,
        since: PLACED_AT,
      })
      expect(rec.persisted.map((p) => [p.clientOrderId, p.status])).to.deep.equal([
        [CLIENT_ID, 'CANCELED'],
      ])
      expect(rec.placed).to.deep.equal([])
      expect(rec.filled).to.deep.equal([])
      expect(bot.orders.size).to.equal(0)
    })
  }

  it('§4.1 a deal with no record at all counts as finished', async () => {
    const { bot, rec } = buildBot({ dealStatus: null })
    await bot.retireFinishedDealUnplacedOrders()
    expect(rec.lookups).to.have.length(1)
    expect(rec.persisted.map((p) => p.status)).to.deep.equal(['CANCELED'])
  })

  it('§4.1 the row held in memory is retired and dropped from the map', async () => {
    const { bot, rec } = buildBot()
    bot.setOrder(row(), false)
    await bot.retireFinishedDealUnplacedOrders()
    expect(rec.lookups).to.have.length(1)
    expect(rec.persisted.map((p) => p.status)).to.deep.equal(['CANCELED'])
    expect(bot.orders.size).to.equal(0)
  })

  it('§4.2 an open deal is not touched: no lookup, no write', async () => {
    for (const opts of [
      { dealStatus: DCADealStatusEnum.open },
      { dealStatus: DCADealStatusEnum.closed, held: true },
    ]) {
      const { bot, rec } = buildBot(opts)
      await bot.retireFinishedDealUnplacedOrders()
      expect(rec.lookups).to.deep.equal([])
      expect(rec.persisted).to.deep.equal([])
    }
  })

  it('§4.2 a row younger than the age floor, or with a real id, is not asked about', async () => {
    for (const r of [
      row({ transactTime: Date.now() - 1_000, updateTime: Date.now() - 1_000 }),
      row({ orderId: '1000000308' }),
    ]) {
      const { bot, rec } = buildBot({ rows: [r] })
      await bot.retireFinishedDealUnplacedOrders()
      expect(rec.lookups).to.deep.equal([])
      expect(rec.persisted).to.deep.equal([])
    }
  })

  it('§4.3 an order the venue holds is recorded with its real id and status, not booked into the deal', async () => {
    const { bot, rec } = buildBot({
      venue: (q) => ({
        status: StatusEnum.ok,
        reason: null,
        data: {
          ...row(),
          orderId: '7000000308',
          clientOrderId: q.newClientOrderId,
          status: 'FILLED',
          executedQty: '10',
          cummulativeQuoteQty: '12.5',
          updateTime: PLACED_AT + 60_000,
        },
      }),
    })
    await bot.retireFinishedDealUnplacedOrders()
    expect(rec.lookups).to.have.length(1)
    expect(rec.persisted).to.have.length(1)
    expect(rec.persisted[0]).to.include({
      clientOrderId: CLIENT_ID,
      orderId: '7000000308',
      status: 'FILLED',
      executedQty: '10',
    })
    expect(rec.filled).to.deep.equal([])
    expect(rec.placed).to.deep.equal([])
    expect(bot.orders.size).to.equal(0)
  })

  it('§4.4 an ambiguous answer leaves the row alone', async () => {
    const { bot, rec } = buildBot({
      venue: () => ({ status: StatusEnum.notok, reason: 'Unknown error', data: null }),
    })
    await bot.retireFinishedDealUnplacedOrders()
    expect(rec.persisted).to.deep.equal([])
    expect(rec.placed).to.deep.equal([])
    expect(bot.orders.size).to.equal(0)
  })

  it('§4.4 a deal read that fails judges nothing', async () => {
    const { bot, rec } = buildBot()
    bot.dealsDb = {
      readData: async () => ({ status: StatusEnum.notok, reason: 'db down', data: null }),
    }
    await bot.retireFinishedDealUnplacedOrders()
    expect(rec.lookups).to.deep.equal([])
    expect(rec.persisted).to.deep.equal([])
  })
})
