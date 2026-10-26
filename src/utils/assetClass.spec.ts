import { describe, it } from 'mocha'
import { expect } from 'chai'
import { classifyAssetClass } from './assetClass'

/**
 * Exchanges tag tokenized ETFs as stocks; a stock whose underlying is in the US
 * ETF registry is an `etf`. Only stock → etf, and only with a registry.
 */
describe('classifyAssetClass ETF refinement', () => {
  const etfTickers = new Map([
    ['AAPU', 'Direxion Daily AAPL Bull 2X ETF'],
    ['SPY', 'State Street SPDR S&P 500 ETF Trust'],
    ['QQQ', 'Invesco QQQ Trust'],
  ])
  const base = { pair: 'X', quoteAsset: 'USDT' }

  it('reclassifies a stock whose underlying is a US ETF', () => {
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'bitget',
        baseAsset: 'rAAPU',
        underlying: 'AAPU',
        connectorAssetClass: 'stock',
        etfTickers,
      }),
    ).to.equal('etf')
    // Clean perp base, no underlying.
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'binanceUsdm',
        baseAsset: 'SPY',
        connectorAssetClass: 'stock',
        etfTickers,
      }),
    ).to.equal('etf')
    // Kraken xStock wrapper resolves through the ticker normalizer.
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'kraken',
        baseAsset: 'QQQx',
        connectorAssetClass: 'stock',
        etfTickers,
      }),
    ).to.equal('etf')
  })

  it('leaves companies, crypto and an empty registry alone', () => {
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'bitget',
        baseAsset: 'rAAPL',
        underlying: 'AAPL',
        connectorAssetClass: 'stock',
        etfTickers,
      }),
    ).to.equal('stock')
    // A crypto coin sharing an ETF ticker is never touched.
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'binance',
        baseAsset: 'SPY',
        connectorAssetClass: 'crypto',
        etfTickers,
      }),
    ).to.equal('crypto')
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'binance',
        baseAsset: 'SPY',
        etfTickers,
      }),
    ).to.equal('crypto')
    expect(
      classifyAssetClass({
        ...base,
        exchange: 'bitget',
        baseAsset: 'rAAPU',
        underlying: 'AAPU',
        connectorAssetClass: 'stock',
        etfTickers: new Map(),
      }),
    ).to.equal('stock')
  })
})
