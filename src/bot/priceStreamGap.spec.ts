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

  describe('boot grace', () => {
    // A bot loads with no stream data at all; its first poll (2.5 min in)
    // sees every symbol stale, and the subscriptions only settle over the
    // next minutes. Grace = 2 × priceTimeout, anchored at bot load.
    const POLL = 2.5 * MIN
    const GRACE = 2 * POLL
    const opts = { graceMs: GRACE, startedAt: 0 }

    it('is silent for a symbol whose stream simply had not started yet', () => {
      const t = new PriceStreamGapTracker(REPEAT, opts)
      // First poll: nothing has ticked yet, served from REST, no line.
      expect(t.note('BTCUSDT', true, POLL)).to.equal(null)
      expect(t.gapped()).to.deep.equal(['BTCUSDT'])
      expect(t.reported()).to.deep.equal([])
      // The stream came up in the meantime: fresh — and the run before was
      // ours, so still ambiguous, still silent.
      expect(t.note('BTCUSDT', false, 2 * POLL)).to.equal(null)
      // Fresh again without our help: it is live. No "recovered" line for a
      // gap that was never announced.
      expect(t.note('BTCUSDT', false, 3 * POLL)).to.equal(null)
      expect(t.gapped()).to.deep.equal([])
    })

    it('still reports a symbol that has not ticked once the grace is over', () => {
      const t = new PriceStreamGapTracker(REPEAT, opts)
      expect(t.note('FLR-USDC', true, POLL)).to.equal(null)
      // Fresh only because we served it last run.
      expect(t.note('FLR-USDC', false, 2 * POLL)).to.equal(null)
      // Past the grace, still stale: announced now, dated from the first
      // stale poll.
      expect(t.note('FLR-USDC', true, 3 * POLL)).to.deep.equal({
        kind: 'entered',
      })
      expect(t.reported()).to.deep.equal(['FLR-USDC'])
      expect(t.note('FLR-USDC', false, 4 * POLL)).to.equal(null)
      expect(t.note('FLR-USDC', true, 5 * POLL)).to.equal(null)
      // The repeat interval counts from the announcement; the reported
      // duration counts from the first stale poll.
      expect(t.note('FLR-USDC', true, 3 * POLL + 61 * MIN)).to.deep.equal({
        kind: 'persisting',
        minutes: 66,
      })
      // And recovery is announced as usual once ticks arrive.
      expect(t.note('FLR-USDC', false, 3 * POLL + 62 * MIN)).to.equal(null)
      expect(t.note('FLR-USDC', false, 3 * POLL + 63 * MIN)).to.deep.equal({
        kind: 'recovered',
        minutes: 68,
      })
    })

    it('does not cover a symbol that has already been seen live', () => {
      const t = new PriceStreamGapTracker(REPEAT, opts)
      // Live tick seen inside the grace window: the subscription works, so a
      // later gap on it is real and is reported at once.
      expect(t.note('ETH-USD', false, MIN)).to.equal(null)
      expect(t.note('ETH-USD', true, 2 * MIN)).to.deep.equal({
        kind: 'entered',
      })
    })

    it('is off when no grace is configured', () => {
      const t = new PriceStreamGapTracker(REPEAT)
      expect(t.note('BTCUSDT', true, 0)).to.deep.equal({ kind: 'entered' })
    })
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
