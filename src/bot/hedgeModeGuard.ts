import {
  BaseReturn,
  FuturesStrategyEnum,
  PositionSide,
  StatusEnum,
  StrategyEnum,
} from '../../types'
import logger from './../utils/logger'

/**
 * The account's POSITION MODE, read from the venue rather than from the copy we
 * stored the last time the user told us about it.
 *
 * A futures account is either one-way (a single net position per contract) or
 * hedge (a long and a short leg that exist independently). Every order the
 * engine builds names the mode in `positionSide`, and the venue refuses an
 * order that names the wrong one — OKX with `Parameter posSide error` (51000),
 * Binance USD-M/COIN-M with `Order's position side does not match user's
 * setting.` (-4061). Nothing about that refusal is recoverable by retrying the
 * same order: the mode has to be re-read first.
 *
 * `user.exchanges[].hedge` is a CACHE of that mode, written when the connection
 * is added and when the user flips the mode through Gainium. It is not written
 * when the user flips the mode AT THE EXCHANGE, which they are free to do at any
 * time, so it can be arbitrarily old — a month, in the case that produced this
 * module. Bot load used to substitute that copy for a live read whenever the
 * load was a service restart, which is exactly when a bot is least likely to
 * have been near a fresh read.
 *
 * Reading live per BOT would undo the reason that substitution was made in the
 * first place (a mass restart re-reads the mode for every futures bot at once).
 * So the read is coalesced per CONNECTION, which is the granularity the mode
 * actually has: one account has one position mode no matter how many bots run
 * on it. Shape follows {@link ../utils/leverageBracketCache}, for the same
 * reason and with the same bound — one entry per connection this process has
 * loaded a futures bot for, so no eviction policy is needed.
 *
 * Fail-open throughout: a venue that does not answer reads as `null`, and the
 * caller then keeps using the stored copy, which is exactly today's behaviour.
 */

const logPrefix = '[HedgeModeGuard]'

/**
 * Lower-cased substrings that mark a POSITION-SIDE refusal.
 *
 * Deliberately narrow, and deliberately not a bare `posside`: the connector
 * passes the venue's own wording through untouched (`Parameter posSide error`
 * is what prod logs hold verbatim), and a wider probe would also claim the
 * reduce-only and "no position in this direction" refusals, which are a real
 * position state and not a mode disagreement.
 */
const POSITION_SIDE_REFUSAL_SIGNATURES = [
  // OKX 51000. Raised BOTH ways round — `net` sent to a hedge-mode account and
  // `long`/`short` sent to a one-way account both produce this one string.
  'parameter posside error',
  // Binance USD-M / COIN-M -4061.
  "order's position side does not match",
  // Same rejection with the apostrophe normalised away by a venue or proxy.
  'order position side does not match',
]

/** Does this venue rejection say our order named the wrong position mode? */
export const isPositionSideRefusal = (reason?: string | null): boolean => {
  if (!reason) {
    return false
  }
  const r = reason.toLowerCase()
  return POSITION_SIDE_REFUSAL_SIGNATURES.some((s) => r.includes(s))
}

/**
 * The leg a hedge-mode order must name, from the bot's own direction.
 *
 * This is the expression every order builder in the engine already uses
 * (`this.hedge ? (this.isLong ? LONG : SHORT) : BOTH` in `dcaHelper` /
 * `comboHelper`, and the `futuresStrategy` ladder in `helper`), stated once so
 * the recovery path cannot invent a different answer from the one that built
 * the order.
 *
 * Returns `null` when the settings name no single leg — a NEUTRAL grid trades
 * both directions and has no bot-level leg to fall back on. A caller must
 * refuse to act rather than guess: naming the wrong leg on a hedge account does
 * not fail, it opens a position on the opposite side.
 */
export const hedgeLegForSettings = (settings?: {
  futuresStrategy?: FuturesStrategyEnum | string | null
  strategy?: StrategyEnum | string | null
}): PositionSide.LONG | PositionSide.SHORT | null => {
  if (!settings) {
    return null
  }
  if (settings.futuresStrategy === FuturesStrategyEnum.long) {
    return PositionSide.LONG
  }
  if (settings.futuresStrategy === FuturesStrategyEnum.short) {
    return PositionSide.SHORT
  }
  if (settings.futuresStrategy === FuturesStrategyEnum.neutral) {
    return null
  }
  if (settings.strategy === StrategyEnum.long) {
    return PositionSide.LONG
  }
  if (settings.strategy === StrategyEnum.short) {
    return PositionSide.SHORT
  }
  return null
}

/**
 * Serve a cached mode outright for this long. Sized to cover a mass restart:
 * the bots of one connection load within seconds of each other, so one read
 * answers all of them, while a user who changes the mode at the venue waits at
 * most this long for the next bot load to notice.
 */
export const HEDGE_FRESH_TTL_MS = 60 * 1000

/**
 * The staleness a recovery from a position-side refusal will accept. Short
 * enough that the re-read is a real re-read, long enough that a burst of
 * refused orders on one connection does not become a burst of venue calls.
 */
export const HEDGE_REFUSAL_MAX_AGE_MS = 5 * 1000

type Entry = { at: number; value: boolean }

const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<boolean | null>>()

/**
 * Coalesce concurrent misses onto one upstream call. The returned promise never
 * rejects: a venue error reads as `null`, which every caller treats as "no
 * answer, keep what you had".
 */
const fetchOnce = (
  key: string,
  fetchHedge: () => Promise<BaseReturn<boolean>>,
): Promise<boolean | null> => {
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  const pending = Promise.resolve()
    .then(fetchHedge)
    .then((result) => {
      // Only a real answer is cached — an exchange error must not be served to
      // the next bot on this connection as if it were the account's mode.
      if (
        result?.status === StatusEnum.ok &&
        typeof result.data === 'boolean'
      ) {
        cache.set(key, { at: Date.now(), value: result.data })
        return result.data
      }
      logger.warn(
        `${logPrefix} ${key} position mode unread: ${
          result?.reason ?? 'no answer'
        }`,
      )
      return null
    })
    .catch((e: unknown) => {
      logger.error(`${logPrefix} ${key} threw: ${(e as Error)?.message ?? e}`)
      return null
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, pending)
  return pending
}

/**
 * The connection's position mode as the VENUE reports it, or `null` when the
 * venue did not answer.
 *
 * @param exchangeUUID the connection the mode belongs to. Falsy means there is
 *   nothing to key a shared answer by, so the read is made uncached.
 * @param maxAgeMs how stale a cached answer may be for this caller.
 */
export const readHedgeMode = async (
  exchangeUUID: string | undefined | null,
  fetchHedge: () => Promise<BaseReturn<boolean>>,
  maxAgeMs: number = HEDGE_FRESH_TTL_MS,
): Promise<boolean | null> => {
  if (!exchangeUUID) {
    return fetchOnce(`${Date.now()}|${Math.random()}`, fetchHedge)
  }
  const cached = cache.get(exchangeUUID)
  if (cached && Date.now() - cached.at < maxAgeMs) {
    return cached.value
  }
  return fetchOnce(exchangeUUID, fetchHedge)
}

/** Test seam — drops every remembered position mode. */
export const resetHedgeModeCacheForTests = (): void => {
  cache.clear()
  inFlight.clear()
}
