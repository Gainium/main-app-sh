process.env.NODE_ENV = 'testing'

/**
 * The two batch endpoints of the exchange client.
 *
 * Spec: `specs/076.kraken-spot-bulk-cancel-and-bulk-place.md` §2, §6.
 * Run: `npm test` (mocha).
 *
 * The contract these tests hold the client to is the one that lets every
 * caller stay ignorant of batches: ONE answer per input order, positionally
 * aligned, each indistinguishable from what `openOrder` would have returned —
 * and, above all, an order is never sent twice and never written off while the
 * venue might be holding it.
 *
 * No network: the real methods are driven off the prototype against a
 * recording transport, so the ladders, the classifiers and the fallbacks under
 * test are the shipped ones.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Exchange from './exchange'
import AbstractExchange from './index'
import type { OpenOrderRequest } from './index'
import { ExchangeEnum, StatusEnum } from '../../types'
import type { BaseReturn, CommonOrder } from '../../types'

type Call = {
  endpoint: string
  method: string
  body?: Record<string, unknown>
  params?: Record<string, unknown>
  noAutoRetry?: boolean
}

/**
 * @param handler answers one connector call. Returning a `BaseReturn` is an
 * HTTP 200 with that body; THROWING is what `apiCall` does once its own
 * transport handling is done with a request (a 404, or an exhausted ladder).
 */
function client(
  exchange: ExchangeEnum,
  handler: (call: Call) => unknown | Promise<unknown>,
) {
  const calls: Call[] = []
  const ex: any = Object.create((Exchange as any).prototype)
  ex.exchange = exchange
  ex.getEmptyTimeProfile = () => ({})
  ex.saveTimeProfile = () => undefined
  ex.apiCall = async (call: Call) => {
    calls.push(call)
    return { data: await handler(call), timeProfile: {} }
  }
  return { ex, calls }
}

const order = (id: string, price = 100): OpenOrderRequest => ({
  symbol: 'ETH-EUR',
  side: 'BUY' as OpenOrderRequest['side'],
  quantity: 1,
  price,
  newClientOrderId: id,
  type: 'LIMIT',
})

const venueOrder = (id: string) =>
  ({
    clientOrderId: id,
    orderId: `TX-${id}`,
    status: 'NEW',
  }) as unknown as CommonOrder

const ok = <T>(data: T) => ({ status: StatusEnum.ok, data, reason: null })
const bad = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

/** Endpoints hit, in order, so a test can read the whole conversation. */
const trace = (calls: Call[]) =>
  calls.map((c) => `${c.method} ${c.endpoint}`).join(' | ')

describe('openOrdersBatch answers per order (spec 076 §6.1)', () => {
  it('maps a placed order to ok and a refused one to notok, and resends neither', async () => {
    const { ex, calls } = client(ExchangeEnum.binance, () =>
      ok([
        { newClientOrderId: 'A', order: venueOrder('A') },
        { newClientOrderId: 'B', reason: 'EOrder:Insufficient funds' },
      ]),
    )
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    expect(results).to.have.length(2)
    expect(results[0].status).to.equal(StatusEnum.ok)
    expect(results[0].data?.clientOrderId).to.equal('A')
    expect(results[1].status).to.equal(StatusEnum.notok)
    // Verbatim: the engine classifies on this string (not-enough-balance
    // cooldowns, compliance, tick size) and a reworded one classifies wrong.
    expect(results[1].reason).to.equal('EOrder:Insufficient funds')
    expect(trace(calls), 'a refused order must not be re-sent').to.equal(
      'post orders/openBatch',
    )
  })

  it('sends the batch with no transport retry, one call, LIMIT items', async () => {
    const { ex, calls } = client(ExchangeEnum.bybit, () =>
      ok([
        { newClientOrderId: 'A', order: venueOrder('A') },
        { newClientOrderId: 'B', order: venueOrder('B') },
      ]),
    )
    await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    expect(
      calls[0].noAutoRetry,
      'a batch must never be blindly re-sent',
    ).to.equal(true)
    expect(calls[0].body?.symbol).to.equal('ETH-EUR')
    expect(calls[0].body?.orders).to.deep.equal([
      {
        side: 'BUY',
        quantity: 1,
        price: 100,
        newClientOrderId: 'A',
        type: 'LIMIT',
      },
      {
        side: 'BUY',
        quantity: 1,
        price: 100,
        newClientOrderId: 'B',
        type: 'LIMIT',
      },
    ])
  })

  it('places one order on its own rather than as a batch of one', async () => {
    const { ex, calls } = client(ExchangeEnum.okx, () => ok(venueOrder('A')))
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A')],
    })
    expect(trace(calls)).to.equal('post order')
    expect(results[0].status).to.equal(StatusEnum.ok)
  })

  it('places one at a time when an order carries no client order id', async () => {
    const { ex, calls } = client(ExchangeEnum.kucoin, () => ok(venueOrder('A')))
    await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [{ ...order('A'), newClientOrderId: undefined }, order('B')],
    })
    // Nothing to resolve BY, so the batch's whole safety argument is gone.
    expect(trace(calls)).to.equal('post order | post order')
  })
})

describe('openOrdersBatch falls back when the batch is DEFINITIVELY refused (spec 076 §6.2)', () => {
  it('places every order one at a time, in input order', async () => {
    const { ex, calls } = client(ExchangeEnum.bitget, (call) =>
      call.endpoint === 'orders/openBatch'
        ? bad('EGeneral:Invalid arguments:volume')
        : ok(venueOrder(`${call.body?.newClientOrderId}`)),
    )
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B'), order('C')],
    })
    expect(trace(calls)).to.equal(
      'post orders/openBatch | post order | post order | post order',
    )
    expect(calls.slice(1).map((c) => c.body?.newClientOrderId)).to.deep.equal([
      'A',
      'B',
      'C',
    ])
    expect(results.map((r) => r.status)).to.deep.equal([
      StatusEnum.ok,
      StatusEnum.ok,
      StatusEnum.ok,
    ])
  })

  it('asks a declining connector once per process, then stops asking', async () => {
    const { ex, calls } = client(ExchangeEnum.kraken, (call) =>
      call.endpoint === 'orders/openBatch'
        ? bad('Batch order placement not supported for this exchange')
        : ok(venueOrder(`${call.body?.newClientOrderId}`)),
    )
    await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('C'), order('D')],
    })
    expect(trace(calls)).to.equal(
      'post orders/openBatch | post order | post order | post order | post order',
    )
  })

  it('reads a connector that predates the route (404) the same way', async () => {
    // `apiCall` turns a 404 into this exact throw once its ladder is opted out
    // of. No route means no handler ran, so nothing was placed.
    const { ex, calls } = client(ExchangeEnum.paperKraken, (call) => {
      if (call.endpoint === 'orders/openBatch') {
        throw new Error('Exchange connector | Not Found')
      }
      return ok(venueOrder(`${call.body?.newClientOrderId}`))
    })
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    expect(trace(calls)).to.equal(
      'post orders/openBatch | post order | post order',
    )
    expect(results.map((r) => r.status)).to.deep.equal([
      StatusEnum.ok,
      StatusEnum.ok,
    ])
  })
})

describe('openOrdersBatch resolves before it resends (spec 076 §6.3)', () => {
  /**
   * The case the whole design exists for: the batch may or may not have
   * reached the matching engine, and nothing in the answer can say which.
   */
  const ambiguousBatch = (lookups: Record<string, unknown>) =>
    client(ExchangeEnum.hyperliquid, (call) => {
      if (call.endpoint === 'orders/openBatch') {
        return bad('Request Timeout')
      }
      if (call.endpoint === 'order' && call.method === 'get') {
        return lookups[`${call.params?.newClientOrderId}`]
      }
      return ok(venueOrder(`${call.body?.newClientOrderId}`))
    })

  it('adopts an order the venue turns out to be holding', async () => {
    const { ex, calls } = ambiguousBatch({
      A: ok(venueOrder('A')),
      B: ok(venueOrder('B')),
    })
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    expect(trace(calls), 'never re-sent').to.equal(
      'post orders/openBatch | get order | get order',
    )
    expect(results.map((r) => r.data?.clientOrderId)).to.deep.equal(['A', 'B'])
  })

  it('sends only the order the venue definitively does not have', async () => {
    const { ex, calls } = ambiguousBatch({
      A: ok(venueOrder('A')),
      B: bad('Order not found'),
    })
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    expect(trace(calls)).to.equal(
      'post orders/openBatch | get order | get order | post order',
    )
    expect(calls[3].body?.newClientOrderId).to.equal('B')
    expect(results.map((r) => r.status)).to.deep.equal([
      StatusEnum.ok,
      StatusEnum.ok,
    ])
  })

  it('sends nothing when the lookup is itself inconclusive', async () => {
    const { ex, calls } = ambiguousBatch({
      A: bad('ECONNRESET'),
      B: bad('Order not found'),
    })
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    // A is left UNCONFIRMED — the engine still holds its id, and the reconcile
    // machinery owns it. Re-sending would be the duplicate this method exists
    // to prevent.
    expect(
      calls.filter((c) => c.endpoint === 'order' && c.method === 'post'),
    ).to.have.length(1)
    expect(results[0].status).to.equal(StatusEnum.notok)
    expect(results[0].reason).to.equal('Request Timeout')
    expect(results[1].status).to.equal(StatusEnum.ok)
  })

  it('treats a reply of the wrong length as an unknown outcome, not as data', async () => {
    const { ex, calls } = client(ExchangeEnum.coinbase, (call) => {
      if (call.endpoint === 'orders/openBatch') {
        // Two orders asked for, one answer back: the positions cannot be
        // matched up, so no order may be read as refused.
        return ok([{ newClientOrderId: 'A', order: venueOrder('A') }])
      }
      if (call.method === 'get') {
        return bad('Order not found')
      }
      return ok(venueOrder(`${call.body?.newClientOrderId}`))
    })
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B')],
    })
    expect(trace(calls)).to.equal(
      'post orders/openBatch | get order | post order | get order | post order',
    )
    expect(results.map((r) => r.status)).to.deep.equal([
      StatusEnum.ok,
      StatusEnum.ok,
    ])
  })
})

describe('cancelOrdersBatch (spec 076 §2)', () => {
  it('sends one non-retrying call and passes the answer through', async () => {
    const { ex, calls } = client(ExchangeEnum.kraken, () =>
      ok([{ orderId: 'TX-1', status: 'CANCELED' }]),
    )
    const res = await ex.cancelOrdersBatch({
      symbol: 'ETH-EUR',
      newClientOrderIds: ['TX-1', 'TX-2'],
    })
    expect(calls).to.have.length(1)
    expect(calls[0].endpoint).to.equal('orders/cancelBatch')
    expect(calls[0].noAutoRetry).to.equal(true)
    expect(calls[0].body?.newClientOrderIds).to.deep.equal(['TX-1', 'TX-2'])
    expect(res.status).to.equal(StatusEnum.ok)
    expect(res.data).to.have.length(1)
  })

  it('answers notok on a 404 without re-driving the ladder', async () => {
    const { ex, calls } = client(ExchangeEnum.kraken, () => {
      throw new Error('Exchange connector | Not Found')
    })
    const res = await ex.cancelOrdersBatch({
      symbol: 'ETH-EUR',
      newClientOrderIds: ['TX-1', 'TX-2'],
    })
    // One call. `handleError`'s ladder would have made six of them, at 3s
    // apiece for a 404, to learn the same thing.
    expect(calls).to.have.length(1)
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.equal('Exchange connector | Not Found')
  })
})

describe('the transports with no batch route are unchanged (spec 076 §2.3)', () => {
  const base = () => {
    const placed: string[] = []
    const ex: any = Object.create((AbstractExchange as any).prototype)
    ex.openOrder = async (o: OpenOrderRequest) => {
      placed.push(`${o.newClientOrderId}`)
      return ok(venueOrder(`${o.newClientOrderId}`))
    }
    return { ex, placed }
  }

  it('declines a bulk cancel, so the caller keeps its per-order loop', async () => {
    const { ex } = base()
    const res = await ex.cancelOrdersBatch({
      symbol: 'ETH-EUR',
      newClientOrderIds: ['1', '2'],
    })
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.equal(
      'Batch order cancel not supported for this exchange',
    )
  })

  it('places a bulk placement one at a time, in input order', async () => {
    const { ex, placed } = base()
    const results: BaseReturn<CommonOrder>[] = await ex.openOrdersBatch({
      symbol: 'ETH-EUR',
      orders: [order('A'), order('B'), order('C')],
    })
    expect(placed).to.deep.equal(['A', 'B', 'C'])
    expect(results.map((r) => r.status)).to.deep.equal([
      StatusEnum.ok,
      StatusEnum.ok,
      StatusEnum.ok,
    ])
  })
})
