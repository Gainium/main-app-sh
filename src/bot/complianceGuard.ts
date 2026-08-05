import RedisClient from '../db/redis'
import logger from '../utils/logger'

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
 * per symbol for a bounded window, so the bot engine can serve it locally
 * instead of re-hitting the exchange. It deliberately does NOT change bot
 * status, the message the user sees, or the deal — the engine replays the
 * cached rejection through the exact same error path, so the ONLY difference is
 * that we stop hammering the venue.
 *
 * Follows the QuantRulesGuard pattern: a static class with no instance state,
 * flat namespaced Redis keys (Redis is the only state shared across the
 * per-bot-type PM2 workers), and fail-open semantics — on any Redis error we
 * log and behave as if there were no cooldown, so a Redis blip never wedges
 * order placement.
 */

/**
 * How long one observed rejection suppresses further venue calls for that
 * account+symbol. Long enough to collapse the loop (82 calls / 4h becomes 4),
 * short enough that a user who fixes the restriction resumes on their own.
 */
const COOLDOWN_MS = 60 * 60 * 1000

const logPrefix = '[ComplianceGuard]'

/** JSON {until, reason} for one account+symbol cooldown; TTL = cooldown secs. */
const cooldownKey = (exchangeUUID: string, symbol: string) =>
  `cr:cd:${exchangeUUID}:${symbol}`

export type ComplianceCheckResult = {
  restricted: boolean
  /** The exchange's own rejection text, replayed verbatim. */
  reason: string | null
  /** Cooldown expiry (ms epoch), or null when not restricted. */
  until: number | null
}

const NOT_RESTRICTED: ComplianceCheckResult = {
  restricted: false,
  reason: null,
  until: null,
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
    const until = +new Date() + COOLDOWN_MS
    try {
      const redis = await RedisClient.getInstance()
      await redis.set(
        cooldownKey(input.exchangeUUID, input.symbol),
        JSON.stringify({ until, reason: input.reason }),
        Math.ceil(COOLDOWN_MS / 1000),
      )
    } catch (e) {
      logger.error(
        `${logPrefix} record ${input.exchangeUUID}:${input.symbol} error: ${
          (e as Error)?.message ?? e
        }`,
      )
    }
    return until
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
    try {
      const redis = await RedisClient.getInstance()
      const raw = await redis.get(cooldownKey(exchangeUUID, symbol))
      if (!raw) {
        return NOT_RESTRICTED
      }
      const parsed = JSON.parse(raw) as { until?: number; reason?: string }
      const until = Number(parsed.until)
      if (!Number.isFinite(until) || until <= +new Date() || !parsed.reason) {
        return NOT_RESTRICTED
      }
      return { restricted: true, reason: parsed.reason, until }
    } catch (e) {
      logger.error(
        `${logPrefix} check ${exchangeUUID}:${symbol} error: ${
          (e as Error)?.message ?? e
        }`,
      )
      return NOT_RESTRICTED
    }
  }

  /** Drop a cooldown (used by tests). */
  static async clear(exchangeUUID: string, symbol: string): Promise<void> {
    try {
      const redis = await RedisClient.getInstance()
      await redis.set(cooldownKey(exchangeUUID, symbol), '', 1)
    } catch (e) {
      logger.error(
        `${logPrefix} clear ${exchangeUUID}:${symbol} error: ${
          (e as Error)?.message ?? e
        }`,
      )
    }
  }
}

export default ComplianceGuard
