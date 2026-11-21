import { Grid, TypeOrderEnum } from '../../../types'

/**
 * Spec 255. Before spec 252, a venue lowering a pair's base precision made
 * `afterUpdateExchangeInfo` round each resting level's PRICE into its `qty`,
 * and the Redis `deals` snapshot kept the result. A level is treated as that
 * corruption only when both hold:
 *
 * - its quantity is its price rounded to some base precision (|qty - price|
 *   is at most half a whole unit), the only shape the defect wrote; and
 * - its value (qty × price) is more than `factor` times off the value the
 *   deal's own settings give the same level today.
 *
 * Either alone is not enough: a cheap pair can rest a healthy level whose
 * quantity happens to be near its price, and a balance-percentage ladder
 * re-derived later can drift far from what the deal opened with.
 */
export const RESTORED_LEVEL_FACTOR = 100

const isRegular = (g: Grid) => g.type === TypeOrderEnum.dealRegular

/** Cheap pre-check: could this level be the qty = price corruption at all? */
export const looksLikeQtyFromPrice = (g: Grid): boolean =>
  isRegular(g) &&
  Number.isFinite(g.qty) &&
  Number.isFinite(g.price) &&
  Math.abs(g.qty - g.price) <= 0.5

const levelOf = (g: Grid) => g.levelNumber ?? g.number

export type RestoredLadderRepair = {
  ladder: Grid[]
  /** The stored levels that were re-sized, as they were stored. */
  repaired: Grid[]
}

/**
 * Re-size the corrupted levels of a restored ladder from `fresh`, the ladder
 * the deal's settings build now. A corrupted level takes the fresh level's
 * quantity and keeps its stored price, so it still pairs with whatever rests
 * on the venue. A level with no fresh counterpart is left as stored. Every
 * other level is returned as the same object.
 */
export const repairRestoredDcaLadder = (
  stored: Grid[],
  fresh: Grid[],
  factor = RESTORED_LEVEL_FACTOR,
): RestoredLadderRepair => {
  const repaired: Grid[] = []
  const ladder = stored.map((g) => {
    if (!looksLikeQtyFromPrice(g)) {
      return g
    }
    const level = fresh.find(
      (f) => isRegular(f) && f.side === g.side && levelOf(f) === levelOf(g),
    )
    const freshValue = level ? level.qty * level.price : 0
    if (!level || !(freshValue > 0) || !Number.isFinite(freshValue)) {
      return g
    }
    const value = g.qty * g.price
    const off =
      value > 0 ? Math.max(value / freshValue, freshValue / value) : Infinity
    if (off <= factor) {
      return g
    }
    repaired.push(g)
    return { ...g, qty: level.qty }
  })
  return { ladder, repaired }
}
