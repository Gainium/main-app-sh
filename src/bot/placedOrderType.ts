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
