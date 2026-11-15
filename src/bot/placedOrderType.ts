import { OrderTypeEnum } from '../../types'

/** What the venue returned for an order we just placed. */
export type PlacedOrderReply = {
  type?: string | null
  price?: string | null
  executedQty?: string | null
  cummulativeQuoteQty?: string | null
  fills?: unknown[] | null
}

const finite = (v: string | null | undefined) =>
  v != null && !isNaN(+v) && isFinite(+v)

/**
 * Whether an order we just placed went through as MARKET or LIMIT, judged
 * from the venue's reply: a MARKET type, any fills, a price other than the
 * one we asked for, or an average fill price other than it.
 *
 * A requested LIMIT order that has executed nothing and reports a price of
 * 0 has not traded at all, so its price is no evidence of a market fill —
 * some venues report a resting order's (still empty) average price there
 * (spec 181).
 */
export function placedOrderType(
  reply: PlacedOrderReply,
  requested: { type?: string | null; origPrice?: string | null },
  roundPrice: (value: number) => number,
): OrderTypeEnum {
  const unfilledZeroPrice =
    requested.type === OrderTypeEnum.limit &&
    Number(reply.price ?? NaN) === 0 &&
    !(Number(reply.executedQty ?? 0) > 0)
  return reply.type === 'MARKET' ||
    (reply.fills?.length || 0) > 0 ||
    (!unfilledZeroPrice &&
      reply.price &&
      requested.origPrice &&
      finite(reply.price) &&
      finite(requested.origPrice) &&
      +reply.price !== +requested.origPrice) ||
    (reply.cummulativeQuoteQty &&
      finite(reply.cummulativeQuoteQty) &&
      requested.origPrice &&
      finite(requested.origPrice) &&
      reply.executedQty &&
      finite(reply.executedQty) &&
      +reply.cummulativeQuoteQty &&
      +reply.executedQty &&
      +requested.origPrice &&
      roundPrice(+reply.cummulativeQuoteQty / +reply.executedQty) !==
        +requested.origPrice)
    ? OrderTypeEnum.market
    : OrderTypeEnum.limit
}

/**
 * What we store for an order we just placed (spec 243).
 *
 * `type` is the type we SENT. A LIMIT order whose price the book had already
 * crossed trades on arrival. It stays LIMIT and carries
 * `filledOnArrival: true`. `pricedFromFills` says how it traded
 * (`placedOrderType`) and decides the stored price: from the fills when it
 * traded, the requested price when it did not. An order sent as MARKET keeps
 * its earlier classification unchanged.
 *
 * Until spec 243 the `placedOrderType` result was stored as the type. It was
 * only ever meant to choose the price (2022 base-order fill price, then
 * spec 181).
 */
export function placedOrderRecord(
  reply: PlacedOrderReply,
  requested: { type?: string | null; origPrice?: string | null },
  roundPrice: (value: number) => number,
): { type: OrderTypeEnum; pricedFromFills: boolean; filledOnArrival: boolean } {
  const traded = placedOrderType(reply, requested, roundPrice)
  const sentLimit = requested.type === OrderTypeEnum.limit
  return {
    type: sentLimit ? OrderTypeEnum.limit : traded,
    pricedFromFills: traded === OrderTypeEnum.market,
    filledOnArrival: sentLimit && traded === OrderTypeEnum.market,
  }
}

/**
 * Whether an order took liquidity: sent as MARKET, or a LIMIT that filled
 * on arrival (spec 243). Readers that used the stored MARKET label to mean
 * "traded on arrival, as taker" read this instead.
 */
export const tradedAsTaker = (
  order:
    | { type?: string | null; filledOnArrival?: boolean | null }
    | null
    | undefined,
): boolean =>
  !!order &&
  (order.type === OrderTypeEnum.market || order.filledOnArrival === true)

/** Fee rate to estimate with when the venue reported none for the order. */
export const estimatedFeeRate = (
  order: { type?: string | null; filledOnArrival?: boolean | null },
  fee: { maker?: number | null; taker?: number | null } | null | undefined,
): number => (tradedAsTaker(order) ? (fee?.taker ?? 0) : (fee?.maker ?? 0))
