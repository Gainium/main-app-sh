/**
 * Add / reduce funds on a Combo deal.
 *
 * A Combo deal is a ladder of rungs — the base order and each DCA level — and
 * every rung that has filled owns a minigrid that trades the base it bought.
 * Adding funds does not add a rung: it scales EVERY rung by one factor `k`.
 * Reducing funds is the same operation with `k < 1`.
 *
 * - The filled part (the position) is scaled with one aggregated MARKET order
 *   of `|k − 1| × positionBase`, and each live minigrid's budget by `k`, so
 *   its sell/buy lines grow or shrink with the position they trade.
 * - The unfilled DCA levels are scaled through the deal's per-level size
 *   offsets (`deal.sizes.fundsDca`), which the ladder builder adds to each level,
 *   so the resting limit AND the minigrid that level opens later scale too,
 *   and the change survives a reload.
 *
 * Everything here is plain arithmetic over plain numbers, so it can be pinned
 * without an engine. The engine side lives in `comboHelper.ts`.
 */
import { AddFundsTypeEnum, OrderSizeTypeEnum } from '../../../types'

export type ComboFundsDirection = 'add' | 'reduce'

/** One rung or grid line: a quantity in base at a price. */
export type ComboFundsLine = { qty: number; price: number }

export type ComboFundsScale =
  | { kind: 'scale'; k: number }
  /** A reduce that takes everything: the deal is closed instead. */
  | { kind: 'close' }
  | { kind: 'invalid'; reason: string }

const finitePositive = (n: number) => Number.isFinite(n) && n > 0

/**
 * The deal's position in base: what a long holds, what a short has sold.
 * Same reading as the Combo take-profit equation (`comboSolveParts`).
 */
export const comboPositionBase = (input: {
  isLong: boolean
  initialBalances: { base: number; quote: number }
  currentBalances: { base: number; quote: number }
}): number =>
  input.isLong
    ? input.currentBalances.base
    : input.initialBalances.base - input.currentBalances.base

/**
 * The scale factor a request asks for.
 *
 * - percent: `k = 1 ± qty / 100`.
 * - fixed in quote: the amount is the TOTAL commitment across the position
 *   (marked at `price`) and the unfilled levels (at their own prices):
 *   `k − 1 = F / (positionBase × price + Σ qty × price)`.
 * - fixed in base: `k − 1 = F / (positionBase + Σ qty)`.
 *
 * Any asset other than base is read as quote, as the DCA add funds does.
 */
export function comboFundsScale(input: {
  direction: ComboFundsDirection
  type?: AddFundsTypeEnum
  asset: OrderSizeTypeEnum | string
  qty: number
  price: number
  positionBase: number
  unfilled: ComboFundsLine[]
}): ComboFundsScale {
  const { direction, type, asset, qty, price, positionBase, unfilled } = input
  if (!finitePositive(qty)) {
    return { kind: 'invalid', reason: 'Funds amount must be a positive number' }
  }
  if (!finitePositive(positionBase)) {
    return { kind: 'invalid', reason: 'The deal holds no position to scale' }
  }
  let fraction: number
  if (type === AddFundsTypeEnum.perc) {
    fraction = qty / 100
  } else if (asset === OrderSizeTypeEnum.base) {
    fraction = qty / (positionBase + unfilled.reduce((a, l) => a + l.qty, 0))
  } else {
    if (!finitePositive(price)) {
      return { kind: 'invalid', reason: 'Cannot get price' }
    }
    fraction =
      qty /
      (positionBase * price + unfilled.reduce((a, l) => a + l.qty * l.price, 0))
  }
  if (!finitePositive(fraction)) {
    return { kind: 'invalid', reason: 'Funds amount must be a positive number' }
  }
  if (direction === 'add') {
    return { kind: 'scale', k: 1 + fraction }
  }
  const k = 1 - fraction
  return k <= 1e-9 ? { kind: 'close' } : { kind: 'scale', k }
}

/**
 * The scale a fill actually achieved. The order was sized `|k − 1| ×
 * positionBase`; a venue that fills less (or rounds the lot) scales the deal
 * by what it filled, so the grids never hold more or less base than the deal.
 */
export const comboFillScale = (
  direction: ComboFundsDirection,
  executed: number,
  positionBase: number,
): number => {
  if (!finitePositive(executed) || !finitePositive(positionBase)) {
    return 1
  }
  return direction === 'add'
    ? 1 + executed / positionBase
    : Math.max(0, 1 - executed / positionBase)
}

/**
 * The smallest `k` at which every line still meets the exchange minimum
 * (quantity and notional). `0` when there is nothing to check.
 */
export const comboMinimumScale = (input: {
  lines: ComboFundsLine[]
  minBase: number
  minQuote: number
}): number => {
  let kMin = 0
  for (const l of input.lines) {
    if (!finitePositive(l.qty)) {
      continue
    }
    if (finitePositive(input.minBase)) {
      kMin = Math.max(kMin, input.minBase / l.qty)
    }
    if (finitePositive(input.minQuote) && finitePositive(l.price)) {
      kMin = Math.max(kMin, input.minQuote / (l.qty * l.price))
    }
  }
  return kMin
}

/**
 * Whether scaling by `k` leaves a line below the exchange minimum. Only a
 * shrink can push a line under: an add never makes a line smaller.
 *
 * `maxReducePerc` is the largest reduction, in percent and rounded down to two
 * decimals, that would still pass — `0` when none would.
 */
export function comboFundsMinimumVerdict(input: {
  k: number
  lines: ComboFundsLine[]
  minBase: number
  minQuote: number
}): { refuse: false } | { refuse: true; maxReducePerc: number } {
  if (input.k >= 1) {
    return { refuse: false }
  }
  const kMin = comboMinimumScale(input)
  // Tolerance for the float noise of a k computed from a percentage.
  if (input.k + 1e-9 >= kMin) {
    return { refuse: false }
  }
  const max = Math.floor((1 - kMin) * 100 * 100 + 1e-6) / 100
  return { refuse: true, maxReducePerc: Math.max(0, max) }
}

export const comboFundsMinimumRefusalMessage = (
  requestedPerc: number,
  maxReducePerc: number,
): string =>
  maxReducePerc > 0
    ? `Reduce funds refused: after a ${+requestedPerc.toFixed(
        2,
      )}% reduction a grid line or safety order of this deal would be below the exchange minimum order size. The largest reduction possible now is ${maxReducePerc}%`
    : `Reduce funds refused: every grid line or safety order of this deal is already at the exchange minimum order size, so it cannot be reduced without closing it`

/**
 * The deal's per-level size offsets after scaling its unfilled levels by `k`.
 * `levels[].number` is the 1-based DCA level; `qty` its current quantity.
 * Offsets of filled levels are kept as they are.
 */
export function scaledDcaOffsets(
  current: number[] | undefined,
  levels: { number: number; qty: number }[],
  k: number,
): number[] {
  const out = [...(current ?? [])]
  for (const l of levels) {
    const i = l.number - 1
    if (i < 0 || !Number.isFinite(l.qty)) {
      continue
    }
    while (out.length <= i) {
      out.push(0)
    }
    out[i] = (out[i] ?? 0) + (k - 1) * l.qty
  }
  return out
}
