/**
 * Per-pair leverage limits, as the connector's exchange info reports them
 * (venue strings like `"100"` on Bybit / Bitget / Hyperliquid / OKX, numbers
 * elsewhere), normalised for the `pairs` collection: positive finite numbers,
 * or absent — never 0 standing in for "unknown". A min above the max is a
 * venue inconsistency; the max is the figure that matters, so it is kept.
 */
export interface PairLeverage {
  minLeverage?: number
  maxLeverage?: number
}

const positive = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export const normalizePairLeverage = (info: {
  minLeverage?: unknown
  maxLeverage?: unknown
}): PairLeverage => {
  const max = positive(info.maxLeverage)
  let min = positive(info.minLeverage)
  if (min !== undefined && max !== undefined && min > max) min = undefined
  return {
    ...(min !== undefined ? { minLeverage: min } : {}),
    ...(max !== undefined ? { maxLeverage: max } : {}),
  }
}
