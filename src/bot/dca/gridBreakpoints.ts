/**
 * Bounds on a DCA deal's grid breakpoints. Spec `164`.
 *
 * A breakpoint `{price P, displacedPrice D}` moves ladder level `P` to `D`. It
 * is written when the market passed level `P` before that level was resting
 * (`createCurrentDealOrders`, `D` = market price) or when a level filled away
 * from its own price (`updateDeal`, `D` = fill price), and is applied on every
 * rebuild of the ladder.
 *
 * Nothing bounded either side. A one-second wick to ~1% of the price, during a
 * burst of fills, stored two levels at the wick price; every later rebuild put
 * them there and the "not behind the previous level" guard pushed each later
 * level a tick further, to zero, ending the ladder. Raising the level count
 * then placed two orders near zero and nothing else.
 */
import { TypeOrderEnum } from '../../../types'
import { isLadderOrder } from './ladderLevels'

/**
 * The deepest UNROUNDED level of a percentage ladder of `count` levels: the
 * same running sum `createInitialDealOrders` steps `percentageLevel` through
 * (`step × scale^(i-1)` of the start price per level), so the two agree to the
 * last bit.
 */
export function percentageLadderEnd(
  start: number,
  gridStep: number,
  stepScale: number,
  count: number,
  long: boolean,
): number {
  let level = start
  for (let i = 1; i <= count; i++) {
    level -= (long ? 1 : -1) * gridStep * stepScale ** (i - 1)
  }
  return level
}

/**
 * How far past its own deepest level a ladder still accepts a moved level, as
 * a fraction of the ladder's depth (start to deepest level).
 *
 * The deepest level is not a hard wall. When a ladder's step shrinks below one
 * price tick (a step scale under 1 over many levels), the build pushes each
 * later level a tick past the previous one, so the real ladder runs past its
 * closed-form depth, and every applied breakpoint restarts that chain from the
 * moved price. A hard wall at the closed form then discarded breakpoints of
 * levels that had really filled, the rebuilt ladder stopped matching the
 * deal's fills, and the smart orders stalled with nothing resting. The wall
 * exists for wicks far beyond the ladder (to ~1 % of the price), which a tenth
 * of the ladder's depth still refuses.
 */
export const LADDER_END_SLACK = 0.1

/**
 * The deepest price a level may be moved to: `ladderEnd` widened by
 * {@link LADDER_END_SLACK} of the depth from `start`. Returns `ladderEnd`
 * unchanged when either is not a positive finite number.
 */
export function toleratedLadderEnd(
  start: number,
  ladderEnd: number | undefined,
  long: boolean,
): number | undefined {
  if (
    ladderEnd === undefined ||
    !Number.isFinite(ladderEnd) ||
    !Number.isFinite(start) ||
    start <= 0
  ) {
    return ladderEnd
  }
  const depth = Math.abs(start - ladderEnd)
  return long
    ? ladderEnd - depth * LADDER_END_SLACK
    : ladderEnd + depth * LADDER_END_SLACK
}

/**
 * Can a level be moved to `displacedPrice`?
 *
 * Never to a price that is not a positive finite number. Never past
 * `ladderEnd`, the deepest level of the deal's own ladder: a market beyond the
 * deal's whole DCA coverage is not a place to rest ONE level, and resting it
 * there drags every later level after it. With no `ladderEnd` (a ladder whose
 * depth has no closed form) only the first rule applies.
 */
export function isDisplacementInLadder(
  displacedPrice: number,
  ladderEnd: number | undefined,
  long: boolean,
): boolean {
  if (!Number.isFinite(displacedPrice) || displacedPrice <= 0) {
    return false
  }
  if (ladderEnd === undefined || !Number.isFinite(ladderEnd)) {
    return true
  }
  return long ? displacedPrice >= ladderEnd : displacedPrice <= ladderEnd
}

/** The fields {@link isLevelFilled} reads off an order row. */
export type LevelOrderRow = {
  origPrice: string
  side: string
  typeOrder?: TypeOrderEnum
  addFundsId?: string
  status: string
}

/**
 * Has the ladder level at `price` already filled in full?
 *
 * The slice of "current" levels is `ordersCount − filled` levels, and in a
 * burst of fills processed interleaved the filled count lags. The slice can
 * then begin at a level that has just filled. That level is not resting, so
 * it was both re-sent and, with the market past it, given a breakpoint that
 * moved it to the market price, though it had been bought at its own.
 *
 * Only FILLED counts. A PARTIALLY_FILLED level is still resting and must stay
 * a current order, or the diff cancels it. Add-funds rows are not ladder levels
 * ({@link isLadderOrder}).
 */
export function isLevelFilled(
  level: { price: number; side: string },
  rows: LevelOrderRow[],
): boolean {
  return rows.some(
    (o) =>
      isLadderOrder(o) &&
      o.status === 'FILLED' &&
      o.side === level.side &&
      parseFloat(o.origPrice) === level.price,
  )
}
