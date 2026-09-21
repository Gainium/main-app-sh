process.env.NODE_ENV = 'testing'

/**
 * Regression test for spec
 * `064.grid-position-unrealized-value-is-scaled-by-the-price-ratio` §1.2.4 /
 * §4.3 — the DCA/combo half of the same gap.
 *
 * `DealMonitor.completeStats` only writes on the sample that CLOSES a tracking
 * window, and a deal is sampled at most once a minute. `removeDealStats` used
 * to `delete` the entry outright, so every measurement taken since the last
 * window close — up to a full interval of drawdown, run-up and time-in-loss —
 * was dropped when the deal closed.
 *
 * Drives the real `DealMonitor` with the deal collections stubbed. No Mongo,
 * Redis, venue or bot stack is needed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { BotMarginTypeEnum, StrategyEnum } from '../../types'
import { DealMonitor } from './dealMonitor'
import { dcaDealsDb } from '../db/dbInit'

const AVG_PRICE = 100
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0)

const makeDeal = (id: string) =>
  ({
    _id: id,
    botId: 'bot-064',
    settings: {
      futures: false,
      coinm: false,
      marginType: BotMarginTypeEnum.inherit,
      leverage: 1,
      profitCurrency: 'quote',
    },
    avgPrice: AVG_PRICE,
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
  }) as any

describe('deal stats survive the deal close (spec 064 §4.3)', () => {
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

  /** Opens a window and records a 10 % drawdown inside it, writing nothing. */
  const trackALoss = async (id: string) => {
    const deal = makeDeal(id)
    await monitor.addDealStats(
      false,
      { symbol: 'X-USDT', price: AVG_PRICE, time: T0 } as any,
      1,
      deal,
      0,
    )
    await monitor.addDealStats(
      false,
      { symbol: 'X-USDT', price: AVG_PRICE * 0.9, time: T0 + 31_000 } as any,
      1,
      deal,
      0,
    )
    expect(
      writes,
      'the window is still open, nothing is written',
    ).to.have.length(0)
  }

  it('flushes the open window when the deal closes', async () => {
    await trackALoss('deal-flush')
    await monitor.removeDealStats('deal-flush')
    expect(writes).to.have.length(1)
    expect(writes[0].filter._id).to.equal('deal-flush')
    expect(writes[0].update.$max['stats.drawdownPercent']).to.be.closeTo(
      0.1,
      1e-9,
    )
  })

  it('stops tracking the deal, so a repeat close writes nothing', async () => {
    await trackALoss('deal-once')
    await monitor.removeDealStats('deal-once')
    await monitor.removeDealStats('deal-once')
    expect(writes).to.have.length(1)
  })

  it('writes nothing for a deal that has nothing new to write', async () => {
    const deal = makeDeal('deal-quiet')
    await monitor.addDealStats(
      false,
      { symbol: 'X-USDT', price: AVG_PRICE, time: T0 } as any,
      1,
      deal,
      0,
    )
    await monitor.removeDealStats('deal-quiet')
    expect(writes).to.have.length(0)
  })

  it('writes nothing for a deal it never tracked', async () => {
    await monitor.removeDealStats('deal-unknown')
    expect(writes).to.have.length(0)
  })
})
