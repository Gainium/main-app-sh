import RetryBackoff from './retryBackoff'

/**
 * Spec `186`. Cooldown for a futures grid level the venue refuses as
 * un-reducible.
 *
 * A long grid's SELL levels (a short grid's BUY levels) are sent reduce-only.
 * When the venue holds less position than the level would reduce it refuses —
 * Binance -2022 `ReduceOnly Order is rejected`, and the other texts in
 * `positionAlreadyClosedReasons`. Nothing remembered that between rebuilds: the
 * refused level is dropped from the grid, the next `limitOrders()` (every fill
 * runs one) regenerates it, finds it missing and sends it again under a fresh
 * client id. One bot re-sent the same refused SELL 420 times in six hours while
 * its other levels kept filling.
 *
 * Keyed on the LEVEL — bot, symbol, side, price — so the rest of the grid is
 * never held back. Same windows as `RiskTierGuard`: the condition is routinely
 * transient (a fill on the opening side grows the position again), so the first
 * re-probe is a minute away and a level that never clears settles at one
 * attempt per 15 minutes.
 */

const backoff = new RetryBackoff({
  namespace: 'gro',
  minMs: 60 * 1000,
  maxMs: 15 * 60 * 1000,
})

export type GridReduceOnlyLevel = {
  botId: string
  symbol: string
  side: string
  price: string | number
}

export type GridReduceOnlyCheckResult = {
  restricted: boolean
  /** The exchange's own rejection text, replayed verbatim. */
  reason: string | null
  /** Cooldown expiry (ms epoch), or null when not restricted. */
  until: number | null
  attempt: number
}

const keyOf = (level: GridReduceOnlyLevel) => [
  level.botId,
  level.symbol,
  level.side,
  `${+level.price}`,
]

export class GridReduceOnlyGuard {
  /**
   * Remember a fresh refusal of this level. Call ONLY for refusals that came
   * back from the venue, so a suppressed attempt can never slide the window.
   */
  static async record(
    level: GridReduceOnlyLevel,
    reason: string,
  ): Promise<number> {
    const state = await backoff.record(keyOf(level), reason)
    return state.until
  }

  /** Is this level inside a cooldown? Fail-open on any Redis error. */
  static async check(
    level: GridReduceOnlyLevel,
  ): Promise<GridReduceOnlyCheckResult> {
    const res = await backoff.check(keyOf(level))
    return {
      restricted: res.suppressed,
      reason: res.reason,
      until: res.until,
      attempt: res.attempt,
    }
  }

  /** Drop a cooldown — the venue has accepted this level. */
  static async clear(level: GridReduceOnlyLevel): Promise<void> {
    return backoff.clear(keyOf(level))
  }
}

export default GridReduceOnlyGuard
