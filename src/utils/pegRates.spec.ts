process.env.NODE_ENV = 'testing'

/**
 * Spec 158: BNFCR is valued at 1 USD in the portfolio snapshot's rate table, so
 * a Multi-Assets account's negative BNFCR lowers its USD value. Run: `npm test`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import type { Prices } from '../../types'
import utils from './index'
import { pegRateEntries } from './pegRates'

const { findUSDRate } = utils

// The venue table the snapshot builds for binanceUsdm, plus the `all` entries
// `userSnapshots` / `priceBalancesUsd` append.
const venue: Prices = [
  { pair: 'BNBUSDT', price: 725, exchange: 'binanceUsdm' },
  { pair: 'USDCUSDT', price: 0.9994, exchange: 'binanceUsdm' },
]
const usdt: Prices = [{ pair: 'USDTZUSD', price: 0.99967, exchange: 'all' }]
const before = [...venue, ...usdt]
const after = [...venue, ...usdt, ...pegRateEntries]

// The snapshot loop's valuation of one account (user.ts, `userSnapshots`):
// rows whose USD value is 0 are skipped.
const accountUsd = (rows: { asset: string; amount: number }[], rates: Prices) =>
  rows.reduce((sum, r) => {
    const amountUsd = r.amount * findUSDRate(r.asset, rates, 'binanceUsdm')
    return amountUsd ? sum + amountUsd : sum
  }, 0)

const account = [
  { asset: 'USDC', amount: 22624.98 },
  { asset: 'BNB', amount: 0.69 },
  { asset: 'BNFCR', amount: -4250.73 },
]

describe('spec 158 — BNFCR in the snapshot rate table', () => {
  it('§1.1 values BNFCR at 1 USD', () => {
    expect(findUSDRate('BNFCR', after, 'binanceUsdm')).to.equal(1)
  })

  it('§1.1 the account value is net of the BNFCR debt', () => {
    const positive = accountUsd(account.slice(0, 2), after)
    expect(accountUsd(account, after)).to.be.closeTo(positive - 4250.73, 1e-6)
    // Today, without the entry, the debt is dropped entirely.
    expect(accountUsd(account, before)).to.be.closeTo(positive, 1e-6)
  })

  it('§1.3 leaves every other asset priced as before', () => {
    for (const asset of ['USDC', 'BNB', 'USDT', 'USD', 'BTC']) {
      expect(findUSDRate(asset, after, 'binanceUsdm')).to.equal(
        findUSDRate(asset, before, 'binanceUsdm'),
      )
    }
  })

  it('§1.3 the entry only names BNFCR', () => {
    expect(pegRateEntries.map((p) => p.pair)).to.deep.equal(['BNFCRUSD'])
    expect(pegRateEntries.every((p) => p.exchange === 'all')).to.equal(true)
  })
})
