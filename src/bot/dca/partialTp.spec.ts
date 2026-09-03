process.env.NODE_ENV = 'testing'

/**
 * Regression tests for take-profits the venue reports FILLED without filling.
 *
 * Replays the orders that produced the bug on a real account (Kraken linear
 * futures, three DCA bots, 2026-08-29). Every deal below closed on a TP that
 * the venue called FILLED after selling 1-42% of it; the remainder accumulated
 * into BTC/XRP positions no bot owned, which consumed 4,233 of the account's
 * 4,258 USD of margin. With ~24 USD free every subsequent base order was
 * rejected `Not enough balance`, so all three bots looped
 * create-deal → rejected → cancel for weeks. 41 users were affected in a
 * 30-day window.
 *
 * The two halves this pins:
 *   - the real underfilled rows MUST be detected, whatever the venue or order
 *     type — the previous guard was gated on bybit+LIMIT and matched none of
 *     them;
 *   - full fills and rounding dust MUST NOT be, or a deal can never close and
 *     the silent stranding is merely traded for a silently wedged deal.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { underfilledTpQty, PARTIAL_TP_TOLERANCE } from './partialTp'

const tp = (origQty: string, executedQty: string, over: object = {}) => ({
  typeOrder: 'dealTP',
  status: 'FILLED',
  origQty,
  executedQty,
  ...over,
})

const expectStranding = (order: object, shouldDetect: boolean) => {
  const unsold = underfilledTpQty(order)
  expect(unsold > 0).to.equal(shouldDetect)
}

describe('partialTp', () => {
  describe('real stranded TPs; each MUST be detected', () => {
    // deal 6a140f941af32681aa9ee80d: bought 0.1065 BTC over six orders, TP sold 0.0023
    it('BTC 0.1065 -> 0.0023 (MARKET, krakenUsdm)', () => {
      expectStranding(tp('0.1065', '0.0023'), true)
    })
    // its re-placed remainder, a D-SR order, underfilled again
    it('BTC 0.1042 -> 0.0011 (D-SR remainder)', () => {
      expectStranding(tp('0.1042', '0.0011'), true)
    })
    it('BTC 0.0908 -> 0.0377', () => {
      expectStranding(tp('0.0908', '0.0377'), true)
    })
    it('XAUT 0.09 -> 0.008', () => {
      expectStranding(tp('0.09', '0.008'), true)
    })
    it('XRP 589 -> 4', () => {
      expectStranding(tp('589', '4'), true)
    })
    it('nothing sold at all: 1.0 -> "0.00000000"', () => {
      expectStranding(tp('1.0', '0.00000000'), true)
    })
  })

  describe('clean closes; MUST NOT be detected', () => {
    it('exact full fill 0.0612 -> 0.0612', () => {
      expectStranding(tp('0.0612', '0.0612'), false)
    })
    // a real row: the venue settled a hair OVER the requested size
    it('venue settled over 0.0604 -> 0.0605', () => {
      expectStranding(tp('0.0604', '0.0605'), false)
    })
  })

  describe('wedge guards; MUST NOT be detected or deals never close', () => {
    it('dust 1.0 -> 0.9995 (0.05% short)', () => {
      expectStranding(tp('1.0', '0.9995'), false)
    })
    it('dust 1.0 -> 0.9992 (0.08% short)', () => {
      expectStranding(tp('1.0', '0.9992'), false)
    })
    it('origQty zero', () => {
      expectStranding(tp('0', '0'), false)
    })
    it('non-numeric quantities', () => {
      expectStranding(tp('abc', 'xyz'), false)
    })
    it('negative executedQty', () => {
      expectStranding(tp('1', '-1'), false)
    })
    it('not FILLED', () => {
      expectStranding(tp('1', '0', { status: 'NEW' }), false)
    })
    it('not a take-profit', () => {
      expectStranding(tp('1', '0', { typeOrder: 'dealStart' }), false)
    })
  })

  // Measured on prod 2026-08-30: the one account that underfills steadily (bitget
  // spot) produced 37 shortfalls in 24h, 31 of them in 0.10-0.50%, median 0.196%,
  // max 0.93% — routine lot-size rounding, not stranding. At the original 0.1%
  // tolerance every one of these would have held its deal open for a remainder
  // below the venue's minimum order size. They must all read as dust.
  describe('measured venue rounding dust; MUST NOT be detected', () => {
    it('bitget 18.945 -> 18.926 (0.10% short)', () => {
      expectStranding(tp('18.945', '18.926'), false)
    })
    it('bitget 357.14 -> 356.7 (0.12% short)', () => {
      expectStranding(tp('357.14', '356.7'), false)
    })
    it('bitget 11.85 -> 11.8 (0.42% short)', () => {
      expectStranding(tp('11.85', '11.8'), false)
    })
    it('bitget 3.6 -> 3.5 (2.78% short)', () => {
      expectStranding(tp('3.6', '3.5'), false)
    })
    it('widest measured dust 1.0 -> 0.9907 (0.93%)', () => {
      expectStranding(tp('1.0', '0.9907'), false)
    })
  })

  describe('just past the tolerance; MUST be detected', () => {
    it('1.0 -> 0.9489 (5.11% short)', () => {
      expectStranding(tp('1.0', '0.9489'), true)
    })
  })

  // The exact boundary is a float knife-edge and is deliberately not asserted
  // either way.
  it('PARTIAL_TP_TOLERANCE has not silently changed (revisit the cases above if it has)', () => {
    expect(PARTIAL_TP_TOLERANCE).to.equal(0.05)
  })
})
