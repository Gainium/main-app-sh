import { describe, it } from 'mocha'
import { expect } from 'chai'
import { spotShortfallVerdict } from './spotBaseShortfall'

describe('spec 298 — spotShortfallVerdict', () => {
  const v = (venueTotal: number | null, remaining: number, minAmount = 0.01) =>
    spotShortfallVerdict({ venueTotal, remaining, minAmount })

  it('unreadable balance decides nothing', () => {
    expect(v(null, 10).kind).to.equal('unknown')
    expect(v(5, 10, 0).kind).to.equal('unknown')
  })

  it('a holding under the pair minimum is left to spec 047', () => {
    expect(v(0, 10).kind).to.equal('gone')
    expect(v(0.005, 10).kind).to.equal('gone')
  })

  it('TOTAL covering the deal is covered — locked coin counts (DOT case)', () => {
    // total 46.5 (free 4.15 + locked), needed 44.35
    expect(v(46.5, 44.35).kind).to.equal('covered')
  })

  it('short by less than one tradeable unit is covered', () => {
    expect(v(9.995, 10).kind).to.equal('covered')
  })

  it('above the minimum and below the deal is short, by the difference', () => {
    const r = v(4, 10)
    expect(r.kind).to.equal('short')
    expect((r as any).missing).to.be.closeTo(6, 1e-12)
  })
})
