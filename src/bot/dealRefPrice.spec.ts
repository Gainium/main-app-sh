process.env.NODE_ENV = 'testing'

/**
 * Checks for the deal reference price — the number every percentage exit on a
 * DCA/combo deal is measured from.
 *
 * Run: `npm test` (mocha).
 *
 * The property under test is narrow and load-bearing: a `settings.avgPrice` of
 * `0` must never reach a price calculation. It is not a smaller reference, it
 * is a missing one — `getTrailingSettings` turns it into `trailingTpPrice: 0`,
 * which `checkTrailing` reads as falsy, so trailing TP never arms and (because
 * `trailingTp` also suppresses the resting TP order) the deal is left with no
 * take profit at all. The same zero makes move SL's trigger `0`, which
 * `last >= required` satisfies on the first tick of a long deal.
 *
 * The second property is that the zero is never *persisted*: three deals on
 * prod reached exactly this state through the dashboard's mass deal-edit,
 * which seeds its form from the bot-form defaults (`avgPrice: 0`) and diffs
 * that against each selected deal's real average.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  dealRefPrice,
  isUsableRefPrice,
  withoutUnusableAvgPrice,
} from './dealRefPrice'

describe('dealRefPrice', () => {
  describe('isUsableRefPrice', () => {
    it('a real price is usable', () => {
      expect(isUsableRefPrice(68170.27)).to.equal(true)
    })
    it('zero is not usable', () => {
      expect(isUsableRefPrice(0)).to.equal(false)
    })
    it('undefined is not usable', () => {
      expect(isUsableRefPrice(undefined)).to.equal(false)
    })
    it('null is not usable', () => {
      expect(isUsableRefPrice(null)).to.equal(false)
    })
    it('a negative price is not usable', () => {
      expect(isUsableRefPrice(-1)).to.equal(false)
    })
    it('NaN is not usable', () => {
      expect(isUsableRefPrice(NaN)).to.equal(false)
    })
    it('Infinity is not usable', () => {
      expect(isUsableRefPrice(Infinity)).to.equal(false)
    })
  })

  describe('dealRefPrice', () => {
    // The regression: `settings.avgPrice ?? deal.avgPrice` returned 0 here.
    it('a zeroed override falls back to the computed average', () => {
      expect(dealRefPrice(0, 68170.27307581436)).to.equal(68170.27307581436)
    })
    it('an absent override falls back to the computed average', () => {
      expect(dealRefPrice(undefined, 2069.9362322890206)).to.equal(
        2069.9362322890206,
      )
    })
    it('a real override still wins over the computed average', () => {
      expect(dealRefPrice(70000, 68170.27307581436)).to.equal(70000)
    })
    // A deal that has genuinely not filled yet has nothing to fall back to; the
    // caller's own guards (`skipTp`, `isDealForMoveSl`) keep it out of the price
    // checks, so returning 0 here is the honest answer, not a hazard.
    it('nothing usable on either side stays 0', () => {
      expect(dealRefPrice(0, 0)).to.equal(0)
    })
  })

  describe('withoutUnusableAvgPrice', () => {
    // A stand-in for `Partial<Deal['settings']>`; the helper is generic over the
    // patch shape, so it needs a named type rather than a bare object literal.
    type Patch = { avgPrice?: number; tpPerc?: string }

    // The mass deal-edit payload: bot-form defaults diffed against a real deal.
    it('a zero avgPrice is dropped from the patch', () => {
      expect(
        withoutUnusableAvgPrice<Patch>({ avgPrice: 0, tpPerc: '20' }),
      ).to.deep.equal({ tpPerc: '20' })
    })
    it('a real avgPrice override is preserved', () => {
      expect(
        withoutUnusableAvgPrice<Patch>({ avgPrice: 70000, tpPerc: '20' }),
      ).to.deep.equal({ avgPrice: 70000, tpPerc: '20' })
    })
    it('a patch that never mentions avgPrice is untouched', () => {
      expect(withoutUnusableAvgPrice<Patch>({ tpPerc: '20' })).to.deep.equal({
        tpPerc: '20',
      })
    })
    it('an avgPrice-only patch of 0 becomes an empty patch', () => {
      expect(withoutUnusableAvgPrice<Patch>({ avgPrice: 0 })).to.deep.equal({})
    })
    // `updateDealSettings` returns early on an empty patch, so a mass edit that
    // changed nothing else cannot fall through into cancel-and-recreate.
    it('the emptied patch has no keys left for updateDealSettings to act on', () => {
      expect(
        Object.keys(withoutUnusableAvgPrice<Patch>({ avgPrice: 0 })).length,
      ).to.equal(0)
    })
  })
})
