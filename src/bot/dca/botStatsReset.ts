import type { BotStats } from '../../../types'

/**
 * The zeroed statistics document a bot starts from.
 *
 * Lives here rather than inline in `dcaHelper.getEmptyStats()` because the
 * settings-change reset in `bot/index.ts` needs the same shape and has no bot
 * instance to ask for it. `getEmptyStats()` still owns `symbolStats`, which is
 * the only half that depends on the bot's pairs.
 */
export const emptyBotStats = (): BotStats => {
  const usdAsset = () => ({
    usd: 0,
    asset: 0,
  })
  const series = () => ({
    count: 0,
    max: 0,
    value: usdAsset(),
    minValue: usdAsset(),
    maxValue: usdAsset(),
    perc: 0,
  })
  return {
    numerical: {
      profit: {
        grossProfit: usdAsset(),
        grossProfitPerc: 0,
        maxDealProfit: usdAsset(),
        maxDealProfitPerc: 0,
        avgDealProfit: usdAsset(),
        avgDealProfitPerc: 0,
        maxRunUp: usdAsset(),
        maxRunUpPerc: 0,
        maxConsecutiveWins: 0,
        standardDeviationOfPositiveReturns: 0,
        series: series(),
      },
      loss: {
        grossLoss: usdAsset(),
        grossLossPerc: 0,
        maxDealLoss: usdAsset(),
        maxDealLossPerc: 0,
        avgDealLoss: usdAsset(),
        avgDealLossPerc: 0,
        maxDrawdown: usdAsset(),
        maxDrawdownPerc: 0,
        maxEquityDrawdown: usdAsset(),
        maxEquityDrawdownPerc: 0,
        maxConsecutiveLosses: 0,
        standardDeviationOfNegativeReturns: 0,
        standardDeviationOfDownside: 0,
        series: series(),
        seriesEquity: {
          value: 0,
          min: 0,
          max: 0,
          perc: 0,
        },
      },
      general: {
        netProfitPerc: 0,
        avgDaily: usdAsset(),
        avgDailyPerc: 0,
        annualizedReturn: 0,
        startBalance: usdAsset(),
        maxDCAOrdersTriggered: 0,
        avgDCAOrdersTriggered: 0,
        coveredPriceDeviation: 0,
        actualPriceDeviation: 0,
        confidenceGrade: '',
      },
      ratios: {
        profitFactor: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        cwr: 0,
        buyAndHold: {
          result: 0,
          perc: 0,
          symbol: '',
          startPrice: 0,
        },
      },
      usage: {
        maxTheoreticalUsage: 0,
        maxActualUsage: 0,
        avgDealUsage: 0,
      },
      deals: {
        profit: 0,
        loss: 0,
      },
    },
    duration: {
      profit: {
        avgWinningTradeDuration: 0,
        maxWinningTradeDuration: 0,
        totalTime: 0,
      },
      loss: {
        avgLosingTradeDuration: 0,
        maxLosingTradeDuration: 0,
        totalTime: 0,
      },
      general: {
        maxDealDuration: 0,
        avgDealDuration: 0,
        dealsPerDay: 0,
        workingTime: 0,
        totalTime: 0,
      },
    },
    chart: [],
  }
}

/**
 * How much of the statistics document a settings change invalidates.
 *
 * - `all` — a `profitCurrency` change. It re-denominates everything, including
 *   the series, so there is nothing worth carrying.
 * - `keepChart` — an order-sizing change (`orderSize`, `baseOrderSize`,
 *   `ordersCount`, `volumeScale`, `orderSizeType`, `maxNumberOfOpenDeals`,
 *   `useDca`). Every aggregate accumulated over deals is incomparable
 *   afterwards and restarts, but `chart` is the bot's daily equity /
 *   realized-profit / benchmark series over the last 90 days — changing the
 *   size of *future* orders does not change what already happened, so the
 *   series is kept, together with the baseline it is denominated against.
 */
export type StatsResetScope = 'all' | 'keepChart'

/**
 * What to write to a bot's `stats` when a settings change resets it.
 *
 * `null` means "clear the document", which is what both cases used to do. The
 * chart being collateral damage of a sizing edit was invisible until the bot
 * card started rendering `stats.chart` as its P&L sparkline, and it is
 * permanent for a bot that is stopped afterwards: the series is only ever
 * rebuilt by a *running* bot, from `updateEquityStats` (armed for the next
 * midnight) or `botUpdateStats` (on a deal close).
 *
 * **The series and its baseline travel together.** `chart` is not a standalone
 * record: `equity` is written as `startBalance + the bot's profit`,
 * `realizedProfit` is seeded at `startBalance.usd` and then carried forward
 * point to point, and `buyAndHold` is priced off `ratios.buyAndHold.startPrice`
 * — and the drawer's performance chart subtracts `startBalance.usd` back out to
 * recover the real realized profit. `startBalance` is itself sizing-derived
 * (`usage.max` × `maxNumberOfOpenDeals`), so re-seeding it under a preserved
 * series is what would put a step in the equity line and leave the realized
 * profit off by the whole difference between the two balances, permanently.
 * Carrying `general.startBalance` and `ratios.buyAndHold` across with the
 * points keeps the series self-consistent; every aggregate accumulated over
 * deals still restarts.
 *
 * The result is always a complete `BotStats`, never a chart-only fragment —
 * both chart writers read `stats.numerical.general…` unguarded once `stats` is
 * truthy, and the dashboards select `numerical`/`duration` off the same object.
 */
export const statsAfterReset = (
  previous: BotStats | null | undefined,
  scope: StatsResetScope,
): BotStats | null => {
  if (scope === 'all') {
    return null
  }
  // Rebuilt as plain objects: `previous` is a mongoose document, and the caller
  // keeps holding it after this returns.
  const chart = (previous?.chart ?? [])
    .filter(
      (point) =>
        Number.isFinite(point?.time) &&
        Number.isFinite(point?.equity) &&
        Number.isFinite(point?.buyAndHold) &&
        Number.isFinite(point?.realizedProfit),
    )
    .map((point) => ({
      time: point.time,
      equity: point.equity,
      buyAndHold: point.buyAndHold,
      realizedProfit: point.realizedProfit,
    }))
  const startBalance = previous?.numerical?.general?.startBalance
  const finite = (value: unknown) =>
    Number.isFinite(value) ? Number(value) : 0
  // No series, or a series whose baseline is gone: there is nothing that can be
  // carried across coherently, so keep clearing the document — the engine
  // re-seeds from `getEmptyStats()` on its next tick, exactly as it does today.
  if (!chart.length || !finite(startBalance?.asset)) {
    return null
  }
  const buyAndHold = previous?.numerical?.ratios?.buyAndHold
  const next = emptyBotStats()
  next.chart = chart
  next.numerical.general.startBalance = {
    usd: finite(startBalance?.usd),
    asset: finite(startBalance?.asset),
  }
  next.numerical.ratios.buyAndHold = {
    result: finite(buyAndHold?.result),
    perc: finite(buyAndHold?.perc),
    symbol: buyAndHold?.symbol ?? '',
    startPrice: finite(buyAndHold?.startPrice),
  }
  return next
}
