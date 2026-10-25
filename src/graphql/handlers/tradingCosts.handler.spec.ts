process.env.NODE_ENV = 'testing'

/**
 * `TradingCostsService` (main-app spec 050 §4–§5): what it reads, how often,
 * and that recorded close-time facts are used without reading orders. The DAO
 * reads are answered by stubs; the arithmetic is real.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../../types'

const load = createRequire(__filename)
const dbInit = load('../../db/dbInit')
const { TradingCostsService } = load('./tradingCosts.handler')
const { FeeAssetPrices } = load('./feeAssetPrices')

const DAOS = [
  'orderDb',
  'dcaBotDb',
  'comboBotDb',
  'dcaDealsDb',
  'comboDealsDb',
  'feeDb',
  'userDb',
  'pairDb',
]
const saved: Record<string, any> = {}
const savedAggregate: Record<string, any> = {}
let calls: Record<string, any[]> = {}
let answers: Record<string, (search: any, fields: any, opts: any) => any[]> = {}

const BOT = 'aaaaaaaaaaaaaaaaaaaaaaaa'

const fresh = () => {
  ;(TradingCostsService as any)._instance = null
  return TradingCostsService.getInstance()
}

describe('TradingCostsService', () => {
  before(() => {
    for (const name of DAOS) {
      saved[name] = dbInit[name].readData
      dbInit[name].readData = async (search: any, fields: any, opts: any) => {
        calls[name] = [...(calls[name] ?? []), search]
        return {
          status: StatusEnum.ok,
          data: { result: (answers[name] ?? (() => []))(search, fields, opts) },
        }
      }
      savedAggregate[name] = dbInit[name].aggregate
      dbInit[name].aggregate = async (pipeline: any[]) => {
        const key = `${name}.aggregate`
        calls[key] = [...(calls[key] ?? []), pipeline]
        return {
          status: StatusEnum.ok,
          data: { result: (answers[key] ?? (() => []))(pipeline, null, null) },
        }
      }
    }
  })
  after(() => {
    for (const name of DAOS) {
      dbInit[name].readData = saved[name]
      dbInit[name].aggregate = savedAggregate[name]
    }
  })
  beforeEach(() => {
    calls = {}
    answers = {}
    ;(FeeAssetPrices as any)._instance = null
  })

  it('order slippage from a recorded reference reads nothing', async () => {
    const s = await fresh().orderSlippage({
      type: 'MARKET',
      status: 'FILLED',
      side: 'BUY',
      typeOrder: 'dealStart',
      botId: BOT,
      refPrice: '100',
      executedQty: '1',
      price: '100.1',
    })
    expect(s?.source).to.equal('recorded')
    expect(calls).to.deep.equal({})
  })

  it('a LIMIT order is null and reads nothing', async () => {
    expect(
      await fresh().orderSlippage({ type: 'LIMIT', refPrice: '1' }),
    ).to.equal(null)
    expect(calls).to.deep.equal({})
  })

  it('base orders of one batch read their bots once, DCA first then combo', async () => {
    answers.dcaBotDb = () => [{ _id: BOT, settings: { type: 'regular' } }]
    const svc = fresh()
    const order = (over: any) => ({
      type: 'MARKET',
      status: 'FILLED',
      side: 'BUY',
      typeOrder: 'dealStart',
      executedQty: '1',
      price: '100',
      origPrice: '99.5',
      ...over,
    })
    const [a, b, c] = await Promise.all([
      svc.orderSlippage(order({ botId: BOT })),
      svc.orderSlippage(order({ botId: BOT })),
      svc.orderSlippage(order({ botId: 'bbbbbbbbbbbbbbbbbbbbbbbb' })),
    ])
    expect(a?.source).to.equal('reconstructed')
    expect(b?.source).to.equal('reconstructed')
    expect(c).to.equal(null)
    expect(calls.dcaBotDb).to.have.length(1)
    expect(calls.comboBotDb).to.have.length(1)
    expect(calls.comboBotDb[0]._id.$in).to.deep.equal([
      'bbbbbbbbbbbbbbbbbbbbbbbb',
    ])
  })

  it('a deal with recorded close-time facts reads no orders', async () => {
    const deal = {
      _id: 'd1',
      status: 'closed',
      profit: { total: -1 },
      commission: 0.4,
      settings: { profitCurrency: 'quote' },
      slippage: {
        quote: 0.1,
        bps: 2,
        orders: 2,
        reconstructed: false,
        notional: 500,
      },
      feesEstimated: false,
    }
    const svc = fresh()
    expect(await svc.dealSlippage(deal)).to.deep.equal({
      quote: 0.1,
      bps: 2,
      orders: 2,
      reconstructed: false,
    })
    const b = await svc.dealCostBreakdown(deal)
    expect(b?.netQuote).to.equal(-1)
    expect(b?.feesQuote).to.equal(0.4)
    expect(b?.grossQuote).to.be.closeTo(-0.5, 1e-12)
    expect(calls.orderDb).to.equal(undefined)
  })

  it('a page of historical deals costs one orders read by dealId', async () => {
    answers.orderDb = (search) =>
      search.dealId.$in.flatMap((dealId: string) => [
        {
          dealId,
          type: 'MARKET',
          status: 'FILLED',
          side: 'SELL',
          typeOrder: 'dealTP',
          origPrice: '100',
          executedQty: '1',
          price: '99',
          feePaid: '0.1',
        },
        {
          dealId,
          type: 'LIMIT',
          status: 'FILLED',
          side: 'BUY',
          typeOrder: 'dealStart',
          executedQty: '1',
          price: '95',
        },
      ])
    const svc = fresh()
    const deals = ['d1', 'd2', 'd3'].map((_id) => ({
      _id,
      status: 'closed',
      profit: { total: 3 },
      commission: 0.2,
      settings: { profitCurrency: 'quote' },
    }))
    const results = await Promise.all(
      deals.map((d) => svc.dealCostBreakdown(d)),
    )
    const slips = await Promise.all(deals.map((d) => svc.dealSlippage(d)))
    expect(calls.orderDb).to.have.length(1)
    expect(calls.orderDb[0].dealId.$in).to.deep.equal(['d1', 'd2', 'd3'])
    for (const r of results) {
      expect(r).to.deep.equal({
        grossQuote: 4.2,
        feesQuote: 0.2,
        feesEstimated: true,
        slippageQuote: 1,
        netQuote: 3,
      })
    }
    expect(slips[0]?.orders).to.equal(1)
  })

  it('a running deal has no cost breakdown and reads nothing for it', async () => {
    expect(
      await fresh().dealCostBreakdown({ _id: 'd9', status: 'open' }),
    ).to.equal(null)
    expect(calls).to.deep.equal({})
  })

  it('bot aggregate: recorded deals as stored, historical deals from the bot’s MARKET orders', async () => {
    answers.dcaDealsDb = () => [
      {
        _id: 'd1',
        botId: BOT,
        status: 'closed',
        profit: { total: 2 },
        commission: 0.5,
        settings: { profitCurrency: 'quote' },
        symbol: { quoteAsset: 'USDT' },
        slippage: {
          quote: 0.25,
          bps: 1,
          orders: 1,
          reconstructed: false,
          notional: 100,
        },
        feesEstimated: false,
      },
      {
        _id: 'd2',
        botId: BOT,
        status: 'closed',
        profit: { total: -1 },
        commission: 0.5,
        settings: { profitCurrency: 'quote' },
        symbol: { quoteAsset: 'USDT' },
      },
    ]
    answers.orderDb = (search) =>
      search.type === 'MARKET'
        ? [
            {
              dealId: 'd2',
              botId: BOT,
              type: 'MARKET',
              status: 'FILLED',
              side: 'BUY',
              typeOrder: 'dealRegular',
              origPrice: '10',
              executedQty: '1',
              price: '10.05',
            },
          ]
        : []
    // the fee probe: this bot has an executed trade with no reported fee
    answers['orderDb.aggregate'] = () => [{ _id: BOT }]
    const row = await fresh().botTradingCosts({ _id: BOT })
    expect(row).to.deep.include({
      quoteAsset: 'USDT',
      deals: 2,
      netQuote: 1,
      feesQuote: 1,
      feesEstimated: true,
      // d2's safety order is read from its origPrice
      slippageReconstructed: true,
    })
    expect(row.slippageQuote).to.be.closeTo(0.3, 1e-9)
    expect(row.grossQuote).to.be.closeTo(2.3, 1e-9)
    // deals by botId in both collections; the MARKET scan + the fee probe.
    expect(calls.dcaDealsDb[0].botId.$in).to.deep.equal([BOT])
    // closed deals only, in both collections
    expect(calls.dcaDealsDb[0].status).to.equal('closed')
    expect(calls.comboDealsDb[0].status).to.equal('closed')
    expect(calls.comboDealsDb[0].botId.$in).to.deep.equal([BOT])
    expect(calls.orderDb).to.have.length(1)
    expect(calls.orderDb[0].botId.$in).to.deep.equal([BOT])
    expect(calls['orderDb.aggregate']).to.have.length(1)
  })

  it('an account of many bots reads orders per chunk of bots, not per bot (198 §3)', async () => {
    // 1,200 bots = 3 chunks of 500; each bot: one historical deal on a
    // fee-token venue, one safety order 10 or 20 bps above its reference.
    const bots = Array.from({ length: 1200 }, (_, i) =>
      (0xb00000 + i).toString(16).padStart(24, '0'),
    )
    answers.dcaDealsDb = (search) =>
      bots
        .filter((botId) => !search.botId || search.botId.$in.includes(botId))
        .map((botId) => ({
          _id: `d${bots.indexOf(botId)}`,
          botId,
          status: 'closed',
          exchange: 'binance',
          profit: { total: 1 },
          commission: 0.1,
          settings: { profitCurrency: 'quote' },
          symbol: { quoteAsset: 'USDT' },
        }))
    const slip = (i: number) => (i % 2 ? 0.01 : 0.02)
    answers.orderDb = (search) =>
      search.type === 'MARKET'
        ? search.botId.$in.map((botId: string) => {
            const i = bots.indexOf(botId)
            return {
              dealId: `d${i}`,
              botId,
              type: 'MARKET',
              status: 'FILLED',
              side: 'BUY',
              typeOrder: 'dealRegular',
              origPrice: '10',
              executedQty: '1',
              price: `${10 + slip(i)}`,
            }
          })
        : []
    // only the first bot has a trade with no venue-reported fee
    answers['orderDb.aggregate'] = (pipeline) =>
      pipeline[0].$match.botId.$in.includes(bots[0]) ? [{ _id: bots[0] }] : []
    const svc = fresh()
    const [row] = await svc.accountTradingCosts('u1', false, {
      botType: 'dca',
    })
    expect(row.deals).to.equal(1200)
    // each bot's slippage attributed to its own deal: 600 × 0.02 + 600 × 0.01
    expect(row.slippageQuote).to.be.closeTo(18, 1e-6)
    expect(row.feesEstimated).to.equal(true)
    // 3 chunks: a MARKET read + a fee-bearing read each; one probe each
    expect(calls.orderDb).to.have.length(6)
    expect(calls['orderDb.aggregate']).to.have.length(3)
    // settings of 500 bots per read
    expect(calls.dcaBotDb.length).to.be.at.most(3)
    const one = await svc.botTradingCosts({ _id: bots[1] })
    expect(one.feesEstimated).to.equal(false)
    expect(one.slippageQuote).to.be.closeTo(0.01, 1e-9)
    // served from the caches the account read filled
    expect(calls.orderDb).to.have.length(6)
  })

  it('a cancelled deal the store returns anyway is not counted', async () => {
    answers.dcaDealsDb = () => [
      {
        _id: 'd1',
        botId: BOT,
        status: 'closed',
        profit: { total: 1 },
        commission: 0.1,
        settings: { profitCurrency: 'quote' },
        symbol: { quoteAsset: 'USDT' },
        feesEstimated: false,
      },
      {
        _id: 'd2',
        botId: BOT,
        status: 'canceled',
        profit: { total: -1 },
        commission: 0.1,
        settings: { profitCurrency: 'quote' },
        symbol: { quoteAsset: 'USDT' },
        feesEstimated: false,
      },
    ]
    const row = await fresh().botTradingCosts({ _id: BOT })
    expect(row?.deals).to.equal(1)
    expect(row?.netQuote).to.equal(1)
  })

  it('account summary filters by closeTime and bot type', async () => {
    const svc = fresh()
    const rows = await svc.accountTradingCosts('u1', false, {
      from: 10,
      to: 20,
      botType: 'combo',
    })
    expect(rows).to.deep.equal([])
    expect(calls.dcaDealsDb).to.equal(undefined)
    expect(calls.comboDealsDb[0]).to.deep.include({
      userId: 'u1',
      status: 'closed',
      closeTime: { $gte: 10, $lte: 20 },
      parentBotId: { $exists: false },
    })
  })

  describe('order fee (§4.4)', () => {
    const USER = 'cccccccccccccccccccccccc'
    const order = (over: any) => ({
      userId: USER,
      exchange: 'binance',
      exchangeUUID: 'acc-1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      type: 'MARKET',
      status: 'FILLED',
      side: 'BUY',
      executedQty: '1',
      cummulativeQuoteQty: '100',
      ...over,
    })

    it('a venue-reported fee reads nothing', async () => {
      const f = await fresh().orderFee(
        order({ feePaid: '0.1', feeSide: 'quote' }),
      )
      expect(f).to.deep.equal({ feeQuote: 0.1, feeEstimated: false })
      expect(calls).to.deep.equal({})
    })

    it('estimates read the stored rates once per user per batch', async () => {
      answers.feeDb = () => [
        {
          userId: USER,
          exchangeUUID: 'acc-1',
          pair: 'BTCUSDT',
          maker: 0.001,
          taker: 0.002,
        },
      ]
      answers.userDb = () => [
        { _id: USER, exchanges: [{ uuid: 'acc-2', zeroFee: true }] },
      ]
      const svc = fresh()
      const [a, b, c] = await Promise.all([
        svc.orderFee(order({})),
        svc.orderFee(order({ type: 'LIMIT' })),
        svc.orderFee(order({ symbol: 'ETHUSDT' })),
      ])
      expect(a.feeEstimated).to.equal(true)
      expect(a.feeQuote).to.be.closeTo(0.2, 1e-12)
      expect(b.feeQuote).to.be.closeTo(0.1, 1e-12)
      expect(c).to.deep.equal({ feeQuote: null, feeEstimated: null })
      expect(calls.feeDb).to.have.length(1)
      expect(calls.userDb).to.have.length(1)
    })

    it('a zero-fee connection estimates 0, as the engine does', async () => {
      answers.feeDb = () => [
        {
          userId: USER,
          exchangeUUID: 'acc-2',
          pair: 'BTCUSDT',
          maker: 0.001,
          taker: 0.002,
        },
      ]
      answers.userDb = () => [
        { _id: USER, exchanges: [{ uuid: 'acc-2', zeroFee: true }] },
      ]
      const f = await fresh().orderFee(order({ exchangeUUID: 'acc-2' }))
      expect(f).to.deep.equal({ feeQuote: 0, feeEstimated: true })
    })
  })
  describe('fees charged in a third asset', () => {
    const USER = 'cccccccccccccccccccccccc'
    const T = 1_792_674_087_768
    let sourceCalls: any[] = []
    const withPrices = (mid: number | null) => {
      sourceCalls = []
      answers.pairDb = (search) =>
        search.exchange === 'binance' && search['baseAsset.name'] === 'BNB'
          ? [
              {
                pair: 'BNBUSDT',
                baseAsset: { name: 'BNB' },
                quoteAsset: { name: 'USDT' },
              },
            ]
          : []
      FeeAssetPrices.getInstance().setCandleSource(async (q: any) => {
        sourceCalls.push(q)
        if (mid === null) return []
        const rows = []
        for (let t = q.from; t <= q.to; t += 60_000) {
          rows.push({ t, o: mid, h: mid, l: mid, c: mid })
        }
        return rows
      })
    }
    const bnbOrder = (over: any) => ({
      userId: USER,
      exchange: 'binance',
      exchangeUUID: 'acc-1',
      symbol: 'HYPEUSDT',
      baseAsset: 'HYPE',
      quoteAsset: 'USDT',
      type: 'MARKET',
      status: 'FILLED',
      side: 'SELL',
      typeOrder: 'dealTP',
      executedQty: '1',
      cummulativeQuoteQty: '100',
      transactTime: T,
      feePaid: '0.00001',
      feeAsset: 'BNB',
      ...over,
    })

    it('an order fee in BNB is valued at the fill minute and flagged converted', async () => {
      withPrices(600)
      const f = await fresh().orderFee(bnbOrder({}))
      expect(f.feeEstimated).to.equal(false)
      expect(f.feeConverted).to.equal(true)
      expect(f.feeQuote).to.be.closeTo(0.006, 1e-12)
      expect(sourceCalls).to.have.length(1)
      expect(sourceCalls[0]).to.deep.include({
        exchange: 'binance',
        symbol: 'BNBUSDT',
        interval: '1m',
        // the fill's whole UTC day
        from: 1_792_627_200_000,
        to: 1_792_627_200_000 + 86_400_000 - 1,
      })
      // a venue-reported fee: no stored-rate read
      expect(calls.feeDb).to.equal(undefined)
    })

    it('an unpriced BNB fee stays unknown — never 0, never the estimate', async () => {
      withPrices(null)
      const f = await fresh().orderFee(bnbOrder({}))
      expect(f).to.deep.equal({ feeQuote: null, feeEstimated: false })
      expect(calls.feeDb).to.equal(undefined)
    })

    it('without a candle source nothing is read for it', async () => {
      const f = await fresh().orderFee(bnbOrder({}))
      expect(f).to.deep.equal({ feeQuote: null, feeEstimated: false })
      expect(calls).to.deep.equal({})
    })

    it('a closed deal reports them beside the breakdown; fees / gross / net unchanged', async () => {
      withPrices(600)
      answers.orderDb = () => [
        bnbOrder({ dealId: 'd1' }),
        bnbOrder({
          dealId: 'd1',
          type: 'LIMIT',
          side: 'BUY',
          typeOrder: 'dealStart',
          transactTime: T - 3_600_000,
          updateTime: T - 60_000,
          feePaid: '0.00002',
        }),
        // on-pair fee: booked, not reported here
        bnbOrder({
          dealId: 'd1',
          typeOrder: 'dealRegular',
          feeAsset: 'USDT',
          feePaid: '0.1',
        }),
      ]
      const deal = {
        _id: 'd1',
        status: 'closed',
        exchange: 'binance',
        profit: { total: -1 },
        commission: 0.4,
        settings: { profitCurrency: 'quote' },
        slippage: {
          quote: 0.1,
          bps: 2,
          orders: 2,
          reconstructed: false,
          notional: 500,
        },
        feesEstimated: false,
      }
      const b = await fresh().dealCostBreakdown(deal)
      expect(b?.netQuote).to.equal(-1)
      expect(b?.feesQuote).to.equal(0.4)
      expect(b?.grossQuote).to.be.closeTo(-0.5, 1e-12)
      expect(b?.unbookedFeesQuote).to.be.closeTo(0.018, 1e-12)
      expect(b?.unbookedFeesPartial).to.equal(false)
      expect(b?.unbookedFeeAssets).to.deep.equal(['BNB'])
      expect(calls.orderDb).to.have.length(1)
      expect(calls.orderDb[0].dealId.$in).to.deep.equal(['d1'])
      // both minutes in one window
      expect(sourceCalls).to.have.length(1)
    })

    it('a deal with an unpriced one is partial; with none priced the amount is null', async () => {
      withPrices(null)
      answers.orderDb = () => [bnbOrder({ dealId: 'd1' })]
      const b = await fresh().dealCostBreakdown({
        _id: 'd1',
        status: 'closed',
        exchange: 'binance',
        profit: { total: 1 },
        commission: 0,
        settings: { profitCurrency: 'quote' },
        feesEstimated: false,
      })
      expect(b?.netQuote).to.equal(1)
      expect(b?.unbookedFeesQuote).to.equal(null)
      expect(b?.unbookedFeesPartial).to.equal(true)
    })

    it('bot aggregate: one read of the bot’s fee-bearing orders, summed separately', async () => {
      withPrices(600)
      answers.dcaDealsDb = () => [
        {
          _id: 'd1',
          botId: BOT,
          status: 'closed',
          exchange: 'binance',
          profit: { total: 2 },
          commission: 0.5,
          settings: { profitCurrency: 'quote' },
          symbol: { quoteAsset: 'USDT' },
          feesEstimated: false,
        },
        {
          _id: 'd2',
          botId: BOT,
          status: 'closed',
          exchange: 'binance',
          profit: { total: 1 },
          commission: 0.5,
          settings: { profitCurrency: 'quote' },
          symbol: { quoteAsset: 'USDT' },
          feesEstimated: false,
        },
      ]
      answers.orderDb = (search) =>
        search.botId?.$in?.includes(BOT) && search.$or
          ? [
              bnbOrder({ dealId: 'd1', botId: BOT }),
              bnbOrder({ dealId: 'd2', botId: BOT }),
            ]
          : []
      const row = await fresh().botTradingCosts({ _id: BOT })
      expect(row).to.deep.include({
        deals: 2,
        netQuote: 3,
        feesQuote: 1,
        unbookedFeesPartial: false,
      })
      expect(row.grossQuote).to.be.closeTo(4, 1e-12)
      expect(row.unbookedFeesQuote).to.be.closeTo(0.012, 1e-12)
      expect(calls.orderDb).to.have.length(1)
      expect(calls.orderDb[0]).to.deep.include({
        botId: { $in: [BOT] },
        status: 'FILLED',
      })
    })
    it('fee-ledger vs plain deal: same breakdown, only the ledger deal reports the USD deduction', async () => {
      withPrices(600)
      answers.orderDb = (search) =>
        search.dealId.$in.flatMap((dealId: string) => [bnbOrder({ dealId })])
      const common = {
        status: 'closed',
        exchange: 'binance',
        profit: { total: 2, totalUsd: 2 - 0.0061 },
        commission: 0.1,
        settings: { profitCurrency: 'quote' },
        symbol: { baseAsset: 'HYPE', quoteAsset: 'USDT' },
        feesEstimated: false,
      }
      const svc = fresh()
      const [ledger, plain] = await Promise.all([
        svc.dealCostBreakdown({
          ...common,
          _id: 'd1',
          flags: ['feeByAsset'],
          feeByAsset: [{ asset: 'BNB', total: 0.00001, totalUsd: 0.0061 }],
        }),
        svc.dealCostBreakdown({
          ...common,
          _id: 'd2',
          profit: { total: 2, totalUsd: 2 },
        }),
      ])
      for (const b of [ledger, plain]) {
        expect(b).to.deep.include({
          netQuote: 2,
          feesQuote: 0.1,
          grossQuote: 2.1,
        })
        expect(b?.unbookedFeesQuote).to.be.closeTo(0.006, 1e-12)
      }
      expect(ledger).to.deep.include({
        unbookedFeesInUsdProfit: true,
        unbookedFeesUsd: 0.0061,
      })
      expect(plain).to.deep.include({
        unbookedFeesInUsdProfit: false,
        unbookedFeesUsd: null,
      })
      // one orders read for the page, both deals
      expect(calls.orderDb).to.have.length(1)
    })
  })
})
