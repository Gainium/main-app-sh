process.env.NODE_ENV = 'testing'

/**
 * Which venue rejections count as "the account could not fund this order".
 *
 * `notEnoughErrors` is substring-matched against whatever string the venue
 * sent back, and that list IS the behaviour: four separate mechanisms are
 * gated on it — the coalesced "Not enough balance" bot message
 * (`handleOrderErrors`), the refused-order backoff and size memory
 * (`sendGridToExchange`), the spec-015 fee-sizing fallback and adaptive close.
 * A venue whose wording is absent gets none of them: its rejection surfaces as
 * a hard bot error and the same unfundable order is re-sent on the next tick.
 *
 * That is what happened to Kraken spot (`EOrder:Insufficient funds`) and
 * Hyperliquid perps (`insufficient margin to place order`), neither of which
 * matched any of the twelve original patterns. Those two, and every string in
 * `OTHER_REJECTIONS`, are copied verbatim from production rejection logs. The
 * remaining `FUNDING_REJECTIONS` entries are representative wordings for
 * patterns that were already on the list, kept so that removing one fails.
 *
 * Note this list deliberately does NOT carry a bare 'insufficient' token. A
 * generic pattern would also catch coin-m margin rejections, where a wallet
 * balance is denominated in the base coin and adaptive close would compare
 * coins against contracts. That case is held shut by the `!this.futures` gate
 * in `dcaHelper.closeDealById`, not here — but keeping the patterns narrow is
 * what stops the two guards from being needed at the same time.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { matchesNotEnoughBalance, notEnoughErrors } from './main'

/**
 * Rejections that mean the account cannot fund the order. The first two are
 * verbatim production strings — and, in the September logs, the ONLY funding
 * rejections any venue actually sent; the rest exercise patterns that were
 * already listed but went unseen in that window.
 */
const FUNDING_REJECTIONS: Array<[string, string]> = [
  ['Kraken spot', 'EOrder:Insufficient funds'],
  [
    'Hyperliquid perps',
    'order 41: insufficient margin to place order. asset=41',
  ],
  ['Binance futures', 'Margin is insufficient.'],
  ['Bybit', 'Insufficient balance'],
  ['OKX', 'Order failed. Insufficient account balance'],
  ['Coinbase', 'insufficientAvailableFunds'],
  ['KuCoin', 'ab not enough for new order'],
]

/**
 * Rejections from the same production logs that are NOT funding problems.
 * These guard the other direction: a pattern broad enough to sweep one of
 * these in would route a reduce-only or permissions failure into the
 * balance-backoff path, where it would be retried and coalesced instead of
 * reported.
 */
const OTHER_REJECTIONS: string[] = [
  "Order failed because you don't have any positions in this direction for this contract to reduce or close. ",
  'order 41: reduce only order would increase position. asset=41',
  'ReduceOnly Order is rejected.',
  'current position is zero, cannot fix reduce-only order qty',
  'Filter failure: NOTIONAL',
  'Order value exceeded lower limit.',
  'Invalid API-key, IP, or permissions for action.',
  'Your api key has expired.',
]

describe('notEnoughErrors', () => {
  describe('funding rejections are recognised', () => {
    for (const [venue, reason] of FUNDING_REJECTIONS) {
      it(`${venue}: ${reason}`, () => {
        expect(matchesNotEnoughBalance(reason)).to.equal(true)
      })
    }
  })

  describe('non-funding rejections are left alone', () => {
    for (const reason of OTHER_REJECTIONS) {
      it(reason.trim(), () => {
        expect(matchesNotEnoughBalance(reason)).to.equal(false)
      })
    }
  })

  it('matches regardless of the case the venue used', () => {
    expect(matchesNotEnoughBalance('eorder:insufficient funds')).to.equal(true)
    expect(matchesNotEnoughBalance('EORDER:INSUFFICIENT FUNDS')).to.equal(true)
  })

  it('carries no bare "insufficient" or "funds" catch-all', () => {
    // A pattern this short would match every coin-m margin rejection too, and
    // adaptive close cannot size those. If a venue needs adding, add ITS
    // wording — see this file's header.
    const tooBroad = ['insufficient', 'funds', 'not enough', 'margin']
    for (const pattern of notEnoughErrors) {
      expect(
        tooBroad.includes(pattern.trim().toLowerCase()),
        `"${pattern}" is too broad to substring-match venue rejections`,
      ).to.equal(false)
    }
  })
})
