/**
 * RSI smoothing fields through the v2 REST validators (create for DCA and
 * combo, and the indicator-replacing update): smoothing none + 7 averages
 * (case-insensitive; vwma / price refused), smoothingLength a whole number
 * 1..1000, smoothingCompare value | line, and line + bw refused while
 * smoothing is on. The fields stay optional — bots without them validate as
 * before.
 *
 * No DB: `pairDb.readData` is replaced, as in indicatorBetween.spec.ts.
 */
import { expect } from 'chai'
import { pairDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'
import type { DCABotSettings } from '../../../types'
import { applyIndicatorSettingsUpdate } from './validators/indicatorUpdate'

/* eslint-disable @typescript-eslint/no-require-imports */
const { DCA_FORM_DEFAULTS, COMBO_FORM_DEFAULTS } = require('./botDefaults')
const {
  validateCreateDCABotInput,
  validateCreateComboBotInput,
} = require('./validators/bots')
/* eslint-enable @typescript-eslint/no-require-imports */

const EXCHANGE_UUID = 'e0000000-0000-0000-0000-000000000000'

const indicator = (over: Record<string, unknown>) => ({
  type: 'RSI',
  indicatorLength: 14,
  indicatorValue: '30',
  indicatorCondition: 'cu',
  indicatorInterval: '1h',
  groupId: 'g1',
  uuid: 'u1',
  indicatorAction: 'startDeal',
  ...over,
})

const post = async (ind: Record<string, unknown>, combo = false) => {
  const body = {
    name: 'smoothing',
    pair: ['BTC_USDT'],
    startCondition: 'TechnicalIndicators',
    indicators: [ind],
    indicatorGroups: [{ id: 'g1', logic: 'and', action: 'startDeal' }],
    exchangeUUID: EXCHANGE_UUID,
  }
  const settings = {
    ...(combo ? COMBO_FORM_DEFAULTS : DCA_FORM_DEFAULTS),
    ...body,
    type: 'regular',
    futures: false,
    coinm: false,
    exchange: 'binance',
    exchangeUUID: EXCHANGE_UUID,
    vars: { list: [], paths: [] },
  }
  return (combo ? validateCreateComboBotInput : validateCreateDCABotInput)(
    settings,
    body,
    '650da8e761845af24b76e600',
  )
}

const messages = (r: any): string =>
  (r.errors as [string, string][]).map((e) => e.join(': ')).join('\n')

describe('oscillator smoothing — v2 validators', () => {
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

  for (const combo of [false, true]) {
    const kind = combo ? 'combo' : 'dca'

    it(`${kind}: an RSI without the fields validates as before`, async () => {
      const r = await post(indicator({}), combo)
      expect(r.valid, messages(r)).to.equal(true)
      expect(r.data.indicators[0]).to.not.have.property('smoothing')
    })

    it(`${kind}: accepts none and every allowed average, any case, both modes`, async () => {
      for (const t of [
        'none',
        'sma',
        'EMA',
        'wma',
        'Dema',
        'tema',
        'hma',
        'RMA',
      ]) {
        for (const c of ['value', 'line', 'Line']) {
          const r = await post(
            indicator({
              smoothing: t,
              smoothingLength: 14,
              smoothingCompare: c,
            }),
            combo,
          )
          expect(r.valid, `${t}/${c}: ${messages(r)}`).to.equal(true)
          expect(r.data.indicators[0]).to.include({
            smoothing: t,
            smoothingLength: 14,
            smoothingCompare: c,
          })
        }
      }
    })

    it(`${kind}: null fields mean off and are accepted`, async () => {
      const r = await post(
        indicator({
          smoothing: null,
          smoothingLength: null,
          smoothingCompare: null,
        }),
        combo,
      )
      expect(r.valid, messages(r)).to.equal(true)
    })

    it(`${kind}: refuses vwma, price and unknown averages`, async () => {
      for (const t of ['vwma', 'price', 'kama', 12]) {
        const r = await post(indicator({ smoothing: t }), combo)
        expect(r.valid, `${t}`).to.equal(false)
        expect(messages(r)).to.match(/smoothing/)
      }
    })

    it(`${kind}: length must be a whole number from 1 to 1000`, async () => {
      for (const l of [1, 14, 1000]) {
        const r = await post(
          indicator({ smoothing: 'ema', smoothingLength: l }),
          combo,
        )
        expect(r.valid, `${l}: ${messages(r)}`).to.equal(true)
      }
      for (const l of [0, -3, 2.5, 1001, 'abc']) {
        const r = await post(
          indicator({ smoothing: 'ema', smoothingLength: l }),
          combo,
        )
        expect(r.valid, `${l}`).to.equal(false)
        expect(messages(r)).to.match(/smoothingLength/)
      }
    })

    it(`${kind}: compare must be value or line`, async () => {
      const r = await post(indicator({ smoothingCompare: 'cross' }), combo)
      expect(r.valid).to.equal(false)
      expect(messages(r)).to.match(/smoothingCompare/)
    })

    it(`${kind}: line + bw is refused while smoothing is on`, async () => {
      const between = {
        indicatorCondition: 'bw',
        indicatorValue: '30',
        indicatorValue2: '60',
      }
      const on = await post(
        indicator({
          ...between,
          smoothing: 'ema',
          smoothingLength: 14,
          smoothingCompare: 'line',
        }),
        combo,
      )
      expect(on.valid).to.equal(false)
      expect(messages(on)).to.match(/Between is not available/)
      // value mode, or smoothing off, keeps bw valid
      for (const extra of [
        {
          smoothing: 'ema',
          smoothingLength: 14,
          smoothingCompare: 'value',
        },
        {
          smoothing: 'none',
          smoothingLength: 14,
          smoothingCompare: 'line',
        },
      ]) {
        const r = await post(indicator({ ...between, ...extra }), combo)
        expect(r.valid, messages(r)).to.equal(true)
      }
    })
  }

  it('every smoothable oscillator accepts smoothing in both modes', async () => {
    for (const type of [
      'RSI',
      'CCI',
      'MFI',
      'WR',
      'UO',
      'MOM',
      'AO',
      'ADX',
      'BBPB',
      'KCPB',
      'BBW',
      'VO',
      'MAR',
    ]) {
      for (const smoothingCompare of ['value', 'line']) {
        const r = await post(
          indicator({
            type,
            smoothing: 'tema',
            smoothingLength: 5,
            smoothingCompare,
          }),
        )
        expect(r.valid, `${type}/${smoothingCompare}: ${messages(r)}`).to.equal(
          true,
        )
      }
    }
  })

  it('other indicators refuse smoothing, but accept none', async () => {
    for (const type of [
      'MACD',
      'Stoch',
      'StochRSI',
      'ATR',
      'BBWP',
      'MA',
      'XO',
    ]) {
      const r = await post(
        indicator({ type, smoothing: 'ema', smoothingLength: 14 }),
      )
      expect(r.valid, type).to.equal(false)
      expect(messages(r), type).to.match(/Smoothing is not available for/)
      const none = await post(indicator({ type, smoothing: 'none' }))
      expect(messages(none), type).to.not.match(/smoothing/i)
    }
  })

  it('update: the same rules apply when indicators are replaced', () => {
    const current = {
      ...DCA_FORM_DEFAULTS,
      startCondition: 'TechnicalIndicators',
      indicators: [indicator({})],
      indicatorGroups: [{ id: 'g1', logic: 'and', action: 'startDeal' }],
    } as unknown as DCABotSettings
    const ok = applyIndicatorSettingsUpdate(current, {
      indicators: [
        indicator({
          smoothing: 'hma',
          smoothingLength: 9,
          smoothingCompare: 'line',
        }),
      ],
    } as never)
    expect(ok.status).to.equal(StatusEnum.ok)
    const bad = applyIndicatorSettingsUpdate(current, {
      indicators: [indicator({ smoothing: 'vwma', smoothingLength: 9 })],
    } as never)
    expect(bad.status).to.equal(StatusEnum.notok)
  })
})
