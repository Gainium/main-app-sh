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
import { placedOrderType } from './placedOrderType'
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
