import type { AccountFill } from '../../types'

/**
 * What the venue's own fill history says about one order we are about to
 * write off, or `null` when it holds no execution against it. Spec 270.
 *
 * Kraken Futures reports every account fill with the client order id WE sent,
 * so the sum of fills against that id is what actually executed — no
 * inference from positions or balances. Against the row's own size:
 *   - all of it executed            -> FILLED
 *   - some of it, and the venue no longer holds the order -> CANCELED with
 *     that much executed, the same answer the venue gives for a part-filled
 *     order it cancelled while its event is still on record.
 * Nothing executed is `null`: the order really was cancelled or rejected, and
 * the write-off stands. Pure.
 */
export const settleFromVenueFills = (
  row: { clientOrderId: string; origQty?: string | number },
  fills: AccountFill[],
): {
  status: 'FILLED' | 'CANCELED'
  executedQty: number
  quote: number
  lastFillAt: number
} | null => {
  let size = 0
  let quote = 0
  let lastFillAt = 0
  for (const f of fills) {
    if (!f || f.clientOrderId !== row.clientOrderId) continue
    const q = +f.quantity
    const p = +f.price
    if (!(q > 0) || !Number.isFinite(p)) continue
    size += q
    quote += q * p
    lastFillAt = Math.max(lastFillAt, +f.timestamp || 0)
  }
  // Summed floats: 5 + 8.0000000001 must still read as 13.
  size = +size.toFixed(10)
  if (!(size > 0)) return null
  const orig = +(row.origQty ?? 0)
  if (!(orig > 0)) {
    return { status: 'FILLED', executedQty: size, quote, lastFillAt }
  }
  const full = isFullFill(orig, size)
  return {
    status: full ? 'FILLED' : 'CANCELED',
    executedQty: full ? orig : size,
    quote: full ? (quote / size) * orig : quote,
    lastFillAt,
  }
}

/** Relative tolerance for "executed the whole size" across float sums. */
const fullFillTolerance = 1e-9

/** Did `executed` cover `orig`, allowing for summed-float noise? Pure. */
export const isFullFill = (orig: number, executed: number) =>
  executed >= orig * (1 - fullFillTolerance)

/**
 * A Kraken Futures FILLED answer that executed less than the order we sent.
 *
 * The connector answers an order that aged out of Kraken's events page from
 * the account fills alone, and those carry no order size, so it reports what
 * executed as FILLED. Kraken's own FILLED (live view or events) always covers
 * the order's quantity, so a FILLED short of the row's size can only be that
 * fills answer for an order the venue no longer holds — part-filled and then
 * cancelled. Stored as such, the cancel stays a cancel. Spec 270 §3.3. Pure.
 */
export const fillsAnswerIsPartialCancel = (
  answer: {
    status?: string
    executedQty?: string | number
    origQty?: string | number
  },
  rowOrigQty?: string | number,
) => {
  const orig = +(rowOrigQty ?? 0)
  const executed = +(answer.executedQty ?? 0)
  const answered = +(answer.origQty ?? 0)
  return (
    answer.status === 'FILLED' &&
    orig > 0 &&
    executed > 0 &&
    // The fills answer's own size IS what executed (it has no other); a
    // venue answer that carries a larger size of its own is left alone.
    answered > 0 &&
    isFullFill(executed, answered) &&
    isFullFill(answered, executed) &&
    !isFullFill(orig, executed)
  )
}

/** How many fill pages the write-off guard reads back, at most. */
export const writeOffFillPages = 5

/**
 * May the write-off go ahead when the fill history could not be read?
 * Only when Kraken refused the key outright (`authenticationError`, a key
 * without the query-trades permission): that refusal is permanent and would
 * otherwise keep the row unresolved forever. Any other failure is a blip and
 * the row is kept for the next pass. Pure.
 */
export const fillsRefusalIsPermanent = (reason?: string | null) =>
  /authenticationerror|eapi:invalid key|permission/i.test(`${reason ?? ''}`)
