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

const executed = (o: { executedQty?: string | number | null }) =>
  +(o.executedQty ?? 0) > 0

/**
 * Snapshot rows still held as a bare NEW (nothing executed) that Mongo's open
 * read did not return. Mongo either never got the row, or holds it in a state
 * the snapshot's lost write would have recorded. Spec 210.
 */
export const unconfirmedOpenSnapshotIds = <
  T extends {
    clientOrderId: string
    status?: string
    executedQty?: string | number | null
  },
>(
  snapshot: T[],
  dbOpen: { clientOrderId: string }[],
): string[] => {
  const open = new Set(dbOpen.map((o) => o.clientOrderId))
  return snapshot
    .filter(
      (o) => o.status === 'NEW' && !executed(o) && !open.has(o.clientOrderId),
    )
    .map((o) => o.clientOrderId)
}

/**
 * Drops snapshot rows Mongo holds as CANCELED / EXPIRED with nothing executed.
 *
 * The bot cancels a resting entry to re-price it and the cancel lands in
 * Mongo at once, but the snapshot only learns of it on its next delayed
 * write. A restart in between restored the cancelled entry as NEW, and the
 * restart check then refused to place the deal's entry because one was
 * "already active" — the deal sat in `start` with nothing on the venue. A
 * cold load from Mongo leaves such rows out, so this does the same. Rows
 * either side holds with a fill are kept exactly as before. Spec 210.
 */
export const dropOrdersEndedUnfilled = <
  T extends {
    clientOrderId: string
    status?: string
    executedQty?: string | number | null
  },
>(
  snapshot: T[],
  dbRows: {
    clientOrderId: string
    status?: string
    executedQty?: string | number | null
  }[],
): { orders: T[]; dropped: string[] } => {
  const ended = new Set(
    dbRows
      .filter(
        (r) =>
          (r.status === 'CANCELED' || r.status === 'EXPIRED') && !executed(r),
      )
      .map((r) => r.clientOrderId),
  )
  const dropped: string[] = []
  const orders = snapshot.filter((o) => {
    if (o.status === 'NEW' && !executed(o) && ended.has(o.clientOrderId)) {
      dropped.push(o.clientOrderId)
      return false
    }
    return true
  })
  return { orders, dropped }
}
