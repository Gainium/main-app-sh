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

/** The fields of a spot balance row this decision reads. */
export type VenueBalanceLike = {
  asset: string
  free: number
  locked: number
}

/**
 * What the spot balance call came back with. `unavailable` is deliberately NOT
 * an empty list, for the same reason {@link VenuePositionProbe} gives.
 */
export type VenueBalanceProbe =
  | { kind: 'unavailable' }
  | { kind: 'balances'; balances: VenueBalanceLike[] }

/**
 * The spot half of the same question. Spec
 * `specs/047.a-standing-dust-refusal-is-still-silent-and-never-settles.md`
 * (issue #763), extending `005` past the futures-only gate it shipped with.
 *
 * Spot has no position endpoint — a deal's "position" is base sitting in the
 * account — so the reading is the account balance, and that balance is NOT
 * per-deal: other bots and the user's own trades share it. So this is
 * deliberately one-directional. It can prove a position GONE, never present:
 * the only thing an account-wide number can settle is that there is no close
 * order this account could build for this pair AT ALL, which is true exactly
 * when it holds less base than the pair's minimum order quantity. Whoever the
 * remaining units belong to, below that floor none of them are sellable.
 *
 * Anything above the floor vetoes, whether or not those units are this deal's.
 * Over-vetoing leaves a deal stuck, which is the bug; under-vetoing books a
 * deal closed while base it owns is still sitting there, which is worse.
 *
 * @param minTradeableQty the pair's minimum order quantity
 *   (`exchangeInfo.baseAsset.minAmount`). A missing or non-positive one never
 *   settles a deal — `0` would read every account as empty.
 */
export const reconcileSpotDealAgainstVenue = (
  probe: VenueBalanceProbe,
  baseAsset: string,
  minTradeableQty: number,
): PositionReconcileVerdict => {
  if (probe.kind === 'unavailable') {
    return { closeDeal: false, verdict: 'venue balance unknown' }
  }
  if (!Number.isFinite(minTradeableQty) || minTradeableQty <= 0) {
    return { closeDeal: false, verdict: 'pair minimum order size unknown' }
  }
  const row = probe.balances.find((b) => b.asset === baseAsset)
  // Locked counts: base reserved by a resting order is still held.
  const held = (Number(row?.free) || 0) + (Number(row?.locked) || 0)
  return held >= minTradeableQty
    ? {
        closeDeal: false,
        verdict: `account still holds ${held} ${baseAsset}`,
      }
    : {
        closeDeal: true,
        verdict:
          `account holds ${held} ${baseAsset}, under the ${minTradeableQty} ` +
          `minimum this pair can trade`,
      }
}

/**
 * What the user reads when a deal is settled because its position is gone.
 *
 * The deal has to be named: `Futures position` is `showUser: false`, so until
 * now nothing about this reached the user at all, and a deal that closes on its
 * own with no closing order is exactly the event a user needs an explanation
 * for rather than a silent status change.
 *
 * @param trigger what the deal was doing when the probe ran. Defaults to the
 *   `checkTPLevel` caller `005` was written for; spec `047` §4.4 asks the same
 *   question from a close the engine could not even build, where "reached its
 *   take profit" would not be true.
 */
export const dealPositionGoneMessage = ({
  dealId,
  symbol,
  exchange,
  trigger = 'reached its take profit',
}: {
  dealId: string
  symbol: string
  exchange: string
  trigger?: string
}): string =>
  `Deal ${dealId} (${symbol}) ${trigger}, but ${exchange} reports no open position for it — ` +
  `the position this deal was tracking is no longer on the exchange. ` +
  `The deal has been closed with the profit it had already realised, instead of being left open to retry a close that cannot succeed.`
