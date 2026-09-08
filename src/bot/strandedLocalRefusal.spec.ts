process.env.NODE_ENV = 'testing'

/**
 * Regression tests for bug #673 — an order refused by a LOCAL guard keeps the
 * `status: 'NEW'`, `orderId: '-1'` row `sendOrderToExchange` wrote before the
 * guard ran, and the dashboard shows it to the user as an open order forever.
 *
 * `sendOrderToExchange` persists the order at `count === 0` (`main.ts` ~:6870)
 * as a write-ahead record, BEFORE the not-enough-balance / compliance / auth
 * short-circuits are consulted. Commit `3f7ae42` then gated the terminal
 * `updateOrderOnDb({...order, status: 'CANCELED'})` behind
 * `!notEnoughBalanceShortCircuit && !complianceShortCircuit && !authShortCircuit`
 * on the premise that that write was what CREATED the row — it was not, it was
 * what RETIRED it. Skipping it stranded the pre-written row at `NEW`.
 *
 * Prod, measured read-only 2026-09-05: rows still sitting at `NEW`/`-1`, by
 * creation window — June 1, July 4, Aug 1-6 **0**, then 82,112 in the seven
 * hours after the `3f7ae42` rollout at 2026-08-06T07:37Z and ~130k/day since,
 * for a live total of **3,973,560** (3,658,885 of them non-paper, over 484 bots
 * and 88 users) against only 32,287 genuinely open orders.
 *
 * Enforces specs/013 §4.1, §4.2, §4.3 and §4.4.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import ComplianceGuard from './complianceGuard'
import { MathHelper } from '../utils/math'

const CLIENT_ID = 'GRID-RO-LSPRHVhH667Jmh1Tn6rDZqwoE8o'
/** The exact Kraken text behind the 39 reported rows. */
const COMPLIANCE_REASON =
  'EAccount:Invalid permissions:USDT trading restricted for DE.'

type Row = Record<string, any>

/**
 * A stand-in for the `orders` DAO backed by a Map, so the REAL
 * `saveOrderToDb` / `updateOrderOnDb` / `deleteOrderFromDb` run against it and
 * the assertions are about persisted STATE, not about which method was called.
 */
const makeOrdersDb = () => {
  const rows = new Map<string, Row>()
  const matches = (row: Row, filter: Row): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$and') {
        if (!(v as Row[]).every((sub) => matches(row, sub))) return false
        continue
      }
      if (v && typeof v === 'object' && '$ne' in v) {
        if (row[k] === (v as Row).$ne) return false
        continue
      }
      if (row[k] !== v) return false
    }
    return true
  }
  return {
    rows,
    createData: async (doc: Row) => {
      rows.set(doc.clientOrderId, { ...doc })
      return { status: StatusEnum.ok, reason: null, data: { result: doc } }
    },
    updateData: async (filter: Row, update: Row) => {
      const { $unset, ...set } = update
      for (const [key, row] of rows) {
        if (!matches(row, filter)) continue
        const next = { ...row, ...set }
        for (const k of Object.keys($unset ?? {})) delete next[k]
        rows.set(key, next)
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
      return {
        status: StatusEnum.ok,
        reason: `Deleted: ${deleted} records`,
        data: null,
      }
    },
  }
}

const makeOrder = () => ({
  clientOrderId: CLIENT_ID,
  symbol: 'BTC-USDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '416.70833334',
  price: '1.2',
  origPrice: '1.2',
  exchange: ExchangeEnum.kraken,
  typeOrder: 'regular',
  dealId: undefined,
  reduceOnly: false,
  positionSide: undefined,
})

/**
 * Drive the real `sendOrderToExchange` off the prototype — importing the module
 * opens no connections and instance properties shadow prototype methods, so no
 * Mongo, Redis, venue or bot stack is needed.
 */
const makeBot = (openOrder: () => Promise<any>) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []

  Object.assign(bot, {
    botId: '6a212785ce236bfdf885bada',
    userId: '69cf3bb41004d803c3d84ae7',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    data: {
      exchange: ExchangeEnum.kraken,
      // Empty on purpose: `AuthFailureGuard.check` is skipped, so the auth
      // short-circuit cannot fire and the compliance one is isolated.
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return openOrder()
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
    // --- collaborators stubbed to no-ops; none of them is under test ---
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
    needToSendOrder: () => true,
    isComplianceGateable: () => true,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => 'BTC-USDT-BUY',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 2,
      baseAsset: { maxMarketAmount: 1e12, precision: 8 },
      quoteAsset: { minAmount: 1, precision: 2 },
    }),
  })

  // Prototype getters cannot be shadowed by plain assignment.
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

const restricted = async () => ({
  restricted: true,
  reason: COMPLIANCE_REASON,
  until: Date.now() + 60_000,
})
const notRestricted = async () => ({
  restricted: false,
  reason: null,
  until: null,
})

const originalCheck = ComplianceGuard.check

describe('bug #673 — a locally refused order must not be left open (spec 013)', () => {
  afterEach(() => {
    ComplianceGuard.check = originalCheck
  })

  it('§4.1 removes the pre-written row when the compliance guard serves the rejection', async () => {
    ComplianceGuard.check = restricted as any
    const bot = makeBot(async () => {
      throw new Error('the venue must not be called on a short-circuit')
    })

    await bot.sendOrderToExchange(makeOrder())

    // §4.2 — the guard answered locally, so the venue was never asked.
    expect(bot.venueCalls).to.have.length(0)
    // §4.1 — and nothing is left behind describing an order that never was.
    expect(
      bot.ordersDb.rows.get(CLIENT_ID),
      'a locally refused order must leave no row',
    ).to.equal(undefined)
    // The in-memory copy is dropped either way; this is the pre-existing
    // behaviour the fix must not disturb.
    expect(bot.orders.has(CLIENT_ID)).to.equal(false)
  })

  it('§4.3 still writes a real venue rejection off as CANCELED', async () => {
    ComplianceGuard.check = notRestricted as any
    const bot = makeBot(async () => ({
      status: StatusEnum.notok,
      reason: COMPLIANCE_REASON,
      data: null,
    }))

    await bot.sendOrderToExchange(makeOrder())

    // The venue WAS asked, so its answer is recorded rather than erased —
    // the audit trail for an order the exchange actually saw.
    expect(bot.venueCalls).to.have.length(1)
    const row = bot.ordersDb.rows.get(CLIENT_ID)
    expect(row, 'a venue-refused order keeps its row').to.not.equal(undefined)
    expect(row.status).to.equal('CANCELED')
  })

  it('§4.4 leaves an order the venue accepted alone', async () => {
    ComplianceGuard.check = notRestricted as any
    const bot = makeBot(async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        ...makeOrder(),
        orderId: 'OQCLML-BW3P3-BUCMWZ',
        status: 'NEW',
        executedQty: '0',
        cummulativeQuoteQty: '0',
        fills: [],
      },
    }))

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.venueCalls).to.have.length(1)
    const row = bot.ordersDb.rows.get(CLIENT_ID)
    expect(row, 'an accepted order keeps its row').to.not.equal(undefined)
    expect(row.status).to.equal('NEW')
  })
})
