process.env.NODE_ENV = 'testing'

/**
 * Valuing a fee charged in an asset that is neither side of the pair
 * (`feeAssetPrice.ts`).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  candleMid,
  convertedFeeQuote,
  feeLegsByPair,
  feePriceVenueOf,
  feeRoute,
  feeTimeOf,
  minuteOf,
  routePrice,
} from './feeAssetPrice'

const PAIRS = [
  { pair: 'BNBUSDT', base: 'BNB', quote: 'USDT' },
  { pair: 'BNBBTC', base: 'BNB', quote: 'BTC' },
  { pair: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
  { pair: 'ETHUSDT', base: 'ETH', quote: 'USDT' },
]

describe('feeAssetPrice', () => {
  describe('candleMid', () => {
    it('is the four-point average of the minute', () => {
      expect(candleMid({ t: 0, o: 600, h: 604, l: 598, c: 602 })).to.equal(601)
    })
    it('is null for a candle that is not a price', () => {
      expect(candleMid(null)).to.equal(null)
      expect(candleMid({ t: 0, o: 0, h: 1, l: 1, c: 1 })).to.equal(null)
      expect(candleMid({ t: 0, o: NaN, h: 1, l: 1, c: 1 })).to.equal(null)
    })
  })

  describe('feeRoute', () => {
    it('prefers the direct pair', () => {
      expect(feeRoute('BNB', 'BTC', PAIRS)).to.deep.equal({ num: 'BNBBTC' })
      expect(feeRoute('bnb', 'usdt', PAIRS)).to.deep.equal({ num: 'BNBUSDT' })
    })
    it('takes a USD stablecoin at 1 USDT only when no direct pair exists', () => {
      expect(feeRoute('BNB', 'USDC', PAIRS)).to.deep.equal({
        num: 'BNBUSDT',
        pegged: true,
      })
      expect(
        feeRoute('BNB', 'USDC', [
          ...PAIRS,
          { pair: 'BNBUSDC', base: 'BNB', quote: 'USDC' },
        ]),
      ).to.deep.equal({ num: 'BNBUSDC' })
    })
    it('crosses through USDT for any other quote with a USDT pair', () => {
      expect(feeRoute('BNB', 'ETH', PAIRS)).to.deep.equal({
        num: 'BNBUSDT',
        den: 'ETHUSDT',
      })
    })
    it('has no route without a fee-asset pair, or for an on-pair asset', () => {
      expect(feeRoute('KCS', 'USDT', PAIRS)).to.equal(null)
      expect(feeRoute('BNB', 'TRY', PAIRS)).to.equal(null)
      expect(feeRoute('USDT', 'USDT', PAIRS)).to.equal(null)
    })
  })

  describe('routePrice', () => {
    const mids: Record<string, number | null> = {
      BNBUSDT: 600,
      ETHUSDT: 3000,
      BTCUSDT: null,
    }
    it('divides a crossed route', () => {
      expect(
        routePrice({ num: 'BNBUSDT', den: 'ETHUSDT' }, (p) => mids[p]),
      ).to.equal(0.2)
    })
    it('is null when any needed mid is missing', () => {
      expect(
        routePrice({ num: 'BNBUSDT', den: 'BTCUSDT' }, (p) => mids[p]),
      ).to.equal(null)
      expect(routePrice({ num: 'X' }, () => undefined)).to.equal(null)
    })
  })

  describe('feeTimeOf', () => {
    it('MARKET: transactTime; LIMIT: the last update (the fill)', () => {
      expect(
        feeTimeOf({ type: 'MARKET', transactTime: 10, updateTime: 20 }),
      ).to.equal(10)
      expect(
        feeTimeOf({ type: 'LIMIT', transactTime: 10, updateTime: 20 }),
      ).to.equal(20)
    })
    it('falls back to the other time, null with neither', () => {
      expect(feeTimeOf({ type: 'MARKET', updateTime: 20 })).to.equal(20)
      expect(feeTimeOf({ type: 'LIMIT', transactTime: 10 })).to.equal(10)
      expect(feeTimeOf({ type: 'LIMIT' })).to.equal(null)
    })
    it('minuteOf floors to the minute', () => {
      expect(minuteOf(1_792_674_087_768)).to.equal(1_792_674_060_000)
    })
  })

  describe('feeLegsByPair', () => {
    it('separates pair legs from off-pair legs', () => {
      expect(
        feeLegsByPair({
          baseAsset: 'MUBARAK',
          quoteAsset: 'USDT',
          feeBreakdown: [
            { asset: 'BGB', amount: '0.005' },
            { asset: 'USDT', amount: '0.01' },
          ],
        }),
      ).to.deep.equal({
        base: 0,
        quote: 0.01,
        offPair: [{ asset: 'BGB', amount: 0.005 }],
      })
    })
    it('a feeSide leg is on-pair whatever its asset spelling', () => {
      expect(
        feeLegsByPair({
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          feePaid: '0.1',
          feeSide: 'quote',
        }).offPair,
      ).to.deep.equal([])
    })
  })

  describe('convertedFeeQuote', () => {
    const bnbFee = {
      baseAsset: 'HYPE',
      quoteAsset: 'USDT',
      feePaid: '0.00000965',
      feeAsset: 'BNB',
    }
    it('values the off-pair leg at its price', () => {
      const v = convertedFeeQuote(bnbFee, 77.98, () => 1000)
      expect(v).to.be.closeTo(0.00965, 1e-12)
    })
    it('adds the on-pair legs (base at the fill price)', () => {
      const v = convertedFeeQuote(
        {
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          feeBreakdown: [
            { asset: 'BNB', amount: '0.001' },
            { asset: 'BTC', amount: '0.00001' },
          ],
        },
        50_000,
        () => 600,
      )
      expect(v).to.be.closeTo(0.6 + 0.5, 1e-12)
    })
    it('is null when a leg has no price — never 0', () => {
      expect(convertedFeeQuote(bnbFee, 77.98, () => null)).to.equal(null)
      expect(convertedFeeQuote(bnbFee, 77.98, () => 0)).to.equal(null)
    })
    it('is null for an order with no off-pair leg', () => {
      expect(
        convertedFeeQuote(
          {
            baseAsset: 'BTC',
            quoteAsset: 'USDT',
            feePaid: '1',
            feeAsset: 'USDT',
          },
          50_000,
          () => 1,
        ),
      ).to.equal(null)
    })
  })

  it('fee-token venues price on their own spot market', () => {
    expect(feePriceVenueOf('binanceUsdm')).to.equal('binance')
    expect(feePriceVenueOf('bitgetUsdm')).to.equal('bitget')
    expect(feePriceVenueOf('kucoin')).to.equal('kucoin')
    expect(feePriceVenueOf('bybit')).to.equal(null)
    expect(feePriceVenueOf('binanceCoinm')).to.equal(null)
    expect(feePriceVenueOf(undefined)).to.equal(null)
  })
})
