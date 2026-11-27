process.env.NODE_ENV = 'testing'

/**
 * Spec 294: a DCA safety order the market is far past is not moved to the
 * market and re-sent every cycle.
 *
 * Fixture: a long spot DCA deal on a Binance pair, start 1890.92, remaining
 * safety levels 531.36 / 357.58 / 166.43 (qty 0.01 / 0.02 / 0.04), market
 * 74.57. Binance refuses a limit buy far above the market with
 * `Filter failure: PERCENT_PRICE_BY_SIDE`; moved to the market, the 531.36
 * level is worth 0.75 USDT and is refused with `Filter failure: NOTIONAL`.
 * Ids are synthetic.
 *
 * Drives the REAL `sendOrderToExchange` on the DCA engine built off its
 * prototype (harness from `heldTakeProfitPerDeal.spec.ts`). Nothing opens a
 * connection.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'
import MainBot from '../main'
import RedisClient from '../../db/redis'
import { MathHelper } from '../../utils/math'
import { orderWaitingForPrice } from '../utils'
import { isMarketBeyondLadder } from './gridBreakpoints'
import { isHeldOutOfBandReason } from '../outOfBandRetry'

const START = 1890.92
const LEVELS: [number, number][] = [
  [531.36, 0.01],
  [357.58, 0.02],
  [166.43, 0.04],
]
const MIN_NOTIONAL = 5
const DEAL = 'deal-long'

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
let seq = 0
const safety = (price: number, qty: number, over: Row = {}): any => ({
  clientOrderId: `D-RO-test${seq++}`,
  symbol: 'XYZUSDT',
  dealId: DEAL,
  botId: 'bot',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: `${qty}`,
  executedQty: '0',
  price: `${price}`,
  origPrice: `${price}`,
  exchange: ExchangeEnum.binance,
  typeOrder: TypeOrderEnum.dealRegular,
  ...over,
})

const refuse = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

/**
 * Binance-like venue: a buy more than `band` above the market is refused on
 * the price band, an order worth under the minimum on value, else it rests.
 */
const binance =
  (market: { price: number }, band: number) =>
  async (req: any): Promise<any> => {
    if (+req.price > market.price * (1 + band)) {
      return refuse('Filter failure: PERCENT_PRICE_BY_SIDE')
    }
    if (+req.price * +req.quantity < MIN_NOTIONAL) {
      return refuse('Filter failure: NOTIONAL')
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        clientOrderId: req.newClientOrderId,
        orderId: `${Math.random()}`,
        symbol: 'XYZUSDT',
        side: req.side,
        type: 'LIMIT',
        status: 'NEW',
        origQty: `${req.quantity}`,
        executedQty: '0',
        price: `${req.price}`,
        cummulativeQuoteQty: '0',
        fills: [],
      },
    }
  }

const build = (DCA: any, market: { price: number }, band = 0.2) => {
  const bot: any = Object.create(DCA.prototype)
  const venueCalls: any[] = []
  const processErrors: any[][] = []
  const orderErrors: any[][] = []
  const rows = new Map<string, Row>()
  const venue = binance(market, band)
  Object.assign(bot, {
    botId: 'bot-past-ladder-1',
    userId: 'user-1',
    botType: 'dca',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    processErrors,
    orderErrors,
    rows,
    deals: new Map([
      [
        DEAL,
        {
          deal: { _id: DEAL, initialPrice: START, status: 'open' },
          initialOrders: LEVELS.map(([price, qty], i) => ({
            number: i,
            price,
            qty,
            side: OrderSideEnum.buy,
            newClientOrderId: `lvl-${i}`,
            type: TypeOrderEnum.dealRegular,
            dealId: DEAL,
          })),
          currentOrders: [],
          previousOrders: [],
        },
      ],
    ]),
    ordersDb: {
      readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
      createData: async (d: Row) => {
        rows.set(d.clientOrderId, { ...d })
        return { status: StatusEnum.ok, reason: null, data: { result: d } }
      },
      updateData: async (filter: Row, update: Row) => {
        const { $unset: _unset, ...set } = update
        const row = rows.get(filter.clientOrderId)
        if (row) rows.set(filter.clientOrderId, { ...row, ...set })
        return { status: StatusEnum.ok, data: null }
      },
      deleteManyData: async () => ({ status: StatusEnum.ok, data: null }),
    },
    data: {
      exchange: ExchangeEnum.binance,
      exchangeUUID: '',
      status: BotStatusEnum.open,
      paperContext: false,
      settings: { futures: false, name: 'past-ladder' },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return venue(req)
      },
      getOrder: async () => refuse('Order not found'),
      returnBad: () => (e: Error) => refuse(e.message),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    pushLogs: () => undefined,
    processError: async (...a: any[]) => {
      processErrors.push(a)
    },
    handleOrderErrors: async (...a: any[]) => {
      orderErrors.push(a)
    },
    updateData: () => undefined,
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
    getNotEnoughOrdersIdByOrder: () => 'k',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 2,
      baseAsset: { maxMarketAmount: 1e12, precision: 2, step: 0.01 },
      quoteAsset: { minAmount: MIN_NOTIONAL, precision: 8 },
    }),
    getLatestPrice: async () => market.price,
    replacesVenueCancel: () => false,
    shouldProceed: () => true,
    scheduleHeldOutOfBandPublish: () => undefined,
    publishHeldOutOfBand: () => undefined,
  })
  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: false,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 1,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

const notices = (bot: any) =>
  bot.processErrors.filter((a: any[]) => a[1] === orderWaitingForPrice)
const botErrors = (bot: any) =>
  bot.processErrors.filter((a: any[]) => a[3] === true)

describe('spec 294: DCA safety orders past the deal ladder', () => {
  let DCA: any
  before(function () {
    this.timeout(180000)
    DCA = createRequire(__filename)('../dcaHelper').default(MainBot)
  })
  beforeEach(() => {
    store.clear()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  describe('isMarketBeyondLadder (§1.4)', () => {
    it('a market far below a deep long ladder is beyond it', () => {
      expect(isMarketBeyondLadder(74.57, START, 166.43, true)).to.equal(true)
    })
    it('a market a few % past the deepest level is still inside', () => {
      expect(isMarketBeyondLadder(160, START, 166.43, true)).to.equal(false)
      expect(isMarketBeyondLadder(354, START, 166.43, true)).to.equal(false)
    })
    it('a shallow ladder keeps the spec 164 tolerance', () => {
      // start 100, deepest 90: tolerated end 89, floor 81, so 89 is the wall.
      expect(isMarketBeyondLadder(89.5, 100, 90, true)).to.equal(false)
      expect(isMarketBeyondLadder(88.9, 100, 90, true)).to.equal(true)
      // short ladder: start 100, deepest 110, tolerated 111.
      expect(isMarketBeyondLadder(110.5, 100, 110, false)).to.equal(false)
      expect(isMarketBeyondLadder(111.5, 100, 110, false)).to.equal(true)
    })
    it('an unknown ladder is never beyond', () => {
      expect(isMarketBeyondLadder(1, START, undefined, true)).to.equal(false)
      expect(isMarketBeyondLadder(0, START, 166.43, true)).to.equal(false)
    })
  })

  it('§1.1 a level the market is far past is not re-sent at the market, and the user is told once', async () => {
    const market = { price: 74.57 }
    const bot = build(DCA, market)
    const res = await bot.sendOrderToExchange(safety(531.36, 0.01), false)
    expect(
      bot.venueCalls.map((r: any) => +r.price),
      'only the level itself reached the venue',
    ).to.deep.equal([531.36])
    expect(res).to.equal(undefined)
    expect(notices(bot)).to.have.length(1)
    expect(notices(bot)[0][3], 'a warning, not a bot error').to.equal(false)
    expect(notices(bot)[0][5]).to.contain('531.36')
    expect(notices(bot)[0][5]).to.contain('166.43')
    expect(botErrors(bot)).to.deep.equal([])
    expect(bot.orderErrors, 'no bot error through handleOrderErrors').to.deep.equal([])
  })

  it('§1.2 later cycles are held without asking the venue or telling the user again', async () => {
    const market = { price: 74.57 }
    const bot = build(DCA, market)
    await bot.sendOrderToExchange(safety(531.36, 0.01), false)
    for (let i = 0; i < 3; i++) {
      const res = await bot.sendOrderToExchange(safety(531.36, 0.01), true)
      expect(isHeldOutOfBandReason(res), `cycle ${i}`).to.equal(true)
    }
    expect(bot.venueCalls).to.have.length(1)
    expect(notices(bot)).to.have.length(1)
    expect(botErrors(bot)).to.deep.equal([])
    expect(bot.orderErrors).to.deep.equal([])
  })

  it('§1.2 the level is sent again once the market is back inside the ladder', async () => {
    const market = { price: 74.57 }
    const bot = build(DCA, market)
    await bot.sendOrderToExchange(safety(531.36, 0.01), false)
    market.price = 540
    const res = await bot.sendOrderToExchange(safety(531.36, 0.01), false)
    expect(bot.venueCalls.map((r: any) => +r.price)).to.deep.equal([
      531.36, 531.36,
    ])
    expect(res?.status).to.equal('NEW')
  })

  it('not changing (spec 248): a level 1% past, inside the ladder, is still re-sent at the market', async () => {
    const market = { price: 354 }
    const bot = build(DCA, market, 0.005)
    const res = await bot.sendOrderToExchange(safety(357.58, 0.02), false)
    expect(bot.venueCalls.map((r: any) => +r.price)).to.deep.equal([
      357.58, 354,
    ])
    expect(res?.status).to.equal('NEW')
    expect(notices(bot)).to.deep.equal([])
  })

  it('§1.3 a re-priced level refused below the minimum value is held and told once, not re-sent each cycle', async () => {
    // Inside the ladder (deepest 166.43, wall 149.79): re-priced to 160 the
    // 0.031 level is worth 4.96 USDT, under the 5 USDT minimum (5.16 at 166.43).
    const market = { price: 160 }
    const bot = build(DCA, market, 0.005)
    await bot.sendOrderToExchange(safety(166.43, 0.031), false)
    expect(bot.venueCalls.map((r: any) => +r.price)).to.deep.equal([
      166.43, 160,
    ])
    expect(notices(bot)).to.have.length(1)
    expect(notices(bot)[0][3]).to.equal(false)
    expect(botErrors(bot)).to.deep.equal([])
    expect(bot.orderErrors).to.deep.equal([])
    for (let i = 0; i < 3; i++) {
      await bot.sendOrderToExchange(safety(166.43, 0.031), false)
    }
    expect(bot.venueCalls, 'later cycles are held').to.have.length(2)
    expect(notices(bot)).to.have.length(1)
    expect(bot.orderErrors).to.deep.equal([])
    // Back at the level: it rests at its own price.
    market.price = 166.5
    const res = await bot.sendOrderToExchange(safety(166.43, 0.031), false)
    expect(bot.venueCalls.map((r: any) => +r.price).slice(2)).to.deep.equal([
      166.43,
    ])
    expect(res?.status).to.equal('NEW')
  })
})
