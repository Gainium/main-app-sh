process.env.NODE_ENV = 'testing'

/**
 * The pooled-collateral widening the funds checks apply once their per-asset
 * figure has come up short (exchange-connector spec 028).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { poolCoversQuote, widenByPool } from './pooledMargin'

describe('pooled margin — widenByPool (exchange-connector spec 028)', () => {
  it('linear: a USD pool is used as is', () => {
    expect(widenByPool(0, 50, false)).to.equal(50)
  })

  it('COIN-M: a USDT-funded pool covers an inverse order, counted in the coin', () => {
    // 100 USD of pooled collateral, DOGE at 0.25: 400 DOGE of margin.
    expect(widenByPool(0, 100, true, 0.25)).to.equal(400)
  })

  it('COIN-M: no usable price leaves the per-coin figure alone', () => {
    expect(widenByPool(3, 100, true)).to.equal(3)
    expect(widenByPool(3, 100, true, 0)).to.equal(3)
    expect(widenByPool(3, 100, true, NaN)).to.equal(3)
  })

  it('never shrinks what the per-asset check already found', () => {
    expect(widenByPool(500, 100, true, 0.25)).to.equal(500)
    expect(widenByPool(80, 50, false)).to.equal(80)
  })

  it('an empty or unreadable pool widens nothing', () => {
    expect(widenByPool(2, 0, true, 0.25)).to.equal(2)
    expect(widenByPool(2, NaN, false)).to.equal(2)
  })

  it('the USD pool covers USD and USDC quotes, nothing else', () => {
    expect(poolCoversQuote('USD')).to.equal(true)
    expect(poolCoversQuote('USDC')).to.equal(true)
    expect(poolCoversQuote('USDT')).to.equal(false)
    expect(poolCoversQuote('EUR')).to.equal(false)
    expect(poolCoversQuote('BTC')).to.equal(false)
  })
})
