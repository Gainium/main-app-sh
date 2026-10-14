import { ExchangeEnum } from '../../../types'
import { findVenuePosition, VenuePositionProbe } from './positionReconcile'

/**
 * Venues that refuse a reduce-only close under their minimum order value
 * unless it closes the whole position. Spec `163`.
 *
 * Hyperliquid perps: a reduce-only order under $10 fills when it closes the
 * whole position and is refused (`minTradeNtlRejected`) when it is only part
 * of it. Perps there are one-way, so two deals on the same account and pair
 * share one position.
 */
const WHOLE_POSITION_ONLY_BELOW_MINIMUM: ReadonlySet<string> = new Set([
  ExchangeEnum.hyperliquidLinear,
])

/** Whether a refused close on this venue can be a shared-position refusal at all. */
export const closesWholePositionOnlyBelowMinimum = (
  exchange: string | undefined,
): boolean => !!exchange && WHOLE_POSITION_ONLY_BELOW_MINIMUM.has(exchange)

export type SharedPositionCloseVerdict =
  | { shared: false }
  | { shared: true; venueQty: number }

/**
 * Whether a close the venue just refused as under its minimum order value is
 * only part of the position the venue holds, on a venue that accepts such a
 * close only for the whole position. Then no order closing just this deal can
 * be accepted, and asking again is pointless.
 *
 * Fail-safe in the same direction as `reconcileDealAgainstVenue`: anything
 * short of a venue answer showing a position larger than the close — no
 * answer, no position, a position no larger than the close — is `shared:
 * false`, which leaves the caller's existing behaviour in place.
 *
 * @param closeQty the quantity of the refused close, in base units.
 * @param qtyStep the pair's base step; a position larger than the close by
 *   less than half a step is the same position, rounded.
 */
export const isPartialCloseOfSharedPosition = (
  exchange: string | undefined,
  probe: VenuePositionProbe,
  symbol: string,
  side: 'LONG' | 'SHORT',
  hedge: boolean,
  closeQty: number,
  qtyStep: number,
): SharedPositionCloseVerdict => {
  if (!closesWholePositionOnlyBelowMinimum(exchange)) {
    return { shared: false }
  }
  if (probe.kind === 'unavailable') {
    return { shared: false }
  }
  if (!Number.isFinite(closeQty) || closeQty <= 0) {
    return { shared: false }
  }
  const held = findVenuePosition(probe.positions, symbol, side, hedge)
  const venueQty = Math.abs(Number(held?.positionAmt))
  if (!held || !Number.isFinite(venueQty)) {
    return { shared: false }
  }
  const tolerance =
    Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep / 2 : closeQty * 1e-9
  return venueQty - closeQty > tolerance
    ? { shared: true, venueQty }
    : { shared: false }
}
