/**
 * Asset-class normalizer.
 *
 * Asset class (crypto / stock / etf / commodity / metal / forex / index) is set
 * by the PRODUCER — the exchange-connector — from each exchange's OWN
 * authoritative classification (e.g. Bitget's v3 `symbolType`). We do NOT guess
 * from symbol names: curated suffix/ticker heuristics produce false positives
 * (e.g. the `SPX6900` memecoin matching an `SPX` index list, or Bitget's `…ON`
 * wrapped tokens — which Bitget itself classifies as crypto — looking like
 * stocks). So this module simply trusts the connector signal and defaults to
 * crypto when an exchange exposes no classification.
 *
 * When a new venue starts listing RWAs, wire its native signal in the
 * connector (its producer), not a heuristic here.
 */

import type { AssetClass } from '../../types'

export interface ClassifyAssetClassInput {
  exchange: string
  pair: string
  baseAsset: string
  quoteAsset: string
  /** Authoritative class from the connector's ExchangeInfo, if the exchange
   *  exposes one. */
  connectorAssetClass?: AssetClass
}

export interface NormalizeStockTickerOpts {
  /**
   * The pair's `exchange` (an `ExchangeEnum` value, e.g. `bitget`, `bybit`,
   * `bybitLinear`). Gates the **upper-case** wrapper strips to the venues that
   * actually mint them, because upper-case affixes collide with clean tickers
   * (`NFLX`, `RBLX`). Optional: when absent we only strip the unambiguous
   * lower-case wrappers, so a missing exchange can never mangle a clean ticker.
   */
  exchange?: string
}

/**
 * Canonical equity-ticker normalization for the icon pipeline (backend) and
 * `CoinIcon` (frontend mirrors this exact rule). Maps a tokenized-stock base to
 * the clean underlying ticker for logo lookup: reality `rTSLA`/`RAAPL` → `TSLA`
 * /`AAPL`, lower-case wrappers `AAPLon`/`AAPLx` → `AAPL`, Bybit-spot xstock
 * `AAPLX` → `AAPL`. A clean perp base like `AAPL` or `NFLX` (no wrapper) is
 * returned upper-cased and intact. Only ever called for stock/etf rows, so it
 * can't mis-hit a crypto base.
 *
 * Lower-case wrappers (`rTSLA`, `AAPLx`, `AAPLon`) are unambiguous — no clean
 * upper-case ticker looks like that — so they strip on any venue. Upper-case
 * wrappers (`RAAPL`, `AAPLX`) are NOT: a clean ticker can legitimately start
 * with `R` (`RBLX`/`RIVN`/`RDDT`) or end in `X` (`NFLX`). We therefore strip
 * those ONLY on the venue that produces that wrapper:
 *   - Bitget stock-class bases are always reality (`R`-prefixed); Bitget never
 *     lists a clean `R`-ticker as a stock, so any Bitget stock base starting
 *     with `R` is a wrapper.
 *   - Bybit SPOT xstocks are `X`-suffixed (`AAPLX`); the clean `NFLX`/`AAPL`
 *     perps live on `bybitLinear`, so gate on the spot `exchange === 'bybit'`.
 *   - Kraken xStocks are `X`-suffixed too (`AAPLX`, on `krakenUsdm`); Kraken has
 *     no clean equity perps, so any Kraken stock base may be stripped.
 * The venue is lower-cased and stripped of a `paper` prefix first, so the paper
 * twins (`paperBitget`, `paperBybit`, `paperKrakenUsdm`, …) gate identically.
 */
export function normalizeStockTicker(
  symbol: string,
  opts?: NormalizeStockTickerOpts,
): string {
  const s = symbol || ''
  // Normalize the venue: lower-case and drop the `paper` prefix so the paper
  // twins (`paperBitget`, `paperBybit`, `paperBybitLinear`, …) gate exactly
  // like their real counterparts — the local/paper stack lists these RWAs too.
  const exchange = (opts?.exchange ?? '').toLowerCase().replace(/^paper/, '')

  // Unambiguous lower-case wrappers — safe to strip on any venue.
  let m = s.match(/^r([A-Z][A-Z0-9]+)$/) // reality rTSLA → TSLA
  if (m) return m[1].toUpperCase()
  m = s.match(/^([A-Z0-9]+)on$/) // AAPLon → AAPL
  if (m) return m[1].toUpperCase()
  m = s.match(/^([A-Z0-9]+)x$/) // Kraken AAPLx → AAPL
  if (m) return m[1].toUpperCase()

  // Upper-case wrappers — venue-gated so we don't mangle a clean ticker.
  if (exchange.startsWith('bitget')) {
    m = s.match(/^R([A-Z][A-Z0-9]+)$/) // Bitget reality RAAPL → AAPL
    if (m) return m[1].toUpperCase()
  }
  // Upper-case `X` suffix = an xstock wrapper. Strip it only where the venue's
  // stock listings are EXCLUSIVELY tokenized, so we never mangle a clean ticker
  // ending in X (`NFLX`):
  //   - Bybit SPOT (`bybit`) — clean equity perps live on `bybitLinear`.
  //   - Kraken (any market) — Kraken classifies only xStocks/Pre-IPO as `stock`
  //     (futures `category`); it has no clean equity perps, and spot carries no
  //     stock signal. So any Kraken stock base is an xStock (`…x`/`…X`).
  if (exchange === 'bybit' || exchange.startsWith('kraken')) {
    m = s.match(/^([A-Z0-9]+)X$/) // xstock AAPLX → AAPL
    if (m) return m[1].toUpperCase()
  }

  return s.toUpperCase()
}

/**
 * Normalize a pair into its asset class. Trusts the connector's authoritative
 * signal; defaults to crypto. No name-based heuristics — see the file header.
 */
export function classifyAssetClass(input: ClassifyAssetClassInput): AssetClass {
  return input.connectorAssetClass ?? 'crypto'
}
