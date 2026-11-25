import type { Order } from '../../../types'
import { OrderSideEnum } from '../../../types'
import { observedFeeSplit } from '../orderFee'
import { observedFeeLegs } from '../feeLedger'
import { estimatedFeeRate } from '../placedOrderType'

/**
 * Spec `263`. Base a deal's own rows paid away in fees, read the way
 * `closeDeal` books `profit.pureBase` (its `feeBaseFull` loop): per executed
 * row, the base leg the venue REPORTED when it reported an on-pair fee; for a
 * row with no usable fee report, the account-rate estimate on an entry BUY
 * (the only side whose unreported fee is assumed to come out of base); nothing
 * for a third-asset fee on a `feeByAsset` deal.
 *
 * The close remainder sweep subtracts this from the ledger remainder, because
 * the ledger books every fill GROSS and a base fee the venue took is base the
 * account never received. It used to subtract `executedQty × taker` over every
 * entry BUY whatever the venue actually charged: on a deal whose fees were
 * paid in quote that deduction is coins that WERE received, and once reduce-
 * funds sells had taken the position down it was as large as the whole
 * remainder, so the sweep sold nothing and the close booked the coins as
 * `profit.pureBase`. Measuring both with one reading leaves the sweep and the
 * booking agreeing on what is still held.
 */
export function sweepBaseFeesPaid(
  orders: Partial<Order>[],
  fee: { maker?: number | null; taker?: number | null } | null | undefined,
  baseAsset?: string,
  quoteAsset?: string,
  feeByAssetGated = false,
): number {
  let base = 0
  for (const o of orders) {
    const executed = +(o.executedQty ?? 0)
    if (!Number.isFinite(executed) || executed <= 0) {
      continue
    }
    const observed = observedFeeSplit(o, baseAsset, quoteAsset)
    if (observed) {
      base += observed.base
      continue
    }
    if (
      feeByAssetGated &&
      observedFeeLegs(o, baseAsset, quoteAsset).length
    ) {
      continue
    }
    if (o.side === OrderSideEnum.buy) {
      base += executed * estimatedFeeRate(o, fee)
    }
  }
  return base
}
