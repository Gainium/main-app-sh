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
 * The prefix `Exchange.apiCall` throws with once it has spent its OWN transport
 * retry ladder — six attempts at 500ms against the connector, ~3s in total.
 *
 * Named rather than inlined because two different questions read it, and they
 * must agree on the same string: {@link isAmbiguousOrderFailure} ("is the
 * venue's state unknown?") and {@link isTransportRetryExhausted} ("has this
 * call already been retried at the transport layer?").
 */
const TRANSPORT_RETRY_EXHAUSTED_MARKER = 'exchange connector |'

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
  TRANSPORT_RETRY_EXHAUSTED_MARKER,
  // Hyperliquid's `unknownOid`, which reaches a PLACEMENT result only after the
  // venue has already accepted the order. The connector's own `openOrder` uses
  // `unknownOid` as its "not a duplicate, go ahead and send" answer on the
  // pre-flight lookup, so the only way the token can come back out of a
  // placement is the post-acceptance status lookup — HL took the order, and
  // then would not describe it. That is a lost answer, not a refusal, and it is
  // exactly the shape that produced the orphan in forum #5097: BUY 1.18 HYPE
  // accepted at 05:41:09 on 2026-08-26, written off at 05:41:20, filled at
  // 06:13:32 into a position no bot was tracking.
  //
  // Note the deliberate asymmetry with `isDefinitiveOrderNotFound`, which also
  // matches this token. There it describes an order nobody has touched for a
  // day (the quarantine age floor is what makes that safe); here it describes
  // one the venue was handed seconds ago. Same word, opposite meaning, and the
  // caller's context is the only thing that can tell them apart.
  'unknownoid',
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

/**
 * Has this failure ALREADY been retried by `Exchange.apiCall`'s transport
 * ladder?
 *
 * Deliberately much narrower than {@link isAmbiguousOrderFailure}, which is
 * about what the VENUE did; this is about what WE already did. Only
 * `Exchange.apiCall` throws this prefix, and only after six attempts over ~3s,
 * so a caller-level retry policy that sees it is about to re-run that whole
 * ladder against a connector that has just refused six times in a row.
 *
 * Every other ambiguous reason — a `Response timeout` or a rate-limit reason
 * carried in a `notok` body on an HTTP 200, say — is NOT covered by the
 * transport ladder, and a caller-level retry is the only retry those get. So
 * they must keep it.
 *
 * @param reason the `reason` of a `notok` BaseReturn, or a thrown message
 */
export const isTransportRetryExhausted = (reason?: string | null): boolean =>
  !!reason &&
  `${reason}`.toLowerCase().indexOf(TRANSPORT_RETRY_EXHAUSTED_MARKER) !== -1
