import { ExchangeEnum } from '../../types'
import { FailsafeConfig, LOG_PREFIX } from './types'

/**
 * L2 load-control stack (spec §7.2 / §7.3) — the mutating actions live on the
 * injected redis client, but the decisions are deterministic and unit-tested
 * with a fake redis (sinon stubs).
 *
 * A "redis" here is the main-app RedisWrapper (core/src/db/redis) reached via
 * `RedisClient.getInstance()`; only the methods we use are typed below so the
 * pure decisions can be exercised with a stub.
 */
export interface RedisLike {
  // The main-app RedisWrapper resolves get to `string | null | void`; treat any
  // non-string as "absent" at call sites.
  get(key: string): Promise<string | null | void>
  set(key: string, value: string, ttlSec?: number): Promise<unknown>
  incr(key: string): Promise<number | undefined>
  expire(key: string, sec: number): Promise<unknown>
}

/** Why a confirm was skipped (maps to a counter field). */
export type SkipReason = 'cap' | 'congestion' | 'usage' | 'kill' | null

export interface KillState {
  off: boolean
  offExchanges: Set<string>
  shadow: boolean
  fetchedAt: number
}

/**
 * Kill-switch cache (spec §7.3): global off, per-exchange off, and force-shadow,
 * all polled with a 60 s cache so the runtime override lands in <= 60 s without a
 * restart. Pass the previous state back in to reuse the cache.
 */
export async function refreshKillSwitch(
  redis: RedisLike,
  prev: KillState | null,
  now: number = Date.now(),
): Promise<KillState> {
  if (prev && now - prev.fetchedAt < 60_000) return prev
  const [off, shadow] = await Promise.all([
    redis.get('gainium:failsafe:off'),
    redis.get('gainium:failsafe:shadow'),
  ])
  return {
    off: !!off,
    // Per-exchange off keys are looked up lazily in `isExchangeKilled`.
    offExchanges: prev?.offExchanges ?? new Set<string>(),
    shadow: !!shadow,
    fetchedAt: now,
  }
}

/** Per-exchange kill check (`gainium:failsafe:off:<exchange>`), also 60 s cached. */
export async function isExchangeKilled(
  redis: RedisLike,
  exchange: ExchangeEnum | string,
  cache: Map<string, { off: boolean; at: number }>,
  now: number = Date.now(),
): Promise<boolean> {
  const hit = cache.get(exchange)
  if (hit && now - hit.at < 60_000) return hit.off
  const v = await redis.get(`gainium:failsafe:off:${exchange}`)
  const off = !!v
  cache.set(exchange, { off, at: now })
  return off
}

/**
 * Rate cap (spec §7.2 (1)): INCR gainium:failsafe:confirms:<exchange>:<epochMin>
 * with EX 120; when the count exceeds FF_MAX_CONFIRMS_PER_MIN, skip. The counter
 * is charged optimistically before the confirm (the check reserves the slot).
 * Redis-unavailable (undefined) fails OPEN (allows) — the confirm itself is
 * harmless read-only and other controls still apply.
 */
export async function checkRateCap(
  redis: RedisLike,
  exchange: ExchangeEnum | string,
  cfg: FailsafeConfig,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  const epochMinute = Math.floor(now / 60_000)
  const key = `gainium:failsafe:confirms:${exchange}:${epochMinute}`
  const count = await redis.incr(key)
  if (count === undefined) return { ok: true }
  if (count === 1) await redis.expire(key, 120)
  return { ok: count <= cfg.maxConfirmsPerMin }
}

interface CongestionDoc {
  pressure: number
  updatedAt?: number
}

/**
 * Congestion breaker (spec §7.2 (2), §4): GET gainium:congestion:<exchange>.
 * pressure >= FF_CB_THRESHOLD => skip. Missing OR stale (updatedAt older than
 * 60 s) => skip ONLY when FF_CB_REQUIRE_SIGNAL is true (cloud prod); otherwise
 * the other controls govern and we allow.
 */
export async function checkCongestion(
  redis: RedisLike,
  exchange: ExchangeEnum | string,
  cfg: FailsafeConfig,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  const raw = await redis.get(`gainium:congestion:${exchange}`)
  if (!raw) return { ok: !cfg.cbRequireSignal }
  let doc: CongestionDoc
  try {
    doc = JSON.parse(raw) as CongestionDoc
  } catch {
    return { ok: !cfg.cbRequireSignal }
  }
  const stale =
    typeof doc.updatedAt === 'number' && now - doc.updatedAt > 60_000
  if (stale) return { ok: !cfg.cbRequireSignal }
  if (typeof doc.pressure !== 'number') return { ok: !cfg.cbRequireSignal }
  return { ok: doc.pressure < cfg.cbThreshold }
}

/**
 * Response-usage backoff (spec §7.2 (3)) — pure. Given the max `usage` ratio
 * observed across a batch of BaseReturn responses, decides whether to put the
 * exchange into a cooldown. Returns the cooldown deadline to store, or null.
 */
export function usageCooldownDeadline(
  maxUsage: number,
  cfg: FailsafeConfig,
  now: number = Date.now(),
): number | null {
  if (maxUsage >= cfg.usageBackoff) return now + cfg.usageCooldownMs
  return null
}

/** Whether an exchange is currently under a usage cooldown. */
export function isUsageCooled(
  cooldowns: Map<string, number>,
  exchange: ExchangeEnum | string,
  now: number = Date.now(),
): boolean {
  const until = cooldowns.get(exchange)
  return typeof until === 'number' && until > now
}

/**
 * Full pre-confirm gate for one exchange. Runs kill -> usage -> cap -> congestion
 * in that order (cheapest / most-decisive first) and returns the first failing
 * reason, or null when the confirm may proceed.
 */
export async function admitConfirm(
  redis: RedisLike,
  exchange: ExchangeEnum,
  cfg: FailsafeConfig,
  ctx: {
    kill: KillState
    exchangeKillCache: Map<string, { off: boolean; at: number }>
    usageCooldowns: Map<string, number>
  },
  now: number = Date.now(),
): Promise<SkipReason> {
  if (cfg.enabled === false) return 'kill'
  if (ctx.kill.off) return 'kill'
  if (await isExchangeKilled(redis, exchange, ctx.exchangeKillCache, now)) {
    return 'kill'
  }
  if (isUsageCooled(ctx.usageCooldowns, exchange, now)) return 'usage'
  if (!(await checkRateCap(redis, exchange, cfg, now)).ok) return 'cap'
  if (!(await checkCongestion(redis, exchange, cfg, now)).ok)
    return 'congestion'
  return null
}

export const logPrefix = LOG_PREFIX
