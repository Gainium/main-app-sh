/**
 * Base a combo SHORT bot owes from closes that were too small to place.
 * Spec `222`.
 *
 * A combo SHORT deal on spot, with profit in quote, closes by buying back the
 * base it sold: `initialBalances.base - currentBalances.base`. When that
 * buy-back is worth less than the venue's minimum order, the venue would refuse
 * it, so the close is skipped and the deal is closed without an order. The skip
 * itself is correct. Before this module, though, nothing remembered the base
 * that was not bought back, and every such close shrank the bot's base for good.
 *
 * The shortfall is now carried per bot and per symbol and added to the next
 * close's buy-back. Several small shortfalls are bought back by whichever close
 * gets them over the minimum. The carry only grows inside a skip, and a skip
 * means own + carry was below the minimum, so it is always worth less than one
 * minimum order. Only a bot's final deal can be left short, by less than that.
 *
 * Pure: no I/O. The bot persists the array as `shortCloseCarry`.
 */
export type ShortCloseCarry = { symbol: string; base: number }[]

const finite = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0

/** The base carried for `symbol`, 0 when there is none. */
export function carriedBase(
  carry: ShortCloseCarry | undefined | null,
  symbol: string,
): number {
  return Math.max(
    0,
    finite((carry ?? []).find((c) => c?.symbol === symbol)?.base),
  )
}

/** `carry` with `symbol` set to `base`; an entry at or below 0 is dropped. */
export function setCarriedBase(
  carry: ShortCloseCarry | undefined | null,
  symbol: string,
  base: number,
): ShortCloseCarry {
  const rest = (carry ?? []).filter((c) => c && c.symbol !== symbol)
  const value = finite(base)
  return value > 0 ? [...rest, { symbol, base: value }] : rest
}

/**
 * Carry after a close was skipped below the venue minimum. `owed` is the
 * skipped deal's own shortfall. A negative `owed` (the deal bought back more
 * than it sold) is not credited: that base was never sold to begin with.
 */
export function carryAfterSkippedClose(carried: number, owed: number): number {
  return Math.max(0, finite(carried)) + Math.max(0, finite(owed))
}

/**
 * Carry after a close order filled. `inOrder` is the carried base that was
 * added to that order when it was sized. `fillRatio` is the share of the order
 * that executed (1 for a full fill). The carry is repaid by what was carried
 * into the order times that ratio, floored at 0.
 *
 * This is measured against the order rather than against the deal's books. The
 * combo close deliberately sizes a deal's own part net of an entry-fee estimate,
 * so after a correct close the books still show that estimate as unbought.
 * Repaying from the books would leave it in the carry for good.
 */
export function carryAfterFilledClose(
  carried: number,
  inOrder: number,
  fillRatio: number,
): number {
  const ratio = Math.min(1, Math.max(0, finite(fillRatio)))
  const repaid = Math.max(0, finite(inOrder)) * ratio
  return Math.max(0, Math.max(0, finite(carried)) - repaid)
}
