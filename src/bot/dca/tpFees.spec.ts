process.env.NODE_ENV = 'testing'

/**
 * Regression tests for TP/SL fee pricing.
 *
 * Two bugs were conflated here once and must not be conflated again:
 *
 *  1. **Spot quantity (86ex01wye).** A percentage stop-loss sized its sell with
 *     the taker fee on the assumption that taker >= maker. Promotional pricing
 *     inverted that on one pair, the bot tried to sell more base than it held,
 *     and the SL market order was rejected — the deal could not be closed.
 *     Fix: use the WORSE of the two sides, never a fixed side.
 *
 *  2. **Futures price (regression, v1.14.17 -> here).** The fix for (1) folded
 *     the price leg's separate fee lookup into the quantity leg's value. That
 *     value is deliberately zeroed on futures, so every futures TP and
 *     percentage SL was placed with NO fee compensation — silently, since the
 *     deal still closes cleanly and the reported P&L is accurate. It just
 *     under-delivers the configured percentage by a round trip.
 *
 * (2) has no symptom a user can report, so it is pinned here rather than left
 * to review.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  quantityFeeIsThirdAssetOnly,
  tpPriceDisplacement,
  worstFee,
} from './tpFees'

// Binance USD-M standard tier.
const futuresFee = { maker: 0.0002, taker: 0.0005 }
// The 86ex01wye shape: a promo makes taker CHEAPER than maker.
const promoFee = { maker: 0.001, taker: 0.0004 }
// The quantity leg's value on futures — what the price leg must NOT read.
const zeroedFee = { maker: 0, taker: 0 }

const closeTo = (actual: number, expected: number, eps = 1e-12) =>
  expect(Math.abs(actual - expected) < eps).to.equal(true)

describe('tpFees', () => {
  describe('worstFee: neither side may be assumed cheaper', () => {
    it('takes taker when taker is worse', () => {
      closeTo(worstFee(futuresFee), 0.0005)
    })
    it('takes maker under promo pricing', () => {
      closeTo(worstFee(promoFee), 0.001)
    })
    it('missing fee is zero, not NaN', () => {
      closeTo(worstFee(undefined), 0)
    })
    it('partial fee object falls back per side', () => {
      closeTo(worstFee({ maker: 0.0003 }), 0.0003)
    })
  })

  describe('tpPriceDisplacement: a long is pushed away from entry, a short toward it', () => {
    it('long covers the round trip', () => {
      closeTo(tpPriceDisplacement(futuresFee, true), 1 + 0.001)
    })
    it('short covers the round trip', () => {
      closeTo(tpPriceDisplacement(futuresFee, false), 1 - 0.001)
    })
    it('zero-fee account needs no displacement', () => {
      closeTo(tpPriceDisplacement(zeroedFee, true), 1)
    })
  })

  describe('the regression itself', () => {
    // A futures TP fed the zeroed quantity fee lands exactly at the configured
    // percentage, pocketing none of the round trip. This is the bug: it must not
    // be what a real futures fee produces.
    it('zeroed fee collapses displacement (the bug shape)', () => {
      closeTo(tpPriceDisplacement(zeroedFee, true), 1)
    })
    it('a real futures fee must NOT collapse to 1', () => {
      const real = tpPriceDisplacement(futuresFee, true)
      expect(real > 1).to.equal(true)
    })

    // The user-visible consequence, at the TP size that makes it legible: a 0.12%
    // TP on a 100.00 average entry. Compensated, the order rests 0.10% higher.
    const avg = 100
    const tpPerc = 0.0012
    it('0.12% TP on futures rests above the uncompensated price', () => {
      const compensated =
        avg * (1 + tpPerc) * tpPriceDisplacement(futuresFee, true)
      closeTo(compensated, 100.22012)
    })
    it('uncompensated price is the bare target', () => {
      const uncompensated =
        avg * (1 + tpPerc) * tpPriceDisplacement(zeroedFee, true)
      closeTo(uncompensated, 100.12)
    })
  })

  // Spec 007 §2: a deal whose fees have ALL been paid in a third asset
  // (BNB/BGB/KCS) never had base or quote debited for a fee — the same
  // precondition that already zeroes the quantity fee for futures (file
  // header) happens to also hold here, for an unrelated reason. This is
  // deliberately narrower than "use the real fee" — see spec 007 §4 for why
  // a per-order real-fee swap is out of scope.
  describe('quantityFeeIsThirdAssetOnly: the ONE case safe to zero the quantity gross-up for', () => {
    it('every observed fee off-pair, none on-pair → true', () => {
      expect(
        quantityFeeIsThirdAssetOnly(
          [{ asset: 'BNB', total: 0.001, totalUsd: 0.25 }],
          0,
          { base: 0, quote: 0 },
        ),
      ).to.equal(true)
    })
    it('an on-pair fee alongside an off-pair one → false (mixed, keep the gross-up)', () => {
      expect(
        quantityFeeIsThirdAssetOnly(
          [{ asset: 'BNB', total: 0.001, totalUsd: 0.25 }],
          0,
          { base: 0.00002, quote: 0 },
        ),
      ).to.equal(false)
    })
    it('commission already booked (from an earlier on-pair fee), no feeByAsset → false', () => {
      expect(
        quantityFeeIsThirdAssetOnly(undefined, 0.05, { base: 0, quote: 0.05 }),
      ).to.equal(false)
    })
    it('nothing observed yet (no fills) → false, not vacuously true', () => {
      expect(
        quantityFeeIsThirdAssetOnly(undefined, 0, { base: 0, quote: 0 }),
      ).to.equal(false)
    })
  })
})
