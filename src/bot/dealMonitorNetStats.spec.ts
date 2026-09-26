process.env.NODE_ENV = 'testing'

/**
 * The stats worker stores the fee-inclusive uPnL, P&L % and value (main-app
 * spec 019 §5.4), refreshes them on quiet deals at most every
 * NET_STATS_REFRESH_MS, and no longer applies the quote→USD rate twice to the
 * legacy `stats.unrealizedProfit` on a reduce-funds deal.
 *
 * Drives the real `DealMonitor` with the deal collection stubbed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { BotMarginTypeEnum, StrategyEnum } from '../../types'
import { DealMonitor, NET_STATS_REFRESH_MS } from './dealMonitor'
import { dcaDealsDb } from '../db/dbInit'
import { computeDealUnrealizedNet } from './dealUnrealizedPnl'

const T0 = Date.UTC(2026, 8, 26, 12, 0, 0)

const makeDeal = (id: string, over: Record<string, unknown> = {}) =>
  ({
    _id: id,
    botId: 'bot-019',
    settings: {
      futures: false,
      coinm: false,
      marginType: BotMarginTypeEnum.inherit,
      leverage: 1,
      profitCurrency: 'quote',
    },
    avgPrice: 100,
    strategy: StrategyEnum.long,
    currentBalances: { base: 1, quote: 0 },
    initialBalances: { base: 0, quote: 100 },
    profit: { total: 0, pureBase: 0, pureQuote: 0 },
    usage: { current: { base: 1, quote: 100 }, max: { base: 1, quote: 100 } },
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
    },
    flags: [],
    tpFilledHistory: [],
    reduceFunds: [],
    ...over,
  }) as any

describe('deal stats store the fee-inclusive uPnL (spec 019 §5.4)', () => {
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

  const tick = (
    deal: any,
    price: number,
    time: number,
    usdRate = 1,
    fee = 0.001,
  ) =>
    monitor.addDealStats(
      false,
      { symbol: 'X-USDT', price, time } as any,
      usdRate,
      deal,
      fee,
    )

  it('persists unrealizedProfitNet / percent / value / updatedAt with the window', async () => {
    const deal = makeDeal('net-1')
    await tick(deal, 100, T0)
    await tick(deal, 90, T0 + 31_000)
    await monitor.removeDealStats('net-1')
    expect(writes).to.have.length(1)
    const set = writes[0].update.$set
    const expected = computeDealUnrealizedNet(deal, 90, 1, 0.001, false)!
    expect(set['stats.unrealizedProfitNet']).to.be.closeTo(
      expected.unrealizedUsd,
      1e-9,
    )
    // gross -10, fee 2 × 0.001 × 100 = 0.2
    expect(set['stats.unrealizedProfitNet']).to.be.closeTo(-10.2, 1e-9)
    expect(set['stats.unrealizedPercentNet']).to.be.closeTo(-10.2, 1e-9)
    expect(set['stats.valueUsd']).to.be.closeTo(89.8, 1e-9)
    expect(set['stats.updatedAt']).to.be.instanceOf(Date)
  })

  it('a quiet deal is re-persisted only after the refresh interval', async () => {
    const deal = makeDeal('net-2')
    await tick(deal, 100, T0)
    await tick(deal, 90, T0 + 31_000) // new drawdown → window changed
    // the bot's deal snapshot carries the persisted extremes into the next window
    deal.stats.drawdownPercent = 0.2
    await tick(deal, 95, T0 + 62_000) // closes the window → write 1
    expect(writes).to.have.length(1)
    const persistedAt = T0 + 62_000
    // price moves but no new extreme, no profit/loss flip, inside the interval
    await tick(deal, 95.5, T0 + 93_000)
    await tick(deal, 96, T0 + 124_000)
    await tick(deal, 96.5, T0 + 300_000)
    expect(writes, 'no write inside the interval').to.have.length(1)
    // past the interval the moved value marks the window changed…
    await tick(deal, 97, persistedAt + NET_STATS_REFRESH_MS + 1)
    // …and the next sample past the window persists it
    await tick(deal, 97, persistedAt + NET_STATS_REFRESH_MS + 40_000)
    expect(writes).to.have.length(2)
    expect(writes[1].update.$set['stats.unrealizedProfitNet']).to.be.closeTo(
      computeDealUnrealizedNet(deal, 97, 1, 0.001, false)!.unrealizedUsd,
      1e-9,
    )
    await monitor.removeDealStats('net-2')
  })

  it('legacy unrealizedProfit applies the quote→USD rate once on a reduce-funds deal', async () => {
    // BTC-quoted: 1 BTC spent, 20 units held, reduce-funds branch active
    const deal = makeDeal('net-3', {
      avgPrice: 0.05,
      initialBalances: { base: 0, quote: 1 },
      currentBalances: { base: 20, quote: 0 },
      usage: { current: { base: 20, quote: 1 }, max: { base: 20, quote: 1 } },
      reduceFunds: [{ qty: 0, price: 0.05 }],
    })
    await tick(deal, 0.05, T0, 60000, 0.001)
    await tick(deal, 0.055, T0 + 31_000, 60000, 0.001)
    await monitor.removeDealStats('net-3')
    const set = writes[0].update.$set
    // gross 0.1 BTC × 60,000 = 6,000 USD, minus 2 × 0.001 × 60,000 = 120
    expect(set['stats.unrealizedProfit']).to.be.closeTo(5880, 1e-6)
    expect(set['stats.unrealizedProfitNet']).to.be.closeTo(5880, 1e-6)
  })
})
