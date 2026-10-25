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
 *     day, a confirmed miss for minutes;
 *   - `warm` reads, ahead of a run of `prices` calls, the days they will need,
 *     `MAX_IN_FLIGHT` at a time, into a short-lived memo of each day's
 *     answer (`WARM_MAX_WINDOWS` days, minutes). `prices` then answers a day
 *     from that memo instead of the source, so it values exactly what it
 *     would have valued, without waiting on each day in turn.
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
/** Eviction stops here, so one eviction frees room for many days. */
const MID_CACHE_LOW = 150_000
export const WARM_MAX_WINDOWS = 400
const WARM_TTL_MS = 10 * 60_000

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
  /** A day's answer by `windowKey`: its minutes and their mids (NaN: no usable price). */
  private days = new Map<
    string,
    { at: number; value: Promise<WindowMids | null> }
  >()

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

  /**
   * Reads ahead the candle days `reqs` will need from the source, for the
   * `prices` calls that follow (the module doc's `warm`). Values nothing and
   * caches no price: a day it could not read is read again by `prices`.
   */
  async warm(reqs: FeePriceRequest[]): Promise<number> {
    if (!this.source || !reqs.length) return 0
    const need = this.minutesNeeded(reqs, await this.routesOf(reqs))
    const windows = this.windowsFor(need).filter(
      (w) => !this.dayCached(windowKey(w)),
    )
    const run = windows.slice(0, WARM_MAX_WINDOWS)
    await Promise.all(run.map((w) => this.windowMids(w)))
    return run.length
  }

  /** Routes per (venue, asset, quote). */
  private async routesOf(reqs: FeePriceRequest[]) {
    const routes = new Map<string, FeeRoute | null>()
    for (const r of reqs) {
      const k = `${r.venue}|${r.asset.toUpperCase()}|${r.quote.toUpperCase()}`
      if (routes.has(k)) continue
      const pairs = await this.pairsFor(r.venue, [r.asset, r.quote])
      routes.set(k, feeRoute(r.asset, r.quote, pairs))
    }
    return routes
  }

  /** Prices by `priceKey`; null where unknown. */
  async prices(reqs: FeePriceRequest[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>()
    if (!this.source || !reqs.length) {
      for (const r of reqs) out.set(priceKey(r), null)
      return out
    }
    const routes = await this.routesOf(reqs)
    // Every mid this call needs, as it found or read it: the shared cache may
    // evict them before they are read back below.
    const have = new Map<string, number | null>()
    await this.readCandles(this.minutesNeeded(reqs, routes, have), have)
    for (const r of reqs) {
      const route = routes.get(
        `${r.venue}|${r.asset.toUpperCase()}|${r.quote.toUpperCase()}`,
      )
      const m = minuteOf(r.at)
      out.set(
        priceKey(r),
        route
          ? routePrice(route, (pair) => {
              const k = midKey(r.venue, pair, m)
              return have.has(k)
                ? have.get(k)
                : this.midCached(r.venue, pair, m)
            })
          : null,
      )
    }
    return out
  }

  /**
   * Every (venue, pair, minute) any route needs and no price is cached for;
   * the cached ones go into `have`.
   */
  private minutesNeeded(
    reqs: FeePriceRequest[],
    routes: Map<string, FeeRoute | null>,
    have?: Map<string, number | null>,
  ) {
    const need = new Map<string, Set<number>>()
    const want = (venue: string, pair: string, minute: number) => {
      const cached = this.midCached(venue, pair, minute)
      if (cached !== undefined) {
        have?.set(midKey(venue, pair, minute), cached)
        return
      }
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
    return need
  }

  private midCached(venue: string, pair: string, minute: number) {
    const hit = this.mids.get(midKey(venue, pair, minute))
    if (!hit) return undefined
    const ttl = hit.value === null ? MISS_TTL_MS : MID_TTL_MS
    if (+new Date() - hit.at > ttl) {
      this.mids.delete(midKey(venue, pair, minute))
      return undefined
    }
    return hit.value
  }

  /** Caches a mid; at the cap the oldest-stored minutes go first. */
  private setMid(
    venue: string,
    pair: string,
    minute: number,
    v: number | null,
    have?: Map<string, number | null>,
  ) {
    const key = midKey(venue, pair, minute)
    have?.set(key, v)
    this.mids.delete(key)
    if (this.mids.size >= MID_CACHE_MAX) {
      for (const k of this.mids.keys()) {
        if (this.mids.size <= MID_CACHE_LOW) break
        this.mids.delete(k)
      }
    }
    this.mids.set(key, { at: +new Date(), value: v })
  }

  private windowsFor(need: Map<string, Set<number>>) {
    const windows: VenueWindow[] = []
    for (const [k, set] of need) {
      const [venue, pair] = [
        k.slice(0, k.indexOf('|')),
        k.slice(k.indexOf('|') + 1),
      ]
      for (const w of windowsOf([...set], +new Date()))
        windows.push({ venue, pair, ...w })
    }
    return windows
  }

  private async readCandles(
    need: Map<string, Set<number>>,
    have?: Map<string, number | null>,
  ) {
    const windows = this.windowsFor(need)
    const run = windows.slice(0, MAX_WINDOWS_PER_CALL)
    if (windows.length > run.length) {
      logger.info(
        `${logPrefix} ${windows.length - run.length} candle day(s) over the per-call cap left unknown`,
      )
    }
    await Promise.all(run.map((w) => this.readWindow(w, have)))
  }

  private async readWindow(w: VenueWindow, have?: Map<string, number | null>) {
    const day = await this.windowMids(w)
    if (!day) {
      // Source failure: not remembered, the next call asks again.
      return
    }
    // Every minute the window returned is now known, asked for or not.
    const returned = new Set<number>()
    day.minutes.forEach((m, i) => {
      returned.add(m)
      this.setMid(
        w.venue,
        w.pair,
        m,
        Number.isNaN(day.mids[i]) ? null : day.mids[i],
        have,
      )
    })
    for (const m of w.minutes) {
      if (!returned.has(m)) this.setMid(w.venue, w.pair, m, null, have)
    }
  }

  private dayCached(key: string) {
    const hit = this.days.get(key)
    if (hit && +new Date() - hit.at > WARM_TTL_MS) {
      this.days.delete(key)
      return undefined
    }
    return hit
  }

  /** The window's minutes and mids: from the `warm` memo, else one source read. */
  private windowMids(w: VenueWindow): Promise<WindowMids | null> {
    const key = windowKey(w)
    const hit = this.dayCached(key)
    if (hit) return hit.value
    const value = this.readDay(w)
    const entry = { at: +new Date(), value }
    while (this.days.size >= WARM_MAX_WINDOWS) {
      this.days.delete(this.days.keys().next().value as string)
    }
    this.days.set(key, entry)
    // A failed read is not remembered.
    void value.then((v) => {
      if (!v && this.days.get(key) === entry) this.days.delete(key)
    })
    return value
  }

  private async readDay(w: VenueWindow): Promise<WindowMids | null> {
    const source = this.source
    if (!source) return null
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
    if (!rows) return null
    const byMinute = new Map<number, number | null>()
    for (const c of rows) {
      if (c && Number.isFinite(Number(c.t))) {
        byMinute.set(minuteOf(Number(c.t)), candleMid(c))
      }
    }
    const minutes = new Float64Array(byMinute.size)
    const mids = new Float64Array(byMinute.size)
    let i = 0
    for (const [m, v] of byMinute) {
      minutes[i] = m
      mids[i] = v === null ? NaN : v
      i += 1
    }
    return { minutes, mids }
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

type VenueWindow = { venue: string; pair: string } & FeeWindow

/** What one window read answered, minute by minute (NaN: no usable price). */
type WindowMids = { minutes: Float64Array; mids: Float64Array }

const midKey = (venue: string, pair: string, minute: number) =>
  `${venue}|${pair}|${minute}`

const windowKey = (w: VenueWindow) => `${w.venue}|${w.pair}|${w.from}|${w.to}`

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
