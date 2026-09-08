import RedisClient from '../db/redis'
import logger from '../utils/logger'
import { MathHelper } from '../utils/math'

/**
 * Learned quantity-precision guard.
 *
 * A pair's `baseAsset.step` comes from the venue's PUBLIC instrument list and is
 * stored once per `exchange@pair` in `pairs`. It is deliberately not per-account
 * — but the venue an account actually signs against is not always the one that
 * list came from. Bybit's regional hosts are the live example: `api.bybit.eu`
 * publishes 133 spot symbols to `api.bybit.com`'s 538, gives 34 of the shared
 * ones a COARSER `basePrecision` (SOLUSDC 0.001 vs 0.0001), and does not list
 * SOLUSDT at all. A bot on an `eu` connection therefore computes quantities that
 * are legal multiples of the `.com` step and gets every one of them refused with
 * `Order quantity has too many decimals.` — for 7.1 days straight, in the case
 * that produced this module.
 *
 * Re-keying the shared instrument load by host would change sizing for every
 * `.com` bot, and would not even have fixed that account (there is no EU
 * SOLUSDT row to key to). So we learn from the refusal instead: the quantity we
 * sent is in the rejection, and a refused quantity with `d` decimals proves the
 * venue accepts at most `d-1`. That fact is scoped to the connection + symbol
 * it was observed on and never leaves this module's own Redis keys.
 *
 * Shape follows {@link ../bot/quantRulesGuard QuantRulesGuard}: a static class
 * with no instance state and flat namespaced keys. Two differences, both
 * deliberate:
 *
 *  - **Reads are synchronous.** {@link QtyStepGuard.peek} is consulted from
 *    `MainBot.getExchangeInfo`, which runs on essentially every tick, and
 *    `RedisClient.getInstance()` retries a dead Redis forever (`db/redis.ts`
 *    `getClient`). Awaiting it there could wedge the engine, so the in-process
 *    Map is authoritative for reads and Redis is hydrated in the background.
 *  - **The Map is written before Redis.** The retry that depends on a lesson
 *    must work whether or not Redis answers.
 *
 * Fail-open throughout: any Redis error is logged and read as "nothing learned",
 * which restores today's behaviour exactly.
 */

const logPrefix = '[QtyStepGuard]'

const math = new MathHelper()

/** Learned precisions are long-lived but not immortal — venues re-list pairs. */
const REDIS_TTL_SEC = 90 * 24 * 60 * 60

/**
 * How long a hydrated (or missing) entry is trusted before the background read
 * is allowed to run again. Bounds the hot path to one Redis GET per
 * account+symbol per interval per process, and lets a lesson another worker
 * learned arrive without a restart.
 */
const HYDRATE_TTL_MS = 6 * 60 * 60 * 1000

/** Accepted decimal count for one connection+symbol. */
const stepKey = (exchangeUUID: string, symbol: string) =>
  `qstep:${exchangeUUID}:${symbol}`

const mapKey = (exchangeUUID: string, symbol: string) =>
  `${exchangeUUID}|${symbol}`

type Entry = {
  /** Accepted decimal count, or null when the venue has taught us nothing. */
  decimals: number | null
  /** When this entry was last reconciled with Redis (ms epoch). */
  hydratedAt: number
}

/**
 * One entry per connection+symbol this process has actually looked at, which is
 * bounded by the bots the worker runs — the same bound `leverageBracketCache`
 * relies on, so no eviction policy is needed. Entries are tiny (a number and a
 * timestamp) and the overwhelming majority hold `decimals: null`.
 */
const cache = new Map<string, Entry>()
const hydrating = new Set<string>()

/**
 * Does this venue refusal say our QUANTITY carried too many decimals?
 *
 * Only the quantity variant. `Order price has too many decimals.` is a
 * different failure with its own classification (`bot/utils.ts` `errorDict`)
 * and its own re-quantize branch (the tickSize / PRICE_FILTER one in
 * `sendOrderToExchange`), and must not be routed here.
 */
export const isQtyDecimalsRefusal = (reason?: string | null): boolean =>
  typeof reason === 'string' &&
  reason.toLowerCase().indexOf('quantity has too many decimals') !== -1

/**
 * The precision a refusal proves the venue accepts.
 *
 * The venue refused the quantity we sent, so whatever it accepts is strictly
 * coarser than what that quantity carried: one decimal place fewer. Returns
 * null when there is nothing coarser to try (a whole-unit quantity was
 * refused, so the cause is not precision) or the quantity is unreadable.
 */
export const deriveAcceptedDecimals = (
  qty: number | string,
): number | null => {
  const n = typeof qty === 'number' ? qty : parseFloat(qty)
  if (!Number.isFinite(n)) {
    return null
  }
  const sent = math.countDecimals(n)
  return sent > 0 ? sent - 1 : null
}

/** The `baseAsset.step` that a decimal count corresponds to. */
export const decimalsToStep = (decimals: number): number =>
  Number(`1e-${Math.max(0, Math.floor(decimals))}`)

export class QtyStepGuard {
  /**
   * The learned precision for a connection+symbol, or null if none.
   *
   * Synchronous by contract — see the class note. On a cold or stale entry it
   * schedules a background Redis read and answers from what it has now, so the
   * caller never waits and a persisted lesson is live from the next call.
   */
  static peek(
    exchangeUUID: string | undefined | null,
    symbol: string | undefined | null,
  ): number | null {
    if (!exchangeUUID || !symbol) {
      return null
    }
    const key = mapKey(exchangeUUID, symbol)
    const entry = cache.get(key)
    if (!entry || Date.now() - entry.hydratedAt > HYDRATE_TTL_MS) {
      void QtyStepGuard.hydrate(exchangeUUID, symbol, key)
    }
    return entry?.decimals ?? null
  }

  /**
   * Record what a refusal taught. Monotone: a learned precision may only ever
   * get coarser, so a stale finer value can never be restored by this path.
   *
   * Returns the precision in force after recording.
   */
  static async record(
    exchangeUUID: string | undefined | null,
    symbol: string,
    decimals: number,
  ): Promise<number | null> {
    if (!exchangeUUID || !symbol || !Number.isFinite(decimals)) {
      return null
    }
    const next = Math.max(0, Math.floor(decimals))
    const key = mapKey(exchangeUUID, symbol)
    const known = cache.get(key)?.decimals
    if (typeof known === 'number' && known <= next) {
      return known
    }
    // The Map first: the retry that depends on this lesson must not be
    // contingent on Redis answering.
    cache.set(key, { decimals: next, hydratedAt: Date.now() })
    try {
      // Same gate as `hydrate`: never build the client from an order path.
      if (!RedisClient._instance?.isReady) {
        return next
      }
      const redis = await RedisClient.getInstance()
      const raw = await redis.get(stepKey(exchangeUUID, symbol))
      const stored = raw === null || raw === undefined ? NaN : Number(raw)
      if (!Number.isFinite(stored) || stored > next) {
        await redis.set(
          stepKey(exchangeUUID, symbol),
          `${next}`,
          REDIS_TTL_SEC,
        )
      }
    } catch (e) {
      logger.error(`${logPrefix} cannot persist ${key} = ${next}: ${e}`)
    }
    return next
  }

  /**
   * Background reconcile of one key with Redis. Never awaited by a caller and
   * never throws; on any failure the entry is marked hydrated-as-empty so a
   * broken Redis cannot turn into a per-tick reconnect storm.
   */
  private static async hydrate(
    exchangeUUID: string,
    symbol: string,
    key: string,
  ): Promise<void> {
    if (hydrating.has(key)) {
      return
    }
    hydrating.add(key)
    try {
      // Never construct the client from here: `getInstance()` retries a dead
      // Redis forever, and this path runs under a hot read. Only an already-
      // connected wrapper is consulted; before boot finishes there is simply
      // nothing learned, which is today's behaviour.
      if (!RedisClient._instance?.isReady) {
        cache.set(key, {
          decimals: cache.get(key)?.decimals ?? null,
          hydratedAt: Date.now(),
        })
        return
      }
      const redis = await RedisClient.getInstance()
      const raw = await redis.get(stepKey(exchangeUUID, symbol))
      const stored = raw === null || raw === undefined ? NaN : Number(raw)
      const known = cache.get(key)?.decimals
      const decimals = !Number.isFinite(stored)
        ? (known ?? null)
        : typeof known === 'number'
          ? Math.min(known, stored)
          : stored
      cache.set(key, { decimals, hydratedAt: Date.now() })
    } catch (e) {
      logger.error(`${logPrefix} cannot hydrate ${key}: ${e}`)
      cache.set(key, {
        decimals: cache.get(key)?.decimals ?? null,
        hydratedAt: Date.now(),
      })
    } finally {
      hydrating.delete(key)
    }
  }

  /** Test seam — drops every in-process lesson. */
  static resetForTests(): void {
    cache.clear()
    hydrating.clear()
  }
}

export default QtyStepGuard
