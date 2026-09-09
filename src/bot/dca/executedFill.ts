/**
 * How much of an order row a venue actually executed.
 *
 * The deal balance ledger (`dcaHelper.updateDealBalances`, and the spec `024`
 * rebuild inside `closeDeal`) is a sum over the deal's order rows. Anything
 * that enters that sum is money the deal is treated as having moved, so a row
 * that traded nothing has to answer 0 — otherwise the ledger gains a base
 * position the deal does not hold, `closeDeal` marks it at `lastPrice`, and the
 * difference is booked as realised profit that never happened. Spec `029`.
 *
 * Two shapes had to be told apart from a real fill:
 *
 *  - **Never reached a venue.** A combo safety order is persisted when the deal
 *    opens, before any venue call, with `orderId: '-1'` (`main.ts`'s
 *    placeholder for "no exchange id"), `fills: []`, and `executedQty` already
 *    equal to `origQty`. Cancelling it leaves a CANCELED row that reads exactly
 *    like a fully filled one. Three of them put 24.923 base and -450.01 quote
 *    onto one deal's ledger, and the deal closed booking 95.13 against the 0.74
 *    its real fills support. The placeholder is decisive rather than a
 *    heuristic: across every CANCELED row in production carrying a non-zero
 *    `executedQty`, all 14,721 without a venue id have `executedQty === origQty`
 *    and none of the 392 genuine partial/full fills lacks one.
 *
 *  - **Reports zero, counted as its plan.** The old expression tested
 *    `executedQty` for truthiness *after* coercion, and `+'0'` is falsy, so a
 *    row explicitly saying it executed nothing fell through to `origQty` — the
 *    quantity it was planned for. A `FILLED` row with `executedQty: '0'` and
 *    `price: '0'` (spec `028`'s shape) therefore added its whole planned size
 *    to the base leg at no cost.
 *
 * The `origQty` fallback survives for its original case only: a row whose
 * `executedQty` cannot be read at all. It is never applied to the base order,
 * whose partial fills must not be guessed at — that is the AIOZ failure
 * `baseOrderQty.ts` was written for.
 *
 * Pure, so `executedFill.spec.ts` can pin it against the real production rows.
 */

/** The id `main.ts` writes when an order has no venue-side identifier. */
export const NO_EXCHANGE_ORDER_ID = '-1'

/** The subset of an order row this needs. Matches `Order` structurally. */
export type ExecutableOrderRow = {
  status?: string | null
  /** `Order.orderId` is venue-shaped: a uuid, a numeric id, or the placeholder. */
  orderId?: string | number | null
  executedQty?: string | number | null
  origQty?: string | number | null
  typeOrder?: string | null
}

const finite = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Gross quantity this row executed, in base units. Never NaN, never negative —
 * the caller applies the side.
 *
 * @param isBaseOrder the row opens the deal (`typeOrder === dealStart`), whose
 *   planned size is never a stand-in for what it filled.
 */
export function executedFillQty(
  order: ExecutableOrderRow,
  isBaseOrder = order?.typeOrder === 'dealStart',
): number {
  if (!order) return 0
  // §4.1 — a terminal row with no venue-side order never traded. Guarded on
  // CANCELED rather than "not FILLED" so a row still working (`NEW`,
  // `PARTIALLY_FILLED`) that has not had its id written back yet is untouched;
  // those are excluded from the ledger by status anyway.
  if (
    `${order.status}`.toUpperCase() === 'CANCELED' &&
    `${order.orderId}` === NO_EXCHANGE_ORDER_ID
  ) {
    return 0
  }
  // §4.2 — a readable executedQty is the answer, zero included.
  const executed = finite(order.executedQty)
  if (executed !== null) return Math.abs(executed)
  if (isBaseOrder) return 0
  return Math.abs(finite(order.origQty) ?? 0)
}
