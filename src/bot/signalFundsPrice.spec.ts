process.env.NODE_ENV = 'testing'

/**
 * `addFunds` / `reduceFunds` webhook `price`: a resting limit order instead of
 * a market order.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { parseSignalFundsPrice } from './signalFundsPrice'

describe('parseSignalFundsPrice', () => {
  it('no price → market order, no symbol needed', () => {
    expect(parseSignalFundsPrice({ action: 'addFunds' })).to.deep.equal({
      needsSymbol: false,
    })
    expect(parseSignalFundsPrice({ price: null })).to.deep.equal({
      needsSymbol: false,
    })
  })

  it('accepts numbers and numeric strings', () => {
    expect(
      parseSignalFundsPrice({ price: 61234.5, symbol: 'BTCUSDT' }),
    ).to.deep.equal({
      price: '61234.5',
      needsSymbol: false,
    })
    expect(
      parseSignalFundsPrice({ price: ' 0.0123 ', symbol: 'X' }).price,
    ).to.equal('0.0123')
  })

  it('flags a missing symbol so multi-pair bots can refuse', () => {
    expect(parseSignalFundsPrice({ price: '10' }).needsSymbol).to.equal(true)
    expect(
      parseSignalFundsPrice({ price: '10', symbol: ' ' }).needsSymbol,
    ).to.equal(true)
  })

  it('rejects a price that rendered empty, NaN, zero or negative', () => {
    for (const price of ['', '{{close}}', 'NaN', 0, '-5', {}, true]) {
      const r = parseSignalFundsPrice({ price })
      expect(r.error, JSON.stringify(price)).to.match(/^Invalid "price"/)
      expect(r.price).to.equal(undefined)
    }
  })
})
