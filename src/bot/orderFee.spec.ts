process.env.NODE_ENV = 'testing'

/**
 * Checks for the observed-fee resolution that `deal.feePaid` and
 * `deal.commission` are now built from.
 *
 * Run: `npm test` (mocha).
 *
 * Two properties matter more than the rest, and both are about NOT booking a
 * number we do not have:
 *
 *   1. An order the venue did not price, or priced in an asset that is neither
 *      side of the pair, resolves to `null` — "fall back to the estimate" —
 *      and never to `{base: 0, quote: 0}`. A zeroed split books a real cost as
 *      free, which is strictly worse than the estimate it replaced.
 *   2. The stream accrual is idempotent. It sums per-trade commissions, so a
 *      replayed report must not inflate the fee.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  accrueStreamFee,
  hasObservedFee,
  observedFeeOnSide,
  observedFeeSplit,
} from './orderFee'

const order = (over: Record<string, unknown>) =>
  ({ baseAsset: 'BTC', quoteAsset: 'USDT', ...over }) as any

describe('orderFee', () => {
  describe('observedFeeSplit — a venue that names a SIDE (Kraken, Coinbase, Bybit)', () => {
    it('feeSide quote books against quote', () => {
      expect(
        observedFeeSplit(order({ feePaid: '0.6', feeSide: 'quote' })),
      ).to.deep.equal({ base: 0, quote: 0.6 })
    })
    it('feeSide base books against base', () => {
      expect(
        observedFeeSplit(order({ feePaid: '0.001', feeSide: 'base' })),
      ).to.deep.equal({ base: 0.001, quote: 0 })
    })
  })

  describe('observedFeeSplit — a venue that names a TICKER (OKX, KuCoin, Bitget, Binance)', () => {
    it('feeAsset matching quote books against quote', () => {
      expect(
        observedFeeSplit(order({ feePaid: '0.08', feeAsset: 'USDT' })),
      ).to.deep.equal({ base: 0, quote: 0.08 })
    })
    it('feeAsset matching base books against base', () => {
      expect(
        observedFeeSplit(order({ feePaid: '0.00002', feeAsset: 'BTC' })),
      ).to.deep.equal({ base: 0.00002, quote: 0 })
    })
    it('ticker comparison is case-insensitive', () => {
      expect(
        observedFeeSplit(order({ feePaid: '1', feeAsset: 'usdt' })),
      ).to.deep.equal({ base: 0, quote: 1 })
    })
    it('a side named by the venue wins over the ticker', () => {
      expect(
        observedFeeSplit(
          order({ feePaid: '2', feeSide: 'base', feeAsset: 'USDT' }),
        ),
      ).to.deep.equal({ base: 2, quote: 0 })
    })
  })

  describe('observedFeeSplit — a THIRD asset: real, unbookable here, must not become zero', () => {
    it('a BNB fee falls back rather than booking as free', () => {
      expect(
        observedFeeSplit(order({ feePaid: '0.0007', feeAsset: 'BNB' })),
      ).to.equal(null)
    })
    it('a KCS fee falls back rather than booking as free', () => {
      expect(
        observedFeeSplit(order({ feePaid: '0.004', feeAsset: 'KCS' })),
      ).to.equal(null)
    })
  })

  describe('observedFeeSplit — nothing observed at all → fall back', () => {
    const cases: [string, any][] = [
      ['no fee fields', {}],
      ['zero fee', { feePaid: '0', feeAsset: 'USDT' }],
      ['empty fee', { feePaid: '', feeAsset: 'USDT' }],
      ['fee with no currency', { feePaid: '1' }],
    ]
    for (const [label, over] of cases) {
      it(`${label} falls back`, () => {
        expect(observedFeeSplit(order(over))).to.equal(null)
      })
    }
    it('a null order falls back', () => {
      expect(observedFeeSplit(null as any)).to.equal(null)
    })
  })

  describe('observedFeeSplit — feeBreakdown: both legs on the pair is bookable; a third asset is not', () => {
    it('a breakdown wholly on the pair is booked', () => {
      expect(
        observedFeeSplit(
          order({
            feeBreakdown: [
              { asset: 'USDT', amount: '0.05' },
              { asset: 'BTC', amount: '0.0001' },
            ],
          }),
        ),
      ).to.deep.equal({ base: 0.0001, quote: 0.05 })
    })
    it('a breakdown with one off-pair leg falls back whole', () => {
      expect(
        observedFeeSplit(
          order({
            feeBreakdown: [
              { asset: 'BNB', amount: '0.0003' },
              { asset: 'USDT', amount: '0.05' },
            ],
          }),
        ),
      ).to.equal(null)
    })
  })

  describe('hasObservedFee', () => {
    it('hasObservedFee on a priced order', () => {
      expect(hasObservedFee(order({ feePaid: '1' }))).to.equal(true)
    })
    it('hasObservedFee on a zero fee', () => {
      expect(hasObservedFee(order({ feePaid: '0' }))).to.equal(false)
    })
    it('hasObservedFee on nothing', () => {
      expect(hasObservedFee(order({}))).to.equal(false)
    })
    it('hasObservedFee on a breakdown', () => {
      expect(
        hasObservedFee(order({ feeBreakdown: [{ asset: 'BNB', amount: '1' }] })),
      ).to.equal(true)
    })
  })

  describe('observedFeeOnSide — the grid/combo one-side shape', () => {
    // The combo transaction path assumes exactly one of comBase/comQuote is
    // populated, keyed to the TRADE side, and converts between them afterwards.
    // A venue that charges on the other side (Kraken bills base on a sell) must
    // therefore be converted here, or the next conversion overwrites the real
    // fee with zero.
    it('a quote fee on a buy is converted into base', () => {
      expect(
        observedFeeOnSide({ base: 0, quote: 50 }, 'base', 100),
      ).to.equal(0.5)
    })
    it('a base fee on a sell is converted into quote', () => {
      expect(
        observedFeeOnSide({ base: 0.5, quote: 0 }, 'quote', 100),
      ).to.equal(50)
    })
    it('a fee already on the requested side passes through', () => {
      expect(
        observedFeeOnSide({ base: 0, quote: 50 }, 'quote', 100),
      ).to.equal(50)
    })
    it('a split fee is combined onto one side', () => {
      expect(
        observedFeeOnSide({ base: 0.1, quote: 5 }, 'quote', 100),
      ).to.equal(15)
    })

    const fallbackCases: [string, any, number][] = [
      ['nothing observed', null, 100],
      ['a zero price', { base: 1, quote: 0 }, 0],
      ['an empty split', { base: 0, quote: 0 }, 100],
    ]
    for (const [label, split, price] of fallbackCases) {
      it(`observedFeeOnSide falls back on ${label}`, () => {
        expect(observedFeeOnSide(split, 'quote', price)).to.equal(null)
      })
    }
  })

  describe('accrueStreamFee — per-trade slices, summed, idempotently', () => {
    it('first trade starts the total, a later trade adds to it, a replayed/older/currency-mismatched/id-less report adds nothing', () => {
      const t1 = accrueStreamFee(
        {},
        { commission: '0.05', commissionAsset: 'USDT', tradeId: 100 },
      )
      expect(t1).to.deep.equal({
        feePaid: '0.05',
        feeAsset: 'USDT',
        feeTradeId: 100,
      })

      const t2 = accrueStreamFee(t1 as any, {
        commission: '0.03',
        commissionAsset: 'USDT',
        tradeId: 101,
      })
      expect(t2).to.deep.equal({
        feePaid: '0.08',
        feeAsset: 'USDT',
        feeTradeId: 101,
      })

      expect(
        accrueStreamFee(t2 as any, {
          commission: '0.03',
          commissionAsset: 'USDT',
          tradeId: 101,
        }),
      ).to.deep.equal({})

      expect(
        accrueStreamFee(t2 as any, {
          commission: '0.05',
          commissionAsset: 'USDT',
          tradeId: 100,
        }),
      ).to.deep.equal({})

      expect(
        accrueStreamFee(t2 as any, {
          commission: '0.03',
          commissionAsset: 'USDT',
        }),
      ).to.deep.equal({})

      expect(
        accrueStreamFee(t2 as any, {
          commission: '0.0002',
          commissionAsset: 'BNB',
          tradeId: 102,
        }),
      ).to.deep.equal({})
    })

    const ignoredCases: [string, any][] = [
      ['zero commission', { commission: '0', commissionAsset: 'USDT', tradeId: 1 }],
      ['no commission', { commissionAsset: 'USDT', tradeId: 1 }],
      ['null asset', { commission: '1', commissionAsset: null, tradeId: 1 }],
    ]
    for (const [label, msg] of ignoredCases) {
      it(`stream accrual ignores ${label}`, () => {
        expect(accrueStreamFee({}, msg)).to.deep.equal({})
      })
    }
  })
})
