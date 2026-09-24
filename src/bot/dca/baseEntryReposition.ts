import { OrderStatusType, OrderTypeEnum } from '../../../types'

/** What the "is this reposition a no-op" decision reads. */
export type RestingBaseEntryInputs = {
  /** Status of the resting `dealStart` row, as the engine holds it. */
  orderStatus: OrderStatusType | string | null | undefined
  /** Type the resting row was sent as. */
  orderType: OrderTypeEnum | string | null | undefined
  /** Price the resting row was sent at. */
  restingPrice: string | number | null | undefined
  /** The bot's configured entry type. */
  startOrderType: OrderTypeEnum | string | null | undefined
  /**
   * What `getBaseOrder` would price a LIMIT entry at right now: the latest
   * price rounded to the pair's price precision.
   */
  repositionPrice: number | null | undefined
}

/**
 * Whether repositioning a resting LIMIT base order would re-place it at the
 * price it already rests at.
 *
 * Repositioning is cancel + re-place. On a pair whose price does not move,
 * that re-derives the same price every 10 s, so the order loses its place in
 * the queue and each tick costs two rate-limited private calls. Nothing
 * about the entry changes. Spec `103` §4.1.
 *
 * Only for a bot whose entry IS a LIMIT. A market-entry bot's resting LIMIT is
 * a substitution (the slippage ladder's last rung, or the limit-only fallback),
 * and re-placing it derives a MARKET order, not this price, so it is never a
 * no-op. An unreadable price (`0`, `NaN`) is not evidence that nothing moved.
 */
export function repositionKeepsRestingBaseEntry(
  args: RestingBaseEntryInputs,
): boolean {
  const { orderStatus, orderType, restingPrice, startOrderType } = args
  if (orderStatus !== 'NEW') {
    return false
  }
  if (
    orderType !== OrderTypeEnum.limit ||
    startOrderType !== OrderTypeEnum.limit
  ) {
    return false
  }
  const resting = Number(restingPrice)
  const next = Number(args.repositionPrice)
  if (!isFinite(resting) || !isFinite(next) || resting <= 0 || next <= 0) {
    return false
  }
  return resting === next
}

/** What the reposition-timer window rule reads. */
export type RepositionWindowInputs = {
  /** `0` = no enter-market timer for this bot (spec `100`). */
  enterMarketTimeout: number
  repositionTimeout: number
  /** When the deal's entry timing started. */
  startedAt: number
  now: number
}

/**
 * Whether another reposition tick still fits before the enter-market timer.
 * The enter-market check owns the order from then on. With no enter-market
 * timer there is no window, so the order is repositioned indefinitely.
 *
 * `placeBaseOrder` has always applied this rule inline. It lives here so the
 * keep path of spec `103` re-arms under the same rule and the two cannot
 * drift apart.
 */
export function repositionTickDue(args: RepositionWindowInputs): boolean {
  const { enterMarketTimeout, repositionTimeout, startedAt, now } = args
  return (
    enterMarketTimeout === 0 ||
    now + repositionTimeout < startedAt + enterMarketTimeout
  )
}
