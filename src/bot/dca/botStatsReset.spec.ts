process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the stats reset that a settings change triggers.
 * Spec: main-app `specs/013.sizing-edit-wipes-the-equity-chart.md`.
 *
 * An order-sizing edit invalidates every aggregate in `stats` — they are all
 * denominated against a starting balance the edit just moved — but it does not
 * invalidate `stats.chart`, which is the bot's daily equity / realized-profit /
 * buy-and-hold series in absolute USD. Nulling the whole document threw the
 * series away with the aggregates, and only a *running* bot ever rebuilds one
 * (`updateEquityStats` is armed for the next midnight, `botUpdateStats` fires
 * on a deal close), so a bot stopped after such an edit read "No data" on its
 * card for good.
 *
 * Run: `cd core && npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { emptyBotStats, statsAfterReset } from './botStatsReset'
import type { BotStats } from '../../../types'

/** A stats document mid-life: real aggregates and a three-day equity series. */
const livedInStats = (): BotStats => {
  const stats = emptyBotStats()
  stats.numerical.general.startBalance = { usd: 1000, asset: 1000 }
  stats.numerical.general.netProfitPerc = 0.042
  stats.numerical.deals.profit = 7
  stats.numerical.ratios.buyAndHold.symbol = 'ETHUSDT'
  stats.numerical.ratios.buyAndHold.startPrice = 2500
  stats.duration.general.maxDealDuration = 90_000
  stats.chart = [
    {
      time: 1789084800000,
      equity: 1000,
      buyAndHold: 1000,
      realizedProfit: 1000,
    },
    {
      time: 1789171200000,
      equity: 1020,
      buyAndHold: 1010,
      realizedProfit: 1015,
    },
    {
      time: 1789257600000,
      equity: 1042,
      buyAndHold: 1005,
      realizedProfit: 1042,
    },
  ]
  return stats
}

describe('botStatsReset', () => {
  describe('§1.1 an order-sizing edit keeps the equity series', () => {
    it('carries `chart` across the reset', () => {
      const previous = livedInStats()
      const next = statsAfterReset(previous, 'keepChart')
      expect(next, 'the sizing reset must not null the whole document').to.not
        .be.null
      expect(next?.chart).to.deep.equal(previous.chart)
    })

    it('still resets every aggregate accumulated over deals', () => {
      const next = statsAfterReset(livedInStats(), 'keepChart')
      const empty = emptyBotStats()
      expect(next?.numerical.general.netProfitPerc).to.equal(
        empty.numerical.general.netProfitPerc,
      )
      expect(next?.numerical.deals).to.deep.equal(empty.numerical.deals)
      expect(next?.numerical.profit).to.deep.equal(empty.numerical.profit)
      expect(next?.numerical.loss).to.deep.equal(empty.numerical.loss)
      expect(next?.numerical.usage).to.deep.equal(empty.numerical.usage)
      expect(next?.duration).to.deep.equal(empty.duration)
      // The ratios accumulated over deals reset; only the benchmark baseline
      // below survives with the series.
      expect(next?.numerical.ratios.profitFactor).to.equal(0)
      expect(next?.numerical.ratios.sharpeRatio).to.equal(0)
      expect(next?.numerical.ratios.sortinoRatio).to.equal(0)
      expect(next?.numerical.ratios.cwr).to.equal(0)
    })

    it('carries the baseline the series is denominated against', () => {
      // `equity` is `startBalance + profit`, `realizedProfit` is seeded at
      // `startBalance.usd`, `buyAndHold` is priced off `startPrice`, and the
      // drawer subtracts `startBalance.usd` back out. Re-seeding that baseline
      // under a preserved series (the sizing change moves it: it is
      // `usage.max` × `maxNumberOfOpenDeals`) steps the equity line and leaves
      // realized profit off by the difference for good.
      const previous = livedInStats()
      const next = statsAfterReset(previous, 'keepChart')
      expect(next?.numerical.general.startBalance).to.deep.equal({
        usd: 1000,
        asset: 1000,
      })
      expect(next?.numerical.ratios.buyAndHold.symbol).to.equal('ETHUSDT')
      expect(next?.numerical.ratios.buyAndHold.startPrice).to.equal(2500)
    })

    it('returns a document the engine can keep accumulating on', () => {
      // `updateEquityStats` / `botUpdateStats` read `stats.numerical.general`
      // and `stats.chart` without guarding either. A partial document here
      // (chart only) would throw on the next tick instead of rebuilding.
      const next = statsAfterReset(livedInStats(), 'keepChart')
      expect(next?.numerical?.general?.startBalance?.usd).to.be.a('number')
      expect(Array.isArray(next?.chart)).to.equal(true)
      // A preserved baseline is also what stops `updateEquityStats` from
      // re-seeding one: it only seeds when `startBalance.asset` is falsy.
      expect(next?.numerical.general.startBalance.asset).to.be.greaterThan(0)
    })

    it('does not alias the previous document', () => {
      // The caller still holds `oldSettings.stats`; mutating it from here would
      // corrupt the very series being preserved.
      const previous = livedInStats()
      const next = statsAfterReset(previous, 'keepChart')
      next!.chart[0].equity = -1
      next!.numerical.deals.profit = 99
      expect(previous.chart[0].equity).to.equal(1000)
      expect(previous.numerical.deals.profit).to.equal(7)
    })
  })

  describe('§1.1 a profit-currency change is still a full wipe', () => {
    it('returns null so the document is cleared', () => {
      // `resetStats` re-denominates the whole document; there is nothing worth
      // carrying, and the engine rebuilds from `getEmptyStats()` on next tick.
      expect(statsAfterReset(livedInStats(), 'all')).to.be.null
    })
  })

  describe('§1.2 nothing to preserve stays a null write', () => {
    it('a bot with no stats yet', () => {
      expect(statsAfterReset(null, 'keepChart')).to.be.null
      expect(statsAfterReset(undefined, 'keepChart')).to.be.null
    })

    it('a bot whose series is empty', () => {
      const previous = livedInStats()
      previous.chart = []
      expect(statsAfterReset(previous, 'keepChart')).to.be.null
    })

    it('a series of non-finite points, which the card cannot plot anyway', () => {
      const previous = livedInStats()
      previous.chart = [
        { time: NaN, equity: 1, buyAndHold: 1, realizedProfit: 1 },
      ]
      expect(statsAfterReset(previous, 'keepChart')).to.be.null
    })

    it('a series whose baseline is missing, which cannot be read back', () => {
      // Every point is denominated against `startBalance`; without it the
      // dashboards subtract the wrong seed, so the series is not preservable.
      const previous = livedInStats()
      previous.numerical.general.startBalance = { usd: 0, asset: 0 }
      expect(statsAfterReset(previous, 'keepChart')).to.be.null
    })
  })

  describe('§1.2 the carried series is plain, finite data', () => {
    it('drops points the chart writers would carry a NaN forward from', () => {
      const previous = livedInStats()
      previous.chart = [
        ...previous.chart,
        { time: 1789344000000, equity: NaN, buyAndHold: 1, realizedProfit: 1 },
      ]
      const next = statsAfterReset(previous, 'keepChart')
      expect(next?.chart).to.have.length(3)
      expect(next?.chart.every((p) => Number.isFinite(p.equity))).to.equal(true)
    })

    it('copies the points rather than handing over mongoose subdocuments', () => {
      const previous = livedInStats()
      const next = statsAfterReset(previous, 'keepChart')
      expect(next?.chart[0]).to.not.equal(previous.chart[0])
      expect(Object.keys(next!.chart[0]).sort()).to.deep.equal([
        'buyAndHold',
        'equity',
        'realizedProfit',
        'time',
      ])
    })
  })

  describe('emptyBotStats is the shape dcaHelper seeds', () => {
    it('has zeroed aggregates and an empty series', () => {
      const empty = emptyBotStats()
      expect(empty.chart).to.deep.equal([])
      expect(empty.numerical.general.startBalance).to.deep.equal({
        usd: 0,
        asset: 0,
      })
      expect(empty.numerical.ratios.buyAndHold.startPrice).to.equal(0)
    })

    it('returns a fresh object each call', () => {
      const a = emptyBotStats()
      a.numerical.deals.profit = 5
      expect(emptyBotStats().numerical.deals.profit).to.equal(0)
    })
  })
})
