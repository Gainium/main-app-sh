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
  // Kraken answers a dead credential with `EAPI:Invalid key`. VENUE-PREFIXED on
  // purpose: a bare `invalid key` would widen the allowlist past what we have
  // seen, and Kraken's neighbouring `EAPI:Invalid nonce` / `EAPI:Invalid
  // signature` are genuinely retryable and must stay transient.
  'eapi:invalid key',
  // Bitget: the key was deleted (40037), or the passphrase does not belong to
  // it (40012). Bitget's other key-scoped refusals stay out on purpose:
  // - `invalid ip,current request ip …` (40018) names ONE egress IP. Bitget
  //   calls are not pinned to a connector, so a key allow-listing only some of
  //   the fleet's IPs is refused on some calls and accepted on the next.
  // - `sign signature error` (40009) can come from how one request was
  //   signed, the same reason Kraken's `EAPI:Invalid signature` stays out.
  // - `user status is abnormal` is a restriction Bitget can lift without the
  //   user touching the key, which the fee cron's key-disable would not notice.
  'apikey does not exist',
  'apikey/password is incorrect',
]

/** Does this exchange rejection describe a dead credential? */
export const isHardAuthFailure = (reason?: string | null): boolean => {
  if (!reason) {
    return false
  }
  const r = reason.toLowerCase()
  return AUTH_FAILURE_SIGNATURES.some((s) => r.includes(s))
}

/**
 * Lower-cased substrings that mark a venue LOCKOUT — a different condition from
 * a dead credential, and deliberately a different list.
 *
 * Kraken answers too many sequential `EAPI:Invalid key` attempts with
 * `EGeneral:Temporary lockout`, and **every further attempt with that key
 * restarts the lockout timer**. Two consequences follow, and together they are
 * why a dead-credential allowlist cannot cover this case:
 *
 * 1. While locked, the venue stops returning the dead-key wording — the lockout
 *    MASKS the only signature {@link isHardAuthFailure} knows. A caller gated
 *    solely on that list therefore never records anything for a locked account
 *    and re-asks on its next cycle, forever.
 * 2. That re-ask is itself what keeps the lockout alive. The condition hiding
 *    the signature is sustained by the calls the missing signature fails to
 *    gate.
 *
 * The only exit is silence for longer than the lockout window, after which the
 * venue answers honestly again — either OK, or the dead-key wording, which the
 * hard-auth guard above then handles as it always did. The two gates compose.
 *
 * Kept OUT of {@link AUTH_FAILURE_SIGNATURES} on purpose: that list also drives
 * the hourly fee cron's consecutive-failure key-disable, and a lockout does not
 * mean the key is bad — an account can be locked out by its own retry loop while
 * its credentials are perfectly valid.
 */
export const VENUE_LOCKOUT_SIGNATURES = [
  // Venue-prefixed for the same reason `eapi:invalid key` is: a bare `lockout`
  // would widen the allowlist past the wording we have actually observed.
  'egeneral:temporary lockout',
]

/** Is this exchange rejection a venue lockout that must be waited out? */
export const isVenueLockout = (reason?: string | null): boolean => {
  if (!reason) {
    return false
  }
  const r = reason.toLowerCase()
  return VENUE_LOCKOUT_SIGNATURES.some((s) => r.includes(s))
}

const logPrefix = '[AuthFailureGuard]'

const AUTH_MIN_MS = 5 * 60 * 1000

const AUTH_MAX_MS = 60 * 60 * 1000

const backoff = new RetryBackoff({
  namespace: 'af',
  minMs: AUTH_MIN_MS,
  maxMs: AUTH_MAX_MS,
  // Remember the last window for longer than the slowest caller's cadence.
  // The position reconciler re-reads every account every 15 min; with the
  // default memory (2x window = 10 min after the first rejection) each visit
  // found no state, restarted at 5 min, and was never suppressed — a dead key
  // was re-sent once per cycle forever. Two hours covers the 1 h ceiling.
  memoryMs: 2 * AUTH_MAX_MS,
})

/**
 * First lockout cooldown. Has to clear TWO different things at once:
 * - Kraken's own lockout window, which its docs describe as temporary
 *   (minutes) but which restarts on every attempt made during it;
 * - the slowest gated caller's cadence — the position reconciler asks every
 *   `PR_CYCLE_MS` (15 min default). A window below that re-probes on the very
 *   next cycle and produces no silence at all.
 *
 * 30 minutes is 2x that cycle, so at least one whole cycle passes untouched.
 */
export const VENUE_LOCKOUT_MIN_MS = 30 * 60 * 1000

/**
 * Ceiling for an account that is STILL locked after a silent window — i.e. one
 * that some other, ungated caller is also probing. Backing off further is the
 * only response that does not add to the cause.
 */
export const VENUE_LOCKOUT_MAX_MS = 4 * 60 * 60 * 1000

const lockoutBackoff = new RetryBackoff({
  namespace: 'lk',
  minMs: VENUE_LOCKOUT_MIN_MS,
  maxMs: VENUE_LOCKOUT_MAX_MS,
  // Above `maxMs` by construction. A memory shorter than the caller's cadence
  // is what made the first hard-auth gate here ship inert: `check()` found an
  // expired key on every visit, restarted at `minMs`, and suppressed nothing.
  memoryMs: 2 * VENUE_LOCKOUT_MAX_MS,
})

/**
 * Venue-lockout cooldown, keyed per ACCOUNT like the auth guard above and built
 * on the same shared {@link RetryBackoff}.
 *
 * Separate from {@link AuthFailureGuard} rather than folded into it: that
 * guard's `check()` sits on four live bot-engine call sites, and the two
 * conditions are genuinely different — a dead key needs the USER to act, a
 * lockout needs only time, and their windows must be able to run independently
 * without either clearing the other.
 *
 * Fail-open on any Redis trouble, exactly like the auth guard: a blip reads as
 * "no cooldown" and the call goes to the venue.
 */
export class VenueLockoutGuard {
  /**
   * Remember a lockout the venue actually returned. Never call this for a
   * locally suppressed attempt — that would slide the window forward forever
   * and the account would never be re-probed.
   */
  static async record(input: {
    exchangeUUID: string
    reason: string
  }): Promise<number> {
    const state = await lockoutBackoff.record([input.exchangeUUID], input.reason)
    return state.until
  }

  /** Is this account inside a lockout cooldown? Replays the venue's wording. */
  static async check(exchangeUUID: string): Promise<AuthCheckResult> {
    const res = await lockoutBackoff.check([exchangeUUID])
    return {
      failed: res.suppressed,
      reason: res.reason,
      until: res.until,
    }
  }

  /** Drop a lockout cooldown — e.g. when the user re-enters the key (and by tests). */
  static async clear(exchangeUUID: string): Promise<void> {
    return lockoutBackoff.clear([exchangeUUID])
  }
}

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
