process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `025.a-nan-quantity-reaches-the-venue-and-poisons-the-deal` (issue #715),
 * submission-boundary half.
 *
 * `sendOrderToExchange` has no opinion about the numbers it is handed. On
 * 2026-09-08 it took a take-profit whose quantity was NaN, wrote it ahead to
 * `orders`, and sent it:
 *
 *   13:18:28.477Z  UNKNOWN_FAILURE_REASON  Method limitOrders() Step Send new
 *                  order request D-TP-wNa2CKPAwo3IEmZ9So23q2zVHTNTH2,
 *                  qty NaN, price 0.000001, side SELL
 *
 * and the row it left behind reads `origQty 'NaN'`, `cummulativeQuoteQty
 * 'NaN'`, `orderId '-1'` — as STRINGS, which mongoose's `String` fields
 * accept. Every later deal aggregate that casts them back to `Number` then
 * produces NaN, which is how one unfillable order stops a deal document from
 * saving at all (spec `023` §2.2; 16 such rows across 10 deals and 6 bots).
 *
 * No venue accepts a non-finite quantity or price, so refusing one here cannot
 * cost a fill. It is the one guard that is independent of which upstream
 * producer went wrong — the DCA ladder (§4.2/§4.3), `getTPOrder` (spec 023),
 * or one not yet found.
 *
 * Drives the REAL `sendOrderToExchange` off the prototype — importing the
 * module opens no connections and instance properties shadow prototype
 * methods, so no Mongo, Redis, venue or bot stack is needed. Harness shape
 * copied from `strandedLocalRefusal.spec.ts` (spec 013).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

/** The clientOrderId of the take-profit production actually sent. */
const CLIENT_ID = 'D-TP-wNa2CKPAwo3IEmZ9So23q2zVHTNTH2'

type Row = Record<string, any>

/**
 * A stand-in for the `orders` DAO backed by a Map, so the REAL
 * `saveOrderToDb` runs against it and the assertions are about persisted
 * STATE, not about which method was called.
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

/** The prod row, before `sendOrderToExchange` persisted it. */
const makeOrder = (over: Row = {}) => ({
  clientOrderId: CLIENT_ID,
  symbol: 'SWFTC-USDC',
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: 'NaN',
  price: '0.000001',
  origPrice: '0.000001',
  exchange: ExchangeEnum.coinbase,
  typeOrder: 'dealTP',
  dealId: '6a9fca447794d53dedbab119',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeBot = () => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const errors: string[] = []

  Object.assign(bot, {
    botId: '6a8b89e98e06bef801add796',
    userId: '6a8b1db88e06bef801d752bd',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    errors,
    data: {
      exchange: ExchangeEnum.coinbase,
      // Empty on purpose: `AuthFailureGuard.check` is skipped, so no
      // short-circuit other than the one under test can fire.
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        // What coinbase answered: an unfillable order, refused without a
        // reason string.
        return {
          status: StatusEnum.notok,
          reason: 'UNKNOWN_FAILURE_REASON: , ',
          data: null,
        }
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
    handleErrors: (m: string) => {
      errors.push(m)
    },
    handleOrderErrors: (m: string) => {
      errors.push(m)
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
    getNotEnoughOrdersIdByOrder: () => 'SWFTC-USDC-SELL',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.006, taker: 0.012 }),
    getExchangeInfo: async () => ({
      pair: 'SWFTC-USDC',
      priceAssetPrecision: 6,
      baseAsset: { maxMarketAmount: 1e12, precision: 0, step: 1, minAmount: 1 },
      quoteAsset: { minAmount: 1, precision: 6 },
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

describe('order-submission NaN refusal (spec 025, issue #715)', () => {
  it('§4.1 never asks the venue for an order with a NaN quantity', async () => {
    const bot = makeBot()

    await bot.sendOrderToExchange(makeOrder())

    expect(
      bot.venueCalls.map((c: any) => c.quantity),
      'the venue was asked to fill a non-finite quantity',
    ).to.deep.equal([])
  })

  it('§4.1 leaves no origQty "NaN" row behind', async () => {
    const bot = makeBot()

    await bot.sendOrderToExchange(makeOrder())

    // The write-ahead row is what poisons every later deal aggregate: the
    // string "NaN" survives a mongoose `String` field and fails the Number
    // cast on `fullFee` / `currentBalances.*` / `usage.currentUsd` /
    // `assets.required.base`, after which the deal cannot be saved at all.
    const row = bot.ordersDb.rows.get(CLIENT_ID)
    expect(
      row?.origQty,
      'a non-finite quantity must not be write-ahead persisted',
    ).to.equal(undefined)
  })

  it('§4.1 reports it as a named order-parameter failure', async () => {
    const bot = makeBot()

    await bot.sendOrderToExchange(makeOrder())

    // `Order qty is not a number` is already in `bot/utils.ts` errorDict and
    // maps to the `orderParams` subtype — same string `addDealFunds` uses for
    // its own refusal, so no new taxonomy entry is needed.
    expect(bot.errors.join('\n')).to.contain('Order qty is not a number')
  })

  it('§4.1 refuses a non-finite PRICE the same way', async () => {
    const bot = makeBot()

    await bot.sendOrderToExchange(
      makeOrder({ origQty: '37828', price: 'NaN', origPrice: 'NaN' }),
    )

    expect(bot.venueCalls).to.have.length(0)
    expect(bot.ordersDb.rows.get(CLIENT_ID)).to.equal(undefined)
  })

  it('§4.1 returns the reason when the caller asked for one', async () => {
    const bot = makeBot()

    const result = await bot.sendOrderToExchange(makeOrder(), true)

    expect(result).to.be.a('string')
    expect(result).to.contain('Order qty is not a number')
  })

  it('§4.5 a well-formed order still reaches the venue and is persisted', async () => {
    const bot = makeBot()

    await bot.sendOrderToExchange(makeOrder({ origQty: '37828' }))

    expect(bot.venueCalls, 'a healthy order must still be sent').to.have.length(
      1,
    )
    expect(bot.venueCalls[0].quantity).to.equal(37828)
    const row = bot.ordersDb.rows.get(CLIENT_ID)
    expect(row, 'a healthy order still gets its write-ahead row').to.not.equal(
      undefined,
    )
  })
})
