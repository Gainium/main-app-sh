process.env.NODE_ENV = 'testing'

/**
 * Core spec 070 — an order event drives the REST balance refresh on a venue
 * whose stream carries no hold. Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import { createHoldRefresh, holdFromRestOnly } from './holdRefresh'

/** A hand-driven clock: nothing here should depend on real time passing. */
const fakeClock = () => {
  let next = 1
  const due: Map<number, { fn: () => void; at: number }> = new Map()
  let now = 0
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      due.set(id, { fn, at: now + ms })
      return id as unknown as NodeJS.Timeout
    },
    clearTimer: (timer: NodeJS.Timeout) => {
      due.delete(timer as unknown as number)
    },
    advance: (ms: number) => {
      now += ms
      for (const [id, entry] of [...due.entries()]) {
        if (entry.at <= now) {
          due.delete(id)
          entry.fn()
        }
      }
    },
    armed: () => due.size,
  }
}

/** The refresh runs on a microtask after its timer fires; let it land. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('holdRefresh (spec 070)', () => {
  it('§4.1 schedules one refresh for an order event on a hold-from-REST venue', async () => {
    const clock = fakeClock()
    const refreshed: string[] = []
    const holdRefresh = createHoldRefresh({ windowMs: 5000, ...clock })

    expect(
      holdRefresh.schedule(
        ExchangeEnum.kraken,
        'uuid-1',
        'executionReport',
        () => refreshed.push('uuid-1'),
      ),
    ).to.equal(true)
    expect(refreshed).to.deep.equal([], 'not before the window closes')

    clock.advance(5000)
    await flush()
    expect(refreshed).to.deep.equal(['uuid-1'])
  })

  it('§4.2 collapses a burst into a single refresh per connection', async () => {
    const clock = fakeClock()
    const refreshed: string[] = []
    const holdRefresh = createHoldRefresh({ windowMs: 5000, ...clock })

    for (let i = 0; i < 20; i++) {
      holdRefresh.schedule(
        ExchangeEnum.kraken,
        'uuid-1',
        'executionReport',
        () => refreshed.push('uuid-1'),
      )
    }
    expect(holdRefresh.pending()).to.equal(1)

    clock.advance(5000)
    await flush()
    expect(refreshed).to.deep.equal(['uuid-1'])

    // The window is over: the next order event earns its own refresh.
    holdRefresh.schedule(ExchangeEnum.kraken, 'uuid-1', 'executionReport', () =>
      refreshed.push('uuid-1'),
    )
    clock.advance(5000)
    await flush()
    expect(refreshed).to.deep.equal(['uuid-1', 'uuid-1'])
  })

  it('§4.3 keeps connections independent', async () => {
    const clock = fakeClock()
    const refreshed: string[] = []
    const holdRefresh = createHoldRefresh({ windowMs: 5000, ...clock })

    holdRefresh.schedule(ExchangeEnum.kraken, 'uuid-1', 'executionReport', () =>
      refreshed.push('uuid-1'),
    )
    holdRefresh.schedule(ExchangeEnum.kraken, 'uuid-2', 'executionReport', () =>
      refreshed.push('uuid-2'),
    )
    expect(holdRefresh.pending()).to.equal(2)

    clock.advance(5000)
    await flush()
    expect(refreshed.sort()).to.deep.equal(['uuid-1', 'uuid-2'])
  })

  it('§4.4 ignores balance events and every venue that streams its own hold', async () => {
    const clock = fakeClock()
    const refreshed: string[] = []
    const holdRefresh = createHoldRefresh({ windowMs: 5000, ...clock })
    const run = () => refreshed.push('x')

    expect(
      holdRefresh.schedule(
        ExchangeEnum.kraken,
        'uuid-1',
        'outboundAccountPosition',
        run,
      ),
    ).to.equal(false)
    expect(
      holdRefresh.schedule(ExchangeEnum.kraken, 'uuid-1', undefined, run),
    ).to.equal(false)
    expect(
      holdRefresh.schedule(
        ExchangeEnum.binance,
        'uuid-2',
        'executionReport',
        run,
      ),
    ).to.equal(false)
    expect(
      holdRefresh.schedule(
        ExchangeEnum.krakenUsdm,
        'uuid-3',
        'executionReport',
        run,
      ),
    ).to.equal(false)

    clock.advance(60000)
    await flush()
    expect(refreshed).to.deep.equal([])
    expect(clock.armed()).to.equal(0)
  })

  it('§4.5 cancel drops a pending refresh for a disconnected connection', async () => {
    const clock = fakeClock()
    const refreshed: string[] = []
    const holdRefresh = createHoldRefresh({ windowMs: 5000, ...clock })

    holdRefresh.schedule(ExchangeEnum.kraken, 'uuid-1', 'executionReport', () =>
      refreshed.push('uuid-1'),
    )
    holdRefresh.cancel('uuid-1')
    expect(holdRefresh.pending()).to.equal(0)
    expect(clock.armed()).to.equal(0)

    clock.advance(5000)
    await flush()
    expect(refreshed).to.deep.equal([])
  })

  it('§4.6 a failing refresh is contained and does not block the next one', async () => {
    const clock = fakeClock()
    const errors: string[] = []
    const holdRefresh = createHoldRefresh({
      windowMs: 5000,
      ...clock,
      onError: (uuid) => errors.push(uuid),
    })

    holdRefresh.schedule(ExchangeEnum.kraken, 'uuid-1', 'executionReport', () =>
      Promise.reject(new Error('connector down')),
    )
    clock.advance(5000)
    await flush()
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).to.deep.equal(['uuid-1'])

    const refreshed: string[] = []
    expect(
      holdRefresh.schedule(
        ExchangeEnum.kraken,
        'uuid-1',
        'executionReport',
        () => refreshed.push('uuid-1'),
      ),
    ).to.equal(true)
    clock.advance(5000)
    await flush()
    expect(refreshed).to.deep.equal(['uuid-1'])
  })

  it('names Kraken spot, and only Kraken spot, as hold-from-REST', () => {
    expect([...holdFromRestOnly]).to.deep.equal([ExchangeEnum.kraken])
  })
})
