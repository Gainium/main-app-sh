process.env.NODE_ENV = 'testing'

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { profitFactorOf, withGrossProfitFactors } from './profitFactor'

describe('profitFactorOf', () => {
  it('divides gross profit by gross loss, not winning by losing deal counts', () => {
    // 9 wins of +1 and 1 loss of -50: counts would say 9, money says 0.18.
    expect(profitFactorOf(9, -50)).to.be.closeTo(0.18, 1e-12)
  })

  it('accepts gross loss with either sign', () => {
    expect(profitFactorOf(30, 10)).to.equal(3)
    expect(profitFactorOf(30, -10)).to.equal(3)
  })

  it('encodes "profits, no losses" as -1 (rendered as infinity)', () => {
    expect(profitFactorOf(12.5, 0)).to.equal(-1)
  })

  it('is 0 with nothing to divide', () => {
    expect(profitFactorOf(0, 0)).to.equal(0)
    expect(profitFactorOf(0, -4)).to.equal(0)
  })

  it('treats non-finite inputs as 0 instead of storing NaN', () => {
    expect(profitFactorOf(NaN, -4)).to.equal(0)
    expect(profitFactorOf(5, NaN)).to.equal(-1)
  })
})

describe('withGrossProfitFactors', () => {
  it('recomputes a stale count-ratio bot factor from the stored gross totals', () => {
    const { stats } = withGrossProfitFactors(
      {
        numerical: {
          profit: { grossProfit: { usd: 9 } },
          loss: { grossLoss: { usd: -50 } },
          ratios: { profitFactor: 9 },
        },
      },
      null,
    )
    expect(stats.numerical.ratios.profitFactor).to.be.closeTo(0.18, 1e-12)
  })

  it('leaves stats without gross totals as they are', () => {
    const input = { numerical: { ratios: { profitFactor: 2 } } }
    expect(withGrossProfitFactors(input, null).stats).to.equal(input)
  })

  it('withholds a pair factor that has no gross totals behind it yet', () => {
    const { symbolStats } = withGrossProfitFactors(null, [
      { numerical: { general: { profitFactor: 5 } } },
      {
        numerical: {
          general: {
            profitFactor: 5,
            grossProfit: { usd: 6 },
            grossLoss: { usd: -3 },
          },
        },
      },
    ])
    expect(symbolStats?.[0]?.numerical?.general?.profitFactor).to.equal(null)
    expect(symbolStats?.[1]?.numerical?.general?.profitFactor).to.equal(2)
  })
})
