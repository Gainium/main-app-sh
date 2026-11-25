/**
 * Closing-side orders a combo close sweep left unsettled. Spec `268`.
 *
 * Pure — no I/O. Quantities arrive as strings on order rows and are coerced.
 *
 * The deal ledger (`updateDealBalances`) counts only FILLED / CANCELED rows,
 * and a combo close is sized straight off that ledger. A closing-side grid
 * order the sweep could not finish (the venue's read answered
 * PARTIALLY_FILLED while its stream had not yet reported the fill) is in
 * neither: its base is still on the ledger, and the close sells it a second
 * time — out of the sibling deals sharing a one-way position.
 */

/** The fields of an order row these helpers read. */
export type CloseSettleRow = {
  dealId?: string | null
  side?: string | null
  status?: string | null
  executedQty?: string | number | null
}

/** Statuses of a row the venue may still be filling. */
const UNSETTLED = ['NEW', 'PARTIALLY_FILLED']

/**
 * Rows of `dealId` on the closing side (`SELL` for a long) that are still
 * resting after the close sweep — so whatever they executed is not in the
 * deal's ledger yet.
 */
export function unsettledClosingRows<T extends CloseSettleRow>(
  rows: T[],
  dealId: string,
  closingSide: 'BUY' | 'SELL',
): T[] {
  return rows.filter(
    (o) =>
      o.dealId === dealId &&
      o.side === closingSide &&
      UNSETTLED.includes(`${o.status}`),
  )
}

/** Base the venue reported executed on `rows` (non-numeric reads as 0). */
export function unsettledExecutedBase(rows: CloseSettleRow[]): number {
  return rows.reduce((acc, o) => {
    const x = Number(o.executedQty)
    return acc + (Number.isFinite(x) && x > 0 ? x : 0)
  }, 0)
}

/**
 * The close quantity net of what unsettled closing rows already executed:
 * never larger than `qty`, never below 0.
 */
export function closeQtyNetOfUnsettled(
  qty: number,
  rows: CloseSettleRow[],
): number {
  return Math.max(0, qty - unsettledExecutedBase(rows))
}
