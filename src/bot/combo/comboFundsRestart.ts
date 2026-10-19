/**
 * Main-app spec 047 §2.3.7: a restart in the middle of a Combo add / reduce
 * funds booking.
 *
 * A booking writes the deal (funds entry, `fundsScale`, scaled level offsets)
 * and its minigrids to the database, then cancels the deal's book and places
 * the scaled one. The Redis snapshots a cold restart prefers are written on a
 * delay, so a process stopped in that window restarts on a snapshot from
 * BEFORE the change: the old deal, the old minigrids and the old book. The
 * restart check then placed the old book again next to the half placed new
 * one — grid sells for more base than the deal held, safety orders at the old
 * size — and nothing ever corrected it.
 *
 * A change now writes `comboFundsRebuild` before its order is sent (before a
 * reduce takes the book down) and clears it once the rebuilt book is in the
 * snapshots. A restart loads any deal whose
 * stored copy is newer than its snapshot from the database (orders and
 * minigrids included) and finishes the change.
 */

type FundsRestartDeal = {
  comboFundsRebuild?: string | null
  fundsScale?: { id: string }[]
  pendingAddFunds?: { id: string }[]
  pendingReduceFunds?: { id: string }[]
}

type FundsRestartOrder = {
  status: string
  executedQty?: string
  addFundsId?: string
  reduceFundsId?: string
}

/**
 * Mongo conditions, ORed into the cold-restart deal read, for the stored
 * deals that may be newer than their snapshot: a change mid-rebuild, or an
 * order in flight.
 */
export const comboFundsRestartFilter = (): Record<string, unknown>[] => [
  { comboFundsRebuild: { $type: 'string' } },
  { 'pendingAddFunds.0': { $exists: true } },
  { 'pendingReduceFunds.0': { $exists: true } },
]

/**
 * Why the stored deal must be loaded instead of its snapshot, or `null`.
 * An order in flight always loads from the database: its fill may have been
 * recorded there (and only there) before the stop.
 */
export function comboFundsSnapshotStale(
  snapshot: FundsRestartDeal,
  stored: FundsRestartDeal,
): string | null {
  if (stored.comboFundsRebuild) {
    return `funds change ${stored.comboFundsRebuild} not finished`
  }
  const known = new Set((snapshot.fundsScale ?? []).map((f) => f.id))
  const newer = (stored.fundsScale ?? []).filter((f) => !known.has(f.id))
  if (newer.length) {
    return `funds change ${newer.map((f) => f.id).join(', ')} booked after the snapshot`
  }
  const pending = [
    ...(stored.pendingAddFunds ?? []),
    ...(stored.pendingReduceFunds ?? []),
  ]
  if (pending.length) {
    return `funds order ${pending.map((p) => p.id).join(', ')} in flight`
  }
  return null
}

/**
 * The funds changes of a deal a load finds already ended — its pending
 * entries and the change its `comboFundsRebuild` marks: an order that
 * executed anything is booked (`book`), one whose orders all ended with
 * nothing executed is dropped (`drop`). Changes already booked (in
 * `fundsScale`) are left alone, and so are orders still open: the venue check
 * settles those. `open` says whether the marked change still has an open
 * order.
 */
export function settledPendingFundsOrders<T extends FundsRestartOrder>(
  deal: FundsRestartDeal,
  orders: T[],
): { book: T[]; drop: T[]; open: boolean } {
  const booked = new Set((deal.fundsScale ?? []).map((f) => f.id))
  const ids = new Set([
    ...(deal.pendingAddFunds ?? []).map((p) => p.id),
    ...(deal.pendingReduceFunds ?? []).map((p) => p.id),
    ...(deal.comboFundsRebuild ? [deal.comboFundsRebuild] : []),
  ])
  const book: T[] = []
  const drop: T[] = []
  for (const id of ids) {
    if (booked.has(id)) {
      continue
    }
    const own = orders.filter(
      (o) => o.addFundsId === id || o.reduceFundsId === id,
    )
    const executed = own.find(
      (o) =>
        (o.status === 'FILLED' ||
          o.status === 'CANCELED' ||
          o.status === 'EXPIRED') &&
        +(o.executedQty ?? 0) > 0,
    )
    if (executed) {
      book.push(executed)
      continue
    }
    if (
      own.length &&
      own.every((o) => o.status === 'CANCELED' || o.status === 'EXPIRED')
    ) {
      drop.push(own[0])
    }
  }
  const marked = deal.comboFundsRebuild
  const open =
    !!marked &&
    orders.some(
      (o) =>
        (o.addFundsId === marked || o.reduceFundsId === marked) &&
        (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'),
    )
  return { book, drop, open }
}
