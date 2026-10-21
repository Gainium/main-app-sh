process.env.NODE_ENV = 'testing'

/**
 * Spec 168: the fiat rates served to clients keep only entries a client can
 * convert with. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  fetchReferenceRates,
  isReportingCurrency,
  mergeFiatRates,
  usableFiatRates,
} from './fiatRates'

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

describe('mergeFiatRates — reporting-currency sources', () => {
  const now = new Date('2026-10-21T00:00:00Z')
  const old = new Date('2026-10-01T00:00:00Z')

  it('prefers live Kraken, then ECB, then open.er-api', () => {
    const out = mergeFiatRates(
      [{ asset: 'EUR', usdRate: 1.12 }],
      { ecb: { EUR: 0.9, SGD: 1.25 }, erApi: { SGD: 1.3, VND: 25000 } },
      [],
      now,
    )
    const by = (a: string) => out.find((r) => r.asset === a)
    expect(by('EUR')).to.deep.equal({
      asset: 'EUR',
      usdRate: 1.12,
      source: 'kraken',
      updated: now,
    })
    expect(by('SGD')).to.include({ source: 'ecb', usdRate: 1 / 1.25 })
    expect(by('VND')).to.include({ source: 'erApi', usdRate: 1 / 25000 })
  })

  it('carries a previous rate forward with its old timestamp when every source misses', () => {
    const out = mergeFiatRates([], { ecb: {}, erApi: {} }, [
      { asset: 'IDR', usdRate: 0.00006, source: 'ecb', updated: old },
    ])
    expect(out).to.deep.equal([
      { asset: 'IDR', usdRate: 0.00006, source: 'ecb', updated: old },
    ])
  })

  it('omits a currency no source has ever priced', () => {
    const out = mergeFiatRates([], { ecb: {}, erApi: {} }, [])
    expect(out).to.deep.equal([])
  })
})

describe('fetchReferenceRates', () => {
  it('keeps the ECB set and records the fallback failure', async () => {
    const r = await fetchReferenceRates({
      ecb: async () => ({ EUR: 0.9 }),
      erApi: async () => {
        throw new Error('timeout')
      },
    })
    expect(r.ecb).to.deep.equal({ EUR: 0.9 })
    expect(r.erApi).to.deep.equal({})
    expect(r.errors).to.deep.equal(['open.er-api: timeout'])
  })

  it('isReportingCurrency accepts USD and the curated list only', () => {
    expect(isReportingCurrency('USD')).to.equal(true)
    expect(isReportingCurrency('SGD')).to.equal(true)
    expect(isReportingCurrency('USDT')).to.equal(false)
  })
})
