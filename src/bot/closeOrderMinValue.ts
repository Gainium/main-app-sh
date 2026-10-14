import { ExchangeEnum } from '../../types'

/** Venues that accept a reduce-only close below the minimum order value in either position mode. */
const EXEMPT_IN_ANY_MODE: ReadonlySet<string> = new Set([
  ExchangeEnum.bybitUsdm,
  ExchangeEnum.paperBybitUsdm,
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.paperBinanceUsdm,
])

/** Venues that accept it only in hedge mode, where the close names its position side. */
const EXEMPT_IN_HEDGE_MODE: ReadonlySet<string> = new Set([
  ExchangeEnum.bitgetUsdm,
  ExchangeEnum.paperBitgetUsdm,
])

/**
 * The minimum order value (`quoteAsset.minAmount`) a reduce-only close of a
 * deal's remainder has to clear. Spec `162`.
 *
 * On a USDⓈ-margined futures venue `quoteAsset.minAmount` is the venue's
 * minimum notional, and some venues apply it only to orders that open or add
 * to a position:
 *
 * - **bybit linear** — closing orders are not restricted by the minimum
 *   notional (they still need the minimum order size);
 * - **binance USDⓈ-M** — `-4164` applies "unless you choose reduce only", and
 *   hedge-mode closes (no reduce-only flag, a position side) fill below it;
 * - **bitget USDT-M**, hedge mode only — hedge-mode closes fill below it; a
 *   one-way reduce-only close below it has not been observed either way.
 *
 * There the close is held to no value minimum, so a remainder the venue would
 * close is not left open. Everywhere else the minimum is returned unchanged:
 * **hyperliquid** accepts a reduce-only close under $10 only when it closes
 * the whole venue position, which a deal's remainder need not be
 * (`minTradeNtlRejected`), a spot sell is an ordinary order, and on a
 * coin-margined venue the field is the contract size, not a minimum value.
 *
 * Paper venues follow the live venue they simulate.
 */
export function closeOrderQuoteMinimum(
  exchange: string | undefined,
  hedge: boolean,
  quoteMinAmount: number,
): number {
  if (!exchange) {
    return quoteMinAmount
  }
  if (
    EXEMPT_IN_ANY_MODE.has(exchange) ||
    (hedge && EXEMPT_IN_HEDGE_MODE.has(exchange))
  ) {
    return 0
  }
  return quoteMinAmount
}
