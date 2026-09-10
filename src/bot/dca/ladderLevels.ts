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
 *
 * ## Whether an addition spends a level is a property of the addition
 *
 * Neither answer is hard-wired to "add-funds never counts". `addFundsId` only
 * decides the DEFAULT; an explicit `consumesLadderLevel` on the order — and on
 * the `deal.funds` entry its fill writes — overrides it in either direction.
 * That is the seam a "replace the next available DCA level" opt-in needs (spec `031` §6): the
 * opted-in addition sets the flag and is counted, an ordinary one is not, and
 * neither has to be told apart by anything deeper in the engine.
 *
 * Nothing sets the flag today, and it is deliberately absent from the `Order`
 * type and the mongoose schema: persisting a field no writer produces would be
 * speculative. The opt-in that introduces it adds it in three places — the
 * order (`types.ts` + `src/db/schema.ts` in the consuming service), the
 * `deal.funds` entry `updateDeal` appends, and the call that builds the order —
 * and these two functions then need no change at all.
 */
import { TypeOrderEnum } from '../../../types'

/** The fields the ladder count reads off an order row. */
export type LadderOrderRow = {
  typeOrder?: TypeOrderEnum
  addFundsId?: string
  /**
   * Does this order spend one of the bot's configured levels? Overrides the
   * `addFundsId` default in both directions. Unset on every order today.
   */
  consumesLadderLevel?: boolean
}

/**
 * Is this row one of the bot's configured safety orders?
 *
 * The default is keyed on `addFundsId`, the same discriminator `main.ts` picks
 * over `typeOrder` for the quant-rules retry budget, and NOT on the `D-ROA`
 * client-order-id prefix: `getOrderId` strips the dashes on OKX, so an ordinary
 * `D-RO-A…` safety order arrives as `…DROA…` and a prefix test reads it as an
 * addition roughly once in sixty orders.
 *
 * `executeNextDcaLevel` relies on the default holding for a row that carries
 * neither field: it deliberately does not set `addFundsId`, precisely so that
 * the level it fills early is counted as spent.
 */
export function isLadderOrder(order: LadderOrderRow): boolean {
  if (order.typeOrder !== TypeOrderEnum.dealRegular) {
    return false
  }
  if (typeof order.consumesLadderLevel === 'boolean') {
    return order.consumesLadderLevel
  }
  return !order.addFundsId
}

/** One entry of `deal.funds` — an add-funds fill, as `updateDeal` records it. */
export type LadderFundsEntry = {
  price: number
  qty: number
  /** Mirrors the order's flag. Unset on every entry today; see the note above. */
  consumesLadderLevel?: boolean
}

/** The `levels` counter and the add-funds ledger, as the deal doc holds them. */
export type LadderPosition = {
  levels: { complete: number }
  funds?: LadderFundsEntry[] | null
}

/**
 * The 1-based number of the next safety order the deal has NOT consumed.
 *
 * `levels.complete` counts the base order as 1 and `createInitialDealOrders`
 * numbers safety orders from 1, so the next level IS `levels.complete` — but
 * only on a deal that has never taken add funds, because `updateDeal`'s
 * add-funds branch increments the same counter. `deal.funds` records exactly
 * those fills and is append-only (`reduceDealFunds` books a `dealTP` and never
 * touches it), so subtracting back out the ones that took no level restores the
 * identity. Same correction `getDealDCAByMarketToCheck` applies to the same
 * pair of fields, with the same override as {@link isLadderOrder}: an addition
 * flagged as consuming a level is left in the count, because it spent one.
 */
export function nextLadderLevel(deal: LadderPosition): number {
  const outsideLadder = (deal.funds ?? []).filter(
    (f) => f?.consumesLadderLevel !== true,
  ).length
  return deal.levels.complete - outsideLadder
}
