import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  priceBandEdgeFromReason,
  priceBandRepriceTarget,
} from './priceBandReprice'

/**
 * Numbers recorded from a short spot combo deal on Bybit BTCUSDT: its
 * minigrid buy-backs at 71.5k-74.8k were refused for balance, then the market
 * fell to ~64.4k and every re-send at the grid level was refused by the venue
 * limit-price band, on each restart, for ten days.
 */
const BYBIT_BUY_BAND = 'Buy order price cannot be higher than 64651.1USDT.'
const MARKET = 64380

describe('priceBandEdgeFromReason', () => {
  it('reads the cap Bybit names for a buy', () => {
    expect(priceBandEdgeFromReason(BYBIT_BUY_BAND, 'BUY')).to.equal(64651.1)
  })

  it('reads the floor Bybit names for a sell', () => {
    expect(
      priceBandEdgeFromReason(
        'Sell order price cannot be lower than 1.2345USDT.',
        'SELL',
      ),
    ).to.equal(1.2345)
  })

  it('reads the edge OKX names, with thousands separators', () => {
    expect(
      priceBandEdgeFromReason(
        'The highest price limit for the buy leg is 65,241.7. ',
        'BUY',
      ),
    ).to.equal(65241.7)
    expect(
      priceBandEdgeFromReason(
        'The lowest price limit for the sell leg is 0.05856.',
        'SELL',
      ),
    ).to.equal(0.05856)
  })

  it('ignores an edge named for the other side', () => {
    expect(priceBandEdgeFromReason(BYBIT_BUY_BAND, 'SELL')).to.equal(null)
  })

  it('returns null when the venue names no edge', () => {
    expect(
      priceBandEdgeFromReason(
        'the trade price of rmrna/usdt cannot exceed the current price, 20%.',
        'BUY',
      ),
    ).to.equal(null)
  })
})

describe('priceBandRepriceTarget', () => {
  it('re-prices a stale buy-back to the market, inside the band the venue names', () => {
    expect(
      priceBandRepriceTarget({
        side: 'BUY',
        price: 74834.7,
        market: MARKET,
        reason: BYBIT_BUY_BAND,
      }),
    ).to.equal(MARKET)
  })

  it('never re-prices past a band edge tighter than the market', () => {
    expect(
      priceBandRepriceTarget({
        side: 'BUY',
        price: 74834.7,
        market: MARKET,
        reason: 'Buy order price cannot be higher than 64300USDT.',
      }),
    ).to.equal(64300)
  })

  it('falls back to the market when no edge is named', () => {
    expect(
      priceBandRepriceTarget({
        side: 'BUY',
        price: 74834.7,
        market: MARKET,
        reason: 'order price exceeds the maximum price limit',
      }),
    ).to.equal(MARKET)
  })

  it('re-prices a stale sell up to the market', () => {
    expect(
      priceBandRepriceTarget({
        side: 'SELL',
        price: 60000,
        market: MARKET,
        reason: 'order price exceeds the minimum price',
      }),
    ).to.equal(MARKET)
  })

  it('leaves an order the market has not passed alone', () => {
    expect(
      priceBandRepriceTarget({
        side: 'BUY',
        price: 63000,
        market: MARKET,
        reason: BYBIT_BUY_BAND,
      }),
    ).to.equal(null)
    expect(
      priceBandRepriceTarget({
        side: 'SELL',
        price: 76655.4,
        market: MARKET,
        reason: BYBIT_BUY_BAND,
      }),
    ).to.equal(null)
  })

  it('never moves a buy up or a sell down', () => {
    // A cap above the order price is never used to move the buy up: it goes
    // down to the market.
    expect(
      priceBandRepriceTarget({
        side: 'BUY',
        price: 64500,
        market: MARKET,
        reason: 'Buy order price cannot be higher than 70000USDT.',
      }),
    ).to.equal(MARKET)
    // ...and a sell is never moved down.
    expect(
      priceBandRepriceTarget({
        side: 'SELL',
        price: 64000,
        market: MARKET,
        reason: 'Sell order price cannot be lower than 60000USDT.',
      }),
    ).to.equal(MARKET)
  })

  it('refuses without a usable market price', () => {
    for (const market of [0, NaN, -1]) {
      expect(
        priceBandRepriceTarget({
          side: 'BUY',
          price: 74834.7,
          market,
          reason: BYBIT_BUY_BAND,
        }),
      ).to.equal(null)
    }
  })
})
