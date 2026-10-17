process.env.NODE_ENV = 'testing'

/**
 * Spec 168: the fiat rates served to clients keep only entries a client can
 * convert with. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { usableFiatRates } from './fiatRates'

describe('usableFiatRates (spec 168 §2)', () => {
  it('§2.1 returns an empty list when the rate doc has no fiat rates', () => {
    expect(usableFiatRates(undefined)).to.deep.equal([])
    expect(usableFiatRates(null)).to.deep.equal([])
    expect(usableFiatRates([])).to.deep.equal([])
  })

  it('§2.2 keeps valid entries unchanged and in order', () => {
    const rates = [
      { asset: 'EUR', usdRate: 1.16 },
      { asset: 'JPY', usdRate: 0.0066 },
    ]
    expect(usableFiatRates(rates)).to.deep.equal(rates)
  })

  it('§2.3 drops entries with no asset or a non-positive rate', () => {
    const rates = [
      { asset: 'EUR', usdRate: 1.16 },
      { asset: '', usdRate: 1.3 },
      { asset: 'GBP', usdRate: 0 },
      { asset: 'CHF', usdRate: -1 },
      { asset: 'CAD', usdRate: Number.NaN },
    ]
    expect(usableFiatRates(rates)).to.deep.equal([
      { asset: 'EUR', usdRate: 1.16 },
    ])
  })
})
