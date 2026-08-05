import RetryBackoff from './retryBackoff'

/**
 * Compliance / jurisdiction restriction cooldown guard.
 *
 * Some exchange rejections are PERMANENT account conditions, not transient
 * ones — the instrument is not tradable by this account holder at all. Kraken
 * spot is the loud case:
 *   `EAccount:Invalid permissions:USDT trading restricted for DE.`
 * (classified as the `Compliance restriction` subType by the boterrorrules
 * `trading restricted for` pattern.)
 *
 * No retry can ever succeed, yet the bot engine re-attempts every few minutes:
 * `BotStatusEnum.error` is a SOFT status that `placeOrders` clears through
 * `restoreFromRangeOrError()` before each placement, so nothing gates the next
 * try. Production logged 82 such `openOrder` calls in 4h from ONE account.
 *
 * This guard caches the venue's own rejection per account (= exchangeUUID) and
 * per symbol, so the bot engine can serve it locally instead of re-hitting the
 * exchange. It deliberately does NOT change bot status, the message the user
 * sees, or the deal — the engine replays the cached rejection through the exact
 * same error path, so the ONLY difference is that we stop hammering the venue.
 *
 * The cooldown mechanism itself lives in {@link RetryBackoff}, shared with the
 * not-enough-balance gate. Backoff replaced the original fixed 1h window: a
 * restriction the account holder resolves is now picked up in 5 minutes instead
 * of up to an hour, while one that is never resolved still settles at the same
 * 1h ceiling. Strictly better at both ends.
 */

const backoff = new RetryBackoff({
  namespace: 'cr',
  minMs: 5 * 60 * 1000,
  maxMs: 60 * 60 * 1000,
})

export type ComplianceCheckResult = {
  restricted: boolean
  /** The exchange's own rejection text, replayed verbatim. */
  reason: string | null
  /** Cooldown expiry (ms epoch), or null when not restricted. */
  until: number | null
}

export class ComplianceGuard {
  /**
   * Remember a fresh compliance rejection for this account+symbol. Called only
   * for rejections that actually came back from the exchange, so a suppressed
   * attempt can never slide the window forward.
   */
  static async record(input: {
    exchangeUUID: string
    symbol: string
    reason: string
  }): Promise<number> {
    const state = await backoff.record(
      [input.exchangeUUID, input.symbol],
      input.reason,
    )
    return state.until
  }

  /**
   * Is this account+symbol inside a compliance-restriction cooldown? Returns
   * the cached rejection so the caller can replay it. Fail-open: on any Redis
   * error, returns restricted=false and the order goes to the exchange.
   */
  static async check(
    exchangeUUID: string,
    symbol: string,
  ): Promise<ComplianceCheckResult> {
    const res = await backoff.check([exchangeUUID, symbol])
    return {
      restricted: res.suppressed,
      reason: res.reason,
      until: res.until,
    }
  }

  /** Drop a cooldown (used by tests). */
  static async clear(exchangeUUID: string, symbol: string): Promise<void> {
    return backoff.clear([exchangeUUID, symbol])
  }
}

export default ComplianceGuard
