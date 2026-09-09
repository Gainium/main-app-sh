process.env.NODE_ENV = 'testing'

/**
 * A combo close may sweep the fee-order remainder, but only if the deal
 * actually bought one.
 *
 * Both cases below are real production deals, read on 2026-09-09. Each one
 * re-sent an identical close quantity that the venue refused for insufficient
 * funds, over and over, because every input to the size is a stored field —
 * nothing about the deal changed between attempts, so neither could ever
 * close on its own.
 *
 * The combo close is sized:
 *
 *   qty = currentBalances.base + feeDust − Σ(entry executedQty) × maxFee
 *
 * `currentBalances.base` was exactly right in both cases — it matched the
 * deal's own order ledger (buys less sells) to the last decimal. The error was
 * entirely `feeDust`: both deals carried a positive `feeBalance` while holding
 * ZERO fee orders of their own, so the close asked for base the account had
 * never bought.
 *
 * Clamping the credit to what the deal's own fee orders bought brings both
 * closes back to exactly the position held. A deal that did buy fee base still
 * sweeps it, which is the whole point of the credit — see `./comboFeeDust`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { backedFeeDust } from './comboFeeDust'

/** SN51-USD on Kraken spot: the close was refused for insufficient funds. */
const SN51 = {
  currentBalancesBase: 1.86257,
  feeBalance: 0.20606655,
  entryExecuted: 36.31643,
  maxFee: 0.0025,
  sentQty: 1.97784,
}

/** SOL-USD on Kraken spot: the same refusal, on a different bot and pair. */
const SOL = {
  currentBalancesBase: 0.1449066,
  feeBalance: 0.0568275819,
  entryExecuted: 1.28013148,
  maxFee: 0.006,
  sentQty: 0.19405339,
}

/** The shipped formula, with whatever fee dust the caller decides to add. */
const closeQty = (d: typeof SN51, feeDust: number): number =>
  d.currentBalancesBase + feeDust - d.entryExecuted * d.maxFee

describe('backedFeeDust', () => {
  describe('clamps an unbacked credit to zero', () => {
    it('a deal holding no fee orders sweeps nothing', () => {
      expect(
        backedFeeDust({ feeBalance: SN51.feeBalance, feeOrderBase: 0 }),
      ).to.equal(0)
      expect(
        backedFeeDust({ feeBalance: SOL.feeBalance, feeOrderBase: 0 }),
      ).to.equal(0)
    })

    it('a credit larger than the fee base bought is capped at what was bought', () => {
      expect(backedFeeDust({ feeBalance: 0.2, feeOrderBase: 0.05 })).to.equal(
        0.05,
      )
    })
  })

  describe('leaves a genuine sweep alone', () => {
    it('a credit fully covered by the deal’s own fee orders passes through', () => {
      expect(backedFeeDust({ feeBalance: 0.05, feeOrderBase: 0.2 })).to.equal(
        0.05,
      )
    })

    it('fees having drawn the credit negative sweeps nothing, not a negative size', () => {
      expect(backedFeeDust({ feeBalance: -0.03, feeOrderBase: 0.2 })).to.equal(
        0,
      )
    })

    it('refuses non-finite inputs rather than propagating NaN into an order', () => {
      expect(backedFeeDust({ feeBalance: NaN, feeOrderBase: 0.2 })).to.equal(0)
      expect(backedFeeDust({ feeBalance: 0.05, feeOrderBase: NaN })).to.equal(0)
      expect(
        backedFeeDust({ feeBalance: Infinity, feeOrderBase: 0.2 }),
      ).to.equal(0)
    })
  })

  describe('the two production deals close at what they actually hold', () => {
    for (const [name, d] of [
      ['SN51-USD', SN51],
      ['SOL-USD', SOL],
    ] as const) {
      it(`${name}: the shipped size overshot the position`, () => {
        // Reproduce what the engine actually sent, to prove the fixture is the
        // real formula and not a paraphrase of it.
        const before = closeQty(d, Math.max(0, d.feeBalance))
        expect(before).to.be.closeTo(d.sentQty, 1e-5)
        expect(before).to.be.greaterThan(d.currentBalancesBase)
      })

      it(`${name}: clamping brings the size within the position`, () => {
        const after = closeQty(
          d,
          backedFeeDust({ feeBalance: d.feeBalance, feeOrderBase: 0 }),
        )
        expect(after).to.be.lessThan(d.currentBalancesBase)
        expect(after).to.be.lessThan(d.sentQty)
      })
    }
  })
})
