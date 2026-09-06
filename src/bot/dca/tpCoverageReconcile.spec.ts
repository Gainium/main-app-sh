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
})
