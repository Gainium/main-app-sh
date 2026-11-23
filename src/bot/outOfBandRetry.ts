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
