process.env.NODE_ENV = 'testing'

/**
 * A non-opening order (a grid level, a DCA safety order) that the Binance
 * Futures Quantitative Rules pre-send gate soft-skips, and whose deferred
 * retry is then given up on, must not stay behind as a resting order.
 *
 * `sendOrderToExchange` writes the order ahead (map + DB row, `NEW` /
 * orderId `'-1'`) before the cooldown gate runs. When the gate skips it and
 * the retry decides not to re-send (the symbol is too close to level 2), the
 * placeholder used to stay: the engine believed the level was resting, never
 * placed it again, and the row stayed an open order the venue had never seen.
 *
 * Drives the REAL `sendOrderToExchange` pre-send path off the prototype (no
 * Mongo, Redis, venue or stack); `QuantRulesGuard` is stubbed at its statics.
 * Harness shape copied from `nanOrderRefusal.spec.ts`.
 *
 * The decision not to RE-SEND during a restriction is deliberately unchanged
 * and asserted here: the venue is never called.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { QuantRulesGuard, LEVEL2_VIOLATIONS } from './quantRulesGuard'

type Row = Record<string, any>

const makeOrdersDb = () => {
  const rows = new Map<string, Row>()
  const matches = (row: Row, filter: Row): boolean =>
    Object.entries(filter).every(([k, v]) => row[k] === v)
  return {
    rows,
    createData: async (doc: Row) => {
      rows.set(doc.clientOrderId, { ...doc })
      return { status: StatusEnum.ok, reason: null, data: { result: doc } }
    },
    updateData: async (filter: Row, update: Row) => {
      const { $unset: _u, ...set } = update
      for (const [key, row] of rows) {
        if (matches(row, { clientOrderId: filter.clientOrderId })) {
          rows.set(key, { ...row, ...set })
        }
      }
      return { status: StatusEnum.ok, reason: null, data: { result: null } }
    },
    deleteManyData: async (filter: Row) => {
      let deleted = 0
      for (const [key, row] of [...rows]) {
        if (!matches(row, filter)) continue
        rows.delete(key)
        deleted++
      }
      return { status: StatusEnum.ok, reason: `Deleted: ${deleted}`, data: null }
    },
  }
}

const GRID_ID = 'GRID-LISTAUSDT-BUY-0001'

const makeOrder = (over: Row = {}) => ({
  clientOrderId: GRID_ID,
  symbol: 'LISTAUSDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '100',
  price: '0.25',
  origPrice: '0.25',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  exchange: ExchangeEnum.binanceUsdm,
  typeOrder: 'regular',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeBot = () => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const passes: number[] = []
  const released: any[] = []
  Object.assign(bot, {
    botId: '6b094101a1cb5bf0629d0000',
    userId: 'u1',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    quantRulesRetryTimers: new Map(),
    quantRulesRetryAttempts: new Map(),
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    passes,
    released,
    data: {
      exchange: ExchangeEnum.binanceUsdm,
      // Empty: skips AuthFailureGuard. QuantRulesGuard is stubbed below.
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return { status: StatusEnum.notok, reason: 'not expected', data: null }
      },
      getOrder: async () => ({ status: StatusEnum.notok, reason: 'x', data: null }),
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
    handleOrderErrors: () => undefined,
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    releaseBlockedDeal: async (o: any) => {
      released.push(o)
    },
    // The grid engine's rule (helper.ts): a regular grid level is placed
    // again by level.
    replacesVenueCancel: (o: any) => o.typeOrder === 'regular',
    // The @RunWithDelay pass; record the wait instead of arming a timer.
    scheduleMarketClosedRetry: (_b: string, delay: number) => {
      passes.push(delay)
    },
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => 'LISTAUSDT-BUY',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.0002, taker: 0.0005 }),
    getExchangeInfo: async () => ({
      pair: 'LISTAUSDT',
      priceAssetPrecision: 4,
      baseAsset: { maxMarketAmount: 1e12, precision: 0, step: 1, minAmount: 1 },
      quoteAsset: { minAmount: 1, precision: 4 },
    }),
  })
  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: true,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: true,
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

/** `armQuantRulesRetry` is fire-and-forget from the send path. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

const COOLDOWN_MS = 10 * 60_000

describe('Quantitative Rules give-up retires the skipped order', () => {
  const realCheck = QuantRulesGuard.check
  const realCount = QuantRulesGuard.violationCount24h
  let violations = LEVEL2_VIOLATIONS - 2

  beforeEach(() => {
    violations = LEVEL2_VIOLATIONS - 2
    ;(QuantRulesGuard as any).check = async () => ({
      restricted: true,
      until: Date.now() + COOLDOWN_MS,
      level: 1,
      scope: 'symbol',
    })
    ;(QuantRulesGuard as any).violationCount24h = async () => violations
  })
  afterEach(() => {
    ;(QuantRulesGuard as any).check = realCheck
    ;(QuantRulesGuard as any).violationCount24h = realCount
  })

  it('a given-up grid level leaves no NEW / -1 row and no in-memory order', async () => {
    const bot = makeBot()
    await bot.sendOrderToExchange(makeOrder())
    await settle()

    expect(bot.venueCalls, 'never reach the venue while restricted').to.have.length(0)
    expect(bot.orders.has(GRID_ID), 'engine must not believe it rests').to.equal(false)
    expect(bot.ordersDb.rows.get(GRID_ID), 'no never-sent open row').to.equal(undefined)
  })

  it('keeps the level for a re-place pass no earlier than the cooldown end', async () => {
    const bot = makeBot()
    const before = Date.now()
    await bot.sendOrderToExchange(makeOrder())
    await settle()

    expect([...(bot.marketClosedOrders?.values() ?? [])].map((o: any) => o.clientOrderId)).to.deep.equal([GRID_ID])
    expect(bot.passes.length).to.be.greaterThan(0)
    // The last call wins (@RunWithDelay), so the latest wait is the one used.
    const wait = bot.passes[bot.passes.length - 1]
    expect(wait).to.be.at.least(COOLDOWN_MS - (Date.now() - before))
  })

  it('while a retry is armed instead, the row stays for that retry to reuse', async () => {
    violations = 0
    const bot = makeBot()
    await bot.sendOrderToExchange(makeOrder())
    await settle()

    expect(bot.quantRulesRetryTimers.has(GRID_ID)).to.equal(true)
    expect(bot.orders.has(GRID_ID)).to.equal(true)
    expect(bot.ordersDb.rows.get(GRID_ID)?.orderId).to.equal('-1')
    for (const t of bot.quantRulesRetryTimers.values()) clearTimeout(t)
  })

  it('an add-funds order is retired but not queued to be placed again', async () => {
    violations = 0
    const bot = makeBot()
    // addFunds orders are `dealRegular`, which the grid rule does not re-place.
    await bot.sendOrderToExchange(
      makeOrder({ typeOrder: 'dealRegular', dealId: 'd1', addFundsId: 'af1' }),
    )
    await settle()

    expect(bot.venueCalls).to.have.length(0)
    expect(bot.ordersDb.rows.get(GRID_ID)).to.equal(undefined)
    expect(bot.marketClosedOrders?.size ?? 0).to.equal(0)
  })

  it('a deal-opening order keeps its own path (cancel + release)', async () => {
    const bot = makeBot()
    await bot.sendOrderToExchange(makeOrder({ typeOrder: 'dealStart', dealId: 'd1' }))
    await settle()

    expect(bot.released).to.have.length(1)
    expect(bot.ordersDb.rows.get(GRID_ID)?.status).to.equal('CANCELED')
    expect(bot.marketClosedOrders?.size ?? 0).to.equal(0)
  })

  it('an order the venue has acknowledged is never deleted', async () => {
    const bot = makeBot()
    const acked = makeOrder({ orderId: '987654321' })
    bot.orders.set(GRID_ID, acked)
    bot.ordersDb.rows.set(GRID_ID, { ...acked })
    await bot.scheduleQuantRulesRetry(acked, false, {
      until: Date.now() + COOLDOWN_MS,
      level: 1,
      scope: 'symbol',
    })
    await settle()

    expect(bot.orders.has(GRID_ID)).to.equal(true)
    expect(bot.ordersDb.rows.get(GRID_ID)?.orderId).to.equal('987654321')
  })
})
