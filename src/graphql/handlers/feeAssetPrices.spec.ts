process.env.NODE_ENV = 'testing'

/**
 * `FeeAssetPrices`: what it reads to price a fee asset at a fill, how the
 * reads are batched and cached, and that a missing price stays unknown.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../../types'

const load = createRequire(__filename)
const dbInit = load('../../db/dbInit')
const { FeeAssetPrices, MAX_WINDOWS_PER_CALL, priceKey, windowsOf } =
  load('./feeAssetPrices')

const MIN = 60_000
const T0 = 1_792_674_060_000 // a minute boundary
const DAY = 24 * 60 * MIN
const D0 = Math.floor(T0 / DAY) * DAY // its UTC day

const PAIRS: Record<string, { pair: string; base: string; quote: string }[]> = {
  'binance|BNB': [
    { pair: 'BNBUSDT', base: 'BNB', quote: 'USDT' },
    { pair: 'BNBBTC', base: 'BNB', quote: 'BTC' },
  ],
  'bitget|BGB': [{ pair: 'BGBUSDT', base: 'BGB', quote: 'USDT' }],
}

let pairReads: any[] = []
let sourceCalls: any[] = []
let saved: any

const candle = (t: number, mid: number) => ({
  t,
  o: mid,
  h: mid + 1,
  l: mid - 1,
  c: mid,
})

const fresh = (withSource = true) => {
  ;(FeeAssetPrices as any)._instance = null
  const svc = FeeAssetPrices.getInstance()
  if (withSource) {
    svc.setCandleSource(async (q: any) => {
      sourceCalls.push(q)
      const rows = []
      for (let t = q.from; t <= q.to; t += MIN) {
        // BNB 600 + minutes since T0; nothing for BGB's second minute.
        if (q.symbol === 'BGBUSDT' && t === T0 + MIN) continue
        rows.push(candle(t, q.symbol === 'BGBUSDT' ? 5 : 600 + (t - T0) / MIN))
      }
      return rows
    })
  }
  return svc
}

describe('FeeAssetPrices', () => {
  before(() => {
    saved = dbInit.pairDb.readData
    dbInit.pairDb.readData = async (search: any) => {
      pairReads.push(search)
      return {
        status: StatusEnum.ok,
        data: {
          result: (
            PAIRS[`${search.exchange}|${search['baseAsset.name']}`] ?? []
          ).map((p) => ({
            pair: p.pair,
            baseAsset: { name: p.base },
            quoteAsset: { name: p.quote },
          })),
        },
      }
    }
  })
  after(() => {
    dbInit.pairDb.readData = saved
  })
  beforeEach(() => {
    pairReads = []
    sourceCalls = []
  })

  it('without a candle source every price is unknown and nothing is read', async () => {
    const svc = fresh(false)
    const req = { venue: 'binance', asset: 'BNB', quote: 'USDT', at: T0 }
    expect(await svc.priceOne(req)).to.equal(null)
    const m = await svc.prices([req])
    expect(m.get(priceKey(req))).to.equal(null)
    expect(pairReads).to.deep.equal([])
  })

  it('prices from the 1m candle containing the time (OHLC4)', async () => {
    const svc = fresh()
    const p = await svc.priceOne({
      venue: 'binance',
      asset: 'BNB',
      quote: 'USDT',
      at: T0 + 2 * MIN + 59_000,
    })
    expect(p).to.equal(602)
    expect(sourceCalls).to.deep.equal([
      {
        exchange: 'binance',
        symbol: 'BNBUSDT',
        interval: '1m',
        // the whole UTC day, one read
        from: D0,
        to: D0 + DAY - 1,
      },
    ])
  })

  it('one tick of requests is one day read per pair; repeats are cached', async () => {
    const svc = fresh()
    const reqs = [0, 1, 5].map((i) => ({
      venue: 'binance',
      asset: 'BNB',
      quote: 'USDT',
      at: T0 + i * MIN + 10,
    }))
    const ps = await Promise.all(reqs.map((r) => svc.priceOne(r)))
    expect(ps).to.deep.equal([600, 601, 605])
    expect(sourceCalls).to.have.length(1)
    expect(sourceCalls[0]).to.deep.include({ from: D0, to: D0 + DAY - 1 })
    expect(pairReads).to.have.length(2) // BNB and USDT as bases, once each
    await svc.prices(reqs)
    expect(sourceCalls).to.have.length(1)
    expect(pairReads).to.have.length(2)
  })

  it('a minute with no candle is unknown (never 0) and remembered briefly', async () => {
    const svc = fresh()
    const req = { venue: 'bitget', asset: 'BGB', quote: 'USDT', at: T0 + MIN }
    expect(await svc.priceOne(req)).to.equal(null)
    expect(await svc.priceOne(req)).to.equal(null)
    expect(sourceCalls).to.have.length(1)
    expect(await svc.priceOne({ ...req, at: T0 })).to.equal(5)
  })

  it('no route (no fee-asset pair on the venue) reads no candles', async () => {
    const svc = fresh()
    expect(
      await svc.priceOne({
        venue: 'kucoin',
        asset: 'KCS',
        quote: 'USDT',
        at: T0,
      }),
    ).to.equal(null)
    expect(sourceCalls).to.deep.equal([])
  })

  it('a source failure is not remembered as a miss', async () => {
    const svc = fresh(false)
    let fail = true
    svc.setCandleSource(async (q: any) => {
      sourceCalls.push(q)
      if (fail) return null
      return [candle(T0, 600)]
    })
    const req = { venue: 'binance', asset: 'BNB', quote: 'USDT', at: T0 }
    expect(await svc.priceOne(req)).to.equal(null)
    fail = false
    expect(await svc.priceOne(req)).to.equal(600)
    expect(sourceCalls).to.have.length(2)
  })

  it('caps the windows read in one call; the rest stay unknown, not missing', async () => {
    const svc = fresh()
    const reqs = Array.from({ length: MAX_WINDOWS_PER_CALL + 5 }, (_, i) => ({
      venue: 'binance',
      asset: 'BNB',
      quote: 'USDT',
      at: T0 + i * DAY, // one day apart: one day read each
    }))
    const first = await svc.prices(reqs)
    expect(sourceCalls).to.have.length(MAX_WINDOWS_PER_CALL)
    const unknown = reqs.filter((r) => first.get(priceKey(r)) === null)
    expect(unknown).to.have.length(5)
    const second = await svc.prices(unknown)
    expect(sourceCalls).to.have.length(MAX_WINDOWS_PER_CALL + 5)
    for (const r of unknown) expect(second.get(priceKey(r))).to.be.a('number')
  })

  it('fills spread over a day cost one read, not one per gap', async () => {
    const svc = fresh()
    const spread = [0, 90, 300, 700].map((h) => ({
      venue: 'binance',
      asset: 'BNB',
      quote: 'USDT',
      at: D0 + h * MIN,
    }))
    await svc.prices(spread)
    expect(sourceCalls).to.have.length(1)
  })

  it('warm reads the days ahead, together; prices then values the same without reading (198 §3.3)', async () => {
    const reqs = [0, 1, 2, 3, 4, 5].map((d) => ({
      venue: 'binance',
      asset: 'BNB',
      quote: 'USDT',
      at: T0 - d * DAY,
    }))
    const cold = new Map<string, number | null>()
    for (const r of reqs) {
      for (const [k, v] of await fresh().prices([r])) cold.set(k, v)
    }
    const svc = fresh()
    let inFlight = 0
    let maxInFlight = 0
    const source = (svc as any).source
    svc.setCandleSource(async (q: any) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return source(q)
    })
    sourceCalls = []
    expect(await svc.warm(reqs)).to.equal(6)
    expect(sourceCalls).to.have.length(6)
    expect(maxInFlight).to.be.greaterThan(1)
    // one bot after another, as the trading-costs aggregate values them
    for (const r of reqs) {
      expect((await svc.prices([r])).get(priceKey(r))).to.equal(
        cold.get(priceKey(r)),
      )
    }
    expect(sourceCalls).to.have.length(6)
  })

  it('a day warm could not read is read again by prices', async () => {
    const svc = fresh()
    let fail = true
    const source = (svc as any).source
    svc.setCandleSource(async (q: any) => {
      sourceCalls.push(q)
      return fail ? null : source(q)
    })
    const r = { venue: 'binance', asset: 'BNB', quote: 'USDT', at: T0 }
    await svc.warm([r])
    fail = false
    expect((await svc.prices([r])).get(priceKey(r))).to.equal(600)
    // the warm read and the priced read
    expect(sourceCalls.filter((q) => q.symbol === 'BNBUSDT')).to.have.length(3)
  })

  describe('windowsOf', () => {
    it('one window per UTC day, cut at now', () => {
      const w = windowsOf(
        [D0 + MIN, D0 + 1439 * MIN, D0 + DAY + 5 * MIN],
        D0 + DAY + 10 * MIN,
      )
      expect(w).to.deep.equal([
        { from: D0, to: D0 + DAY - 1, minutes: [D0 + MIN, D0 + 1439 * MIN] },
        {
          from: D0 + DAY,
          to: D0 + DAY + 10 * MIN,
          minutes: [D0 + DAY + 5 * MIN],
        },
      ])
    })
  })
})
