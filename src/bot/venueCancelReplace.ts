import { wasRestingWhenCanceled } from './combo/gridCancelRested'

/**
 * Placing back an order the venue cancelled while the engine still wants it.
 *
 * Venues cancel resting orders on their own: Bitget clears every resting order
 * on its stock tokens once a day, and the account owner can cancel orders on
 * the exchange. Each engine used to need its own handler for this. Grid levels
 * got one (spec 201), Combo grid levels another (spec 179) and take-profits a
 * third (spec 095), but safety orders on DCA and Combo bots had none. A venue
 * cancel of a safety order left the deal with no DCA order resting until a
 * fill or a restart happened to place it again. When the price ran through
 * the level in that window, the level was never bought.
 *
 * The decision of WHICH cancel reports to act on is the same for every
 * engine, so it lives in `MainBot` (`noteVenueCancel`). Each engine only
 * answers whether the level is still wanted, and places it
 * (`replaceVenueCanceled`). Spec 247.
 */

/**
 * Quiet time after the last venue cancel before the queued orders are placed
 * again. A cancel-all arrives as a burst, and it is placed back in one pass.
 */
export const VENUE_CANCEL_REPLACE_DELAY_MS = 2000

export type VenueCancelReport = {
  status?: string
  executedQty?: string | number | null
  transactTime?: number
  updateTime?: number
  clientOrderId?: string
}

/**
 * Is this cancel report one the venue (or the account owner) made to an
 * order that was resting, with nothing executed? Only those are placed again:
 * - the bot's own cancels are the engine's business (spec 095 ledger);
 * - an order refused as it was placed would be refused again (spec 179);
 * - a cancel that executed part of the order is booked as a fill instead;
 * - an EXPIRED order ran out on purpose (a time-in-force or timeout).
 */
export const isVenueCancelToReplace = (
  order: VenueCancelReport,
  ownCancel: boolean,
): boolean => {
  if (`${order.status}`.toUpperCase() !== 'CANCELED') {
    return false
  }
  if (ownCancel) {
    return false
  }
  const executed = Number(order.executedQty ?? 0)
  if (!Number.isFinite(executed) || executed > 0) {
    return false
  }
  return wasRestingWhenCanceled(order)
}

type LadderLevel = {
  type?: string
  side?: string
  price: number
  dcaLevel?: number
  hide?: boolean
}

type RestingRow = {
  typeOrder?: string
  side?: string
  origPrice?: string | number
  price?: string | number
  dcaLevel?: number
}

const samePrice = (a: number, b: number) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

/**
 * The safety-order level a venue-cancelled `dealRegular` order stood for, if
 * the deal still wants it resting. Matched by LEVEL (side, price and DCA
 * level), not by client order id: the deal's ladder is regenerated on every
 * fill with fresh ids. Nothing is returned when:
 * - the ladder no longer has that level (a fill moved it on, or the level
 *   filled in the meantime);
 * - an order for it is already resting (something else placed it back).
 * Spec 247.
 */
export const venueCanceledSafetyLevel = <L extends LadderLevel>(input: {
  order: {
    side?: string
    origPrice?: string | number
    price?: string | number
    dcaLevel?: number
  }
  /** The deal's `currentOrders`: the levels it wants resting now. */
  currentOrders: L[]
  /** The deal's orders still on the book (NEW / PARTIALLY_FILLED). */
  resting: RestingRow[]
  dealRegular: string
}): L | undefined => {
  const { order, dealRegular } = input
  const price = Number(order.origPrice) || Number(order.price)
  const side = `${order.side}`.toUpperCase()
  const sameLevel = (s?: string, p?: number, lvl?: number) =>
    `${s}`.toUpperCase() === side &&
    samePrice(Number(p), price) &&
    (order.dcaLevel === undefined ||
      lvl === undefined ||
      Number(lvl) === Number(order.dcaLevel))
  const level = input.currentOrders.find(
    (l) =>
      l.type === dealRegular &&
      !l.hide &&
      sameLevel(l.side, l.price, l.dcaLevel),
  )
  if (!level) {
    return undefined
  }
  const alreadyResting = input.resting.some(
    (r) =>
      r.typeOrder === dealRegular &&
      sameLevel(r.side, Number(r.origPrice) || Number(r.price), r.dcaLevel),
  )
  return alreadyResting ? undefined : level
}
