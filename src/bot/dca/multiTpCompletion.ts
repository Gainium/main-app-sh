/**
 * Is a multi take-profit deal finished?
 *
 * Spec `specs/009.multi-tp-targets-the-position-cannot-serve.md` (issue #658).
 *
 * `processFilledOrder` used to answer this by counting the targets the user
 * *configured*. The engine cannot always arm one order per configured target:
 * `getTPOrder`'s splitter rounds each target's slice **up** to the venue's
 * minimum order size, so on a position only a few steps wide the first targets
 * consume all of it and the rest are dropped. Five 20 % targets on a 0.02
 * XAUTUSDT position arm exactly two orders of 0.01. When both filled, the deal
 * held nothing and still waited for three more fills — deal
 * `69f1b27faeba7a4880365abb` did that from 2026-04-29 to 2026-09-04, re-arming
 * a take-profit every ~15 s against a position the venue had closed on day one.
 *
 * The number that settles it is the one the arming code already computes:
 * `getTPOrder` in `aggregate` mode returns the base quantity the deal still has
 * to close. Pure on purpose, and for the same reason as `positionReconcile`:
 * the decision is one piece of judgement whose two failure directions are not
 * symmetric.
 */

export type MultiTpRearmInput = {
  /** How many targets the bot's `multiTp` / `multiSl` settings declare. */
  configuredTargets: number
  /** How many distinct targets have filled, including the fill being handled. */
  filledTargets: number
  /**
   * Base quantity the deal still has to close, or `null` when it could not be
   * determined — an exchange-info or fee lookup that came back empty, not a
   * deal that holds nothing. The two must not be conflated: `0` finishes a
   * deal, and doing that on a failed lookup would book a deal closed while its
   * position is still live, leaving it with no take profit and no stop loss.
   */
  remainingQty: number | null
}

/**
 * `true` to re-arm the remaining take-profit targets, `false` to close the deal
 * on this fill.
 *
 * Both guards are load-bearing and neither subsumes the other. Dropping the
 * target count would close a deal on a fill that left targets armed and
 * quantity behind; dropping the quantity is the bug above. The fail-safe
 * direction is "re-arm": a deal held open one cycle too long is recoverable —
 * 005's venue reconciliation settles it — while a deal closed one cycle too
 * early abandons a live position on the venue.
 */
export const shouldRearmTpTargets = ({
  configuredTargets,
  filledTargets,
  remainingQty,
}: MultiTpRearmInput): boolean =>
  configuredTargets > filledTargets &&
  (remainingQty === null || !Number.isFinite(remainingQty) || remainingQty > 0)
