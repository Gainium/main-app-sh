process.env.NODE_ENV = 'testing'

/**
 * Spec `222`: the carry rules on their own. The engine wiring is driven in
 * `comboShortCloseCarry.harness.spec.ts`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  carriedBase,
  setCarriedBase,
  carryAfterSkippedClose,
  carryAfterFilledClose,
} from './comboShortCloseCarry'

describe('combo SHORT close carry rules (spec 222)', () => {
  it('§4 an absent or foreign carry reads 0', () => {
    expect(carriedBase(undefined, 'A-USDC')).to.equal(0)
    expect(carriedBase([{ symbol: 'B-USDC', base: 3 }], 'A-USDC')).to.equal(0)
    expect(
      carriedBase([{ symbol: 'A-USDC', base: NaN as any }], 'A-USDC'),
    ).to.equal(0)
  })

  it('§4 set replaces one symbol and drops a zero entry', () => {
    const c = setCarriedBase([{ symbol: 'B-USDC', base: 1 }], 'A-USDC', 2)
    expect(carriedBase(c, 'A-USDC')).to.equal(2)
    expect(carriedBase(c, 'B-USDC')).to.equal(1)
    expect(setCarriedBase(c, 'A-USDC', 0)).to.deep.equal([
      { symbol: 'B-USDC', base: 1 },
    ])
  })

  it('§1.1 a skipped close adds its own shortfall, never a negative one', () => {
    expect(carryAfterSkippedClose(0, 5)).to.equal(5)
    expect(carryAfterSkippedClose(5, 7)).to.equal(12)
    expect(carryAfterSkippedClose(5, -3)).to.equal(5)
  })

  it('§1.3 a filled close repays what was carried into it, scaled by its fill', () => {
    expect(carryAfterFilledClose(10, 10, 1)).to.equal(0)
    // only part of the carry fitted in the order
    expect(carryAfterFilledClose(10, 4, 1)).to.equal(6)
    // half the order executed
    expect(carryAfterFilledClose(10, 10, 0.5)).to.equal(5)
    // nothing carried into the order: carry untouched
    expect(carryAfterFilledClose(10, 0, 1)).to.equal(10)
    // never negative, never NaN
    expect(carryAfterFilledClose(3, 4, 1)).to.equal(0)
    expect(carryAfterFilledClose(3, NaN, 1)).to.equal(3)
    expect(carryAfterFilledClose(3, 3, NaN)).to.equal(3)
  })
})
