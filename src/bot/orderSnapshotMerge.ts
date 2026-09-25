/**
 * The Redis `orders` snapshot is written through a debounce
 * (`setOrdersToRedis`), and the pending write dies with the process. Orders
 * placed in the last seconds before a restart are in Mongo but not in the
 * snapshot, and a cold restart that trusts the snapshot alone places them
 * again. Spec 108.
 *
 * Merges Mongo's open rows into the snapshot by `clientOrderId`. Order status
 * only moves forward (NEW → PARTIALLY_FILLED → terminal), so when both hold
 * the same order the more advanced status is the fresher row. A tie goes to
 * Mongo.
 */
const statusRank = (status?: string) =>
  status === 'NEW' ? 0 : status === 'PARTIALLY_FILLED' ? 1 : 2

export const mergeOpenOrdersIntoSnapshot = <
  T extends { clientOrderId: string; status?: string },
>(
  snapshot: T[],
  dbOpen: T[],
): { orders: T[]; added: number } => {
  const byId = new Map(snapshot.map((o) => [o.clientOrderId, o]))
  let added = 0
  for (const row of dbOpen) {
    const known = byId.get(row.clientOrderId)
    if (!known) {
      added++
      byId.set(row.clientOrderId, row)
    } else if (statusRank(row.status) >= statusRank(known.status)) {
      byId.set(row.clientOrderId, row)
    }
  }
  return { orders: [...byId.values()], added }
}
