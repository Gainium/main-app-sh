process.env.NODE_ENV = 'testing'

/**
 * A requested LIMIT order the venue reports unfilled at price 0 is a LIMIT
 * order, not a market fill.
 *
 * Spec: `specs/181.an-unfilled-limit-order-at-price-zero-is-stored-as-market.md`.
 * Connector half: `exchange-connector core/specs/038.bitget-spot-unfilled-limit-reported-at-price-zero.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB needed — the classifier is pure.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  estimatedFeeRate,
  placedOrderRecord,
  placedOrderType,
  tradedAsTaker,
} from './placedOrderType'
import { feeTimeOf } from './feeAssetPrice'
import { isFullyExecutedMarketPartial } from './marketEntryFill'
import { OrderTypeEnum } from '../../types'

const round = (v: number) => Math.round(v * 100) / 100
const limit = { type: 'LIMIT', origPrice: '197.54' }
const market = { type: 'MARKET', origPrice: '197.54' }
const resting = {
  type: 'LIMIT',
  price: '0',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  fills: [],
}

describe('placedOrderType (spec 181)', () => {
  it('§1.1 a requested LIMIT order resting at price 0 is LIMIT', () => {
    expect(placedOrderType(resting, limit, round)).to.equal(OrderTypeEnum.limit)
  })

  it('§1.1 also with no executedQty field at all', () => {
    expect(
      placedOrderType({ type: 'LIMIT', price: '0' }, limit, round),
    ).to.equal(OrderTypeEnum.limit)
  })

  it('§1.2 a LIMIT reply at the requested price is LIMIT', () => {
    expect(
      placedOrderType({ ...resting, price: '197.54' }, limit, round),
    ).to.equal(OrderTypeEnum.limit)
  })

  it('§1.2 a LIMIT reply at a different non-zero price is MARKET', () => {
    expect(
      placedOrderType({ ...resting, price: '197.9' }, limit, round),
    ).to.equal(OrderTypeEnum.market)
  })

  it('§1.2 price 0 with something executed still flips to MARKET', () => {
    expect(
      placedOrderType({ ...resting, executedQty: '0.5' }, limit, round),
    ).to.equal(OrderTypeEnum.market)
  })

  it('§1.2 price 0 on a requested MARKET order is unchanged (MARKET)', () => {
    expect(placedOrderType(resting, market, round)).to.equal(
      OrderTypeEnum.market,
    )
  })

  it('§1.2 a MARKET type, or any fills, is MARKET', () => {
    expect(
      placedOrderType({ ...resting, type: 'MARKET' }, limit, round),
    ).to.equal(OrderTypeEnum.market)
    expect(placedOrderType({ ...resting, fills: [{}] }, limit, round)).to.equal(
      OrderTypeEnum.market,
    )
  })

  it('§1.2 an average fill price off the requested one is MARKET', () => {
    expect(
      placedOrderType(
        {
          type: 'LIMIT',
          price: '197.54',
          executedQty: '0.5',
          cummulativeQuoteQty: '98.95',
        },
        limit,
        round,
      ),
    ).to.equal(OrderTypeEnum.market)
    expect(
      placedOrderType(
        {
          type: 'LIMIT',
          price: '197.54',
          executedQty: '0.5',
          cummulativeQuoteQty: '98.77',
        },
        limit,
        round,
      ),
    ).to.equal(OrderTypeEnum.limit)
  })
})

/**
 * Spec 243: an order sent as LIMIT is stored as LIMIT. Trading on arrival
 * still prices it from its fills and marks it `filledOnArrival`.
 *
 * Shape from a split take profit on Binance spot: a slice sent as
 * LIMIT SELL 0.0049 @ 1829.65 that traded at once at 1830.38.
 */
describe('placedOrderRecord (spec 243)', () => {
  const sent = { type: 'LIMIT', origPrice: '1829.65' }
  const crossed = {
    type: 'LIMIT',
    price: '1829.65',
    executedQty: '0.00490000',
    cummulativeQuoteQty: '8.96886200',
    fills: [{ price: '1830.38000000', qty: '0.00490000' }],
  }

  it('§1.1 a LIMIT that filled on arrival is stored LIMIT, priced from fills', () => {
    expect(placedOrderRecord(crossed, sent, round)).to.deep.equal({
      type: OrderTypeEnum.limit,
      pricedFromFills: true,
      filledOnArrival: true,
    })
  })

  it('§1.1 also when the answer carries only an average fill price', () => {
    const { fills: _fills, ...noFills } = crossed
    expect(placedOrderRecord(noFills, sent, round)).to.deep.equal({
      type: OrderTypeEnum.limit,
      pricedFromFills: true,
      filledOnArrival: true,
    })
  })

  it('§1.3 a LIMIT that rests is LIMIT, at its requested price, not flagged', () => {
    expect(
      placedOrderRecord(
        { type: 'LIMIT', price: '1829.65', executedQty: '0', fills: [] },
        sent,
        round,
      ),
    ).to.deep.equal({
      type: OrderTypeEnum.limit,
      pricedFromFills: false,
      filledOnArrival: false,
    })
  })

  it('§1.3 a MARKET order is classified exactly as before', () => {
    const m = { type: 'MARKET', origPrice: '1829.65' }
    expect(placedOrderRecord(crossed, m, round)).to.deep.equal({
      type: OrderTypeEnum.market,
      pricedFromFills: true,
      filledOnArrival: false,
    })
    const quiet = { type: 'LIMIT', price: '1829.65', executedQty: '0' }
    expect(placedOrderRecord(quiet, m, round).type).to.equal(
      placedOrderType(quiet, m, round),
    )
  })
})

describe('tradedAsTaker (spec 243 §1.3)', () => {
  it('a MARKET order, or a LIMIT that filled on arrival, took liquidity', () => {
    expect(tradedAsTaker({ type: 'MARKET' })).to.equal(true)
    expect(tradedAsTaker({ type: 'LIMIT', filledOnArrival: true })).to.equal(
      true,
    )
    expect(tradedAsTaker({ type: 'LIMIT' })).to.equal(false)
    expect(tradedAsTaker({ type: 'LIMIT', filledOnArrival: false })).to.equal(
      false,
    )
  })

  it('the estimated fee rate is taker for a LIMIT that filled on arrival', () => {
    const fee = { maker: 0.0002, taker: 0.0005 }
    expect(
      estimatedFeeRate({ type: 'LIMIT', filledOnArrival: true }, fee),
    ).to.equal(0.0005)
    expect(estimatedFeeRate({ type: 'MARKET' }, fee)).to.equal(0.0005)
    expect(estimatedFeeRate({ type: 'LIMIT' }, fee)).to.equal(0.0002)
    expect(estimatedFeeRate({ type: 'LIMIT' }, undefined)).to.equal(0)
  })

  it('feeTimeOf values a LIMIT that filled on arrival at its transact time', () => {
    const o = {
      type: 'LIMIT' as const,
      filledOnArrival: true,
      transactTime: 1000,
      updateTime: 2000,
    }
    expect(feeTimeOf(o)).to.equal(1000)
    expect(feeTimeOf({ ...o, filledOnArrival: false })).to.equal(2000)
  })

  it('a full-size PARTIALLY_FILLED answer for a LIMIT that filled on arrival is filled', () => {
    expect(
      isFullyExecutedMarketPartial({
        type: 'LIMIT',
        filledOnArrival: true,
        status: 'PARTIALLY_FILLED',
        executedQty: '0.0049',
        origQty: '0.0049',
      }),
    ).to.equal(true)
  })
})
