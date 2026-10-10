process.env.NODE_ENV = 'testing'

/**
 * `channel.publish` returning false is write-buffer backpressure, not a lost
 * message. `send` must wait for 'drain' instead of logging a failure per
 * publish, and a burst must share one listener and one log line.
 */
import { EventEmitter } from 'events'
import { describe, it } from 'mocha'
import { expect } from 'chai'
import type { Channel } from 'amqplib/callback_api'
import Rabbit, { noteBackpressure, waitForDrain } from './rabbit'

class FakeChannel extends EventEmitter {
  published: Buffer[] = []
  full = false
  publish(_exchange: string, _queue: string, content: Buffer) {
    this.published.push(content)
    return !this.full
  }
}

const settled = async (p: Promise<unknown>, ms = 20) => {
  let done = false
  p.then(() => (done = true))
  await new Promise((r) => setTimeout(r, ms))
  return done
}

const rabbitOn = (channel: FakeChannel) => {
  const rabbit = new Rabbit()
  ;(rabbit as unknown as { getClient: () => unknown }).getClient =
    async () => ({
      client: {},
      channel: null,
      channelPool: { getChannel: () => channel },
    })
  return rabbit
}

describe('rabbit write-buffer backpressure', () => {
  it('waitForDrain resolves on drain and shares one listener per channel', async () => {
    const ch = new FakeChannel()
    const waits = Array.from({ length: 100 }, () =>
      waitForDrain(ch as unknown as Channel),
    )
    expect(ch.listenerCount('drain')).to.equal(1)
    expect(await settled(Promise.all(waits))).to.be.false
    ch.emit('drain')
    expect(await settled(Promise.all(waits))).to.be.true
    expect(ch.listenerCount('drain')).to.equal(0)
    expect(ch.listenerCount('close')).to.equal(0)
  })

  it('waitForDrain also resolves on close and on timeout', async () => {
    const closed = new FakeChannel()
    const w1 = waitForDrain(closed as unknown as Channel)
    closed.emit('close')
    expect(await settled(w1)).to.be.true

    const stuck = new FakeChannel()
    expect(await settled(waitForDrain(stuck as unknown as Channel, 5), 30)).to
      .be.true
    expect(stuck.listenerCount('drain')).to.equal(0)
  })

  it('send publishes once and waits for drain when the buffer is full', async () => {
    const ch = new FakeChannel()
    ch.full = true
    const sending = rabbitOn(ch).send('bpTestQueue', { a: 1 })
    expect(await settled(sending)).to.be.false
    expect(ch.published).to.have.length(1)
    ch.emit('drain')
    expect(await settled(sending)).to.be.true
    expect(ch.published).to.have.length(1)
  })

  it('send returns at once when the buffer has room', async () => {
    const ch = new FakeChannel()
    expect(await settled(rabbitOn(ch).send('bpTestQueue2', { a: 1 }))).to.be
      .true
  })

  it('logs backpressure once per queue per minute', () => {
    const t0 = 1_000_000_000
    expect(noteBackpressure('bpLogQueue', t0)).to.be.true
    for (let i = 1; i < 500; i++) {
      expect(noteBackpressure('bpLogQueue', t0 + i)).to.be.false
    }
    expect(noteBackpressure('otherQueue', t0 + 1)).to.be.true
    expect(noteBackpressure('bpLogQueue', t0 + 60_000)).to.be.true
  })
})
