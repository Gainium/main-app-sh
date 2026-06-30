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

/**
 * Canonical equity-ticker normalization for the icon pipeline (backend) and
 * `CoinIcon` (frontend mirrors this exact rule). Maps a tokenized-stock base to
 * the clean underlying ticker for logo lookup: Bitget reality `rTSLA` → `TSLA`,
 * lower-case wrappers `AAPLon`/`AAPLx` → `AAPL`. A clean perp base like `AAPL`
 * or `NFLX` (no wrapper) is returned upper-cased and intact. Only ever called
 * for stock/etf rows, so it can't mis-hit a crypto base.
 */
export function normalizeStockTicker(symbol: string): string {
  const s = symbol || ''
  let m = s.match(/^r([A-Z][A-Z0-9]+)$/) // reality rTSLA → TSLA
  if (m) return m[1].toUpperCase()
  m = s.match(/^([A-Z0-9]+)on$/) // AAPLon → AAPL
  if (m) return m[1].toUpperCase()
  m = s.match(/^([A-Z0-9]+)x$/) // AAPLx → AAPL
  if (m) return m[1].toUpperCase()
  return s.toUpperCase()
}

/**
 * Normalize a pair into its asset class. Trusts the connector's authoritative
 * signal; defaults to crypto. No name-based heuristics — see the file header.
 */
export function classifyAssetClass(input: ClassifyAssetClassInput): AssetClass {
  return input.connectorAssetClass ?? 'crypto'
}
