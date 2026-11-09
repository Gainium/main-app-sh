/**
 * Ladder levels a DCA deal skipped. Spec `233`.
 *
 * A level is skipped when it was not resting while the market ran past it: the
 * venue refused it (balance, margin) or it was waiting as a smart order. When
 * it can be placed again, the gap path moves ONE level to the market and it
 * fills there, often far past the levels after it. The deal's last fill price
 * is then beyond those levels, and `createCurrentDealOrders` keeps only levels
 * on the far side of the last fill. So they are never placed again, by design:
 * buying them now would be a market order the user did not plan.
 *
 * Until spec 233 that left no trace. The deal showed fewer filled levels than
 * the user expected, with nothing resting and nothing saying why. This module
 * names those levels, so the engine can record them on the deal and the user
 * can execute one by hand. It decides nothing about placement.
 *
 * ## Which level a fill filled (position, not price)
 *
 * A fill identifies its level by, in order:
 * 1. `ladderLevel`, the level number stamped on the order when it was sent
 *    (spec 233; absent on older rows);
 * 2. its `origPrice` equal to a level's price in the CURRENT ladder (stored
 *    breakpoints applied, so a level moved to the market matches its moved
 *    price);
 * 3. failing both, the shallowest level not yet taken. That is the count rule
 *    the engine has always used (`ordersCount − filled`), so an old fill that
 *    matches nothing is booked where the engine itself books it.
 *
 * Price alone is not enough. A level that filled away from its price matches
 * no level, and a converging ladder can give two levels the same price.
 * Rule 3 can only hide a skipped level (it books a fill onto it), never invent
 * one, so the list can come out too short but never lists a filled level.
 */
import { TypeOrderEnum } from '../../../types'
import { isLadderOrder } from './ladderLevels'

/** One level of the deal's current ladder, as `createInitialDealOrders` builds it. */
export type LadderLevel = {
  levelNumber?: number
  price: number
  qty: number
  side: string
  type: TypeOrderEnum
}

/** The fields this module reads off an order row. */
export type MissedLevelOrderRow = {
  typeOrder?: TypeOrderEnum
  addFundsId?: string
  status: string
  side: string
  origPrice: string
  orderId?: string | number
  ladderLevel?: number
}

/** A skipped level, as recorded on the deal (`deal.missedLevels`). */
export type MissedLevel = {
  /** 1-based ladder level number. */
  level: number
  /** The level's price in the current ladder. */
  price: number
  /** The level's size in base, as the ladder sizes it at that price. */
  qty: number
}

const RESTING = new Set(['NEW', 'PARTIALLY_FILLED'])

/** A stored grid breakpoint: level `price` moved to `displacedPrice`. */
export type LadderBreakpoint = { price: number; displacedPrice: number }

/**
 * How close an order's price must be to a level's to name it, as a fraction of
 * the price. A pair's price precision can change after a deal opened, so a
 * rebuilt level may sit a tick or two from the price its order was sent at
 * (0.01725 sent, 0.017254 rebuilt). Exact matches are always tried first, and
 * the nearest free level wins.
 */
export const LEVEL_PRICE_TOLERANCE = 0.001

const near = (a: number, b: number) =>
  Number.isFinite(a) &&
  Number.isFinite(b) &&
  b > 0 &&
  Math.abs(a - b) / b <= LEVEL_PRICE_TOLERANCE

/**
 * The level numbers that a FILLED row has taken, and the ones a live order rests
 * on (or part-filled), for the ladder `levels`.
 *
 * `breakpoints` are the deal's stored ones. A level that filled away from its
 * price left a breakpoint {its price → the fill}; the build may or may not
 * apply it (spec 164 §1.3 ignores one beyond the ladder), so a row is matched
 * against both ends of any breakpoint it belongs to.
 */
export function resolveLadderLevels(
  levels: LadderLevel[],
  rows: MissedLevelOrderRow[],
  breakpoints: LadderBreakpoint[] = [],
): { filled: Set<number>; resting: Set<number> } {
  const ladder = levels
    .filter(
      (l) =>
        l.type === TypeOrderEnum.dealRegular &&
        typeof l.levelNumber === 'number',
    )
    .sort((a, b) => (a.levelNumber as number) - (b.levelNumber as number))
  const numbers = new Set(ladder.map((l) => l.levelNumber as number))
  const filled = new Set<number>()
  const resting = new Set<number>()
  const ladderRows = rows.filter(
    (r) =>
      isLadderOrder(r) &&
      (r.status === 'FILLED' ||
        // A resting row with no venue id is a write-off placeholder.
        (RESTING.has(r.status) && `${r.orderId}` !== '-1')),
  )
  const take = (r: MissedLevelOrderRow, n: number) => {
    if (r.status === 'FILLED') {
      filled.add(n)
    } else {
      resting.add(n)
    }
  }
  const taken = (n: number) => filled.has(n) || resting.has(n)
  const free = (r: MissedLevelOrderRow) =>
    ladder.filter((l) => l.side === r.side && !taken(l.levelNumber as number))
  // 1. The stamp, for every row first, so a stamped fill can never be beaten
  //    to its level by an unstamped row that happens to share the price.
  let open: MissedLevelOrderRow[] = []
  for (const r of ladderRows) {
    if (
      typeof r.ladderLevel === 'number' &&
      numbers.has(r.ladderLevel) &&
      !taken(r.ladderLevel)
    ) {
      take(r, r.ladderLevel)
    } else {
      open.push(r)
    }
  }
  // The prices a row can name: its own, and both ends of a breakpoint it is
  // one end of.
  const candidates = (r: MissedLevelOrderRow) => {
    const p = parseFloat(r.origPrice)
    const out = [p]
    for (const b of breakpoints) {
      if (near(p, b.price) || near(p, b.displacedPrice)) {
        out.push(b.price, b.displacedPrice)
      }
    }
    return out
  }
  // 2. An exact price, then 3. the nearest within the tolerance.
  for (const exact of [true, false]) {
    const next: MissedLevelOrderRow[] = []
    for (const r of open) {
      const prices = exact ? [parseFloat(r.origPrice)] : candidates(r)
      let best: LadderLevel | undefined
      let bestGap = Infinity
      for (const l of free(r)) {
        for (const p of prices) {
          const gap = Math.abs(l.price - p)
          if (exact ? gap === 0 : near(p, l.price) && gap < bestGap) {
            best = l
            bestGap = gap
          }
        }
        if (exact && best) {
          break
        }
      }
      if (best) {
        take(r, best.levelNumber as number)
      } else {
        next.push(r)
      }
    }
    open = next
  }
  // 4. The count rule for what is left: shallowest free level first.
  for (const r of open) {
    if (r.status !== 'FILLED') {
      continue
    }
    const first = free(r)[0]
    if (!first) {
      break
    }
    filled.add(first.levelNumber as number)
  }
  return { filled, resting }
}

/**
 * The deal's skipped levels: unfilled, not resting, and either on the near
 * side of the deal's last fill (`lastPrice`), where `createCurrentDealOrders`
 * never places them, or already recorded as skipped (`previous`). Sorted by
 * level number, priced and sized as the current ladder has them.
 *
 * A recorded level stays skipped until it fills. The last fill price moves
 * with every fill, including the user's own execution of a skipped level, and
 * a level must not drift back to the far side of it and be bought at the
 * market by the bot after all.
 *
 * A deal whose last fill is not a positive finite price adds no level.
 */
export function missedLadderLevels(
  levels: LadderLevel[],
  rows: MissedLevelOrderRow[],
  lastPrice: number,
  long: boolean,
  previous?: MissedLevel[] | null,
  breakpoints: LadderBreakpoint[] = [],
): MissedLevel[] {
  const known = new Set((previous ?? []).map((m) => m.level))
  const priced = Number.isFinite(lastPrice) && lastPrice > 0
  if (!priced && !known.size) {
    return []
  }
  const { filled, resting } = resolveLadderLevels(levels, rows, breakpoints)
  return levels
    .filter(
      (l) =>
        l.type === TypeOrderEnum.dealRegular &&
        typeof l.levelNumber === 'number' &&
        !filled.has(l.levelNumber) &&
        !resting.has(l.levelNumber) &&
        (known.has(l.levelNumber) ||
          (priced && (long ? l.price >= lastPrice : l.price <= lastPrice))),
    )
    .map((l) => ({
      level: l.levelNumber as number,
      price: l.price,
      qty: l.qty,
    }))
    .sort((a, b) => a.level - b.level)
}

/** Do two recorded lists name the same levels at the same prices and sizes? */
export function sameMissedLevels(
  a: MissedLevel[] | undefined | null,
  b: MissedLevel[] | undefined | null,
): boolean {
  const x = a ?? []
  const y = b ?? []
  return (
    x.length === y.length &&
    x.every(
      (m, i) =>
        m.level === y[i].level && m.price === y[i].price && m.qty === y[i].qty,
    )
  )
}
