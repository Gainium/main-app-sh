import { DCADealStatusEnum } from '../../../types'

/**
 * A deal whose entry order could never be built.
 *
 * `placeBaseOrder` writes the deal row first (`createDeal`, status `start`) and
 * only then builds the order that row exists to hold. `getBaseOrder` answers
 * `undefined` on every path where it cannot size or price that order — the
 * production case is a percentage-of-balance entry whose balance read the venue
 * refused outright ("Invalid API-key, IP, or permissions for action"), which it
 * reports through `handleErrors` and therefore returns `Promise<void>` from.
 *
 * The whole remainder of `placeBaseOrder` sits behind `if (baseOrder)`, so a
 * falsy answer skips everything and returns — leaving the row behind. That deal
 * holds no order document at all, yet counts against the bot's active-deal
 * limit, and the dashboard cannot close it because its deal actions require
 * status `open`. Nothing sweeps `start` deals, so it stays for good: the
 * once-per-bot-start replay in `restoreWork` re-enters the same silent return.
 *
 * Spec `specs/039…`. Sibling of `partialBaseEntry.ts` (spec `038`), which is the
 * same stranding reached with an order that DOES exist and stopped part-filled.
 */
export type UnbuiltBaseEntryInputs = {
  /** Whether `getBaseOrder` produced an entry order for this deal. */
  baseOrderBuilt: boolean
  /** The deal's own status, as the engine holds it. */
  dealStatus: DCADealStatusEnum | string | null | undefined
  /**
   * How many order rows the engine holds for this deal, in ANY status.
   *
   * Not "how many are live". `sendOrderToExchange` persists its row before any
   * short-circuit is consulted (spec `013`), so a single row of any status is
   * proof that an attempt got as far as the venue call and that this deal has a
   * history worth more than the slot it occupies. Zero rows is the only shape
   * this decision may act on.
   */
  orderCount: number
}

/**
 * Whether a deal should be retired because its entry order could not be built.
 *
 * Deliberately NOT consulted:
 *
 * - WHY the order could not be built. A dead API key, an unpriceable symbol and
 *   an exchange info read that came back empty all leave the same inert row, and
 *   `getBaseOrder` has already reported whichever it was on its way out.
 * - Whether this call created the deal or found it. The row is equally inert
 *   either way, and covering the found case is what heals the deals stranded
 *   before this shipped — `restoreWork` walks them on every bot start.
 */
export function shouldDiscardUnbuiltBaseEntry(
  args: UnbuiltBaseEntryInputs,
): boolean {
  const { baseOrderBuilt, dealStatus, orderCount } = args
  if (baseOrderBuilt) {
    return false
  }
  // Cancelling a deal that is open, or reviving a terminal one, would be far
  // worse than the stranding this fixes.
  if (dealStatus !== DCADealStatusEnum.start) {
    return false
  }
  return orderCount === 0
}
