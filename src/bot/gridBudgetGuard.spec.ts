process.env.NODE_ENV = 'testing'

/**
 * A grid budget too small to fund every level at the exchange's per-order
 * minimum must be refused, not silently scaled up to that minimum.
 *
 * This file covers the pure verdict: given the budget, the budget-derived size
 * of one level and the smallest size at which no level is raised to an exchange
 * minimum, decide whether to refuse and state the budget the grid really needs.
 *
 * Enforces specs/068 §4.1–§4.3, §4.5 (message).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  GRID_BUDGET_TOLERANCE,
  gridBudgetVerdict,
  gridLevelMinimum,
  gridBudgetRefusalMessage,
} from './gridBudgetGuard'
import { errorDict } from './utils'

describe('grid budget guard — the verdict (spec 068)', () => {
  describe('§4.1 minimum budget is linear in the level size', () => {
    it('refuses a budget far below the minimum and names the budget needed', () => {
      // Budget 5 over 175 levels wants ~0.0286 per level; the venue needs 5.
      const v = gridBudgetVerdict({ budget: 5, wanted: 5 / 175, minimum: 5 })
      expect(v.refuse).to.equal(true)
      if (v.refuse) {
        expect(v.minimumBudget).to.be.closeTo(875, 1e-6)
      }
    })

    it('allows a budget whose level size clears the minimum', () => {
      const v = gridBudgetVerdict({ budget: 1000, wanted: 5.71, minimum: 5 })
      expect(v.refuse).to.equal(false)
    })

    it('allows a budget exactly at the minimum', () => {
      const v = gridBudgetVerdict({ budget: 875, wanted: 5, minimum: 5 })
      expect(v.refuse).to.equal(false)
    })
  })

  describe('§1.3 / §4.1 tolerance', () => {
    it('is 10 %', () => {
      expect(GRID_BUDGET_TOLERANCE).to.equal(0.1)
    })

    it('allows a shortfall inside the tolerance (step rounding near the minimum)', () => {
      // minimumBudget = 100 × 5 / 4.6 ≈ 108.7 — within 10 %.
      const v = gridBudgetVerdict({ budget: 100, wanted: 4.6, minimum: 5 })
      expect(v.refuse).to.equal(false)
    })

    it('refuses a shortfall just outside the tolerance', () => {
      // minimumBudget = 100 × 5 / 4.5 ≈ 111.1 — over 10 %.
      const v = gridBudgetVerdict({ budget: 100, wanted: 4.5, minimum: 5 })
      expect(v.refuse).to.equal(true)
    })

    it('refuses the one-step-to-two-steps doubling on a coarse-step pair', () => {
      // Wanted 105 units on a 100-unit step where the minimum rounds up to 200.
      const v = gridBudgetVerdict({ budget: 50, wanted: 105, minimum: 200 })
      expect(v.refuse).to.equal(true)
    })
  })

  describe('§4.2 degenerate inputs', () => {
    for (const wanted of [0, -1, NaN, Infinity]) {
      it(`refuses when the level size is ${wanted} and a minimum exists`, () => {
        const v = gridBudgetVerdict({ budget: 5, wanted, minimum: 5 })
        expect(v.refuse).to.equal(true)
        if (v.refuse) {
          expect(v.minimumBudget).to.equal(null)
        }
      })
    }

    for (const budget of [0, -5, NaN]) {
      it(`refuses a budget of ${budget} when a minimum exists`, () => {
        const v = gridBudgetVerdict({ budget, wanted: 1, minimum: 5 })
        expect(v.refuse).to.equal(true)
      })
    }

    for (const minimum of [0, -1, NaN, Infinity]) {
      it(`fails open when the minimum is ${minimum} (exchange info unusable)`, () => {
        const v = gridBudgetVerdict({ budget: 5, wanted: 0.01, minimum })
        expect(v.refuse).to.equal(false)
      })
    }
  })

  describe('§4.3 the per-level minimum', () => {
    it('base-fixed: min notional at the LOWEST level price, rounded UP to the step', () => {
      // 5 / 0.03 = 166.67 → next multiple of the 100-unit step.
      const m = gridLevelMinimum({
        unit: 'base',
        minNotional: 5,
        minQty: 100,
        step: 100,
        lowestPrice: 0.03,
        highestPrice: 0.09,
      })
      expect(m).to.equal(200)
    })

    it('base-fixed: the minimum quantity wins when it is the larger', () => {
      const m = gridLevelMinimum({
        unit: 'base',
        minNotional: 1,
        minQty: 10,
        step: 0.1,
        lowestPrice: 2,
        highestPrice: 4,
      })
      expect(m).to.equal(10)
    })

    it('base-fixed: an exact multiple of the step is not pushed up a step', () => {
      const m = gridLevelMinimum({
        unit: 'base',
        minNotional: 5,
        minQty: 0.001,
        step: 0.001,
        lowestPrice: 100,
        highestPrice: 200,
      })
      expect(m).to.be.closeTo(0.05, 1e-12)
    })

    it('quote-fixed: min quantity at the HIGHEST level price when that exceeds the min notional', () => {
      const m = gridLevelMinimum({
        unit: 'quote',
        minNotional: 5,
        minQty: 100,
        step: 100,
        lowestPrice: 0.03,
        highestPrice: 0.09,
      })
      expect(m).to.be.closeTo(9, 1e-12)
    })

    it('quote-fixed: the min notional wins when it is the larger', () => {
      const m = gridLevelMinimum({
        unit: 'quote',
        minNotional: 5,
        minQty: 0.001,
        step: 0.001,
        lowestPrice: 100,
        highestPrice: 200,
      })
      expect(m).to.equal(5)
    })
  })

  describe('§4.5 the message names both budgets', () => {
    it('states the configured and the minimum budget, levels and pair', () => {
      const msg = gridBudgetRefusalMessage({
        budget: 5,
        minimumBudget: 875,
        asset: 'USDT',
        levels: 175,
        pair: 'ABC-USDT',
      })
      expect(msg).to.contain('Budget 5 USDT')
      expect(msg).to.contain('minimum 875 USDT')
      expect(msg).to.contain('175 levels')
      expect(msg).to.contain('ABC-USDT')
      expect(msg).to.contain('Bot will stop')
    })

    it('is not claimed by any text-matched error classification', () => {
      for (const minimumBudget of [875, null]) {
        const msg = gridBudgetRefusalMessage({
          budget: 5,
          minimumBudget,
          asset: 'USDT',
          levels: 175,
          pair: 'ABC-USDT',
        }).toLowerCase()
        const claimed = Object.keys(errorDict).filter(
          (k) => msg.indexOf(k.toLowerCase()) !== -1,
        )
        expect(claimed).to.deep.equal([])
      }
    })

    it('omits the figure when the minimum budget is unknown', () => {
      const msg = gridBudgetRefusalMessage({
        budget: 0,
        minimumBudget: null,
        asset: 'USDT',
        levels: 175,
        pair: 'ABC-USDT',
      })
      expect(msg).to.contain('too small')
      expect(msg).to.not.contain('null')
      expect(msg).to.contain('Bot will stop')
    })
  })
})
