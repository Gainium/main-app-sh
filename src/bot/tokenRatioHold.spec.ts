process.env.NODE_ENV = 'testing'
import { expect } from 'chai'
import {
  priceJumpFactor,
  tokenRatioVerdict,
  tokenRatioHeldMessage,
  TokenRatioEvidence,
} from './tokenRatioHold'

/**
 * Spec 296 — a deal is held only when its pair's price AND the account's base
 * balance both jumped by a like factor that no recorded fill explains.
 */
describe('tokenRatioHold (spec 296)', () => {
  const base: TokenRatioEvidence = {
    avgPrice: 870.655,
    price: 72.36,
    baselineBase: 0.0128,
    venueBase: 0.0128 * 8,
    buysSince: 0,
    sellsSince: 0,
  }

  it('§3.1 holds an SNDKB-shaped split: price ~12x down, balance 8x up', () => {
    const v = tokenRatioVerdict(base)
    expect(v.hold).to.equal(true)
    if (v.hold) {
      expect(v.balanceFactor).to.be.closeTo(8, 1e-9)
      expect(v.priceFactor).to.be.closeTo(870.655 / 72.36, 1e-9)
    }
  })

  it('§3.1 holds across the whole observed price spread (9.2x to 15.7x at ratio 8)', () => {
    for (const p of [9.16, 12, 15.7]) {
      expect(
        tokenRatioVerdict({ ...base, price: base.avgPrice / p }).hold,
      ).to.equal(true)
    }
  })

  it('§3.2 does not hold a HONEY-shaped flash crash: price -60%, balance unchanged', () => {
    const v = tokenRatioVerdict({
      ...base,
      avgPrice: 0.05,
      price: 0.02,
      baselineBase: 1000,
      venueBase: 1000,
    })
    expect(v).to.deep.equal({ hold: false, reason: 'balance did not jump' })
  })

  it('§3.2 a crash that the bot averaged into is still not held (buys are subtracted)', () => {
    // 1000 at baseline, safety orders bought 9000 more on the way down.
    const v = tokenRatioVerdict({
      avgPrice: 0.05,
      price: 0.01,
      baselineBase: 1000,
      venueBase: 10000,
      buysSince: 9000,
      sellsSince: 0,
    })
    expect(v.hold).to.equal(false)
  })

  it('§3.3 near-entry prices read nothing and never hold', () => {
    expect(priceJumpFactor(100, 60)).to.equal(null)
    expect(priceJumpFactor(100, 190)).to.equal(null)
    expect(
      tokenRatioVerdict({ ...base, price: base.avgPrice / 1.9 }),
    ).to.deep.equal({ hold: false, reason: 'price within range' })
  })

  it('§3.3 missing or zero evidence falls back to today', () => {
    for (const e of [
      { baselineBase: null },
      { baselineBase: 0 },
      { venueBase: null },
      { venueBase: NaN },
    ]) {
      expect(
        tokenRatioVerdict({ ...base, ...e } as TokenRatioEvidence),
      ).to.deep.equal({
        hold: false,
        reason: 'balance unverified',
      })
    }
  })

  it('§3.4 a balance factor far from the price factor is not held', () => {
    // price 12x down, balance 40x up: not a redenomination of this size.
    const v = tokenRatioVerdict({ ...base, venueBase: 0.0128 * 40 })
    expect(v.hold).to.equal(false)
  })

  it('§3.5 holds a reverse split: price 10x up, balance 10x down', () => {
    const v = tokenRatioVerdict({
      avgPrice: 1,
      price: 10,
      baselineBase: 500,
      venueBase: 50,
      buysSince: 0,
      sellsSince: 0,
    })
    expect(v.hold).to.equal(true)
  })

  it('§3.5 a pump the bot sold into is not held (sells are added back)', () => {
    const v = tokenRatioVerdict({
      avgPrice: 1,
      price: 10,
      baselineBase: 500,
      venueBase: 50,
      buysSince: 0,
      sellsSince: 450,
    })
    expect(v.hold).to.equal(false)
  })

  it('§3.6 the message names the pair, both factors and the way out', () => {
    const m = tokenRatioHeldMessage({
      symbol: 'SNDKBUSDT',
      priceFactor: 12,
      balanceFactor: 8,
    })
    expect(m).to.contain('SNDKBUSDT')
    expect(m).to.contain('12.0x below')
    expect(m).to.contain('8.0x larger')
    expect(m).to.contain('manual close')
  })
})
