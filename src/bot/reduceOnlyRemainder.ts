import { ExchangeEnum } from '../../types'

/** The fields these predicates read off an order. */
export type RemainderOrder = {
  reduceOnly?: boolean | null
  type?: string | null
  status?: string | null
  executedQty?: string | number | null
  origQty?: string | number | null
}

/**
 * Whether `buyRemainder` should attempt recovery on a reduce-only order it
 * would otherwise bail out of unconditionally.
 *
 * The blanket reduce-only exclusion is correct almost everywhere: a
 * reduce-only remainder derived from `origQty - executedQty` describes spot
 * balances, not a futures position, and asking to reduce by that much was
 * measured (2026-08-30, 18.3h prod) to be rejected 15/15 times across
 * binanceUsdm/krakenUsdm/bybitLinear/bitgetUsdm. krakenUsdm's rejection in
 * that same measurement (`wouldNotReducePosition`) is consistent with "the
 * ask was bigger than the open position", which is recoverable by asking for
 * less — unlike the other three venues' outright `ReduceOnly Order is
 * rejected.` — so only krakenUsdm gets a carve-out here. `buyRemainder`'s own
 * existing fall-through-on-rejection behavior (main.ts) bounds the retry: a
 * krakenUsdm ask that is still too big simply comes back rejected and the
 * function returns whatever was recovered so far.
 *
 * Scoped to MARKET because that is Kraken's `mkr` order type — IOC with a 1%
 * price-protection band — which is the shape that produces this underfill in
 * the first place.
 */
export function canRecoverReduceOnlyRemainder(
  exchange: string | undefined,
  order: RemainderOrder,
): boolean {
  return exchange === ExchangeEnum.krakenUsdm && order.type === 'MARKET'
}

/**
 * Whether a synchronous order-placement response is krakenUsdm's terminal
 * "FILLED but underfilled" shape for a reduce-only close.
 *
 * Kraken futures has no true market order; `mkr` is IOC with a 1%
 * price-protection band, so a close that cannot fill within the band at send
 * time is filled for whatever the band allowed and the rest is cancelled by
 * the venue itself — there is never a resting remainder order to report
 * against, which is why the venue answers `FILLED` rather than
 * `PARTIALLY_FILLED`.
 *
 * Mirrors the existing bybit CANCELED-with-partial-fill hook in
 * `sendOrderToExchange`, generalized to the shape Kraken actually sends, so
 * the synchronous placement-response path (`closeDealById` et al.) gives
 * `buyRemainder` the same chance to recover the remainder that the
 * WS-driven order-status consumer already has unconditionally. Without this,
 * whichever of the two paths observes the order first decides deal closure
 * with no recovery attempted on either side.
 */
export function isKrakenUsdmUnderfilledReduceOnlyClose(
  exchange: string | undefined,
  order: RemainderOrder,
): boolean {
  if (
    exchange !== ExchangeEnum.krakenUsdm ||
    !order.reduceOnly ||
    order.type !== 'MARKET' ||
    order.status !== 'FILLED'
  ) {
    return false
  }
  const executed = Number(order.executedQty)
  const requested = Number(order.origQty)
  return (
    Number.isFinite(executed) &&
    Number.isFinite(requested) &&
    requested > 0 &&
    executed >= 0 &&
    executed < requested
  )
}
