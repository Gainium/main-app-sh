process.env.NODE_ENV = 'testing'

/**
 * Canonical fee-inclusive unrealized P&L (main-app spec 019 §5). The vectors
 * are the ones the dashboard's copy of the formula is tested with, so a
 * server value and a client value agree.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StrategyEnum } from '../../types'
import { computeDealUnrealizedNet } from './dealUnrealizedPnl'

const zero = { base: 0, quote: 0 }

const longDca = () => ({
  strategy: StrategyEnum.long,
  avgPrice: 50000,
  settings: { futures: false, coinm: false, profitCurrency: 'quote' },
  initialBalances: { base: 0, quote: 1000 },
  currentBalances: { base: 0.02, quote: 0 },
  usage: {
    current: { base: 0.02, quote: 1000 },
    max: { base: 0.02, quote: 1000 },
  },
})

const shortDca = () => ({
  strategy: StrategyEnum.short,
  avgPrice: 60000,
  settings: { futures: false, coinm: false, profitCurrency: 'quote' },
  initialBalances: { base: 1, quote: 0 },
  currentBalances: { base: 0, quote: 60000 },
  usage: { current: { base: 1, quote: 60000 }, max: { base: 1, quote: 60000 } },
})

const close = (a: number | undefined, b: number) =>
  expect(a).to.be.closeTo(b, 1e-9)

describe('fee-inclusive uPnL, DCA leg (spec 019 §5.2)', () => {
  it('LONG: gross 100, usage 1000, fee 2 → 98, 9.8 %', () => {
    const r = computeDealUnrealizedNet(longDca(), 55000, 1, 0.001, false)
    close(r?.unrealizedUsd, 98)
    close(r?.usageUsd, 1000)
    close(r?.percent, 9.8)
    close(r?.valueUsd, 1098)
  })

  it('SHORT: gross 5000, usage 55000, fee 110 → 4890', () => {
    const r = computeDealUnrealizedNet(shortDca(), 55000, 1, 0.001, false)
    close(r?.unrealizedUsd, 4890)
    close(r?.usageUsd, 55000)
    close(r?.percent, (4890 / 55000) * 100)
  })

  it('fee 0 is a known fee: uPnL = gross', () => {
    close(
      computeDealUnrealizedNet(longDca(), 55000, 1, 0, false)?.unrealizedUsd,
      100,
    )
  })

  it('unknown fee, price or USD rate → no value', () => {
    expect(computeDealUnrealizedNet(longDca(), 55000, 1, undefined, false)).to
      .be.undefined
    expect(computeDealUnrealizedNet(longDca(), undefined, 1, 0.001, false)).to
      .be.undefined
    expect(computeDealUnrealizedNet(longDca(), 55000, 0, 0.001, false)).to.be
      .undefined
  })

  it('applies the quote→USD rate exactly once', () => {
    // BTC-quoted deal at 60,000 USD per BTC, with a reduce-funds fill (the
    // branch that used to apply the rate twice).
    const deal = {
      ...longDca(),
      initialBalances: { base: 0, quote: 1 },
      currentBalances: { base: 20, quote: 0 },
      usage: { current: { base: 20, quote: 1 }, max: { base: 20, quote: 1 } },
      reduceFunds: [{ qty: 0, price: 0.05 }],
    }
    const r = computeDealUnrealizedNet(deal, 0.055, 60000, 0.001, false)
    // gross 0.1 BTC = 6000 USD; usage 1 BTC = 60000 USD; fee 120 USD
    close(r?.unrealizedUsd, 6000 - 120)
    close(r?.usageUsd, 60000)
  })

  it('reduce-funds and filled new-style TPs widen the usage basis', () => {
    const deal = {
      ...longDca(),
      reduceFunds: [{ qty: 0.001, price: 50000 }],
      tpFilledHistory: [{ qty: 0.002, price: 56000 }],
      flags: ['newMultiTp'],
    }
    const r = computeDealUnrealizedNet(deal, 55000, 1, 0.001, false)
    const usage = 1000 + 50 + 112
    close(r?.usageUsd, usage)
    close(r?.unrealizedUsd, 100 - 2 * 0.001 * usage)
  })

  it('no strategy → no value', () => {
    expect(
      computeDealUnrealizedNet(
        { ...longDca(), strategy: undefined },
        55000,
        1,
        0.001,
        false,
      ),
    ).to.be.undefined
  })
})

describe('fee-inclusive uPnL, combo leg (spec 019 §5.3)', () => {
  it('without fee ledger: profit + position P&L − closing fee, on max usage', () => {
    const deal = {
      strategy: StrategyEnum.long,
      avgPrice: 100,
      settings: { futures: false, coinm: false, profitCurrency: 'quote' },
      initialBalances: { base: 0, quote: 1000 },
      currentBalances: { base: 5, quote: 500 },
      usage: { current: { base: 5, quote: 500 }, max: zero },
      profit: { total: 10 },
    }
    deal.usage.max = { base: 10, quote: 1000 }
    const r = computeDealUnrealizedNet(deal, 110, 1, 0.001, true)
    // quote = (1000-500) + 10 = 510; total = 10 + (5*110 - 510) - 5*110*0.001
    const total = 10 + (550 - 510) - 0.55
    close(r?.unrealizedUsd, total)
    close(r?.usageUsd, 1000)
    close(r?.percent, (total / 1000) * 100)
  })

  it('with the fee ledger: subtracts the fees actually paid', () => {
    const deal = {
      strategy: StrategyEnum.long,
      avgPrice: 100,
      settings: {
        futures: false,
        coinm: false,
        profitCurrency: 'quote',
        comboTpBase: 'filled',
      },
      initialBalances: { base: 0, quote: 1000 },
      currentBalances: { base: 5, quote: 500 },
      usage: {
        current: { base: 5, quote: 500 },
        max: { base: 10, quote: 1000 },
      },
      profit: { total: 10, pureBase: 0, pureQuote: 10 },
      feePaid: { base: 0.01, quote: 0.5 },
    }
    const r = computeDealUnrealizedNet(deal, 110, 1, 0.001, true)
    const total = 550 - 500 - (0.01 * 100 + 0.5)
    close(r?.unrealizedUsd, total)
    close(r?.usageUsd, 500)
  })
})
