/**
 * Where a DCA deal stands in its CONFIGURED ladder.
 *
 * A deal's `dealRegular` rows are not all ladder levels. `addDealFunds` builds
 * its order as `dealRegular` too — a point-in-time top-up the user asked for
 * OUTSIDE the ladder, which grows `levels.all` rather than spending one of the
 * bot's `ordersCount` slots. Counting those rows as ladder levels retires a
 * configured safety order per addition: spec `031`.
 *
 * Both answers below are one expression each, and both were inlined in methods
 * that also talk to the venue, so neither could be exercised without a stack.
 * Pure here so `ladderLevels.spec.ts` can pin them with no mocking.
 */
import { TypeOrderEnum } from '../../../types'

/** The two fields the ladder count reads off an order row. */
export type LadderOrderRow = {
  typeOrder?: TypeOrderEnum
  addFundsId?: string
}

/**
 * Is this row one of the bot's configured safety orders?
 *
 * Keyed on `addFundsId`, the same discriminator `main.ts` picks over
 * `typeOrder` for the quant-rules retry budget, and NOT on the `D-ROA`
 * client-order-id prefix: `getOrderId` strips the dashes on OKX, so an ordinary
 * `D-RO-A…` safety order arrives as `…DROA…` and a prefix test reads it as an
 * addition roughly once in sixty orders.
 */
export function isLadderOrder(order: LadderOrderRow): boolean {
  return order.typeOrder === TypeOrderEnum.dealRegular && !order.addFundsId
}

/** The `levels` counter and the add-funds ledger, as the deal doc holds them. */
export type LadderPosition = {
  levels: { complete: number }
  funds?: { price: number; qty: number }[] | null
}

/**
 * The 1-based number of the next safety order the deal has NOT consumed.
 *
 * `levels.complete` counts the base order as 1 and `createInitialDealOrders`
 * numbers safety orders from 1, so the next level IS `levels.complete` — but
 * only on a deal that has never taken add funds, because `updateDeal`'s
 * add-funds branch increments the same counter. `deal.funds` records exactly
 * those fills and is append-only (`reduceDealFunds` books a `dealTP` and never
 * touches it), so subtracting it back out restores the identity. Same
 * correction `getDealDCAByMarketToCheck` already applies to the same pair of
 * fields.
 */
export function nextLadderLevel(deal: LadderPosition): number {
  return deal.levels.complete - (deal.funds?.length ?? 0)
}
