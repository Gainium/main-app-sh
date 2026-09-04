import type { Order } from '../../types'

export type FeeLedgerEntry = { asset: string; total: number; totalUsd: number }

/**
 * Every fee leg this order reports, on-pair or not, each as its own
 * {asset, amount} — the raw legs `observedFeeSplit` either books (on-pair,
 * summed) or discards whole (any off-pair leg present). A superset of
 * `observedFeeSplit`: it sums these when every leg is on-pair, else returns
 * null. The fee ledger's job is the opposite one — a complete record of
 * every asset a fee was ever paid in, including the ones `observedFeeSplit`
 * has to discard.
 */
export function observedFeeLegs(
  order: Partial<Order>,
  baseAsset?: string,
  quoteAsset?: string,
): { asset: string; amount: number }[] {
  if (!order) {
    return []
  }
  const base = `${baseAsset ?? order.baseAsset ?? ''}`.toUpperCase()
  const quote = `${quoteAsset ?? order.quoteAsset ?? ''}`.toUpperCase()

  const rawLegs: { asset?: string; side?: 'base' | 'quote'; amount: number }[] =
    []
  if (order.feeBreakdown?.length) {
    for (const leg of order.feeBreakdown) {
      rawLegs.push({
        asset: `${leg?.asset ?? ''}`.toUpperCase(),
        amount: +leg?.amount,
      })
    }
  } else {
    const amount = +(order.feePaid ?? 0)
    if (!(amount > 0)) {
      return []
    }
    rawLegs.push({
      amount,
      side: order.feeSide,
      asset: `${order.feeAsset ?? ''}`.toUpperCase(),
    })
  }

  const legs: { asset: string; amount: number }[] = []
  for (const leg of rawLegs) {
    if (!Number.isFinite(leg.amount) || leg.amount <= 0) {
      continue
    }
    const asset =
      leg.side === 'base' ? base : leg.side === 'quote' ? quote : leg.asset
    if (!asset) {
      continue
    }
    legs.push({ asset, amount: leg.amount })
  }
  return legs
}

/**
 * Merge one {asset, amount, usdRate} contribution into a running per-asset
 * ledger — the `profitByAssets` find/filter/push shape
 * (`dcaHelper.ts:2356-2384`), generalized into a pure, independently
 * testable function.
 */
export function accrueFeeLedger(
  ledger: FeeLedgerEntry[] | undefined,
  asset: string,
  amount: number,
  usdRate: number,
): FeeLedgerEntry[] {
  const existing = (ledger ?? []).find((e) => e.asset === asset)
  const rest = (ledger ?? []).filter((e) => e.asset !== asset)
  return [
    ...rest,
    {
      asset,
      total: (existing?.total ?? 0) + amount,
      totalUsd: (existing?.totalUsd ?? 0) + amount * usdRate,
    },
  ]
}
