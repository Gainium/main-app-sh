process.env.NODE_ENV = 'testing'

/**
 * Regression tests for Claus #505 — a venue refusing a MARKET base order must
 * not leave the deal with no order on the exchange at all.
 *
 * The refusal these cover is Coinbase Advanced Trade's limit-only mode
 * ("Orderbook is in limit only mode - please use limit order type"), observed
 * in production on 2026-08-25 and again on 2026-08-30. The decision is made by
 * `shouldFallBackToLimitEntry`; `placeBaseOrder` acts on it by re-sending the
 * base order with `forceLimit`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { OrderTypeEnum } from '../../types'
import { isLimitOnlyReason, shouldFallBackToLimitEntry } from './limitOnlyEntry'

describe('limitOnlyEntry', () => {
  describe('isLimitOnlyReason', () => {
    it('matches the Coinbase wording verbatim', () => {
      expect(
        isLimitOnlyReason(
          'Orderbook is in limit only mode - please use limit order type',
        ),
      ).to.equal(true)
    })
    it('matches a hyphenated / cased spelling of the same condition', () => {
      expect(isLimitOnlyReason('Product is LIMIT-ONLY right now')).to.equal(
        true,
      )
    })
    it('does not match a post-only rejection', () => {
      // A post-only refusal is a LIMIT order being refused. Falling back to
      // limit there would re-send the same refused order forever.
      expect(
        isLimitOnlyReason('Order would immediately match and take'),
      ).to.equal(false)
    })
    it('does not match an unrelated rejection', () => {
      expect(isLimitOnlyReason('Account has insufficient balance')).to.equal(
        false,
      )
    })
  })

  describe('shouldFallBackToLimitEntry', () => {
    const reason =
      'Orderbook is in limit only mode - please use limit order type'

    it('35s enter-market fallback refused on a limit-entry bot: falls back', () => {
      expect(
        shouldFallBackToLimitEntry({
          sentType: OrderTypeEnum.market,
          forceLimit: false,
          reason,
        }),
      ).to.equal(true)
    })

    it("market-entry bot's own first base order refused: falls back too", () => {
      // This is the case the first #505 fix did not cover: it required the bot
      // to be configured for LIMIT entry, so a MARKET-entry bot was still left
      // in `start` with nothing on the book.
      expect(
        shouldFallBackToLimitEntry({
          sentType: OrderTypeEnum.market,
          forceLimit: false,
          reason,
        }),
      ).to.equal(true)
    })

    it('terminates: the re-sent LIMIT cannot trigger a second fallback', () => {
      expect(
        shouldFallBackToLimitEntry({
          sentType: OrderTypeEnum.limit,
          forceLimit: true,
          reason,
        }),
      ).to.equal(false)
    })

    it('terminates even if a forceLimit send somehow reports MARKET', () => {
      expect(
        shouldFallBackToLimitEntry({
          sentType: OrderTypeEnum.market,
          forceLimit: true,
          reason,
        }),
      ).to.equal(false)
    })

    it('a refused LIMIT send falls through to the generic handler', () => {
      expect(
        shouldFallBackToLimitEntry({
          sentType: OrderTypeEnum.limit,
          forceLimit: false,
          reason,
        }),
      ).to.equal(false)
    })

    it('an unrelated MARKET rejection is not a limit-only fallback', () => {
      expect(
        shouldFallBackToLimitEntry({
          sentType: OrderTypeEnum.market,
          forceLimit: false,
          reason: 'NOTIONAL',
        }),
      ).to.equal(false)
    })
  })
})
