process.env.NODE_ENV = 'testing'

/**
 * Per-pair leverage limits in the pair data: the connector's raw values are
 * normalised before they are stored. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { normalizePairLeverage } from './pairLeverage'

describe('normalizePairLeverage', () => {
  it('turns the venue strings into numbers', () => {
    expect(
      normalizePairLeverage({ minLeverage: '1', maxLeverage: '100' }),
    ).to.deep.equal({ minLeverage: 1, maxLeverage: 100 })
  })

  it('keeps numbers and fractional values', () => {
    expect(
      normalizePairLeverage({ minLeverage: 0.01, maxLeverage: 12.5 }),
    ).to.deep.equal({ minLeverage: 0.01, maxLeverage: 12.5 })
  })

  it('drops missing, zero, negative and unparsable values', () => {
    expect(normalizePairLeverage({})).to.deep.equal({})
    expect(
      normalizePairLeverage({ minLeverage: '0', maxLeverage: 'abc' }),
    ).to.deep.equal({})
    expect(
      normalizePairLeverage({ minLeverage: -1, maxLeverage: '' }),
    ).to.deep.equal({})
  })

  it('a max alone is kept', () => {
    expect(normalizePairLeverage({ maxLeverage: '75' })).to.deep.equal({
      maxLeverage: 75,
    })
  })

  it('a min above the max is dropped, the max kept', () => {
    expect(
      normalizePairLeverage({ minLeverage: 50, maxLeverage: 20 }),
    ).to.deep.equal({ maxLeverage: 20 })
  })
})
