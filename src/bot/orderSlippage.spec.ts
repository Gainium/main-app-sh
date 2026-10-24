process.env.NODE_ENV = 'testing'

/**
 * Order slippage and the deal cost decomposition (`orderSlippage.ts`).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  compoundReduceOf,
  dealCostBreakdown,
  dealSlippage,
  feesEstimatedOf,
  fillOf,
  marketReference,
  needsBotContext,
  needsStoredFeeRate,
  orderFeeQuote,
  orderSlippage,
  placementStampsOf,
  slippageContextFromBot,
  sumTradingCosts,
  isUnbookedFeeOrder,
  sumUnbookedFees,
  usdProfitFeeDeduction,
  withUnbookedFees,
  type SlippageBotContext,
} from './orderSlippage'

const market = (over: Record<string, unknown>) =>
  ({
    type: 'MARKET',
    status: 'FILLED',
    side: 'BUY',
    exchange: 'binance',
    typeOrder: 'dealTP',
    ...over,
  }) as any

const regularDca: SlippageBotContext = {
  kind: 'dca',
  terminal: false,
  compoundReduce: false,
  startOrderLimit: false,
}

const close = (a: number | null | undefined, b: number, eps = 1e-9) =>
  expect(a).to.be.a('number') &&
  expect(Math.abs((a as number) - b)).to.be.lessThan(eps)

describe('orderSlippage', () => {
  describe('sign: positive is adverse', () => {
    it('a BUY filled above the reference is positive', () => {
      const s = orderSlippage(
        market({
          side: 'BUY',
          refPrice: '100',
          executedQty: '2',
          cummulativeQuoteQty: '202',
        }),
      )
      close(s?.bps, 100)
      close(s?.quote, 2)
      expect(s?.source).to.equal('recorded')
      close(s?.notional, 200)
    })
    it('a SELL filled below the reference is positive', () => {
      const s = orderSlippage(
        market({
          side: 'SELL',
          refPrice: '100',
          executedQty: '2',
          cummulativeQuoteQty: '198',
        }),
      )
      close(s?.bps, 100)
      close(s?.quote, 2)
    })
    it('a SELL filled above the reference is negative (price improvement)', () => {
      const s = orderSlippage(
        market({
          side: 'SELL',
          refPrice: '100',
          executedQty: '1',
          cummulativeQuoteQty: '100.5',
        }),
      )
      close(s?.bps, -50)
      close(s?.quote, -0.5)
    })
  })

  describe('reference source', () => {
    it('recorded refPrice wins over origPrice', () => {
      const s = orderSlippage(
        market({
          refPrice: '100',
          origPrice: '90',
          executedQty: '1',
          price: '101',
        }),
      )
      expect(s?.refPrice).to.equal(100)
      expect(s?.source).to.equal('recorded')
    })
    it('origPrice is the (reconstructed) reference for TP, safety and fee orders', () => {
      for (const typeOrder of ['dealTP', 'dealRegular', 'fee']) {
        const s = orderSlippage(
          market({
            typeOrder,
            origPrice: '100',
            executedQty: '1',
            price: '100.1',
          }),
        )
        expect(s?.source, typeOrder).to.equal('reconstructed')
        close(s?.bps, 10, 1e-6)
      }
    })
    it('a dealStart without bot context is unknown', () => {
      const o = market({
        typeOrder: 'dealStart',
        origPrice: '99.5',
        executedQty: '1',
        price: '100',
      })
      expect(needsBotContext(o)).to.equal(true)
      expect(orderSlippage(o)).to.equal(null)
    })
    it('a dealStart with a recorded refPrice needs no context', () => {
      const o = market({
        typeOrder: 'dealStart',
        refPrice: '100',
        origPrice: '99.5',
        executedQty: '1',
        price: '100',
      })
      expect(needsBotContext(o)).to.equal(false)
      expect(orderSlippage(o)?.source).to.equal('recorded')
    })
    it('combo and terminal base orders: origPrice, reconstructed, no shift band', () => {
      const o = market({
        typeOrder: 'dealStart',
        origPrice: '100',
        executedQty: '1',
        price: '100.2',
      })
      for (const ctx of [
        { ...regularDca, kind: 'combo' as const },
        { ...regularDca, terminal: true },
      ]) {
        const s = orderSlippage(o, ctx)
        expect(s?.source).to.equal('reconstructed')
        close(s?.bps, 20, 1e-6)
      }
    })
    it('other order kinds without a recorded reference are unknown', () => {
      for (const typeOrder of [
        'regular',
        'stop',
        'swap',
        'liquidation',
        'split',
      ]) {
        expect(
          orderSlippage(
            market({
              typeOrder,
              origPrice: '100',
              executedQty: '1',
              price: '100',
            }),
          ),
          typeOrder,
        ).to.equal(null)
      }
    })
  })

  describe('regular DCA base order reconstruction (k = 0.005, count 0)', () => {
    it('long: origPrice = ref × (1 − 0.005)', () => {
      const s = orderSlippage(
        market({
          typeOrder: 'dealStart',
          side: 'BUY',
          origPrice: `${100 * 0.995}`,
          executedQty: '1',
          price: '100',
        }),
        regularDca,
      )
      expect(s?.source).to.equal('reconstructed')
      close(s?.refPrice, 100)
      close(s?.bps, 0, 1e-6)
    })
    it('short: origPrice = ref × (1 + 0.005)', () => {
      const s = orderSlippage(
        market({
          typeOrder: 'dealStart',
          side: 'SELL',
          origPrice: `${100 * 1.005}`,
          executedQty: '1',
          price: '99.9',
        }),
        regularDca,
      )
      close(s?.refPrice, 100)
      close(s?.bps, 10, 1e-6)
    })
    it('compound reduce flips the shift', () => {
      const ctx = { ...regularDca, compoundReduce: true }
      const long = orderSlippage(
        market({
          typeOrder: 'dealStart',
          side: 'BUY',
          origPrice: `${100 * 1.005}`,
          executedQty: '1',
          price: '100',
        }),
        ctx,
      )
      close(long?.refPrice, 100)
      const short = orderSlippage(
        market({
          typeOrder: 'dealStart',
          side: 'SELL',
          origPrice: `${100 * 0.995}`,
          executedQty: '1',
          price: '100',
        }),
        ctx,
      )
      close(short?.refPrice, 100)
    })
    it('a bot that enters by LIMIT does not reconstruct a MARKET entry', () => {
      expect(
        orderSlippage(
          market({
            typeOrder: 'dealStart',
            origPrice: '99.5',
            executedQty: '1',
            price: '100',
          }),
          { ...regularDca, startOrderLimit: true },
        ),
      ).to.equal(null)
    })
  })

  describe('reconstruction band (±25 bp)', () => {
    const start = (side: string, fill: number) =>
      market({
        typeOrder: 'dealStart',
        side,
        origPrice: `${100 * (side === 'BUY' ? 0.995 : 1.005)}`,
        executedQty: '1',
        price: `${fill}`,
      })
    it('inside the band stays reconstructed (+24 bp, −24 bp)', () => {
      const up = orderSlippage(start('BUY', 100.24), regularDca)
      expect(up?.source).to.equal('reconstructed')
      close(up?.bps, 24, 1e-6)
      const down = orderSlippage(start('BUY', 99.76), regularDca)
      expect(down?.source).to.equal('reconstructed')
      close(down?.bps, -24, 1e-6)
    })
    it('outside the band is null, not a guess (+26 bp, −26 bp, the ~50 bp shift artefact)', () => {
      expect(orderSlippage(start('BUY', 100.26), regularDca)).to.equal(null)
      expect(orderSlippage(start('BUY', 99.74), regularDca)).to.equal(null)
      // the shift was absent: origPrice was the market and it filled there
      expect(
        orderSlippage(
          market({
            typeOrder: 'dealStart',
            side: 'BUY',
            origPrice: '100',
            executedQty: '1',
            price: '100',
          }),
          regularDca,
        ),
      ).to.equal(null)
      expect(orderSlippage(start('SELL', 99.7), regularDca)).to.equal(null)
    })
    it('the band never applies to a recorded reference', () => {
      const s = orderSlippage(
        market({
          typeOrder: 'dealStart',
          refPrice: '100',
          executedQty: '1',
          price: '101',
        }),
        regularDca,
      )
      expect(s?.source).to.equal('recorded')
      close(s?.bps, 100, 1e-6)
    })
  })

  describe('cap on references not recorded at send (±100 bp)', () => {
    const tp = (side: string, fill: number) =>
      market({
        typeOrder: 'dealTP',
        side,
        origPrice: '100',
        executedQty: '1',
        price: `${fill}`,
      })
    it('inside the cap is kept (+99 bp, −99 bp)', () => {
      close(orderSlippage(tp('SELL', 99.01))?.bps, 99, 1e-6)
      close(orderSlippage(tp('SELL', 100.99))?.bps, -99, 1e-6)
    })
    it('outside the cap is null (+101 bp, −101 bp, a target 3 % past the market)', () => {
      expect(orderSlippage(tp('SELL', 98.99))).to.equal(null)
      expect(orderSlippage(tp('SELL', 101.01))).to.equal(null)
      expect(orderSlippage(tp('BUY', 103))).to.equal(null)
    })
    it('a recorded refPrice is never capped', () => {
      const s = orderSlippage(
        market({
          typeOrder: 'dealTP',
          side: 'SELL',
          refPrice: '100',
          origPrice: '100',
          executedQty: '1',
          price: '97',
        }),
      )
      close(s?.bps, 300, 1e-6)
    })
    it('the deal aggregate excludes capped orders and keeps the reconstructed flag', () => {
      const s = dealSlippage(
        [
          tp('SELL', 97), // capped → excluded
          market({
            typeOrder: 'dealStart',
            side: 'BUY',
            origPrice: '99.5',
            executedQty: '1',
            price: '100.1',
          }),
        ],
        () => regularDca,
      )
      expect(s?.orders).to.equal(1)
      expect(s?.reconstructed).to.equal(true)
      close(s?.bps, 10, 1e-6)
    })
  })

  describe('not applicable', () => {
    it('LIMIT orders are null, not 0', () => {
      expect(
        orderSlippage(
          market({
            type: 'LIMIT',
            refPrice: '100',
            executedQty: '1',
            price: '100',
          }),
        ),
      ).to.equal(null)
    })
    it('inverse / coin-margined contracts are null', () => {
      for (const exchange of [
        'binanceCoinm',
        'bybitInverse',
        'okxInverse',
        'bitgetCoinm',
        'kucoinInverse',
        'krakenCoinm',
        'paperBinanceCoinm',
      ]) {
        expect(
          orderSlippage(
            market({
              exchange,
              refPrice: '100',
              executedQty: '1',
              price: '101',
            }),
          ),
          exchange,
        ).to.equal(null)
      }
    })
    it('a virtual funding row is null', () => {
      expect(
        orderSlippage(
          market({
            fundingSource: 'virtual',
            refPrice: '100',
            executedQty: '1',
            price: '101',
          }),
        ),
      ).to.equal(null)
    })
    it('nothing executed is null', () => {
      expect(
        orderSlippage(
          market({
            status: 'NEW',
            refPrice: '100',
            executedQty: '0',
            price: '101',
          }),
        ),
      ).to.equal(null)
    })
  })

  describe('fill price', () => {
    it('cummulativeQuoteQty / executedQty when both are stated', () => {
      expect(
        fillOf(
          market({ executedQty: '2', cummulativeQuoteQty: '201', price: '1' }),
        ),
      ).to.deep.equal({ price: 100.5, qty: 2 })
    })
    it('falls back to price when the quote quantity is missing', () => {
      expect(
        fillOf(market({ executedQty: '2', price: '100.5' })),
      ).to.deep.equal({ price: 100.5, qty: 2 })
    })
    it('falls back to price and origQty when a FILLED row states no executed quantity', () => {
      expect(
        fillOf(
          market({ origQty: '3', price: '10', cummulativeQuoteQty: '31' }),
        ),
      ).to.deep.equal({ price: 10, qty: 3 })
    })
  })

  describe('dealSlippage', () => {
    it('sums executed MARKET trades, weights bps by reference notional, skips LIMIT', () => {
      const orders = [
        market({
          side: 'BUY',
          refPrice: '100',
          executedQty: '1',
          price: '101',
        }), // +1
        market({
          side: 'SELL',
          refPrice: '200',
          executedQty: '1',
          price: '199',
        }), // +1
        market({
          type: 'LIMIT',
          refPrice: '100',
          executedQty: '5',
          price: '50',
        }),
        market({
          typeOrder: 'split',
          refPrice: '100',
          executedQty: '1',
          price: '150',
        }),
        market({
          status: 'CANCELED',
          executedQty: '0',
          refPrice: '100',
          price: '150',
        }),
      ]
      const s = dealSlippage(orders, () => null)
      close(s?.quote, 2)
      expect(s?.orders).to.equal(2)
      close(s?.notional, 300)
      close(s?.bps, (2 / 300) * 10_000)
      expect(s?.reconstructed).to.equal(false)
    })
    it('flags reconstruction and reads the context by botId', () => {
      const s = dealSlippage(
        [
          market({
            typeOrder: 'dealStart',
            botId: 'b1',
            origPrice: '99.5',
            executedQty: '1',
            price: '100',
          }),
        ],
        (botId) => (botId === 'b1' ? regularDca : null),
      )
      expect(s?.reconstructed).to.equal(true)
      expect(s?.orders).to.equal(1)
    })
    it('null when no order counted', () => {
      expect(
        dealSlippage(
          [market({ type: 'LIMIT', executedQty: '1', price: '1' })],
          () => null,
        ),
      ).to.equal(null)
    })
  })

  describe('feesEstimatedOf', () => {
    it('true when an executed trade has no observed fee', () => {
      expect(
        feesEstimatedOf([market({ feePaid: '0.1' }), market({})]),
      ).to.equal(true)
    })
    it('false when every executed trade carries an observed fee', () => {
      expect(
        feesEstimatedOf([
          market({ feePaid: '0.1' }),
          market({ feeBreakdown: [{ asset: 'BNB', amount: '0.01' }] }),
          market({ status: 'CANCELED', executedQty: '0' }),
        ]),
      ).to.equal(false)
    })
  })

  describe('dealCostBreakdown', () => {
    const slip = {
      quote: 0.5,
      bps: 5,
      orders: 2,
      reconstructed: false,
      notional: 1000,
    }
    it('gross − fees − slippage = net, net is the booked profit', () => {
      const b = dealCostBreakdown(
        {
          status: 'closed',
          profit: { total: -1.2 },
          commission: 2,
          settings: { profitCurrency: 'quote' },
        },
        slip,
        true,
      )
      expect(b).to.deep.equal({
        grossQuote: -1.2 + 2 + 0.5,
        feesQuote: 2,
        feesEstimated: true,
        slippageQuote: 0.5,
        netQuote: -1.2,
      })
      close(b!.grossQuote - b!.feesQuote - (b!.slippageQuote ?? 0), b!.netQuote)
    })
    it('a base-profit deal is converted at lastPrice', () => {
      const b = dealCostBreakdown(
        {
          status: 'closed',
          profit: { total: 0.01 },
          commission: 0.001,
          lastPrice: 100,
          settings: { profitCurrency: 'base' },
        },
        null,
        false,
      )
      close(b?.netQuote, 1)
      close(b?.feesQuote, 0.1)
      expect(b?.slippageQuote).to.equal(null)
      close(b?.grossQuote, 1.1)
    })
    it('futures books in quote whatever profitCurrency says', () => {
      const b = dealCostBreakdown(
        {
          status: 'closed',
          profit: { total: 3 },
          commission: 1,
          lastPrice: 100,
          settings: { profitCurrency: 'base', futures: true },
        },
        null,
        false,
      )
      close(b?.netQuote, 3)
    })
    it('null for a running deal, an untraded cancel and inverse contracts', () => {
      expect(
        dealCostBreakdown(
          { status: 'open', profit: { total: 1 } },
          null,
          false,
        ),
      ).to.equal(null)
      expect(
        dealCostBreakdown(
          { status: 'canceled', profit: { total: 0 }, commission: 0 },
          null,
          false,
        ),
      ).to.equal(null)
      // closed only: a cancelled deal that traded is not decomposed either
      expect(
        dealCostBreakdown(
          {
            status: 'canceled',
            profit: { total: -2 },
            commission: 0.3,
            settings: { profitCurrency: 'quote' },
          },
          {
            quote: 0.1,
            bps: 1,
            orders: 1,
            reconstructed: false,
            notional: 1000,
          },
          false,
        ),
      ).to.equal(null)
      expect(
        dealCostBreakdown(
          {
            status: 'closed',
            profit: { total: 1 },
            settings: { futures: true, coinm: true },
          },
          null,
          false,
        ),
      ).to.equal(null)
    })
  })

  describe('sumTradingCosts', () => {
    it('groups by quote asset, most deals first', () => {
      const b = (net: number) => ({
        grossQuote: net + 1,
        feesQuote: 1,
        feesEstimated: false,
        slippageQuote: null,
        netQuote: net,
      })
      const rows = sumTradingCosts([
        { quoteAsset: 'USDT', breakdown: b(1) },
        {
          quoteAsset: 'USDT',
          breakdown: { ...b(2), slippageQuote: 0.5, grossQuote: 3.5 },
          reconstructed: true,
        },
        { quoteAsset: 'BTC', breakdown: b(0.1) },
        { quoteAsset: 'BTC', breakdown: null },
      ])
      expect(rows.map((r) => r.quoteAsset)).to.deep.equal(['USDT', 'BTC'])
      expect(rows[0]).to.deep.include({
        deals: 2,
        netQuote: 3,
        feesQuote: 2,
        slippageQuote: 0.5,
        grossQuote: 5.5,
        slippageReconstructed: true,
      })
      expect(rows[1].deals).to.equal(1)
    })
  })

  describe('bot context', () => {
    it('mirrors the engine’s useCompountReduce', () => {
      expect(
        compoundReduceOf({
          orderSizeType: 'quote',
          strategy: 'LONG',
          profitCurrency: 'quote',
          useRiskReduction: true,
        }),
      ).to.equal(true)
      expect(
        compoundReduceOf({
          orderSizeType: 'quote',
          strategy: 'LONG',
          profitCurrency: 'base',
          useReinvest: true,
        }),
      ).to.equal(false)
      expect(
        compoundReduceOf({
          orderSizeType: 'usd',
          strategy: 'LONG',
          profitCurrency: 'quote',
          useReinvest: true,
        }),
      ).to.equal(false)
      expect(
        compoundReduceOf({
          orderSizeType: 'base',
          strategy: 'SHORT',
          futures: true,
          useReinvest: true,
        }),
      ).to.equal(true)
    })
    it('reads terminal and limit entry from settings', () => {
      expect(
        slippageContextFromBot('dca', {
          type: 'terminal',
          startOrderType: 'LIMIT',
        }),
      ).to.deep.equal({
        kind: 'dca',
        terminal: true,
        compoundReduce: false,
        startOrderLimit: true,
      })
    })
  })

  describe('placement stamps', () => {
    it('marketReference uses the price’s own observation time', () => {
      expect(
        marketReference({ price: 101.5, time: 1_000 }, 2_000, 60_000),
      ).to.deep.equal({ refPrice: '101.5', refPriceAt: 1_000 })
    })
    it('absent when the held price is too old or missing', () => {
      expect(
        marketReference({ price: 101.5, time: 1_000 }, 100_000, 60_000),
      ).to.equal(null)
      expect(
        marketReference({ price: 0, time: 1_000 }, 2_000, 60_000),
      ).to.equal(null)
      expect(marketReference(undefined, 2_000, 60_000)).to.equal(null)
    })
    it('placementStampsOf carries only present keys', () => {
      expect(placementStampsOf({})).to.deep.equal({})
      expect(
        Object.keys(placementStampsOf({ refPrice: '1', sentAt: 5, ackAt: 6 })),
      ).to.deep.equal(['refPrice', 'sentAt', 'ackAt'])
    })
  })

  describe('orderFeeQuote (§4.4)', () => {
    const filled = (over: Record<string, unknown>) =>
      market({
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        executedQty: '0.5',
        cummulativeQuoteQty: '50',
        ...over,
      })
    const rate = { maker: 0.001, taker: 0.002 }
    it('venue fee in quote is taken as is', () => {
      expect(
        orderFeeQuote(filled({ feePaid: '0.05', feeSide: 'quote' }), rate),
      ).to.deep.equal({ feeQuote: 0.05, feeEstimated: false })
    })
    it('venue fee in base is converted at the fill price', () => {
      const f = orderFeeQuote(
        filled({ feePaid: '0.0005', feeAsset: 'BTC' }),
        rate,
      )
      expect(f.feeEstimated).to.equal(false)
      close(f.feeQuote, 0.05)
    })
    it('a third-asset fee (BNB) is null and not an estimate', () => {
      const o = filled({ feePaid: '0.0001', feeAsset: 'BNB' })
      expect(needsStoredFeeRate(o)).to.equal(false)
      expect(orderFeeQuote(o, rate)).to.deep.equal({
        feeQuote: null,
        feeEstimated: false,
      })
    })
    it('no venue fee: stored-rate estimate, taker for MARKET, maker for LIMIT', () => {
      const m = filled({})
      expect(needsStoredFeeRate(m)).to.equal(true)
      const fm = orderFeeQuote(m, rate)
      expect(fm.feeEstimated).to.equal(true)
      close(fm.feeQuote, 0.1)
      close(orderFeeQuote(filled({ type: 'LIMIT' }), rate).feeQuote, 0.05)
      expect(orderFeeQuote(m, { maker: 0, taker: 0 })).to.deep.equal({
        feeQuote: 0,
        feeEstimated: true,
      })
    })
    it('no venue fee and no stored rate, not executed, or inverse: unknown', () => {
      expect(orderFeeQuote(filled({}), null)).to.deep.equal({
        feeQuote: null,
        feeEstimated: null,
      })
      expect(
        orderFeeQuote(filled({ status: 'NEW', executedQty: '0' }), rate),
      ).to.deep.equal({ feeQuote: null, feeEstimated: null })
      expect(
        orderFeeQuote(
          filled({
            exchange: 'binanceCoinm',
            feePaid: '0.1',
            feeSide: 'quote',
          }),
          rate,
        ),
      ).to.deep.equal({ feeQuote: null, feeEstimated: null })
    })
  })
  describe('fees charged off-pair (unbooked)', () => {
    const bnb = (over: Record<string, unknown>) =>
      market({
        typeOrder: 'dealTP',
        baseAsset: 'HYPE',
        quoteAsset: 'USDT',
        executedQty: '1',
        cummulativeQuoteQty: '100',
        feePaid: '0.00001',
        feeAsset: 'BNB',
        ...over,
      })
    it('a FILLED deal trade charged in a third asset is unbooked', () => {
      expect(isUnbookedFeeOrder(bnb({}))).to.equal(true)
      expect(
        isUnbookedFeeOrder(
          bnb({
            feeBreakdown: [
              { asset: 'BGB', amount: '1' },
              { asset: 'USDT', amount: '1' },
            ],
          }),
        ),
      ).to.equal(true)
    })
    it('not: on-pair fee, combo grid leg, split / funding rows, cancelled, inverse', () => {
      expect(isUnbookedFeeOrder(bnb({ feeAsset: 'USDT' }))).to.equal(false)
      expect(isUnbookedFeeOrder(bnb({ typeOrder: 'dealGrid' }))).to.equal(false)
      expect(isUnbookedFeeOrder(bnb({ typeOrder: 'split' }))).to.equal(false)
      expect(isUnbookedFeeOrder(bnb({ typeOrder: 'funding' }))).to.equal(false)
      expect(isUnbookedFeeOrder(bnb({ status: 'CANCELED' }))).to.equal(false)
      expect(isUnbookedFeeOrder(bnb({ exchange: 'binanceCoinm' }))).to.equal(
        false,
      )
    })
    it('sums the valued ones, marks the rest partial, null with none', () => {
      expect(sumUnbookedFees([])).to.equal(null)
      expect(
        sumUnbookedFees([
          { assets: ['BNB'], feeQuote: 0.01 },
          { assets: ['BNB'], feeQuote: null },
          { assets: ['BGB', 'BNB'], feeQuote: 0.02 },
        ]),
      ).to.deep.equal({ quote: 0.03, partial: true, assets: ['BGB', 'BNB'] })
      expect(
        sumUnbookedFees([{ assets: ['BNB'], feeQuote: null }]),
      ).to.deep.equal({ quote: null, partial: true, assets: ['BNB'] })
    })
    it('rides beside the breakdown and never moves gross / fees / net', () => {
      const b = dealCostBreakdown(
        {
          status: 'closed',
          profit: { total: 3 },
          commission: 0.2,
          settings: { profitCurrency: 'quote' },
        },
        { quote: 1, bps: 1, orders: 1, reconstructed: false, notional: 1 },
        false,
      )
      const w = withUnbookedFees(b, {
        quote: 0.5,
        partial: false,
        assets: ['BNB'],
      })
      expect(w).to.deep.equal({
        ...b,
        unbookedFeesQuote: 0.5,
        unbookedFeesPartial: false,
        unbookedFeeAssets: ['BNB'],
        unbookedFeesInUsdProfit: false,
        unbookedFeesUsd: null,
      })
      expect(withUnbookedFees(b, null)).to.equal(b)
      const [row] = sumTradingCosts([
        { quoteAsset: 'USDT', breakdown: w },
        { quoteAsset: 'USDT', breakdown: b },
        {
          quoteAsset: 'USDT',
          breakdown: withUnbookedFees(b, {
            quote: null,
            partial: true,
            assets: ['BNB'],
          }),
        },
      ])
      expect(row.unbookedFeesQuote).to.equal(0.5)
      expect(row.unbookedFeesPartial).to.equal(true)
      expect(row.unbookedFeesInUsdProfitQuote).to.equal(null)
      expect(row.netQuote).to.equal(9)
      expect(row.feesQuote).to.be.closeTo(0.6, 1e-12)
    })
  })
  describe('fee-ledger deals: off-pair fees already inside profit.totalUsd', () => {
    const ledgerDeal = (over: Record<string, unknown> = {}) => ({
      flags: ['newMultiTp', 'feeByAsset'],
      symbol: { baseAsset: 'HYPE', quoteAsset: 'USDT' },
      feeByAsset: [
        { asset: 'BNB', total: 0.00002, totalUsd: 0.0146 },
        { asset: 'USDT', total: 0.1, totalUsd: 0.1 },
        { asset: 'HYPE', total: 0.001, totalUsd: 0.08 },
      ],
      ...over,
    })
    it('reads the USD subtracted from the ledger’s off-pair entries only', () => {
      expect(usdProfitFeeDeduction(ledgerDeal())).to.deep.equal({
        usd: 0.0146,
        assets: ['BNB'],
      })
    })
    it('none without the flag, or with only on-pair entries', () => {
      expect(
        usdProfitFeeDeduction(ledgerDeal({ flags: ['newMultiTp'] })),
      ).to.equal(null)
      expect(
        usdProfitFeeDeduction(
          ledgerDeal({
            feeByAsset: [{ asset: 'USDT', total: 1, totalUsd: 1 }],
          }),
        ),
      ).to.equal(null)
      expect(usdProfitFeeDeduction(null)).to.equal(null)
    })
    it('a ledger deal says so beside an unchanged breakdown; aggregates keep the split', () => {
      const deal = {
        status: 'closed',
        profit: { total: 2 },
        commission: 0.1,
        settings: { profitCurrency: 'quote' },
      }
      const b = dealCostBreakdown(deal, null, false)
      const ledger = withUnbookedFees(
        b,
        { quote: 0.015, partial: false, assets: ['BNB'] },
        usdProfitFeeDeduction(ledgerDeal()),
      )
      expect(ledger).to.deep.include({
        netQuote: 2,
        feesQuote: 0.1,
        grossQuote: 2.1,
        unbookedFeesQuote: 0.015,
        unbookedFeesInUsdProfit: true,
        unbookedFeesUsd: 0.0146,
      })
      // grid-leg-only fees: no unbooked order, the deduction still shows
      expect(
        withUnbookedFees(b, null, usdProfitFeeDeduction(ledgerDeal())),
      ).to.deep.include({
        unbookedFeesQuote: null,
        unbookedFeesInUsdProfit: true,
      })
      const plain = withUnbookedFees(b, {
        quote: 0.02,
        partial: false,
        assets: ['BNB'],
      })
      const [row] = sumTradingCosts([
        { quoteAsset: 'USDT', breakdown: ledger },
        { quoteAsset: 'USDT', breakdown: plain },
      ])
      expect(row.netQuote).to.equal(4)
      expect(row.grossQuote).to.be.closeTo(4.2, 1e-12)
      expect(row.unbookedFeesQuote).to.be.closeTo(0.035, 1e-12)
      expect(row.unbookedFeesInUsdProfitQuote).to.be.closeTo(0.015, 1e-12)
    })
  })
})
