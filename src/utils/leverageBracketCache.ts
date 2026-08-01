import {
  BaseReturn,
  ExchangeEnum,
  LeverageBracket,
  OKXSource,
  StatusEnum,
} from '../../types'
import logger from './logger'

/**
 * Read-through cache + request coalescing + hard timeout for the futures
 * leverage-bracket table behind `getLeverageBracketsByUUID`.
 *
 * The bracket table is what the bot form's margin/leverage selector is built
 * from, and every DCA form, grid form and MarginLeverageBlock mount fires its
 * own query. Un-cached, every one of those was a live exchange round trip
 * through exchange-balancer -> exchange-connector, so N dashboard tabs meant N
 * calls queued on the connector's per-exchange rate limiter. Once that queue
 * backs up the resolver just waits: prod logged a single 47.7s
 * `[SlowGraphQL] op=getLeverageBracket`, which the user sees as a hung form.
 *
 * Keying: the table is a function of the exchange universe, NOT of the account.
 * Every connector implementation derives it from public data — okx/bybit/bitget/
 * hyperliquid from `getAllExchangeInfo()`, kucoin from `getFuturesSymbols()`,
 * kraken from a constant, and binance maps only `brackets[0].initialLeverage`
 * (the tier-0 max initial leverage per symbol). So one entry per
 * (provider, okxSource) serves every user safely. `provider` is an `ExchangeEnum`
 * and so already distinguishes coinm from usdm; `okxSource` is included because
 * it selects a different symbol universe (OKX Europe vs global). That makes the
 * key space bounded by the futures enum (a few dozen entries), so the map needs
 * no eviction policy.
 */

const logPrefix = 'leverageBracketCache |'

/** Serve a cached table outright for this long — no exchange call at all. */
const FRESH_TTL_MS = 60 * 1000

/**
 * How long an expired table stays usable as a timeout fallback. Bracket tables
 * change on the order of weeks, so an old one is a far better answer than
 * making the form spin while the connector queue drains.
 */
const STALE_TTL_MS = 60 * 60 * 1000

/** Never make the dashboard wait longer than this for a bracket table. */
const REQUEST_TIMEOUT_MS = 10 * 1000

type CacheEntry = { at: number; value: BaseReturn<LeverageBracket[]> }

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<BaseReturn<LeverageBracket[]>>>()

const cacheKey = (provider: ExchangeEnum, okxSource?: OKXSource) =>
  `${provider}|${okxSource ?? ''}`

/**
 * Coalesce concurrent misses onto one upstream call. The returned promise never
 * rejects, so a caller that has already given up on the timeout cannot leave an
 * unhandled rejection behind — and the call is deliberately left running so it
 * still populates the cache for whoever asks next.
 */
const fetchOnce = (
  key: string,
  fetchBrackets: () => Promise<BaseReturn<LeverageBracket[]>>,
): Promise<BaseReturn<LeverageBracket[]>> => {
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  const pending = Promise.resolve()
    .then(fetchBrackets)
    .then((result) => {
      // Only successful tables are cached — an exchange error must not be
      // served to the next caller for a minute.
      if (result?.status === StatusEnum.ok && Array.isArray(result.data)) {
        cache.set(key, { at: Date.now(), value: result })
      }
      return result
    })
    .catch((e: unknown) => {
      logger.error(`${logPrefix} ${key} threw: ${(e as Error)?.message}`)
      return {
        status: StatusEnum.notok as typeof StatusEnum.notok,
        reason: (e as Error)?.message ?? 'Failed to fetch leverage brackets',
        data: null,
      }
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, pending)
  return pending
}

export const getLeverageBracketsCached = async (
  provider: ExchangeEnum,
  okxSource: OKXSource | undefined,
  fetchBrackets: () => Promise<BaseReturn<LeverageBracket[]>>,
): Promise<BaseReturn<LeverageBracket[]>> => {
  const key = cacheKey(provider, okxSource)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < FRESH_TTL_MS) {
    return cached.value
  }

  const pending = fetchOnce(key, fetchBrackets)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS)
  })
  const result = await Promise.race([pending, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
  if (result) {
    return result
  }

  logger.warn(
    `${logPrefix} ${key} exceeded ${REQUEST_TIMEOUT_MS}ms, ${
      cached ? 'serving stale table' : 'no cached table to fall back on'
    }`,
  )
  if (cached && Date.now() - cached.at < STALE_TTL_MS) {
    return cached.value
  }
  return {
    status: StatusEnum.notok as typeof StatusEnum.notok,
    reason: 'Exchange did not return leverage brackets in time',
    data: null,
  }
}
