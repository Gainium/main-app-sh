process.env.NODE_ENV = 'testing'

/**
 * A rate-limited reconcile lookup is retried instead of skipping the order,
 * one rate-limited batch call no longer turns batching off for the process,
 * and reconcile lookups are paced per exchange account.
 *
 * The rate-limit reply below is the venue's own wording as the connector
 * relays it; nothing else in this file comes from a real account.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import MainBot, {
  isReconcileDeferred,
  reconcileDeferredReason,
  reconcileLookup,
  reconcileRetryDecision,
} from './main'
import { accountPaceWaitMs, paceAccountLookup } from './reconcilePacing'

const rateLimited = {
  status: StatusEnum.notok,
  reason: 'Exchange connector | Too many visits. Exceeded the API Rate Limit.',
  // The venue refusal arrives WITH data — this is what was read as "done".
  data: { code: 10006 },
}
const ok = { status: StatusEnum.ok, reason: null, data: { status: 'FILLED' } }

describe('reconcileRetryDecision', () => {
  it('is done only for an OK answer that carries the order', () => {
    expect(reconcileRetryDecision(ok)).to.equal('done')
    expect(
      reconcileRetryDecision({ status: StatusEnum.ok, data: null }),
    ).to.equal('retry')
  })
  it('retries a rate limit, even with data and the transport marker', () => {
    expect(reconcileRetryDecision(rateLimited)).to.equal('retry')
    expect(
      reconcileRetryDecision({
        status: StatusEnum.notok,
        reason: 'Too many requests',
        data: null,
      }),
    ).to.equal('retry')
  })
  it('retries any other non-ok answer, data or not', () => {
    expect(
      reconcileRetryDecision({
        status: StatusEnum.notok,
        reason: 'Internal error',
        data: { a: 1 },
      }),
    ).to.equal('retry')
  })
  it('stops on a definitive not-found and on an exhausted transport', () => {
    expect(
      reconcileRetryDecision({
        status: StatusEnum.notok,
        reason: 'Order not found after execution',
        data: null,
      }),
    ).to.equal('stop')
    expect(
      reconcileRetryDecision({
        status: StatusEnum.notok,
        reason: 'Exchange connector | Bad Gateway',
        data: null,
      }),
    ).to.equal('stop')
  })
})

describe('reconcileLookup on a rate limit', () => {
  it('re-asks after a longer backoff and returns the order once it is read', async () => {
    const answers = [rateLimited, rateLimited, ok]
    const sleeps: number[] = []
    let spent = 0
    const res = await reconcileLookup(async () => answers.shift(), {
      attempts: 3,
      backoffMs: 750,
      rateLimitBackoffMs: 1500,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 0.5,
      onAttempts: (n) => (spent = n),
    })
    expect(res).to.equal(ok)
    expect(spent).to.equal(3)
    // 1500 then 3000 (x1 jitter at random 0.5): a few seconds in all.
    expect(sleeps).to.deep.equal([1500, 3000])
  })
  it('keeps the ordinary step for other failures', async () => {
    const sleeps: number[] = []
    await reconcileLookup(
      async () => ({ status: StatusEnum.notok, reason: 'x', data: null }),
      {
        attempts: 3,
        backoffMs: 750,
        rateLimitBackoffMs: 1500,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        random: () => 0.5,
      },
    )
    expect(sleeps).to.deep.equal([750, 1500])
  })
})

describe('accountPaceWaitMs', () => {
  it('lets a lookup through while the window has room', () => {
    expect(accountPaceWaitMs(10, 10, 5_400, 0)).to.equal(0)
  })
  it('sends the first lookup over the limit to the next window, with jitter', () => {
    expect(accountPaceWaitMs(11, 10, 5_400, 0)).to.equal(600)
    expect(accountPaceWaitMs(11, 10, 5_400, 0.999)).to.equal(849)
  })
  it('never waits when pacing is off', () => {
    expect(accountPaceWaitMs(1_000, 0, 5_400, 0)).to.equal(0)
  })
})

describe('paceAccountLookup', () => {
  const clock = () => {
    let t = 1_000_000
    const counts = new Map<string, number>()
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms
      },
      incr: async (k: string) => {
        const n = (counts.get(k) ?? 0) + 1
        counts.set(k, n)
        return n
      },
      expire: async () => undefined,
      random: () => 0,
      maxWaitMs: 60_000,
    }
  }
  it('spreads one busy account at the limit per second', async () => {
    const c = clock()
    const waits: number[] = []
    for (let i = 0; i < 25; i++) {
      const r = await paceAccountLookup('acct-many', { ...c, limit: 10 })
      expect(r.admitted).to.equal(true)
      waits.push(r.waitedMs)
    }
    expect(waits.slice(0, 10).every((w) => w === 0)).to.equal(true)
    expect(waits[10]).to.equal(1000)
    // 25 lookups at 10/s finish in the third second.
    expect(c.now() - 1_000_000).to.equal(2000)
  })
  it('does not delay an account that stays under its limit', async () => {
    const c = clock()
    for (let i = 0; i < 9; i++) {
      const r = await paceAccountLookup('acct-one', { ...c, limit: 10 })
      expect(r).to.deep.equal({ waitedMs: 0, admitted: true })
    }
    const other = await paceAccountLookup('acct-other', { ...c, limit: 10 })
    expect(other.waitedMs).to.equal(0)
  })
  it('counts in-process when Redis is unavailable', async () => {
    const c = clock()
    const waits: number[] = []
    for (let i = 0; i < 3; i++) {
      const r = await paceAccountLookup('acct-local', {
        ...c,
        incr: async () => undefined,
        limit: 2,
      })
      waits.push(r.waitedMs)
    }
    expect(waits).to.deep.equal([0, 0, 1000])
  })
  it('defers instead of going ahead when the wait would pass the deadline', async () => {
    const c = clock()
    const r = await paceAccountLookup('acct-stuck', {
      ...c,
      incr: async () => 99,
      limit: 1,
      maxWaitMs: 2500,
    })
    expect(r.admitted).to.equal(false)
    expect(r.waitedMs).to.be.at.most(2500)
  })
})

describe('a deferred lookup', () => {
  it('is not retried and is not a venue answer', () => {
    const deferred = {
      status: StatusEnum.notok,
      reason: reconcileDeferredReason,
      data: null,
    }
    expect(isReconcileDeferred(deferred)).to.equal(true)
    expect(reconcileRetryDecision(deferred)).to.equal('stop')
    expect(isReconcileDeferred(rateLimited)).to.equal(false)
  })
})

describe('primeReconcileBatch latch', () => {
  const harness = (reason: string) => {
    const bot: any = Object.create((MainBot as any).prototype)
    let calls = 0
    bot.data = { exchange: ExchangeEnum.bybit }
    bot.handleDebug = () => undefined
    bot.venueOrderId = (id: string) => id
    bot.exchange = {
      getOrdersBatch: async () => {
        calls++
        return { status: StatusEnum.notok, reason, data: null }
      },
    }
    const orders = [
      { clientOrderId: 'a', symbol: 'BTCUSDT' },
      { clientOrderId: 'b', symbol: 'BTCUSDT' },
    ]
    return { bot, orders, calls: () => calls }
  }
  it('keeps batching armed after a rate-limited batch call', async () => {
    const h = harness(rateLimited.reason)
    await h.bot.primeReconcileBatch(h.orders)
    await h.bot.primeReconcileBatch(h.orders)
    expect(h.calls()).to.equal(2)
  })
  it('stops asking once the venue says it cannot batch', async () => {
    const h = harness('Batch order lookup not supported')
    h.bot.data = { exchange: ExchangeEnum.kucoin }
    await h.bot.primeReconcileBatch(h.orders)
    await h.bot.primeReconcileBatch(h.orders)
    expect(h.calls()).to.equal(1)
  })
})
