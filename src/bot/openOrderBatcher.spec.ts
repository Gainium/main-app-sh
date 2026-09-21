process.env.NODE_ENV = 'testing'

/**
 * The placement coalescer, on its own.
 *
 * Spec: `specs/082.kraken-spot-bulk-cancel-and-bulk-place.md` §7.
 * Run: `npm test` (mocha).
 *
 * Everything here is about two promises that must not be broken:
 *
 *   1. no participant is ever left parked — not when one of its peers never
 *      arrives, not when the send throws, not when a continuation forgets to
 *      report itself settled. A parked participant is an order that never
 *      leaves the process while the bot believes it has been placed.
 *   2. no two participants run their post-send bookkeeping at the same time.
 *      That bookkeeping is the balance latch, the cooldown guards and the DB
 *      writes, and it is sequential today.
 *
 * No bot, no exchange, no network: the class takes a list of ids and a send
 * function, and that is all it knows.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import OpenOrderBatcher from './openOrderBatcher'
import { StatusEnum } from '../../types'
import type { BaseReturn, CommonOrder } from '../../types'
import type { OpenOrderRequest } from '../exchange'
import { isAmbiguousOrderFailure } from '../utils/exchange'

const request = (id: string): OpenOrderRequest => ({
  symbol: 'ETH-EUR',
  side: 'BUY' as OpenOrderRequest['side'],
  quantity: 1,
  price: 100,
  newClientOrderId: id,
  type: 'LIMIT',
})

const placed = (id: string): BaseReturn<CommonOrder> => ({
  status: StatusEnum.ok,
  data: { clientOrderId: id, status: 'NEW' } as unknown as CommonOrder,
  reason: null,
})

/** Records every chunk the batcher sends, in the order it sends them. */
function recorder(
  answer: (
    orders: OpenOrderRequest[],
  ) => Promise<BaseReturn<CommonOrder>[]> = async (orders) =>
    orders.map((o) => placed(`${o.newClientOrderId}`)),
) {
  const chunks: string[][] = []
  const send = async (orders: OpenOrderRequest[]) => {
    chunks.push(orders.map((o) => `${o.newClientOrderId}`))
    return answer(orders)
  }
  return { chunks, send }
}

const ids = (count: number, prefix = 'O') =>
  [...Array(count).keys()].map((i) => `${prefix}${i}`)

describe('OpenOrderBatcher flush (spec 082 §7.3)', () => {
  it('sends once every participant has arrived', async () => {
    const { chunks, send } = recorder()
    const batcher = new OpenOrderBatcher(ids(3), send)
    const answers = await Promise.all(
      ids(3).map(async (id) => {
        const result = await batcher.send(request(id))
        batcher.settled(id)
        return result
      }),
    )
    batcher.dispose()
    expect(chunks, 'one call for the whole burst').to.deep.equal([
      ['O0', 'O1', 'O2'],
    ])
    expect(answers.map((a) => a.data?.clientOrderId)).to.deep.equal([
      'O0',
      'O1',
      'O2',
    ])
  })

  it('a bail counts as accounted for, so the rest do not wait for it', async () => {
    const { chunks, send } = recorder()
    const batcher = new OpenOrderBatcher(ids(3), send)
    // O1 never reaches the send site — a pre-send gate refused it.
    batcher.bail('O1')
    await Promise.all(
      ['O0', 'O2'].map(async (id) => {
        await batcher.send(request(id))
        batcher.settled(id)
      }),
    )
    batcher.dispose()
    expect(chunks).to.deep.equal([['O0', 'O2']])
  })

  it('settling a participant that never arrived is read as a bail', async () => {
    const { chunks, send } = recorder()
    const batcher = new OpenOrderBatcher(ids(2), send)
    // The caller only ever calls `settled` in its `finally`; this is the shape
    // that takes when the body returned before the send site.
    batcher.settled('O1')
    await batcher.send(request('O0'))
    batcher.settled('O0')
    batcher.dispose()
    expect(chunks).to.deep.equal([['O0']])
  })

  it('splits into chunks of 15, sent one after another', async () => {
    const inFlight: number[] = []
    let concurrent = 0
    const { chunks, send } = recorder(async (orders) => {
      concurrent++
      inFlight.push(concurrent)
      await new Promise((r) => setTimeout(r, 5))
      concurrent--
      return orders.map((o) => placed(`${o.newClientOrderId}`))
    })
    const all = ids(31)
    const batcher = new OpenOrderBatcher(all, send)
    await Promise.all(
      all.map(async (id) => {
        await batcher.send(request(id))
        batcher.settled(id)
      }),
    )
    batcher.dispose()
    expect(chunks.map((c) => c.length)).to.deep.equal([15, 15, 1])
    expect(chunks[0][0], 'chunks follow the caller’s order').to.equal('O0')
    expect(chunks[2], 'a chunk of one is still a call').to.deep.equal(['O30'])
    expect(Math.max(...inFlight), 'chunks overlapped').to.equal(1)
  })

  it('chunks follow the caller’s order whatever order participants arrive in', async () => {
    const { chunks, send } = recorder()
    const all = ids(4)
    const batcher = new OpenOrderBatcher(all, send)
    await Promise.all(
      [...all].reverse().map(async (id) => {
        await batcher.send(request(id))
        batcher.settled(id)
      }),
    )
    batcher.dispose()
    expect(chunks).to.deep.equal([['O0', 'O1', 'O2', 'O3']])
  })
})

describe('OpenOrderBatcher delivery is one at a time (spec 082 §7.3)', () => {
  it('does not resolve participant i+1 until i has settled', async () => {
    const { send } = recorder()
    const all = ids(4)
    const batcher = new OpenOrderBatcher(all, send)
    const trace: string[] = []
    let inContinuation = 0
    await Promise.all(
      all.map(async (id) => {
        try {
          await batcher.send(request(id))
          inContinuation++
          trace.push(`start ${id}`)
          // The real continuation awaits: countBalances, the DB write, emits.
          await new Promise((r) => setTimeout(r, 3))
          trace.push(`end ${id}`)
          expect(inContinuation, 'two continuations overlapped').to.equal(1)
          inContinuation--
        } finally {
          batcher.settled(id)
        }
      }),
    )
    batcher.dispose()
    expect(trace).to.deep.equal([
      'start O0',
      'end O0',
      'start O1',
      'end O1',
      'start O2',
      'end O2',
      'start O3',
      'end O3',
    ])
  })
})

describe('OpenOrderBatcher never parks a burst (spec 082 §7.4)', () => {
  it('flushes on a timeout when a participant neither arrives nor bails', async () => {
    const { chunks, send } = recorder()
    const batcher = new OpenOrderBatcher(ids(3), send, { timeoutMs: 30 })
    const answers = await Promise.all(
      ['O0', 'O1'].map(async (id) => {
        const r = await batcher.send(request(id))
        batcher.settled(id)
        return r
      }),
    )
    batcher.dispose()
    expect(chunks, 'sent what arrived').to.deep.equal([['O0', 'O1']])
    expect(answers.every((a) => a.status === StatusEnum.ok)).to.equal(true)
  })

  it('releases the queue when a delivered participant never settles', async () => {
    const { send } = recorder()
    const batcher = new OpenOrderBatcher(ids(2), send, { timeoutMs: 30 })
    const first = batcher.send(request('O0'))
    const second = batcher.send(request('O1'))
    // O0's continuation never reports itself settled. O1 must still be served.
    await first
    const answer = await second
    batcher.dispose()
    expect(answer.status).to.equal(StatusEnum.ok)
  })

  it('a throw in the flush leaves every order UNCONFIRMED, never refused', async () => {
    const batcher = new OpenOrderBatcher(ids(3), async () => {
      throw new Error('socket exploded')
    })
    const answers = await Promise.all(
      ids(3).map(async (id) => {
        const r = await batcher.send(request(id))
        batcher.settled(id)
        return r
      }),
    )
    batcher.dispose()
    for (const answer of answers) {
      expect(answer.status).to.equal(StatusEnum.notok)
      // The whole point: a throw can only happen after the wire call was
      // entered, so these orders may be live. `isAmbiguousOrderFailure` is what
      // stops the engine writing them off or re-sending them.
      expect(
        isAmbiguousOrderFailure(answer.reason),
        `"${answer.reason}" reads as a definitive refusal`,
      ).to.equal(true)
    }
  })

  it('a participant that arrives after the flush is placed on its own', async () => {
    const { chunks, send } = recorder()
    const batcher = new OpenOrderBatcher(ids(2), send)
    await Promise.all(
      ids(2).map(async (id) => {
        await batcher.send(request(id))
        batcher.settled(id)
      }),
    )
    const late = await batcher.send(request('O0'))
    batcher.dispose()
    expect(chunks).to.deep.equal([['O0', 'O1'], ['O0']])
    expect(late.status).to.equal(StatusEnum.ok)
  })

  it('an order the batch never named is not one of its participants', () => {
    const batcher = new OpenOrderBatcher(ids(2), recorder().send)
    expect(batcher.has('O1')).to.equal(true)
    expect(batcher.has('SOMEONE-ELSE')).to.equal(false)
    expect(batcher.has(undefined)).to.equal(false)
    batcher.dispose()
    expect(batcher.has('O1'), 'disposed batcher claims nothing').to.equal(false)
  })
})
