process.env.NODE_ENV = 'testing'

/**
 * Spec 264: once a venue has named its price band for a pair (spec 258), an
 * order still outside it is held without asking the venue again, and the
 * deal's held orders are published for the chart.
 *
 * Fixture (synthetic ids): a Combo deal's base grid on a Bitget tokenized-stock
 * pair. Five sells sit 576.66–621.88 while the price is near 385. On prod each
 * bot reload rebuilt the grid and re-sent all five, refused every time (one deal
 * collected 410 refused sells in two weeks).
 *
 * Drives the REAL `sendOrderToExchange` (harness shape from
 * `gridReduceOnlyRefusal.spec.ts`) with a Map-backed fake Redis.
 *
 * Run: NODE_ENV=testing npx mocha -r ts-node/register src/bot/outOfBandHold.spec.ts
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import {
  StatusEnum,
  ExchangeEnum,
  TypeOrderEnum,
  BotStatusEnum,
} from '../../types'
import MainBot from './main'
import RedisClient from '../db/redis'
import { MathHelper } from '../utils/math'
import { orderPrice } from './utils'
import {
  VenuePriceBand,
  holdOutsideKnownBand,
  sameHeldOrders,
} from './outOfBandRetry'

const BAND_20 =
  'the trade price of rxyz/usdt cannot exceed the current price, 20%.'
const LEVELS = [576.66, 587.96, 599.27, 610.57, 621.88]

const store = new Map<string, string>()
const fakeRedis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v)
  },
  del: async (k: string) => {
    store.delete(k)
  },
}

type Row = Record<string, any>
const makeOrdersDb = () => {
  const rows = new Map<string, Row>()
  return {
    rows,
    createData: async (doc: Row) => {
      rows.set(doc.clientOrderId, { ...doc })
      return { status: StatusEnum.ok, reason: null, data: { result: doc } }
    },
    updateData: async (filter: Row, update: Row) => {
      const { $unset: _unset, ...set } = update
      const row = rows.get(filter.clientOrderId)
      if (row) rows.set(filter.clientOrderId, { ...row, ...set })
      return { status: StatusEnum.ok, reason: null, data: { result: null } }
    },
    deleteManyData: async (filter: Row) => {
      rows.delete(filter.clientOrderId)
      return { status: StatusEnum.ok, reason: 'Deleted', data: null }
    },
  }
}

let seq = 0
const sell = (price: number): Row => ({
  clientOrderId: `CMB-GR-t${seq++}`,
  symbol: 'RXYZUSDT',
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '0.0351',
  price: `${price}`,
  origPrice: `${price}`,
  exchange: ExchangeEnum.bitget,
  typeOrder: TypeOrderEnum.dealGrid,
  dealId: 'deal-a',
  minigridId: 'grid-base',
})

type Venue = (req: any) => Promise<any>
const refuseBand: Venue = async () => ({
  status: StatusEnum.notok,
  reason: BAND_20,
  data: null,
})
const accept: Venue = async (req: any) => ({
  status: StatusEnum.ok,
  reason: null,
  data: {
    ...sell(+req.price),
    clientOrderId: req.newClientOrderId,
    orderId: `${Math.random()}`,
    status: 'NEW',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    fills: [],
  },
})

const makeBot = (venue: Venue, market: { price: number }) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const orderErrors: string[] = []
  const published: Row[][] = []
  let answer = venue
  Object.assign(bot, {
    botId: '6aa2c22b0000000000000002',
    userId: '6662f6170000000000ec8f00',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb: makeOrdersDb(),
    venueCalls,
    orderErrors,
    published,
    setVenue: (v: Venue) => {
      answer = v
    },
    data: {
      exchange: ExchangeEnum.bitget,
      exchangeUUID: '',
      status: BotStatusEnum.open,
      paperContext: false,
      settings: { futures: false },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return answer(req)
      },
      getOrder: async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found',
        data: null,
      }),
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: (reason: string) => {
      orderErrors.push(reason)
    },
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: (r: string) =>
      /cannot exceed/.test(r) ? orderPrice : null,
    getNotEnoughOrdersIdByOrder: () => 'RXYZUSDT-SELL',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 2,
      baseAsset: { maxMarketAmount: 1e12, precision: 4 },
      quoteAsset: { minAmount: 1, precision: 2 },
    }),
    getLatestPrice: async () => market.price,
    replacesVenueCancel: (o: any) => o.typeOrder === TypeOrderEnum.dealGrid,
    shouldProceed: () => true,
    // the debounce, run at once
    scheduleHeldOutOfBandPublish() {
      bot.flushHeldOutOfBandPublish()
    },
    publishHeldOutOfBand(_dealId: string, held: Row[]) {
      published.push(held)
    },
    async replaceVenueCanceled(o: any): Promise<boolean> {
      const res: unknown = await bot.sendOrderToExchange(
        { ...o, clientOrderId: `${o.clientOrderId}-again` },
        true,
      )
      return typeof res !== 'string'
    },
  })
  for (const [name, value] of Object.entries({
    isBitget: true,
    futures: false,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('spec 264: orders outside a known price band are held, not re-sent', () => {
  beforeEach(() => {
    store.clear()
    VenuePriceBand.resetCache()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  it('helpers: hold only an order ahead of the market and outside the band', () => {
    expect(holdOutsideKnownBand('SELL', 576.66, 385, 0.2)).to.equal(true)
    expect(holdOutsideKnownBand('SELL', 450, 385, 0.2)).to.equal(false)
    expect(holdOutsideKnownBand('BUY', 300, 385, 0.2)).to.equal(true)
    expect(holdOutsideKnownBand('SELL', 576.66, 385, null)).to.equal(false)
    expect(holdOutsideKnownBand('SELL', 380, 385, 0.2)).to.equal(false)
  })

  it('helpers: the held set compares without its timestamps', () => {
    const a = {
      side: 'SELL',
      price: 1,
      qty: 2,
      typeOrder: 'dealGrid',
      band: 0.2,
      since: 1,
    }
    expect(sameHeldOrders([a], [{ ...a, since: 9 }])).to.equal(true)
    expect(sameHeldOrders([a], [])).to.equal(false)
    expect(sameHeldOrders(undefined, [])).to.equal(true)
  })

  it('one venue refusal, then a reload rebuilds the grid without asking the venue', async () => {
    const market = { price: 385 }
    const first = makeBot(refuseBand, market)
    const res = await first.sendOrderToExchange(sell(LEVELS[0]), true)
    expect(res).to.equal(BAND_20)
    expect(first.venueCalls).to.have.length(1)
    expect(store.get('outOfBandBand:bitget:RXYZUSDT')).to.equal('0.2')

    // a worker restart: fresh memory, same Redis
    VenuePriceBand.resetCache()
    const reloaded = makeBot(refuseBand, market)
    const sent = LEVELS.map(sell)
    for (const o of sent) {
      const r = await reloaded.sendOrderToExchange(o, true)
      expect(r).to.match(/^Held: /)
    }
    expect(reloaded.venueCalls).to.have.length(0)
    expect(reloaded.orderErrors).to.have.length(0)
    // no refused rows left behind for orders the venue never saw
    expect(reloaded.ordersDb.rows.size).to.equal(0)
    expect(reloaded.outOfBandOrders.size).to.equal(5)
    const last = reloaded.published[reloaded.published.length - 1]
    expect(last.map((h: Row) => h.price)).to.deep.equal([...LEVELS].reverse())
  })

  it('the held orders are placed and unpublished once the price comes near', async () => {
    const market = { price: 385 }
    await makeBot(refuseBand, market).sendOrderToExchange(sell(LEVELS[0]), true)
    const bot = makeBot(accept, market)
    for (const l of LEVELS) {
      await bot.sendOrderToExchange(sell(l), true)
    }
    expect(bot.venueCalls).to.have.length(0)
    // 576.66 and 587.96 are within 18% of 500; the rest are not
    market.price = 500
    bot.checkOutOfBandOrders('RXYZUSDT', 500)
    await settle()
    await settle()
    expect(bot.venueCalls.map((c: any) => +c.price)).to.deep.equal([
      576.66, 587.96,
    ])
    const last = bot.published[bot.published.length - 1]
    expect(last.map((h: Row) => h.price)).to.deep.equal([
      621.88, 610.57, 599.27,
    ])
  })

  it('an order inside the band goes to the venue as before', async () => {
    const market = { price: 385 }
    await makeBot(refuseBand, market).sendOrderToExchange(sell(LEVELS[0]), true)
    const bot = makeBot(accept, market)
    await bot.sendOrderToExchange(sell(420), true)
    expect(bot.venueCalls).to.have.length(1)
  })
})
