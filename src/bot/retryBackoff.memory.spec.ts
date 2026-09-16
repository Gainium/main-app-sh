process.env.NODE_ENV = 'testing'

/**
 * `RetryBackoff.memoryMs`: a caller slower than the window must still see the
 * previous interval and escalate, or a dead key is re-sent on every visit.
 *
 * Drives the REAL `RetryBackoff` against a Map-backed fake Redis that honours
 * TTLs, with a controllable clock. Nothing here touches Redis or a venue.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import RedisClient from '../db/redis'
import RetryBackoff from './retryBackoff'

const MIN = 5 * 60 * 1000
const MAX = 60 * 60 * 1000
const CYCLE = 15 * 60 * 1000

type Row = { v: string; expiresAt: number }
const store = new Map<string, Row>()

/**
 * `RetryBackoff` reads the clock with `+new Date()`, so instead of faking time
 * the test REWINDS every stored window by the elapsed amount — the same trick
 * `tpDustClose.harness.spec.ts` uses — and expires TTLs the same way.
 */
const elapse = (ms: number) => {
  for (const [k, r] of store) {
    const expiresAt = r.expiresAt - ms
    if (expiresAt <= Date.now()) {
      store.delete(k)
      continue
    }
    const state = JSON.parse(r.v)
    store.set(k, {
      v: JSON.stringify({ ...state, until: state.until - ms }),
      expiresAt,
    })
  }
}

const fakeRedis = {
  get: async (k: string) => store.get(k)?.v ?? null,
  set: async (k: string, v: string, ttlSec?: number) => {
    store.set(k, {
      v,
      expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : Number.MAX_SAFE_INTEGER,
    })
  },
  del: async (k: string) => {
    store.delete(k)
  },
}

/** Drive a caller that records on every unsuppressed visit, `visits` times. */
async function drive(b: RetryBackoff, cadence: number, visits: number) {
  const sent: number[] = []
  for (let i = 0; i < visits; i++) {
    const c = await b.check(['acct'])
    if (!c.suppressed) {
      sent.push(i)
      await b.record(['acct'], 'EAPI:Invalid key')
    }
    elapse(cadence)
  }
  return sent
}

describe('RetryBackoff memoryMs — slow callers still escalate', () => {
  beforeEach(() => {
    store.clear()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  it('default memory: a 15 min caller is never suppressed (the pre-fix defect)', async () => {
    const b = new RetryBackoff({ namespace: 't', minMs: MIN, maxMs: MAX })
    const sent = await drive(b, CYCLE, 8)
    // 8 visits over 2 h, every one of them went to the venue.
    expect(sent).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('memoryMs above maxMs: the same caller escalates and settles near hourly', async () => {
    const b = new RetryBackoff({
      namespace: 't',
      minMs: MIN,
      maxMs: MAX,
      memoryMs: 2 * MAX,
    })
    const sent = await drive(b, CYCLE, 16) // 4 h of 15-min visits
    // Windows 5→10 min are shorter than the cadence, so visits 0-2 are sent;
    // the 20 min window opened at t=30 still covers t=45, which is the first
    // suppressed visit. From then on the ceiling (60 min) keeps it ~hourly.
    expect(sent.slice(0, 3)).to.deep.equal([0, 1, 2])
    expect(sent).to.not.include(3)
    expect(sent.length).to.be.at.most(7)
    const lastHour = sent.filter((i) => i >= 12)
    expect(lastHour.length).to.be.at.most(1)
  })

  it('does not lengthen suppression itself: until is still the window', async () => {
    const b = new RetryBackoff({
      namespace: 't',
      minMs: MIN,
      maxMs: MAX,
      memoryMs: 2 * MAX,
    })
    const before = Date.now()
    const s = await b.record(['acct'], 'x')
    expect(s.until - before).to.be.within(MIN, MIN + 1000)
    elapse(MIN + 1000)
    const c = await b.check(['acct'])
    expect(c.suppressed).to.equal(false)
  })
})
