process.env.NODE_ENV = 'testing'

/**
 * The per-account funding lock (main-app spec 044 §8, D5) over an in-memory
 * store with the same SET NX PX / compare-and-delete semantics as Redis.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import { FundingLock, MemoryFundingLockStore } from './fundingLock'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('FundingLock (main-app spec 044 §8)', () => {
  let lock: FundingLock
  let store: MemoryFundingLockStore

  beforeEach(() => {
    lock = new FundingLock()
    store = new MemoryFundingLockStore()
    lock.setStore(store)
    lock.ttlMs = 5_000
    lock.waitMs = 5_000
  })

  it('serialises sections on one account', async () => {
    let inside = 0
    let maxInside = 0
    const order: string[] = []
    const section = (name: string) => async () => {
      inside++
      maxInside = Math.max(maxInside, inside)
      order.push(`${name}:in`)
      await sleep(30)
      order.push(`${name}:out`)
      inside--
      return name
    }
    const [a, b] = await Promise.all([
      lock.run('acc', section('a')),
      lock.run('acc', section('b')),
    ])
    expect(maxInside).to.equal(1)
    expect(a).to.deep.equal({ acquired: true, value: 'a' })
    expect(b).to.deep.equal({ acquired: true, value: 'b' })
    expect(order).to.deep.equal(['a:in', 'a:out', 'b:in', 'b:out'])
    expect(store.held(lock.key('acc'))).to.equal(false)
  })

  it('different accounts do not wait for each other', async () => {
    let inside = 0
    let maxInside = 0
    const section = async () => {
      inside++
      maxInside = Math.max(maxInside, inside)
      await sleep(30)
      inside--
    }
    await Promise.all([lock.run('a', section), lock.run('b', section)])
    expect(maxInside).to.equal(2)
  })

  it('is released when the section throws', async () => {
    let caught: unknown
    try {
      await lock.run('acc', async () => {
        throw new Error('boom')
      })
    } catch (e) {
      caught = e
    }
    expect((caught as Error).message).to.equal('boom')
    expect(store.held(lock.key('acc'))).to.equal(false)
    const next = await lock.run('acc', async () => 1)
    expect(next).to.deep.equal({ acquired: true, value: 1 })
  })

  it('gives up after the bounded wait', async () => {
    lock.waitMs = 60
    await store.setNxPx(lock.key('acc'), 'someone-else', 5_000)
    const r = await lock.run('acc', async () => 1)
    expect(r.acquired).to.equal(false)
    if (!r.acquired) {
      expect(r.reason).to.match(/held the lock/)
    }
  })

  it('a live holder renews the lock past its TTL', async () => {
    lock.ttlMs = 30
    lock.maxHoldMs = 5_000
    let tookIt: boolean | undefined
    await lock.run('acc', async () => {
      await sleep(100)
      tookIt = await store.setNxPx(lock.key('acc'), 'intruder', 5_000)
    })
    expect(tookIt).to.equal(false)
    expect(store.held(lock.key('acc'))).to.equal(false)
  })

  it('a holder that lost the key sees it, and does not release the new holder', async () => {
    let ownedAfter: boolean | undefined
    await lock.run('acc', async (lease) => {
      expect(await lease.owned()).to.equal(true)
      // Someone else's key now (an expiry during a stall, simulated).
      await store.delIfValue(
        lock.key('acc'),
        (store as any).keys.get(lock.key('acc')).value,
      )
      await store.setNxPx(lock.key('acc'), 'second', 5_000)
      ownedAfter = await lease.owned()
    })
    expect(ownedAfter).to.equal(false)
    expect(store.held(lock.key('acc'))).to.equal(true)
  })

  it('a section that never returns stops being renewed after the max hold', async () => {
    lock.ttlMs = 30
    lock.maxHoldMs = 60
    let release: () => void = () => undefined
    let ownedLate: boolean | undefined
    const hung = lock.run('acc', async (lease) => {
      await new Promise<void>((r) => (release = r))
      ownedLate = await lease.owned()
    })
    await sleep(150)
    const next = await lock.run('acc', async () => 'ran')
    expect(next).to.deep.equal({ acquired: true, value: 'ran' })
    release()
    await hung
    expect(ownedLate).to.equal(false)
  })

  it('refuses when the store is unavailable', async () => {
    lock.setStore({
      setNxPx: async () => undefined,
      delIfValue: async () => undefined,
      pexpireIfValue: async () => undefined,
    })
    let ran = false
    const r = await lock.run('acc', async () => {
      ran = true
    })
    expect(r.acquired).to.equal(false)
    expect(ran).to.equal(false)
  })
})
