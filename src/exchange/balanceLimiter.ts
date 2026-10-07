import RedisClient from '../db/redis'
import logger from '../utils/logger'

/**
 * Per-account limiter for exchange balance reads — SHADOW MODE ONLY.
 *
 * A balance read is one of the most expensive calls a venue meters (Binance
 * spot charges 20 weight for it), and it is the one a busy account can repeat
 * without limit: every bot tick that misses the stored balance, every
 * portfolio refresh, every API client polling for its balance. Those weights
 * come out of a per-IP budget shared by every user on that connector, so one
 * account reading in a loop delays everybody's order placement.
 *
 * The limiter is keyed by EXCHANGE ACCOUNT (see `accountRefFor`), not by user
 * or IP, and would apply three rules, in order:
 *
 *   merge  — a read for this account is already in flight: share its answer.
 *            Never staler than a call of its own, so it is safe for everyone.
 *   reuse  — this account was read live within `windowMs` and has not placed
 *            or cancelled an order through us since: serve that answer.
 *   budget — this account already made `perMinute` live reads this minute:
 *            serve the last known answer instead of calling the venue.
 *
 * Reads that size a deal from the balance (`EXEMPT_CALLERS`) can only ever be
 * merged — never reused or held back — so a percentage-of-balance deal is
 * always sized from a live figure.
 *
 * This version ENFORCES NOTHING. Every read still goes to the venue; the
 * verdict it would have received is only recorded on the request's telemetry
 * row, so the rules can be judged against real traffic (which accounts they
 * would touch, from which code paths) before any of them is switched on. The
 * bookkeeping mirrors enforcement exactly — only reads that WOULD have been
 * live take the in-flight slot, open a reuse window or count against the
 * budget — so the shadow numbers are the numbers enforcement would produce.
 *
 * `BALANCE_LIMITER_MODE=off` disables the bookkeeping entirely. Any Redis
 * failure yields an empty verdict and never affects the read itself.
 */
export type BalanceLimiterVerdict = 'merge' | 'reuse' | 'budget' | 'live' | ''

/** Callers that must always be served a live (or merged) figure. */
export const EXEMPT_CALLERS: ReadonlySet<string> = new Set([
  'bot.dealSizing',
  'bot.balanceStart',
])

const PREFIX = 'gainium:balanceLimiter'
/** Upper bound on how long an in-flight marker can outlive a hung read. */
const IN_FLIGHT_TTL_SEC = 30

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type BalanceLimiterTicket = {
  verdict: BalanceLimiterVerdict
  /** Finish the bookkeeping once the read has answered. Never throws. */
  settle: (ok: boolean) => void
}

const noopTicket: BalanceLimiterTicket = {
  verdict: '',
  settle: () => undefined,
}

export class BalanceLimiter {
  private static _instance: BalanceLimiter | null = null
  static getInstance(): BalanceLimiter {
    if (!BalanceLimiter._instance) {
      BalanceLimiter._instance = new BalanceLimiter()
    }
    return BalanceLimiter._instance
  }

  get enabled() {
    return (process.env.BALANCE_LIMITER_MODE ?? 'log').toLowerCase() !== 'off'
  }

  get windowMs() {
    return envNumber('BALANCE_LIMITER_WINDOW_MS', 5000)
  }

  get perMinute() {
    return envNumber('BALANCE_LIMITER_PER_MINUTE', 6)
  }

  private key(accountRef: string, part: string) {
    return `${PREFIX}:${accountRef}:${part}`
  }

  /**
   * Classify a balance read that is about to go to the venue. Resolves with a
   * ticket whose `settle` must be called when the read answers.
   */
  async begin(
    accountRef: string,
    caller: string,
  ): Promise<BalanceLimiterTicket> {
    if (!this.enabled || !accountRef) {
      return noopTicket
    }
    try {
      const redis = await RedisClient.getInstance()
      const inFlightKey = this.key(accountRef, 'inflight')
      const took = await redis.setNx(
        inFlightKey,
        `${Date.now()}`,
        IN_FLIGHT_TTL_SEC,
      )
      if (took === undefined) {
        return noopTicket
      }
      if (!took) {
        return { verdict: 'merge', settle: () => undefined }
      }
      const release = (verdict: BalanceLimiterVerdict) => (ok: boolean) => {
        void (async () => {
          await redis.del(inFlightKey)
          if (ok && verdict === 'live') {
            await redis.set(
              this.key(accountRef, 'fresh'),
              `${Date.now()}`,
              Math.max(1, Math.ceil(this.windowMs / 1000)),
            )
          }
        })().catch(() => undefined)
      }
      if (!EXEMPT_CALLERS.has(caller)) {
        if (await redis.get(this.key(accountRef, 'fresh'))) {
          // Would have been served the recent answer, so it is not a live
          // read: give the in-flight slot back and leave the window as is.
          void redis.del(inFlightKey)
          return { verdict: 'reuse', settle: () => undefined }
        }
      }
      const minute = Math.floor(Date.now() / 60000)
      const countKey = this.key(accountRef, `n:${minute}`)
      const count = await redis.incr(countKey)
      if (count === 1) {
        void redis.expire(countKey, 120)
      }
      if (
        count !== undefined &&
        count > this.perMinute &&
        !EXEMPT_CALLERS.has(caller)
      ) {
        void redis.del(inFlightKey)
        return { verdict: 'budget', settle: () => undefined }
      }
      return { verdict: 'live', settle: release('live') }
    } catch (e) {
      logger.debug(
        `BalanceLimiter | begin failed: ${(e as Error)?.message ?? e}`,
      )
      return noopTicket
    }
  }

  /**
   * The account just placed or cancelled an order through us, so its balance
   * has moved: the next read must not be treated as reusable.
   */
  invalidate(accountRef: string) {
    if (!this.enabled || !accountRef) {
      return
    }
    void RedisClient.getInstance()
      .then((redis) => redis.del(this.key(accountRef, 'fresh')))
      .catch(() => undefined)
  }
}

export default BalanceLimiter
