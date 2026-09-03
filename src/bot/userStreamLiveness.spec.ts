process.env.NODE_ENV = 'testing'

/**
 * Tests for the user-stream liveness verdict (core spec 002 §4.5, §4.6).
 *
 * The scenario behind every case: an account channel whose server-side
 * subscription is gone while the bot still holds resting orders. The verdict
 * must say "repair" only when a live prober proves the silence is real, must
 * stay quiet when the prober is absent (a quiet account is just quiet), and
 * must escalate to a visible error once repairs stop helping.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  assessUserStreamLiveness,
  isPingMessage,
  parseProberHeartbeat,
  userStreamAckKey,
  LivenessInput,
} from './userStreamLiveness'

const MIN = 60_000
const NOW = 1_800_000_000_000

const base = (over: Partial<LivenessInput> = {}): LivenessInput => ({
  now: NOW,
  lastHeardAt: NOW - 30 * MIN,
  subscribedAt: NOW - 60 * MIN,
  lastRepairAt: 0,
  silentRepairs: 0,
  restingOrders: 6,
  prober: { ts: NOW - 30_000, pingMs: 2 * MIN },
  silenceMs: 6 * MIN,
  proberStaleMs: 3 * MIN,
  ...over,
})

describe('assessUserStreamLiveness (spec 002 §4.6)', () => {
  it('repairs a silent channel while the prober is alive', () => {
    const v = assessUserStreamLiveness(base())
    expect(v.action).to.equal('repair')
    expect(v.quietMs).to.equal(30 * MIN)
  })

  it('does nothing when the bot holds no resting orders', () => {
    expect(
      assessUserStreamLiveness(base({ restingOrders: 0 })).action,
    ).to.equal('none')
  })

  it('treats silence as meaningless without a prober heartbeat', () => {
    const v = assessUserStreamLiveness(base({ prober: null }))
    expect(v.action).to.equal('none')
    expect(v.reason).to.match(/absent/)
  })

  it('treats silence as meaningless when the prober heartbeat is stale', () => {
    const v = assessUserStreamLiveness(
      base({ prober: { ts: NOW - 10 * MIN, pingMs: 2 * MIN } }),
    )
    expect(v.action).to.equal('none')
    expect(v.reason).to.match(/stale/)
  })

  it('treats silence as meaningless when the failsafe is alive but not pinging', () => {
    const v = assessUserStreamLiveness(base({ prober: { ts: NOW - 1000 } }))
    expect(v.action).to.equal('none')
    expect(v.reason).to.match(/not pinging/)
  })

  it('stays quiet while the channel delivered inside the silence window', () => {
    expect(
      assessUserStreamLiveness(base({ lastHeardAt: NOW - 2 * MIN })).action,
    ).to.equal('none')
  })

  it('gives a fresh subscription the full window before judging it', () => {
    expect(
      assessUserStreamLiveness(
        base({ lastHeardAt: 0, subscribedAt: NOW - 1 * MIN }),
      ).action,
    ).to.equal('none')
  })

  it('spaces repairs by the silence window', () => {
    expect(
      assessUserStreamLiveness(
        base({ lastRepairAt: NOW - 3 * MIN, silentRepairs: 1 }),
      ).action,
    ).to.equal('none')
    expect(
      assessUserStreamLiveness(
        base({ lastRepairAt: NOW - 7 * MIN, silentRepairs: 1 }),
      ).action,
    ).to.equal('repair')
  })

  it('escalates to a visible error after two silent repairs', () => {
    const v = assessUserStreamLiveness(
      base({ lastRepairAt: NOW - 7 * MIN, silentRepairs: 2 }),
    )
    expect(v.action).to.equal('repair-and-error')
  })

  it('never judges a bot that has not subscribed at all', () => {
    expect(
      assessUserStreamLiveness(base({ subscribedAt: 0, lastHeardAt: 0 }))
        .action,
    ).to.equal('none')
  })
})

describe('prober heartbeat + ack contract (spec 002 §4.5)', () => {
  it('parses the failsafe heartbeat and tolerates garbage', () => {
    expect(parseProberHeartbeat(null)).to.equal(null)
    expect(parseProberHeartbeat('not json')).to.equal(null)
    expect(parseProberHeartbeat('{"registry":3}')).to.equal(null)
    expect(parseProberHeartbeat('{"ts":5}')).to.deep.equal({
      ts: 5,
      pingMs: undefined,
    })
    expect(parseProberHeartbeat('{"ts":5,"pingMs":120000}')).to.deep.equal({
      ts: 5,
      pingMs: 120000,
    })
  })

  it('recognises PING messages only', () => {
    expect(isPingMessage('PING 1700000000000')).to.equal(true)
    expect(isPingMessage('RECONCILE VIA SWEEP')).to.equal(false)
    expect(isPingMessage(undefined)).to.equal(false)
  })

  it('keys the ack hash by account', () => {
    expect(userStreamAckKey('918d10eb')).to.equal(
      'gainium:userStreamAck:918d10eb',
    )
  })
})
