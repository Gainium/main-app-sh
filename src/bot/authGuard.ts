import RedisClient from '../db/redis'
import logger from '../utils/logger'
import RetryBackoff from './retryBackoff'

/**
 * Hard exchange-auth failure cooldown guard.
 *
 * A dead / expired / revoked / IP-blocked API key is a PERMANENT account
 * condition, not a transient one: no retry can succeed until the *user* fixes
 * the key. The bot engine nevertheless re-asks on every tick, because
 * `BotStatusEnum.error` is a SOFT status that the combo/DCA price-update path
 * clears through `restoreFromRangeOrError()` before the next cycle. Production
 * showed one combo bot on a Bybit key logging
 *   `Reason Your api key has expired. Method checkAssets() Step getBalance`
 * 211 times across 131 distinct minutes in 2.2h — ~2/min, indefinitely — while
 * the bot itself sat at `status: 'open'` with `statusReason: ''`, i.e. the
 * `API keys error` classification (`errorsBot: true`) was firing every single
 * minute and was powerless to stop it.
 *
 * The classification is therefore NOT the missing piece; the missing piece is a
 * gate on the call itself. This guard caches the venue's own rejection per
 * ACCOUNT (= exchangeUUID — a credential is account-wide, not per symbol) so the
 * engine can stop re-hitting the exchange, stop re-flooding the error log, and
 * stop writing a `botevents` row per attempt (290 rows in 3h for that one bot).
 *
 * The cooldown mechanism itself lives in {@link RetryBackoff}, shared with the
 * compliance-restriction and not-enough-balance gates. Backoff (5min → 1h) means
 * a key the user actually fixes is picked up within 5 minutes, while one that is
 * never fixed settles at an hourly re-probe. Each re-probe that still fails
 * reports normally, so the user keeps getting a refreshed, actionable error —
 * just at a sane rate instead of twice a minute.
 *
 * Deliberately a CONSERVATIVE POSITIVE ALLOWLIST of hard-credential signatures
 * rather than the whole `API keys error` subType: that subType also covers
 * signature/nonce blips (`EAPI:Invalid nonce`) which genuinely can succeed on
 * the next try, and putting those behind a 5-minute cooldown would delay a
 * recoverable account. Anything not matched here keeps today's behaviour.
 */

/**
 * Lower-cased substrings that mark a HARD exchange-auth failure. Canonical
 * definition, shared with the hourly fee cron (`main-app/src/user/utils.ts`),
 * which learned the same lesson first — one list so the two cannot drift.
 */
export const AUTH_FAILURE_SIGNATURES = [
  'api key has expired', // Binance: "Your api key has expired."
  'api-key has expired',
  'apikey has expired',
  'api key is invalid', // Bybit
  'apikey is invalid',
  'invalid api-key', // OKX "Invalid Api-Key ID.", Binance "Invalid API-key, IP, or permissions..."
  'invalid api key',
  'invalid apikey',
  'api-key format invalid', // Binance -2014
  'api-key not exists', // KuCoin "KC-API-KEY not exists | 400003"
  'api key not exists',
  'apikey not exists',
  'api-passphrase', // KuCoin wrong passphrase
]

/** Does this exchange rejection describe a dead credential? */
export const isHardAuthFailure = (reason?: string | null): boolean => {
  if (!reason) {
    return false
  }
  const r = reason.toLowerCase()
  return AUTH_FAILURE_SIGNATURES.some((s) => r.includes(s))
}

const logPrefix = '[AuthFailureGuard]'

const AUTH_MIN_MS = 5 * 60 * 1000

const backoff = new RetryBackoff({
  namespace: 'af',
  minMs: AUTH_MIN_MS,
  maxMs: 60 * 60 * 1000,
})

/** Redis key holding "an alert already went out for this account's window". */
const alertKey = (exchangeUUID: string) => `af:alert:${exchangeUUID}`

export type AuthCheckResult = {
  /** Is this account inside an auth-failure cooldown? */
  failed: boolean
  /** The exchange's own rejection text, replayed verbatim. */
  reason: string | null
  /** Cooldown expiry (ms epoch), or null when not failing. */
  until: number | null
}

export class AuthFailureGuard {
  /**
   * Remember a fresh hard-auth rejection for this account. Called only for
   * rejections that actually came back from the exchange, so a locally
   * suppressed attempt can never slide the window forward.
   */
  static async record(input: {
    exchangeUUID: string
    reason: string
  }): Promise<number> {
    const state = await backoff.record([input.exchangeUUID], input.reason)
    return state.until
  }

  /**
   * Is this account inside an auth-failure cooldown? Returns the cached
   * rejection so the caller can replay it. Fail-open: on any Redis error,
   * returns failed=false and the call goes to the exchange.
   */
  static async check(exchangeUUID: string): Promise<AuthCheckResult> {
    const res = await backoff.check([exchangeUUID])
    return {
      failed: res.suppressed,
      reason: res.reason,
      until: res.until,
    }
  }

  /**
   * Claim the ONE user-facing alert this account is allowed for its current
   * cooldown window. Returns true for exactly one caller per window — across
   * sibling bots AND across worker processes — and false for every other
   * occurrence inside it.
   *
   * Why this is needed on top of the call gate: the gate above suppresses the
   * exchange round trip and the error LOG line, but it deliberately replays the
   * venue's cached rejection so that "every caller's existing `status === notok`
   * branch is unchanged" — and one of those branches is the one that raises
   * `botError` → AlertService → Telegram. Suppressing the log without the alert
   * is the worst split of the two: prod looks clean while the user's phone does
   * not. Worse, a suppressed call returns with no network wait, so the loop
   * churns faster; production went from 95 alerts/day before the gate to 103
   * after, including 50 in a single minute from four sibling bots on one revoked
   * key. A dead credential is ONE account-wide condition, so it is worth exactly
   * one actionable alert per backoff window, not one per bot per call.
   *
   * Keyed on `exchangeUUID` (a credential is account-wide) and made atomic by
   * `INCR`, so the sibling bots that re-probe in the same second cannot each
   * win. Fail-OPEN on any Redis trouble: a duplicate "your API key was rejected"
   * is an annoyance, a silenced one loses the user money.
   */
  static async claimAlert(exchangeUUID: string): Promise<boolean> {
    try {
      const state = await backoff.check([exchangeUUID])
      const now = +new Date()
      // Tie the claim's lifetime to the cooldown itself so it expires exactly
      // when the window does: the first REAL re-probe after that is then the
      // first caller to INCR and earns a fresh, refreshed alert, while every
      // replay inside the window shares the one already sent. The fallback
      // covers the hard-auth call sites that are still ungated (`checkOrder` /
      // `getOrder`), which reach here with no `record()` behind them — they get
      // the same one-per-minimum-window budget instead of one per call.
      const ttlMs =
        state.suppressed && state.until > now ? state.until - now : AUTH_MIN_MS
      const redis = await RedisClient.getInstance()
      const key = alertKey(exchangeUUID)
      const count = await redis.incr(key)
      if (count === undefined) {
        return true
      }
      // Re-armed on EVERY occurrence, not just the winning one: a claim left
      // without a TTL (process died between INCR and EXPIRE) would silence the
      // account for good, and a claim from a narrower window would otherwise
      // outlive a cooldown that a later re-probe has since widened.
      await redis.expire(key, Math.ceil(ttlMs / 1000))
      return count === 1
    } catch (e) {
      logger.error(
        `${logPrefix} claimAlert ${exchangeUUID} error: ${
          (e as Error)?.message ?? e
        }`,
      )
      return true
    }
  }

  /** Drop a cooldown — e.g. when the user re-enters the key (and by tests). */
  static async clear(exchangeUUID: string): Promise<void> {
    await RedisClient.getInstance()
      .then((r) => r.del(alertKey(exchangeUUID)))
      .catch(() => undefined)
    return backoff.clear([exchangeUUID])
  }
}

export default AuthFailureGuard
