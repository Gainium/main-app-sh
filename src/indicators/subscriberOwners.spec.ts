process.env.NODE_ENV = 'testing'

/**
 * A restart beacon from one subscriber process must only forget THAT
 * process's subscriptions in a shared indicator room.
 *
 * Run: `npm test` (mocha).
 *
 * The room's subscriber list decides when the room closes (`unsubscribe`
 * closes it when the list reaches zero). If a restart forgets the live
 * subscribers of another process, the restarted process's own later
 * unsubscribes close the room under them and they silently stop receiving
 * indicator updates. No Redis or workers: the real methods are driven off the
 * prototypes against plain objects.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import InternalIndicator from './service'
import InternalIndicatorsFactory from './index'
import {
  IndicatorSubscriberOwners,
  indicatorSubscriberOwner,
} from './subscriberOwners'

const ROOM = 'rsi-14rsi-binance-BTCUSDT-1h'
const SPLIT = '@gainium@'
const ext = (sub: string) => `${sub}${SPLIT}${ROOM}`

type FakeService = { subscribers: { id: string }[]; closed: boolean }

/** The worker-side Service of one room, with only the state these paths use. */
const makeService = (subs: string[]): FakeService =>
  ({
    subscribers: subs.map((id) => ({ id })),
    timer: null,
    redisClient: null,
    checkCandleTimer: null,
    closed: false,
    handleDebug: () => undefined,
  }) as FakeService

const svc = InternalIndicator.prototype as unknown as {
  removeCallback: (this: FakeService, room: string, sub?: string) => number
  unsubscribe: (this: FakeService, id: string) => number
}

describe('indicator subscribers: restart drops only its own process', () => {
  it('owner key is the restart beacon of the sending process', () => {
    expect(
      indicatorSubscriberOwner({ type: 'dca', service: 'botServicehedgeDca' }),
    ).to.equal('botServicehedgeDca')
    expect(indicatorSubscriberOwner({ type: 'dca' })).to.equal('botServicedca')
    expect(indicatorSubscriberOwner({ type: 'combo' })).to.equal(
      'botServicecombo',
    )
    expect(indicatorSubscriberOwner({ type: 'metricsService' })).to.equal(
      'metricsService',
    )
  })

  it('take(owner) returns only that owner’s ids in a shared room', () => {
    const owners = new IndicatorSubscriberOwners()
    owners.add('metricsService', ROOM, ext('m1'))
    owners.add('botServicedca', ROOM, ext('d1'))
    owners.add('botServicehedgeDca', ROOM, ext('h1'))

    expect(owners.take('metricsService')).to.deep.equal([
      { room: ROOM, id: ext('m1') },
    ])
    // A DCA-process restart leaves the Hedge DCA process's subscriber alone.
    expect(owners.take('botServicedca')).to.deep.equal([
      { room: ROOM, id: ext('d1') },
    ])
    expect(owners.remove(ext('h1'))).to.equal(ROOM)
    expect(owners.take('botServicehedgeDca')).to.deep.equal([])
  })

  it('restart of A keeps B counted, so A leaving later does not close the room', () => {
    const service = makeService(['m1', 'd1', 'd2'])
    // Metrics service restarts: drop its stale subscriber only.
    expect(svc.removeCallback.call(service, ROOM, 'm1')).to.equal(2)
    // It re-subscribes, later leaves again.
    service.subscribers.push({ id: 'm2' })
    expect(svc.unsubscribe.call(service, 'm2')).to.equal(2)
    expect(service.closed).to.equal(false)
    expect(service.subscribers.map((s) => s.id)).to.deep.equal(['d1', 'd2'])
  })

  it('legacy removeCallback(room) forgets B and the room closes under it', () => {
    const service = makeService(['m1', 'd1', 'd2'])
    svc.removeCallback.call(service, ROOM)
    service.subscribers.push({ id: 'm2' })
    expect(svc.unsubscribe.call(service, 'm2')).to.equal(0)
    expect(service.closed).to.equal(true) // d1, d2 are still listening
  })

  it('factory removeSubscriberCallback forgets one subscriber, never closes', async () => {
    const sent: unknown[][] = []
    const factory = {
      splitPhrase: SPLIT,
      subscribersCount: 3,
      indicators: new Map([
        [ROOM, { subcribersSet: new Set([ext('m1'), ext('d1'), ext('d2')]) }],
      ]),
      removeCallbackIndicator: async (...args: unknown[]) => {
        sent.push(args)
      },
      deleteIndicator: async () => {
        throw new Error('must not close the room')
      },
    }
    const proto = InternalIndicatorsFactory.prototype as unknown as {
      removeSubscriberCallback: (id: string) => Promise<void>
    }
    await proto.removeSubscriberCallback.call(factory, ext('m1'))
    // Unknown / already-dropped id is a no-op.
    await proto.removeSubscriberCallback.call(factory, ext('m1'))

    expect([...factory.indicators.get(ROOM)!.subcribersSet]).to.deep.equal([
      ext('d1'),
      ext('d2'),
    ])
    expect(factory.subscribersCount).to.equal(2)
    expect(sent).to.deep.equal([[ROOM, 'm1']])
  })
})
