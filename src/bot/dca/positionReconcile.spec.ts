process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the deal ↔ venue position reconciliation.
 * Spec: `specs/005.zombie-deal-venue-position-reconciliation.md` (issue #630).
 *
 * Replays the production state of DCA deal `69f1b27faeba7a4880365abb` (bot
 * `69de6e9e10716872ece23ce8`, XAUTUSDT SHORT on `paperBitgetUsdm`): the deal is
 * `status: 'open'` with one of five multi-TP targets filled, while
 * `paperFutures` has held its position `CLOSED` since 2026-04-29T13:39:55Z. The
 * same paper user still has 25 other open positions, so this is a vanished
 * position and not an emptied account.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  dealPositionGoneMessage,
  findVenuePosition,
  reconcileDealAgainstVenue,
  type VenuePositionLike,
} from './positionReconcile'

/** The 25 positions the paper user really does still hold, abridged. */
const otherPositions: VenuePositionLike[] = [
  { symbol: 'CROUSDT', positionAmt: '856', positionSide: 'SHORT' },
  { symbol: 'KAVAUSDT', positionAmt: '1324.8999999999999', positionSide: 'SHORT' },
  { symbol: 'LINKUSDT', positionAmt: '1', positionSide: 'LONG' },
]

describe('positionReconcile', () => {
  describe('§1.1 a position the venue no longer holds settles the deal', () => {
    it('closes the deal when the symbol is absent from the venue list', () => {
      const v = reconcileDealAgainstVenue(
        { kind: 'positions', positions: otherPositions },
        'XAUTUSDT',
        'SHORT',
        false,
      )
      expect(v.closeDeal).to.equal(true)
      expect(v.verdict).to.contain('XAUTUSDT')
    })

    it('closes the deal when the venue reports the symbol at size zero', () => {
      // Real venues answer with a zeroed row rather than dropping the symbol.
      const v = reconcileDealAgainstVenue(
        {
          kind: 'positions',
          positions: [
            ...otherPositions,
            { symbol: 'XAUTUSDT', positionAmt: '0', positionSide: 'SHORT' },
          ],
        },
        'XAUTUSDT',
        'SHORT',
        false,
      )
      expect(v.closeDeal).to.equal(true)
    })
  })

  describe('§1.2 a position that is still there is left alone', () => {
    it('does not close a deal whose position the venue still holds', () => {
      const v = reconcileDealAgainstVenue(
        {
          kind: 'positions',
          positions: [
            ...otherPositions,
            { symbol: 'XAUTUSDT', positionAmt: '0.01', positionSide: 'SHORT' },
          ],
        },
        'XAUTUSDT',
        'SHORT',
        false,
      )
      expect(v.closeDeal).to.equal(false)
      expect(v.verdict).to.contain('0.01')
    })
  })

  describe('§2 side matching is `main.ts:3678`, not a second opinion', () => {
    it('ignores the side on a one-way account', () => {
      // One-way holds a single position per symbol; reading it as the wrong
      // side would declare a position the bot owns to be gone.
      expect(
        findVenuePosition(
          [{ symbol: 'XAUTUSDT', positionAmt: '0.02', positionSide: 'BOTH' }],
          'XAUTUSDT',
          'SHORT',
          false,
        ),
      ).to.not.equal(undefined)
    })

    it('reads a hedge account `BOTH` row by the sign of the amount', () => {
      const shortRow = [
        { symbol: 'XAUTUSDT', positionAmt: '-0.02', positionSide: 'BOTH' },
      ]
      expect(
        findVenuePosition(shortRow, 'XAUTUSDT', 'SHORT', true),
      ).to.not.equal(undefined)
      expect(findVenuePosition(shortRow, 'XAUTUSDT', 'LONG', true)).to.equal(
        undefined,
      )
    })

    it('does not match the opposite side on a hedge account', () => {
      expect(
        findVenuePosition(
          [{ symbol: 'XAUTUSDT', positionAmt: '0.02', positionSide: 'LONG' }],
          'XAUTUSDT',
          'SHORT',
          true,
        ),
      ).to.equal(undefined)
    })
  })

  describe('§3.1 fail-safe: an unreachable venue is not an empty venue', () => {
    it('never closes a deal when the positions call did not answer', () => {
      // Closing here would abandon a live position with no TP and no SL —
      // strictly worse than the zombie deal this fix exists to settle.
      const v = reconcileDealAgainstVenue(
        { kind: 'unavailable' },
        'XAUTUSDT',
        'SHORT',
        false,
      )
      expect(v.closeDeal).to.equal(false)
      expect(v.verdict).to.contain('unknown')
    })
  })

  describe('§4 the user is told, and told which deal', () => {
    it('names the deal, the symbol and the exchange', () => {
      const m = dealPositionGoneMessage({
        dealId: '69f1b27faeba7a4880365abb',
        symbol: 'XAUTUSDT',
        exchange: 'paperBitgetUsdm',
      })
      expect(m).to.contain('69f1b27faeba7a4880365abb')
      expect(m).to.contain('XAUTUSDT')
      expect(m).to.contain('paperBitgetUsdm')
      // The realised P&L is kept — say so, or "closed" reads as "discarded".
      expect(m).to.contain('realised')
    })
  })
})
