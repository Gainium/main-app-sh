process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the pub/sub bookkeeping in {@link RedisWrapper}.
 *
 * Replays the 2026-09-02 17:12:33 incident: thirteen DCA bots of one user, all
 * on the same Kraken account, were loaded on the same worker within 10 ms of a
 * process restart. Every one of them ran `unsubscribe(ch, cb)` then
 * `subscribe(ch, cb)` on the shared `userStreamInfo<uuid>` channel. In
 * node-redis 5 an `unsubscribe` for a channel that has no LOCAL listener entry
 * still sends a real UNSUBSCRIBE, and the entry for a pending SUBSCRIBE is only
 * created when its reply arrives. So the wire order became SUBSCRIBE (bot 1),
 * UNSUBSCRIBE (bot 2) and every later `subscribe` was deduplicated client-side
 * ("already subscribed, add listener without a command"). The client held 13
 * listeners, the server held no subscription, nothing logged an error, nothing
 * retried, and the account stayed deaf to fills and reconcile sweeps for 20
 * hours until the next worker restart.
 *
 * The fake client below mirrors `@redis/client` 5.10 `pub-sub.js` semantics
 * exactly where they matter: entries are created on reply, an unknown-channel
 * unsubscribe goes to the wire, and a subscribe on an existing entry is a
 * local no-op. Wire order equals call order; replies drain in FIFO order on
 * `setImmediate`, so a test can interleave callers at reply boundaries.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { RedisWrapper } from './redis'

type Listener = (msg: string, channel: string) => void

class FakeRedisClient {
  isReady = true
  /** Channels the SERVER believes this connection is subscribed to. */
  server = new Set<string>()
  /** node-redis's local listener registry (`PubSub.listeners.CHANNELS`). */
  listeners = new Map<string, { unsubscribing: boolean; set: Set<Listener> }>()
  /** Commands on the wire that have not been answered yet, FIFO. */
  private pendingReplies: Array<() => void> = []
  private draining = false
  wire: string[] = []

  private enqueue(apply: () => void, onReply: () => void): Promise<void> {
    apply()
    return new Promise((resolve) => {
      this.pendingReplies.push(() => {
        onReply()
        resolve()
      })
      this.scheduleDrain()
    })
  }

  private scheduleDrain() {
    if (this.draining) return
    this.draining = true
    setImmediate(() => {
      this.draining = false
      const next = this.pendingReplies.shift()
      if (next) next()
      if (this.pendingReplies.length) this.scheduleDrain()
    })
  }

  subscribe(channel: string, listener: Listener): Promise<void> {
    const entry = this.listeners.get(channel)
    if (entry && !entry.unsubscribing) {
      // "all channels are already subscribed, add listeners without issuing a command"
      entry.set.add(listener)
      return Promise.resolve()
    }
    this.wire.push(`SUBSCRIBE ${channel}`)
    return this.enqueue(
      () => this.server.add(channel),
      () => {
        let e = this.listeners.get(channel)
        if (!e) {
          e = { unsubscribing: false, set: new Set() }
          this.listeners.set(channel, e)
        }
        e.set.add(listener)
      },
    )
  }

  unsubscribe(channel: string, listener?: Listener): Promise<void> {
    if (!listener) {
      this.wire.push(`UNSUBSCRIBE ${channel}`)
      return this.enqueue(
        () => this.server.delete(channel),
        () => this.listeners.delete(channel),
      )
    }
    const entry = this.listeners.get(channel)
    if (entry) {
      const remaining = entry.set.has(listener)
        ? entry.set.size - 1
        : entry.set.size
      if (remaining !== 0) {
        // "all channels has other listeners, delete the listeners without issuing a command"
        entry.set.delete(listener)
        return Promise.resolve()
      }
      entry.unsubscribing = true
    }
    // No local entry, or this listener is the last one: real UNSUBSCRIBE.
    this.wire.push(`UNSUBSCRIBE ${channel}`)
    return this.enqueue(
      () => this.server.delete(channel),
      () => {
        const e = this.listeners.get(channel)
        if (!e) return
        e.set.delete(listener)
        if (e.set.size === 0) this.listeners.delete(channel)
      },
    )
  }

  /** Deliver like the server would: only over a live subscription. */
  publish(channel: string, msg: string): number {
    if (!this.server.has(channel)) return 0
    for (const cb of this.listeners.get(channel)?.set ?? []) cb(msg, channel)
    return 1
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r))
const drain = async () => {
  for (let i = 0; i < 20; i++) await tick()
}

function wrapperOver(fake: FakeRedisClient): RedisWrapper {
  const w = new RedisWrapper()
  ;(w as unknown as { _instance: FakeRedisClient })._instance = fake
  return w
}

const CH = 'userStreamInfo918d10eb-7520-4053-bab5-45925f3b26d5'

describe('RedisWrapper pub/sub — concurrent sibling subscribe', () => {
  it('two bots subscribing to one channel within a round trip both receive', async () => {
    const fake = new FakeRedisClient()
    const w = wrapperOver(fake)
    const got: string[] = []
    const cb1: Listener = (m) => got.push(`1:${m}`)
    const cb2: Listener = (m) => got.push(`2:${m}`)

    // Bot 1: the legacy call order in setExchangeCredentials.
    const bot1 = (async () => {
      await w.unsubscribe(CH, cb1)
      await w.subscribe(CH, cb1)
    })()
    // Bot 2 starts after bot 1's UNSUBSCRIBE reply, while bot 1's SUBSCRIBE is
    // still on the wire — the 10 ms stagger seen in the incident log.
    await tick()
    const bot2 = (async () => {
      await w.unsubscribe(CH, cb2)
      await w.subscribe(CH, cb2)
    })()
    await bot1
    await bot2
    await drain()

    expect(
      fake.server.has(CH),
      `server lost the subscription; wire=${fake.wire.join(' > ')}`,
    ).to.equal(true)
    expect(fake.publish(CH, 'RECONCILE VIA SWEEP')).to.equal(1)
    expect(got).to.have.members([
      '1:RECONCILE VIA SWEEP',
      '2:RECONCILE VIA SWEEP',
    ])
  })

  it('never sends UNSUBSCRIBE for a listener it did not register', async () => {
    const fake = new FakeRedisClient()
    const w = wrapperOver(fake)
    const cb1: Listener = () => undefined
    const cb2: Listener = () => undefined
    await w.subscribe(CH, cb1)
    await drain()
    await w.unsubscribe(CH, cb2)
    await drain()
    expect(fake.wire).to.deep.equal([`SUBSCRIBE ${CH}`])
    expect(fake.server.has(CH)).to.equal(true)
  })

  it('unsubscribing the last registered listener releases the channel', async () => {
    const fake = new FakeRedisClient()
    const w = wrapperOver(fake)
    const cb1: Listener = () => undefined
    const cb2: Listener = () => undefined
    await w.subscribe(CH, cb1)
    await w.subscribe(CH, cb2)
    await drain()
    await w.unsubscribe(CH, cb1)
    await drain()
    expect(fake.server.has(CH)).to.equal(true)
    await w.unsubscribe(CH, cb2)
    await drain()
    expect(fake.server.has(CH)).to.equal(false)
    expect(fake.listeners.has(CH)).to.equal(false)
  })

  it('resubscribe(channel) re-establishes a subscription the server lost', async () => {
    const fake = new FakeRedisClient()
    const w = wrapperOver(fake)
    const got: string[] = []
    const cb1: Listener = (m) => got.push(`1:${m}`)
    const cb2: Listener = (m) => got.push(`2:${m}`)
    await w.subscribe(CH, cb1)
    await w.subscribe(CH, cb2)
    await drain()
    // The deaf state: client entry intact, server subscription gone.
    fake.server.delete(CH)
    expect(fake.publish(CH, 'lost')).to.equal(0)

    const relisted = await w.resubscribe(CH)
    await drain()
    expect(relisted).to.equal(2)
    expect(fake.server.has(CH)).to.equal(true)
    expect(fake.publish(CH, 'PING')).to.equal(1)
    expect(got).to.have.members(['1:PING', '2:PING'])
  })

  it('resubscribe(channel) is a no-op for a channel nothing registered', async () => {
    const fake = new FakeRedisClient()
    const w = wrapperOver(fake)
    expect(await w.resubscribe(CH)).to.equal(0)
    await drain()
    expect(fake.wire).to.deep.equal([])
  })
})
