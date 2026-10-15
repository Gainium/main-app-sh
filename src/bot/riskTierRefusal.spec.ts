process.env.NODE_ENV = 'testing'

/**
 * A safety order the venue refuses because the contract's risk tier is full
 * must not be re-sent on every ladder rebuild.
 *
 * Bybit linear, combo bot: the deal's DCA level `BUY LIMIT 77533 @ 0.02841` was
 * refused with "The combined value of positions and orders has reached the
 * limit of the current risk tier…" over and over — re-sent after each minigrid
 * fill, a refusal and a bot error every second or two — while the deal's small
 * minigrid orders on the same contract kept being accepted.
 *
 * Drives the REAL `sendOrderToExchange` (harness from
 * `strandedLocalRefusal.spec.ts`) and the REAL `RiskTierGuard` /
 * `RetryBackoff` against a Map-backed fake Redis. Nothing opens a connection.
 *
 * Run: `npm test` (mocha) from core/.
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
import { getErrorSubType, riskTierLimit } from './utils'
import { isRiskTierRefusal } from './riskTierGuard'
import { MathHelper } from '../utils/math'

const RISK_TIER_REASON =
  'The combined value of positions and orders has reached the limit of the current risk tier. Only reduce-only or close-on-trigger orders are allowed. Please adjust your leverage to 4.7 or below to increase the limit. Or manually increase the risk limit tier.'

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

const DEAL = '6ad05f3a000000000000a95c'
let seq = 0
/** Each rebuild re-sends the level under a fresh client id, as on prod. */
const makeOrder = (over: Row = {}) => ({
  clientOrderId: `CMB-RO-test${seq++}`,
  symbol: 'PUFFERUSDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '77533',
  price: '0.02841',
  origPrice: '0.02841',
  exchange: ExchangeEnum.bybitUsdm,
  typeOrder: TypeOrderEnum.dealRegular,
  dealId: DEAL,
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

type Venue = (req: any) => Promise<any>
const refuseRiskTier: Venue = async () => ({
  status: StatusEnum.notok,
  reason: RISK_TIER_REASON,
  data: null,
})
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
    botId: '6ac756a30000000000e516aa',
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
      exchange: ExchangeEnum.bybitUsdm,
      // Empty: the auth gate is skipped so the risk-tier one is isolated.
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
    getNotEnoughOrdersIdByOrder: () => 'PUFFERUSDT-BUY',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.0002, taker: 0.00055 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 5,
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

describe('risk-tier refusal of a safety order is not re-sent in a loop', () => {
  beforeEach(() => {
    store.clear()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  it('classifies the Bybit text as the Risk tier limit subType without DB rules', () => {
    expect(getErrorSubType(RISK_TIER_REASON)).to.equal(riskTierLimit)
    expect(isRiskTierRefusal(RISK_TIER_REASON)).to.equal(true)
    expect(isRiskTierRefusal('Insufficient balance')).to.equal(false)
  })

  it('sends a rebuilt level to the venue once, not once per rebuild', async () => {
    const bot = makeBot(refuseRiskTier)
    // Six rebuilds in a few seconds, as six minigrid fills would trigger.
    for (let i = 0; i < 6; i++) {
      const res = await bot.sendOrderToExchange(makeOrder(), true)
      // Every caller still gets the venue's refusal back.
      expect(res).to.equal(RISK_TIER_REASON)
    }
    expect(bot.venueCalls).to.have.length(1)
  })

  it('reports the refusal once and leaves no rows for suppressed attempts', async () => {
    const bot = makeBot(refuseRiskTier)
    const sent = [makeOrder(), makeOrder(), makeOrder()]
    for (const o of sent) {
      await bot.sendOrderToExchange(o)
    }
    expect(bot.orderErrors).to.deep.equal([RISK_TIER_REASON])
    // The real refusal keeps its CANCELED audit row; the suppressed ones never
    // reached the venue and leave nothing behind.
    expect(bot.ordersDb.rows.get(sent[0].clientOrderId)?.status).to.equal(
      'CANCELED',
    )
    expect(bot.ordersDb.rows.has(sent[1].clientOrderId)).to.equal(false)
    expect(bot.ordersDb.rows.has(sent[2].clientOrderId)).to.equal(false)
  })

  it('never holds back the minigrid or a reduce-only order on the same contract', async () => {
    const bot = makeBot(refuseRiskTier)
    await bot.sendOrderToExchange(makeOrder())
    bot.setVenue(accept)
    await bot.sendOrderToExchange(
      makeOrder({
        typeOrder: TypeOrderEnum.dealGrid,
        origQty: '1170',
        price: '0.02841',
      }),
    )
    await bot.sendOrderToExchange(
      makeOrder({ side: 'SELL', reduceOnly: true, price: '0.02841' }),
    )
    expect(bot.venueCalls).to.have.length(3)
  })

  it('lets a different level, a new deal or a leverage change reach the venue', async () => {
    const bot = makeBot(refuseRiskTier)
    await bot.sendOrderToExchange(makeOrder())
    await bot.sendOrderToExchange(makeOrder({ price: '0.02644' }))
    await bot.sendOrderToExchange(
      makeOrder({ dealId: '6ad06156000000000000bb40' }),
    )
    bot.data.settings.leverage = 4
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(4)
  })

  it('re-probes after the window and backs off further on a repeat refusal', async () => {
    const bot = makeBot(refuseRiskTier)
    await bot.sendOrderToExchange(makeOrder())
    elapse(59_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls, 'still inside the first minute').to.have.length(1)
    elapse(2_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls, 'first window over').to.have.length(2)
    // The second refusal doubled the window to two minutes.
    elapse(90_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(2)
    elapse(31_000)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(3)
  })

  it('an accepted level drops the window so the next refusal starts small', async () => {
    const bot = makeBot(refuseRiskTier)
    await bot.sendOrderToExchange(makeOrder())
    elapse(61_000)
    bot.setVenue(accept)
    await bot.sendOrderToExchange(makeOrder())
    expect(store.size, 'acceptance clears the level').to.equal(0)
  })

  it('does not open a window for other refusals or for spot bots', async () => {
    const other = makeBot(async () => ({
      status: StatusEnum.notok,
      reason: 'Insufficient balance',
      data: null,
    }))
    await other.sendOrderToExchange(makeOrder())
    await other.sendOrderToExchange(makeOrder())
    expect(other.venueCalls).to.have.length(2)

    const spot = makeBot(refuseRiskTier, { futures: false })
    await spot.sendOrderToExchange(makeOrder())
    await spot.sendOrderToExchange(makeOrder())
    expect(spot.venueCalls).to.have.length(2)
  })
})
