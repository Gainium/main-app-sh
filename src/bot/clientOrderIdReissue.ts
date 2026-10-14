/**
 * Which client order id an order that is about to be (re-)sent should carry.
 * Spec `161`.
 *
 * A client order id names ONE order on the venue for good: Bybit refuses any
 * id it has already accepted (`Duplicate clientOrderId.`), whether that order
 * is still open, filled or cancelled. So an order the bot re-places after the
 * venue cancelled it needs an id the venue has never seen, and the ladder
 * level it belongs to has to remember which id is now its live one — otherwise
 * the next pass sends the spent id again.
 *
 * Pure: the caller hands in what it knows about each id.
 */

/** An order in this state will never trade again; its id is spent. */
export function isSpentStatus(status: string | undefined): boolean {
  return status === 'CANCELED' || status === 'EXPIRED'
}

export type LevelIdResolution =
  /** Send (or skip) under the level's own id; the usual checks decide. */
  | { action: 'keep' }
  /** The level was already re-sent under `id` and that order still counts. */
  | { action: 'adopt'; id: string }
  /**
   * Every id the level has carried is spent; send under a new one. `spent` is
   * the last of them, which must point at the new id as well.
   */
  | { action: 'mint'; spent: string }

/**
 * @param id the client order id the level carries
 * @param reissued spent id → the id its order was re-sent under
 * @param statusOf the status this bot holds for an id, `undefined` when it holds none
 */
export function resolveLevelClientOrderId(
  id: string,
  reissued: ReadonlyMap<string, string>,
  statusOf: (id: string) => string | undefined,
): LevelIdResolution {
  let current = id
  const seen = new Set<string>([id])
  while (reissued.has(current)) {
    const next = reissued.get(current) as string
    if (seen.has(next)) {
      break
    }
    seen.add(next)
    current = next
  }
  const status = statusOf(current)
  if (current !== id) {
    // A replacement this bot no longer holds was written off; nothing of the
    // level is live.
    return status === undefined || isSpentStatus(status)
      ? { action: 'mint', spent: current }
      : { action: 'adopt', id: current }
  }
  return isSpentStatus(status)
    ? { action: 'mint', spent: current }
    : { action: 'keep' }
}

/**
 * The ids a refused duplicate may be re-sent under, in order of preference:
 * the same id with its last character swapped. Same prefix and length, and
 * digits are valid in every id alphabet in use (hex for Hyperliquid). `2`
 * first, as it always was (spec 145 keeps `…2` → `…3`).
 */
export function siblingClientOrderIds(id: string): string[] {
  const stem = id.slice(0, -1)
  const last = id.slice(-1)
  return ['2', '3', '4', '5', '6', '7', '8', '9']
    .filter((c) => c !== last)
    .map((c) => `${stem}${c}`)
}
