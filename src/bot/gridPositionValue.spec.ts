process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `064.grid-position-unrealized-value-is-scaled-by-the-price-ratio`.
 *
 * A futures grid bot values its open position as `qty * perc * lastPrice`,
 * where `perc` is `(lastPrice - entry) / entry` — i.e. the true unrealized
 * value `qty * (lastPrice - entry)` multiplied by `lastPrice / entry`. That
 * factor understates a long's open loss and overstates a short's, so the
 * `valueChanged` stop-loss fires late on a long, and the drawdown statistic
 * built from the same expression is short by the same factor.
 *
 * On top of that, `GridMonitor` has no removal path at all, so the last
 * (<= 60 s) window of a bot's life — the one holding the stop-loss — is never
 * sampled and never written to the bot document.
 *
 * The constants come from the reported bot: a paper `binanceUsdm` grid on
 * `SYNUSDT` at leverage 1 with `slPerc: -0.04`, whose `initialValue` is
 * 286.19686 (spec §2.1). Its closing position is not recoverable — the close
 * zeroes it — so the position here is SIZED to the `Position unPnL -4.16%` the
 * engine logged 0.1 s before the close against a true result of -4.796 %
 * (spec §2.2-§2.3), the same way spec 045 sized its close.
 *
 * `tpSl` is driven off the real mixin with a fake base class; `GridMonitor` is
 * driven with its `botDb` stubbed. No Mongo, Redis, venue or bot stack is
 * needed. Harness shape copied from `gridCloseProfitLedger.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { BotMarginTypeEnum, ExchangeEnum, PositionSide } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'
import { GridMonitor } from './gridMonitor'
import { DealStats } from './worker/statsService'
import { botDb } from '../db/dbInit'

/** Spec §2.1 — `initialBalances.base * initialPrice + initialBalances.quote`. */
const INITIAL_BALANCES = { base: 560, quote: 149.8798 }
const INITIAL_PRICE = 0.24342333
const INITIAL_VALUE =
  INITIAL_BALANCES.base * INITIAL_PRICE + INITIAL_BALANCES.quote

/** The grid round-trips the bot had banked before the close (spec §2.3). */
const REALIZED = 2.7692
/** The stop-loss the reporter configured. */
const SL_PERC = -0.04

/**
 * The position, sized so that the buggy expression reproduces the engine's
 * logged -4.16 % and the correct one reproduces the bot's true -4.796 %.
 * `entry = LAST_PRICE / 0.8896` is the `lastPrice / entry` factor of spec §2.3.
 */
const POSITION = { side: PositionSide.LONG, qty: 697.6, price: 0.214186 }
/** What the bot recorded as its last price when it stopped. */
const CLOSE_PRICE = 0.19054

/** The price at which the position is truly 4.00 % down — where SL is due. */
const SL_DUE_PRICE =
  POSITION.price + (SL_PERC * INITIAL_VALUE - REALIZED) / POSITION.qty

const truePerc = (price: number) =>
  (POSITION.qty * (price - POSITION.price) + REALIZED) / INITIAL_VALUE

let Helper: any

const makeBot = () => {
  class TestBot extends Helper {
    public logs: string[] = []
    public botId = 'grid-064'
    public math = new MathHelper()
    public data: any = {
      _id: 'grid-064',
      exchange: ExchangeEnum.paperBinanceUsdm,
      symbol: { symbol: 'SYNUSDT', baseAsset: 'SYN', quoteAsset: 'USDT' },
      settings: {
        pair: 'SYNUSDT',
        futures: true,
        coinm: false,
        marginType: BotMarginTypeEnum.isolated,
        leverage: 1,
        profitCurrency: 'quote',
        tpSl: false,
        sl: true,
        slCondition: 'valueChanged',
        slPerc: SL_PERC,
      },
      initialPrice: INITIAL_PRICE,
      initialBalances: INITIAL_BALANCES,
      currentBalances: { base: 1260, quote: 0 },
      position: { ...POSITION },
      profit: { total: REALIZED, totalUsd: REALIZED },
    }
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get currentLeverage() {
      return 1
    }
    handleLog(text: string) {
      this.logs.push(text)
    }
    handleDebug() {}
    handleWarn(text: string) {
      this.warnings.push(text)
    }
    handleErrors() {}
    // Live on `MainBot`, which the fake base does not provide. `afterBotStop`
    // calls all three before the flush.
    public warnings: string[] = []
    stopConsumerHeartbeat() {}
    stopQuantRulesRetries() {}
    getLastStreamData() {
      return { price: CLOSE_PRICE }
    }
  }
  return new (TestBot as any)()
}

/** The grid snapshot `GridMonitor` is fed, as `priceUpdateCallback` builds it. */
const gridInput = (over: any = {}) => ({
  _id: 'grid-064',
  exchange: ExchangeEnum.paperBinanceUsdm,
  initialBalances: INITIAL_BALANCES,
  initialPrice: INITIAL_PRICE,
  currentBalances: { base: 1260, quote: 0 },
  realInitialBalances: INITIAL_BALANCES,
  settings: {
    marginType: BotMarginTypeEnum.isolated,
    leverage: 1,
    profitCurrency: 'quote',
  },
  position: { ...POSITION },
  profit: { total: REALIZED },
  stats: {
    drawdownPercent: 0,
    runUpPercent: 0,
    timeInLoss: 0,
    timeInProfit: 0,
    trackTime: 0,
    timeCountStart: 0,
    currentCount: null,
  },
  ...over,
})

describe('grid position value and the stats of the final window (spec 064)', () => {
  before(function () {
    // One ts-node compile of a 5k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1.1.1 the unrealized value is the signed price delta', () => {
    it('reproduces the engine log the reported bot emitted before the fix', () => {
      // Sanity on the fixture itself: the buggy expression is what produced
      // `Position unPnL -4.16%` (spec §2.2), and the true result is -4.796 %.
      const perc = (CLOSE_PRICE - POSITION.price) / POSITION.price
      const buggy =
        (POSITION.qty * perc * CLOSE_PRICE + REALIZED) / INITIAL_VALUE
      expect(buggy * 100).to.be.closeTo(-4.16, 0.01)
      expect(truePerc(CLOSE_PRICE) * 100).to.be.closeTo(-4.796, 0.01)
    })

    it('values the position as `qty * (lastPrice - entry)`, like the close does', () => {
      // `tpSl` only reports its number when it triggers, so the value is read
      // through the trigger boundary: at a true -4.796 % a -4.79 % stop is due
      // and a -4.81 % stop is not.
      const at479 = makeBot()
      at479.data.settings.slPerc = -0.0479
      expect(at479.tpSl(CLOSE_PRICE).value).to.equal('sl')
      const at481 = makeBot()
      at481.data.settings.slPerc = -0.0481
      expect(at481.tpSl(CLOSE_PRICE).value).to.equal('none')
    })
  })

  describe('§1.1.2 a -4 % stop-loss triggers at -4 %', () => {
    it('triggers once the position is truly 4 % down', () => {
      expect(truePerc(SL_DUE_PRICE) * 100).to.be.closeTo(-4, 1e-6)
      const bot = makeBot()
      expect(bot.tpSl(SL_DUE_PRICE).value).to.equal('sl')
    })

    it('does not run on to a 4.8 % loss before firing', () => {
      // The price the unfixed code needed. If the bot is still not stopped
      // here, the stop-loss is late by more than 0.5 pp.
      const bot = makeBot()
      const res = bot.tpSl(CLOSE_PRICE)
      expect(res.value).to.equal('sl')
      expect(bot.logs[0]).to.contain('-4.8')
    })

    it('reports the same percentage it stopped on', () => {
      const bot = makeBot()
      bot.tpSl(SL_DUE_PRICE)
      expect(bot.logs[0]).to.contain('Position unPnL -4%')
    })
  })

  describe('§1.1.2 the same correction on a short', () => {
    /** A short is overstated by the factor, so its stop fires EARLY. */
    const makeShort = () => {
      const bot = makeBot()
      bot.data.position = {
        side: PositionSide.SHORT,
        qty: POSITION.qty,
        price: POSITION.price,
      }
      return bot
    }
    const shortTruePerc = (price: number) =>
      (POSITION.qty * (POSITION.price - price) + REALIZED) / INITIAL_VALUE

    it('does not trigger a -4 % stop while the short is only 3 % down', () => {
      const price =
        POSITION.price - (-0.03 * INITIAL_VALUE - REALIZED) / POSITION.qty
      expect(shortTruePerc(price) * 100).to.be.closeTo(-3, 1e-6)
      expect(makeShort().tpSl(price).value).to.equal('none')
    })

    it('triggers a -4 % stop once the short is truly 4 % down', () => {
      const price =
        POSITION.price - (SL_PERC * INITIAL_VALUE - REALIZED) / POSITION.qty
      expect(shortTruePerc(price) * 100).to.be.closeTo(-4, 1e-6)
      expect(makeShort().tpSl(price).value).to.equal('sl')
    })

    it('does not stop the short early, at a true -3.6 % loss', () => {
      // The price at which the `lastPrice / entry` factor made the unfixed
      // code read -4.00 % on a short that was really only 3.60 % down.
      const price = 0.2329265
      expect(shortTruePerc(price) * 100).to.be.closeTo(-3.6, 0.01)
      expect(makeShort().tpSl(price).value).to.equal('none')
    })
  })

  describe('§1.1.3 the drawdown of the window the bot stops in', () => {
    // `any` so that the file still compiles before the removal path exists —
    // the red run then fails on "removeBotStats is not a function", which IS
    // spec §1.2.3 ("GridMonitor has no removal path at all").
    const monitor = GridMonitor.getInstance() as any
    let writes: { filter: any; update: any }[] = []
    let original: any

    before(() => {
      original = (botDb as any).updateData
      ;(botDb as any).updateData = (filter: any, update: any) => {
        writes.push({ filter, update })
        return Promise.resolve({ status: 'OK', data: {} })
      }
    })

    after(() => {
      ;(botDb as any).updateData = original
    })

    beforeEach(() => {
      writes = []
      // `stats` is private on the singleton; a fresh id per test is cheaper
      // and safer than reaching into it.
    })

    it('measures the drawdown as the signed price delta', async () => {
      const id = `grid-064-dd-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 20, 14, 1, 16, 593)
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: CLOSE_PRICE, time: t0 + 48_757 } as any,
        gridInput({ _id: id }),
      )
      expect(writes).to.have.length(1)
      expect(writes[0].filter._id).to.equal(id)
      expect(writes[0].update.$max['stats.drawdownPercent']).to.be.closeTo(
        Math.abs(truePerc(CLOSE_PRICE)),
        1e-6,
      )
    })

    it('flushes the last window instead of discarding it', async () => {
      const id = `grid-064-flush-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 20, 14, 1, 16, 593)
      // One sample opens the window; the bot stops 48.7 s later, before the
      // next sample is due, exactly as the reported bot did (spec §2.2).
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      expect(
        writes,
        'nothing is written while the window is open',
      ).to.have.length(0)
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: CLOSE_PRICE, time: t0 + 48_757 } as any,
        gridInput({ _id: id }),
      )
      expect(writes, 'the window is flushed on removal').to.have.length(1)
      expect(
        writes[0].update.$max['stats.drawdownPercent'],
        'and the flush carries the deepest point of that window',
      ).to.be.greaterThan(0.045)
    })

    it('§4.4 never increments a negative interval', async () => {
      const id = `grid-064-clock-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 20, 14, 1, 16, 593)
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      // A flush clocked BEFORE the stream time the window opened on.
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: CLOSE_PRICE, time: t0 - 5_000 } as any,
        gridInput({ _id: id }),
      )
      const inc = writes[0].update.$inc
      expect(inc['stats.timeInLoss']).to.be.at.least(0)
      expect(inc['stats.timeInProfit']).to.be.at.least(0)
      expect(inc['stats.trackTime']).to.be.at.least(0)
    })

    it('drops the bot from memory so a second removal writes nothing', async () => {
      const id = `grid-064-twice-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 20, 14, 1, 16, 593)
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: CLOSE_PRICE, time: t0 + 1_000 } as any,
        gridInput({ _id: id }),
      )
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: CLOSE_PRICE, time: t0 + 2_000 } as any,
        gridInput({ _id: id }),
      )
      expect(writes).to.have.length(1)
    })
  })

  describe('§1.1.3 the run-up of the window a take-profit stops in', () => {
    // The same gap, on the other side of the trade. A bot that stops on its
    // take-profit closes in PROFIT, so the measurement the final window holds
    // is a run-up, not a drawdown — and it was discarded by the same missing
    // removal path. Reported shape: a bot the engine stopped on a logged
    // `Position unPnL 4.8%, in settings 3%, TP trigger` stored a
    // `runUpPercent` of 2.6 %, i.e. the window that fired the stop was never
    // written.
    const monitor = GridMonitor.getInstance() as any
    let writes: { filter: any; update: any }[] = []
    let original: any

    /** The price at which this position's total result is truly +4.80 %. */
    const TP_PRICE = 0.22990883473394494

    before(() => {
      original = (botDb as any).updateData
      ;(botDb as any).updateData = (filter: any, update: any) => {
        writes.push({ filter, update })
        return Promise.resolve({ status: 'OK', data: {} })
      }
    })

    after(() => {
      ;(botDb as any).updateData = original
    })

    beforeEach(() => {
      writes = []
    })

    it('flushes the run-up of the window instead of discarding it', async () => {
      const id = `grid-064-runup-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 21, 6, 56, 2, 439)
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      expect(
        writes,
        'nothing is written while the window is open',
      ).to.have.length(0)
      // The bot stops 106 s later — the same gap the reported bot showed
      // between its `timeCountStart` and its stop.
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: TP_PRICE, time: t0 + 106_075 } as any,
        gridInput({ _id: id }),
      )
      expect(writes, 'the window is flushed on removal').to.have.length(1)
      expect(
        writes[0].update.$max['stats.runUpPercent'],
        'and it carries the run-up the take-profit fired on',
      ).to.be.closeTo(0.048, 1e-6)
    })

    it('measures the run-up as the signed price delta, like the close does', async () => {
      const id = `grid-064-runup-delta-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 21, 6, 56, 2, 439)
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: TP_PRICE, time: t0 + 106_075 } as any,
        gridInput({ _id: id }),
      )
      // `qty * perc * lastPrice` reads 5.0813 % here: on a LONG in profit the
      // `lastPrice / entry` factor is above 1, so it OVERstates the run-up,
      // the mirror of the understated loss that let the stop-loss run on.
      expect(writes[0].update.$max['stats.runUpPercent']).to.not.be.closeTo(
        0.050813,
        1e-4,
      )
    })

    it('counts the window as time in profit, not time in loss', async () => {
      const id = `grid-064-runup-time-${Date.now()}`
      const t0 = Date.UTC(2026, 8, 21, 6, 56, 2, 439)
      await monitor.addBotStats(
        { symbol: 'SYNUSDT', price: INITIAL_PRICE, time: t0 } as any,
        gridInput({ _id: id }),
      )
      await monitor.removeBotStats(
        { symbol: 'SYNUSDT', price: TP_PRICE, time: t0 + 106_075 } as any,
        gridInput({ _id: id }),
      )
      const inc = writes[0].update.$inc
      expect(inc['stats.timeInProfit']).to.be.greaterThan(0)
      expect(inc['stats.timeInLoss']).to.equal(0)
    })
  })

  describe('§4.2 the flush never holds up the stop', () => {
    let original: any

    before(() => {
      original = DealStats.getInstance().removeStats
    })

    after(() => {
      ;(DealStats.getInstance() as any).removeStats = original
    })

    it('carries the final measurement through when the flush answers', async () => {
      const seen: any[] = []
      ;(DealStats.getInstance() as any).removeStats = async (d: any) => {
        seen.push(d)
      }
      const bot = makeBot()
      await bot.afterBotStop()
      expect(seen).to.have.length(1)
      expect(seen[0].botType).to.equal('grid')
      expect(seen[0].payload.data.price).to.equal(CLOSE_PRICE)
      expect(bot.warnings).to.have.length(0)
    })

    it('gives up on a flush that never settles instead of blocking the close', async function () {
      // The `IdMute` wait queue is a `getFixedArray`: an evicted waiter's
      // promise never resolves. Unbounded, that would hold the position open
      // through its own stop-loss.
      this.timeout(30_000)
      ;(DealStats.getInstance() as any).removeStats = () =>
        new Promise(() => {})
      const bot = makeBot()
      const started = Date.now()
      await bot.afterBotStop()
      const waited = Date.now() - started
      expect(waited, 'it waits for the flush').to.be.at.least(4_000)
      expect(waited, 'but not forever').to.be.below(15_000)
      expect(bot.warnings.join(' ')).to.contain('Stats flush on stop')
    })
  })
})
