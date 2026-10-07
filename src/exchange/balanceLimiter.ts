import RedisClient from '../db/redis'
import logger from '../utils/logger'
import { StatusEnum } from '../../types'
import type { BaseReturn, FreeAsset } from '../../types'

/**
 * Per-account limiter for exchange balance reads.
 *
 * A balance read is one of the most expensive calls a venue meters (Binance
 * spot charges 20 weight for it), and an account running many bots repeats it
 * constantly: every bot on the account reads the WHOLE account balance on its
 * own, so an account with a few hundred bots asks the venue the same question
 * hundreds of times a minute. Those weights come out of a per-IP budget shared
 * by every user on that connector, so one such account delays everybody's
 * order placement.
 *
 * Keyed by EXCHANGE ACCOUNT (see `accountRefFor`), not by user, bot or IP.
 * Three rules, in order:
 *
 *   reuse  — this account was read successfully within `windowMs` and has not
 *            placed or cancelled an order through us since: serve that answer.
 *   merge  — a read for this account is already in flight: wait for it and
 *            serve its answer (in-process directly; across processes by
 *            waiting briefly for its stored result).
 *   budget — this account already made `perMinute` live reads this minute.
 *            RECORDED ONLY — never enforced.
 *
 * ENFORCED only for callers in {@link isEnforcedCaller} (the bot engine's
 * per-tick balance checks) and only while `BALANCE_LIMITER_MODE` is `enforce`
 * (the default). Every other caller — and every caller under `log` — still
 * reads live, and the verdict it would have received is recorded on its
 * telemetry row.
 *
 * Never enforced for {@link EXEMPT_CALLERS}: reads that size a deal from the
 * balance always go to the venue.
 *
 * Staleness is bounded by `windowMs` and broken early by the account's own
 * order activity: placing or cancelling through us bumps a generation counter
 * and drops the stored answer, and a read that STARTED before that bump never
 * stores its answer. Any Redis failure falls back to a live read.
 */
export type BalanceLimiterVerdict = 'merge' | 'reuse' | 'budget' | 'live' | ''

/** Callers that must always be served a live figure. */
export const EXEMPT_CALLERS: ReadonlySet<string> = new Set([
  'bot.dealSizing',
  'bot.balanceStart',
])

/** Callers whose reads may be served a reused or merged answer. */
export const isEnforcedCaller = (caller: string) =>
  caller.startsWith('bot.checkAssets') && !EXEMPT_CALLERS.has(caller)

const PREFIX = 'gainium:balanceLimiter'
/** Upper bound on how long an in-flight marker can outlive a hung read. */
const IN_FLIGHT_TTL_SEC = 30
/** How long a merged read in another process is waited for before going live. */
const CROSS_PROCESS_WAIT_MS = 3000
const CROSS_PROCESS_POLL_MS = 150

const envNumber = (name: string, fallback: number) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type LiveResult = { data: BaseReturn<FreeAsset> }

export type BalanceLimiterOutcome<T extends LiveResult> =
  | { served: false; result: T; verdict: BalanceLimiterVerdict }
  | { served: true; data: BaseReturn<FreeAsset>; verdict: 'reuse' | 'merge' }

export class BalanceLimiter {
  private static _instance: BalanceLimiter | null = null
  static getInstance(): BalanceLimiter {
    if (!BalanceLimiter._instance) {
      BalanceLimiter._instance = new BalanceLimiter()
    }
    return BalanceLimiter._instance
  }

  /** In-process reads in flight, by account — the cheapest merge there is. */
  private inFlight = new Map<string, Promise<LiveResult>>()

  get mode(): 'off' | 'log' | 'enforce' {
    const m = (process.env.BALANCE_LIMITER_MODE ?? 'enforce').toLowerCase()
    return m === 'off' || m === 'log' ? m : 'enforce'
  }

  get enabled() {
    return this.mode !== 'off'
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
   * Run a balance read through the limiter. `live` performs the venue call;
   * it is not invoked when the read is served from a reused or merged answer.
   */
  async read<T extends LiveResult>(
    accountRef: string,
    caller: string,
    live: () => Promise<T>,
  ): Promise<BalanceLimiterOutcome<T>> {
    if (!this.enabled || !accountRef) {
      return { served: false, result: await live(), verdict: '' }
    }
    const enforce = this.mode === 'enforce' && isEnforcedCaller(caller)
    let redis: Awaited<ReturnType<typeof RedisClient.getInstance>> | undefined
    try {
      redis = await RedisClient.getInstance()
    } catch {
      redis = undefined
    }
    if (!redis) {
      return { served: false, result: await live(), verdict: '' }
    }

    if (enforce) {
      const stored = await this.stored(redis, accountRef)
      if (stored) {
        return { served: true, data: stored, verdict: 'reuse' }
      }
      const local = this.inFlight.get(accountRef)
      if (local) {
        const r = await local.catch(() => undefined)
        if (r?.data?.status === StatusEnum.ok) {
          return { served: true, data: r.data, verdict: 'merge' }
        }
      }
    }

    const verdict = await this.classify(redis, accountRef, caller)
    if (enforce && verdict.verdict === 'merge') {
      const waited = await this.waitForStored(redis, accountRef)
      if (waited) {
        return { served: true, data: waited, verdict: 'merge' }
      }
    }

    const gen = (await redis.get(this.key(accountRef, 'gen'))) ?? '0'
    const pending = live()
    if (!this.inFlight.has(accountRef)) {
      this.inFlight.set(accountRef, pending)
      void pending
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(accountRef) === pending) {
            this.inFlight.delete(accountRef)
          }
        })
    }
    const result = await pending
    const ok = result?.data?.status === StatusEnum.ok
    void this.settle(
      redis,
      accountRef,
      verdict.tookSlot,
      ok ? result.data : null,
      gen,
    )
    return { served: false, result, verdict: verdict.verdict }
  }

  /**
   * Shadow bookkeeping for a read that is about to go live: what the rules
   * would say. Takes the cross-process in-flight slot when free.
   */
  private async classify(
    redis: NonNullable<Awaited<ReturnType<typeof RedisClient.getInstance>>>,
    accountRef: string,
    caller: string,
  ): Promise<{ verdict: BalanceLimiterVerdict; tookSlot: boolean }> {
    try {
      const took = await redis.setNx(
        this.key(accountRef, 'inflight'),
        `${Date.now()}`,
        IN_FLIGHT_TTL_SEC,
      )
      if (took === undefined) {
        return { verdict: '', tookSlot: false }
      }
      if (!took) {
        return { verdict: 'merge', tookSlot: false }
      }
      if (
        !EXEMPT_CALLERS.has(caller) &&
        (await redis.get(this.key(accountRef, 'result')))
      ) {
        return { verdict: 'reuse', tookSlot: true }
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
        return { verdict: 'budget', tookSlot: true }
      }
      return { verdict: 'live', tookSlot: true }
    } catch (e) {
      logger.debug(
        `BalanceLimiter | classify failed: ${(e as Error)?.message ?? e}`,
      )
      return { verdict: '', tookSlot: false }
    }
  }

  /** Release the in-flight slot and store a successful answer for reuse. */
  private async settle(
    redis: NonNullable<Awaited<ReturnType<typeof RedisClient.getInstance>>>,
    accountRef: string,
    tookSlot: boolean,
    data: BaseReturn<FreeAsset> | null,
    genAtStart: string,
  ) {
    try {
      if (data) {
        // An order placed or cancelled while this read was in flight may not
        // be reflected in it: only store answers no invalidation overtook.
        const genNow = (await redis.get(this.key(accountRef, 'gen'))) ?? '0'
        if (genNow === genAtStart) {
          await redis.set(
            this.key(accountRef, 'result'),
            JSON.stringify(data),
            Math.max(1, Math.ceil(this.windowMs / 1000)),
          )
        }
      }
      if (tookSlot) {
        await redis.del(this.key(accountRef, 'inflight'))
      }
    } catch {
      // Bookkeeping only; the read itself already answered.
    }
  }

  private async stored(
    redis: NonNullable<Awaited<ReturnType<typeof RedisClient.getInstance>>>,
    accountRef: string,
  ): Promise<BaseReturn<FreeAsset> | null> {
    try {
      const raw = await redis.get(this.key(accountRef, 'result'))
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(`${raw}`) as BaseReturn<FreeAsset>
      return parsed?.status === StatusEnum.ok ? parsed : null
    } catch {
      return null
    }
  }

  private async waitForStored(
    redis: NonNullable<Awaited<ReturnType<typeof RedisClient.getInstance>>>,
    accountRef: string,
  ): Promise<BaseReturn<FreeAsset> | null> {
    const deadline = Date.now() + CROSS_PROCESS_WAIT_MS
    while (Date.now() < deadline) {
      await sleep(CROSS_PROCESS_POLL_MS)
      const stored = await this.stored(redis, accountRef)
      if (stored) {
        return stored
      }
      if (!(await redis.get(this.key(accountRef, 'inflight')))) {
        // The other read finished without storing (failed, or overtaken by an
        // order): nothing to wait for.
        return null
      }
    }
    return null
  }

  /**
   * The account just placed or cancelled an order through us, so its balance
   * has moved: drop the stored answer and stop any read already in flight from
   * storing one.
   */
  invalidate(accountRef: string) {
    if (!this.enabled || !accountRef) {
      return
    }
    void RedisClient.getInstance()
      .then(async (redis) => {
        await redis.incr(this.key(accountRef, 'gen'))
        await redis.expire(this.key(accountRef, 'gen'), 3600)
        await redis.del(this.key(accountRef, 'result'))
      })
      .catch(() => undefined)
  }
}

export default BalanceLimiter
