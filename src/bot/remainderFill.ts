import { ExchangeEnum } from '../../types'
import type { RemainderOrder } from './reduceOnlyRemainder'

/**
 * Whether the venue's answer to a remainder order — a MARKET order
 * `buyRemainder` sent for the part of an order that did not fill — is
 * "executed some of it, then ended the order itself".
 *
 * `buyRemainder` merges a remainder order it considers successful back into
 * the row it is completing. Everything it does not recognise is dropped: the
 * quantity was still BOUGHT, so a venue shape missing from this predicate
 * becomes a position the deal does not know it owns — worse, and more silently,
 * than the underfill the remainder order was trying to repair.
 *
 * Two venues answer this way, for the same underlying reason and with
 * deliberately different scope:
 *
 * - **coinbase** sends every market order as `market_market_ioc`, and its
 *   connector maps every status that is not `OPEN`/`PENDING`/`FILLED` to
 *   `CANCELED`. So a market order that could not fill in full against the book
 *   at send time comes back `CANCELED` carrying its `filled_size`. This is the
 *   only shape a Coinbase remainder order has when the book is thin, which is
 *   exactly when a remainder order is needed. Spec `057` §4.5.
 * - **bybit**'s pre-existing hook, kept at exactly its original scope: it also
 *   required the ORIGINAL order to have been `MARKET`. That narrowing is not
 *   widened here — it is not this spec's to re-measure.
 */
export function isVenueCanceledRemainderFill(
  exchange: string | undefined,
  originalOrderType: string | undefined | null,
  remainder: RemainderOrder,
): boolean {
  if (remainder.status !== 'CANCELED') {
    return false
  }
  const executed = Number(remainder.executedQty)
  if (!Number.isFinite(executed) || executed <= 0) {
    return false
  }
  if (exchange === ExchangeEnum.coinbase) {
    return true
  }
  return exchange === ExchangeEnum.bybit && originalOrderType === 'MARKET'
}

/**
 * Whether a remainder top-up of `qty` at `price` is worth less than the venue's
 * minimum order value, on a venue that is known to refuse it for that reason.
 *
 * Only **bybit** spot BUY. A market buy there is sized in quote, and Bybit
 * refuses one below the pair's `minOrderAmt` (`quoteAsset.minAmount`) with
 * `Order value exceeded lower limit.`, or with `An unknown parameter was sent.`
 * once the amount rounds to zero. Other venues are not judged: a kucoinLinear
 * top-up worth 0.05 USDT against a stored minimum of 1 filled. Spec `153` §1.1.
 */
export function isBelowVenueMinOrderValue(
  exchange: string | undefined,
  side: string | undefined,
  qty: number,
  price: number,
  quoteMinAmount: number | undefined | null,
): boolean {
  if (exchange !== ExchangeEnum.bybit || side !== 'BUY') {
    return false
  }
  if (
    typeof quoteMinAmount !== 'number' ||
    !Number.isFinite(quoteMinAmount) ||
    quoteMinAmount <= 0
  ) {
    return false
  }
  return qty * price < quoteMinAmount
}
