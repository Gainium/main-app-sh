import type { InitialGrid } from '../helper'

/**
 * Spec `176`. True when two levels of a ladder rounded onto the same price.
 *
 * A combo minigrid rebuilt after a fill frees one level at the fill price; a
 * second level at that price stays on the ladder as an order at the price that
 * just traded, and fills again with nothing on the other side to pay for it.
 */
export const hasCollapsedLevels = (levels: InitialGrid[]): boolean =>
  new Set(levels.map((l) => l.price.buy)).size < levels.length

/**
 * The most levels an arithmetic ladder over `[lowPrice, topPrice]` can have
 * whose prices, rounded to `precision` decimals, are all different: its
 * points round into at most `ceil(width / tick) + 1` distinct prices.
 */
export const maxDistinctLevels = (
  lowPrice: number,
  topPrice: number,
  precision: number,
): number => Math.max(1, Math.ceil((topPrice - lowPrice) * 10 ** precision))
