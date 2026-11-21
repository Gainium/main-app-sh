/**
 * Whether a venue's answer to an order lookup would move the local row
 * BACKWARDS. Spec `250`.
 *
 * A venue's REST read can lag its own user stream: a grid exit the stream
 * reported FILLED came back PARTIALLY_FILLED a moment later. Copying that over
 * the row took the fill out of the deal's ledger, which counts only
 * FILLED / CANCELED rows.
 *
 * Deliberately narrow, so the lookup's forward corrections stay intact:
 * - A FILLED row is final: no other status replaces it.
 * - A non-FILLED row is kept only against a NON-terminal answer (NEW /
 *   PARTIALLY_FILLED) that reports less executed than the row holds. A
 *   CANCELED answer still ends the row (spec `235` §4.2), and a row written
 *   off as CANCELED can still be revived by a live answer.
 * - Any answer that moves the row up (FILLED, or more executed) is applied
 *   (spec `207`).
 *
 * `venueExecutedQty` is in the row's units and is 0 when the venue states none.
 */
export const venueAnswerRegressesRow = (
  local: { status?: string; executedQty?: string | number | null },
  venue: { status?: string; executedQty: number },
): boolean => {
  if (local.status === venue.status) {
    return false
  }
  if (local.status === 'FILLED') {
    return true
  }
  return (
    (venue.status === 'NEW' || venue.status === 'PARTIALLY_FILLED') &&
    +(local.executedQty ?? 0) > venue.executedQty
  )
}
