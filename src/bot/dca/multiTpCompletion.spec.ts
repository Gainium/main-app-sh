process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the multi take-profit completion test.
 * Spec: `specs/009.multi-tp-targets-the-position-cannot-serve.md` (issue #658).
 *
 * Replays DCA deal `69f1b27faeba7a4880365abb` (bot `69de6e9e10716872ece23ce8`,
 * XAUTUSDT SHORT on `paperBitgetUsdm`, base order 0.02, five multi-TP targets of
 * 20 % each). The quantities below are the ones the real `getTPOrder` produces
 * for that shape — see `multiTpCompletion.harness.ts`, which drives the shipped
 * splitter rather than transcribing it:
 *
 *   configured targets 5 → orders emitted 2 (0.01 + 0.01 = the whole position)
 *   aggregate remaining after one fill  0.01
 *   aggregate remaining after two fills 0
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { shouldRearmTpTargets } from './multiTpCompletion'

describe('multiTpCompletion', () => {
  describe('§1.1 a deal with nothing left to close is finished', () => {
    it('closes the deal that armed 2 of 5 targets once both have filled', () => {
      // The defect: `total (5) > filled (2)` re-armed forever.
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 2,
          remainingQty: 0,
        }),
      ).to.equal(false)
    })

    it('closes on the last configured target too, as it always did', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 5,
          remainingQty: 0,
        }),
      ).to.equal(false)
    })
  })

  describe('§1.1 a deal that still holds a position keeps its targets armed', () => {
    it('re-arms after the first of the two servable targets fills', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 1,
          remainingQty: 0.01,
        }),
      ).to.equal(true)
    })

    it('re-arms the fifth target of a position wide enough to serve all five', () => {
      // 0.05 with a 0.01 step arms one order per target; after four fills the
      // last 0.01 is still open and must not be abandoned.
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 4,
          remainingQty: 0.01,
        }),
      ).to.equal(true)
    })

    it('re-arms a remainder below one target slice rather than abandoning it', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 1,
          remainingQty: 0.004,
        }),
      ).to.equal(true)
    })
  })

  describe('§3 an unknown remaining quantity is not an empty position', () => {
    it('re-arms when the quantity could not be determined', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 2,
          remainingQty: null,
        }),
      ).to.equal(true)
    })

    it('re-arms on a NaN rather than booking the deal closed', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 2,
          remainingQty: NaN,
        }),
      ).to.equal(true)
    })

    it('never re-arms once every configured target has filled, whatever the quantity says', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 5,
          filledTargets: 5,
          remainingQty: null,
        }),
      ).to.equal(false)
    })
  })

  describe('§1.2 the single-target and non-multi cases are untouched', () => {
    it('closes when there is no multi-TP configuration at all (total 0)', () => {
      expect(
        shouldRearmTpTargets({
          configuredTargets: 0,
          filledTargets: 1,
          remainingQty: 0.01,
        }),
      ).to.equal(false)
    })
  })
})
