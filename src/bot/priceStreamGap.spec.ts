process.env.NODE_ENV = 'testing'

/**
 * A symbol served by the REST fallback instead of the live price stream must
 * be reported once when it starts, periodically while it lasts, and once when
 * it ends — and must NOT flap, because the fallback's own price injection makes
 * the symbol look fresh on the following run.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { PriceStreamGapTracker } from './priceStreamGap'

const MIN = 60 * 1000
const REPEAT = 60 * MIN

describe('PriceStreamGapTracker', () => {
  it('reports the gap once when a symbol first falls back to REST', () => {
    const t = new PriceStreamGapTracker(REPEAT)
    expect(t.note('FLR-USDC', true, 0)).to.deep.equal({ kind: 'entered' })
    expect(t.note('FLR-USDC', true, 5 * MIN)).to.equal(null)
    expect(t.gapped()).to.deep.equal(['FLR-USDC'])
  })

  it('does not flap on the freshness the fallback itself wrote', () => {
    const t = new PriceStreamGapTracker(REPEAT)
    // A permanently dead stream alternates stale/fresh every 2.5 min because
    // the REST injection is itself only 2.5 min old on the next run.
    expect(t.note('FLR-USDC', true, 0)).to.deep.equal({ kind: 'entered' })
    for (let i = 1; i <= 20; i++) {
      const stale = i % 2 === 0
      expect(t.note('FLR-USDC', stale, i * 2.5 * MIN)).to.equal(null)
    }
    expect(t.gapped()).to.deep.equal(['FLR-USDC'])
  })

  it('repeats at most once per repeat interval while the gap persists', () => {
    const t = new PriceStreamGapTracker(REPEAT)
    t.note('FLR-USDC', true, 0)
    expect(t.note('FLR-USDC', true, 30 * MIN)).to.equal(null)
    expect(t.note('FLR-USDC', true, 61 * MIN)).to.deep.equal({
      kind: 'persisting',
      minutes: 61,
    })
    expect(t.note('FLR-USDC', true, 62 * MIN)).to.equal(null)
  })

  it('declares recovery only on a fresh run we did not serve', () => {
    const t = new PriceStreamGapTracker(REPEAT)
    t.note('FLR-USDC', true, 0)
    // First fresh run is ambiguous — our own injection could explain it.
    expect(t.note('FLR-USDC', false, 2.5 * MIN)).to.equal(null)
    expect(t.note('FLR-USDC', false, 5 * MIN)).to.deep.equal({
      kind: 'recovered',
      minutes: 5,
    })
    expect(t.gapped()).to.deep.equal([])
  })

  it('stays silent for a symbol that never left the live stream', () => {
    const t = new PriceStreamGapTracker(REPEAT)
    expect(t.note('BTCUSDT', false, 0)).to.equal(null)
    expect(t.note('BTCUSDT', false, 10 * MIN)).to.equal(null)
    expect(t.gapped()).to.deep.equal([])
  })

  it('tracks symbols independently', () => {
    const t = new PriceStreamGapTracker(REPEAT)
    expect(t.note('FLR-USDC', true, 0)).to.deep.equal({ kind: 'entered' })
    expect(t.note('BTCUSDT', false, 0)).to.equal(null)
    expect(t.note('ETH-USD', true, MIN)).to.deep.equal({ kind: 'entered' })
    expect(t.gapped().sort()).to.deep.equal(['ETH-USD', 'FLR-USDC'])
    t.forget('FLR-USDC')
    expect(t.gapped()).to.deep.equal(['ETH-USD'])
  })
})
