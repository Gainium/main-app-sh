/**
 * Server-side aggregation of a hedge bot's two legs.
 *
 * A hedge bot (`hedgeCombo` / `hedgeDca`) is a WRAPPER document holding two
 * child bots — one long, one short. The wrapper's own `profit`, `profitToday`
 * and `workingTimeNumber` are written ONCE at creation (all zeros) and never
 * updated again: the engine only ever writes `status` back to the parent, see
 * `MetaBot.updateBotData` / `setStatus`. Every real number lives on the legs.
 *
 * The dashboard has always known this and sums the legs client-side (see
 * main-dash-redesign `core/src/types/hedgeBot.ts` and the comment on
 * `HedgeBotCard`). Anything that reads the wrapper document directly — such as
 * the v2 REST API — would otherwise report a flat 0 profit for every hedge
 * bot. This helper is the server-side equivalent of that client-side sum.
 *
 * ⚠️ The two legs are independent bots: each owns its own pair and may even sit
 * on its own exchange, so they do NOT necessarily settle in the same quote
 * asset. USD-denominated figures are always summable; native-unit ones are only
 * summable when the quote assets agree. `nativeBasis` reports which you got:
 * on `'mixed'` the native fields are left at 0 and `profitByAssets` (which is
 * keyed by asset and therefore always exact) is the figure to use.
 */

import type { StrategyEnum } from '../../types'

type ProfitByAsset = { asset: string; total: number; totalUsd: number }

type SymbolLike = { symbol?: string; baseAsset?: string; quoteAsset?: string }

/**
 * The subset of a leg (a DCA/Combo bot document) this module reads. Kept
 * structural rather than importing `ComboBotSchema` so it accepts a raw lean
 * document, a `convertComboBotToArray` result, and a projected partial alike.
 */
export type HedgeLegLike = {
  profit?: {
    total?: number
    totalUsd?: number
    freeTotal?: number
    freeTotalUsd?: number
    pureBase?: number
    pureQuote?: number
  } | null
  profitByAssets?: ProfitByAsset[] | null
  profitToday?: {
    start?: number
    end?: number
    totalToday?: number
    totalTodayUsd?: number
  } | null
  unrealizedProfit?: number | null
  workingTimeNumber?: number | null
  deals?: { all?: number; active?: number } | null
  dealsInBot?: { all?: number; active?: number } | null
  symbol?: unknown
  settings?: { strategy?: StrategyEnum | string } | null
}

export type HedgeAggregate = {
  profit: {
    total: number
    totalUsd: number
    freeTotal: number
    freeTotalUsd: number
    pureBase: number
    pureQuote: number
  }
  profitByAssets: ProfitByAsset[]
  profitToday: {
    start: number
    end: number
    totalToday: number
    totalTodayUsd: number
  }
  unrealizedProfit: number
  /** Longest of the two legs' working times, matching the dashboard. */
  workingTimeNumber: number
  dealsInBot: { all: number; active: number }
  /**
   * `'exact'`  — both legs settle in the same quote asset, so the native-unit
   *              fields on `profit` are a meaningful sum.
   * `'mixed'`  — they don't; the native-unit fields are 0 and only the `*Usd`
   *              fields and `profitByAssets` are trustworthy.
   */
  nativeBasis: 'exact' | 'mixed'
  /** Distinct quote assets across both legs, for clients that want to say why. */
  quoteAssets: string[]
}

const num = (v: unknown): number =>
  typeof v === 'number' && isFinite(v) ? v : 0

/**
 * Pull the quote assets out of a leg's `symbol` field, which reaches us in one
 * of three shapes depending on how far along the read path we are: a real `Map`
 * (raw lean document), an array of `{ key, value }` (after
 * `convertComboBotToArray`), or a plain object (already JSON round-tripped).
 */
const quoteAssetsOfLeg = (leg: HedgeLegLike): string[] => {
  const symbol = leg.symbol
  const out = new Set<string>()
  const take = (v: unknown) => {
    const q = (v as SymbolLike | undefined)?.quoteAsset
    if (typeof q === 'string' && q) {
      out.add(q)
    }
  }
  if (symbol instanceof Map) {
    for (const v of symbol.values()) take(v)
  } else if (Array.isArray(symbol)) {
    for (const entry of symbol) {
      take((entry as { value?: unknown })?.value ?? entry)
    }
  } else if (symbol && typeof symbol === 'object') {
    for (const v of Object.values(symbol as Record<string, unknown>)) take(v)
  }
  return [...out]
}

const mergeProfitByAssets = (legs: HedgeLegLike[]): ProfitByAsset[] => {
  const byAsset = new Map<string, ProfitByAsset>()
  for (const leg of legs) {
    for (const entry of leg?.profitByAssets ?? []) {
      if (!entry?.asset) {
        continue
      }
      const acc = byAsset.get(entry.asset) ?? {
        asset: entry.asset,
        total: 0,
        totalUsd: 0,
      }
      acc.total += num(entry.total)
      acc.totalUsd += num(entry.totalUsd)
      byAsset.set(entry.asset, acc)
    }
  }
  return [...byAsset.values()]
}

/**
 * Aggregate the two legs of a hedge bot into the figures the wrapper document
 * does not maintain. Either leg may be missing (a half-built or partially
 * deleted hedge bot); missing legs simply contribute nothing.
 */
export const aggregateHedgeLegs = (
  long?: HedgeLegLike | null,
  short?: HedgeLegLike | null,
): HedgeAggregate => {
  const legs = [long, short].filter(Boolean) as HedgeLegLike[]

  const quoteAssets = [...new Set(legs.flatMap(quoteAssetsOfLeg))]
  // One distinct quote asset across both legs (or none to compare, e.g. a bot
  // that has never traded) means the native-unit sums below are meaningful.
  const nativeBasis: 'exact' | 'mixed' =
    quoteAssets.length > 1 ? 'mixed' : 'exact'
  const native = nativeBasis === 'exact' ? 1 : 0

  const sum = (pick: (leg: HedgeLegLike) => unknown) =>
    legs.reduce((acc, leg) => acc + num(pick(leg)), 0)

  const deals = (leg: HedgeLegLike) => leg.deals ?? leg.dealsInBot

  return {
    profit: {
      total: native * sum((l) => l.profit?.total),
      totalUsd: sum((l) => l.profit?.totalUsd),
      freeTotal: native * sum((l) => l.profit?.freeTotal),
      freeTotalUsd: sum((l) => l.profit?.freeTotalUsd),
      pureBase: native * sum((l) => l.profit?.pureBase),
      pureQuote: native * sum((l) => l.profit?.pureQuote),
    },
    profitByAssets: mergeProfitByAssets(legs),
    profitToday: {
      // `start`/`end` are the legs' own day boundaries, not amounts — take the
      // latest window rather than adding two epochs together.
      start: Math.max(0, ...legs.map((l) => num(l.profitToday?.start))),
      end: Math.max(0, ...legs.map((l) => num(l.profitToday?.end))),
      totalToday: native * sum((l) => l.profitToday?.totalToday),
      totalTodayUsd: sum((l) => l.profitToday?.totalTodayUsd),
    },
    unrealizedProfit: sum((l) => l.unrealizedProfit),
    workingTimeNumber: Math.max(
      0,
      ...legs.map((l) => num(l.workingTimeNumber)),
    ),
    dealsInBot: {
      all: sum((l) => deals(l)?.all),
      active: sum((l) => deals(l)?.active),
    },
    nativeBasis,
    quoteAssets,
  }
}

export default aggregateHedgeLegs
