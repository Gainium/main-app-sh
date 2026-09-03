process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the base-order contribution to a DCA take-profit.
 *
 * Every case below is a real production deal, checked to the decimal against
 * prod Mongo on 2026-08-26.
 *
 * The bug: `getTPOrder` added the base order in separately, and when its row
 * was not in the order map it invented one from `baseOrderSize`. A base order
 * that partially fills and is then CANCELED is exactly such a row — `loadOrders`
 * filtered `status: CANCELED` out, so after a restart it could never be found.
 * The invented number then either replaced the whole position (sizing ran before
 * the order map was populated) or was stacked on top of it (order map populated,
 * base order still missing).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { grossEntryVolume, resolveBaseOrderQty } from './baseOrderQty'

/** Flooring to 1 decimal, the base precision of the Coinbase AIOZ-USDC pair. */
const floor1 = (n: number) => Math.floor(n * 10) / 10

describe('baseOrderQty', () => {
  describe('grossEntryVolume', () => {
    it('a deal that has closed nothing is its own size', () => {
      expect(grossEntryVolume(3711.3, 0, 0)).to.equal(3711.3)
    })
    it('a deal that has already taken partial profit adds it back', () => {
      // `add` arrives negative: 51.5 closed via tpHistory.
      expect(grossEntryVolume(186.79, -51.5, 0)).to.equal(238.29)
    })
    it('a QUEUED reduce-funds is still in the position, so it is not closed volume', () => {
      // `add` folds pendingReduceFunds in; grossEntryVolume must take it back out.
      expect(grossEntryVolume(100, -30, 30)).to.equal(100)
    })
  })

  describe('resolveBaseOrderQty — a real AIOZ-USDC deal on Coinbase', () => {
    // base order                   origQty 1790.1, executedQty 345.3, CANCELED
    // safety fills                 596.1 + 632.3 + 670.8 + 711.7 + 755.1 = 3366.0
    // position held                345.3 + 3366.0 = 3711.30
    // nominal would be             baseOrderSize 100 / initialPrice 0.0559154 = 1788.4
    const AIOZ_FILLS = 3366.0
    const AIOZ_HELD = 3711.3

    it('the CANCELED base order row, once loaded, is used directly', () => {
      expect(
        resolveBaseOrderQty({
          boFromOrder: 345.3,
          filledQty: AIOZ_FILLS,
          dealSize: AIOZ_HELD,
          grossEntry: AIOZ_HELD,
          floor: floor1,
        }),
      ).to.deep.equal({ qty: 345.3, source: 'order' })
    })

    it('with the base order row missing, the position supplies exactly 345.3', () => {
      // NOT 1788.4 — that is what produced the 5147.9 the venue rejected.
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: AIOZ_FILLS,
          dealSize: AIOZ_HELD,
          grossEntry: AIOZ_HELD,
          floor: floor1,
        }),
      ).to.deep.equal({ qty: 345.3, source: 'deal' })
    })

    it('sized before the order map is populated, the whole position is the base', () => {
      // The regime that rested 1786.1 against 3711.30: no fills visible at all.
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: 0,
          dealSize: AIOZ_HELD,
          grossEntry: AIOZ_HELD,
          floor: floor1,
        }),
      ).to.deep.equal({ qty: 3711.3, source: 'deal' })
    })
  })

  describe('resolveBaseOrderQty — a real TURBO-USDC deal (paper Binance)', () => {
    // 24 FILLED safety orders 101296, FILLED base order 2251, size 103547.
    // It still rests a 2226 take-profit — the nominal, alone.
    it('an empty order map does not resize the deal down to its base order', () => {
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: 0,
          dealSize: 103547,
          grossEntry: 103547,
          floor: (n) => Math.floor(n),
        }),
      ).to.deep.equal({ qty: 103547, source: 'deal' })
    })
  })

  describe('resolveBaseOrderQty — the fallback that must survive', () => {
    it('a deal whose opening order has not landed still gets the nominal', () => {
      // qty 0 with source 'nominal' — the caller fills in the settings-derived
      // stopgap, which needs a live USD rate for `usd`-sized bots.
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: 0,
          dealSize: 0,
          grossEntry: 0,
          floor: floor1,
        }),
      ).to.deep.equal({ qty: 0, source: 'nominal' })
    })
  })

  describe('resolveBaseOrderQty — the fallback that must NOT be reached', () => {
    it('a fully accounted position contributes no base order, not a nominal one', () => {
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: 3711.3,
          dealSize: 3711.3,
          grossEntry: 3711.3,
          floor: floor1,
        }),
      ).to.deep.equal({ qty: 0, source: 'accounted' })
    })

    it('a sub-precision residue is not a base order', () => {
      // floating-point noise of the kind `deal.size` carries (103547.00000000001)
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: 3711.3,
          dealSize: 3711.3000000000002,
          grossEntry: 3711.3000000000002,
          floor: floor1,
        }),
      ).to.deep.equal({ qty: 0, source: 'accounted' })
    })

    it('a short records its size negative and still resolves positive', () => {
      expect(
        resolveBaseOrderQty({
          boFromOrder: 0,
          filledQty: 0,
          dealSize: -125,
          grossEntry: 125,
          floor: (n) => Math.floor(n),
        }),
      ).to.deep.equal({ qty: 125, source: 'deal' })
    })
  })
})
