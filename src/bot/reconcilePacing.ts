/**
 * Per-account pacing of reconcile-path order lookups.
 *
 * A venue rate-limits per account (Bybit: per UID, per second), but every bot
 * reconciles on its own. A service restart starts every bot's restart probe
 * within the resume stagger, so an account with hundreds of bots on it fires
 * one lookup per open order per bot inside a few seconds — thousands against a
 * per-second budget. The venue answers "Too many visits", the connector
 * retries each call in lockstep, and the orders go unchecked for the pass.
 *
 * So lookups are counted per exchange account across every bot, thread and bot
 * service, in a one-second window in Redis, and a lookup over the limit waits
 * for the next window. An account with a handful of bots never reaches the
 * limit and is not delayed at all. Without Redis the count is per process.
 */

/** Reconcile lookups allowed per exchange account per second. 0 = no pacing. */
export const reconcileAccountRps = Number(
  process.env.BOT_RECONCILE_ACCOUNT_RPS ?? 10,
)

/**
 * How long a lookup that is number `count` in the current second must wait:
 * 0 while the window has room, otherwise until the next window starts, plus up
 * to 250ms of jitter so the waiters of one window do not all fire at the first
 * millisecond of the next.
 */
export function accountPaceWaitMs(
  count: number,
  limit: number,
  now: number,
  random: number,
): number {
  if (!(limit > 0) || count <= limit) return 0
  return 1000 - (now % 1000) + Math.floor(random * 250)
}

export type AccountPaceDeps = {
  /** Increment and return the count for `key`; undefined when unavailable. */
  incr: (key: string) => Promise<number | undefined>
  expire: (key: string, sec: number) => Promise<unknown>
  sleep: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  limit?: number
  /** Give up — do not make the call — rather than wait past this. */
  maxWaitMs: number
}

const localWindows = new Map<string, number>()

/** In-process stand-in for the Redis counter. */
function localIncr(key: string) {
  const n = (localWindows.get(key) ?? 0) + 1
  localWindows.set(key, n)
  if (localWindows.size > 10_000) {
    // Window keys carry their second; anything this many is stale.
    for (const k of localWindows.keys()) {
      localWindows.delete(k)
      if (localWindows.size <= 5_000) break
    }
  }
  return n
}

/**
 * Wait until a lookup on `account` fits its per-second budget. `admitted` is
 * false when that would take longer than `maxWaitMs`: the caller must then
 * not make the call (it is deferred to a later pass), because letting it
 * through anyway releases exactly the herd the budget exists to hold back.
 * Never throws.
 */
export async function paceAccountLookup(
  account: string,
  deps: AccountPaceDeps,
): Promise<{ waitedMs: number; admitted: boolean }> {
  const limit = deps.limit ?? reconcileAccountRps
  if (!(limit > 0) || !account) return { waitedMs: 0, admitted: true }
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const maxWaitMs = deps.maxWaitMs
  const started = now()
  for (;;) {
    const t = now()
    const key = `gainium:reconcilePace:${account}:${Math.floor(t / 1000)}`
    let count: number | undefined
    try {
      count = await deps.incr(key)
      if (count === 1) await deps.expire(key, 2)
    } catch {
      count = undefined
    }
    if (count === undefined) count = localIncr(key)
    const wait = accountPaceWaitMs(count, limit, t, random())
    if (!wait) return { waitedMs: t - started, admitted: true }
    if (t - started + wait > maxWaitMs) {
      return { waitedMs: t - started, admitted: false }
    }
    await deps.sleep(wait)
  }
}
