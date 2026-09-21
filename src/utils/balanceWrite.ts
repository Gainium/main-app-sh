/**
 * Pure helpers for writing a streamed balance item into the `balances`
 * collection (core spec 003 — Kraken spot balances).
 *
 * A producer may omit `locked`: Kraken spot v2 reports the total balance and
 * no hold figure (websocket-connector-sh ≥ 1.14.11). Writing `locked: 0` on
 * such an event would overstate "available" every time the stream ticks, and
 * the REST refresh that knows the real hold would be undone within seconds.
 * So an absent `locked` must leave the stored value untouched on update, and
 * only default to 0 when the row is being created.
 */

/** Negative or non-finite holds are reported by some venues; store 0. */
export const normalizeLocked = (locked: number): number =>
  Number.isFinite(locked) && locked > 0 ? locked : 0

export const hasLocked = (item: { locked?: string | null }): boolean =>
  item.locked !== undefined && item.locked !== null && `${item.locked}` !== ''

/** Fields to `$set` on an existing row: `locked` only when the event has it. */
export function lockedUpdateFields(item: {
  locked?: string | null
}): { locked?: number } {
  return hasLocked(item) ? { locked: normalizeLocked(parseFloat(`${item.locked}`)) } : {}
}

/** `locked` for a row being created: the event's figure, else 0. */
export function lockedInsertValue(item: { locked?: string | null }): number {
  return hasLocked(item) ? normalizeLocked(parseFloat(`${item.locked}`)) : 0
}

/**
 * `free` to store for a streamed balance item (core spec 069).
 *
 * An item with no `locked` comes from a venue whose stream reports only the
 * wallet TOTAL (Kraken spot v2) — the producer puts that total in `free`
 * because it has nothing better. Stored verbatim beside a real hold written
 * by the REST refresh, it double-counts the hold: `free + locked` exceeds the
 * wallet. So the hold we already know is taken out of it.
 *
 * The stored hold can be stale until the next REST refresh. Stale-high
 * understates what is spendable, which is the safe side; the floor at 0 keeps
 * a hold that outlived its order from producing a negative balance.
 */
export function streamedFree(
  item: { free: string; locked?: string | null },
  storedLocked: number | null | undefined,
): number {
  const reported = parseFloat(item.free)
  if (hasLocked(item) || !Number.isFinite(reported)) {
    return reported
  }
  const free = Math.max(0, reported - normalizeLocked(storedLocked ?? 0))
  // Trim binary subtraction residue; no venue quotes past 12 decimals here.
  return +free.toFixed(12)
}
