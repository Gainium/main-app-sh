import { OrderStatusType, OrderTypeEnum } from '../../../types'
import { repositionKeepsRestingBaseEntry } from './baseEntryReposition'

/** What the "rest the remainder" decision reads. Spec `111` §4.1. */
export type BaseEntryRemainderInputs = {
  /**
   * Whether this bot may enter at market: a MARKET entry, or a LIMIT one with
   * the "Enter Market Timeout" switch on. Such a bot's settle already tops the
   * entry up at market (spec `057`).
   */
  marketEntryAllowed: boolean
  /**
   * Both in ONE unit: base, or contracts on a coin-margined account. The
   * engine puts them there first (`dcaHelper.baseEntryRemainderUnits`). Spec
   * `111` §4.1.1.
   */
  executedQty: string | number | null | undefined
  origQty: string | number | null | undefined
}

/**
 * How much of a base order that opened its deal short is left to rest as a
 * LIMIT order. `0` means nothing is placed.
 *
 * Only for a bot that may not enter at market. The settle opens its deal on
 * what filled, so a take profit and stop loss cover that part, and this
 * remainder is the rest of the base order its owner configured. The result is
 * not rounded; the caller rounds to the pair's step.
 */
export function baseEntryRemainderQty(args: BaseEntryRemainderInputs): number {
  if (args.marketEntryAllowed) {
    return 0
  }
  if (
    args.origQty === null ||
    args.origQty === undefined ||
    args.origQty === '' ||
    args.executedQty === null ||
    args.executedQty === undefined ||
    args.executedQty === ''
  ) {
    return 0
  }
  const requested = Number(args.origQty)
  const executed = Number(args.executedQty)
  if (!isFinite(requested) || !isFinite(executed) || executed <= 0) {
    return 0
  }
  return requested > executed ? requested - executed : 0
}

/**
 * A coin-margined (inverse) quantity in contracts of `contractSize` quote
 * each: the conversion `sendOrderToExchange` applies on the way out and
 * `convertOrderExecutedQty` undoes on the way back. `NaN` when it cannot be
 * computed. Spec `111` §4.1.1.
 */
export function inverseContracts(
  qty: number,
  price: number,
  contractSize: number,
): number {
  if (
    !isFinite(qty) ||
    !isFinite(price) ||
    !isFinite(contractSize) ||
    !(contractSize > 0)
  ) {
    return NaN
  }
  return Math.round((qty * price) / contractSize)
}

/** What the remainder's reposition tick compares. */
export type RestingRemainderInputs = {
  orderStatus: OrderStatusType | string | null | undefined
  orderType: OrderTypeEnum | string | null | undefined
  restingPrice: string | number | null | undefined
  repositionPrice: number | null | undefined
}

/**
 * Whether the resting remainder already sits at the price a reposition would
 * place it at. That is spec `103` §4.1's rule, applied to the remainder row.
 * A part-filled remainder is still resting for the rest of its size, so it
 * counts the same as an untouched one. Spec `111` §4.3.2.
 */
export function remainderKeepsResting(args: RestingRemainderInputs): boolean {
  if (args.orderStatus !== 'NEW' && args.orderStatus !== 'PARTIALLY_FILLED') {
    return false
  }
  return repositionKeepsRestingBaseEntry({
    orderStatus: 'NEW',
    orderType: args.orderType,
    restingPrice: args.restingPrice,
    // The remainder exists only on a LIMIT-entry bot (§4.1).
    startOrderType: OrderTypeEnum.limit,
    repositionPrice: args.repositionPrice,
  })
}
