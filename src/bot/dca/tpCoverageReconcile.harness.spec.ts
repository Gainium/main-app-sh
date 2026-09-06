process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `013.tp-coverage-drift-after-partial-tp` (#696).
 *
 * Drives the REAL `dcaHelper.checkTpCoverage` — not a reimplementation — over
 * the recorded production state of the three deals measured on 2026-09-06:
 *
 *   6a90e161a76e7fe63ea3118f  B3-USDC   under-covered by 110,493 (§2.2)
 *   6a978104aa99d06351d63e3a  CTSIUSDT  double take-profit, +315 (§2.3)
 *   691de676b60a5e1cf2d420eb  DGBUSDT   double take-profit, +20,646.4 (§2.4)
 *
 * plus a healthy partially-filled deal that must be left alone (§1.6).
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Every
 * venue-touching collaborator is recorded rather than performed — this suite
 * must never place or cancel an order anywhere.
 *
 * The module-level arming flag is read at import time, so the helper is
 * re-required per arming state.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, beforeEach } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { ConditionLatch } from '../conditionLatch'

type Cancelled = { clientOrderId: string; promotePartialToFilled: unknown }

const settings: any = {
  useMultiTp: false,
  useTp: true,
  trailingTp: false,
  dealCloseCondition: 'tp',
  multiTp: [],
}

/** Venue minimums small enough that none of the real drifts are masked. */
const EXCHANGE_INFO: any = {
  baseAsset: { minAmount: 1, step: 0.1, asset: 'BASE' },
  quoteAsset: { minAmount: 1, step: 0.01, asset: 'QUOTE' },
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  // Real `MainBot` field (`main.ts:828`) — a standing drift must not be
  // re-reported on every reconcile pass. 24h re-arm, as in production.
  standingConditionLatch = new ConditionLatch(24 * 60 * 60 * 1000)
  data: any = {
    settings,
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const order = (
  clientOrderId: string,
  status: string,
  origQty: string,
  executedQty: string,
  dealId: string,
) => ({
  clientOrderId,
  status,
  origQty,
  executedQty,
  dealId,
  typeOrder: 'dealTP',
  symbol: 'X',
})

/** The four deals, exactly as production held them. */
const DEALS = {
  b3: {
    _id: '6a90e161a76e7fe63ea3118f',
    symbol: { symbol: 'B3-USDC' },
    size: 989458.9999999998,
    tpHistory: [{ id: 'D-TP-TNTUX', qty: 54103 }],
    lastPrice: 0.0004776,
    avgPrice: 0.0004688244815601252,
    initialPrice: 0.0004688244815601252,
    reduceFunds: [],
    tps: [order('D-TP-TNTUX', 'PARTIALLY_FILLED', '878966', '54103', '6a90e161a76e7fe63ea3118f')],
  },
  ctsi: {
    _id: '6a978104aa99d06351d63e3a',
    symbol: { symbol: 'CTSIUSDT' },
    size: 900,
    tpHistory: [{ id: 'TP-Jjsrx', qty: 367 }],
    lastPrice: 0.02409,
    avgPrice: 0.02484698888888889,
    initialPrice: 0.02484698888888889,
    reduceFunds: [],
    tps: [
      order('TP-Jjsrx', 'PARTIALLY_FILLED', '682', '367.00000000', '6a978104aa99d06351d63e3a'),
      order('TP-qWLCK', 'NEW', '533', '0.00000000', '6a978104aa99d06351d63e3a'),
    ],
  },
  dgb: {
    _id: '691de676b60a5e1cf2d420eb',
    symbol: { symbol: 'DGBUSDT' },
    size: 43018.899999999994,
    tpHistory: [{ id: 'D-TP-fawIy', qty: 11245.4 }],
    lastPrice: 0.0075,
    avgPrice: 0.0075,
    initialPrice: 0.0075,
    reduceFunds: [],
    tps: [
      order('D-TP-fawIy', 'PARTIALLY_FILLED', '31934.9', '11245.4', '691de676b60a5e1cf2d420eb'),
      order('D-TP-GzuLl', 'NEW', '31730.4', '0', '691de676b60a5e1cf2d420eb'),
    ],
  },
  /** SPELLUSDT — partially filled and perfectly covered. Must not be touched. */
  healthy: {
    _id: '6a5939f5d3d5da3fb6d03677',
    symbol: { symbol: 'SPELLUSDT' },
    size: 158522,
    tpHistory: [{ id: 'TP-ui5yI', qty: 102530 }],
    lastPrice: 0.0004,
    avgPrice: 0.0004,
    initialPrice: 0.0004,
    reduceFunds: [],
    tps: [order('TP-ui5yI', 'PARTIALLY_FILLED', '158522', '102530.00000000', '6a5939f5d3d5da3fb6d03677')],
  },
} as const

/**
 * One helper class per arming state. The flag is a module-level constant read
 * at import time, so each state needs its own load of `dcaHelper` — and that
 * load compiles 21k lines through ts-node, so it is done at most twice for the
 * whole file rather than once per test.
 */
const helperCache = new Map<boolean, any>()
const helperFor = (armed: boolean) => {
  const hit = helperCache.get(armed)
  if (hit) return hit
  if (armed) {
    process.env.BOT_TP_COVERAGE_REPAIR = '1'
  } else {
    delete process.env.BOT_TP_COVERAGE_REPAIR
  }
  delete require.cache[require.resolve('../dcaHelper')]
  const built = require('../dcaHelper').default(FakeBase as any)
  helperCache.set(armed, built)
  return built
}

const buildBot = (armed: boolean, deals: readonly any[]) => {
  const Helper: any = helperFor(armed)

  class TestBot extends Helper {
    public cancelled: Cancelled[] = []
    public placed: any[] = []
    public warns: string[] = []
    public logs: string[] = []
    public rearmQty = 935356

    getDealsByStatusAndSymbol() {
      return deals.map((d) => ({ deal: d, initialOrders: [], currentOrders: [] }))
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    getOrdersByStatusAndDealId() {
      // No FILLED close orders on any of these deals.
      return []
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async cancelOrderOnExchange(
      o: any,
      _setErrors: boolean,
      _removeFromLocal: boolean,
      promotePartialToFilled: unknown,
    ) {
      this.cancelled.push({
        clientOrderId: o.clientOrderId,
        promotePartialToFilled,
      })
      return undefined
    }
    async getTPOrder() {
      return [{ qty: this.rearmQty, price: 1 }]
    }
    async placeOrders(_b: string, _s: string, dealId: string, orders: any) {
      this.placed.push({ dealId, orders })
    }
    handleWarn(m: string) {
      this.warns.push(m)
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
  }
  return new TestBot()
}

/** What the reconcile pass hands over: venue-confirmed orders, per deal. */
const confirmedFrom = (deals: readonly any[]) => {
  const map = new Map<string, any[]>()
  for (const d of deals) {
    map.set(d._id, [...d.tps])
  }
  return map
}

const run = async (bot: any, deals: readonly any[], unresolved = new Set<string>()) =>
  await bot.checkTpCoverage(confirmedFrom(deals), unresolved)

describe('checkTpCoverage (spec 013, issue #696)', () => {
  before(function () {
    // Two ts-node compiles of a 21k-line module, done once here so no
    // individual test carries the cost and trips the suite's default timeout.
    this.timeout(180000)
    helperFor(false)
    helperFor(true)
  })

  describe('§4.2 the correction is disarmed unless an operator arms it', () => {
    let bot: any
    const all = [DEALS.b3, DEALS.ctsi, DEALS.dgb, DEALS.healthy]

    beforeEach(async () => {
      bot = buildBot(false, all)
      await run(bot, all)
    })

    it('cancels nothing and places nothing', () => {
      expect(bot.cancelled).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
    })

    it('still reports every drifted deal', () => {
      const warned = bot.warns.filter((w: string) =>
        w.startsWith('tp-coverage drift'),
      )
      expect(warned).to.have.length(3)
      expect(warned.join('\n')).to.contain('6a90e161a76e7fe63ea3118f')
      expect(warned.join('\n')).to.contain('6a978104aa99d06351d63e3a')
      expect(warned.join('\n')).to.contain('691de676b60a5e1cf2d420eb')
    })

    it('says what arming it would do', () => {
      expect(bot.logs.join('\n')).to.contain('BOT_TP_COVERAGE_REPAIR')
    })

    it('leaves the healthy partially-filled deal unmentioned', () => {
      expect(bot.warns.join('\n')).to.not.contain('SPELLUSDT')
      expect(bot.logs.join('\n')).to.not.contain('SPELLUSDT')
    })
  })

  describe('§2.2 the reported B3-USDC deal', () => {
    it('names the uncovered 110,493 base', async () => {
      const bot = buildBot(false, [DEALS.b3])
      await run(bot, [DEALS.b3])
      const w = bot.warns.join('\n')
      expect(w).to.contain('under')
      expect(w).to.contain('110493')
      expect(w).to.contain('D-TP-TNTUX')
    })

    it('when armed, cancels the stale take-profit and re-arms', async () => {
      const bot = buildBot(true, [DEALS.b3])
      await run(bot, [DEALS.b3])
      expect(bot.cancelled.map((c: Cancelled) => c.clientOrderId)).to.deep.equal([
        'D-TP-TNTUX',
      ])
      expect(bot.placed).to.have.length(1)
      expect(bot.placed[0].dealId).to.equal(DEALS.b3._id)
      expect(bot.placed[0].orders.new[0].qty).to.equal(935356)
    })
  })

  describe('§1.4 the FILLED promotion is never tripped', () => {
    it('cancels every stale take-profit with promotePartialToFilled false', async () => {
      const armedDeals = [DEALS.b3, DEALS.ctsi, DEALS.dgb]
      const bot = buildBot(true, armedDeals)
      await run(bot, armedDeals)
      expect(bot.cancelled).to.have.length(3)
      for (const c of bot.cancelled as Cancelled[]) {
        // The whole reason #694's follow-up exists: the default path would
        // promote these to FILLED and close the deal on the fraction that sold.
        expect(c.promotePartialToFilled).to.equal(false)
      }
    })

    it('never cancels the correctly-sized NEW replacement', async () => {
      const bot = buildBot(true, [DEALS.ctsi, DEALS.dgb])
      await run(bot, [DEALS.ctsi, DEALS.dgb])
      const ids = bot.cancelled.map((c: Cancelled) => c.clientOrderId)
      expect(ids).to.deep.equal(['TP-Jjsrx', 'D-TP-fawIy'])
      expect(ids).to.not.contain('TP-qWLCK')
      expect(ids).to.not.contain('D-TP-GzuLl')
    })
  })

  describe('spec 008 — a standing drift is not re-reported every pass', () => {
    it('reports once across repeated reconcile passes', async () => {
      const bot = buildBot(false, [DEALS.b3])
      for (let i = 0; i < 5; i++) await run(bot, [DEALS.b3])
      expect(
        bot.warns.filter((w: string) => w.startsWith('tp-coverage drift')),
      ).to.have.length(1)
    })

    it('reports again once the drift clears and returns', async () => {
      const bot = buildBot(false, [DEALS.b3])
      await run(bot, [DEALS.b3])
      // Covered: the take-profit now rests the whole tracked position.
      const healed = {
        ...DEALS.b3,
        tps: [order('D-TP-TNTUX', 'PARTIALLY_FILLED', '989459', '54103', DEALS.b3._id)],
      }
      await run(bot, [healed])
      await run(bot, [DEALS.b3])
      expect(
        bot.warns.filter((w: string) => w.startsWith('tp-coverage drift')),
      ).to.have.length(2)
    })

    it('does not cancel and re-place on every pass when armed', async () => {
      const bot = buildBot(true, [DEALS.b3])
      for (let i = 0; i < 4; i++) await run(bot, [DEALS.b3])
      expect(bot.cancelled).to.have.length(1)
      expect(bot.placed).to.have.length(1)
    })
  })

  describe('§4.4 a deal with no live take-profit is out of scope', () => {
    it('is neither reported nor acted on', async () => {
      const bare = { ...DEALS.b3, tps: [] as any[] }
      const bot = buildBot(true, [bare])
      await run(bot, [bare])
      expect(bot.warns.join('\n')).to.not.contain('tp-coverage drift')
      expect(bot.cancelled).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
    })
  })

  describe('§1.7 a deal the venue did not fully answer for is skipped', () => {
    it('does not act on an unresolved deal even when armed', async () => {
      const bot = buildBot(true, [DEALS.b3])
      await run(bot, [DEALS.b3], new Set([DEALS.b3._id]))
      expect(bot.cancelled).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
      expect(bot.warns.join('\n')).to.not.contain('tp-coverage drift')
    })
  })

  describe('§1.6 / §4.3 deals this check must not touch', () => {
    it('leaves a healthy partially-filled deal alone even when armed', async () => {
      const bot = buildBot(true, [DEALS.healthy])
      await run(bot, [DEALS.healthy])
      expect(bot.cancelled).to.deep.equal([])
      expect(bot.placed).to.deep.equal([])
    })

    it('skips a multi-TP deal entirely', async () => {
      const bot = buildBot(true, [DEALS.b3])
      bot.getAggregatedSettings = async () => ({
        ...settings,
        useMultiTp: true,
      })
      await run(bot, [DEALS.b3])
      expect(bot.cancelled).to.deep.equal([])
      expect(bot.warns.join('\n')).to.not.contain('tp-coverage drift')
    })

    it('skips a deal whose take-profit is trailing, and one closed by other means', async () => {
      for (const override of [
        { trailingTp: true },
        { dealCloseCondition: 'perc' },
        { useTp: false },
      ]) {
        const bot = buildBot(true, [DEALS.b3])
        bot.getAggregatedSettings = async () => ({ ...settings, ...override })
        await run(bot, [DEALS.b3])
        expect(bot.cancelled, JSON.stringify(override)).to.deep.equal([])
        expect(bot.warns.join('\n')).to.not.contain('tp-coverage drift')
      }
    })

    it('skips a deal whose take-profit is managed externally', async () => {
      const bot = buildBot(true, [DEALS.b3])
      bot.data = { ...bot.data, flags: ['externalTp'] }
      await run(bot, [DEALS.b3])
      expect(bot.cancelled).to.deep.equal([])
    })
  })
})
