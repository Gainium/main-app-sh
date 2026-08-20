import { ExchangeEnum } from '../../types'

export const isKucoin = (exchange: ExchangeEnum) =>
  [
    ExchangeEnum.kucoin,
    ExchangeEnum.kucoinInverse,
    ExchangeEnum.kucoinLinear,
    ExchangeEnum.paperKucoin,
    ExchangeEnum.paperKucoinInverse,
    ExchangeEnum.paperKucoinLinear,
  ].includes(exchange)

export const isUsdmKucoin = (exchange: ExchangeEnum) =>
  [ExchangeEnum.kucoinLinear, ExchangeEnum.paperKucoinLinear].includes(exchange)

export const isOkx = (exchange: ExchangeEnum) =>
  [
    ExchangeEnum.okx,
    ExchangeEnum.okxInverse,
    ExchangeEnum.okxLinear,
    ExchangeEnum.paperOkx,
    ExchangeEnum.paperOkxInverse,
    ExchangeEnum.paperOkxLinear,
  ].includes(exchange)

export const isKraken = (exchange: ExchangeEnum) =>
  [
    ExchangeEnum.kraken,
    ExchangeEnum.krakenUsdm,
    ExchangeEnum.paperKraken,
    ExchangeEnum.paperKrakenUsdm,
  ].includes(exchange)

/**
 * Transport/plumbing shapes that leave the VENUE'S state UNKNOWN.
 *
 * A venue rejection — min notional, tick size, insufficient funds, bad
 * permissions — is a definitive answer: the order does not exist and never
 * will. A transport failure is not an answer at all. The request may have been
 * signed, sent, accepted and matched, and only the response lost on the way
 * back.
 *
 * Deliberately matched on plumbing only: anything NOT listed here is treated as
 * definitive. Every timeout shape qualifies by construction — a timeout never
 * tells you whether the request landed — as does a 5xx, which is emitted by the
 * connector/venue only after it already has the request.
 */
const AMBIGUOUS_ORDER_FAILURE_MARKERS = [
  'econnreset',
  'econnrefused',
  'econnaborted',
  'epipe',
  'ehostunreach',
  'enetunreach',
  'eai_again',
  'socket hang up',
  'network socket disconnected',
  'fetch failed',
  // Covers ETIMEDOUT, "Request Timeout", "Server Timeout", Kraken's own
  // `EGeneral:Timeout`, and axios' "timeout of 5000ms exceeded".
  'timeout',
  'internal server error',
  'server error',
  'bad gateway',
  'service unavailable',
  // What `Exchange.apiCall` throws once its transport retry ladder is spent.
  'exchange connector |',
]

/**
 * Did an order request fail in a way that leaves the venue's state unknown?
 *
 * Treating an ambiguous failure as a definitive refusal is what produces BOTH
 * halves of the orphan/duplicate failure class:
 *
 *   - re-sending the same `newClientOrderId` on a venue that does not
 *     deduplicate client order ids (Hyperliquid does not) opens a SECOND live
 *     order, and
 *   - writing the order off as CANCELED drops it from `orders`/`ordersKeys`,
 *     after which `SharedStream` no longer routes its fills to the bot at all —
 *     so the position moves on the venue and never in the deal.
 *
 * Callers must ASK the venue before acting when this returns true.
 *
 * NOTE: intentionally NOT built on `getErrorSubType`. That classifier is
 * DB-rule-backed and re-seeded by admin-app, so an admin editing a bot-error
 * rule could silently change whether live orders get re-sent. This decision
 * stays in code.
 *
 * @param reason the `reason` of a `notok` BaseReturn, or a thrown message
 */
export const isAmbiguousOrderFailure = (reason?: string | null): boolean => {
  // No reason at all is the most ambiguous outcome there is — it is what an
  // exhausted transport ladder and a bare rejected promise both look like.
  if (!reason) {
    return true
  }
  const lower = `${reason}`.toLowerCase()
  return AMBIGUOUS_ORDER_FAILURE_MARKERS.some(
    (marker) => lower.indexOf(marker) !== -1,
  )
}
