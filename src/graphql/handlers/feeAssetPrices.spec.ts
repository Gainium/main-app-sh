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
        from: T0 + 2 * MIN,
        to: T0 + 3 * MIN - 1,
      },
    ])
  })

  it('one tick of requests is one window per pair; repeats are cached', async () => {
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
    expect(sourceCalls[0]).to.deep.include({ from: T0, to: T0 + 6 * MIN - 1 })
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
      at: T0 + i * 2 * 60 * MIN, // two hours apart: one window each
    }))
    const first = await svc.prices(reqs)
    expect(sourceCalls).to.have.length(MAX_WINDOWS_PER_CALL)
    const unknown = reqs.filter((r) => first.get(priceKey(r)) === null)
    expect(unknown).to.have.length(5)
    const second = await svc.prices(unknown)
    expect(sourceCalls).to.have.length(MAX_WINDOWS_PER_CALL + 5)
    for (const r of unknown) expect(second.get(priceKey(r))).to.be.a('number')
  })

  describe('windowsOf', () => {
    it('splits on gaps over an hour and on a 1000-minute span', () => {
      expect(windowsOf([T0, T0 + 60 * MIN, T0 + 122 * MIN])).to.deep.equal([
        [T0, T0 + 60 * MIN],
        [T0 + 122 * MIN],
      ])
      const dense = Array.from({ length: 1500 }, (_, i) => T0 + i * MIN)
      const w = windowsOf(dense)
      expect(w.map((x: number[]) => x.length)).to.deep.equal([1000, 500])
    })
  })
})
