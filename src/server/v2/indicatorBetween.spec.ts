/**
 * Indicator condition "bw" (between) through the v2 create validator:
 * accepted on value-type indicators with two numeric bounds, rejected
 * everywhere it cannot be evaluated, and never on single-value conditions.
 *
 * No DB: `pairDb.readData` is replaced, as in pairRoundTrip.spec.ts.
 */
import { expect } from 'chai'
import { pairDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'

/* eslint-disable @typescript-eslint/no-require-imports */
const { DCA_FORM_DEFAULTS } = require('./botDefaults')
const { validateCreateDCABotInput } = require('./validators/bots')
/* eslint-enable @typescript-eslint/no-require-imports */

const EXCHANGE_UUID = 'e0000000-0000-0000-0000-000000000000'

const indicator = (over: Record<string, unknown>) => ({
  type: 'RSI',
  indicatorLength: 14,
  indicatorValue: '30',
  indicatorValue2: '60',
  indicatorCondition: 'bw',
  indicatorInterval: '1h',
  groupId: 'g1',
  uuid: 'u1',
  indicatorAction: 'startDeal',
  ...over,
})

const postDca = async (
  ind: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  const body = {
    name: 'between',
    pair: ['BTC_USDT'],
    startCondition: 'TechnicalIndicators',
    indicators: [ind],
    indicatorGroups: [{ id: 'g1', logic: 'and', action: 'startDeal' }],
    exchangeUUID: EXCHANGE_UUID,
    ...extra,
  }
  const settings = {
    ...DCA_FORM_DEFAULTS,
    ...body,
    type: 'regular',
    futures: false,
    coinm: false,
    exchange: 'binance',
    exchangeUUID: EXCHANGE_UUID,
    vars: { list: [], paths: [] },
  }
  return validateCreateDCABotInput(settings, body, '650da8e761845af24b76e600')
}

const messages = (r: any): string =>
  (r.errors as [string, string][]).map((e) => e.join(': ')).join('\n')

describe('indicator condition "bw" (between) — v2 validator', () => {
  let originalReadData: unknown

  before(() => {
    originalReadData = (pairDb as any).readData
    ;(pairDb as any).readData = async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: [
          {
            exchange: 'binance',
            pair: 'BTCUSDT',
            baseAsset: { name: 'BTC' },
            quoteAsset: { name: 'USDT' },
          },
        ],
      },
    })
  })

  after(() => {
    ;(pairDb as any).readData = originalReadData
  })

  it('accepts RSI between 30 and 60', async () => {
    const r = await postDca(indicator({}))
    expect(r.valid, messages(r)).to.equal(true)
    expect(r.data.indicators[0].indicatorValue2).to.equal('60')
  })

  it('requires a numeric upper bound', async () => {
    const r = await postDca(indicator({ indicatorValue2: undefined }))
    expect(messages(r)).to.match(/indicatorValue2/)
  })

  it('is refused on an indicator that does not compare one value', async () => {
    const r = await postDca(indicator({ type: 'MACD' }))
    expect(messages(r)).to.match(/not supported for indicator "MACD"/)
  })

  it('is refused with percentile', async () => {
    const r = await postDca(indicator({ percentile: true }))
    expect(messages(r)).to.match(/percentile/)
  })

  it('is not a valid start-bot price condition', async () => {
    const r = await postDca(indicator({ indicatorCondition: 'gt' }), {
      startBotPriceCondition: 'bw',
    })
    expect(r.valid).to.equal(false)
    expect(messages(r)).to.match(/startBotPriceCondition/)
  })
})
