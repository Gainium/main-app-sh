/**
 * Spec `266`. A futures combo deal whose venue position is smaller than the
 * deal records keeps re-sending the closing grid levels the venue refuses as
 * un-reducible. These are the pure parts of holding those levels back:
 * which level a refusal names, what "the deal's position or levels changed"
 * means, and what the user is told. The I/O lives in `comboHelper`.
 */

/**
 * How long a hold lasts with nothing else ending it (spec `266` §1.1.5). A
 * position the user restores by hand on the exchange changes nothing the bot
 * can see, so the levels are tried again after this long; a refusal then
 * re-holds them without telling the user again.
 */
export const GRID_SHORTFALL_HOLD_MS = 6 * 60 * 60 * 1000

export type GridShortfallHold = {
  /** {@link dealPositionFingerprint} when the hold was taken. */
  fingerprint: string
  until: number
  /** {@link gridLevelKey} of every held level. */
  levels: Set<string>
}

/**
 * One ladder level, the same for a refused `Order` (string price) and the
 * `Grid` the diff produces for it next time (number price, new client id).
 */
export const gridLevelKey = (level: {
  minigridId?: string | null
  side: string
  price: string | number
}): string => `${level.minigridId ?? ''}|${level.side}|${+level.price}`

/** The deal's recorded position and completed levels; a hold lasts while it does. */
export const dealPositionFingerprint = (deal: {
  currentBalances?: { base?: number } | null
  levels?: { complete?: number } | null
}): string => `${deal.currentBalances?.base}|${deal.levels?.complete}`

/**
 * The venue holds a position for the deal, but less than the deal records.
 * Flat (spec `175`) and unknown amounts are not a shortfall.
 */
export const isVenueShortfall = (
  venueQty: number | undefined,
  dealBase: number | undefined,
): boolean => {
  if (
    venueQty === undefined ||
    dealBase === undefined ||
    !Number.isFinite(venueQty) ||
    !Number.isFinite(dealBase) ||
    venueQty <= 0
  ) {
    return false
  }
  const recorded = Math.abs(dealBase)
  return venueQty < recorded - recorded * 1e-9
}

/** What the user reads, once per episode (spec `266` §1.1.2). */
export const venueShortfallMessage = ({
  dealId,
  symbol,
  exchange,
  venueQty,
  dealQty,
}: {
  dealId: string
  symbol: string
  exchange: string
  venueQty: number
  dealQty: number
}): string =>
  `${exchange} holds a ${venueQty} ${symbol} position, but deal ${dealId} records ${dealQty}. ` +
  `${exchange} refuses the deal's remaining grid sell orders because they would close more than the position it holds. ` +
  `The bot will stop re-sending those orders until the deal's position changes. ` +
  `Nothing about the deal was changed: its position, average price and profit are as before. ` +
  `Check the position on the exchange.`
