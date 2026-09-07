/**
 * Fee inputs for TP/SL *pricing*.
 *
 * Fees enter `getTPOrder` twice and the two uses are NOT interchangeable:
 *
 *  - **Quantity.** Spot pays the fee out of the asset received, so the TP
 *    quantity must be shaved on a long (or grossed up on a short). Futures
 *    charge margin in quote and never touch the position, so the quantity leg
 *    deliberately zeroes the fee.
 *  - **Price.** Both venue types need the TP (and the percentage SL) pushed out
 *    far enough to cover the round trip, futures included. This leg must read
 *    the venue's real fee, never the quantity leg's zeroed one.
 *
 * These live here as pure functions so the invariant is pinned by
 * `tpFees.spec.ts` rather than by a comment. Deriving the price displacement
 * from the zeroed quantity fee silently drops fee compensation on every
 * futures TP/SL, which is what happened between v1.14.17 and this file
 * (see `tpFees.spec.ts` for both regression cases).
 */
import type { Order, UserFee } from '../../../types'
import { observedFeeLegs } from '../feeLedger'
import { observedFeeSplit } from '../orderFee'

type MaybeFee = Partial<UserFee> | null | undefined

/**
 * The worse of the two sides. A close can go out as either a maker or a taker
 * order (percentage SL and "close by market" are taker), and maker is not
 * always the cheaper side — promotional pricing can invert them — so neither
 * side may be assumed. Widened from `maker` for exactly that case.
 */
export function worstFee(fee: MaybeFee): number {
  return Math.max(fee?.maker ?? 0, fee?.taker ?? 0)
}

/**
 * Multiplier applied to an avg-entry-derived TP/SL price so the fill clears the
 * round trip: two legs at the worst fee, pushed away from entry for a long and
 * toward it for a short.
 *
 * `fee` must be the venue's real fee — see the file header.
 */
export function tpPriceDisplacement(fee: MaybeFee, long: boolean): number {
  return 1 + (long ? 1 : -1) * worstFee(fee) * 2
}

/**
 * Whether a deal's fees so far were ALL paid in a third asset — meaning
 * nothing base/quote-denominated has been taken out of the quantity, the
 * same precondition that already zeroes the fee for futures (see file
 * header). Only true once at least one fee has actually been observed;
 * a deal with no fills yet is not "all third-asset," it's "unknown."
 */
export function quantityFeeIsThirdAssetOnly(
  feeByAsset: { asset: string; total: number; totalUsd?: number }[] | undefined,
  commission: number,
  feePaid: { base?: number; quote?: number } | undefined,
): boolean {
  const hasThirdAssetFee = (feeByAsset?.length ?? 0) > 0
  const hasOnPairFee =
    commission > 0 || (feePaid?.base ?? 0) > 0 || (feePaid?.quote ?? 0) > 0
  return hasThirdAssetFee && !hasOnPairFee
}

/**
 * The same question as `quantityFeeIsThirdAssetOnly`, answered from every
 * order filled so far instead of the deal's persisted `feeByAsset`/
 * `commission`/`feePaid` fields.
 *
 * Those fields are only written when `closeDeal` runs (spec 014 §2.2) —
 * which happens when a TP fills, i.e. AFTER the TP this predicate is
 * gating has already been sized and sent. For a deal's first (and for a
 * non-multi-TP deal, only) TP, the persisted fields are always empty
 * regardless of what the base order actually paid — the zeroing this spec
 * exists for would never fire for the common case. This is the live
 * equivalent, evaluated directly against the orders instead.
 */
export function ordersFeeIsThirdAssetOnly(
  orders: Partial<Order>[],
  baseAsset?: string,
  quoteAsset?: string,
): boolean {
  let hasThirdAssetFee = false
  let hasOnPairFee = false
  for (const o of orders) {
    if (observedFeeSplit(o, baseAsset, quoteAsset)) {
      hasOnPairFee = true
      continue
    }
    if (observedFeeLegs(o, baseAsset, quoteAsset).length) {
      hasThirdAssetFee = true
    }
  }
  return hasThirdAssetFee && !hasOnPairFee
}
