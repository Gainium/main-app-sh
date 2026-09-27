import { OrderSideEnum, type Grid } from '../../../types'
import type { InitialGrid } from '../helper'

/** The minigrid level an order at `price` on `side` belongs to. */
export const levelOf = (
  levels: InitialGrid[],
  side: OrderSideEnum,
  price: number,
): InitialGrid | undefined => {
  const at = (l: InitialGrid) =>
    Math.abs((side === OrderSideEnum.buy ? l.price.buy : l.price.sell) - price)
  return levels.length
    ? levels.reduce((a, b) => (at(b) < at(a) ? b : a))
    : undefined
}

/**
 * Spec `116`. When a combo minigrid order fills, `updateMinigrid` rebuilds the
 * ladder with its one empty level at that fill. That rebuild means "the price
 * moved here": every resting order between the old empty level and this one
 * is taken to have filled, and its level turns to the other side.
 *
 * Within one venue burst the engine places counter-orders for some fills
 * before it has processed the others. An order placed after the fill being
 * processed was not on the book when that fill's price was traded. It did not
 * fill, so the rebuild must not treat it as filled. Each such order that the
 * rebuild would turn to the other side is one fill too many: one unit of base
 * too many for a buy fill (a SELL the account cannot fund), or one unit too
 * few for a sell fill (base left with no SELL).
 *
 * Returns the level the ladder's empty level belongs on instead: moved back
 * toward the old one by one level per such order. Returns `null` when the
 * rebuild counts no such order (the rebuild stands as it is), when the
 * rebuild's empty level cannot be identified, or when the move would empty a
 * whole side of the ladder.
 */
export const reanchorLevelAfterFill = ({
  rebuilt,
  levels,
  resting,
  side,
  filledAt,
}: {
  /** The ladder rebuilt at the processed fill. */
  rebuilt: Grid[]
  /** The minigrid's levels. */
  levels: InitialGrid[]
  /** The minigrid's live grid orders: side, limit price, placement time. */
  resting: { side: OrderSideEnum; price: number; placedAt?: number }[]
  /** Side of the processed fill. */
  side: OrderSideEnum
  /** Venue time of the processed fill. */
  filledAt: number
}): number | null => {
  if (!filledAt || !levels.length) {
    return null
  }
  const present = new Set(rebuilt.map((g) => g.number))
  const empty = levels.filter((l) => !present.has(l.number))
  if (empty.length !== 1) {
    return null
  }
  const notFilled = resting.filter((o) => {
    if (o.side !== side || !o.placedAt || o.placedAt <= filledAt) {
      return false
    }
    const level = levelOf(levels, o.side, o.price)
    const wanted = rebuilt.find((g) => g.number === level?.number)
    return !!wanted && wanted.side !== o.side
  }).length
  if (!notFilled) {
    return null
  }
  const numbers = levels.map((l) => l.number)
  const target =
    side === OrderSideEnum.buy
      ? empty[0].number + notFilled
      : empty[0].number - notFilled
  if (target <= Math.min(...numbers) || target >= Math.max(...numbers)) {
    return null
  }
  return target
}
