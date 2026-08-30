/**
 * Take-profits the venue calls `FILLED` but did not actually fill.
 *
 * The engine closes a deal when it sees a filled TP. That is correct only if
 * `FILLED` means "the whole order sold". On several venues it does not:
 * Kraken linear futures and Bitget answer a market close with
 * `status: FILLED` and an `executedQty` far below `origQty` — a 0.1065 BTC
 * take-profit coming back FILLED having sold 0.0023 — instead of reporting
 * `PARTIALLY_FILLED`.
 *
 * `processPartiallyFilledOrder` therefore never runs, no `tpHistory` entry is
 * written, and the deal is closed on the strength of the FILLED flag alone.
 * The unsold remainder stays on the venue as a position no bot tracks, with no
 * take profit and no stop loss, and its initial margin keeps consuming the
 * account until nothing is left to open new deals with — at which point every
 * base order is rejected `Not enough balance` and the bot silently loops
 * create-deal → rejected → cancel forever.
 *
 * The guard that used to cover this required `exchange === bybit`,
 * `type === LIMIT` and the order to already be in `tpHistory`. All three are
 * really proxies for "the venue sent us a PARTIALLY_FILLED event", which the
 * affected venues never do — so it could not fire for them. Over a 30-day
 * fleet sample there were 1,905 underfilled TPs across 65 users and 15
 * exchange/type combinations; that condition matched 6.
 */

import { TypeOrderEnum } from '../../../types'

/**
 * Relative shortfall below which a TP that sold slightly less than it asked
 * for is rounding dust rather than a partial fill.
 *
 * This is load-bearing in both directions. Too high and real remainders are
 * abandoned, which is the bug. Too low — or zero — and a venue that settles a
 * hair under the requested size holds the deal open forever, because the
 * remainder is too small to place a closing order for.
 *
 * The original 0.1% was set on the assumption that "real dust is orders of
 * magnitude under 0.1%". Measured on prod 2026-08-30 it is not: on the one
 * account that underfills steadily (bitget spot), 31 of 37 shortfalls in 24h
 * sat in 0.10–0.50%, median 0.196%, minimum exactly 0.100% — routine lot-size
 * rounding, landing right on the threshold. Had this guard been reachable it
 * would have held ~36 deals a day open on that account alone, for remainders
 * below the venue's own minimum order size, which is the wedge this constant
 * exists to prevent.
 *
 * 5% separates the two populations cleanly: measured dust topped out at 0.93%,
 * measured strandings are 50–98% short. Note the engine's own recovery
 * (`buyRemainder`) already re-places any remainder above the exchange minimum,
 * so dust below this threshold is handled there rather than abandoned.
 */
export const PARTIAL_TP_TOLERANCE = 0.05

/** The fields of an order this predicate reads. */
export type PartialTpOrder = {
  typeOrder?: string | null
  status?: string | null
  origQty?: string | number | null
  executedQty?: string | number | null
}

/**
 * How much of a `FILLED` take-profit was never sold, or `0` when the order is
 * not an underfilled TP and the deal may close on it.
 *
 * Note `executedQty`/`origQty` arrive as STRINGS. Comparing them directly is a
 * lexicographic trap — `'0.00000000' > '0'` is true — so both are coerced to
 * numbers and non-numeric input returns 0 rather than throwing.
 */
export function underfilledTpQty(order: PartialTpOrder): number {
  if (order.typeOrder !== TypeOrderEnum.dealTP || order.status !== 'FILLED') {
    return 0
  }
  const executed = Number(order.executedQty)
  const requested = Number(order.origQty)
  if (
    !Number.isFinite(executed) ||
    !Number.isFinite(requested) ||
    requested <= 0 ||
    executed < 0
  ) {
    return 0
  }
  const shortfall = requested - executed
  return shortfall > requested * PARTIAL_TP_TOLERANCE ? shortfall : 0
}
