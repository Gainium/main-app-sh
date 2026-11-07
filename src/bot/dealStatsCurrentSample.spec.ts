process.env.NODE_ENV = 'testing'

/**
 * Spec 229 — the stored fee-inclusive uPnL is the value at the sample that
 * persisted it, not the sample before; a never-stored deal is stored on its
 * first measurement; and the next window starts from the extremes the last
 * one wrote, so a deal deeper in drawdown than its (stale) bot snapshot is not
 * rewritten every window.
 *
 * Drives the real `DealMonitor` with the deal collection stubbed. A deal is
 * sampled at most once a minute and only on a price change, so on a quiet
 * pair the samples below can be an hour apart.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { BotMarginTypeEnum, StrategyEnum } from '../../types'
import { DealMonitor, NET_STATS_REFRESH_MS } from './dealMonitor'
import { dcaDealsDb } from '../db/dbInit'
import { computeDealUnrealizedNet } from './dealUnrealizedPnl'

const T0 = Date.UTC(2026, 10, 6, 20, 0, 0)
const FEE = 0.001
const MIN = 60_000

const makeDeal = (id: string, stats: Record<string, unknown> = {}) =>
  ({
    _id: id,
    botId: 'bot-229',
    settings: {
      futures: false,
      coinm: false,
      marginType: BotMarginTypeEnum.inherit,
      leverage: 1,
      profitCurrency: 'quote',
    },
    avgPrice: 100,
    strategy: StrategyEnum.long,
    currentBalances: { base: 10, quote: 0 },
    initialBalances: { base: 0, quote: 1000 },
    profit: { total: 0, pureBase: 0, pureQuote: 0 },
    usage: {
      current: { base: 10, quote: 1000 },
      max: { base: 10, quote: 1000 },
    },
    feePaid: { base: 0, quote: 0 },
    stats: {
      drawdownPercent: 0,
      runUpPercent: 0,
      timeInLoss: 0,
      timeInProfit: 0,
      trackTime: 0,
      timeCountStart: 0,
      currentCount: null,
      unrealizedProfit: 0,
      usage: 0,
      maxUsage: 0,
      ...stats,
    },
    flags: [],
    tpFilledHistory: [],
    reduceFunds: [],
  }) as any

const net = (deal: any, price: number) =>
  computeDealUnrealizedNet(deal, price, 1, FEE, false)!

describe('stored uPnL is the persisting sample, new deals are stored at once (spec 229)', () => {
  const monitor = DealMonitor.getInstance()
  let writes: { filter: any; update: any }[] = []
  let original: any

  before(() => {
    original = (dcaDealsDb as any).updateData
    ;(dcaDealsDb as any).updateData = (filter: any, update: any) => {
      writes.push({ filter, update })
      return Promise.resolve({ status: 'OK', data: {} })
    }
  })
  after(() => {
    ;(dcaDealsDb as any).updateData = original
  })
  beforeEach(() => {
    writes = []
  })

  const tick = (deal: any, price: number, time: number) =>
    monitor.addDealStats(
      false,
      { symbol: 'X-USDC', price, time } as any,
      1,
      deal,
      FEE,
    )

  it('§1.1.1 a quiet deal stores the price of the sample that wrote it', async () => {
    // stored an hour ago at 99; then two trades 23 min apart, no new extreme
    const deal = makeDeal('quiet', {
      updatedAt: new Date(T0 - 60 * MIN),
      unrealizedProfitNet: net(makeDeal('x'), 99).unrealizedUsd,
      drawdownPercent: 0.5,
    })
    await tick(deal, 98.3, T0)
    await tick(deal, 97.5, T0 + 23 * MIN)
    await tick(deal, 97.5, T0 + 24 * MIN)
    const last = writes[writes.length - 1]
    expect(last, 'a write happened').to.not.equal(undefined)
    expect(last.update.$set['stats.unrealizedProfitNet']).to.be.closeTo(
      net(deal, 97.5).unrealizedUsd,
      1e-9,
    )
    // and it was written by the 97.5 sample itself, not a later one
    expect(+last.update.$set['stats.updatedAt']).to.be.at.most(T0 + 23 * MIN)
    await monitor.removeDealStats('quiet')
  })

  it('§1.1.1 a changed window is written by the sample that changed it', async () => {
    // stored 9 min ago: fresh at the first sample (spec 230 §1.1.1 does not
    // apply), past the refresh interval at the second
    const deal = makeDeal('one-sample', {
      updatedAt: new Date(T0 - 9 * MIN),
      unrealizedProfitNet: net(makeDeal('x'), 99).unrealizedUsd,
      drawdownPercent: 0.5,
    })
    await tick(deal, 98.3, T0) // opens the window, measures it
    writes = []
    await tick(deal, 97.5, T0 + 2 * MIN) // > 30 s on, net moved, interval passed
    expect(writes).to.have.length(1)
    expect(writes[0].update.$set['stats.unrealizedProfitNet']).to.be.closeTo(
      net(deal, 97.5).unrealizedUsd,
      1e-9,
    )
    await monitor.removeDealStats('one-sample')
  })

  it('§1.1.2 a never-stored deal is stored on its first sample', async () => {
    const deal = makeDeal('new-deal')
    await tick(deal, 99.5, T0)
    expect(writes).to.have.length(1)
    const set = writes[0].update.$set
    expect(set['stats.unrealizedProfitNet']).to.be.closeTo(
      net(deal, 99.5).unrealizedUsd,
      1e-9,
    )
    expect(set['stats.unrealizedPercentNet']).to.be.closeTo(
      net(deal, 99.5).percent,
      1e-9,
    )
    expect(set['stats.updatedAt']).to.be.instanceOf(Date)
    // once: later samples with no new extreme, inside the refresh interval,
    // write nothing
    await tick(deal, 99.6, T0 + MIN)
    await tick(deal, 99.55, T0 + 2 * MIN)
    expect(writes).to.have.length(1)
    await monitor.removeDealStats('new-deal')
  })

  it('§1.1.2 a deal whose uPnL cannot be computed is not force-written', async () => {
    const deal = makeDeal('no-rate')
    await monitor.addDealStats(
      false,
      { symbol: 'X-USDC', price: 99.5, time: T0 } as any,
      0, // no USD rate
      deal,
      FEE,
    )
    expect(writes).to.have.length(0)
    await monitor.removeDealStats('no-rate')
  })

  it('§1.1.3 the next window keeps the extremes the last one wrote', async () => {
    // the bot snapshot still says 0 drawdown; the deal is at -10 %
    const deal = makeDeal('deep', {
      updatedAt: new Date(T0 - 60 * MIN),
      unrealizedProfitNet: net(makeDeal('x'), 90).unrealizedUsd,
    })
    await tick(deal, 90, T0)
    await tick(deal, 89.9, T0 + MIN) // new extreme → written
    expect(writes).to.have.length(1)
    // drifting inside the extreme, inside the refresh interval: no rewrites
    await tick(deal, 90.1, T0 + 2 * MIN)
    await tick(deal, 90.0, T0 + 3 * MIN)
    await tick(deal, 90.2, T0 + 4 * MIN)
    expect(writes).to.have.length(1)
    // past the interval the moved value is written once more
    await tick(deal, 90.3, T0 + MIN + NET_STATS_REFRESH_MS + 1)
    expect(writes).to.have.length(2)
    await monitor.removeDealStats('deep')
  })

  it('spec 230 §1.1.1 a stale stored deal is written on its first sample after a load', async () => {
    // stored at 99 two hours ago (before a restart); the pair has not traded
    // since, so the first sample after the load is the only one it gets
    const deal = makeDeal('stale-on-load', {
      updatedAt: new Date(T0 - 120 * MIN),
      unrealizedProfitNet: net(makeDeal('x'), 99).unrealizedUsd,
      drawdownPercent: 0.5,
    })
    await tick(deal, 98.3, T0)
    expect(writes).to.have.length(1)
    expect(writes[0].update.$set['stats.unrealizedProfitNet']).to.be.closeTo(
      net(deal, 98.3).unrealizedUsd,
      1e-9,
    )
    expect(+writes[0].update.$set['stats.updatedAt']).to.equal(T0)
    await monitor.removeDealStats('stale-on-load')
  })

  it('spec 230 §1.1.1 a recently stored deal is not rewritten on its first sample', async () => {
    const deal = makeDeal('fresh-on-load', {
      updatedAt: new Date(T0 - 2 * MIN),
      unrealizedProfitNet: net(makeDeal('x'), 99).unrealizedUsd,
      drawdownPercent: 0.5,
    })
    await tick(deal, 98.3, T0)
    expect(writes).to.have.length(0)
    await monitor.removeDealStats('fresh-on-load')
  })

  it('spec 230 §1.1.1 a stale deal whose stored value is still right is not rewritten', async () => {
    const deal = makeDeal('same-on-load', {
      updatedAt: new Date(T0 - 120 * MIN),
      unrealizedProfitNet: net(makeDeal('x'), 98.3).unrealizedUsd,
      drawdownPercent: 0.5,
    })
    await tick(deal, 98.3, T0)
    expect(writes).to.have.length(0)
    await monitor.removeDealStats('same-on-load')
  })
})
