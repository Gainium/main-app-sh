import { Grid, OrderSideEnum, TypeOrderEnum } from '../../types'

type RestingOrder = { side: string; price: string | number; typeOrder?: string }

const sideOf = (side: string) =>
  side === 'BUY' || side === OrderSideEnum.buy
    ? OrderSideEnum.buy
    : OrderSideEnum.sell

/**
 * The restart reconcile's last word on how many safety orders a deal may
 * hold. Spec 107.
 *
 * The rebuilt ladder is the engine's own statement of how many `dealRegular`
 * orders should rest on each side right now (remaining levels, capped by the
 * active-orders setting). Whatever the level pairing before it decided, the
 * reconcile must never leave MORE than that resting: resting + placed <=
 * ladder, per side. When `toPlace` would break it, the excess is dropped —
 * the candidates priced closest to an order already resting, because a level
 * one tick from a resting order is that order, re-derived.
 *
 * Only `dealRegular` is capped; every other type passes through untouched.
 */
export const capLadderPlacements = (
  ladder: Grid[],
  resting: RestingOrder[],
  toPlace: Grid[],
): { place: Grid[]; dropped: Grid[] } => {
  const dropped = new Set<Grid>()
  for (const side of [OrderSideEnum.buy, OrderSideEnum.sell]) {
    const expected = ladder.filter(
      (g) => g.type === TypeOrderEnum.dealRegular && g.side === side,
    ).length
    const restingPrices = resting
      .filter(
        (o) =>
          (!o.typeOrder || o.typeOrder === TypeOrderEnum.dealRegular) &&
          sideOf(o.side) === side,
      )
      .map((o) => +o.price)
    const candidates = toPlace.filter(
      (g) => g.type === TypeOrderEnum.dealRegular && g.side === side,
    )
    const excess = restingPrices.length + candidates.length - expected
    if (excess <= 0 || !candidates.length) {
      continue
    }
    const distance = (g: Grid) =>
      restingPrices.length
        ? Math.min(...restingPrices.map((p) => Math.abs(p - g.price)))
        : Infinity
    ;[...candidates]
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, excess)
      .forEach((g) => dropped.add(g))
  }
  return {
    place: toPlace.filter((g) => !dropped.has(g)),
    dropped: toPlace.filter((g) => dropped.has(g)),
  }
}
