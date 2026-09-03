process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec 002 — recovering the remainder of a krakenUsdm
 * reduce-only close the venue reports FILLED after only partially executing.
 *
 * Kraken futures has no true market order; `mkr` is IOC with a 1%
 * price-protection band, so a close that cannot fill within the band is
 * filled for whatever the band allowed and the rest is cancelled by the
 * venue itself — never `PARTIALLY_FILLED`. `buyRemainder`'s blanket
 * `reduceOnly` bail (main.ts) previously meant this shortfall was never
 * recovered on this venue.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import {
  canRecoverReduceOnlyRemainder,
  isKrakenUsdmUnderfilledReduceOnlyClose,
} from './reduceOnlyRemainder'

describe('reduceOnlyRemainder', () => {
  describe('canRecoverReduceOnlyRemainder', () => {
    it('krakenUsdm MARKET reduce-only: recoverable', () => {
      expect(
        canRecoverReduceOnlyRemainder(ExchangeEnum.krakenUsdm, {
          type: 'MARKET',
        }),
      ).to.equal(true)
    })
    it('krakenUsdm LIMIT: not this carve-out (mkr is MARKET-shaped)', () => {
      expect(
        canRecoverReduceOnlyRemainder(ExchangeEnum.krakenUsdm, {
          type: 'LIMIT',
        }),
      ).to.equal(false)
    })
    // Measured 2026-08-30: binanceUsdm/bybitLinear/bitgetUsdm reduce-only
    // remainders were rejected outright (`ReduceOnly Order is rejected.`),
    // not "ask smaller" like krakenUsdm's `wouldNotReducePosition` — stay
    // excluded.
    it('binanceUsdm MARKET reduce-only: stays excluded', () => {
      expect(
        canRecoverReduceOnlyRemainder(ExchangeEnum.binanceUsdm, {
          type: 'MARKET',
        }),
      ).to.equal(false)
    })
    it('bybitLinear (bybitUsdm) MARKET reduce-only: stays excluded', () => {
      expect(
        canRecoverReduceOnlyRemainder(ExchangeEnum.bybitUsdm, {
          type: 'MARKET',
        }),
      ).to.equal(false)
    })
    it('bitgetUsdm MARKET reduce-only: stays excluded', () => {
      expect(
        canRecoverReduceOnlyRemainder(ExchangeEnum.bitgetUsdm, {
          type: 'MARKET',
        }),
      ).to.equal(false)
    })
  })

  describe('isKrakenUsdmUnderfilledReduceOnlyClose', () => {
    const order = (over: Partial<Record<string, unknown>> = {}) => ({
      reduceOnly: true,
      type: 'MARKET',
      status: 'FILLED',
      origQty: '1.0',
      executedQty: '0.001',
      ...over,
    })

    it('krakenUsdm reduce-only MARKET FILLED with a shortfall: detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order(),
        ),
      ).to.equal(true)
    })
    it('nothing filled at all: still detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ executedQty: '0' }),
        ),
      ).to.equal(true)
    })
    it('fully filled: not detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ executedQty: '1.0' }),
        ),
      ).to.equal(false)
    })
    it('venue settled over: not detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ executedQty: '1.0001' }),
        ),
      ).to.equal(false)
    })
    it('not reduceOnly: not this shape', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ reduceOnly: false }),
        ),
      ).to.equal(false)
    })
    it('not MARKET: not this shape', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ type: 'LIMIT' }),
        ),
      ).to.equal(false)
    })
    it('not FILLED: not this shape (a real PARTIALLY_FILLED goes through the existing path)', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ status: 'PARTIALLY_FILLED' }),
        ),
      ).to.equal(false)
    })
    it('other exchange: not this shape (bybit has its own existing hook)', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(ExchangeEnum.bybit, order()),
      ).to.equal(false)
    })
    it('non-numeric quantities: not detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ origQty: 'abc', executedQty: 'xyz' }),
        ),
      ).to.equal(false)
    })
    it('origQty zero: not detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ origQty: '0', executedQty: '0' }),
        ),
      ).to.equal(false)
    })
    it('negative executedQty: not detected', () => {
      expect(
        isKrakenUsdmUnderfilledReduceOnlyClose(
          ExchangeEnum.krakenUsdm,
          order({ executedQty: '-1' }),
        ),
      ).to.equal(false)
    })
  })
})
