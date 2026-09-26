process.env.NODE_ENV = 'testing'

/**
 * "In positions" in USD (main-app spec 019 §4): each deal's current usage in
 * the asset it is held in, grid current exposure, priced per asset — never a
 * sum of quote amounts in different currencies.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StrategyEnum } from '../../types'
import { dealExposure, gridExposure, sumInPositions } from './inPositions'
import { priceExposures } from '../graphql/handlers/inPositions.handler'

const deal = (over: Record<string, unknown> = {}) => ({
  strategy: StrategyEnum.long,
  exchange: 'binance',
  exchangeUUID: 'acc1',
  symbol: { baseAsset: 'ETH', quoteAsset: 'USDT' },
  settings: { futures: false, coinm: false },
  usage: { current: { base: 0.5, quote: 1000 } },
  ...over,
})

describe('in positions exposure (spec 019 §4)', () => {
  it('spot long and USD-M futures are held in quote', () => {
    expect(dealExposure(deal())).to.deep.include({
      asset: 'USDT',
      amount: 1000,
    })
    expect(
      dealExposure(deal({ settings: { futures: true, coinm: false } })),
    ).to.deep.include({ asset: 'USDT', amount: 1000 })
  })

  it('spot short and COIN-M are held in base', () => {
    expect(
      dealExposure(deal({ strategy: StrategyEnum.short })),
    ).to.deep.include({ asset: 'ETH', amount: 0.5 })
    expect(
      dealExposure(deal({ settings: { futures: true, coinm: true } })),
    ).to.deep.include({ asset: 'ETH', amount: 0.5 })
  })

  it('grid: futures entry notional in quote, spot base held, COIN-M unpriced', () => {
    const g = {
      exchange: 'binance',
      exchangeUUID: 'acc1',
      symbol: { baseAsset: 'BTC', quoteAsset: 'USDT' },
    }
    expect(
      gridExposure({
        ...g,
        settings: { futures: true, coinm: false },
        position: { qty: 0.1, price: 60000 },
      }),
    ).to.deep.include({ asset: 'USDT', amount: 6000 })
    expect(
      gridExposure({
        ...g,
        settings: { futures: false },
        currentBalances: { base: 0.2, quote: 100 },
      }),
    ).to.deep.include({ asset: 'BTC', amount: 0.2 })
    expect(
      gridExposure({ ...g, settings: { futures: true, coinm: true } }),
    ).to.equal(null)
  })

  it('sums USD across different quote currencies (USDT + BTC)', () => {
    const docs = [
      dealExposure(deal()),
      dealExposure(deal()),
      dealExposure(
        deal({
          symbol: { baseAsset: 'ETH', quoteAsset: 'BTC' },
          usage: { current: { base: 1, quote: 0.05 } },
        }),
      ),
    ]
    const prices = new Map([
      ['acc1:USDT', 1],
      ['acc1:BTC', 60000],
    ])
    expect(sumInPositions(docs, prices)).to.deep.equal({
      inPositionsUsd: 2000 + 3000,
      inPositionsCount: 3,
      inPositionsUnpriced: 0,
    })
  })

  it('an asset without a price is excluded and counted, not summed as 0 silently', () => {
    const docs = [
      dealExposure(deal()),
      dealExposure(deal({ symbol: { baseAsset: 'X', quoteAsset: 'ODD' } })),
      null,
    ]
    const r = sumInPositions(docs, new Map([['acc1:USDT', 1]]))
    expect(r).to.deep.equal({
      inPositionsUsd: 1000,
      inPositionsCount: 3,
      inPositionsUnpriced: 2,
    })
  })

  it('priceExposures asks the pricer once per account+asset group', async () => {
    const calls: any[] = []
    const pricer = async (rows: any[]) => {
      calls.push(rows)
      return new Map(
        rows.map((r) => [
          `${r.exchangeUUID}:${r.asset}`,
          { price: r.asset === 'BTC' ? 60000 : 1, usdValue: 0 },
        ]),
      )
    }
    const r = await priceExposures(
      [
        dealExposure(deal()),
        dealExposure(deal()),
        dealExposure(
          deal({
            symbol: { baseAsset: 'ETH', quoteAsset: 'BTC' },
            usage: { current: { base: 1, quote: 0.05 } },
          }),
        ),
      ],
      pricer as never,
    )
    expect(calls).to.have.length(1)
    expect(calls[0]).to.have.length(2)
    expect(r.inPositionsUsd).to.equal(5000)
  })
})
