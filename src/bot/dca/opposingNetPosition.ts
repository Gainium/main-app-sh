import { VenuePositionLike, VenuePositionProbe } from './positionReconcile'

/**
 * Spec 262 — a one-way futures account holds ONE net position per symbol.
 *
 * Two bots of opposite direction on the same account and symbol do not each
 * hold a position: the second one's entry only shrinks (or flips) the first
 * one's. Its reduce-only close is then refused by the venue as "would not
 * reduce position", which `isPositionAlreadyClosedReason` reads as "already
 * flat" — and the deal is booked closed with only its fees as profit while the
 * venue still holds a position the other bot's deals no longer match.
 *
 * Pure on purpose: what the venue answered and what that means are decided
 * here; the bot only does the round trip.
 */

export type NetSide = 'LONG' | 'SHORT'

/**
 * The side of the net position on `symbol`, or `null` when there is none.
 * The side derivation is the one `MainBot.loadData` uses at bot start
 * ("check positions"), so the two answers cannot drift.
 */
export const netPositionSide = (
  positions: readonly VenuePositionLike[] | null | undefined,
  symbol: string,
): NetSide | null => {
  const held = (positions ?? []).find(
    (p) => p.symbol === symbol && +p.positionAmt !== 0,
  )
  if (!held) {
    return null
  }
  return held.positionSide === 'BOTH' || !held.positionSide
    ? +held.positionAmt > 0
      ? 'LONG'
      : 'SHORT'
    : held.positionSide === 'LONG'
      ? 'LONG'
      : 'SHORT'
}

/**
 * Whether the venue's answer shows `symbol` held on the side OPPOSITE to
 * `side`. Anything short of that — no answer, a flat symbol, a position on
 * `side` itself — is `false`, which leaves the caller's existing behaviour in
 * place.
 */
export const heldAgainst = (
  probe: VenuePositionProbe,
  symbol: string,
  side: NetSide,
): NetSide | null => {
  if (probe.kind === 'unavailable') {
    return null
  }
  const net = netPositionSide(probe.positions, symbol)
  return net && net !== side ? net : null
}

/** Retry interval for an ASAP bot whose open was refused (spec 262 §4.3). */
export const OPPOSING_POSITION_RETRY_MS = 60_000

/** The refusal reported when a new deal would trade against the net position. */
export const opposingNewDealRefusal = (params: {
  symbol: string
  side: NetSide
  heldSide: NetSide
  holder?: { dealId: string; botName?: string } | null
}): string => {
  const { symbol, side, heldSide, holder } = params
  const base = `Not opening a ${side} deal on ${symbol}: this one-way futures account already holds a ${heldSide} position on it, and both share one net position on the exchange`
  if (holder) {
    const named = holder.botName ? ` "${holder.botName}"` : ''
    return `${base}. That ${heldSide} position belongs to open deal ${holder.dealId} on bot${named}. Close it first, or enable hedge mode on the exchange account.`
  }
  return `${base}. Close that position on the exchange first, or enable hedge mode on the exchange account.`
}

/** The refusal reported when a close is refused against an opposite position. */
export const closeHeldAgainstMessage = (params: {
  dealId: string
  symbol: string
  side: NetSide
  heldSide: NetSide
  reason: string
}): string => {
  const { dealId, symbol, side, heldSide, reason } = params
  return `Close of ${side} deal ${dealId} refused by the exchange (${reason}): the account's net position on ${symbol} is ${heldSide}, not flat, so the deal was not booked closed. On a one-way account opposite-direction bots share one net position; close the ${heldSide} side or settle this deal manually.`
}
