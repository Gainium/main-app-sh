/**
 * Client-order-id markers for "this is the variant attempt, not the original".
 *
 * Several take-profit paths resend the same logical order with a different
 * size, and mark the retry by rewriting the LAST TWO CHARACTERS of the client
 * order id so the two attempts are distinguishable in logs and on the venue
 * (`...ac`, `...fe`, `...ef`). Rewriting the tail rather than appending keeps
 * the id's length, which several venues cap.
 *
 * **Every marker must be hexadecimal.** On Hyperliquid the client order id is
 * not a free-form string: it IS the `cloid`, which
 * `MainBot.getOrderId` mints as `'0x' + randomBytes(16).toString('hex')` and
 * the connector forwards verbatim (`c: order.newClientOrderId as
 * \`0x${string}\``, exchange-connector `hyperliquid/index.ts`). Hyperliquid's
 * API deserializes the whole request body before it looks at anything, so ONE
 * non-hex character anywhere in the cloid makes it reject the entire request
 * with `422 unprocessable entity - failed to deserialize the json body into
 * the target type` — an opaque error that names no field, and under which the
 * take-profit is simply never placed.
 *
 * That is not hypothetical: the real-fee marker shipped as `rf`, and `r` is not
 * a hex digit, so a Hyperliquid spot DCA deal that took the real-fee branch
 * could not place its take-profit at all — while `ac` and `ef`, which happen to
 * be hex, worked the whole time. Probed directly against
 * `api.hyperliquid.xyz/exchange`: the identical payload answers `200` with a
 * signature error for a `...ab` cloid and `422` for a `...rf` one.
 *
 * So the marker alphabet is a real constraint, not a style preference, and
 * {@link ORDER_ID_MARKER} is the only place new ones should be added —
 * `orderIdMarker.spec.ts` asserts the invariant for every entry.
 */
export const ORDER_ID_MARKER = {
  /**
   * Adaptive close: the TP was refused for balance, so it is resent sized to
   * the free balance we just read (`dcaHelper` adaptive-close branch).
   */
  adaptiveClose: 'ac',
  /**
   * The real-fee-sized take-profit attempt — the fee gross-up zeroed because
   * this deal's fees were paid in a third asset (spec 015 §7.1). Was `rf`
   * until it turned out `r` is not a hex digit; see this file's header.
   */
  realFee: 'fe',
  /**
   * The estimated-fee resend that follows a rejected {@link realFee} attempt,
   * carrying the account-rate gross-up back (spec 015 §7.1).
   */
  estimatedFee: 'ef',
} as const

export type OrderIdMarker =
  (typeof ORDER_ID_MARKER)[keyof typeof ORDER_ID_MARKER]

/**
 * Rewrite the tail of `id` with `marker`, preserving the id's length (and so
 * the exact 34-character `0x` + 32-hex shape Hyperliquid requires).
 */
export const markOrderId = (id: string, marker: OrderIdMarker): string =>
  `${id.slice(0, Math.max(0, id.length - marker.length))}${marker}`
