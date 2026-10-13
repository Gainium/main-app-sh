import type { Prices } from '../../types'

/**
 * Venue-native assets pegged 1:1 to USD that no exchange lists a market for, so
 * `findUSDRate` scores them 0 and the portfolio snapshot drops the row.
 *
 * BNFCR (Binance Futures Credit) is where a Binance USDⓈ-M Multi-Assets account
 * books settled losses, fees and funding — usually as a NEGATIVE balance. Left
 * unpriced, the account's USD value is its positive collateral alone and is
 * overstated by the whole debt; Binance's own Wallet Balance counts it at 1 USD.
 *
 * Appended under exchange `all` to the snapshot rate tables only (spec 158),
 * like the USDT→USD and fiat rates, so `findUSDRate`'s existing `asset/USD`
 * lookup prices it and no bot-engine rate lookup ever sees it.
 */
export const pegRateEntries: Prices = [
  { pair: 'BNFCRUSD', price: 1, exchange: 'all' },
]
