/**
 * Opt-in refusal of DCA orders that the exchange minimum would inflate.
 *
 * When a configured Base Order or Safety Order is below a pair's exchange
 * minimum, the sizing routines (`getBaseOrder`, `createInitialDealOrders`)
 * raise it to that minimum so the venue accepts it. That keeps the bot trading,
 * but the order it places can be several times what the user configured — a
 * 10.80 base order placed as 39.59 — which changes the strategy's position
 * sizing and risk without asking.
 *
 * A DCA bot with `rejectBelowExchangeMin` set asks for the other trade-off: do
 * not open the deal, and say which order is too small and what the minimum is,
 * so the user can remove the pair or raise the sizes. The sizing routines keep
 * sizing exactly as they always have; they only record, per order, the quantity
 * the configured size produced and the quantity after the exchange-minimum
 * raises ({@link MinOrderFloor}). The decision lives here, as plain functions
 * over plain numbers.
 *
 * Only the MINIMUM raises are recorded. Step rounding and COIN-M contract
 * rounding also move the quantity, but they are granularity, not a minimum —
 * they happen to every order on the pair whatever its size.
 */

/**
 * How far the exchange minimum may raise an order before the deal is refused.
 * Absorbs rounding next to the minimum (a short entry sized at the slippage
 * price and re-checked at the market price is raised by about the slippage);
 * the same bound the grid-budget refusal uses (spec 068).
 */
export const MIN_ORDER_FLOOR_TOLERANCE = 0.1

/** One order's quantity before and after the exchange-minimum raises. */
export type MinOrderFloor = {
  /** Quantity the configured size produced, before any exchange minimum. */
  configuredQty: number
  /** Quantity after the exchange-minimum raises. */
  raisedQty: number
  /** Price the order was sized at. */
  price: number
}

export type MinOrderViolation = MinOrderFloor & {
  /** `0` for the base order, the DCA level number for a safety order. */
  level: number
}

const usable = (n: number) => Number.isFinite(n) && n > 0

/**
 * True when the exchange minimum raised this order past the tolerance.
 * Fail-open on anything unsizeable — that is the behaviour without the setting.
 */
export const raisedPastConfigured = (f: MinOrderFloor): boolean =>
  usable(f.configuredQty) &&
  usable(f.raisedQty) &&
  f.raisedQty > f.configuredQty * (1 + MIN_ORDER_FLOOR_TOLERANCE)

const fmt = (n: number) => {
  if (!Number.isFinite(n)) {
    return `${n}`
  }
  const abs = Math.abs(n)
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 8
  return `${+n.toFixed(digits)}`
}

const orderName = (level: number) =>
  level === 0 ? 'Base Order' : `Safety Order ${level}`

/** How many orders the message lists before summarising the rest. */
const LISTED = 3

/**
 * The message the user gets. Names the pair, each order that was too small
 * (configured amount and what the minimum would have made it), the exchange
 * minimum, and what to change. Deliberately matches no `errorDict` key, which
 * would re-label it under an unrelated error type.
 */
export const minOrderRefusalMessage = (input: {
  pair: string
  baseAsset: string
  quoteAsset: string
  minBase: number
  minQuote: number
  violations: MinOrderViolation[]
}): string => {
  const { pair, baseAsset, quoteAsset, minBase, minQuote, violations } = input
  const listed = violations
    .slice(0, LISTED)
    .map(
      (v) =>
        `${orderName(v.level)} ${fmt(v.configuredQty * v.price)} ${quoteAsset} would be raised to ${fmt(
          v.raisedQty * v.price,
        )} ${quoteAsset}`,
    )
  if (violations.length > LISTED) {
    listed.push(`${violations.length - LISTED} more safety orders`)
  }
  const minimum = [
    usable(minBase) ? `${fmt(minBase)} ${baseAsset}` : '',
    usable(minQuote) ? `${fmt(minQuote)} ${quoteAsset}` : '',
  ]
    .filter(Boolean)
    .join(' and ')
  return `Deal not opened on ${pair}: order size is below the exchange minimum${
    minimum ? ` (${minimum} per order)` : ''
  }. ${listed.join('; ')}. The bot is set to reject orders below the exchange minimum instead of increasing them. Remove ${pair} from the bot, or increase the Base/Safety Order size. No deal will start on this pair`
}
