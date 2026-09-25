/**
 * Which pending add-funds / reduce-funds entries a reload has to send again.
 * Spec `110`.
 *
 * `deal.pendingAddFunds` / `deal.pendingReduceFunds` list the user's limit
 * additions and reductions that have not filled yet. Each entry's `id` is the
 * `addFundsId` / `reduceFundsId` stamped on the order `addDealFunds` /
 * `reduceDealFunds` sent for it. A reload re-sends the entries so an order
 * that was cancelled (the user starting the bot, a deal settings update) is
 * placed again. It used to re-send EVERY entry: on a keep-orders reload the
 * original orders are still resting, so each one was placed a second time and
 * both copies could fill.
 *
 * An entry is left standing when an order carrying its id is still resting or
 * has already filled — neither order is missing, and the fill path removes the
 * entry once it fills. Everything else is re-sent.
 */

/** The order fields read here. */
export type PendingFundsOrderRow = {
  status: string
  addFundsId?: string
  reduceFundsId?: string
}

const STANDING_STATUSES = ['NEW', 'PARTIALLY_FILLED', 'FILLED']

export function splitPendingFunds<T extends { id: string }>(
  pending: T[],
  orders: PendingFundsOrderRow[],
  key: 'addFundsId' | 'reduceFundsId',
): { standing: T[]; resend: T[] } {
  const standingIds = new Set(
    orders
      .filter((o) => STANDING_STATUSES.includes(o.status) && o[key])
      .map((o) => o[key] as string),
  )
  return {
    standing: pending.filter((p) => standingIds.has(p.id)),
    resend: pending.filter((p) => !standingIds.has(p.id)),
  }
}
