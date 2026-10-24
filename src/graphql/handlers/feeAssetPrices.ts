/**
 * Market prices of fee assets at fill time, for valuing fees a venue charged
 * in an asset that is neither side of the pair (`bot/feeAssetPrice.ts` holds
 * the arithmetic and the route rules).
 *
 * The candles come from a source the host process injects with
 * `setCandleSource` (one-minute candles of a venue pair over a time range).
 * Without a source every price is unknown and nothing is read — a deployment
 * that has no candle store keeps showing these fees as unknown.
 *
 * Cost bounds:
 *   - pairs: one `pairs` read per (venue, base asset), cached for hours;
 *   - candles: one read per (venue pair, UTC day) any minute of that day is
 *     needed for — the whole day's 1440 one-minute candles, one archive page —
 *     so a bot's or an account's history costs one read per trading day per
 *     pair, however its fills are spread inside the day. At most
 *     `MAX_WINDOWS_PER_CALL` day reads per call and `MAX_IN_FLIGHT` source
 *     calls at a time across the process. Days beyond the cap stay unknown for
 *     that call and are not remembered as missing, so a later call reads them;
 *   - every minute read is cached (history does not change): a price for a
 *     day, a confirmed miss for minutes.
 */
import { pairDb } from '../../db/dbInit'
import logger from '../../utils/logger'
import {
  FEE_PRICE_INTERVAL,
  MINUTE_MS,
  type FeeCandle,
  type FeePair,
  type FeeRoute,
  candleMid,
  feeRoute,
  minuteOf,
  routePrice,
} from '../../bot/feeAssetPrice'

const logPrefix = 'FeeAssetPrices |'

export type FeeCandleSource = (q: {
  exchange: string
  symbol: string
  interval: string
  from: number
  to: number
}) => Promise<FeeCandle[] | null>

export type FeePriceRequest = {
  /** The spot venue the price is read on (`feePriceVenueOf`). */
  venue: string
  asset: string
  quote: string
  /** Any time inside the minute; it is floored to the minute. */
  at: number
}

export const DAY_MS = 24 * 60 * MINUTE_MS
export const MAX_WINDOWS_PER_CALL = 120
export const MAX_IN_FLIGHT = 4

const PAIRS_TTL_MS = 6 * 60 * 60_000
const MID_TTL_MS = 24 * 60 * 60_000
const MISS_TTL_MS = 10 * 60_000
const MID_CACHE_MAX = 200_000

export const priceKey = (r: FeePriceRequest) =>
  `${r.venue}|${r.asset.toUpperCase()}|${r.quote.toUpperCase()}|${minuteOf(r.at)}`

export class FeeAssetPrices {
  private static _instance: FeeAssetPrices | null = null
  static getInstance(): FeeAssetPrices {
    if (!FeeAssetPrices._instance) {
      FeeAssetPrices._instance = new FeeAssetPrices()
    }
    return FeeAssetPrices._instance
  }

  private source: FeeCandleSource | null = null
  private pairs = new Map<string, { at: number; value: Promise<FeePair[]> }>()
  private mids = new Map<string, { at: number; value: number | null }>()
  private inFlight = 0
  private waiting: (() => void)[] = []
  private pending = new Map<
    string,
    { req: FeePriceRequest; resolve: ((v: number | null) => void)[] }
  >()
  private scheduled = false

  setCandleSource(source: FeeCandleSource | null) {
    this.source = source
  }

  hasSource(): boolean {
    return !!this.source
  }

  /** One price, coalesced with every other asked for in the same tick. */
  priceOne(req: FeePriceRequest): Promise<number | null> {
    if (!this.source) return Promise.resolve(null)
    return new Promise((resolve) => {
      const key = priceKey(req)
      const entry = this.pending.get(key) ?? { req, resolve: [] }
      entry.resolve.push(resolve)
      this.pending.set(key, entry)
      if (!this.scheduled) {
        this.scheduled = true
        setImmediate(() => void this.flushPending())
      }
    })
  }

  private async flushPending() {
    const batch = this.pending
    this.pending = new Map()
    this.scheduled = false
    let out = new Map<string, number | null>()
    try {
      out = await this.prices([...batch.values()].map((e) => e.req))
    } catch (e) {
      logger.warn(`${logPrefix} batch failed: ${(e as Error)?.message ?? e}`)
    }
    for (const [key, e] of batch) {
      for (const resolve of e.resolve) resolve(out.get(key) ?? null)
    }
  }

  /** Prices by `priceKey`; null where unknown. */
  async prices(reqs: FeePriceRequest[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>()
    if (!this.source || !reqs.length) {
      for (const r of reqs) out.set(priceKey(r), null)
      return out
    }
    // Routes per (venue, asset, quote).
    const routes = new Map<string, FeeRoute | null>()
    for (const r of reqs) {
      const k = `${r.venue}|${r.asset.toUpperCase()}|${r.quote.toUpperCase()}`
      if (routes.has(k)) continue
      const pairs = await this.pairsFor(r.venue, [r.asset, r.quote])
      routes.set(k, feeRoute(r.asset, r.quote, pairs))
    }
    // Every (venue, pair, minute) any route needs.
    const need = new Map<string, Set<number>>()
    const want = (venue: string, pair: string, minute: number) => {
      if (this.midCached(venue, pair, minute) !== undefined) return
      const k = `${venue}|${pair}`
      const set = need.get(k) ?? new Set<number>()
      set.add(minute)
      need.set(k, set)
    }
    for (const r of reqs) {
      const route = routes.get(
        `${r.venue}|${r.asset.toUpperCase()}|${r.quote.toUpperCase()}`,
      )
      if (!route) continue
      const m = minuteOf(r.at)
      want(r.venue, route.num, m)
      if (route.den) want(r.venue, route.den, m)
    }
    await this.readCandles(need)
    for (const r of reqs) {
      const route = routes.get(
        `${r.venue}|${r.asset.toUpperCase()}|${r.quote.toUpperCase()}`,
      )
      const m = minuteOf(r.at)
      out.set(
        priceKey(r),
        route
          ? routePrice(route, (pair) => this.midCached(r.venue, pair, m))
          : null,
      )
    }
    return out
  }

  private midCached(venue: string, pair: string, minute: number) {
    const hit = this.mids.get(`${venue}|${pair}|${minute}`)
    if (!hit) return undefined
    const ttl = hit.value === null ? MISS_TTL_MS : MID_TTL_MS
    if (+new Date() - hit.at > ttl) {
      this.mids.delete(`${venue}|${pair}|${minute}`)
      return undefined
    }
    return hit.value
  }

  private setMid(
    venue: string,
    pair: string,
    minute: number,
    v: number | null,
  ) {
    if (this.mids.size >= MID_CACHE_MAX) this.mids.clear()
    this.mids.set(`${venue}|${pair}|${minute}`, { at: +new Date(), value: v })
  }

  private async readCandles(need: Map<string, Set<number>>) {
    const windows: ({ venue: string; pair: string } & FeeWindow)[] = []
    for (const [k, set] of need) {
      const [venue, pair] = [
        k.slice(0, k.indexOf('|')),
        k.slice(k.indexOf('|') + 1),
      ]
      for (const w of windowsOf([...set], +new Date()))
        windows.push({ venue, pair, ...w })
    }
    const run = windows.slice(0, MAX_WINDOWS_PER_CALL)
    if (windows.length > run.length) {
      logger.info(
        `${logPrefix} ${windows.length - run.length} candle day(s) over the per-call cap left unknown`,
      )
    }
    await Promise.all(run.map((w) => this.readWindow(w)))
  }

  private async readWindow(w: { venue: string; pair: string } & FeeWindow) {
    const source = this.source
    if (!source) return
    await this.acquire()
    let rows: FeeCandle[] | null = null
    try {
      rows = await source({
        exchange: w.venue,
        symbol: w.pair,
        interval: FEE_PRICE_INTERVAL,
        from: w.from,
        to: w.to,
      })
    } catch (e) {
      logger.warn(
        `${logPrefix} ${w.venue}/${w.pair} candles failed: ${(e as Error)?.message ?? e}`,
      )
    } finally {
      this.release()
    }
    if (!rows) {
      // Source failure: not remembered, the next call asks again.
      return
    }
    const byMinute = new Map<number, number | null>()
    for (const c of rows) {
      if (c && Number.isFinite(Number(c.t))) {
        byMinute.set(minuteOf(Number(c.t)), candleMid(c))
      }
    }
    // Every minute the window returned is now known, asked for or not.
    for (const [m, v] of byMinute) this.setMid(w.venue, w.pair, m, v)
    for (const m of w.minutes) {
      if (!byMinute.has(m)) this.setMid(w.venue, w.pair, m, null)
    }
  }

  private acquire(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight += 1
      return Promise.resolve()
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.inFlight += 1
        resolve()
      }),
    )
  }

  private release() {
    this.inFlight -= 1
    const next = this.waiting.shift()
    if (next) next()
  }

  /** The venue's pairs whose base is one of `bases`, cached per base. */
  private async pairsFor(venue: string, bases: string[]): Promise<FeePair[]> {
    const out: FeePair[] = []
    for (const b of new Set(bases.map((x) => x.toUpperCase()))) {
      const key = `${venue}|${b}`
      let hit = this.pairs.get(key)
      if (!hit || +new Date() - hit.at > PAIRS_TTL_MS) {
        hit = { at: +new Date(), value: this.readPairs(venue, b) }
        this.pairs.set(key, hit)
      }
      out.push(...(await hit.value))
    }
    return out
  }

  private async readPairs(venue: string, base: string): Promise<FeePair[]> {
    try {
      const res = await pairDb.readData(
        { exchange: venue, 'baseAsset.name': base } as never,
        { _id: 0, pair: 1, 'baseAsset.name': 1, 'quoteAsset.name': 1 } as never,
        undefined,
        true,
      )
      return (
        (res.data?.result ?? []) as {
          pair?: string
          baseAsset?: { name?: string }
          quoteAsset?: { name?: string }
        }[]
      )
        .filter((p) => p.pair && p.baseAsset?.name && p.quoteAsset?.name)
        .map((p) => ({
          pair: `${p.pair}`,
          base: `${p.baseAsset?.name}`,
          quote: `${p.quoteAsset?.name}`,
        }))
    } catch (e) {
      logger.warn(
        `${logPrefix} pairs for ${venue}/${base} failed: ${(e as Error)?.message ?? e}`,
      )
      // A failed read is not cached as "no pairs".
      this.pairs.delete(`${venue}|${base}`)
      return []
    }
  }
}

/** One source read: a whole UTC day (cut at `now`), and the minutes wanted from it. */
export type FeeWindow = { from: number; to: number; minutes: number[] }

/** The needed minutes grouped into one window per UTC day, oldest first. */
export function windowsOf(minutes: number[], now: number): FeeWindow[] {
  const byDay = new Map<number, number[]>()
  for (const m of [...new Set(minutes)].sort((a, b) => a - b)) {
    const day = Math.floor(m / DAY_MS) * DAY_MS
    const list = byDay.get(day) ?? []
    list.push(m)
    byDay.set(day, list)
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, list]) => ({
      from: day,
      to: Math.max(
        Math.min(day + DAY_MS - 1, now),
        list[list.length - 1] + MINUTE_MS - 1,
      ),
      minutes: list,
    }))
}

export const feeAssetPrices = () => FeeAssetPrices.getInstance()

/** For a host process: where candles for fee-asset prices come from. */
export function setFeeAssetCandleSource(source: FeeCandleSource | null) {
  FeeAssetPrices.getInstance().setCandleSource(source)
}
