import { Grid, TypeOrderEnum } from '../../../types'

/**
 * Spec 252. A Combo safety order (`dealRegular`) carries the budget its level
 * was sized from (`minigridBudget`: quote value, or contracts on coin-margined
 * futures). Its real size never strays far from it: the exchange-minimum and
 * minigrid-sum raises can lift it to about `gridLevel` × the budget, never
 * more, and nothing shrinks it below. A level outside
 * [budget / factor, budget × factor] was not sized by the engine at all — the
 * stored quantity is corrupt and must not be sent.
 *
 * `factor` is max(100, 10 × gridLevel), far above every legitimate raise.
 */
export const levelBudgetFactor = (gridLevel?: string | number) =>
  Math.max(100, 10 * Math.floor(+(gridLevel ?? '1') || 1))

export const isOutOfLevelBudget = (
  g: Grid,
  coinm: boolean,
  factor: number,
): boolean => {
  if (g.type !== TypeOrderEnum.dealRegular) {
    return false
  }
  const budget = g.minigridBudget ?? 0
  if (!(budget > 0) || !Number.isFinite(budget)) {
    return false
  }
  const value = coinm ? g.qty : g.qty * g.price
  if (!Number.isFinite(value) || value <= 0) {
    return true
  }
  return value > budget * factor || value < budget / factor
}
