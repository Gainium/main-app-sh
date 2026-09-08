process.env.NODE_ENV = 'testing'

/**
 * Regression tests for take-profit coverage drift.
 * Spec: `specs/013.tp-coverage-drift-after-partial-tp.md` (issue #696,
 * follow-up to #694).
 *
 * Replays the three production deals measured on 2026-09-06 (§2.1): the
 * under-covered B3-USDC deal that was reported, the over-covered CTSIUSDT deal,
 * and the unreported DGBUSDT deal of the same shape — plus one of the thirteen
 * healthy partially-filled take-profits that must NOT be touched (§1.6).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  reconcileTpCoverage,
  restingTpQty,
  trackedPosition,
  unexplainedDrift,
  type LiveTpOrder,
} from './tpCoverageReconcile'

/** Venue minimums small enough not to mask any drift under test. */
const placeable = { baseMinAmount: 1, quoteMinAmount: 1, price: 1 }

const tp = (
  status: string,
  origQty: string,
  executedQty: string,
  clientOrderId = `D-TP-${status}-${origQty}`,
): LiveTpOrder => ({ clientOrderId, status, origQty, executedQty })

describe('tpCoverageReconcile', () => {
  describe('§1.1 resting coverage vs tracked position', () => {
    it('reads what a take-profit can still sell, not what it was created for', () => {
      // §2.2's order: 54,103 of 878,966 already sold.
      expect(restingTpQty(tp('PARTIALLY_FILLED', '878966', '54103'))).to.equal(
        824863,
      )
    })

    it('treats a NEW order as resting its whole size', () => {
      expect(restingTpQty(tp('NEW', '533', '0.00000000'))).to.equal(533)
    })

    it('subtracts the partial take profit already booked in tpHistory', () => {
      // §2.2: size 989,459 less the 54,103 sold = 935,356.
      expect(
        trackedPosition({
          size: 989458.9999999998,
          tpHistory: [
            { id: 'D-TP-TNTUXFh6ohYEWhi6dK8cYPufQgEYqj', qty: 54103 },
          ],
          filledCloseOrders: [],
        }),
      ).to.be.closeTo(935356, 1e-6)
    })

    it('does not double-count a tpHistory entry whose order is already FILLED', () => {
      // The engine books a closed take-profit in both places; counting both
      // drove the TP quantity negative on deals that closed more than once.
      expect(
        trackedPosition({
          size: 1000,
          tpHistory: [{ id: 'D-TP-done', qty: 400 }],
          filledCloseOrders: [tp('FILLED', '400', '400', 'D-TP-done')],
        }),
      ).to.equal(600)
    })

    it('subtracts base withdrawn by reduce funds', () => {
      expect(
        trackedPosition({
          size: 1000,
          tpHistory: [],
          filledCloseOrders: [],
          reduceFundsBase: 100,
          pendingReduceFundsBase: 50,
        }),
      ).to.equal(850)
    })
  })

  describe('§1.2 under-covered — the reported B3-USDC deal', () => {
    // Deal 6a90e161a76e7fe63ea3118f, user 6a8b1db88e06bef801d752bd.
    const tracked = 935356
    const orders = [tp('PARTIALLY_FILLED', '878966', '54103')]

    it('reports the position the take-profit does not reach', () => {
      const v = reconcileTpCoverage(
        { kind: 'orders', orders },
        tracked,
        placeable,
      )
      expect(v.state).to.equal('under')
      expect(v.resting).to.equal(824863)
      expect(v.drift).to.equal(-110493)
    })

    it('nominates the stale partially-filled order for cancellation', () => {
      const v = reconcileTpCoverage(
        { kind: 'orders', orders },
        tracked,
        placeable,
      )
      expect(v.staleTps.map((o) => o.clientOrderId)).to.deep.equal([
        orders[0].clientOrderId,
      ])
      expect(v.rearm).to.equal(true)
    })
  })

  describe('§1.3 over-covered — the CTSIUSDT double take-profit', () => {
    // Deal 6a978104aa99d06351d63e3a, user 674b015f8de5acbdf0c5309e.
    const orders = [
      tp('PARTIALLY_FILLED', '682', '367.00000000', 'TP-Jjsrx'),
      tp('NEW', '533', '0.00000000', 'TP-qWLCK'),
    ]

    it('sees more base on offer than the deal owns', () => {
      const v = reconcileTpCoverage({ kind: 'orders', orders }, 533, placeable)
      expect(v.state).to.equal('over')
      expect(v.resting).to.equal(848)
      expect(v.drift).to.equal(315)
    })

    it('cancels only the stale partial, never the correctly-sized replacement', () => {
      const v = reconcileTpCoverage({ kind: 'orders', orders }, 533, placeable)
      expect(v.staleTps.map((o) => o.clientOrderId)).to.deep.equal(['TP-Jjsrx'])
    })
  })

  describe('§2.4 over-covered — the unreported DGBUSDT deal', () => {
    it('is the same shape and is flagged the same way', () => {
      const v = reconcileTpCoverage(
        {
          kind: 'orders',
          orders: [
            tp('PARTIALLY_FILLED', '31934.9', '11245.4', 'D-TP-fawIy'),
            tp('NEW', '31730.4', '0', 'D-TP-GzuLl'),
          ],
        },
        31773.499999999993,
        placeable,
      )
      expect(v.state).to.equal('over')
      expect(v.drift).to.be.closeTo(20646.4, 1e-6)
      expect(v.staleTps.map((o) => o.clientOrderId)).to.deep.equal(['D-TP-fawIy'])
    })
  })

  describe('§1.6 a partially-filled take-profit is not itself a defect', () => {
    it('clears a partial fill whose remainder still covers the position', () => {
      // The other thirteen orders in §2.1, e.g. SPELLUSDT 102,530 of 158,522
      // against a tracked 55,992.
      const v = reconcileTpCoverage(
        {
          kind: 'orders',
          orders: [tp('PARTIALLY_FILLED', '158522', '102530.00000000')],
        },
        55992,
        placeable,
      )
      expect(v.state).to.equal('covered')
      expect(v.drift).to.equal(0)
      expect(v.staleTps).to.deep.equal([])
      expect(v.rearm).to.equal(false)
    })
  })

  describe('§1.5 a drift no order could be placed for is not actionable', () => {
    // The KUBUSDT deal in §2.1: 0.01 adrift on a 0.02 position — dust on a
    // deal that has all but closed.
    const dust = { kind: 'orders' as const, orders: [tp('PARTIALLY_FILLED', '9.72', '9.71')] }

    it('reads a sub-minimum drift as covered', () => {
      const v = reconcileTpCoverage(dust, 0.019999999999999574, {
        baseMinAmount: 0.1,
        quoteMinAmount: 5,
        price: 1.6,
      })
      expect(v.state).to.equal('covered')
    })

    it('still reports the measured drift for the log line', () => {
      const v = reconcileTpCoverage(dust, 0.019999999999999574, {
        baseMinAmount: 0.1,
        quoteMinAmount: 5,
        price: 1.6,
      })
      expect(v.drift).to.be.closeTo(-0.01, 1e-9)
    })

    it('is not actionable when the drift is worth less than the venue minimum notional', () => {
      const v = reconcileTpCoverage(
        { kind: 'orders', orders: [tp('PARTIALLY_FILLED', '100', '60')] },
        50,
        { baseMinAmount: 1, quoteMinAmount: 100, price: 0.5 },
      )
      // 10 base adrift, worth $5 against a $100 minimum notional.
      expect(v.state).to.equal('covered')
    })
  })

  describe('§1.7 the venue decides, and silence is not an answer', () => {
    it('never acts when the venue could not be reached', () => {
      const v = reconcileTpCoverage({ kind: 'unavailable' }, 935356, placeable)
      expect(v.state).to.equal('unknown')
      expect(v.staleTps).to.deep.equal([])
      expect(v.rearm).to.equal(false)
    })

    it('ignores orders the venue reports as no longer resting', () => {
      // The dead `NEW` rows of §2.5 arrive here only if the venue confirms
      // them; a CANCELED/FILLED answer contributes no coverage.
      const v = reconcileTpCoverage(
        {
          kind: 'orders',
          orders: [
            tp('CANCELED', '31934.9', '0', 'dead-1'),
            tp('FILLED', '500', '500', 'dead-2'),
            tp('NEW', '533', '0'),
          ],
        },
        533,
        placeable,
      )
      expect(v.state).to.equal('covered')
      expect(v.resting).to.equal(533)
    })

    it('a deal with no live take-profit at all is under-covered, not covered', () => {
      const v = reconcileTpCoverage({ kind: 'orders', orders: [] }, 533, placeable)
      expect(v.state).to.equal('under')
      expect(v.drift).to.equal(-533)
      expect(v.rearm).to.equal(true)
    })
  })

  describe('§1.4 the correction is the same for both shapes', () => {
    it('asks for a re-arm whenever it nominates something to cancel', () => {
      for (const orders of [
        [tp('PARTIALLY_FILLED', '878966', '54103')],
        [
          tp('PARTIALLY_FILLED', '682', '367', 'a'),
          tp('NEW', '533', '0', 'b'),
        ],
      ]) {
        const v = reconcileTpCoverage(
          { kind: 'orders', orders },
          orders.length === 1 ? 935356 : 533,
          placeable,
        )
        expect(v.rearm).to.equal(true)
        expect(v.staleTps.length).to.be.greaterThan(0)
      }
    })

    it('§017 re-arms a deal resting ONE undersized NEW take-profit', () => {
      // Deal 6a301c7ca999bdafb2ad8055 (AIXBTUSDT), prod 2026-09-08: 510 held,
      // one NEW take-profit at 250. No partial, one live order — so before spec
      // `017` `rearm` was false and an armed correction logged
      // `under: 260 of 510` on every pass and did nothing. 61 open deals.
      const v = reconcileTpCoverage(
        { kind: 'orders', orders: [tp('NEW', '250', '0')] },
        510,
        { baseMinAmount: 1, quoteMinAmount: 1, price: 0.023445 },
      )
      expect(v.state).to.equal('under')
      expect(v.drift).to.equal(-260)
      // Nothing is cancelled here: `placeOrders` cancels the small order and
      // sends the replacement in the same pass.
      expect(v.staleTps).to.deep.equal([])
      expect(v.rearm).to.equal(true)
    })

    it('§017 leaves an over-covered deal alone — re-arming there would stack', () => {
      const v = reconcileTpCoverage(
        { kind: 'orders', orders: [tp('NEW', '800', '0')] },
        510,
        { baseMinAmount: 1, quoteMinAmount: 1, price: 0.023445 },
      )
      expect(v.state).to.equal('over')
      expect(v.rearm).to.equal(false)
    })

    it('does not nominate a NEW order for cancellation even when over-covered', () => {
      // Two NEW take-profits and no partial: real, but not this defect's
      // shape, and cancelling a healthy resting order is not this fix's job.
      const v = reconcileTpCoverage(
        {
          kind: 'orders',
          orders: [tp('NEW', '400', '0', 'a'), tp('NEW', '400', '0', 'b')],
        },
        400,
        placeable,
      )
      expect(v.state).to.equal('over')
      expect(v.staleTps).to.deep.equal([])
      expect(v.rearm).to.equal(false)
    })
  })

  /**
   * Spec `014.tp-coverage-fee-shaped-false-drift.md` (issue #700).
   *
   * Every number below is a production deal read from Mongo on 2026-09-07,
   * with the quantity the venue actually had resting. The three healthy ones
   * were reported `under`/`over` on every reconcile pass for more than a day.
   */
  describe('§014 a drift no larger than the fee the take-profit is sized net of', () => {
    const FEE = 0.001

    it('clears the spot LONG shave — RUNE-USDC rested size × (1 − fee)', () => {
      // Deal 6a9169e0d044367d73f9c917: size 1151.1818, one NEW take-profit of
      // 1150.0306 = 1151.1818 × 0.999, exactly what `getTPOrder` sizes.
      const probe = {
        kind: 'orders' as const,
        orders: [tp('NEW', '1150.0306', '0')],
      }
      const venue = { baseMinAmount: 0.1, quoteMinAmount: 1, price: 6.9596 }
      // Before: a healthy deal read as 1.1512 RUNE uncovered.
      expect(reconcileTpCoverage(probe, 1151.1818, venue).state).to.equal(
        'under',
      )
      expect(
        reconcileTpCoverage(probe, 1151.1818, { ...venue, feeRate: FEE }).state,
      ).to.equal('covered')
    })

    it('clears the spot SHORT gross-up — APE-USDC rested size ÷ (1 − fee)', () => {
      // Deal 6a9168a9d044367d73f9b190: tracked 32,550, resting 32,582.58 =
      // 32,550 / 0.999. The mirror of the long shave, same magnitude.
      const probe = {
        kind: 'orders' as const,
        orders: [tp('NEW', '32582.58', '0')],
      }
      const venue = { baseMinAmount: 0.1, quoteMinAmount: 1, price: 0.4 }
      expect(reconcileTpCoverage(probe, 32550, venue).state).to.equal('over')
      expect(
        reconcileTpCoverage(probe, 32550, { ...venue, feeRate: FEE }).state,
      ).to.equal('covered')
    })

    it('clears the shave plus the venue step it is floored to — RENDER-USDT', () => {
      // Deal 6a15d25a1af32681aa1cf186: 626.06 tracked, 625.43 resting. The
      // 0.63 gap is 0.0033 more than one fee because the quantity is floored
      // to the pair's base step; that residue is itself unplaceable.
      const probe = {
        kind: 'orders' as const,
        orders: [tp('NEW', '625.43', '0')],
      }
      const venue = { baseMinAmount: 0.1, quoteMinAmount: 1, price: 2.0436 }
      expect(reconcileTpCoverage(probe, 626.06, venue).state).to.equal('under')
      expect(
        reconcileTpCoverage(probe, 626.06, { ...venue, feeRate: FEE }).state,
      ).to.equal('covered')
    })

    it('still reports the smallest genuinely drifted deal in the population', () => {
      // SANTOSUSDT 689ca35912af2b11a181dce5 — 1.45% adrift, the narrowest real
      // member of the 2026-09-07 population. A one-fee tolerance must not
      // reach it, or the check stops being worth running.
      const v = reconcileTpCoverage(
        { kind: 'orders', orders: [tp('NEW', '388.6', '0')] },
        394.33,
        { baseMinAmount: 0.1, quoteMinAmount: 1, price: 1.5, feeRate: FEE },
      )
      expect(v.state).to.equal('under')
      expect(v.drift).to.be.closeTo(-5.73, 1e-6)
    })

    it('still reports the B3-USDC deal spec 013 was written for', () => {
      const v = reconcileTpCoverage(
        { kind: 'orders', orders: [tp('PARTIALLY_FILLED', '878966', '54103')] },
        935356,
        { ...placeable, feeRate: FEE },
      )
      expect(v.state).to.equal('under')
      expect(v.rearm).to.equal(true)
    })

    it('measures the same tolerance in both directions and none without a fee', () => {
      expect(unexplainedDrift(-1.1512, 1151.1818, FEE)).to.equal(0)
      expect(unexplainedDrift(1.1512, 1151.1818, FEE)).to.equal(0)
      expect(unexplainedDrift(-1.1512, 1151.1818, 0)).to.be.closeTo(
        1.1512,
        1e-9,
      )
      // A zeroFee key answers 0 here exactly as it does in `getTPOrder`.
      expect(unexplainedDrift(-110493, 935356, 0)).to.equal(110493)
      // Nonsense fees are ignored rather than widening the tolerance.
      expect(unexplainedDrift(-100, 1000, 1)).to.equal(100)
      expect(unexplainedDrift(-100, 1000, -0.5)).to.equal(100)
    })

    it('leaves the drift itself untouched for the log line', () => {
      const v = reconcileTpCoverage(
        { kind: 'orders', orders: [tp('NEW', '1150.0306', '0')] },
        1151.1818,
        { baseMinAmount: 0.1, quoteMinAmount: 1, price: 6.9596, feeRate: FEE },
      )
      expect(v.drift).to.be.closeTo(-1.1512, 1e-9)
      expect(v.resting).to.equal(1150.0306)
    })
  })
})
