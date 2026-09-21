/**
 * Minimum-budget guard for grid bots.
 *
 * A grid divides its budget across its levels. When the budget is too small,
 * the budget-derived size of one level falls below the exchange's per-order
 * minimum, and the sizing routine (`MainBot.generateGridsOnPrice`) raises every
 * level to that minimum. The grid — and the start order that pre-funds one side
 * of it — is then sized from the exchange minimum instead of from the budget,
 * and commits a multiple of what the user configured. On futures the start
 * order's balance check divides by leverage, so the inflated order passes.
 *
 * The sizing routine keeps sizing exactly as it always has; it only records
 * what it wanted and what the minimum was ({@link GridSizingReport}). The
 * decision lives here, as plain functions over plain numbers, so it can be
 * tested without an engine: sizing is linear in the budget, so the budget a
 * grid really needs is `budget × minimum / wanted`.
 *
 * Fail-open on anything unknown about the exchange (no usable minimum): that is
 * exactly the behaviour before this module existed.
 */

/**
 * How far the needed budget may exceed the configured one before the start is
 * refused. Absorbs step rounding next to the minimum; small enough that the
 * bot's commitment stays within a tenth of what the user typed.
 */
export const GRID_BUDGET_TOLERANCE = 0.1

/** What the sizing routine wanted for one level, and the least it may be. */
export type GridSizingReport = {
  /** The unit `wanted` and `minimum` are expressed in. */
  unit: 'base' | 'quote'
  /** Budget-derived size of one level, before any exchange-minimum floor. */
  wanted: number
  /** Smallest level size at which no level is raised to an exchange minimum. */
  minimum: number
}

export type GridBudgetVerdict =
  | { refuse: false }
  | {
      refuse: true
      /** The budget this grid needs; `null` when it cannot be derived. */
      minimumBudget: number | null
    }

const usable = (n: number) => Number.isFinite(n) && n > 0

/**
 * The smallest size of one level at which no level of the grid is raised to an
 * exchange minimum.
 *
 * - fixed in base: every level has the same quantity, so the binding level is
 *   the LOWEST price (smallest notional). Rounded up to the quantity step.
 * - fixed in quote: every level has the same notional, so the binding level is
 *   the HIGHEST price (smallest quantity).
 */
export const gridLevelMinimum = (input: {
  unit: 'base' | 'quote'
  minNotional: number
  minQty: number
  step: number
  lowestPrice: number
  highestPrice: number
}): number => {
  const { unit, minNotional, minQty, step, lowestPrice, highestPrice } = input
  const notional = usable(minNotional) ? minNotional : 0
  const qty = usable(minQty) ? minQty : 0
  if (unit === 'quote') {
    return Math.max(notional, usable(highestPrice) ? qty * highestPrice : 0)
  }
  if (!usable(lowestPrice)) {
    return NaN
  }
  const raw = Math.max(qty, notional / lowestPrice)
  if (!usable(step)) {
    return raw
  }
  // The epsilon keeps an exact multiple (0.05 on a 0.001 step) from being
  // pushed up a step by binary noise in the division.
  const steps = Math.ceil(raw / step - 1e-9)
  return +(steps * step).toPrecision(15)
}

/** Spec 068 §4.1–§4.2. */
export const gridBudgetVerdict = (input: {
  budget: number
  wanted: number
  minimum: number
  tolerance?: number
}): GridBudgetVerdict => {
  const { budget, wanted, minimum } = input
  const tolerance = input.tolerance ?? GRID_BUDGET_TOLERANCE
  if (!usable(minimum)) {
    return { refuse: false }
  }
  if (!usable(budget) || !usable(wanted)) {
    return { refuse: true, minimumBudget: null }
  }
  const minimumBudget = (budget * minimum) / wanted
  return minimumBudget > budget * (1 + tolerance)
    ? { refuse: true, minimumBudget }
    : { refuse: false }
}

/** Rounded UP, so the figure shown is one the guard itself accepts. */
const formatUp = (n: number): string => {
  const decimals = n >= 1 ? 2 : 8
  const factor = Math.pow(10, decimals)
  return `${+(Math.ceil(n * factor - 1e-9) / factor).toFixed(decimals)}`
}

/**
 * The text must not contain any substring `errorDict` (`./utils`) matches on —
 * it stays unclassified on purpose: shown to the user, verbatim.
 */
export const gridBudgetRefusalMessage = (input: {
  budget: number
  minimumBudget: number | null
  asset: string
  levels: number
  pair: string
}): string => {
  const { budget, minimumBudget, asset, levels, pair } = input
  const advice =
    'Increase the budget or reduce the number of levels. Bot will stop'
  if (minimumBudget === null || !usable(minimumBudget)) {
    return `Budget ${budget} ${asset} is too small to place ${levels} levels on ${pair} at the exchange minimum order size. ${advice}`
  }
  return `Budget ${budget} ${asset} is below the minimum ${formatUp(
    minimumBudget,
  )} ${asset} needed to place ${levels} levels on ${pair} at the exchange minimum order size. ${advice}`
}
