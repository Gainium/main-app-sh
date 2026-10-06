process.env.NODE_ENV = 'testing'

import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  buildBotWindowPipeline,
  dealsClosedSince,
  foldBotWindowStats,
  type BotWindowDeal,
} from './botWindowStats'

const H = 60 * 60 * 1000
const deal = (
  start: number,
  end: number | null,
  profitUsd: number,
  capital = 100,
): BotWindowDeal => ({ start, end, capital, profit: profitUsd, profitUsd })

describe('botWindowStats', () => {
  it('folds wins, losses, profit factor and win rate from closed deals', () => {
    const s = foldBotWindowStats([
      deal(0, 1 * H, 10),
      deal(1 * H, 2 * H, -5),
      deal(2 * H, 3 * H, 0),
      deal(3 * H, 4 * H, 20),
    ])
    expect(s.closedDeals).to.equal(4)
    expect(s.wins).to.equal(2)
    expect(s.losses).to.equal(1)
    expect(s.winRate).to.equal(0.5)
    expect(s.realizedProfitUsd).to.equal(25)
    expect(s.grossProfitUsd).to.equal(30)
    expect(s.grossLossUsd).to.equal(-5)
    expect(s.profitFactor).to.equal(6)
    expect(s.avgDealDuration).to.equal(H)
    expect(s.firstCloseTime).to.equal(H)
    expect(s.maxDealProfitUsd).to.equal(20)
    expect(s.maxDealLossUsd).to.equal(-5)
    expect(s.avgDealProfitUsd).to.equal(15)
    expect(s.avgDealLossUsd).to.equal(-5)
  })

  it('streaks and per-outcome durations', () => {
    const s = foldBotWindowStats([
      deal(0, 1 * H, 1),
      deal(1 * H, 3 * H, 1),
      deal(3 * H, 4 * H, 0), // break-even: neither, streak continues
      deal(4 * H, 5 * H, 1),
      deal(5 * H, 6 * H, -1),
      deal(6 * H, 9 * H, -1),
      deal(9 * H, 10 * H, 1),
    ])
    expect(s.maxConsecutiveWins).to.equal(3)
    expect(s.maxConsecutiveLosses).to.equal(2)
    expect(s.maxWinningDealDuration).to.equal(2 * H)
    expect(s.avgWinningDealDuration).to.equal(((1 + 2 + 1 + 1) * H) / 4)
    expect(s.maxLosingDealDuration).to.equal(3 * H)
    expect(s.avgLosingDealDuration).to.equal(2 * H)
    expect(s.maxDealDuration).to.equal(3 * H)
  })

  it('return is over peak concurrent capital, open deals included', () => {
    const now = 10 * H
    const s = foldBotWindowStats(
      [
        deal(0, 2 * H, 30, 100),
        deal(1 * H, 3 * H, 0, 100),
        deal(5 * H, null, 0, 250),
      ],
      null,
      now,
    )
    // Two 100 deals overlap (200); the open 250 deal alone is the peak.
    expect(s.peakCapitalUsd).to.equal(250)
    expect(s.returnOnPeakCapital).to.equal(30 / 250)
    expect(s.closedDeals).to.equal(2)
  })

  it('sequential deals re-using capital count once', () => {
    const s = foldBotWindowStats([deal(0, H, 1), deal(H, 2 * H, 1)])
    expect(s.peakCapitalUsd).to.equal(100)
  })

  it('drawdown is the deepest fall of realized equity from its peak', () => {
    const s = foldBotWindowStats([
      deal(0, 1 * H, 20),
      deal(1 * H, 2 * H, -10),
      deal(2 * H, 3 * H, -15),
      deal(3 * H, 4 * H, 40),
    ])
    // equity 100 → 120 → 110 → 95 → 135: fall 25 from 120.
    expect(s.maxDrawdownUsd).to.equal(25)
    expect(s.maxDrawdownPerc).to.be.closeTo(25 / 120, 1e-12)
  })

  it('orders by close time, not by input order', () => {
    const s = foldBotWindowStats([deal(2 * H, 3 * H, 40), deal(0, 1 * H, -30)])
    expect(s.maxDrawdownUsd).to.equal(30)
  })

  it('an empty window is all zeros, never NaN', () => {
    const s = foldBotWindowStats([], 123)
    expect(s.from).to.equal(123)
    expect(s.closedDeals).to.equal(0)
    expect(s.winRate).to.equal(0)
    expect(s.returnOnPeakCapital).to.equal(0)
    expect(s.profitFactor).to.equal(0)
    expect(s.firstCloseTime).to.equal(null)
  })

  it('non-finite values are read as zero', () => {
    const s = foldBotWindowStats([
      { start: 0, end: H, capital: NaN, profit: NaN, profitUsd: Infinity },
    ])
    expect(s.realizedProfitUsd).to.equal(0)
    expect(s.peakCapitalUsd).to.equal(0)
  })

  it('the since window keeps deals closed at or after it, and open deals', () => {
    const rows = [
      deal(0, 500, 1),
      deal(0, 1000, 2),
      deal(900, 2000, 3),
      deal(1500, null, 0),
    ]
    const since = dealsClosedSince(rows, 1000)
    // A deal opened before the change and closed after it is in the window.
    expect(since.map((d) => d.profitUsd)).to.deep.equal([2, 3, 0])
  })

  it('reads every deal of the bots, closed with a price or open', () => {
    const [match] = buildBotWindowPipeline(['b1']) as any[]
    const or = match.$match.$or
    expect(match.$match.botId).to.deep.equal({ $in: ['b1'] })
    expect(or[0].closeTime).to.equal(undefined)
    expect(or[0].initialPrice).to.deep.equal({ $gt: 0 })
    expect(or[1].status.$in).to.include('open')
  })
})
