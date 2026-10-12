process.env.NODE_ENV = 'testing'

/**
 * Oscillator smoothing in the live engine (smoothing / smoothingLength /
 * smoothingCompare) for every smoothable indicator:
 *
 *  - smoothing off (fields missing, `none`, length 0 / null, `vwma`,
 *    `price`, unknown) leaves every subscription config — and so every
 *    indicator room id — exactly as the engine recorded it before the fields
 *    existed (the characterization golden), for every indicator type;
 *  - smoothing on appends the normalised fields to a smoothable oscillator's
 *    config only (its own room) and never to any other type;
 *  - the condition decision in `value` and `line` modes, `bw` and missing
 *    `raw` never firing in `line`, percentile overriding `line`;
 *  - the settings rules the API and automations apply.
 *
 * Parity with `@gainium/backtester` on a live-fed series is in
 * `smoothingParity.spec.ts`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import fs from 'fs'
import { SMOOTHABLE_INDICATORS as LIBRARY_SMOOTHABLE } from '@gainium/indicators'
import path from 'path'
import {
  ExchangeEnum,
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum,
  SMOOTHABLE_INDICATORS,
} from '../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../types'
import { getId } from '../index'
import {
  buildIndicatorConfig,
  conditionSettingsGaps,
  evaluateIndicatorCondition,
  getSmoothingMode,
  indicatorLengthOf,
  indicatorSubscribeInterval,
  referenceSubscription,
  smoothingSettingsGaps,
} from '.'
import { configCases, serialise } from './__fixtures__/conditionCases'

const H = 3_600_000
const { cu, cd, gt, lt, bw } = IndicatorStartConditionEnum

const golden = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '__fixtures__/indicatorConditions.golden.json'),
    'utf8',
  ),
) as { configs: Record<string, string> }

const subscription = (settings: SettingsIndicators) => {
  if (!indicatorLengthOf(settings) || !settings.indicatorInterval)
    return 'not subscribed'
  const parts = [
    `${settings.uuid}@${indicatorSubscribeInterval(settings.type, settings.indicatorInterval)}=${serialise(buildIndicatorConfig(settings))}`,
  ]
  const ref = referenceSubscription(settings)
  if (ref) parts.push(`${ref.uuid}@${ref.interval}=${serialise(ref.config)}`)
  return parts.join(' | ')
}

const offVariants: [string, Record<string, unknown>][] = [
  ['none', { smoothing: 'none', smoothingLength: 14 }],
  [
    'none-line',
    { smoothing: 'none', smoothingLength: 14, smoothingCompare: 'line' },
  ],
  ['length-0', { smoothing: 'ema', smoothingLength: 0 }],
  ['length-null', { smoothing: 'ema', smoothingLength: null }],
  ['length-0.5', { smoothing: 'ema', smoothingLength: 0.5 }],
  ['type-null', { smoothing: null, smoothingLength: 14 }],
  ['vwma', { smoothing: 'vwma', smoothingLength: 14 }],
  ['price', { smoothing: 'price', smoothingLength: 14 }],
  ['unknown', { smoothing: 'kama', smoothingLength: 14 }],
  ['compare-only', { smoothingCompare: 'line' }],
]

const isSmoothable = (t: unknown) =>
  (SMOOTHABLE_INDICATORS as readonly string[]).includes(`${t}`)

const ind = (
  type: IndicatorEnum,
  condition: IndicatorStartConditionEnum,
  value: string,
  extra: object = {},
) =>
  ({
    type,
    indicatorLength: 14,
    indicatorValue: value,
    indicatorCondition: condition,
    indicatorInterval: ExchangeIntervals.oneH,
    indicatorAction: IndicatorAction.startDeal,
    groupId: 'g',
    uuid: 'u',
    ...extra,
  }) as unknown as SettingsIndicators

/** Two bars of a smoothed room, oldest first: [value = S, raw = R]. */
const bars = (
  type: IndicatorEnum,
  prev: [number, number | undefined],
  last: [number, number | undefined],
  extra: object = {},
) =>
  [
    { time: 0, type, value: { value: prev[0], raw: prev[1], ...extra } },
    { time: H, type, value: { value: last[0], raw: last[1], ...extra } },
  ] as unknown as IndicatorHistory[]

const decide = (s: SettingsIndicators, b: IndicatorHistory[]) =>
  evaluateIndicatorCondition(s, b, {
    interval: ExchangeIntervals.oneH,
    symbol: 'X',
    exchange: 'e',
    showLog: false,
    debug: () => undefined,
    reference: () => undefined,
    setReference: () => undefined,
  })

const ON = { smoothing: 'EMA', smoothingLength: 9 }
const LINE = { ...ON, smoothingCompare: 'line' }

describe('oscillator smoothing — live engine', () => {
  it('the scope is the value oscillators the condition reads as `value`', () => {
    expect([...SMOOTHABLE_INDICATORS].sort()).to.deep.equal(
      [
        IndicatorEnum.rsi,
        IndicatorEnum.cci,
        IndicatorEnum.mfi,
        IndicatorEnum.wr,
        IndicatorEnum.uo,
        IndicatorEnum.mom,
        IndicatorEnum.ao,
        IndicatorEnum.adx,
        IndicatorEnum.bbpb,
        IndicatorEnum.kcpb,
        IndicatorEnum.bbw,
        IndicatorEnum.vo,
        IndicatorEnum.mar,
      ].sort(),
    )
  })

  it('the scope is the indicators library’s', () => {
    expect([...SMOOTHABLE_INDICATORS].map(String).sort()).to.deep.equal(
      [...LIBRARY_SMOOTHABLE].map(String).sort(),
    )
  })

  describe('subscriptions (indicator room ids)', () => {
    it('smoothing off keeps every recorded engine subscription, for every type', () => {
      const diffs: string[] = []
      let checked = 0
      for (const { id, settings } of configCases()) {
        for (const [vname, extra] of offVariants) {
          const got = subscription({
            ...settings,
            ...extra,
          } as SettingsIndicators)
          if (got !== golden.configs[id]) diffs.push(`${id}/${vname}: ${got}`)
          checked++
        }
      }
      expect(checked).to.be.greaterThan(100)
      expect(diffs).to.deep.equal([])
    })

    it('smoothing on changes no subscription of a type that cannot be smoothed', () => {
      const diffs: string[] = []
      for (const { id, settings } of configCases()) {
        if (isSmoothable(settings.type)) continue
        const got = subscription({
          ...settings,
          ...LINE,
        } as SettingsIndicators)
        if (got !== golden.configs[id]) diffs.push(`${id}: ${got}`)
      }
      expect(diffs).to.deep.equal([])
    })

    it('smoothing on appends the normalised fields to each smoothable type', () => {
      const seen = new Set<string>()
      for (const { settings } of configCases()) {
        if (!isSmoothable(settings.type)) continue
        seen.add(settings.type)
        const off = buildIndicatorConfig(settings)
        const on = buildIndicatorConfig({
          ...settings,
          ...LINE,
        } as SettingsIndicators)
        expect(on, settings.type).to.deep.equal({
          ...off,
          smoothing: 'ema',
          smoothingLength: 9,
        })
        // appended last, so the room id is the old one plus the smoothing
        expect(Object.keys(on).slice(-2)).to.deep.equal([
          'smoothing',
          'smoothingLength',
        ])
        const id = (c: typeof on) =>
          getId(c, ExchangeEnum.binance, 'BTCUSDT', ExchangeIntervals.oneH)
        expect(id(on)).to.equal(id(off).replace('-binance-', 'ema9-binance-'))
      }
      expect([...seen].sort()).to.deep.equal([...SMOOTHABLE_INDICATORS].sort())
    })

    it('the compare mode is evaluation only: value and line share a room', () => {
      for (const t of SMOOTHABLE_INDICATORS) {
        expect(
          buildIndicatorConfig(
            ind(t, cu, '0', { ...ON, smoothingCompare: 'value' }),
          ),
        ).to.deep.equal(buildIndicatorConfig(ind(t, cu, '0', LINE)))
      }
    })

    it('the RSI room id of an unsmoothed RSI is unchanged', () => {
      const id = (extra: object) =>
        getId(
          buildIndicatorConfig(ind(IndicatorEnum.rsi, cu, '50', extra)),
          ExchangeEnum.binance,
          'BTCUSDT',
          ExchangeIntervals.oneH,
        )
      expect(id({})).to.equal('RSI-RSI14undefined15080-binance-BTCUSDT-1h')
      for (const [, extra] of offVariants) expect(id(extra)).to.equal(id({}))
      expect(id({ smoothing: 'hma', smoothingLength: 14 })).to.equal(
        'RSI-RSI14undefined15080hma14-binance-BTCUSDT-1h',
      )
    })
  })

  describe('decision', () => {
    for (const t of SMOOTHABLE_INDICATORS) {
      const extra = t === IndicatorEnum.mar ? { trend: 0 } : {}
      it(`${t}: 'value' compares the smoothed line with the value`, () => {
        const s = ind(t, cu, '50', ON)
        expect(getSmoothingMode(s)).to.equal('value')
        // smoothed 45 → 55 crosses 50 although the raw line stays above it
        expect(decide(s, bars(t, [45, 70], [55, 72], extra)).action).to.equal(
          true,
        )
        expect(decide(s, bars(t, [40, 45], [42, 60], extra)).action).to.equal(
          false,
        )
      })

      it(`${t}: 'line' compares its line with the smoothed line`, () => {
        const up = bars(t, [50, 48], [51, 53], extra) // raw crosses above S
        const above = bars(t, [50, 52], [51, 53], extra) // already above
        const down = bars(t, [50, 52], [51, 49], extra) // raw crosses below S
        const s = (c: IndicatorStartConditionEnum, v = '999') =>
          ind(t, c, v, LINE)
        expect(getSmoothingMode(s(cu))).to.equal('line')
        expect(decide(s(cu), up).action).to.equal(true)
        expect(decide(s(cu), above).action).to.equal(false)
        expect(decide(s(cd), down).action).to.equal(true)
        expect(decide(s(cd), up).action).to.equal(false)
        expect(decide(s(gt, '-999'), up).action).to.equal(true)
        expect(decide(s(gt, '999'), down).action).to.equal(false)
        expect(decide(s(lt, '999'), down).action).to.equal(true)
        expect(decide(s(lt, '-999'), up).action).to.equal(false)
        expect(decide(s(cu), up).compared).to.deep.equal({
          last: 53,
          prev: 48,
          value: 51,
          prevValue: 50,
        })
        // no value needed
        const noValue = s(cu)
        delete (noValue as Partial<SettingsIndicators>).indicatorValue
        expect(decide(noValue, up).action).to.equal(true)
        // bw never fires; a bar without the raw reading never fires
        expect(
          decide(ind(t, bw, '0', { ...LINE, indicatorValue2: '100' }), up)
            .action,
        ).to.equal(false)
        expect(
          decide(s(gt, '-999'), bars(t, [50, undefined], [51, 53], extra))
            .action,
        ).to.equal(false)
      })

      it(`${t}: percentile overrides 'line'`, () => {
        const s = ind(t, cu, '0', {
          ...LINE,
          percentile: true,
          percentileLookback: 20,
          percentilePercentage: 70,
        })
        expect(getSmoothingMode(s)).to.equal('value')
        const b = [
          {
            time: 0,
            type: t,
            value: { value: 40, raw: 90, percentile: 45, ...extra },
          },
          {
            time: H,
            type: t,
            value: { value: 50, raw: 10, percentile: 45, ...extra },
          },
        ] as unknown as IndicatorHistory[]
        // S crosses its percentile 45 upwards; R would cross S downwards
        expect(decide(s, b).action).to.equal(true)
      })

      it(`${t}: smoothing off reads the line exactly as before`, () => {
        for (const [, extra2] of offVariants) {
          const s = ind(t, cu, '50', extra2)
          expect(getSmoothingMode(s)).to.equal('off')
          const b = [
            { time: 0, type: t, value: { value: 45, ...extra } },
            { time: H, type: t, value: { value: 55, ...extra } },
          ] as unknown as IndicatorHistory[]
          expect(decide(s, b).action).to.equal(true)
        }
      })
    }

    it('a type that cannot be smoothed ignores the fields', () => {
      for (const t of [IndicatorEnum.macd, IndicatorEnum.atr, IndicatorEnum.xo])
        expect(getSmoothingMode(ind(t, cu, '0', LINE))).to.equal('off')
    })
  })

  describe('settings rules', () => {
    const fields = (
      extra: object,
      cond = cu,
      type: IndicatorEnum = IndicatorEnum.cci,
    ) => smoothingSettingsGaps(ind(type, cond, '50', extra)).map((g) => g.field)

    it('accepts none, every allowed average in any case, and unset fields', () => {
      expect(fields({})).to.deep.equal([])
      expect(fields({ smoothing: null, smoothingLength: null })).to.deep.equal(
        [],
      )
      for (const t of [
        'none',
        'sma',
        'EMA',
        'Wma',
        'dema',
        'tema',
        'hma',
        'rma',
      ])
        expect(fields({ smoothing: t, smoothingLength: 14 }), t).to.deep.equal(
          [],
        )
      for (const l of [1, 1000, '12'])
        expect(fields({ smoothingLength: l }), `${l}`).to.deep.equal([])
      expect(
        fields({
          smoothingCompare: 'LINE',
          smoothing: 'ema',
          smoothingLength: 3,
        }),
      ).to.deep.equal([])
    })

    it('rejects vwma, price, unknown averages, bad lengths and compare modes', () => {
      for (const t of ['vwma', 'price', 'kama'])
        expect(fields({ smoothing: t }), t).to.deep.equal(['smoothing'])
      for (const l of [0, -1, 1.5, 1001, 'abc'])
        expect(fields({ smoothingLength: l }), `${l}`).to.deep.equal([
          'smoothingLength',
        ])
      expect(fields({ smoothingCompare: 'both' })).to.deep.equal([
        'smoothingCompare',
      ])
    })

    it("rejects 'line' with bw only while smoothing is on", () => {
      expect(fields(LINE, bw)).to.deep.equal(['smoothingCompare'])
      expect(fields({ ...LINE, smoothing: 'none' }, bw)).to.deep.equal([])
      expect(fields({ ...LINE, percentile: true }, bw)).to.deep.equal([])
      expect(fields({ ...LINE, smoothingCompare: 'value' }, bw)).to.deep.equal(
        [],
      )
    })

    it('every smoothable type accepts it; every other type refuses it (none is fine)', () => {
      for (const t of SMOOTHABLE_INDICATORS)
        expect(fields(LINE, cu, t), t).to.deep.equal([])
      for (const t of Object.values(IndicatorEnum)) {
        if (isSmoothable(t)) continue
        expect(fields(ON, cu, t), t).to.deep.equal(['smoothing'])
        expect(fields({ smoothing: 'none' }, cu, t), t).to.deep.equal([])
      }
    })

    it('line mode needs no indicator value; bw + line is a gap', () => {
      const noValue = ind(IndicatorEnum.mfi, cu, '50', LINE)
      delete (noValue as Partial<SettingsIndicators>).indicatorValue
      expect(conditionSettingsGaps(noValue)).to.deep.equal([])
      const valueMode = ind(IndicatorEnum.mfi, cu, '50', ON)
      delete (valueMode as Partial<SettingsIndicators>).indicatorValue
      expect(
        conditionSettingsGaps(valueMode).map((g) => g.field),
      ).to.deep.equal(['indicatorValue'])
      expect(
        conditionSettingsGaps(
          ind(IndicatorEnum.rsi, bw, '30', { ...LINE, indicatorValue2: '60' }),
        ).map((g) => g.field),
      ).to.deep.equal(['smoothingCompare'])
      expect(
        conditionSettingsGaps(ind(IndicatorEnum.macd, cu, '0', ON)).map(
          (g) => g.field,
        ),
      ).to.deep.equal(['smoothing'])
    })
  })
})
