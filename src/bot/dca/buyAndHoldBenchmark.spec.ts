process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the Buy & Hold benchmark — spec 006.
 *
 * Replays the recorded state of paper DCA bot 6926c265aeee0f2e5dac9aa4: the
 * benchmark is pinned to `XIONUSDT`, Bybit has delisted it, `getLatestPrice`
 * returns its documented 0-on-failure, and the old code booked that 0 as the
 * benchmark rate — leaving `result = -startBalance.asset` and
 * `perc = -1.00046`, a figure no real buy-and-hold can produce.
 *
 * Run: `npm test` from `core/` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { isBenchmarkRate, buyAndHoldOutcome } from './buyAndHoldBenchmark'

// The bot's stats, as recorded in production on 2026-09-04. `usdRate` is 1:
// the recorded `result` is exactly `-startBalanceAsset`, which pins it.
const recorded = {
  startBalanceAsset: 114330.73529999999,
  startBalanceUsd: 114278.14316176198,
  startPrice: 0.89, // XIONUSDT, when the reference was pinned
  usdRate: 1,
}
// What production actually holds for this bot.
const RECORDED_RESULT = -114330.73529999999
const RECORDED_PERC = -1.0004602116973809

describe('buyAndHoldBenchmark', () => {
  describe('isBenchmarkRate — §3.1 only a real positive price is a rate', () => {
    it('a live price is a rate', () => {
      expect(isBenchmarkRate(0.89)).to.equal(true)
    })
    it("getLatestPrice's 0-on-failure is not a rate", () => {
      expect(isBenchmarkRate(0)).to.equal(false)
    })
    it('a negative price is not a rate', () => {
      expect(isBenchmarkRate(-1)).to.equal(false)
    })
    it('NaN is not a rate', () => {
      expect(isBenchmarkRate(NaN)).to.equal(false)
    })
    it('Infinity is not a rate', () => {
      expect(isBenchmarkRate(Infinity)).to.equal(false)
    })
    it('an absent price is not a rate', () => {
      expect(isBenchmarkRate(undefined)).to.equal(false)
    })
  })

  describe('buyAndHoldOutcome — §1.1.1 an unpriceable reference computes nothing', () => {
    it('the delisted XIONUSDT reference yields no outcome, not -100%', () => {
      // §1.2.1: this is the exact input that produced result
      // -114330.73529999999 / perc -1.0004602116973809 in production.
      expect(buyAndHoldOutcome({ ...recorded, rate: 0 })).to.equal(null)
    })

    it('the zero rate is what produced the recorded numbers — diagnosis check', () => {
      // The old, unguarded arithmetic, applied to a 0 rate, reproduces exactly
      // what production holds. This is what pins the root cause to `rate === 0`
      // rather than to a stale `startPrice` or a bad `usdRate`.
      const asset = (recorded.startBalanceAsset / recorded.startPrice) * 0
      const result = (asset - recorded.startBalanceAsset) * recorded.usdRate
      expect(result).to.equal(RECORDED_RESULT)
      expect(result / recorded.startBalanceUsd).to.equal(RECORDED_PERC)
    })

    it('a real rate, however small, still computes', () => {
      // Guarding on `rate > 0` must not swallow a genuinely collapsed asset —
      // that reading is real and belongs on the bot.
      const out = buyAndHoldOutcome({ ...recorded, rate: 1e-9 })
      expect(out).to.not.equal(null)
      expect(out!.asset).to.be.greaterThan(0)
    })

    it('a live reference still computes the benchmark', () => {
      // Reference halved: holding is worth half, so the benchmark is ~-50%.
      const out = buyAndHoldOutcome({
        startBalanceAsset: 100,
        startBalanceUsd: 100,
        startPrice: 2,
        rate: 1,
        usdRate: 1,
      })
      expect(out).to.not.equal(null)
      expect(out!.asset).to.equal(50)
      expect(out!.result).to.equal(-50)
      expect(out!.perc).to.equal(-0.5)
    })

    it('applies the usd rate to the result', () => {
      const out = buyAndHoldOutcome({
        startBalanceAsset: 100,
        startBalanceUsd: 200,
        startPrice: 2,
        rate: 1,
        usdRate: 2,
      })
      expect(out!.result).to.equal(-100)
      expect(out!.perc).to.equal(-0.5)
    })

    it('a reference price of 0 yields no outcome', () => {
      // The `startBalance.asset / 0 = Infinity` hazard already noted in
      // dcaHelper's botUpdateStats comment.
      expect(
        buyAndHoldOutcome({ ...recorded, startPrice: 0, rate: 0.89 }),
      ).to.equal(null)
    })

    it('a zero start balance yields no outcome', () => {
      expect(
        buyAndHoldOutcome({ ...recorded, startBalanceUsd: 0, rate: 0.89 }),
      ).to.equal(null)
    })
  })

  describe('carryForwardBenchmark — §1.1.1 the chart keeps its last point', () => {
    it('keeps today’s point when there is one', async () => {
      const { carryForwardBenchmark } = await import('./buyAndHoldBenchmark')
      expect(carryForwardBenchmark(1200, 900, 500)).to.equal(1200)
    })
    it('falls back to the previous point', async () => {
      const { carryForwardBenchmark } = await import('./buyAndHoldBenchmark')
      expect(carryForwardBenchmark(undefined, 900, 500)).to.equal(900)
    })
    it('falls back to the start balance', async () => {
      const { carryForwardBenchmark } = await import('./buyAndHoldBenchmark')
      expect(carryForwardBenchmark(undefined, undefined, 500)).to.equal(500)
    })
    it('steps over a non-finite carry — never writes a flat zero over history', async () => {
      const { carryForwardBenchmark } = await import('./buyAndHoldBenchmark')
      expect(carryForwardBenchmark(NaN, 900, 500)).to.equal(900)
      expect(carryForwardBenchmark(NaN, NaN, NaN)).to.equal(0)
    })
  })
})
