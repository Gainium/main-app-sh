import type { PipelineStage } from 'mongoose'

import { DCADealStatusEnum } from '../../types'
import { pairStatsMatch, peakCapitalBySymbol } from './pairStats'
import { profitFactorOf } from './profitFactor'

/**
 * Bot-level performance over a window of closed deals, derived from the deals
 * on read — the "Lifetime" and "Since last change" views of the Statistics tab.
 *
 * Why not `bot.stats`: that document is an incremental aggregate the engine
 * resets whenever a sizing setting or the profit currency changes
 * (`resetStatsAfter`), so the bot's history before the last change is gone
 * from it. The deals are not: folding them gives the lifetime figures back for
 * every existing bot with no migration, and the same fold with `from =
 * resetStatsAfter` gives the "since" figures.
 *
 * Population: the same as the per-pair stats (`pairStats.ts`) — closed /
 * canceled deals that ever filled, by CLOSE time, plus every open deal for the
 * capital they hold. A deal opened before a settings change and closed after
 * it counts in "since"; the engine's own `stats` drops it from both windows
 * (`botUpdateStats` returns early on `createTime < resetStatsAfter`).
 *
 * Money is USD (`profit.totalUsd`), so a profit-currency change does not make
 * the lifetime figures incomparable. Return and drawdown are measured against
 * the peak capital the bot ever had committed at once, not `startBalance`,
 * which is sizing-derived and would move with every sizing change.
 *
 * A merged-away deal (spec 138) is not a deal: it adds no count, win / loss,
 * streak, duration or per-deal extreme. Money it had already booked still
 * moves realized profit, gross profit / loss and the equity drawdown.
 */

export type BotWindowStats = {
  /** Start of the window (close time, ms); null = lifetime. */
  from: number | null
  closedDeals: number
  wins: number
  losses: number
  /** wins / (wins + losses), as a fraction — break-even deals are neither. */
  winRate: number
  realizedProfitUsd: number
  grossProfitUsd: number
  grossLossUsd: number
  /** `profitFactorOf` encoding: -1 = profits and no losses. */
  profitFactor: number
  peakCapitalUsd: number
  /** realizedProfitUsd / peakCapitalUsd, as a fraction. */
  returnOnPeakCapital: number
  /** Deepest peak-to-trough fall of realized equity, in USD. */
  maxDrawdownUsd: number
  /** That fall over the equity peak it fell from, as a fraction. */
  maxDrawdownPerc: number
  avgDealDuration: number
  maxDealDuration: number
  /** Best single deal, USD (0 when none won). */
  maxDealProfitUsd: number
  /** Worst single deal, USD, negative (0 when none lost). */
  maxDealLossUsd: number
  avgDealProfitUsd: number
  /** Negative (0 when none lost). */
  avgDealLossUsd: number
  maxConsecutiveWins: number
  maxConsecutiveLosses: number
  avgWinningDealDuration: number
  maxWinningDealDuration: number
  avgLosingDealDuration: number
  maxLosingDealDuration: number
  /** Close time of the first closed deal in the window; null when none. */
  firstCloseTime: number | null
}

export type BotWindowDeal = {
  start: number
  /** Close time; null while the deal is open. */
  end: number | null
  capital: number
  profit: number
  profitUsd: number
  id?: string
  /** Set on a merged-away deal: the merged deal that took its position over. */
  parentId?: string | null
}

const OPEN = [
  DCADealStatusEnum.open,
  DCADealStatusEnum.start,
  DCADealStatusEnum.error,
]

const finite = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

/** Every deal of the bots; both windows are cut from these rows in memory. */
export const buildBotWindowPipeline = (botIds: string[]): PipelineStage[] => [
  pairStatsMatch(botIds, {}),
  {
    $project: {
      _id: 0,
      start: '$createTime',
      end: {
        $cond: [
          { $in: ['$status', OPEN] },
          null,
          { $ifNull: ['$closeTime', '$updateTime'] },
        ],
      },
      capital: {
        $ifNull: ['$usage.maxUsd', { $ifNull: ['$stats.maxUsage', 0] }],
      },
      profit: { $ifNull: ['$profit.total', 0] },
      profitUsd: { $ifNull: ['$profit.totalUsd', 0] },
      id: { $toString: '$_id' },
      parentId: {
        $cond: [
          { $eq: [{ $ifNull: ['$child', false] }, true] },
          '$parentId',
          null,
        ],
      },
    },
  },
]

/**
 * The "since" window: deals closed at or after `from`, plus every open deal —
 * the same population `pairStatsMatch` selects with `{ from }`.
 */
export const dealsClosedSince = (deals: BotWindowDeal[], from: number) =>
  deals.filter((d) => d.end === null || d.end === undefined || d.end >= from)

export const foldBotWindowStats = (
  deals: BotWindowDeal[],
  from: number | null = null,
  now: number = Date.now(),
): BotWindowStats => {
  const closed = deals
    .filter((d) => d.end !== null && d.end !== undefined)
    .sort((a, b) => finite(a.end) - finite(b.end))
  let wins = 0
  let losses = 0
  let closedDeals = 0
  let firstCloseTime: number | null = null
  let dealGrossProfit = 0
  let dealGrossLoss = 0
  let realized = 0
  let grossProfit = 0
  let grossLoss = 0
  let duration = 0
  let maxDuration = 0
  let maxProfit = 0
  let maxLoss = 0
  let winStreak = 0
  let lossStreak = 0
  let maxWinStreak = 0
  let maxLossStreak = 0
  let winDuration = 0
  let maxWinDuration = 0
  let lossDuration = 0
  let maxLossDuration = 0
  for (const d of closed) {
    const profit = finite(d.profit)
    const usd = finite(d.profitUsd)
    const length = Math.max(0, finite(d.end) - finite(d.start))
    realized += usd
    if (d.parentId) {
      // Merged away: booked money only (spec 138 §2.1.2).
      if (profit > 0) {
        grossProfit += usd
      } else if (profit < 0) {
        grossLoss += usd
      }
      continue
    }
    closedDeals += 1
    firstCloseTime ??= finite(d.end)
    // Win / loss by the sign of `profit.total`, as the engine's `isProfit` /
    // `isLoss` — a break-even deal is neither, and does not break a streak.
    if (profit > 0) {
      wins += 1
      grossProfit += usd
      dealGrossProfit += usd
      maxProfit = Math.max(maxProfit, usd)
      winDuration += length
      maxWinDuration = Math.max(maxWinDuration, length)
      winStreak += 1
      lossStreak = 0
      maxWinStreak = Math.max(maxWinStreak, winStreak)
    } else if (profit < 0) {
      losses += 1
      grossLoss += usd
      dealGrossLoss += usd
      maxLoss = Math.min(maxLoss, usd)
      lossDuration += length
      maxLossDuration = Math.max(maxLossDuration, length)
      lossStreak += 1
      winStreak = 0
      maxLossStreak = Math.max(maxLossStreak, lossStreak)
    }
    duration += length
    maxDuration = Math.max(maxDuration, length)
  }
  const peakCapital =
    peakCapitalBySymbol(
      deals.map((d) => ({ ...d, symbol: '*' })),
      now,
    ).get('*') ?? 0
  // Realized equity: the peak capital plus the running realized P&L, stepped
  // at each close.
  let equity = peakCapital
  let peak = equity
  let ddUsd = 0
  let ddPerc = 0
  for (const d of closed) {
    equity += finite(d.profitUsd)
    peak = Math.max(peak, equity)
    const fall = peak - equity
    if (fall > ddUsd) {
      ddUsd = fall
      ddPerc = peak > 0 ? fall / peak : 0
    }
  }
  return {
    from,
    closedDeals,
    wins,
    losses,
    winRate: wins + losses ? wins / (wins + losses) : 0,
    realizedProfitUsd: realized,
    grossProfitUsd: grossProfit,
    grossLossUsd: grossLoss,
    profitFactor: profitFactorOf(grossProfit, grossLoss),
    peakCapitalUsd: peakCapital,
    returnOnPeakCapital: peakCapital > 0 ? realized / peakCapital : 0,
    maxDrawdownUsd: ddUsd,
    maxDrawdownPerc: ddPerc,
    avgDealDuration: closedDeals ? duration / closedDeals : 0,
    maxDealDuration: maxDuration,
    maxDealProfitUsd: maxProfit,
    maxDealLossUsd: maxLoss,
    avgDealProfitUsd: wins ? dealGrossProfit / wins : 0,
    avgDealLossUsd: losses ? dealGrossLoss / losses : 0,
    maxConsecutiveWins: maxWinStreak,
    maxConsecutiveLosses: maxLossStreak,
    avgWinningDealDuration: wins ? winDuration / wins : 0,
    maxWinningDealDuration: maxWinDuration,
    avgLosingDealDuration: losses ? lossDuration / losses : 0,
    maxLosingDealDuration: maxLossDuration,
    firstCloseTime,
  }
}
