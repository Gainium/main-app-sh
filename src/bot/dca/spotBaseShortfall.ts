/**
 * Spec `298`. A long spot deal whose close the venue refused for balance, read
 * against what the account actually holds of the deal's base coin.
 *
 * The reading is the account's TOTAL base (free + locked): coin locked in the
 * user's other orders is still the user's, and a deal it covers is not short —
 * that case keeps today's behaviour. Pure, so the boundaries are pinned by
 * this module's spec.
 */

export type SpotShortfallVerdict =
  /** The balance could not be read: decide nothing. */
  | { kind: 'unknown' }
  /** Under the pair minimum: spec `047` settles this one, not `298`. */
  | { kind: 'gone'; total: number }
  /** The account holds the deal's remaining size. Today's behaviour. */
  | { kind: 'covered'; total: number }
  /** Above the minimum, below the deal: `missing` base left the account. */
  | { kind: 'short'; total: number; missing: number }

/**
 * @param venueTotal free + locked of the base coin, or `null` when unreadable
 * @param remaining the deal's own remaining base
 * @param minAmount the pair's minimum tradeable quantity. Also the tolerance
 *   on "covered": a deal short by less than one tradeable unit is rounding,
 *   fees or dust, and was never refused for it before.
 */
export const spotShortfallVerdict = ({
  venueTotal,
  remaining,
  minAmount,
}: {
  venueTotal: number | null
  remaining: number
  minAmount: number
}): SpotShortfallVerdict => {
  if (
    venueTotal === null ||
    !Number.isFinite(venueTotal) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(minAmount) ||
    minAmount <= 0
  ) {
    return { kind: 'unknown' }
  }
  if (venueTotal < minAmount) {
    return { kind: 'gone', total: venueTotal }
  }
  if (!(remaining > 0) || venueTotal >= remaining - minAmount) {
    return { kind: 'covered', total: venueTotal }
  }
  return { kind: 'short', total: venueTotal, missing: remaining - venueTotal }
}

/** What the user reads, once, when a deal is held for a shortfall. */
export const spotShortfallHeldMessage = ({
  dealId,
  symbol,
  asset,
  total,
  remaining,
  hedge = false,
}: {
  dealId: string
  symbol: string
  asset: string
  total: number
  remaining: number
  /**
   * A leg of a spot hedge bot. Both legs trade one coin from one account, so
   * the coins can also have gone to the hedge's own SHORT side's sells — bot
   * orders, which the outside-trades evidence rightly ignores.
   */
  hedge?: boolean
}): string =>
  `Deal ${dealId} (${symbol}): the exchange account holds ${total} ${asset}, ` +
  `less than the ${remaining} ${asset} this deal still has to sell, and the exchange ` +
  `did not report trades outside the bot that account for the difference. ` +
  (hedge
    ? `The short side of this hedge bot sells the same coin from the same account, and part of this coin was sold by it or moved outside the bot, so this deal is short by ${+(remaining - total).toPrecision(12)} ${asset} and its take profit cannot be placed. `
    : `Part of this coin was sold or moved outside the bot, so its take profit cannot be placed. `) +
  `New take-profit and safety orders for this deal are paused; its stop loss and manual close still work. ` +
  `The deal resumes on its own once the account holds the deal's amount again, or close it manually.`
