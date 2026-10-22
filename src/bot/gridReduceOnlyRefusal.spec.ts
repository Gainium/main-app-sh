process.env.NODE_ENV = 'testing'

/**
 * Spec `186`. A futures grid level the venue refuses as un-reducible must not
 * be re-sent on every grid rebuild.
 *
 * Binance USD-M, long grid on IOSTUSDT: the reduce-only level
 * `SELL LIMIT 21780 @ 0.0011583` was refused with -2022 "ReduceOnly Order is
 * rejected" 420 times in ~6h, once per rebuild (every fill re-runs
 * `limitOrders()`), each time under a fresh `GRID-RO` client id, while the
 * bot's other levels kept filling.
 *
 * Drives the REAL `sendOrderToExchange` (harness from
 * `riskTierRefusal.spec.ts`) and the REAL `RetryBackoff` against a Map-backed
 * fake Redis. Nothing opens a connection.
 *
 * Run: `npm test` (mocha) from core/, or just this file:
 *   NODE_ENV=testing npx mocha -r ts-node/register src/bot/gridReduceOnlyRefusal.spec.ts
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import {
  StatusEnum,
  ExchangeEnum,
  BotMarginTypeEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import RedisClient from '../db/redis'
import { isPositionAlreadyClosedReason } from './positionAlreadyClosed'
import { MathHelper } from '../utils/math'

const REDUCE_ONLY_REJECTED = 'ReduceOnly Order is rejected.'

type Row = Record<string, any>

// --- fake Redis with TTLs and a rewindable clock (see retryBackoff.memory.spec)
type Cell = { v: string; expiresAt: number }
const store = new Map<string, Cell>()
const fakeRedis = {
  get: async (k: string) => {
    const c = store.get(k)
    if (!c) return null
    if (c.expiresAt <= Date.now()) {
      store.delete(k)
      return null
    }
    return c.v
  },
  set: async (k: string, v: string, ttlSec?: number) => {
    store.set(k, {
      v,
      expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : Number.MAX_SAFE_INTEGER,
    })
  },
  del: async (k: string) => {
    store.delete(k)
  },
}
/** Move every stored window `ms` into the past. */
const elapse = (ms: number) => {
  for (const [k, c] of [...store]) {
    const expiresAt = c.expiresAt - ms
    if (expiresAt <= Date.now()) {
      store.delete(k)
      continue
    }
    const state = JSON.parse(c.v)
    store.set(k, {
      v: JSON.stringify({ ...state, until: state.until - ms }),
      expiresAt,
    })
  }
}

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
/** Each rebuild re-sends the level under a fresh client id, as on prod. */
const makeOrder = (over: Row = {}) => ({
  clientOrderId: `x-test${seq++}GRID-RO-level`,
  symbol: 'IOSTUSDT',
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '21780',
  price: '0.0011583',
  origPrice: '0.0011583',
  exchange: ExchangeEnum.binanceUsdm,
  typeOrder: TypeOrderEnum.regular,
  reduceOnly: true,
  positionSide: 'BOTH',
  ...over,
})

type Venue = (req: any) => Promise<any>
const refuse =
  (reason: string): Venue =>
  async () => ({ status: StatusEnum.notok, reason, data: null })
const refuseReduceOnly = refuse(REDUCE_ONLY_REJECTED)
const accept: Venue = async (req: any) => ({
  status: StatusEnum.ok,
  reason: null,
  data: {
    ...makeOrder(),
    clientOrderId: req.newClientOrderId,
    orderId: `${Math.random()}`,
    status: 'NEW',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    fills: [],
  },
})

const makeBot = (venue: Venue, opts: { futures?: boolean } = {}) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const orderErrors: string[] = []
  let answer = venue
  Object.assign(bot, {
    botId: '6aa2c22b0000000000000001',
    userId: '6662f6170000000000ec8f00',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb: makeOrdersDb(),
    venueCalls,
    orderErrors,
    setVenue: (v: Venue) => {
      answer = v
    },
    data: {
      exchange: ExchangeEnum.binanceUsdm,
      // Empty: the auth gate is skipped so this gate is isolated.
      exchangeUUID: '',
      paperContext: false,
      settings: {
        leverage: 5,
        marginType: BotMarginTypeEnum.cross,
        futures: true,
      },
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
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => 'IOSTUSDT-SELL',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.0002, taker: 0.00055 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 7,
      baseAsset: { maxMarketAmount: 1e12, precision: 0 },
      quoteAsset: { minAmount: 5, precision: 2 },
    }),
  })
  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: opts.futures ?? true,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 5,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

describe('spec 186: a grid level refused as un-reducible is not re-sent per rebuild', () => {
  beforeEach(() => {
    store.clear()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  it('§3.2 matches the Binance -2022 text via the shared reason list', () => {
    expect(isPositionAlreadyClosedReason(REDUCE_ONLY_REJECTED)).to.equal(true)
    expect(isPositionAlreadyClosedReason('Insufficient balance')).to.equal(
      false,
    )
  })

  it('§4.1 sends a rebuilt level to the venue once, not once per rebuild', async () => {
    const bot = makeBot(refuseReduceOnly)
    // Six rebuilds, as six fills elsewhere on the grid would trigger.
    for (let i = 0; i < 6; i++) {
      const res = await bot.sendOrderToExchange(makeOrder(), true)
      expect(res).to.equal(REDUCE_ONLY_REJECTED)
    }
    expect(bot.venueCalls).to.have.length(1)
  })

  it('§4.2 reports the refusal once and leaves no rows for suppressed attempts', async () => {
    const bot = makeBot(refuseReduceOnly)
    const sent = [makeOrder(), makeOrder(), makeOrder()]
    for (const o of sent) {
      await bot.sendOrderToExchange(o)
    }
    expect(bot.orderErrors).to.deep.equal([REDUCE_ONLY_REJECTED])
    expect(bot.ordersDb.rows.get(sent[0].clientOrderId)?.status).to.equal(
      'CANCELED',
    )
    expect(bot.ordersDb.rows.has(sent[1].clientOrderId)).to.equal(false)
    expect(bot.ordersDb.rows.has(sent[2].clientOrderId)).to.equal(false)
  })

  it('§4.3 re-probes after the window, backs off further, and an acceptance clears it', async () => {
    const bot = makeBot(refuseReduceOnly)
    await bot.sendOrderToExchange(makeOrder())
    elapse(59_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls, 'inside the first minute').to.have.length(1)
    elapse(2_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls, 'first window over').to.have.length(2)
    elapse(90_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls, 'second window is two minutes').to.have.length(2)
    elapse(31_000)
    bot.setVenue(accept)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(3)
    expect(store.size, 'acceptance clears the level').to.equal(0)
  })

  it('§4.4 a different price or side still reaches the venue', async () => {
    const bot = makeBot(refuseReduceOnly)
    await bot.sendOrderToExchange(makeOrder())
    bot.setVenue(accept)
    await bot.sendOrderToExchange(makeOrder({ price: '0.0010641' }))
    await bot.sendOrderToExchange(
      makeOrder({ side: 'BUY', reduceOnly: false, price: '0.0009578' }),
    )
    expect(bot.venueCalls).to.have.length(3)
  })

  it('§4.5 other refusals, non-reduce-only, stop orders, DCA closes and spot never open a window', async () => {
    const other = makeBot(refuse('Insufficient balance'))
    await other.sendOrderToExchange(makeOrder())
    await other.sendOrderToExchange(makeOrder())
    expect(other.venueCalls, 'other reason').to.have.length(2)

    const notReduce = makeBot(refuseReduceOnly)
    await notReduce.sendOrderToExchange(makeOrder({ reduceOnly: false }))
    await notReduce.sendOrderToExchange(makeOrder({ reduceOnly: false }))
    expect(notReduce.venueCalls, 'not reduce-only').to.have.length(2)

    const stop = makeBot(refuseReduceOnly)
    await stop.sendOrderToExchange(makeOrder({ typeOrder: TypeOrderEnum.stop }))
    await stop.sendOrderToExchange(makeOrder({ typeOrder: TypeOrderEnum.stop }))
    expect(stop.venueCalls, 'grid stop').to.have.length(2)

    const dca = makeBot(refuseReduceOnly)
    const tp = { typeOrder: TypeOrderEnum.dealTP, dealId: 'd1' }
    await dca.sendOrderToExchange(makeOrder(tp))
    await dca.sendOrderToExchange(makeOrder(tp))
    expect(dca.venueCalls, 'DCA close').to.have.length(2)

    const spot = makeBot(refuseReduceOnly, { futures: false })
    await spot.sendOrderToExchange(makeOrder())
    await spot.sendOrderToExchange(makeOrder())
    expect(spot.venueCalls, 'spot').to.have.length(2)
  })

  it('§4.6 fails open when Redis is unavailable', async () => {
    ;(RedisClient as any).getInstance = async () => {
      throw new Error('redis down')
    }
    const bot = makeBot(refuseReduceOnly)
    await bot.sendOrderToExchange(makeOrder())
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(2)
  })
})
