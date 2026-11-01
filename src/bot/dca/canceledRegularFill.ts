import { DCADealStatusEnum, TypeOrderEnum } from '../../../types'
import { executedFillQty, type ExecutableOrderRow } from './executedFill'

/**
 * A safety order or an add-funds order (`dealRegular`) that ended CANCELED
 * with part of it executed. Spec `216`.
 *
 * The part that executed is a position the account holds. `processCanceledOrder`
 * used to return for every order that was not a base order or a take profit,
 * so when the venue (or the account owner on the venue) cancelled one of these
 * after a partial fill, the deal never booked the coins: its size, average and
 * take profit stayed on the earlier fills, and an add-funds entry stayed
 * pending for good.
 */
export type CanceledRegularFillRow = ExecutableOrderRow & {
  updateTime?: number | string | null
}

/**
 * The cancel-report rows `getAvgPrice` counts as an entry: a `dealRegular`
 * CANCELED with a dated, venue-backed partial fill — exactly what
 * {@link shouldBookCanceledRegularFill} books. Stateless on purpose, so the
 * average stays the same after a restart. Spec 216 §1.2.
 */
export const isDatedCanceledRegularFill = (o: CanceledRegularFillRow) =>
  o.typeOrder === TypeOrderEnum.dealRegular &&
  `${o.status}`.toUpperCase() === 'CANCELED' &&
  executedFillQty(o, false) > 0 &&
  Number(o.updateTime) > 0

/**
 * Does this cancel report book its executed part into the deal? Spec 216 §1.1,
 * §1.3.
 */
export const shouldBookCanceledRegularFill = (input: {
  order: CanceledRegularFillRow
  dealStatus: DCADealStatusEnum | string | null | undefined
  /** The bot asked the venue for this cancel (`isOwnCancel`). */
  ownCancel: boolean
  /** The order was already handled as a fill (`processedFilled`). */
  alreadyProcessed: boolean
}) => {
  const { order } = input
  if (!isDatedCanceledRegularFill(order)) {
    return false
  }
  // §1.3.1 — a fully executed order is the FILLED path's.
  const ordered = Number(order.origQty)
  if (Number.isFinite(ordered) && executedFillQty(order, false) >= ordered) {
    return false
  }
  // §1.3.3–§1.3.5
  if (input.ownCancel || input.alreadyProcessed) {
    return false
  }
  return input.dealStatus === DCADealStatusEnum.open
}
