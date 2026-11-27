import RedisClient from '../db/redis'

/**
 * Orders a venue refused because they sit too far from the current price.
 *
 * Some venues refuse a limit order priced more than a set percentage away from
 * the market (Bitget spot: `the trade price of rxyz/usdt cannot exceed the
 * current price, 20%.` / `rxyz/usdt trading price cannot exceed 10%`). For an
 * order the price already ran through, the engine re-prices it at the market
 * (`priceBandReprice.ts`). An order still AHEAD of the price (a grid sell far
 * above it, a buy far below) is a different case: it is right where it is, the
 * venue just will not hold it yet. Written off, it stays off the book even after
 * the price comes within the band, so a move through it trades nothing.
 *
 * The engine keeps such an order by level and places it again once a price
 * tick puts it inside the band, with a margin so it is not refused again at the
 * edge.
 */

/** Place again once the order is within this share of the venue's band. */
export const OUT_OF_BAND_MARGIN = 0.9

/**
 * The band a refusal names, as a fraction (`20%` → 0.2), or null when the
 * refusal names none.
 */
export function bandFractionFromReason(reason: string): number | null {
  const m = /cannot exceed[^%]*?(\d+(?:\.\d+)?)\s*%/i.exec(reason || '')
  if (!m) {
    return null
  }
  const pct = +m[1]
  return Number.isFinite(pct) && pct > 0 && pct < 100 ? pct / 100 : null
}

/**
 * Binance spot refuses a limit order outside its `PERCENT_PRICE_BY_SIDE` band
 * with `Filter failure: PERCENT_PRICE_BY_SIDE`, which names no limit. The band
 * then comes from the pair's own filter when the connector supplies one
 * (`priceMultiplier`: a sell ahead of the price is capped at `up`, a buy at
 * `down`), else this default. Either way it is capped by the distance the
 * venue just refused: that distance is known to be outside the band, so an
 * order is never released at it again, and every further refusal moves the
 * release point closer to the price. Binance's tightest ahead-of-market
 * multipliers seen on spot are 1.2 / 0.8.
 */
export const DEFAULT_UNNAMED_BAND = 0.2

export function bandForUnnamedRefusal(opts: {
  side: string
  price: number
  market: number
  priceMultiplier?: { up?: number; down?: number } | null
}): { band: number; fromFilter: boolean } | null {
  const { side, price, market, priceMultiplier } = opts
  if (!isAheadOfMarket(side, price, market)) {
    return null
  }
  const refused = Math.abs(price - market) / market
  const sell = `${side}`.toUpperCase() === 'SELL'
  const m = sell ? Number(priceMultiplier?.up) : Number(priceMultiplier?.down)
  const fromPair = sell ? m - 1 : 1 - m
  const fromFilter = Number.isFinite(fromPair) && fromPair > 0
  const band = Math.min(
    fromFilter ? Math.min(fromPair, 0.99) : DEFAULT_UNNAMED_BAND,
    refused,
  )
  return band > 0 ? { band, fromFilter } : null
}

/**
 * An order refused for its distance from the market that the market has not
 * reached: a sell at or above it, a buy at or below it.
 */
export function isAheadOfMarket(
  side: string,
  price: number,
  market: number,
): boolean {
  if (!(price > 0) || !(market > 0)) {
    return false
  }
  return `${side}`.toUpperCase() === 'SELL' ? price >= market : price <= market
}

/** Is the order now close enough to the market for the venue to take it? */
export function isWithinBand(
  price: number,
  market: number,
  band: number,
): boolean {
  if (!(price > 0) || !(market > 0) || !(band > 0)) {
    return false
  }
  return Math.abs(price - market) / market <= band * OUT_OF_BAND_MARGIN
}

/**
 * The band a venue enforces on a pair, as learned from its own refusal, kept in
 * Redis so it outlives the worker. A bot reload rebuilds every grid level that
 * is not resting; without this the rebuild re-sent each held order to the venue
 * and was refused again (one deal: 410 refused sells in two weeks, a burst on
 * every reload). With the band known, an order still outside it is held without
 * asking the venue. Fail-open: a Redis error means "band unknown", and the
 * order goes to the venue, which is the behaviour before this existed.
 */
const BAND_TTL_S = 30 * 24 * 60 * 60
const BAND_CACHE_MS = 60_000
const bandCache = new Map<string, { band: number | null; at: number }>()
/**
 * A band that differs by side (Binance's `PERCENT_PRICE_BY_SIDE`) is kept per
 * side; `get` reads the side's own band first, then a band for both sides.
 */
const bandKey = (exchange: string, symbol: string, side?: string) =>
  `outOfBandBand:${exchange}:${symbol}${side ? `:${`${side}`.toUpperCase()}` : ''}`

export const VenuePriceBand = {
  async record(
    exchange: string,
    symbol: string,
    band: number,
    side?: string,
  ): Promise<void> {
    const key = bandKey(exchange, symbol, side)
    bandCache.set(key, { band, at: Date.now() })
    try {
      const redis = await RedisClient.getInstance()
      await redis.set(key, `${band}`, BAND_TTL_S)
    } catch {
      // Fail-open: the in-process copy still spares this worker.
    }
  },

  async get(
    exchange: string,
    symbol: string,
    side?: string,
  ): Promise<number | null> {
    if (side) {
      const own = await this.get(
        `${exchange}`,
        `${symbol}:${`${side}`.toUpperCase()}`,
      )
      if (own) {
        return own
      }
    }
    const key = bandKey(exchange, symbol)
    const cached = bandCache.get(key)
    if (cached && Date.now() - cached.at < BAND_CACHE_MS) {
      return cached.band
    }
    let band: number | null = null
    try {
      const redis = await RedisClient.getInstance()
      const v = Number(await redis.get(key))
      band = v > 0 && v < 1 ? v : null
    } catch {
      band = cached?.band ?? null
    }
    bandCache.set(key, { band, at: Date.now() })
    return band
  },

  /** Tests only. */
  resetCache() {
    bandCache.clear()
  },
}

/**
 * The user is told once that an order is waiting for the price: once per held
 * level, and once per deal for a take profit. Kept in Redis, so a bot reload
 * that holds the same level again says nothing new. Fail-open: a Redis error
 * tells the user again rather than not at all.
 */
const NOTICE_TTL_S = BAND_TTL_S
export const OutOfBandNotice = {
  async claim(botId: string, key: string): Promise<boolean> {
    const k = `outOfBandNotice:${botId}:${key}`
    try {
      const redis = await RedisClient.getInstance()
      if (await redis.get(k)) {
        return false
      }
      await redis.set(k, '1', NOTICE_TTL_S)
    } catch {
      // Fail-open.
    }
    return true
  },
}

/**
 * Should an order be held instead of sent, given the band known for its pair?
 * Held when it is ahead of the market and outside the band (with the margin
 * {@link isWithinBand} applies), i.e. exactly when the tick check would not yet
 * place it.
 */
export function holdOutsideKnownBand(
  side: string,
  price: number,
  market: number,
  band: number | null,
): boolean {
  if (!band) {
    return false
  }
  return (
    isAheadOfMarket(side, price, market) && !isWithinBand(price, market, band)
  )
}

/**
 * Reasons {@link heldOutOfBandReason} has produced. A held order comes back to
 * its caller as a refusal string (`sendOrderToExchange`'s `returnError`), and
 * the callers that report refusals must be able to tell a hold from the venue's
 * answer without trusting the text: a reason is a hold only if this module made
 * it. Bounded; a lookup happens in the same call chain as the make.
 */
const heldReasons = new Set<string>()
const HELD_REASONS_MAX = 2000

/**
 * The refusal a pre-send hold (spec 264) returns in place of the venue's
 * answer. Use {@link isHeldOutOfBandReason} to recognise it.
 */
export function heldOutOfBandReason(
  side: string,
  price: number,
  market: number,
  band: number,
  exchange: string,
): string {
  const reason = `Held: ${side} ${price} is more than ${Math.round(band * 100)}% from the price ${market}, which ${exchange} refuses`
  heldReasons.delete(reason)
  heldReasons.add(reason)
  if (heldReasons.size > HELD_REASONS_MAX) {
    const oldest = heldReasons.values().next().value
    if (oldest !== undefined) {
      heldReasons.delete(oldest)
    }
  }
  return reason
}

/**
 * Was `reason` made by {@link heldOutOfBandReason}? A held order is waiting for
 * the price, not refused: it is noticed once by `noticeHeldOutOfBand` and must
 * never be reported as an error.
 */
export function isHeldOutOfBandReason(reason: unknown): boolean {
  return typeof reason === 'string' && heldReasons.has(reason)
}

/** An order held out of the price band, as shown on the deal. */
export type HeldOutOfBandOrder = {
  side: string
  price: number
  qty: number
  typeOrder: string
  minigridId?: string | null
  dcaLevel?: number | null
  band: number
  since: number
}

/** Same held set (ignoring `since`)? Spares a deal write per rebuild. */
export function sameHeldOrders(
  a: HeldOutOfBandOrder[] | null | undefined,
  b: HeldOutOfBandOrder[],
): boolean {
  const k = (o: HeldOutOfBandOrder) =>
    `${o.side}|${o.price}|${o.qty}|${o.typeOrder}|${o.minigridId ?? ''}|${o.dcaLevel ?? ''}`
  const x = (a ?? []).map(k).sort().join(',')
  const y = b.map(k).sort().join(',')
  return x === y
}
