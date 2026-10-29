process.env.NODE_ENV = 'testing'

/**
 * VWAP, KDJ, ADX DMI mode and the Moving Average trend filter, end to end on
 * the live path: the condition's settings → `buildIndicatorConfig` (the room
 * config) → `@gainium/indicators` `createIndicator` / `feedCandle` with the
 * indicator service's candle (open time `t` and volume included) → the
 * service's stored history value (`indicatorHistoryValue`) → the engine's
 * decision (`evaluateIndicatorCondition`). On every bar the decision must
 * equal the indicators package's own decision on the package's own results —
 * the function the backtester calls — so live bots and backtests fire on the
 * same bars.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  EMA,
  createIndicator,
  dmiCondition,
  feedCandle,
  kdjCondition,
  lineCondition,
  trendFilterCondition,
  vwapCondition,
} from '@gainium/indicators'
import {
  ADXModeEnum,
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum as C,
  KDJCompareToEnum,
  KDJLineEnum,
  MAEnum,
  StochRangeEnum,
  TrendFilterOperatorEnum,
  VWAPAnchorEnum,
  VWAPLineEnum,
} from '../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../types'
import { buildIndicatorConfig, evaluateIndicatorCondition } from '.'
import { indicatorHistoryValue } from '../historyValue'

const M15 = 15 * 60_000
/** a UTC midnight, so the first VWAP day is complete */
const DAY0 = Date.UTC(2026, 0, 5)

type Candle = {
  o: number
  h: number
  l: number
  c: number
  v: number
  t: number
}

/** deterministic random walk (mulberry32) */
function candles(n: number, seed = 7): Candle[] {
  let a = seed
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out: Candle[] = []
  let c = 100
  for (let i = 0; i < n; i++) {
    const o = c
    c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.02))
    const h = Math.max(o, c) * (1 + rnd() * 0.004)
    const l = Math.min(o, c) * (1 - rnd() * 0.004)
    out.push({ o, h, l, c, v: 10 + rnd() * 90, t: DAY0 + i * M15 })
  }
  return out
}

const settings = (
  type: IndicatorEnum,
  extra: Partial<SettingsIndicators>,
): SettingsIndicators =>
  ({
    type,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.fifteenM,
    indicatorLength: 14,
    indicatorValue: '20',
    indicatorCondition: C.cu,
    ...extra,
  }) as SettingsIndicators

const ctx = {
  interval: ExchangeIntervals.fifteenM,
  symbol: 'BTCUSDT',
  exchange: 'binance',
  showLog: false,
  debug: () => undefined,
  reference: () => undefined,
  setReference: () => undefined,
}

/**
 * Runs `s` on the live path over `series`; `expected(last, prev)` gets the
 * package's raw results of the newest two bars. Returns how many bars fired.
 */
function run(
  s: SettingsIndicators,
  series: Candle[],
  expected: (last: any, prev: any, close: number) => boolean,
): { fired: number; bars: number } {
  const ind = createIndicator(buildIndicatorConfig(s) as never)
  expect(ind, 'factory builds the room').to.not.equal(null)
  const history: IndicatorHistory[] = []
  const raw: unknown[] = []
  let fired = 0
  let bars = 0
  for (const k of series) {
    feedCandle(ind, k)
    const result = ind!.result
    if (result === null || result === undefined) continue
    history.push({
      time: k.t,
      type: s.type,
      value: indicatorHistoryValue(s.type, result, k.c, s.maType ?? ''),
    } as IndicatorHistory)
    raw.push(JSON.parse(JSON.stringify(result)))
    if (history.length > 3) history.shift()
    if (history.length < 2) continue
    // the bars go through JSON in the engine (Redis), so they do here too
    const bars2 = JSON.parse(JSON.stringify(history)) as IndicatorHistory[]
    const got = evaluateIndicatorCondition(s, bars2, ctx).action
    const want = expected(raw[raw.length - 1], raw[raw.length - 2], k.c)
    expect(got, `${s.type} at ${new Date(k.t).toISOString()}`).to.equal(want)
    if (got) fired++
    bars++
  }
  return { fired, bars }
}

describe('indicators/conditions — VWAP, KDJ, DMI, MA trend filter (live path)', () => {
  const series = candles(4 * 96)

  for (const vwapLine of [
    VWAPLineEnum.vwap,
    VWAPLineEnum.upper,
    VWAPLineEnum.lower,
  ])
    for (const cond of [C.cu, C.cd, C.gt, C.lt])
      it(`VWAP ${vwapLine} ${cond} = vwapCondition`, () => {
        const s = settings(IndicatorEnum.vwap, {
          vwapAnchor: VWAPAnchorEnum.day,
          vwapLine,
          vwapBandMultiplier: 1.5,
          indicatorCondition: cond,
        })
        const { fired, bars } = run(s, series, (last, prev) =>
          vwapCondition(last, prev, {
            line: vwapLine,
            bandMultiplier: 1.5,
            condition: cond,
          }),
        )
        expect(bars).to.be.greaterThan(200)
        expect(fired).to.be.greaterThan(0)
      })

  it('VWAP needs the candle open time: without it nothing is accumulated', () => {
    const s = settings(IndicatorEnum.vwap, { indicatorCondition: C.gt })
    const ind = createIndicator(buildIndicatorConfig(s) as never)!
    for (const k of series) feedCandle(ind, { ...k, t: undefined })
    const r = ind.result as { vwap?: number } | null
    expect(r === null || Number.isNaN(r.vwap)).to.equal(true)
  })

  for (const [kdjLine, kdjCompareTo, stochRange] of [
    [KDJLineEnum.k, KDJCompareToEnum.d, undefined],
    [KDJLineEnum.j, KDJCompareToEnum.k, StochRangeEnum.both],
    [KDJLineEnum.d, KDJCompareToEnum.custom, undefined],
  ] as [KDJLineEnum, KDJCompareToEnum, StochRangeEnum | undefined][])
    for (const cond of [C.cu, C.cd, C.gt, C.lt])
      it(`KDJ ${kdjLine} vs ${kdjCompareTo} ${cond} zone ${stochRange} = kdjCondition`, () => {
        const s = settings(IndicatorEnum.kdj, {
          kdjLength: 9,
          kdjKSmooth: 3,
          kdjDSmooth: 3,
          kdjLine,
          kdjCompareTo,
          indicatorValue: '50',
          indicatorCondition: cond,
          stochRange,
          stochUpper: '80',
          stochLower: '20',
        })
        const { fired } = run(s, series, (last, prev) =>
          kdjCondition(last, prev, {
            line: kdjLine,
            compareTo: kdjCompareTo,
            level: '50',
            condition: cond,
            zone: stochRange,
            stochUpper: '80',
            stochLower: '20',
          }),
        )
        if (!stochRange) expect(fired).to.be.greaterThan(0)
      })

  for (const cond of [C.cu, C.cd, C.gt, C.lt])
    it(`ADX DMI ${cond} = dmiCondition; indicatorValue is not read`, () => {
      const s = settings(IndicatorEnum.adx, {
        adxMode: ADXModeEnum.dmi,
        indicatorCondition: cond,
        indicatorValue: '1000',
      })
      const { fired } = run(s, series, (last, prev) =>
        dmiCondition(last, prev, { condition: cond }),
      )
      expect(fired).to.be.greaterThan(0)
    })

  it('ADX without DMI mode keeps the ADX value condition', () => {
    const s = settings(IndicatorEnum.adx, {
      adxMode: ADXModeEnum.adx,
      indicatorCondition: C.gt,
      indicatorValue: '20',
    })
    run(s, series, (last) => lineCondition('gt', last.value, 20))
  })

  for (const maType of [MAEnum.ema, MAEnum.vwma, MAEnum.mcginley])
    for (const trendFilterType of [
      TrendFilterOperatorEnum.lower,
      TrendFilterOperatorEnum.higher,
      TrendFilterOperatorEnum.between,
    ])
      it(`MA ${maType} trend filter ${trendFilterType}: MA vs price AND trendFilterCondition`, () => {
        const s = settings(IndicatorEnum.ma, {
          maType,
          maCrossingValue: MAEnum.price,
          indicatorCondition: C.gt,
          indicatorLength: 20,
          trendFilter: true,
          trendFilterLookback: 5,
          trendFilterType,
          trendFilterValue: 0.2,
        })
        // <maType> gt price: the MA above the close, and the MA trending
        const { fired } = run(
          s,
          series,
          (last, _prev, close) =>
            lineCondition('gt', last.value, close) &&
            trendFilterCondition(last, { trendFilterType }),
        )
        expect(fired).to.be.greaterThan(0)
      })

  it('MA with the trend filter stores the plain MA bit for bit, plus trend', () => {
    const plain = settings(IndicatorEnum.ma, {
      maType: MAEnum.ema,
      indicatorLength: 20,
    })
    const filtered = {
      ...plain,
      trendFilter: true,
      trendFilterLookback: 5,
      trendFilterType: TrendFilterOperatorEnum.higher,
      trendFilterValue: 0.2,
    }
    const a = createIndicator(buildIndicatorConfig(plain) as never)!
    const b = createIndicator(buildIndicatorConfig(filtered) as never)!
    expect(a).to.be.instanceOf(EMA)
    let trends = 0
    for (const k of series) {
      feedCandle(a, k)
      feedCandle(b, k)
      if (a.result === null) continue
      const va = indicatorHistoryValue(IndicatorEnum.ma, a.result, k.c, 'ema')
      const vb = indicatorHistoryValue(
        IndicatorEnum.ma,
        b.result,
        k.c,
        'ema',
      ) as { trend?: number }
      expect(va).to.deep.equal({ ma: a.result, price: k.c, maType: 'ema' })
      const { trend, ...rest } = vb
      expect(rest).to.deep.equal(va)
      if (trend !== undefined) trends++
    }
    expect(trends).to.be.greaterThan(300)
  })
})
