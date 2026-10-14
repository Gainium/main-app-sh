process.env.NODE_ENV = 'testing'

/**
 * Spec `162` — which venues hold a reduce-only close to their minimum order
 * value. Walks every `ExchangeEnum` value in both position modes, so a venue
 * added later is held to its minimum unless it is deliberately listed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import { closeOrderQuoteMinimum } from './closeOrderMinValue'

const MIN = 5

const exemptIn = (hedge: boolean) =>
  Object.values(ExchangeEnum)
    .filter((e) => closeOrderQuoteMinimum(e, hedge, MIN) === 0)
    .sort()

describe('closeOrderQuoteMinimum (spec 162)', () => {
  it('§1.1 one-way: only bybit linear and binance USDⓈ-M, live and paper', () => {
    expect(exemptIn(false)).to.deep.equal(
      [
        ExchangeEnum.binanceUsdm,
        ExchangeEnum.bybitUsdm,
        ExchangeEnum.paperBinanceUsdm,
        ExchangeEnum.paperBybitUsdm,
      ].sort(),
    )
  })

  it('§1.1 hedge: those plus bitget USDT-M, live and paper', () => {
    expect(exemptIn(true)).to.deep.equal(
      [
        ExchangeEnum.binanceUsdm,
        ExchangeEnum.bybitUsdm,
        ExchangeEnum.paperBinanceUsdm,
        ExchangeEnum.paperBybitUsdm,
        ExchangeEnum.bitgetUsdm,
        ExchangeEnum.paperBitgetUsdm,
      ].sort(),
    )
  })

  it('§1.3 every other venue keeps its minimum, unchanged', () => {
    for (const hedge of [false, true]) {
      for (const e of Object.values(ExchangeEnum)) {
        const got = closeOrderQuoteMinimum(e, hedge, MIN)
        expect([0, MIN], `${e} hedge=${hedge}`).to.include(got)
      }
    }
    // the ones spec §1.3 names
    for (const e of [
      ExchangeEnum.hyperliquidLinear,
      ExchangeEnum.bybit,
      ExchangeEnum.binance,
      ExchangeEnum.bitget,
      ExchangeEnum.bybitCoinm,
      ExchangeEnum.binanceCoinm,
      ExchangeEnum.bitgetCoinm,
      ExchangeEnum.krakenCoinm,
    ]) {
      expect(closeOrderQuoteMinimum(e, true, MIN), e).to.equal(MIN)
    }
  })

  it('an unknown exchange keeps the minimum', () => {
    expect(closeOrderQuoteMinimum(undefined, true, MIN)).to.equal(MIN)
  })
})
