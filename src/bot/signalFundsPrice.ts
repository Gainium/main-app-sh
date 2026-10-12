/**
 * Optional `price` on an `addFunds` / `reduceFunds` webhook.
 *
 * With it, the order is placed as a resting LIMIT at that price — the same
 * order the terminal's "Limit" option on add / reduce funds places. Without
 * it, the order is a MARKET order, exactly as before.
 *
 * One price cannot be right for several pairs, so on a bot that trades more
 * than one pair the signal must also name the `symbol` the price is for.
 * Otherwise every open deal of the bot would get an order at a price quoted
 * for one of them.
 */
type ParseResult =
  | { price?: string; needsSymbol: boolean; error?: undefined }
  | { price?: undefined; needsSymbol: false; error: string }

/**
 * Read and validate `price`. A field that is present but not a positive number
 * is an error rather than a fallback to market: a template variable that
 * rendered empty or as `NaN` is the usual cause, and a market fill is exactly
 * the slippage the sender asked to avoid.
 */
export function parseSignalFundsPrice(
  data: Record<string, unknown> | undefined,
): ParseResult {
  const raw = data?.price
  if (raw === undefined || raw === null) {
    return { needsSymbol: false }
  }
  const value =
    typeof raw === 'number' || typeof raw === 'string'
      ? Number(`${raw}`.trim())
      : NaN
  if (`${raw}`.trim() === '' || !Number.isFinite(value) || value <= 0) {
    return {
      needsSymbol: false,
      error: `Invalid "price": ${JSON.stringify(raw)}. Expected a positive number, or leave "price" out for a market order.`,
    }
  }
  const symbol = data?.symbol
  return {
    price: `${value}`,
    needsSymbol: typeof symbol !== 'string' || symbol.trim() === '',
  }
}

export const signalFundsPriceNeedsSymbolReason =
  'A "price" on a bot with more than one pair needs a "symbol" to say which pair it is for.'
