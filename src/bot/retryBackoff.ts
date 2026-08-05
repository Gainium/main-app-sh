import RedisClient from '../db/redis'
import logger from '../utils/logger'

/**
 * Shared exponential-backoff cooldown for order rejections that will not
 * succeed if we simply try again.
 *
 * Several exchange rejections share one shape: the venue says no for a reason
 * that will not change in the next few seconds, but nothing in the engine gates
 * the next attempt — `BotStatusEnum.error` is a SOFT status that `placeOrders`
 * clears via `restoreFromRangeOrError()` before each placement. The result is a
 * bot re-asking the venue the same impossible question forever. Two independent
 * fixes for two instances of it (a permanent jurisdiction block, and an order
 * larger than the available balance) had each grown their own cooldown; this is
 * the mechanism both now share.
 *
 * Design notes:
 * - **Redis, not memory.** Bots are spread over per-bot-type PM2 workers and
 *   restart independently, so an in-process map both fragments the window and
 *   forgets it on restart. Redis is the only state shared across workers.
 * - **Exponential, not fixed.** A fixed window has to pick between recovering
 *   quickly from a transient condition and being cheap for a chronic one.
 *   Backoff gets both: the first re-probe lands at `min`, and an order that
 *   keeps failing settles at `max`. Production has both cases — a shortfall
 *   that clears in minutes, and deals whose base left the account months ago.
 * - **Only real rejections extend the window.** `record()` must be called for
 *   rejections that actually came back from the venue. Recording a locally
 *   suppressed attempt would slide the window forward forever and it would
 *   never self-heal.
 * - **Fail-open.** Any Redis error behaves as "no cooldown" and the order goes
 *   to the exchange. A Redis blip must never wedge order placement.
 *
 * Not used by `QuantRulesGuard`: Binance's -4400 ladder has its own escalation
 * levels and account-vs-symbol scopes tied to the venue's penalty model, and it
 * DELAYS orders rather than failing them. Folding it in here would lose that.
 */

const logPrefix = '[RetryBackoff]'

export type BackoffState = {
  /** Cooldown expiry, ms epoch. */
  until: number
  /** The venue's own rejection text, replayed verbatim while suppressed. */
  reason: string
  /** Window length that produced `until`, ms. Doubles per consecutive miss. */
  interval: number
  /** How many rejections have been recorded in this run. */
  attempt: number
}

export type BackoffCheck =
  | { suppressed: false; reason: null; until: null; attempt: 0 }
  | { suppressed: true; reason: string; until: number; attempt: number }

const NOT_SUPPRESSED: BackoffCheck = {
  suppressed: false,
  reason: null,
  until: null,
  attempt: 0,
}

const parse = (raw: string | null | undefined | void): BackoffState | null => {
  if (!raw) {
    return null
  }
  try {
    const p = JSON.parse(raw) as Partial<BackoffState>
    const until = Number(p.until)
    const interval = Number(p.interval)
    const attempt = Number(p.attempt)
    if (!Number.isFinite(until) || !Number.isFinite(interval) || !p.reason) {
      return null
    }
    return {
      until,
      interval,
      reason: p.reason,
      attempt: Number.isFinite(attempt) ? attempt : 1,
    }
  } catch {
    return null
  }
}

export type RetryBackoffOptions = {
  /** Redis key namespace, e.g. `cr` (compliance) or `nb` (not enough balance). */
  namespace: string
  /** First cooldown after the initial rejection. */
  minMs: number
  /** Ceiling a repeatedly-failing order settles at. */
  maxMs: number
  /** Growth per consecutive rejection. Default 2. */
  factor?: number
}

export class RetryBackoff {
  private readonly factor: number

  constructor(private readonly opts: RetryBackoffOptions) {
    this.factor = opts.factor ?? 2
  }

  /**
   * Key the cooldown on whatever identifies the *constraint*, not the order.
   * Callers pass the parts; they are joined verbatim.
   */
  private key(parts: string[]) {
    return `${this.opts.namespace}:cd:${parts.join(':')}`
  }

  /**
   * Record a fresh rejection and open or widen the cooldown. Returns the new
   * state. Call this ONLY for rejections that came back from the exchange.
   */
  async record(parts: string[], reason: string): Promise<BackoffState> {
    const now = +new Date()
    const key = this.key(parts)
    let interval = this.opts.minMs
    let attempt = 1
    try {
      const redis = await RedisClient.getInstance()
      const prev = parse(await redis.get(key))
      if (prev) {
        interval = Math.min(prev.interval * this.factor, this.opts.maxMs)
        attempt = prev.attempt + 1
      }
      const state: BackoffState = {
        until: now + interval,
        reason,
        interval,
        attempt,
      }
      // TTL outlives the window so the next rejection can still see the
      // previous interval and keep escalating instead of resetting to min.
      await redis.set(
        key,
        JSON.stringify(state),
        Math.ceil((interval * 2) / 1000),
      )
      return state
    } catch (e) {
      logger.error(
        `${logPrefix} record ${key} error: ${(e as Error)?.message ?? e}`,
      )
      return { until: now + interval, reason, interval, attempt }
    }
  }

  /**
   * Is this constraint inside a cooldown? Returns the cached rejection so the
   * caller can replay it through its normal error path. Fail-open.
   */
  async check(parts: string[]): Promise<BackoffCheck> {
    const key = this.key(parts)
    try {
      const redis = await RedisClient.getInstance()
      const state = parse(await redis.get(key))
      if (!state || state.until <= +new Date()) {
        return NOT_SUPPRESSED
      }
      return {
        suppressed: true,
        reason: state.reason,
        until: state.until,
        attempt: state.attempt,
      }
    } catch (e) {
      logger.error(
        `${logPrefix} check ${key} error: ${(e as Error)?.message ?? e}`,
      )
      return NOT_SUPPRESSED
    }
  }

  /** Drop a cooldown — call when the underlying constraint is known to be gone. */
  async clear(parts: string[]): Promise<void> {
    try {
      const redis = await RedisClient.getInstance()
      await redis.del(this.key(parts))
    } catch (e) {
      logger.error(
        `${logPrefix} clear ${this.key(parts)} error: ${
          (e as Error)?.message ?? e
        }`,
      )
    }
  }
}

export default RetryBackoff
