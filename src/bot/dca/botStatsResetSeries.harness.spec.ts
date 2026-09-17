process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `013.sizing-edit-wipes-the-equity-chart` §1.1.1 — the preserved series and
 * its baseline.
 *
 * Drives the REAL `dcaHelper.updateEquityStats` — not a reimplementation — over
 * the document `statsAfterReset` writes when an order-sizing edit resets a
 * bot's stats, so what the next tick appends to the preserved series is
 * measured rather than argued. Built by `Object.create`-ing the prototype, as
 * `buyAndHoldEquityStats.harness.ts` does: no stack, DB, Redis or exchange
 * connection.
 *
 * Why this exists. `stats.chart` is not a standalone record. The writer stores
 * `equity` as `startBalance.usd + the bot's profit`, seeds `realizedProfit` at
 * `startBalance.usd`, and prices `buyAndHold` off
 * `ratios.buyAndHold.startPrice`; the dashboard drawer subtracts
 * `startBalance.usd` back out to recover the real realized profit. And
 * `startBalance` is itself sizing-derived — `usage.max` (× maxNumberOfOpenDeals
 * in `botUpdateStats`) — so it is precisely what a sizing edit moves. Carrying
 * the points across such an edit while letting the engine re-seed the baseline
 * therefore steps the equity line by the whole difference between the two
 * balances, which is case B below.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import createDCABotHelper from '../dcaHelper'
import MainBot from '../main'
import { statsAfterReset } from './botStatsReset'
import { ExchangeEnum } from '../../../types'
import type { BotStats } from '../../../types'

const DAY = 24 * 60 * 60 * 1000

/** Yesterday-midnight, the timestamp `updateEquityStats` writes its point at. */
const pointTime = () => {
  const t = new Date()
  t.setHours(0, 0, 0, 0)
  t.setDate(t.getDate() - 1)
  return +t
}

/**
 * A bot mid-life under the OLD sizing: base order 50, so `usage.max.quote` is
 * 1000, and a three-day series denominated against it.
 */
const OLD_BALANCE = 1000
/** The same bot after "Base order size: 50 -> 150" — the reporter's edit. */
const NEW_BALANCE = 3000
/** Realized PnL the bot has booked over its life, on the bot doc (not stats). */
const PROFIT = 42

const livedInStats = (): BotStats => {
  const stats: any = {
    numerical: {
      general: { startBalance: { usd: OLD_BALANCE, asset: OLD_BALANCE } },
      ratios: {
        buyAndHold: {
          symbol: 'ETHUSDT',
          startPrice: 2500,
          result: 20,
          perc: 0.02,
        },
      },
      loss: {
        seriesEquity: { value: 0, min: 0, max: 0, perc: 0 },
        maxEquityDrawdown: { usd: 0 },
        maxEquityDrawdownPerc: 0,
      },
    },
    chart: [
      {
        time: pointTime() - 3 * DAY,
        equity: OLD_BALANCE,
        buyAndHold: OLD_BALANCE,
        realizedProfit: OLD_BALANCE,
      },
      {
        time: pointTime() - 2 * DAY,
        equity: OLD_BALANCE + 30,
        buyAndHold: OLD_BALANCE + 10,
        realizedProfit: OLD_BALANCE + 20,
      },
    ],
  }
  return stats as BotStats
}

/**
 * One `updateEquityStats` tick over `stats`, with the bot already carrying the
 * NEW sizing's usage — i.e. the first tick after the settings change.
 */
async function tick(stats: BotStats | null) {
  const Helper: any = createDCABotHelper(MainBot as any)
  const bot: any = Object.create(Helper.prototype)

  bot.botId = 'bot-778'
  bot.userId = 'user-778'
  bot.botType = 'dca'
  bot.equityTimer = null
  bot.data = {
    exchange: ExchangeEnum.binance,
    paperContext: false,
    status: 'open',
    settings: { pair: ['ETHUSDT'], useMulti: false },
    // The edit tripled the ladder, so the balance a re-seed would measure is
    // three times the one the preserved series is drawn against.
    usage: { max: { quote: NEW_BALANCE, base: 0 } },
    profit: { total: PROFIT, totalUsd: PROFIT },
    stats,
    symbolStats: [],
    ignoreStats: false,
    workingShift: [{ start: Date.now() - 30 * DAY }],
  }
  for (const [k, v] of [
    ['futures', false],
    ['coinm', false],
    ['isLong', true],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }

  bot.startMethod = () => 'x'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.setEquityTimer = () => undefined
  bot.updateData = async () => undefined
  bot.emit = () => undefined
  bot.getAggregatedSettings = async () => bot.data.settings
  bot.getOpenDeals = () => []
  bot.profitBase = async () => false
  bot.getLeverageMultipler = async () => 1
  bot.getUsdRate = async () => 1
  bot.getExchangeInfo = async (s: string) => ({
    pair: s,
    priceAssetPrecision: 4,
  })
  bot.getLatestPrice = async () => 3000
  bot.getEmptyStats = () => ({ stats: livedInStats(), symbolStats: [] })

  await bot.updateEquityStats(bot.botId)

  const written = bot.data.stats
  const appended = written.chart.find((c: any) => c.time === pointTime())
  return {
    startBalanceUsd: written.numerical.general.startBalance.usd,
    points: written.chart.length,
    appended,
    // What the dashboard drawer plots as "Realized Profit": the stored series
    // minus the offset it reads off the SAME stats object.
    realizedProfitShown:
      appended.realizedProfit - written.numerical.general.startBalance.usd,
  }
}

describe('§1.1.1 the reset keeps the series AND the baseline it is drawn against', () => {
  it('A. with the baseline carried across, the next tick continues the series', async () => {
    const preserved = statsAfterReset(livedInStats(), 'keepChart')
    expect(preserved, 'a sizing edit must preserve the series').to.not.be.null

    const after = await tick(preserved)

    // No re-seed: `updateEquityStats` only seeds when `startBalance.asset` is
    // falsy, so the preserved baseline stands.
    expect(after.startBalanceUsd).to.equal(OLD_BALANCE)
    expect(after.points).to.equal(3)
    // equity = startBalance + the bot's profit, i.e. the level the last
    // preserved point sat at plus what has been booked since. No step.
    expect(after.appended.equity).to.equal(OLD_BALANCE + PROFIT)
    // And the realized-profit series still pairs with its offset, so the
    // drawer recovers the real amount rather than an account-sized number.
    expect(after.realizedProfitShown).to.equal(20)
  })

  it('B. carrying the points WITHOUT the baseline steps the equity line', async () => {
    // The trap this spec exists for: the same preserved series, with the
    // baseline left zeroed for the engine to re-measure under the new sizing.
    const chartOnly = statsAfterReset(livedInStats(), 'keepChart') as BotStats
    chartOnly.numerical.general.startBalance = { usd: 0, asset: 0 }
    chartOnly.numerical.ratios.buyAndHold.startPrice = 0

    const after = await tick(chartOnly)

    expect(after.startBalanceUsd).to.equal(NEW_BALANCE)
    // A 3x cliff between the last preserved point and the next one, on a series
    // whose whole purpose is to show how the bot's equity moved.
    expect(after.appended.equity).to.equal(NEW_BALANCE + PROFIT)
    expect(
      after.appended.equity - (OLD_BALANCE + 30),
      'the step the baseline pairing exists to avoid',
    ).to.equal(NEW_BALANCE + PROFIT - (OLD_BALANCE + 30))
    // …and the drawer now subtracts the new balance from a series still seeded
    // at the old one (the point carries the previous realized profit forward),
    // so "Realized Profit" reads as a large negative amount for good: +20
    // becomes -1980.
    expect(after.realizedProfitShown).to.equal(OLD_BALANCE + 20 - NEW_BALANCE)
    expect(after.realizedProfitShown).to.be.lessThan(-1000)
  })

  it('C. a profit-currency change still clears the document', async () => {
    expect(statsAfterReset(livedInStats(), 'all')).to.be.null
  })
})
