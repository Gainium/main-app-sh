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
import {
  AddFundsTypeEnum,
  OrderSizeTypeEnum,
  TypeOrderEnum,
} from '../../../types'

export type ComboFundsDirection = 'add' | 'reduce'

/**
 * Is this order row an add / reduce funds order: by its funds id, or — a row
 * that reached memory without it — by the client order id only funds orders
 * get (`CMB-ROA` add, `D-TPR` reduce). It is never a grid or ladder level, so
 * a book rebuild must not cancel it: its cancel can come back FILLED and book
 * the fill from inside the rebuild, which holds the lock the booking waits for.
 */
export const isComboFundsOrderRow = (o: {
  typeOrder?: TypeOrderEnum
  clientOrderId?: string
  addFundsId?: string
  reduceFundsId?: string
}) =>
  !!o.addFundsId ||
  !!o.reduceFundsId ||
  (o.typeOrder === TypeOrderEnum.dealRegular &&
    `${o.clientOrderId ?? ''}`.includes('CMB-ROA')) ||
  (o.typeOrder === TypeOrderEnum.dealTP &&
    `${o.clientOrderId ?? ''}`.includes('D-TPR'))

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

/**
 * Split a scaling of the deal's DCA levels into the two offset arrays the
 * deal keeps:
 *
 * - `fundsDca` — levels that had NOT filled when the deal was scaled. Their
 *   extra size is new commitment: it counts in the deal's balances and usage.
 * - `fundsDcaHeld` — levels that HAD filled. The funds order already bought
 *   (or sold) their share for the position, and their minigrid was scaled, so
 *   the offset only resizes the level when it is placed again after its
 *   minigrid closes. Counting it in the balances or usage would count the
 *   same funds twice.
 *
 * `levels[].qty` is each level's current size, offsets included, so repeated
 * changes compound.
 */
export function splitScaledOffsets(
  current: { fundsDca?: number[]; fundsDcaHeld?: number[] },
  levels: { number: number; qty: number; filled: boolean }[],
  k: number,
): { fundsDca: number[]; fundsDcaHeld: number[] } {
  return {
    fundsDca: scaledDcaOffsets(
      current.fundsDca,
      levels.filter((l) => !l.filled),
      k,
    ),
    fundsDcaHeld: scaledDcaOffsets(
      current.fundsDcaHeld,
      levels.filter((l) => l.filled),
      k,
    ),
  }
}

/**
 * The part of the deal's ladder that is only a re-placement size (the held
 * offsets), in base and in quote at each level's price. Taken out of the
 * ladder's sums wherever they measure the deal's commitment.
 */
export function heldOffsetTotals(
  levels: { number?: number; price: number }[],
  held: number[] | undefined,
): { base: number; quote: number } {
  let base = 0
  let quote = 0
  if (!held?.length) {
    return { base, quote }
  }
  for (const l of levels) {
    const offset = l.number ? (held[l.number - 1] ?? 0) : 0
    if (!Number.isFinite(offset) || offset === 0) {
      continue
    }
    base += offset
    quote += offset * l.price
  }
  return { base, quote }
}

/**
 * A coin-margined order is a whole number of contracts of `contractValue`
 * quote each; the engine carries its size in base. A reduce rounds down so it
 * never sells more than asked; an add rounds to the nearest contract, as the
 * ladder does. `contracts < 1` is below the exchange minimum.
 */
export function comboContractSize(input: {
  qty: number
  price: number
  contractValue: number
  direction: ComboFundsDirection
}): { contracts: number; qty: number } {
  const { qty, price, contractValue, direction } = input
  if (!finitePositive(qty) || !finitePositive(price)) {
    return { contracts: 0, qty: 0 }
  }
  if (!finitePositive(contractValue)) {
    return { contracts: qty, qty }
  }
  const raw = (qty * price) / contractValue
  const contracts =
    direction === 'reduce' ? Math.floor(raw + 1e-9) : Math.round(raw)
  return { contracts, qty: (contracts * contractValue) / price }
}

/**
 * The scale changes a minigrid is missing: those of its deal booked after the
 * minigrid opened that it has not applied. A minigrid opened after a change
 * was sized from the already scaled level and needs none of it.
 */
export function minigridMissingScale(
  fundsScale: { id: string; k: number; time: number }[] | undefined,
  minigrid: { appliedFundsScale?: string[]; createTime?: number },
): { k: number; ids: string[] } {
  const applied = new Set(minigrid.appliedFundsScale ?? [])
  const created = Number(minigrid.createTime) || 0
  let k = 1
  const ids: string[] = []
  for (const f of fundsScale ?? []) {
    if (applied.has(f.id) || !(f.time > created) || !finitePositive(f.k)) {
      continue
    }
    k *= f.k
    ids.push(f.id)
  }
  return { k, ids }
}

const stepDecimals = (step: number) => {
  const s = `${step}`
  if (s.includes('e-')) {
    return +s.split('e-')[1]
  }
  return s.includes('.') ? s.split('.')[1].length : 0
}
const toStep = (n: number, step: number, mode: 'floor' | 'round') => {
  const units = n / step
  const whole = mode === 'floor' ? Math.floor(units + 1e-9) : Math.round(units)
  return +(whole * step).toFixed(stepDecimals(step))
}

/**
 * The exit lines (sells of a long, buy-backs of a short) of one minigrid after
 * a funds scale, refitted to the lot step so they sum to no more than the base
 * the minigrid holds after the scale (`target`, floored to the step).
 *
 * The ladder regenerated from the scaled budget rounds every line on its own,
 * so the lines did not sum back to the scaled holding: on a 0.1 lot, 57.2 ×
 * 0.7 came back as 40.1 + 40.0 + …, one lot over what the reduce left. Each
 * line is floored to the step and the remainder up to the target given to the
 * last line; lines never sum above the target and never above their own sum.
 */
export function fitExitLines(
  lines: number[],
  target: number,
  step: number,
): number[] {
  if (!finitePositive(step) || !lines.length) {
    return lines
  }
  const cap = Math.min(
    toStep(Math.max(target, 0), step, 'floor'),
    toStep(
      lines.reduce((a, l) => a + l, 0),
      step,
      'round',
    ),
  )
  const out = lines.map((l) => toStep(Math.max(l, 0), step, 'floor'))
  const total = out.reduce((a, l) => a + l, 0)
  const last = out.length - 1
  if (total < cap) {
    out[last] = toStep(out[last] + (cap - total), step, 'round')
    return out
  }
  return capExitLines([out], cap, step)[0]
}

/**
 * Take lots off the largest exit lines until all of them together are at most
 * `position` floored to the step — the deal-level bound: the resting exits of
 * a Combo deal never sell (or buy back) more than the deal holds. A minigrid
 * always keeps at least one lot of exit: one left with none had no ladder at
 * all until the next restart rebuilt it (§2.3.9). Lines taken to zero come
 * back as 0; the caller drops them.
 */
export function capExitLines(
  minigrids: number[][],
  position: number,
  step: number,
): number[][] {
  if (!finitePositive(step)) {
    return minigrids
  }
  const out = minigrids.map((m) => [...m])
  const cap = toStep(Math.max(position, 0), step, 'floor')
  let excess = toStep(
    out.flat().reduce((a, l) => a + l, 0) - cap,
    step,
    'round',
  )
  while (excess > 0) {
    let mi = -1
    let li = -1
    let room = 0
    for (let i = 0; i < out.length; i++) {
      const total = out[i].reduce((a, l) => a + l, 0)
      for (let j = 0; j < out[i].length; j++) {
        const line = out[i][j]
        // What this line can give without emptying its minigrid.
        const can = toStep(
          total - line > step / 2 ? line : line - step,
          step,
          'round',
        )
        if (can > room) {
          room = can
          mi = i
          li = j
        }
      }
    }
    if (mi < 0) {
      break
    }
    const take = Math.min(room, excess)
    out[mi][li] = toStep(out[mi][li] - take, step, 'round')
    excess = toStep(excess - take, step, 'round')
  }
  return out
}
