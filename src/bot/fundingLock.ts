/**
 * Per-account serialisation of bot funding (main-app spec 044 §8, D5).
 *
 * The two legs of a hedge share an account and a pair and open together, and
 * they may run in different worker processes. Each one plans its funding from
 * the account's free balance and the funds other deals reserve, trades, and
 * saves the reservation it now holds. Interleaved, both legs plan against the
 * same free funds and both spend them. So plan → trade → save runs under one
 * lock per exchange account, across processes: Redis `SET NX PX` with a random
 * token, released only by its holder (compare-and-delete), expiring on its own
 * if the holder dies. The wait is bounded; a caller that cannot get the lock
 * is told so and must not fund.
 */
import { randomUUID } from 'crypto'
import logger from '../utils/logger'
import RedisClient from '../db/redis'

const logPrefix = 'FundingLock'

/**
 * How long the lock survives a holder that stopped renewing it (a dead
 * process). A live holder renews it every third of this (a token-checked
 * PEXPIRE heartbeat), so a long section keeps it. Sized at 2× the worst
 * market-order wait seen (paper fills ≈ 40 s; venue retries add more) plus a
 * balance read and the lot and deal writes.
 */
export const FUNDING_LOCK_TTL_MS = 120_000
/**
 * Longest a caller waits for the lock. A section holds it through one market
 * order; two queued legs plus slack.
 */
export const FUNDING_LOCK_WAIT_MS = 300_000

/**
 * The longest any one section may hold the lock (fix round 2). Past it the
 * heartbeat stops renewing and `owned()` answers false, so a section whose
 * awaited venue call never returns cannot keep the account locked: the key
 * expires one TTL later. The funding trade itself is bounded below this
 * (`FUNDING_TRADE_TIMEOUT_MS`).
 */
export const FUNDING_LOCK_MAX_HOLD_MS = 4 * FUNDING_LOCK_TTL_MS
/** How long a funding market order may take before it counts as failed. */
export const FUNDING_TRADE_TIMEOUT_MS = 180_000
/**
 * Fix round 3: a final funding fill within this fraction (plus one base step)
 * of the planned quantity funds the deal with what executed. DCA / combo bots
 * carry no live slippage setting, so the floor applies.
 */
export const FUNDING_FILL_TOLERANCE = 0.01
/**
 * Fix round 3 (c): gross-up of funding buys on venues that size a market buy
 * in quote at the plan price and fill it `quote ÷ ask`.
 */
export const FUNDING_QUOTE_SIZED_BUY_HEADROOM = 0.005

/** Handed to a section: is the lock still ours? */
export type FundingLease = {
  /**
   * True while this holder owns the key — checked against the store, and
   * renews the TTL when it is. Call it right before an irreversible step.
   */
  owned: () => Promise<boolean>
}

export interface FundingLockStore {
  setNxPx(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean | undefined>
  delIfValue(key: string, value: string): Promise<boolean | undefined>
  /**
   * PEXPIRE `key` only while it holds `value` (token-checked renewal).
   * Redis implements it; a store without it cannot be renewed or verified
   * (test doubles that never grant the lock).
   */
  pexpireIfValue?(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<boolean | undefined>
}

export type FundingLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class FundingLock {
  private static _instance: FundingLock | null = null
  static getInstance(): FundingLock {
    if (!FundingLock._instance) {
      FundingLock._instance = new FundingLock()
    }
    return FundingLock._instance
  }

  private store: FundingLockStore | null = null
  ttlMs = FUNDING_LOCK_TTL_MS
  waitMs = FUNDING_LOCK_WAIT_MS
  /**
   * Default: four TTLs (480 s in production) — room for the bounded trade
   * (180 s) plus the reads and writes around it, while a hung section frees
   * the account within 4 TTLs + 1.
   */
  maxHoldMs: number | null = null

  /** Tests: an in-memory store instead of Redis. */
  setStore(store: FundingLockStore | null) {
    this.store = store
  }

  private async getStore(): Promise<FundingLockStore> {
    return this.store ?? (await RedisClient.getInstance())
  }

  key(exchangeUUID: string) {
    return `gainium:fundingLock:${exchangeUUID}`
  }

  /**
   * Run `fn` holding the account's funding lock, renewed every third of the
   * TTL while `fn` runs. `fn` throwing releases the lock and rethrows.
   */
  async run<T>(
    exchangeUUID: string,
    fn: (lease: FundingLease) => Promise<T>,
    owner = '',
  ): Promise<FundingLockResult<T>> {
    const key = this.key(exchangeUUID)
    const token = `${owner}:${randomUUID()}`
    const store = await this.getStore()
    const deadline = Date.now() + this.waitMs
    let delay = 25
    for (;;) {
      const took = await store.setNxPx(key, token, this.ttlMs)
      if (took === undefined) {
        return {
          acquired: false,
          reason: 'the funding lock store is unavailable',
        }
      }
      if (took) {
        break
      }
      if (Date.now() >= deadline) {
        return {
          acquired: false,
          reason: `another funding on this account held the lock for over ${Math.round(this.waitMs / 1000)}s`,
        }
      }
      await sleep(delay)
      delay = Math.min(delay * 2, 250)
    }
    const startedAt = Date.now()
    const maxHold = this.maxHoldMs ?? 4 * this.ttlMs
    let lost = false
    const renew = async () => {
      if (lost) {
        return false
      }
      if (Date.now() - startedAt > maxHold) {
        // Stop renewing: the key lapses one TTL after the last renewal.
        lost = true
        clearInterval(heartbeat)
        logger.error(
          `${logPrefix} | ${owner} held the funding lock on ${exchangeUUID} past its ${maxHold} ms maximum; no longer renewed and no longer owned`,
        )
        return false
      }
      if (!store.pexpireIfValue) {
        return true
      }
      const ok = await store.pexpireIfValue(key, token, this.ttlMs)
      if (ok === false) {
        lost = true
        logger.error(
          `${logPrefix} | ${owner} LOST the funding lock on ${exchangeUUID} after ${Date.now() - startedAt} ms`,
        )
      }
      // undefined: the store did not answer — neither proof of loss nor of
      // ownership; callers treat it as not owned.
      return ok === true
    }
    const heartbeat = setInterval(
      () => void renew(),
      Math.max(5, Math.floor(this.ttlMs / 3)),
    )
    try {
      return { acquired: true, value: await fn({ owned: renew }) }
    } finally {
      clearInterval(heartbeat)
      const released = await store.delIfValue(key, token)
      if (released === false) {
        // Ours expired and someone else may have run alongside the tail of
        // this section. Nothing to undo here; make it visible.
        logger.warn(
          `${logPrefix} | ${owner} lock on ${exchangeUUID} expired before release (held ${Date.now() - startedAt} ms, ttl ${this.ttlMs} ms)`,
        )
      }
    }
  }
}

/** In-memory {@link FundingLockStore} with expiry — tests only. */
export class MemoryFundingLockStore implements FundingLockStore {
  private keys = new Map<string, { value: string; until: number }>()
  async setNxPx(key: string, value: string, ttlMs: number) {
    const cur = this.keys.get(key)
    if (cur && cur.until > Date.now()) {
      return false
    }
    this.keys.set(key, { value, until: Date.now() + ttlMs })
    return true
  }
  async delIfValue(key: string, value: string) {
    const cur = this.keys.get(key)
    if (!cur || cur.until <= Date.now() || cur.value !== value) {
      return false
    }
    this.keys.delete(key)
    return true
  }
  async pexpireIfValue(key: string, value: string, ttlMs: number) {
    const cur = this.keys.get(key)
    if (!cur || cur.until <= Date.now() || cur.value !== value) {
      return false
    }
    cur.until = Date.now() + ttlMs
    return true
  }
  held(key: string) {
    const cur = this.keys.get(key)
    return !!cur && cur.until > Date.now()
  }
}
