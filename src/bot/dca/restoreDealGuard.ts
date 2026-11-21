import { executedFillQty, type ExecutableOrderRow } from './executedFill'

/**
 * What a restore refused under spec `248` answers. Shown to the user as-is.
 */
export const RESTORE_NEVER_OPENED_REASON =
  'This deal never opened a position — nothing to restore'

export type RestoreGuardInputs = {
  /** Every order row the deal holds, in any status. */
  orders: ExecutableOrderRow[]
  avgPrice: number | string | null | undefined
  levelsComplete: number | string | null | undefined
}

/**
 * Does a canceled deal hold a position that Restore could bring back?
 * Spec `248` §4.1.
 *
 * The order rows decide. `executedFillQty` already answers 0 for the row that
 * never reached a venue (`CANCELED` + `orderId: '-1'`, spec `241`'s retired
 * refused entry) and keeps a real fill — a partial one, or a terminal import's
 * synthetic `FILLED` `'-1'` row — at what it executed.
 *
 * A deal with no order rows at all falls back to its own ledger, so a legacy
 * deal whose rows are gone is not locked out of a restore it used to allow.
 *
 * Pure, so the spec can pin it against the production row shapes.
 */
export function dealHoldsPosition(args: RestoreGuardInputs): boolean {
  const orders = args.orders ?? []
  if (orders.length > 0) {
    return orders.some((order) => executedFillQty(order) > 0)
  }
  return Number(args.avgPrice) > 0 && Number(args.levelsComplete) > 0
}
