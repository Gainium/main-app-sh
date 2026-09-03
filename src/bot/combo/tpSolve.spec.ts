process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the Combo TP/SL equation.
 *
 * Origin: a combo perpetual held for months closed on a `tp` trigger with its
 * target set to 1.1% and reported a loss. The trigger was correct; the target
 * was not. `closeDeal` folds accrued funding into the realized profit the user
 * is shown, but the target ignored funding entirely — so on a deal held long
 * enough for funding to rival the target, the take profit aimed at a number
 * the deal could never report.
 *
 * Two properties are pinned here:
 *
 *  1. **Round-trip.** `comboPriceForTarget` and `comboPercentAtPrice` are one
 *     equation solved two ways. The engine already feeds the first into the
 *     second on every recalculation and warns when they disagree by >10%, but
 *     that check runs in production on live money. Before this file they were
 *     two hand-written copies of the algebra: a term added to one and missed
 *     in the other is invisible to the compiler and to review.
 *
 *  2. **Legacy equivalence.** With `funding: 0` both functions must reproduce
 *     the formulas exactly as they stood before funding was introduced. The
 *     originals are transcribed verbatim below. This is what makes the
 *     extraction out of `comboHelper` safe to believe: it separates "moved the
 *     code" from "changed the answer", and only the second is a behaviour
 *     change.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  comboPercentAtPrice,
  comboPnlAtPrice,
  comboPriceForTarget,
  type ComboTpSolveInput,
} from './tpSolve'

const closeTo = (actual: number, expected: number, eps = 1e-12) =>
  expect(Math.abs(actual - expected) < eps).to.equal(true)

// ---------------------------------------------------------------------------
// The pre-funding formulas, transcribed verbatim from `comboHelper` as they
// stood before this change. Do not "tidy" these — their value is being a
// frozen copy of the old behaviour.
// ---------------------------------------------------------------------------

function legacyPercent(i: ComboTpSolveInput, price: number): number {
  const longMult = i.isLong ? 1 : -1
  const qty = i.isLong
    ? i.currentBalances.base
    : i.initialBalances.base - i.currentBalances.base
  const quote =
    (i.isLong
      ? i.initialBalances.quote - i.currentBalances.quote
      : i.currentBalances.quote) + (i.profitBase ? 0 : i.profit * longMult)
  const quoteTp = qty * price
  const base = quote / price + (i.profitBase ? i.profit * longMult : 0)
  const total =
    i.profit +
    (i.profitBase ? qty - base : quoteTp - quote) * longMult -
    i.fullFee -
    (i.profitBase ? qty * i.fee : quoteTp * i.fee)
  return total / i.denominator
}

function legacyPrice(i: ComboTpSolveInput, target: number): number {
  const longMult = i.isLong ? 1 : -1
  const qty = i.isLong
    ? i.currentBalances.base
    : i.initialBalances.base - i.currentBalances.base
  const quote =
    (i.isLong
      ? i.initialBalances.quote - i.currentBalances.quote
      : i.currentBalances.quote) + (i.profitBase ? 0 : i.profit * longMult)
  if (i.profitBase) {
    return (
      quote /
      (qty -
        i.profit * longMult -
        (target * i.denominator - i.profit + i.fullFee + qty * i.fee) /
          longMult)
    )
  }
  return (
    (target * i.denominator + i.fullFee - i.profit + quote * longMult) /
    (qty * (longMult - i.fee))
  )
}

// ---------------------------------------------------------------------------

function deal(over: Partial<ComboTpSolveInput> = {}): ComboTpSolveInput {
  return {
    isLong: true,
    profitBase: false,
    initialBalances: { base: 0, quote: 15016.5774 },
    currentBalances: { base: 2.8, quote: 8772.4637 },
    profit: 1509.1853814074964,
    funding: 0,
    fullFee: 35.46483222150007,
    fee: 0.0002,
    denominator: 5005.5258,
    ...over,
  }
}

const TARGET = 0.011
const TARGET_LABEL = '1.1'

/**
 * A short measures its size as `initialBalances.base - currentBalances.base`,
 * the mirror of the long's `currentBalances.base`. Sold 2.8 into the position,
 * so it starts holding 2.8 and now holds none — the same 2.8 size the long
 * fixture uses, expressed the way the short branch reads it.
 */
const SHORT_BALANCES = {
  initialBalances: { base: 2.8, quote: 15016.5774 },
  currentBalances: { base: 0, quote: 8772.4637 },
}

describe('tpSolve', () => {
  describe('round-trip: solved price must land on the target', () => {
    for (const isLong of [true, false]) {
      for (const profitBase of [false, true]) {
        for (const funding of [0, -48.3325, 12.7]) {
          const label = `${isLong ? 'long ' : 'short'} profitBase=${profitBase ? 'Y' : 'N'} funding=${funding}`
          it(`${label} → price is finite and rounds back to ${TARGET_LABEL}%`, () => {
            const i = deal({
              isLong,
              profitBase,
              funding,
              ...(isLong ? {} : SHORT_BALANCES),
            })
            const price = comboPriceForTarget(i, TARGET)
            expect(price !== null && Number.isFinite(price)).to.equal(true)
            if (price !== null && Number.isFinite(price)) {
              closeTo(comboPercentAtPrice(i, price), TARGET)
            }
          })
        }
      }
    }
  })

  describe('equivalence with the pre-funding formulas (funding: 0)', () => {
    for (const isLong of [true, false]) {
      for (const profitBase of [false, true]) {
        const label = `${isLong ? 'long ' : 'short'} profitBase=${profitBase ? 'Y' : 'N'}`
        const i = deal({
          isLong,
          profitBase,
          funding: 0,
          ...(isLong ? {} : SHORT_BALANCES),
        })
        it(`${label} percent at 2262.74`, () => {
          closeTo(
            comboPercentAtPrice(i, 2262.7445371420145),
            legacyPercent(i, 2262.7445371420145),
          )
        })
        it(`${label} price for ${TARGET_LABEL}%`, () => {
          closeTo(
            comboPriceForTarget(i, TARGET) as number,
            legacyPrice(i, TARGET),
          )
        })
      }
    }
  })

  describe('funding moves the target in the right direction', () => {
    const flat = deal({ funding: 0 })
    const paid = deal({ funding: -48.3325 })
    const earned = deal({ funding: 12.7 })
    const pFlat = comboPriceForTarget(flat, TARGET) as number
    const pPaid = comboPriceForTarget(paid, TARGET) as number
    const pEarned = comboPriceForTarget(earned, TARGET) as number

    // A long that paid funding has to sell higher to clear the same target, by
    // exactly the funding spread over the position net of the exit fee.
    it('long: paying 48.3325 raises the required exit by funding / (qty · (1 − fee))', () => {
      closeTo(pPaid - pFlat, 48.3325 / (2.8 * (1 - 0.0002)), 1e-9)
    })
    it('long: earning funding lowers the required exit', () => {
      expect(pEarned < pFlat).to.equal(true)
    })
  })

  describe('the shape of deal that produced this fix', () => {
    // A deep-laddered deal that has been open long enough for funding to reach
    // the same order of magnitude as the target itself. This is the regime the
    // bug lived in: the target is a percentage of *usage*, so once a deal has
    // laddered in it is a small absolute number, while funding keeps accruing
    // for as long as the position is held.
    const flat = deal()
    const tp = comboPriceForTarget(flat, TARGET) as number

    it('target is a percentage of usage, not of price', () => {
      closeTo(TARGET * flat.denominator, 55.0607838, 1e-6)
    })
    const withFunding = deal({ funding: -48.3325 })
    it('funding here is most of the target', () => {
      expect(48.3325 > 0.75 * TARGET * flat.denominator).to.equal(true)
    })
    it('once funding counts, the old price no longer reaches the target', () => {
      expect(comboPercentAtPrice(withFunding, tp) < TARGET).to.equal(true)
    })
    it('and the shortfall is exactly the funding paid', () => {
      closeTo(
        comboPnlAtPrice(flat, tp) - comboPnlAtPrice(withFunding, tp),
        48.3325,
        1e-9,
      )
    })
  })

  describe('no usage means no level to place', () => {
    it('denominator 0 → null rather than Infinity', () => {
      expect(comboPriceForTarget(deal({ denominator: 0 }), TARGET)).to.equal(
        null,
      )
    })
  })
})
