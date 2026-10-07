import type { PipelineStage } from 'mongoose'

import { DCADealStatusEnum } from '../../types'
import { profitFactorOf } from './profitFactor'

/**
 * Per-pair performance of a DCA / Combo bot, derived from its deals on read.
 *
 * Why not `bot.symbolStats`: that block is an incremental aggregate the engine
 * updates on each close, so it cannot answer a date range, never recorded fees,
 * capital or drawdown, and is reset with the bot's stats. Every one of those is
 * on the deal documents, so folding the deals is both exact and complete.
 *
 * Closed population = `closed` + `canceled` deals that ever filled — the set
 * the Deals tab lists as closed, minus the canceled-before-fill deals that
 * carry no price and so no money (`initialPrice` 0; see dcaHelper
 * `dealHasPrice`). Open population = what the Deals tab lists as open.
 *
 * A merged-away deal (`child: true`, spec 138) is in the population but is not
 * a deal of its own — its position continues in the merged deal. It adds no
 * deal count, win / loss, duration or drawdown; money it had already booked
 * (realized profit, fees) still counts, and it holds its capital up to the
 * merge (`peakCapitalBySymbol`).
 */

export type BotPairStatsRow = {
  symbol: string
  baseAsset: string
  quoteAsset: string
  closedDeals: number
  wins: number
  losses: number
  realizedProfitUsd: number
  grossProfitUsd: number
  grossLossUsd: number
  /** `profitFactorOf` encoding: -1 = profits and no losses. */
  profitFactor: number
  /** Fees paid by the closed deals, in the pair's quote asset. */
  feesQuote: number
  /**
   * The most capital the pair had committed at once: the peak, over time, of
   * the summed `usage.maxUsd` of its deals open at that moment. A pair running
   * several deals together ties up their sum, not the largest one.
   */
  peakCapitalUsd: number
  avgDealDuration: number
  maxDealDuration: number
  /** Worst intra-deal drawdown over closed AND open deals, as a fraction. */
  maxDrawdownPerc: number
  openDeals: number
  unrealizedProfitUsd: number
  openCapitalUsd: number
}

export type PairStatsRange = { from?: number; to?: number }

const CLOSED = [DCADealStatusEnum.closed, DCADealStatusEnum.canceled]
const OPEN = [
  DCADealStatusEnum.open,
  DCADealStatusEnum.start,
  DCADealStatusEnum.error,
]

const num = (path: string) => ({ $ifNull: [path, 0] })

/** A merged-away deal (spec 138 §1.2): its position lives on in the parent. */
const isMergedAway = { $eq: [{ $ifNull: ['$child', false] }, true] }

const finite = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0

export type PairStatsGroup = Omit<
  BotPairStatsRow,
  'symbol' | 'profitFactor' | 'avgDealDuration' | 'peakCapitalUsd'
> & {
  _id: string
  totalDuration: number
}

/** The deals both pair-stats aggregations fold: closed in the window, plus open. */
export const pairStatsMatch = (
  botIds: string[],
  range: PairStatsRange,
): PipelineStage.Match => {
  const closeTime: Record<string, number> = {}
  if (typeof range.from === 'number' && Number.isFinite(range.from)) {
    closeTime.$gte = range.from
  }
  if (typeof range.to === 'number' && Number.isFinite(range.to)) {
    closeTime.$lte = range.to
  }
  const closedMatch: Record<string, unknown> = {
    status: { $in: CLOSED },
    initialPrice: { $gt: 0 },
  }
  if (Object.keys(closeTime).length) {
    closedMatch.closeTime = closeTime
  }
  return {
    $match: {
      botId: { $in: botIds },
      $or: [closedMatch, { status: { $in: OPEN } }],
    },
  }
}

export const buildPairStatsPipeline = (
  botIds: string[],
  range: PairStatsRange = {},
): PipelineStage[] => {
  const isOpen = { $in: ['$status', OPEN] }
  const whenClosed = (expr: unknown) => ({ $cond: [isOpen, 0, expr] })
  const whenOpen = (expr: unknown) => ({ $cond: [isOpen, expr, 0] })
  // Per-deal figures: a closed deal that was not merged away (spec 138 §2.1.1).
  const whenClosedDeal = (expr: unknown) =>
    whenClosed({ $cond: [isMergedAway, 0, expr] })
  const profit = num('$profit.total')
  const profitUsd = num('$profit.totalUsd')

  return [
    pairStatsMatch(botIds, range),
    {
      $group: {
        _id: '$symbol.symbol',
        baseAsset: { $first: '$symbol.baseAsset' },
        quoteAsset: { $first: '$symbol.quoteAsset' },
        closedDeals: { $sum: whenClosedDeal(1) },
        // Win / loss by the sign of `profit.total`, exactly as the engine's
        // `isProfit` / `isLoss` — a break-even deal is neither.
        wins: {
          $sum: whenClosedDeal({ $cond: [{ $gt: [profit, 0] }, 1, 0] }),
        },
        losses: {
          $sum: whenClosedDeal({ $cond: [{ $lt: [profit, 0] }, 1, 0] }),
        },
        realizedProfitUsd: { $sum: whenClosed(profitUsd) },
        grossProfitUsd: {
          $sum: whenClosed({ $cond: [{ $gt: [profit, 0] }, profitUsd, 0] }),
        },
        grossLossUsd: {
          $sum: whenClosed({ $cond: [{ $lt: [profit, 0] }, profitUsd, 0] }),
        },
        feesQuote: {
          $sum: whenClosed({
            $add: [
              {
                $multiply: [num('$feePaid.base'), num('$avgPrice')],
              },
              num('$feePaid.quote'),
            ],
          }),
        },
        totalDuration: {
          $sum: whenClosedDeal({
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ['$closeTime', '$updateTime'] },
                  '$createTime',
                ],
              },
            ],
          }),
        },
        maxDealDuration: {
          $max: whenClosedDeal({
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ['$closeTime', '$updateTime'] },
                  '$createTime',
                ],
              },
            ],
          }),
        },
        // `$max` skips null: a merged-away deal's drawdown is not a deal's.
        maxDrawdownPerc: {
          $max: { $cond: [isMergedAway, null, num('$stats.drawdownPercent')] },
        },
        openDeals: { $sum: whenOpen(1) },
        // The deal monitor's last flush of each open deal's P&L, in USD.
        unrealizedProfitUsd: { $sum: whenOpen(num('$stats.unrealizedProfit')) },
        openCapitalUsd: { $sum: whenOpen(num('$usage.currentUsd')) },
      },
    },
  ]
}

export type PairCapitalDeal = {
  symbol: string
  start: number
  /** Close time; null while the deal is open. */
  end: number | null
  capital: number
  /** The deal's id — what a merged-away deal's `parentId` points at. */
  id?: string
  /** Set on a merged-away deal: the merged deal that took its position over. */
  parentId?: string | null
}

/**
 * One lean row per deal in the same population as the stats — what
 * {@link peakCapitalBySymbol} sweeps. Kept separate from the `$group` because a
 * peak over time needs the deals' intervals, not an accumulator.
 */
export const buildPairCapitalPipeline = (
  botIds: string[],
  range: PairStatsRange = {},
): PipelineStage[] => [
  pairStatsMatch(botIds, range),
  {
    $project: {
      _id: 0,
      symbol: '$symbol.symbol',
      start: '$createTime',
      end: {
        $cond: [
          { $in: ['$status', OPEN] },
          null,
          { $ifNull: ['$closeTime', '$updateTime'] },
        ],
      },
      capital: { $ifNull: ['$usage.maxUsd', num('$stats.maxUsage')] },
      id: { $toString: '$_id' },
      parentId: { $cond: [isMergedAway, '$parentId', null] },
    },
  },
]

/**
 * Peak concurrent capital per pair. Each deal holds its capital from start to
 * end (open deals: to now); the peak is the largest running sum. A deal that
 * closes at the same instant another opens is released first, so a sequential
 * bot re-using one deal's capital reads as that one deal, not two.
 *
 * A merged-away deal hands its capital to the merged deal, which is created
 * just BEFORE its sources are cancelled — so a source is held only up to the
 * merged deal's start, or the merge would be counted twice (spec 138 §2.1.3).
 */
export const peakCapitalBySymbol = (
  deals: PairCapitalDeal[],
  now: number = Date.now(),
): Map<string, number> => {
  const startById = new Map<string, number>()
  for (const d of deals) {
    if (d.id) {
      startById.set(d.id, finite(d.start))
    }
  }
  const events = new Map<string, [number, number][]>()
  for (const d of deals) {
    const capital = finite(d.capital)
    const start = finite(d.start)
    if (!d.symbol || capital <= 0 || !start) {
      continue
    }
    let end = d.end === null || d.end === undefined ? now : finite(d.end)
    const handedOver = d.parentId ? startById.get(d.parentId) : undefined
    if (handedOver) {
      end = Math.min(end, handedOver)
    }
    const list = events.get(d.symbol) ?? []
    list.push([start, capital], [Math.max(start, end), -capital])
    events.set(d.symbol, list)
  }
  const peaks = new Map<string, number>()
  for (const [symbol, list] of events) {
    // Releases (negative) before acquisitions at the same timestamp.
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    let running = 0
    let peak = 0
    for (const [, delta] of list) {
      running += delta
      peak = Math.max(peak, running)
    }
    peaks.set(symbol, peak)
  }
  return peaks
}

export type PairGross = {
  grossProfitUsd: number
  grossProfitAsset: number
  grossLossUsd: number
  grossLossAsset: number
}

/**
 * One pair's gross profit / loss over the deals the engine's per-pair stats
 * count — `closed` + `canceled`, created at or after the bot's
 * `resetStatsAfter` (the same early return as `botUpdateStats`), win / loss by
 * the sign of `profit.total`.
 *
 * Used once per pair to seed `symbolStats[].numerical.general.gross*` on a
 * record written before those fields existed; the engine accumulates from
 * there. `excludeDealId` is the deal being closed, which the caller adds
 * itself — whether it is already saved as closed is a race this sidesteps.
 */
export const buildPairGrossPipeline = (
  botId: string,
  symbol: string,
  resetStatsAfter: number | undefined,
  excludeDealId: string,
): PipelineStage[] => {
  const profit = num('$profit.total')
  const sumIf = (cmp: '$gt' | '$lt', value: unknown) => ({
    $sum: { $cond: [{ [cmp]: [profit, 0] }, value, 0] },
  })
  return [
    {
      $match: {
        botId,
        'symbol.symbol': symbol,
        status: { $in: CLOSED },
        createTime: { $gte: resetStatsAfter ?? 0 },
        $expr: { $ne: [{ $toString: '$_id' }, excludeDealId] },
      },
    },
    {
      $group: {
        _id: null,
        grossProfitUsd: sumIf('$gt', num('$profit.totalUsd')),
        grossProfitAsset: sumIf('$gt', profit),
        grossLossUsd: sumIf('$lt', num('$profit.totalUsd')),
        grossLossAsset: sumIf('$lt', profit),
      },
    },
  ]
}

/** An empty result (no earlier deals) is a legitimate zero, not a failure. */
export const shapePairGross = (rows: Partial<PairGross>[]): PairGross => ({
  grossProfitUsd: finite(rows[0]?.grossProfitUsd),
  grossProfitAsset: finite(rows[0]?.grossProfitAsset),
  grossLossUsd: finite(rows[0]?.grossLossUsd),
  grossLossAsset: finite(rows[0]?.grossLossAsset),
})

/**
 * Shape the aggregate into rows, one per pair, sorted by symbol.
 *
 * `configuredPairs` are the bot's current pairs: a pair that has never traded
 * still gets a zero row — "which pairs are doing nothing" is half of what this
 * breakdown is for. Pairs the bot traded but no longer lists keep their row.
 */
export const shapePairStats = (
  groups: PairStatsGroup[],
  configuredPairs: {
    symbol: string
    baseAsset?: string
    quoteAsset?: string
  }[] = [],
  peaks: Map<string, number> = new Map(),
): BotPairStatsRow[] => {
  const rows = new Map<string, BotPairStatsRow>()
  for (const g of groups) {
    if (!g._id) {
      continue
    }
    const closedDeals = finite(g.closedDeals)
    const grossProfitUsd = finite(g.grossProfitUsd)
    const grossLossUsd = finite(g.grossLossUsd)
    rows.set(g._id, {
      symbol: g._id,
      baseAsset: g.baseAsset ?? '',
      quoteAsset: g.quoteAsset ?? '',
      closedDeals,
      wins: finite(g.wins),
      losses: finite(g.losses),
      realizedProfitUsd: finite(g.realizedProfitUsd),
      grossProfitUsd,
      grossLossUsd,
      profitFactor: profitFactorOf(grossProfitUsd, grossLossUsd),
      feesQuote: finite(g.feesQuote),
      peakCapitalUsd: peaks.get(g._id) ?? 0,
      avgDealDuration: closedDeals ? finite(g.totalDuration) / closedDeals : 0,
      maxDealDuration: finite(g.maxDealDuration),
      maxDrawdownPerc: finite(g.maxDrawdownPerc),
      openDeals: finite(g.openDeals),
      unrealizedProfitUsd: finite(g.unrealizedProfitUsd),
      openCapitalUsd: finite(g.openCapitalUsd),
    })
  }
  for (const p of configuredPairs) {
    if (!p.symbol || rows.has(p.symbol)) {
      continue
    }
    rows.set(p.symbol, {
      symbol: p.symbol,
      baseAsset: p.baseAsset ?? '',
      quoteAsset: p.quoteAsset ?? '',
      closedDeals: 0,
      wins: 0,
      losses: 0,
      realizedProfitUsd: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      profitFactor: 0,
      feesQuote: 0,
      peakCapitalUsd: 0,
      avgDealDuration: 0,
      maxDealDuration: 0,
      maxDrawdownPerc: 0,
      openDeals: 0,
      unrealizedProfitUsd: 0,
      openCapitalUsd: 0,
    })
  }
  return [...rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))
}
