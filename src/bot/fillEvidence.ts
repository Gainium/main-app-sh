import type { CommonOrder, Order } from '../../types'

/**
 * Does a venue payload actually say anything about a fill?
 *
 * Spec `028.venue-filled-with-no-fill-evidence` (issue #719). A venue answer is
 * copied over our own order row wholesale, so the row ends up asserting
 * whatever the payload asserted — including a `FILLED` that the payload does
 * nothing to support. A venue has answered a reconcile lookup with
 *
 *     status FILLED   executedQty -   cummulativeQuoteQty -
 *     updateTime null fills []        price '0'
 *
 * for orders that were still resting on it. Each became a terminal `FILLED`
 * row, and a take-profit that did so then closed its deal on a quantity of
 * `parseFloat(undefined)` — the deal save is refused for the NaN it produces,
 * the cancel sweep on the way past is not, and what is left is a position that
 * is open with no live orders and no way back.
 *
 * The rule these two predicates express:
 *
 *   **What the venue did not state cannot overwrite what we know.** A stated
 *   zero is a statement and still wins; silence is not.
 *
 * Pure: no venue, no DB, no bot.
 */

/**
 * True when `value` is a number the venue actually stated — including `0`.
 *
 * `Number('')` is `0` and `Number(null)` is `0`, so both have to be rejected
 * before the coercion; `'NaN'` (which a poisoned row persists as a string) and
 * `Infinity` fail the finite test.
 */
export function statesQuantity(value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    return false
  }
  const n = Number(value)
  return Number.isFinite(n)
}

/** True when `value` states a NON-ZERO amount — i.e. evidence of a fill. */
function statesFill(value: unknown): boolean {
  if (!statesQuantity(value)) {
    return false
  }
  return Number(value) > 0
}

/**
 * True when a payload states no fill at all: no executed quantity, no executed
 * value, no fill timestamp and no fills.
 *
 * All four, deliberately. A venue that reports the executed value but not the
 * quantity, or a timestamp but neither, IS describing a fill and must keep
 * being believed exactly as before — only the payload that says nothing at all
 * is refused. That narrowness is the whole safety argument: an order the venue
 * really did fill can never be caught by this.
 */
export function isFillEvidenceFree(
  o: Partial<CommonOrder> | Partial<Order>,
): boolean {
  return (
    !statesFill(o.executedQty) &&
    !statesFill(o.cummulativeQuoteQty) &&
    !statesFill(o.updateTime) &&
    !o.fills?.length
  )
}
