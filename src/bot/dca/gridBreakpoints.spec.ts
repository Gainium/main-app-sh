process.env.NODE_ENV = 'testing'

/**
 * Spec `164` — the pure bounds on a DCA deal's grid breakpoints.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { TypeOrderEnum } from '../../../types'
import {
  isDisplacementInLadder,
  isLevelFilled,
  percentageLadderEnd,
} from './gridBreakpoints'

describe('spec 164 — grid breakpoint bounds', () => {
  it('§1.3 percentageLadderEnd walks the same running sum as the ladder', () => {
    // 35 × 1% of 0.315, scale 1: 0.315 − 35 × 0.00315.
    expect(percentageLadderEnd(0.315, 0.00315, 1, 35, true)).to.be.closeTo(
      0.20475,
      1e-12,
    )
    expect(percentageLadderEnd(0.315, 0.00315, 1, 35, false)).to.be.closeTo(
      0.42525,
      1e-12,
    )
    expect(percentageLadderEnd(1, 0.01, 2, 3, true)).to.be.closeTo(0.93, 1e-12)
  })

  it('§1.3 refuses a displacement that is not a positive finite price', () => {
    for (const p of [0, -0.1, NaN, Infinity]) {
      expect(isDisplacementInLadder(p, undefined, true), `${p}`).to.equal(false)
      expect(isDisplacementInLadder(p, 0.2, true), `${p}`).to.equal(false)
    }
  })

  it('§1.2/§1.3 refuses a displacement beyond the deepest level', () => {
    expect(isDisplacementInLadder(0.002, 0.205, true)).to.equal(false)
    expect(isDisplacementInLadder(0.5, 0.425, false)).to.equal(false)
  })

  it('§1.4 accepts a displacement inside the ladder, or with no known depth', () => {
    expect(isDisplacementInLadder(0.25, 0.205, true)).to.equal(true)
    expect(isDisplacementInLadder(0.205, 0.205, true)).to.equal(true)
    expect(isDisplacementInLadder(0.4, 0.425, false)).to.equal(true)
    expect(isDisplacementInLadder(0.002, undefined, true)).to.equal(true)
  })

  it('§1.1 isLevelFilled matches a FILLED ladder order at the level', () => {
    const row = (over: any) => ({
      origPrice: '0.258',
      side: 'BUY',
      typeOrder: TypeOrderEnum.dealRegular,
      status: 'FILLED',
      ...over,
    })
    const level = { price: 0.258, side: 'BUY' }
    expect(isLevelFilled(level, [row({})])).to.equal(true)
    // Still resting: dropping it from the current orders would cancel it.
    expect(
      isLevelFilled(level, [row({ status: 'PARTIALLY_FILLED' })]),
    ).to.equal(false)
    // An add-funds top-up is not a ladder level.
    expect(isLevelFilled(level, [row({ addFundsId: 'a' })])).to.equal(false)
    expect(isLevelFilled(level, [row({ status: 'NEW' })])).to.equal(false)
    expect(isLevelFilled(level, [row({ status: 'CANCELED' })])).to.equal(false)
    expect(isLevelFilled(level, [row({ origPrice: '0.255' })])).to.equal(false)
    expect(isLevelFilled(level, [row({ side: 'SELL' })])).to.equal(false)
    expect(
      isLevelFilled(level, [row({ typeOrder: TypeOrderEnum.dealTP })]),
    ).to.equal(false)
  })
})
