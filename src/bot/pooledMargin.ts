import { ExchangeEnum } from '../../types'

/**
 * What a pooled-collateral account can commit, in the unit the caller's funds
 * check counts in.
 *
 * The connector reports the pool in USD (`/marginAvailableUsd`, `null` when
 * the account is not pooled). A USD-quoted linear contract is margined in USD,
 * so the pool is used as is (Kraken Futures flex). An inverse (COIN-M)
 * contract is counted in its base coin, so the pool is converted at the deal
 * price: that is how a Bitget Unified account in `multi_assets` mode margins
 * DOGEUSD from USDT alone (exchange-connector spec 028).
 *
 * Only ever widens `available` — a venue with no opinion, or a price that
 * cannot convert, leaves it unchanged.
 */
/**
 * Quote assets the USD pool can stand in for. The pool is a USD figure; a
 * USDC-quoted contract is margined in a dollar the venue counts at par, so it
 * draws on the same pool: OKX Europe X-Perps are USDC-quoted and an account in
 * Multi-currency margin funds them from EUR. Only venues that report a pool
 * (`/marginAvailableUsd` non-null) are ever widened.
 *
 * USDT is covered on Binance USDⓈ-M only: its pool is reported in Multi-Assets
 * mode, where every collateral coin margins every USDⓈ-M contract — an EEA
 * Credits-mode account holds USDC and trades USDT-quoted perpetuals from it.
 * Other venues' USDT-M behaviour in pooled mode is unverified, so they keep
 * the per-asset USDT balance.
 */
export const poolCoversQuote = (
  quoteAsset: string,
  exchange?: ExchangeEnum,
): boolean =>
  quoteAsset === 'USD' ||
  quoteAsset === 'USDC' ||
  (quoteAsset === 'USDT' && exchange === ExchangeEnum.binanceUsdm)

export const widenByPool = (
  available: number,
  poolUsd: number,
  coinm: boolean,
  price?: number,
): number => {
  if (!Number.isFinite(poolUsd) || poolUsd <= 0) {
    return available
  }
  if (!coinm) {
    return Math.max(available, poolUsd)
  }
  if (!price || !Number.isFinite(price) || price <= 0) {
    return available
  }
  return Math.max(available, poolUsd / price)
}
