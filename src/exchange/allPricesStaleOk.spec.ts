process.env.NODE_ENV = 'testing'

/**
 * Dashboard USD valuation never waits on a parked price-table fetch.
 *
 * Spec: `specs/123.in-positions-waits-on-a-parked-price-table.md`.
 * Run: `npm test` (mocha).
 *
 * The real `Exchange` methods are driven off the prototype against an
 * in-memory Redis hash and a connector that can be held open, which is what a
 * Binance `latestPrices` parked until the next minute looks like from here.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import Exchange from './exchange'
import RedisClient from '../db/redis'
import { rateDb } from '../db/dbInit'
import { priceBalancesUsd } from '../utils/user'
import { ExchangeEnum, StatusEnum } from '../../types'

const MINUTE = 60 * 1000

const table = (price: number, endTime: number) =>
  JSON.stringify({
    status: StatusEnum.ok,
    reason: null,
    data: [{ pair: 'BTCUSDT', price }],
    timeProfile: { exchangeRequestEndTime: endTime },
  })

/** An in-memory stand-in for the two Redis hashes the price table lives in. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>()
  const h = (key: string) => {
    let m = hashes.get(key)
    if (!m) {
      m = new Map()
      hashes.set(key, m)
    }
    return m
  }
  return {
    hashes,
    client: {
      isReady: true,
      hGet: async (key: string, field: string) => h(key).get(field),
      hSet: async (key: string, field: string, value: string) => {
        h(key).set(field, value)
        return 1
      },
      hDel: async (key: string, field: string) => {
        h(key).delete(field)
        return 1
      },
      hExpire: async () => [1],
    },
  }
}

/**
 * A connector whose `prices` answer is held until `release()` — or forever.
 */
function connector() {
  const calls: unknown[] = []
  let release: (price: number) => void = () => undefined
  const ex: any = Object.create((Exchange as any).prototype)
  ex.exchange = ExchangeEnum.binance
  ex.allPricesCachePeriod = MINUTE
  ex.getEmptyTimeProfile = () => ({})
  ex.saveTimeProfile = () => undefined
  ex.apiCall = (call: unknown) => {
    calls.push(call)
    return new Promise((resolve) => {
      release = (price: number) =>
        resolve({
          data: JSON.parse(table(price, Date.now())),
          timeProfile: {},
        })
    })
  }
  return { ex, calls, release: (price: number) => release(price) }
}

const settle = () => new Promise((r) => setTimeout(r, 120))

/** Resolves to 'timeout' if `p` has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms)),
  ])

describe('getAllPricesStaleOk (spec 123)', () => {
  let redis: ReturnType<typeof fakeRedis>
  let savedGetInstance: unknown

  beforeEach(() => {
    redis = fakeRedis()
    savedGetInstance = (RedisClient as any).getInstance
    ;(RedisClient as any).getInstance = async () => redis.client
  })
  afterEach(() => {
    ;(RedisClient as any).getInstance = savedGetInstance
  })

  it('§1.1.1/§1.1.2 expired cache + parked connector: answers at once from the last good table and refreshes in the background', async () => {
    redis.hashes.set(
      'allPriceLast',
      new Map([[ExchangeEnum.binance, table(50000, Date.now() - 5 * MINUTE)]]),
    )
    const { ex, calls, release } = connector()

    const res = await within(ex.getAllPricesStaleOk(), 200)

    expect(res).to.not.equal('timeout')
    expect((res as any).data[0].price).to.equal(50000)
    // §1.1.2: one background refresh is on its way to the connector.
    await settle()
    expect(calls).to.have.length(1)

    release(51000)
    await settle()
    const last = JSON.parse(
      redis.hashes.get('allPriceLast')!.get(ExchangeEnum.binance)!,
    )
    expect(last.data[0].price).to.equal(51000)
    expect(redis.hashes.get('allPrice')!.get(ExchangeEnum.binance)).to.be.a(
      'string',
    )
  })

  it('§1.1.2 a last good table younger than the cache period is used with no connector call', async () => {
    redis.hashes.set(
      'allPriceLast',
      new Map([[ExchangeEnum.binance, table(50000, Date.now() - 10 * 1000)]]),
    )
    const { ex, calls } = connector()

    const res = await ex.getAllPricesStaleOk()

    expect(res.data[0].price).to.equal(50000)
    expect(calls).to.have.length(0)
  })

  it('§1.1.3 with no stored table at all, waits on the live fetch', async () => {
    const { ex, calls, release } = connector()

    const pending = ex.getAllPricesStaleOk()
    expect(await within(pending, 150)).to.equal('timeout')
    release(52000)

    const res = await pending
    expect(res.data[0].price).to.equal(52000)
    expect(calls).to.have.length(1)
  })

  it('§1.1.5 repeated stale reads during a stall join one connector call', async () => {
    redis.hashes.set(
      'allPriceLast',
      new Map([[ExchangeEnum.binance, table(50000, Date.now() - 5 * MINUTE)]]),
    )
    const { ex, calls, release } = connector()

    await ex.getAllPricesStaleOk()
    await ex.getAllPricesStaleOk()
    await ex.getAllPricesStaleOk()
    await settle()

    expect(calls).to.have.length(1)
    release(51000)
    await settle()
  })

  it('§1.1.4 getAllPrices itself still waits on the connector once the minute cache is gone', async () => {
    redis.hashes.set(
      'allPriceLast',
      new Map([[ExchangeEnum.binance, table(50000, Date.now() - 5 * MINUTE)]]),
    )
    const { ex, calls, release } = connector()

    const pending = ex.getAllPrices()
    expect(await within(pending, 150)).to.equal('timeout')
    release(53000)

    const res = await pending
    expect(res.data[0].price).to.equal(53000)
    expect(calls).to.have.length(1)
  })
})

describe('priceBalancesUsd on a parked connector (spec 123 §1.1.1)', () => {
  let redis: ReturnType<typeof fakeRedis>
  const saved: Record<string, any> = {}

  beforeEach(() => {
    redis = fakeRedis()
    saved.getInstance = (RedisClient as any).getInstance
    ;(RedisClient as any).getInstance = async () => redis.client
    saved.readData = rateDb.readData
    ;(rateDb as any).readData = async () => ({
      status: StatusEnum.ok,
      data: { result: { usdRate: 1, fiatRates: [] } },
    })
  })
  afterEach(() => {
    ;(RedisClient as any).getInstance = saved.getInstance
    ;(rateDb as any).readData = saved.readData
  })

  it('values the balance from the last good table instead of waiting on the connector', async () => {
    redis.hashes.set(
      'allPriceLast',
      new Map([[ExchangeEnum.binance, table(50000, Date.now() - 5 * MINUTE)]]),
    )
    const { ex, release } = connector()
    const ec: any = { chooseExchangeFactory: () => () => ex }

    const res = await within(
      priceBalancesUsd(
        [
          {
            asset: 'BTC',
            free: 2,
            locked: 0,
            exchange: ExchangeEnum.binance,
            exchangeUUID: 'u1',
          },
        ],
        ec,
      ),
      500,
    )

    expect(res).to.not.equal('timeout')
    expect((res as Map<string, any>).get('u1:BTC')).to.deep.equal({
      price: 50000,
      usdValue: 100000,
    })
    release(51000)
    await settle()
  })
})
