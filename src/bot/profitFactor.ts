/**
 * Profit factor = gross profit / gross loss, the standard definition and the
 * one the backtester reports (`@gainium/backtester` dca strategy), so a live
 * bot and a backtest of the same strategy are comparable.
 *
 * Until this helper the live engine stored `winning deals / losing deals` — a
 * ratio of COUNTS under the profit-factor label. A bot winning 9 deals of +$1
 * and losing 1 of -$50 read 9.0 there; its real profit factor is 0.18.
 *
 * Returns the encoding the stats documents already use:
 *  - `-1` when there are profits but no losses (rendered as ∞);
 *  - `0` when there is nothing to divide (no profit, or no deals at all).
 *
 * `grossLoss` is accepted with either sign: the stats documents accumulate it
 * as a negative sum of losing deals' profit.
 */
export const profitFactorOf = (grossProfit: number, grossLoss: number) => {
  const profit = Number.isFinite(grossProfit) ? Math.max(0, grossProfit) : 0
  const loss = Number.isFinite(grossLoss) ? Math.abs(grossLoss) : 0
  if (loss === 0) {
    return profit > 0 ? -1 : 0
  }
  return profit / loss
}

type StatsWithGross = {
  numerical?: {
    profit?: { grossProfit?: { usd?: number } }
    loss?: { grossLoss?: { usd?: number } }
    ratios?: { profitFactor?: number }
  }
}
type PairWithGross = {
  numerical?: {
    general?: {
      profitFactor?: number | null
      grossProfit?: { usd?: number }
      grossLoss?: { usd?: number }
    }
  }
}

/**
 * Read-side correction for stats stored before `profitFactorOf` existed, for
 * consumers that hand the raw documents on (the AI's bot details).
 *
 * A stored factor is only rewritten on the bot's next close, so a stopped bot
 * would keep the count ratio forever. The bot-wide gross totals were always
 * accumulated, so that factor is recomputed here. A pair with no gross totals
 * yet has no correct factor to offer; it is returned as `null` rather than as
 * the count ratio.
 */
export const withGrossProfitFactors = <
  S extends StatsWithGross | null | undefined,
  P extends PairWithGross,
>(
  stats: S,
  symbolStats: P[] | null | undefined,
): { stats: S; symbolStats: P[] | null } => {
  const grossProfit = stats?.numerical?.profit?.grossProfit?.usd
  const grossLoss = stats?.numerical?.loss?.grossLoss?.usd
  const fixedStats =
    stats?.numerical?.ratios &&
    typeof grossProfit === 'number' &&
    typeof grossLoss === 'number'
      ? {
          ...stats,
          numerical: {
            ...stats.numerical,
            ratios: {
              ...stats.numerical.ratios,
              profitFactor: profitFactorOf(grossProfit, grossLoss),
            },
          },
        }
      : stats
  const fixedPairs = symbolStats
    ? symbolStats.map((pair) => {
        const general = pair.numerical?.general
        if (!general) {
          return pair
        }
        const pairProfit = general.grossProfit?.usd
        const pairLoss = general.grossLoss?.usd
        return {
          ...pair,
          numerical: {
            ...pair.numerical,
            general: {
              ...general,
              profitFactor:
                typeof pairProfit === 'number' && typeof pairLoss === 'number'
                  ? profitFactorOf(pairProfit, pairLoss)
                  : null,
            },
          },
        }
      })
    : null
  return { stats: fixedStats as S, symbolStats: fixedPairs }
}
