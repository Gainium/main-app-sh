process.env.NODE_ENV = 'testing'

/**
 * Regression tests for bug #664 — a venue that refuses our QUANTITY precision
 * is never learned from, so the same order is recomputed at the same rejected
 * precision and refused again, indefinitely.
 *
 * Prod (read-only, `~/.pm2/logs` archives): one bot logged
 * `Order quantity has too many decimals.` on 2026-08-28, 08-30, 09-01 and
 * 09-04 — a 7.1-day standing condition — and every rejected quantity in the
 * 40-line sample carried exactly four decimals (0.0118, 0.2004, 0.2473,
 * 0.2483, 0.1985, 0.0089, 0.1941, 0.0668, 0.0487, 0.0289).
 *
 * The account's Bybit connection is on the EU regional host
 * (`bybitHost: 'eu'`). Queried live, `api.bybit.eu` publishes 133 spot symbols
 * against `api.bybit.com`'s 538, does not list SOLUSDT at all, and gives 34
 * shared symbols a COARSER `basePrecision` than `.com` (SOLUSDC 0.001 vs
 * 0.0001). The `pairs` row is loaded from `.com`, so every quantity we compute
 * is a legal multiple of a step the account's own venue rejects — and because
 * SOLUSDT is absent from the EU list entirely, no host-keyed loader could have
 * supplied the right step either. The refusal itself is the only source of
 * truth we have, and it was being thrown away.
 *
 * Enforces specs/018 §4.1–§4.8.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach, after } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import ComplianceGuard from './complianceGuard'
import AuthFailureGuard from './authGuard'
import RedisClient from '../db/redis'
import { MathHelper } from '../utils/math'
import {
  QtyStepGuard,
  deriveAcceptedDecimals,
  decimalsToStep,
  isQtyDecimalsRefusal,
} from './qtyStepGuard'

/** The exact Bybit wording behind the reported rows. */
const REASON = 'Order quantity has too many decimals.'
const UUID = '22dc8496-fc74-4b5c-9cae-4be78be34ef2'
const SYMBOL = 'SOLUSDT'
const CLIENT_ID = 'D-TP-BwH7v8mBxFYCby1UveLSm0MgEMxQFX'

/** The `pairs` row as loaded from api.bybit.com — 4dp, which EU refuses. */
const sharedPairRow = () => ({
  pair: SYMBOL,
  exchange: ExchangeEnum.bybit,
  maxOrders: 500,
  priceAssetPrecision: 2,
  baseAsset: {
    name: 'SOL',
    minAmount: 0.0001,
    maxAmount: 26000,
    maxMarketAmount: 13000,
    step: 0.0001,
  },
  quoteAsset: { name: 'USDT', minAmount: 1, precision: 6 },
})

type Row = Record<string, any>

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
      return { status: StatusEnum.ok, reason: `Deleted: ${deleted}`, data: null }
    },
  }
}

/** A take-profit SELL sized to 4 decimals, exactly as prod logged it. */
const makeOrder = (origQty = '0.2473') => ({
  clientOrderId: CLIENT_ID,
  symbol: SYMBOL,
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty,
  price: '104.52',
  origPrice: '104.52',
  exchange: ExchangeEnum.bybit,
  typeOrder: 'tp',
  dealId: undefined,
  reduceOnly: false,
  positionSide: undefined,
})

/**
 * Drive the real `sendOrderToExchange` off the prototype — importing the module
 * opens no connections and instance properties shadow prototype methods, so no
 * Mongo, Redis, venue or bot stack is needed.
 *
 * `getExchangeInfo` is deliberately NOT stubbed: the real method is what §4.5
 * is about, so `sharedData` is stubbed underneath it instead and the shared row
 * it hands back is asserted on directly.
 */
const makeBot = (venue: (req: any) => Promise<any>) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const shared = sharedPairRow()

  Object.assign(bot, {
    botId: '6a91bbd64889ca2352428bad',
    userId: '6a58ffba11e25b72ba1d3993',
    botType: 'dca',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    sharedRow: shared,
    data: {
      exchange: ExchangeEnum.bybit,
      // Non-empty on purpose: `QtyStepGuard` keys every learned step on
      // `exchangeUUID` (see `main.ts` `QtyStepGuard.peek(this.data?.exchangeUUID,
      // symbol)`), so the behaviour under test cannot be exercised without it.
      // It therefore also arms `AuthFailureGuard`, which `beforeEach` stubs.
      exchangeUUID: UUID,
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    sharedData: {
      getExchangeInfo: async () => shared,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return venue(req)
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
    handleOrderErrors: () => undefined,
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    // The compliance gate is not under test and would reach Redis.
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => `${SYMBOL}-SELL`,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
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

const refuses = () => async () => ({
  status: StatusEnum.notok,
  reason: REASON,
  data: null,
})

/** Refuse anything finer than `maxDecimals`, accept the rest — a fake EU host. */
const refusesFinerThan = (maxDecimals: number) => {
  const math = new MathHelper()
  return async (req: any) => {
    if (math.countDecimals(req.quantity) > maxDecimals) {
      return { status: StatusEnum.notok, reason: REASON, data: null }
    }
    return {
      status: StatusEnum.ok,
      reason: null,
      data: {
        clientOrderId: req.newClientOrderId,
        orderId: 'a1b2c3',
        symbol: req.symbol,
        side: req.side,
        type: req.type,
        status: 'NEW',
        origQty: `${req.quantity}`,
        price: `${req.price}`,
        executedQty: '0',
        cummulativeQuoteQty: '0',
        fills: [],
      },
    }
  }
}

const originalCheck = ComplianceGuard.check
const originalAuthCheck = AuthFailureGuard.check
const originalAuthRecord = AuthFailureGuard.record
const originalAuthClaimAlert = AuthFailureGuard.claimAlert

describe('bug #664 — a refused quantity precision must be learned (spec 018)', () => {
  /**
   * Nothing under this suite may CONSTRUCT a Redis client. `QtyStepGuard`
   * itself is already careful — `peek`/`record`/`hydrate` consult
   * `RedisClient._instance?.isReady` and never call `getInstance()` — but
   * `sendOrderToExchange` gates its venue calls on `AuthFailureGuard.check`,
   * which does, and `getInstance()` retries a dead server forever. That is why
   * these tests passed on a dev box (Redis listening on :6379, so the client
   * resolves even when it then fails NOAUTH) and timed out at 20s each on CI,
   * whose `test.yml` declares no `services:`. Snapshotted rather than asserted
   * `=== undefined` so that a client built by an EARLIER spec file in the same
   * mocha process is not misreported as this suite's doing.
   */
  let redisInstanceAtStart: unknown

  before(() => {
    redisInstanceAtStart = RedisClient._instance
  })

  beforeEach(() => {
    ComplianceGuard.check = (async () => ({
      restricted: false,
      reason: null,
      until: null,
    })) as any
    // Not under test, and the only thing on this path that reaches Redis.
    // `check` answers "no cooldown" so every call goes to the fake venue;
    // `record`/`claimAlert` are the write-side twins and are inert here.
    AuthFailureGuard.check = (async () => ({
      failed: false,
      reason: null,
      until: null,
    })) as any
    AuthFailureGuard.record = (async () => 0) as any
    // The real one fails OPEN (returns true) when it cannot reach Redis.
    AuthFailureGuard.claimAlert = (async () => true) as any
    QtyStepGuard.resetForTests()
  })

  after(() => {
    ComplianceGuard.check = originalCheck
    AuthFailureGuard.check = originalAuthCheck
    AuthFailureGuard.record = originalAuthRecord
    AuthFailureGuard.claimAlert = originalAuthClaimAlert
    // Restores first, assertion last: a failure here must not leak the stubs
    // into whichever spec file mocha runs next.
    expect(
      RedisClient._instance,
      'this suite constructed a Redis client — it will hang on CI, where no Redis is running',
    ).to.equal(redisInstanceAtStart)
  })

  describe('§4.1 recognising the refusal', () => {
    it('matches the venue wording', () => {
      expect(isQtyDecimalsRefusal(REASON)).to.equal(true)
    })
    it('matches case-insensitively', () => {
      expect(isQtyDecimalsRefusal('ORDER QUANTITY HAS TOO MANY DECIMALS.')).to.equal(
        true,
      )
    })
    it('does NOT match the price variant', () => {
      // `Order price has too many decimals.` already has its own
      // classification in bot/utils.ts and its own tickSize retry branch.
      expect(isQtyDecimalsRefusal('Order price has too many decimals.')).to.equal(
        false,
      )
    })
    it('does not match an unrelated refusal', () => {
      expect(isQtyDecimalsRefusal('Insufficient balance')).to.equal(false)
    })
  })

  describe('§4.2 deriving the accepted precision', () => {
    it('a refused 4dp quantity proves at most 3dp is accepted', () => {
      expect(deriveAcceptedDecimals('0.2473')).to.equal(3)
    })
    it('reads the decimals off the number as sent, not off the step', () => {
      expect(deriveAcceptedDecimals(0.0118)).to.equal(3)
    })
    it('a refused 1dp quantity leaves only whole units', () => {
      expect(deriveAcceptedDecimals('0.2')).to.equal(0)
    })
    it('a refused whole quantity teaches nothing', () => {
      // Nothing coarser than 0 decimals exists, so there is no retry to make.
      expect(deriveAcceptedDecimals('3')).to.equal(null)
    })
    it('rejects values that are not finite numbers', () => {
      expect(deriveAcceptedDecimals('not-a-number')).to.equal(null)
    })
    it('converts decimals back to the step the sizing math uses', () => {
      expect(decimalsToStep(3)).to.equal(0.001)
      expect(decimalsToStep(0)).to.equal(1)
    })
  })

  describe('§4.3 learning is monotone and account-scoped', () => {
    it('records what the refusal taught', async () => {
      await QtyStepGuard.record(UUID, SYMBOL, 3)
      expect(QtyStepGuard.peek(UUID, SYMBOL)).to.equal(3)
    })
    it('a coarser lesson overrides a finer one', async () => {
      await QtyStepGuard.record(UUID, SYMBOL, 3)
      await QtyStepGuard.record(UUID, SYMBOL, 2)
      expect(QtyStepGuard.peek(UUID, SYMBOL)).to.equal(2)
    })
    it('never un-learns back to a finer precision', async () => {
      await QtyStepGuard.record(UUID, SYMBOL, 2)
      await QtyStepGuard.record(UUID, SYMBOL, 3)
      expect(QtyStepGuard.peek(UUID, SYMBOL)).to.equal(2)
    })
    it('is scoped to the connection', async () => {
      await QtyStepGuard.record(UUID, SYMBOL, 3)
      expect(QtyStepGuard.peek('another-uuid', SYMBOL)).to.equal(null)
    })
    it('is scoped to the symbol', async () => {
      await QtyStepGuard.record(UUID, SYMBOL, 3)
      expect(QtyStepGuard.peek(UUID, 'BTCUSDT')).to.equal(null)
    })
  })

  describe('§4.4 the retry', () => {
    it('resubmits once at the precision the venue proved it accepts', async () => {
      const bot = makeBot(refusesFinerThan(3))

      await bot.sendOrderToExchange(makeOrder('0.2473'))

      expect(
        bot.venueCalls.map((c: any) => c.quantity),
        'the refused 4dp order must be resubmitted at 3dp',
      ).to.deep.equal([0.2473, 0.247])
    })

    it('rounds DOWN, never up — a SELL must not exceed the position', async () => {
      const bot = makeBot(refusesFinerThan(3))

      await bot.sendOrderToExchange(makeOrder('0.0118'))

      // 0.0118 -> 0.011, not 0.012.
      expect(bot.venueCalls[1].quantity).to.equal(0.011)
    })

    it('leaves the resubmitted order live rather than written off', async () => {
      const bot = makeBot(refusesFinerThan(3))

      await bot.sendOrderToExchange(makeOrder('0.2473'))

      const row = bot.ordersDb.rows.get(CLIENT_ID)
      expect(row?.status).to.equal('NEW')
    })

    it('terminates instead of looping when every precision is refused', async () => {
      // A venue that refuses everything must not be hammered forever: each
      // refusal strictly lowers the decimal count, so the chain is finite.
      const bot = makeBot(refuses())

      await bot.sendOrderToExchange(makeOrder('0.2473'))

      expect(bot.venueCalls.length).to.be.at.most(5)
      expect(bot.ordersDb.rows.get(CLIENT_ID)?.status).to.equal('CANCELED')
    })

    it('does not retry when rounding down would zero the order', async () => {
      // 0.0001 at 3dp is 0 — there is no order left to send.
      const bot = makeBot(refuses())

      await bot.sendOrderToExchange(makeOrder('0.0001'))

      expect(bot.venueCalls).to.have.length(1)
    })
  })

  describe('§4.5 future orders size correctly from the start', () => {
    it('coarsens the step the sizing math reads', async () => {
      const bot = makeBot(refusesFinerThan(3))

      const before = await bot.getExchangeInfo(SYMBOL)
      expect(before.baseAsset.step, 'unlearned, the shared row stands').to.equal(
        0.0001,
      )

      await bot.sendOrderToExchange(makeOrder('0.2473'))

      const after = await bot.getExchangeInfo(SYMBOL)
      expect(after.baseAsset.step).to.equal(0.001)
      // `baseAssetPrecision` is what dcaHelper/gridMonitor round with.
      expect(await bot.baseAssetPrecision(SYMBOL)).to.equal(3)
    })

    it('lifts minAmount to at least one step', async () => {
      const bot = makeBot(refusesFinerThan(3))
      await bot.sendOrderToExchange(makeOrder('0.2473'))
      const after = await bot.getExchangeInfo(SYMBOL)
      expect(after.baseAsset.minAmount).to.equal(0.001)
    })

    it('the NEXT order is sized right the first time, costing no refusal', async () => {
      // The whole point of persisting: one refusal, then the bot converges.
      // Sizing here goes through `baseAssetPrecision`, which is what the real
      // dcaHelper/gridMonitor rounding uses.
      const first = makeBot(refusesFinerThan(3))
      await first.sendOrderToExchange(makeOrder('0.2473'))
      expect(first.venueCalls, 'the lesson costs exactly one refusal').to.have.length(2)

      const second = makeBot(refusesFinerThan(3))
      const precision = await second.baseAssetPrecision(SYMBOL)
      const sized = second.math.round(0.2483, precision, true)
      await second.sendOrderToExchange({ ...makeOrder(), origQty: `${sized}` })

      expect(second.venueCalls.map((c: any) => c.quantity)).to.deep.equal([0.248])
    })

    it('every quantity prod actually had refused survives one pass', async () => {
      // The ten refused quantities from the prod log sample.
      for (const qty of [
        '0.0118', '0.2004', '0.2473', '0.2483', '0.1985',
        '0.0089', '0.1941', '0.0668', '0.0487', '0.0289',
      ]) {
        QtyStepGuard.resetForTests()
        const bot = makeBot(refusesFinerThan(3))
        await bot.sendOrderToExchange({ ...makeOrder(), origQty: qty })
        expect(bot.venueCalls.length, `${qty} must be resubmitted`).to.equal(2)
        expect(
          bot.ordersDb.rows.get(CLIENT_ID)?.status,
          `${qty} must end live, not written off`,
        ).to.equal('NEW')
      }
    })

    it('never coarsens a step that is already coarse enough', async () => {
      await QtyStepGuard.record(UUID, SYMBOL, 6)
      const bot = makeBot(refusesFinerThan(3))
      const info = await bot.getExchangeInfo(SYMBOL)
      expect(info.baseAsset.step).to.equal(0.0001)
    })
  })

  describe('§4.6 inert by default', () => {
    it('an unrefused account gets the shared row untouched, same reference', async () => {
      const bot = makeBot(refusesFinerThan(8))
      const info = await bot.getExchangeInfo(SYMBOL)
      expect(info).to.equal(bot.sharedRow)
    })

    it('an unrelated refusal is not treated as a precision lesson', async () => {
      // Deliberately a reason no OTHER retry branch claims either — `balance`,
      // `duplicate`, `tick size` and `not found` all have their own.
      const bot = makeBot(async () => ({
        status: StatusEnum.notok,
        reason: 'Symbol is not supported',
        data: null,
      }))

      await bot.sendOrderToExchange(makeOrder('0.2473'))

      expect(bot.venueCalls).to.have.length(1)
      expect(QtyStepGuard.peek(UUID, SYMBOL)).to.equal(null)
    })
  })

  describe('§4.8 the shared pair record is never mutated', () => {
    it('applying a learned step copies rather than edits', async () => {
      const bot = makeBot(refusesFinerThan(3))

      await bot.sendOrderToExchange(makeOrder('0.2473'))
      const after = await bot.getExchangeInfo(SYMBOL)

      expect(after).to.not.equal(bot.sharedRow)
      expect(
        bot.sharedRow.baseAsset.step,
        'the row every other bot on this pair shares must be untouched',
      ).to.equal(0.0001)
      expect(bot.sharedRow.baseAsset.minAmount).to.equal(0.0001)
    })
  })
})
