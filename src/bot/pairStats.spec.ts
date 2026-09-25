process.env.NODE_ENV = 'testing'

import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  buildPairCapitalPipeline,
  buildPairGrossPipeline,
  buildPairStatsPipeline,
  peakCapitalBySymbol,
  shapePairGross,
  shapePairStats,
  type PairStatsGroup,
} from './pairStats'

const group = (over: Partial<PairStatsGroup>): PairStatsGroup => ({
  _id: 'BTC-USDC',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  closedDeals: 0,
  wins: 0,
  losses: 0,
  realizedProfitUsd: 0,
  grossProfitUsd: 0,
  grossLossUsd: 0,
  feesQuote: 0,
  totalDuration: 0,
  maxDealDuration: 0,
  maxDrawdownPerc: 0,
  openDeals: 0,
  unrealizedProfitUsd: 0,
  openCapitalUsd: 0,
  ...over,
})

describe('pairStats — buildPairStatsPipeline', () => {
  it('scopes to the given bots and windows only the closed deals', () => {
    const [stage] = buildPairStatsPipeline(['a', 'b'], { from: 10, to: 20 })
    const match = (stage as { $match: any }).$match
    expect(match.botId).to.deep.equal({ $in: ['a', 'b'] })
    const [closed, open] = match.$or
    expect(closed.closeTime).to.deep.equal({ $gte: 10, $lte: 20 })
    expect(closed.initialPrice).to.deep.equal({ $gt: 0 })
    expect(open).to.not.have.property('closeTime')
  })

  it('adds no close-time window when no range is given', () => {
    const [stage] = buildPairStatsPipeline(['a'])
    expect((stage as { $match: any }).$match.$or[0]).to.not.have.property(
      'closeTime',
    )
  })

  it('ignores non-finite range bounds', () => {
    const [stage] = buildPairStatsPipeline(['a'], { from: NaN })
    expect((stage as { $match: any }).$match.$or[0]).to.not.have.property(
      'closeTime',
    )
  })
})

describe('pairStats — shapePairStats', () => {
  it('derives profit factor from money and average duration from closed deals', () => {
    const [row] = shapePairStats([
      group({
        closedDeals: 4,
        wins: 3,
        losses: 1,
        grossProfitUsd: 9,
        grossLossUsd: -3,
        totalDuration: 400,
      }),
    ])
    expect(row?.profitFactor).to.equal(3)
    expect(row?.avgDealDuration).to.equal(100)
  })

  it('keeps a pair with only open deals, at zero closed-deal averages', () => {
    const [row] = shapePairStats([
      group({ openDeals: 2, unrealizedProfitUsd: -4.5, totalDuration: 0 }),
    ])
    expect(row?.closedDeals).to.equal(0)
    expect(row?.avgDealDuration).to.equal(0)
    expect(row?.unrealizedProfitUsd).to.equal(-4.5)
  })

  it('adds a zero row for a configured pair that never traded, sorted by symbol', () => {
    const rows = shapePairStats(
      [group({ _id: 'SOL-USDC', closedDeals: 1, wins: 1 })],
      [
        { symbol: 'SOL-USDC', baseAsset: 'SOL', quoteAsset: 'USDC' },
        { symbol: 'ADA-USDC', baseAsset: 'ADA', quoteAsset: 'USDC' },
      ],
    )
    expect(rows.map((r) => r.symbol)).to.deep.equal(['ADA-USDC', 'SOL-USDC'])
    expect(rows[0]?.closedDeals).to.equal(0)
    expect(rows[0]?.quoteAsset).to.equal('USDC')
  })

  it('turns null / NaN aggregate values into 0', () => {
    const [row] = shapePairStats([
      group({ feesQuote: NaN, realizedProfitUsd: null as unknown as number }),
    ])
    expect(row?.feesQuote).to.equal(0)
    expect(row?.realizedProfitUsd).to.equal(0)
  })
})

describe('pairStats — gross seed for the engine', () => {
  it('matches the engine population: the pair, closed + canceled, since the reset, minus the closing deal', () => {
    const [stage] = buildPairGrossPipeline('bot1', 'BTC-USDC', 1234, 'deal9')
    const match = (stage as { $match: any }).$match
    expect(match.botId).to.equal('bot1')
    expect(match['symbol.symbol']).to.equal('BTC-USDC')
    expect(match.status.$in).to.have.members(['closed', 'canceled'])
    expect(match.createTime).to.deep.equal({ $gte: 1234 })
    expect(match.$expr).to.deep.equal({
      $ne: [{ $toString: '$_id' }, 'deal9'],
    })
  })

  it('counts from the beginning when the bot was never reset', () => {
    const [stage] = buildPairGrossPipeline('bot1', 'BTC-USDC', undefined, 'x')
    expect((stage as { $match: any }).$match.createTime).to.deep.equal({
      $gte: 0,
    })
  })

  it('reads a pair with no earlier deals as zero, not as a failure', () => {
    expect(shapePairGross([])).to.deep.equal({
      grossProfitUsd: 0,
      grossProfitAsset: 0,
      grossLossUsd: 0,
      grossLossAsset: 0,
    })
  })
})

describe('pairStats — peak concurrent capital', () => {
  const deal = (
    symbol: string,
    start: number,
    end: number | null,
    capital: number,
  ) => ({
    symbol,
    start,
    end,
    capital,
  })

  it('sums deals that are open together, not the largest single deal', () => {
    // Three $20 deals overlapping between t=30 and t=40.
    const peaks = peakCapitalBySymbol([
      deal('BTC-USDC', 10, 50, 20),
      deal('BTC-USDC', 20, 60, 20),
      deal('BTC-USDC', 30, 40, 20),
    ])
    expect(peaks.get('BTC-USDC')).to.equal(60)
  })

  it('a deal closing as the next opens re-uses the same capital', () => {
    const peaks = peakCapitalBySymbol([
      deal('SOL-USDC', 0, 100, 20),
      deal('SOL-USDC', 100, 200, 20),
      deal('SOL-USDC', 200, 300, 20),
    ])
    expect(peaks.get('SOL-USDC')).to.equal(20)
  })

  it('holds an open deal until now and keeps pairs apart', () => {
    const peaks = peakCapitalBySymbol(
      [
        deal('ETH-USDC', 10, null, 30),
        deal('ETH-USDC', 500, 600, 30),
        deal('ADA-USDC', 10, 20, 5),
      ],
      1000,
    )
    expect(peaks.get('ETH-USDC')).to.equal(60)
    expect(peaks.get('ADA-USDC')).to.equal(5)
  })

  it('ignores deals with no capital or no start', () => {
    const peaks = peakCapitalBySymbol([
      deal('X-USDC', 0, 10, 50),
      deal('X-USDC', 5, 10, 0),
    ])
    expect(peaks.has('X-USDC')).to.equal(false)
  })

  it('projects the deals of the same population as the stats', () => {
    const [match, project] = buildPairCapitalPipeline(['a'], { from: 1 })
    const stats = buildPairStatsPipeline(['a'], { from: 1 })[0]
    expect(match).to.deep.equal(stats)
    expect(
      Object.keys((project as { $project: object }).$project),
    ).to.include.members(['symbol', 'start', 'end', 'capital'])
  })

  it('carries the peak onto the pair row', () => {
    const [row] = shapePairStats(
      [group({ closedDeals: 2, realizedProfitUsd: 6 })],
      [],
      new Map([['BTC-USDC', 120]]),
    )
    expect(row?.peakCapitalUsd).to.equal(120)
  })
})
