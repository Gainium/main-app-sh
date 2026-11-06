import logger from '../utils/logger'
import { pairDb } from '../db/dbInit'
import { ClearPairsSchema, ExchangeEnum, StatusEnum } from '../../types'
import { LOG_PREFIX } from './types'

/**
 * Venue-symbol → canonical-pair resolver for the detector's price feed.
 *
 * The detector subscribes to `trade@{symbol}@{exchange}`, and
 * websocket-connector publishes those channels keyed by our CANONICAL pair
 * (`pairs.pair` — Kraken `ETH-EUR`, Binance `ETHUSDT`, Coinbase `BTC-USD`).
 * The `orders` collection does not always agree. Kraken echoes its own legacy
 * *altname* back for its oldest `X`/`Z`-prefixed markets, so the stored
 * `order.symbol` is `ETHEUR`, `XBTUSD`, `XRPEUR`, `ETHUSD`, `XBTEUR`,
 * `XRPUSD` — six of Kraken's largest markets.
 *
 * Subscribing on that string yields a channel nobody publishes to. The order is
 * then watched forever against a feed that never ticks, so no cross is ever
 * seen, no candidate is ever raised, and no `RECONCILE VIA SWEEP` is ever
 * published. It is a silent blind spot: every counter reads healthy because the
 * order simply never becomes a candidate.
 *
 * That is exactly how a filled Kraken ETH/EUR safety order went unnoticed for
 * 15h38m on 2026-08-28 (bot `EG_ETH_1`): the venue filled it at 16:15 UTC, and
 * the detector — which exists to catch that — had no price for `ETHEUR` at all.
 *
 * Resolution order, per exchange, first hit wins:
 *   1. exact `pairs.pair` — the overwhelmingly common case, every venue where
 *      the order row and the channel already agree. Costs one Set lookup.
 *   2. a normalised index over `pair` / `wsCode` / `code` (strip `-` and `/`,
 *      uppercase): `ETHEUR`→`ETH-EUR`, `ETH/EUR`→`ETH-EUR`.
 *   3. `${baseAsset}-${quoteAsset}` off the order row, then the same two
 *      lookups again. This is the only bridge for Kraken's `XBT*` altnames —
 *      `XBTUSD` normalises to `XBTUSD`, which matches no Kraken pair, but the
 *      order row carries the already-normalised `baseAsset: BTC`,
 *      `quoteAsset: USD`, which resolves to `BTC-USD`.
 *
 * Anything still unresolved falls back to the raw symbol, so a resolver miss is
 * exactly today's behaviour and never worse. Misses are logged once per
 * (exchange, symbol) so a new venue quirk shows up as a line rather than as
 * silence.
 *
 * Collision safety (the reason step 2 is allowed to exist): measured over the
 * full Kraken pair list, the normalised index has **zero** collisions — no two markets normalise onto the same key. The
 * resolver additionally refuses to record any key that would map to two
 * different pairs, so a future listing that does collide degrades to "leave it
 * alone" rather than to "watch the wrong market's price".
 */

/** Strip the separators venues disagree about and case-fold. */
const normalise = (s: string | undefined | null): string =>
  String(s ?? '')
    .replace(/[-/]/g, '')
    .toUpperCase()

interface ExchangeIndex {
  /** Canonical pairs, verbatim — the step-1 fast path. */
  exact: Set<string>
  /** normalised(pair|wsCode|code) → canonical pair. Collisions are dropped. */
  norm: Map<string, string>
  /** Keys proven ambiguous; never resolved through, only reported. */
  collisions: Set<string>
}

export class SymbolResolver {
  private byExchange = new Map<string, ExchangeIndex>()
  private loadedAt = 0
  /** (exchange, symbol) pairs already reported unresolved — log once each. */
  private reported = new Set<string>()

  /** Exchanges currently indexed (diagnostics). */
  get indexedExchanges(): number {
    return this.byExchange.size
  }

  /**
   * (Re)load the pair index for `exchanges`. Pairs change on a listing cadence,
   * not a trading one, so this is cheap to call on the registry loop and is
   * rate-limited internally by `maxAgeMs`.
   */
  async refresh(
    exchanges: string[],
    maxAgeMs = 30 * 60 * 1000,
    now: number = Date.now(),
  ): Promise<void> {
    const missing = exchanges.filter((e) => !this.byExchange.has(e))
    if (missing.length === 0 && now - this.loadedAt < maxAgeMs) return
    // Load everything we know about at once: a partial index would silently
    // fall back for the exchange that happens to be missing.
    const want = Array.from(new Set([...exchanges, ...this.byExchange.keys()]))
    if (want.length === 0) return
    try {
      const res = await pairDb.readData<ClearPairsSchema>(
        { exchange: { $in: want as ExchangeEnum[] } },
        { pair: 1, code: 1, wsCode: 1, exchange: 1 },
        {},
        true,
      )
      if (res.status !== StatusEnum.ok) {
        logger.error(`${LOG_PREFIX} pair index load failed: ${res.reason}`)
        return
      }
      const next = new Map<string, ExchangeIndex>()
      for (const row of res.data.result) {
        const ex = String(row.exchange)
        const pair = row.pair
        if (!ex || !pair) continue
        let idx = next.get(ex)
        if (!idx) {
          idx = { exact: new Set(), norm: new Map(), collisions: new Set() }
          next.set(ex, idx)
        }
        idx.exact.add(pair)
        for (const alias of [row.pair, row.wsCode, row.code]) {
          const key = normalise(alias)
          if (!key) continue
          // Already proven ambiguous — a later alias must not resurrect it,
          // or the last writer silently wins an ambiguous key.
          if (idx.collisions.has(key)) continue
          const seen = idx.norm.get(key)
          if (seen === undefined) {
            idx.norm.set(key, pair)
          } else if (seen !== pair) {
            // Ambiguous: two markets share a normalised form. Watching the
            // wrong market's price is worse than not watching at all.
            idx.norm.delete(key)
            idx.collisions.add(key)
          }
        }
      }
      // A pair row is never *removed* from the exact set by an alias collision,
      // so re-add after the alias pass in case `pair` itself was dropped above.
      for (const idx of next.values()) {
        for (const pair of idx.exact) {
          const key = normalise(pair)
          if (!idx.collisions.has(key)) idx.norm.set(key, pair)
        }
      }
      this.byExchange = next
      this.loadedAt = now
      const collisions = [...next.values()].reduce(
        (n, i) => n + i.collisions.size,
        0,
      )
      logger.debug(
        `${LOG_PREFIX} pair index: ${next.size} exchange(s), ` +
          `${[...next.values()].reduce((n, i) => n + i.exact.size, 0)} pairs` +
          (collisions ? `, ${collisions} ambiguous alias key(s) dropped` : ''),
      )
    } catch (e) {
      logger.error(`${LOG_PREFIX} pair index load error: ${e}`)
    }
  }

  /**
   * Canonical price-feed symbol for a resting order. Never throws; falls back
   * to `symbol` unchanged when nothing resolves.
   */
  resolve(
    exchange: string,
    symbol: string,
    baseAsset?: string,
    quoteAsset?: string,
  ): string {
    const idx = this.byExchange.get(exchange)
    if (!idx || !symbol) return symbol
    // 1. Already canonical — the common case on every venue.
    if (idx.exact.has(symbol)) return symbol
    // 2. Same market, different separator/case (Kraken altnames, `ETH/EUR`).
    const viaNorm = idx.norm.get(normalise(symbol))
    if (viaNorm) return viaNorm
    // 3. Rebuild from the order's own asset codes, which are already
    //    normalised even when the symbol is not (`XBTUSD` → BTC + USD).
    if (baseAsset && quoteAsset) {
      const rebuilt = `${baseAsset}-${quoteAsset}`
      if (idx.exact.has(rebuilt)) return rebuilt
      const viaAssets = idx.norm.get(normalise(rebuilt))
      if (viaAssets) return viaAssets
    }
    const key = `${exchange}@${symbol}`
    if (!this.reported.has(key)) {
      this.reported.add(key)
      logger.warn(
        `${LOG_PREFIX} unresolved price symbol ${symbol} on ${exchange} — ` +
          `watching it on trade@${symbol}@${exchange}, which may never tick`,
      )
    }
    return symbol
  }
}
