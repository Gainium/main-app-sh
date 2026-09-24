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
