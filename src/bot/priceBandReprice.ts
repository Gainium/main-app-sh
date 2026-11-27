/**
 * Re-pricing a combo grid order the market has already passed.
 *
 * A combo minigrid keeps the orders it should have on the book, priced at its
 * grid levels. When one of them is not on the book (the venue refused it for
 * balance, say) and the market then moves through its level, the engine keeps
 * re-sending it at the level. Most venues fill a LIMIT priced through the book
 * on arrival, which is what the grid wants: spec 243 books that fill at the
 * fill price and the grid stays anchored on `origPrice`. Venues with a limit-
 * price band refuse it instead (Bybit spot: `Buy order price cannot be higher
 * than 64651.1USDT`). That refusal is classified `Order price`, which is
 * non-erroring and hidden because it is normally transient, so a short combo
 * deal whose buy-backs sat 10k above a falling market retried the stale
 * prices on every restart for ten days and never covered.
 *
 * The cure is to send the order where the venue will take it: at the market
 * price (never past a band edge the venue names). The grid level
 * (`origPrice`) is untouched, so the fill is booked like any other limit that
 * crossed the book on arrival.
 */

export type PriceBandSide = 'BUY' | 'SELL'

/**
 * Which refused orders are re-sent through the market: combo grid levels
 * (spec 246), DCA / combo safety orders (spec 248) and a deal's take profit
 * (spec 254), as limit orders. A take profit the market has run through is
 * a close the deal is owed; sent at the market it closes at least as well as
 * its target. Add / reduce funds orders are the user's own and are left as
 * they are.
 */
export function repricesOnPriceBand(order: {
  typeOrder?: string
  type?: string
  dealId?: string | null
  addFundsId?: string | null
  reduceFundsId?: string | null
}): boolean {
  if (order.type === 'MARKET') {
    return false
  }
  if (order.typeOrder === 'dealGrid') {
    return true
  }
  return (
    (order.typeOrder === 'dealRegular' || order.typeOrder === 'dealTP') &&
    !!order.dealId &&
    !order.addFundsId &&
    !order.reduceFundsId
  )
}

/**
 * Whether a refusal is a venue limit-price band, the condition the re-send
 * cures. Every venue but Binance words it so that it classifies as
 * `Order price`, which the caller passes in as `isOrderPriceClass`. Binance
 * says `Filter failure: PERCENT_PRICE` / `PERCENT_PRICE_BY_SIDE`, which shares
 * the generic `Filter failure` match with LOT_SIZE, NOTIONAL and the rest and
 * so classifies as `Order params`. Matched here by the filter's own name, so
 * only the price band is re-sent and no other Binance filter ever is.
 */
export function isPriceBandRefusal(
  reason: string | null | undefined,
  isOrderPriceClass: boolean,
): boolean {
  return isOrderPriceClass || /PERCENT_PRICE/.test(reason ?? '')
}

/**
 * The band edge a venue names in its refusal, or null when it names none.
 * Bybit spot: `Buy order price cannot be higher than 64651.1USDT.` /
 * `Sell order price cannot be lower than 1.2345USDT.`; OKX: `The highest
 * price limit for the buy leg is 65,241.7.`
 */
export function priceBandEdgeFromReason(
  reason: string,
  side: PriceBandSide,
): number | null {
  const text = reason || ''
  // Bybit: `Buy order price cannot be higher than 64651.1USDT.`
  const bybit =
    /(buy|sell) order price cannot be (higher|lower) than\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(
      text,
    )
  // OKX: `The highest price limit for the buy leg is 65,241.7.`
  const okx =
    /(highest|lowest) price limit for the (buy|sell) leg is\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(
      text,
    )
  const m = bybit
    ? { side: bybit[1], direction: bybit[2], value: bybit[3] }
    : okx
      ? {
          side: okx[2],
          direction: okx[1].toLowerCase() === 'highest' ? 'higher' : 'lower',
          value: okx[3],
        }
      : null
  if (!m) {
    return null
  }
  const named = m.side.toUpperCase()
  const direction = m.direction.toLowerCase()
  if (named !== side) {
    return null
  }
  // A buy is capped from above and a sell from below; anything else is not
  // the band this helper understands.
  if ((side === 'BUY') !== (direction === 'higher')) {
    return null
  }
  const edge = +m.value.replace(/,/g, '')
  return Number.isFinite(edge) && edge > 0 ? edge : null
}

/**
 * The price to re-send a refused order at, or null when it must not be
 * re-priced: the order is not through the market (the refusal is about
 * something else), the market is unknown, or the re-price would not move it.
 *
 * Never moves the order the wrong way: a buy only goes down, a sell only up,
 * so the re-sent order always trades at least as well as its grid level.
 */
export function priceBandRepriceTarget(input: {
  side: PriceBandSide
  price: number
  market: number
  reason: string
}): number | null {
  const { side, price, market, reason } = input
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(market) ||
    market <= 0
  ) {
    return null
  }
  const through = side === 'BUY' ? price > market : price < market
  if (!through) {
    return null
  }
  // The market, not the band edge: on 2026-11-16 orders re-sent at exactly
  // the edge a Bybit / OKX refusal named were refused again (the edge had
  // already moved). The edge only ever tightens the target further.
  const edge = priceBandEdgeFromReason(reason, side)
  const bound = edge ?? market
  const target =
    side === 'BUY'
      ? Math.min(market, bound, price)
      : Math.max(market, bound, price)
  return target !== price ? target : null
}

/**
 * Exchange rejections that mean "this order's notional is under the venue
 * minimum". They route the order into the slippage-retry ladder, which on a
 * combo bot terminates in the `count === slippageRetry` branch of
 * `closeDealById` that books the deal closed without an order — the only
 * possible resolution when what is left to close is a residue the venue will
 * never accept an order for. Anything not listed here falls through to the
 * generic handler, which classifies it as `Order params` and stops the bot.
 */
export const notionalReasons = [
  // KuCoin
  'The order funds should be more than',
  // Binance NOTIONAL / MIN_NOTIONAL filter
  'NOTIONAL',
  // Hyperliquid — "order must have minimum value of $10. asset=122"
  'must have minimum value of',
]

/**
 * Did the venue refuse the order as below its minimum order value
 * ({@link notionalReasons})?
 */
export function isBelowMinNotionalRefusal(reason: unknown): boolean {
  const text = `${reason ?? ''}`.toLowerCase()
  return notionalReasons.some((r) => text.includes(r.toLowerCase()))
}
