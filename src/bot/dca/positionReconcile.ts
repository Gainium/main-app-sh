/**
 * Is the deal still tracking a position the venue actually holds?
 *
 * Spec `specs/005.zombie-deal-venue-position-reconciliation.md` (issue #630).
 *
 * A multi-TP deal closes through `checkTPLevel`, which has no equivalent of the
 * "the position is already closed, book the deal closed" reconciliation that
 * `closeDealById` has had since the combo base-minigrid case
 * (`dcaHelper.ts:5993-6006`). So when a take-profit level is reached and the
 * close cannot be placed, the engine schedules another attempt and never asks
 * whether there is anything left to close. Deal `69f1b27faeba7a4880365abb` sat
 * `status: 'open'` from 2026-04-29 to 2026-09-04 that way — its paper position
 * had been CLOSED since the day it opened — re-arming roughly every 15 s, with
 * two sibling deals on the same bot in the same state.
 *
 * Pure on purpose, and for the same reason as `tpCloseOutcome`: the decision is
 * one piece of judgement — *absent* is not the same as *unknown* — reachable in
 * production only behind a live exchange round trip. The fail-safe direction
 * matters more than the happy path: booking a deal closed while the venue still
 * holds the position would abandon a live position with no take profit and no
 * stop loss, which is strictly worse than the bug being fixed.
 */

/** The fields of `PositionInfo` this decision reads. */
export type VenuePositionLike = {
  symbol: string
  positionAmt: string | number
  positionSide: string
}

/**
 * What `futures_getPositions` came back with. `unavailable` is deliberately
 * NOT an empty list: a venue that could not be reached and a venue that holds
 * nothing are the same array and opposite answers.
 */
export type VenuePositionProbe =
  | { kind: 'unavailable' }
  | { kind: 'positions'; positions: VenuePositionLike[] }

export type PositionReconcileVerdict = {
  /** Book the deal closed — there is nothing on the venue left to close. */
  closeDeal: boolean
  /** Short text for the log line; the venue's answer in one phrase. */
  verdict: string
}

/**
 * The position lookup `BotInstance.loadData` does at bot start
 * (`main.ts:3678-3690`), lifted verbatim so the two answers cannot drift.
 *
 * Note the side test applies only under `hedge`: one-way accounts hold a single
 * position per symbol, and a bot that reads it as the wrong side would decide a
 * position it owns is not there.
 */
export const findVenuePosition = (
  positions: VenuePositionLike[],
  symbol: string,
  requiredSide: 'LONG' | 'SHORT',
  hedge: boolean,
): VenuePositionLike | undefined =>
  positions.find(
    (p) =>
      p.symbol === symbol &&
      +p.positionAmt !== 0 &&
      (hedge
        ? requiredSide ===
          (p.positionSide === 'BOTH'
            ? +p.positionAmt > 0
              ? 'LONG'
              : 'SHORT'
            : p.positionSide)
        : true),
  )

/**
 * @param probe what the venue answered, or that it did not answer.
 */
export const reconcileDealAgainstVenue = (
  probe: VenuePositionProbe,
  symbol: string,
  requiredSide: 'LONG' | 'SHORT',
  hedge: boolean,
): PositionReconcileVerdict => {
  if (probe.kind === 'unavailable') {
    // No answer is not an answer. Fall through to whatever the caller would
    // have done without this check; the next probe may well succeed.
    return { closeDeal: false, verdict: 'venue position unknown' }
  }
  const held = findVenuePosition(probe.positions, symbol, requiredSide, hedge)
  return held
    ? {
        closeDeal: false,
        verdict: `venue still holds ${held.positionAmt} ${symbol}`,
      }
    : {
        closeDeal: true,
        verdict: `venue holds no ${symbol} position`,
      }
}

/**
 * What the user reads when a deal is settled because its position is gone.
 *
 * The deal has to be named: `Futures position` is `showUser: false`, so until
 * now nothing about this reached the user at all, and a deal that closes on its
 * own with no closing order is exactly the event a user needs an explanation
 * for rather than a silent status change.
 */
export const dealPositionGoneMessage = ({
  dealId,
  symbol,
  exchange,
}: {
  dealId: string
  symbol: string
  exchange: string
}): string =>
  `Deal ${dealId} (${symbol}) reached its take profit, but ${exchange} reports no open position for it — ` +
  `the position this deal was tracking is no longer on the exchange. ` +
  `The deal has been closed with the profit it had already realised, instead of being left open to retry a close that cannot succeed.`
