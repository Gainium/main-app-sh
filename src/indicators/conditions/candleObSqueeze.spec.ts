process.env.NODE_ENV = 'testing'

/**
 * Candle colour, Order Blocks, Squeeze Momentum, Session Price levels outside
 * the session and Divergence pivots, end to end on the live path: the
 * condition's settings → `buildIndicatorConfig` (the room config) →
 * `@gainium/indicators` `createIndicator` / `feedCandle` with the indicator
 * service's candle (open time `t` included) → the service's stored history
 * value (`indicatorHistoryValue`) → the engine's decision
 * (`evaluateIndicatorCondition`). On every bar the decision must equal the
 * indicators package's own decision on the package's own results — the
 * function the backtester calls — so live bots and backtests fire on the same
 * bars. The spec's invariants are checked on the same walks.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  candleCondition,
  createIndicator,
  feedCandle,
  orderBlockCondition,
  sessionLevelsCondition,
  squeezeCondition,
} from '@gainium/indicators'
import {
  CandleColorEnum,
  CandleSourceEnum,
  CandleTriggerEnum,
  DivTypeEnum,
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum as C,
  OBLevelEnum,
  OBSideEnum,
  SessionLevelEnum,
  SessionLevelsActiveEnum,
  SessionRuleEnum,
  SqzMomentumEnum,
  SqzSignalEnum,
} from '../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../types'
import { buildIndicatorConfig, evaluateIndicatorCondition } from '.'
import { indicatorHistoryValue } from '../historyValue'
import { conditionSettingsGaps } from './catalog'
import {
  CandleColorEnum as PkgCandleColorEnum,
  CandleSourceEnum as PkgCandleSourceEnum,
  CandleTriggerEnum as PkgCandleTriggerEnum,
  OBLevelEnum as PkgOBLevelEnum,
  OBSideEnum as PkgOBSideEnum,
  SessionLevelsActiveEnum as PkgSessionLevelsActiveEnum,
  SqzMomentumEnum as PkgSqzMomentumEnum,
  SqzSignalEnum as PkgSqzSignalEnum,
} from '@gainium/indicators'

const M15 = 15 * 60_000
/** Monday 2026-01-05 00:00 UTC */
const DAY0 = Date.UTC(2026, 0, 5)

type Candle = {
  o: number
  h: number
  l: number
  c: number
  v: number
  t: number
}

/** deterministic random walk (mulberry32); every `dojiEvery`-th bar a doji */
function candles(n: number, seed = 11, dojiEvery = 0): Candle[] {
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
    c =
      dojiEvery && i % dojiEvery === dojiEvery - 1
        ? o
        : Math.max(1, o * (1 + (rnd() - 0.5) * 0.02))
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
    indicatorValue: '0',
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
 * package's raw results of the newest two bars, `onBar` sees every decision.
 * Returns how many bars fired.
 */
function run(
  s: SettingsIndicators,
  series: Candle[],
  expected: (last: any, prev: any) => boolean,
  onBar: (got: boolean, last: any, prev: any) => void = () => undefined,
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
      value: indicatorHistoryValue(s.type, result, k.c, ''),
    } as IndicatorHistory)
    // the bars go through JSON in the engine (Redis): NaN arrives as null
    raw.push(JSON.parse(JSON.stringify(result)))
    if (history.length > 3) history.shift()
    if (history.length < 2) continue
    const bars2 = JSON.parse(JSON.stringify(history)) as IndicatorHistory[]
    const got = evaluateIndicatorCondition(s, bars2, ctx).action
    const last = raw[raw.length - 1]
    const prev = raw[raw.length - 2]
    expect(got, `${s.type} at ${new Date(k.t).toISOString()}`).to.equal(
      expected(last, prev),
    )
    onBar(got, last, prev)
    if (got) fired++
    bars++
  }
  return { fired, bars }
}

describe('indicators/conditions — Candle colour, Order Blocks, Squeeze, Session active, DIV pivots', () => {
  const series = candles(8 * 96, 11, 13)

  it('the enums are the indicators package’s', () => {
    expect(Object.values(CandleSourceEnum)).to.deep.equal(
      Object.values(PkgCandleSourceEnum),
    )
    expect(Object.values(CandleColorEnum)).to.deep.equal(
      Object.values(PkgCandleColorEnum),
    )
    expect(Object.values(CandleTriggerEnum)).to.deep.equal(
      Object.values(PkgCandleTriggerEnum),
    )
    expect(Object.values(OBSideEnum)).to.deep.equal(
      Object.values(PkgOBSideEnum),
    )
    expect(Object.values(OBLevelEnum)).to.deep.equal(
      Object.values(PkgOBLevelEnum),
    )
    expect(Object.values(SqzSignalEnum)).to.deep.equal(
      Object.values(PkgSqzSignalEnum),
    )
    expect(Object.values(SqzMomentumEnum)).to.deep.equal(
      Object.values(PkgSqzMomentumEnum),
    )
    expect(Object.values(SessionLevelsActiveEnum)).to.deep.equal(
      Object.values(PkgSessionLevelsActiveEnum),
    )
  })

  for (const candleSource of [
    CandleSourceEnum.heikinAshi,
    CandleSourceEnum.regular,
  ])
    for (const candleColor of [CandleColorEnum.green, CandleColorEnum.red])
      for (const candleTrigger of [
        CandleTriggerEnum.streak,
        CandleTriggerEnum.start,
      ])
        for (const candleCount of [1, 3])
          it(`CANDLE ${candleSource} ${candleColor} ${candleTrigger} ×${candleCount} = candleCondition, never on a doji`, () => {
            const s = settings(IndicatorEnum.candle, {
              candleSource,
              candleColor,
              candleTrigger,
              candleCount,
            })
            const { fired, bars } = run(
              s,
              series,
              (last, prev) =>
                candleCondition(last, prev, {
                  color: candleColor,
                  count: candleCount,
                  trigger: candleTrigger,
                }),
              (got, last) => {
                // invariant: a candle condition never fires on a doji
                if (last.color === 0) expect(got).to.equal(false)
              },
            )
            expect(bars).to.be.greaterThan(600)
            expect(fired).to.be.greaterThan(0)
          })

  it('CANDLE: the room is the (normalised) source only', () => {
    const a = buildIndicatorConfig(
      settings(IndicatorEnum.candle, {
        candleColor: CandleColorEnum.red,
        candleCount: 4,
      }),
    )
    const b = buildIndicatorConfig(
      settings(IndicatorEnum.candle, {
        candleSource: CandleSourceEnum.heikinAshi,
        candleTrigger: CandleTriggerEnum.start,
      }),
    )
    expect(a).to.deep.equal({
      type: IndicatorEnum.candle,
      source: CandleSourceEnum.heikinAshi,
    })
    expect(b).to.deep.equal(a)
  })

  for (const obSide of [OBSideEnum.bullish, OBSideEnum.bearish])
    for (const obLevel of [
      OBLevelEnum.top,
      OBLevelEnum.middle,
      OBLevelEnum.bottom,
    ])
      for (const cond of [C.cu, C.cd, C.gt, C.lt])
        it(`OB ${obSide} ${obLevel} ${cond} = orderBlockCondition, no crossing on a new block`, () => {
          const s = settings(IndicatorEnum.ob, {
            obSwingLength: 3,
            obSide,
            obLevel,
            indicatorCondition: cond,
          })
          const idKey =
            obSide === OBSideEnum.bullish ? 'bullishId' : 'bearishId'
          let newBlockBars = 0
          const { fired, bars } = run(
            s,
            series,
            (last, prev) =>
              orderBlockCondition(last, prev, {
                side: obSide,
                level: obLevel,
                condition: cond,
              }),
            (got, last, prev) => {
              // invariant: a crossing never fires on the bar a new block
              // replaced the old one
              if (
                (cond === C.cu || cond === C.cd) &&
                last[idKey] !== null &&
                prev[idKey] !== last[idKey]
              ) {
                newBlockBars++
                expect(got).to.equal(false)
              }
            },
          )
          expect(bars).to.be.greaterThan(600)
          // a close above a bearish block's top (below a bullish block's
          // bottom) mitigates it, so those two never fire by design
          const mitigating =
            (obSide === OBSideEnum.bearish &&
              obLevel === OBLevelEnum.top &&
              cond === C.gt) ||
            (obSide === OBSideEnum.bullish &&
              obLevel === OBLevelEnum.bottom &&
              cond === C.lt)
          if (mitigating) expect(fired).to.equal(0)
          else if (cond === C.gt || cond === C.lt)
            expect(fired).to.be.greaterThan(0)
          if (cond === C.cu || cond === C.cd)
            expect(newBlockBars).to.be.greaterThan(0)
        })

  it('OB: the room is the (normalised) swing length only', () => {
    expect(
      buildIndicatorConfig(
        settings(IndicatorEnum.ob, {
          obSwingLength: '7' as unknown as number,
          obSide: OBSideEnum.bearish,
        }),
      ),
    ).to.deep.equal({ type: IndicatorEnum.ob, swingLength: 7 })
  })

  for (const sqzSignal of Object.values(SqzSignalEnum))
    for (const sqzMomentum of Object.values(SqzMomentumEnum))
      it(`SQZ ${sqzSignal} ${sqzMomentum} = squeezeCondition, fired needs a squeeze before`, () => {
        const s = settings(IndicatorEnum.sqz, {
          sqzLength: 20,
          sqzBBMult: 1.5,
          sqzKCLength: 20,
          sqzKCMult: 1.5,
          sqzSignal,
          sqzMomentum,
        })
        const { fired } = run(
          s,
          series,
          (last, prev) =>
            squeezeCondition(last, prev, {
              signal: sqzSignal,
              momentum: sqzMomentum,
            }),
          (got, _last, prev) => {
            // invariant: fired never fires when the previous bar was not in
            // a squeeze
            if (sqzSignal === SqzSignalEnum.fired && prev.squeeze !== 1)
              expect(got).to.equal(false)
          },
        )
        if (
          sqzSignal === SqzSignalEnum.any &&
          sqzMomentum === SqzMomentumEnum.any
        )
          expect(fired).to.equal(0)
      })

  it('SQZ: decimal multipliers reach the room; 2.5 is not 2', () => {
    const at = (sqzBBMult: number) =>
      buildIndicatorConfig(settings(IndicatorEnum.sqz, { sqzBBMult }))
    expect(at(2.5)).to.deep.equal({
      type: IndicatorEnum.sqz,
      length: 20,
      bbMult: 2.5,
      kcLength: 20,
      kcMult: 1.5,
    })
    expect(at(2.5)).to.not.deep.equal(at(2))
  })

  it('SQZ: both any is a settings gap', () => {
    const gaps = (extra: Partial<SettingsIndicators>) =>
      conditionSettingsGaps(settings(IndicatorEnum.sqz, extra)).map(
        (g) => g.field,
      )
    expect(
      gaps({ sqzSignal: SqzSignalEnum.any, sqzMomentum: SqzMomentumEnum.any }),
    ).to.deep.equal(['sqzMomentum'])
    expect(gaps({ sqzSignal: SqzSignalEnum.any })).to.deep.equal([])
    expect(gaps({})).to.deep.equal([])
  })

  // Monday session, no hours: the Monday range on the other days
  for (const sessionLevelsActive of [
    undefined,
    SessionLevelsActiveEnum.session,
    SessionLevelsActiveEnum.outside,
    SessionLevelsActiveEnum.always,
  ])
    for (const [a, b, cond] of [
      [SessionLevelEnum.price, SessionLevelEnum.prevHigh, C.cu],
      [SessionLevelEnum.price, SessionLevelEnum.prevLow, C.cd],
      [SessionLevelEnum.price, SessionLevelEnum.prevMid, C.gt],
    ] as [SessionLevelEnum, SessionLevelEnum, C][])
      it(`SESSION levels active=${sessionLevelsActive} ${a} ${cond} ${b} = sessionLevelsCondition`, () => {
        const s = settings(IndicatorEnum.session, {
          sessionRule: SessionRuleEnum.levels,
          sessionDays: [1],
          sessionLevelA: a,
          sessionLevelB: b,
          indicatorCondition: cond,
          sessionLevelsActive,
        })
        let outsideFired = 0
        let insideFired = 0
        const { fired } = run(
          s,
          candles(15 * 96, 5),
          (last, prev) =>
            sessionLevelsCondition(last, prev, {
              a,
              b,
              condition: cond,
              active: sessionLevelsActive,
            }),
          (got, last) => {
            if (got && last.inSession === 1) insideFired++
            if (got && last.inSession !== 1) outsideFired++
          },
        )
        // invariant: missing (or session) ⇒ false on every candle outside
        // the session, as before the setting existed
        if (
          sessionLevelsActive === undefined ||
          sessionLevelsActive === SessionLevelsActiveEnum.session
        )
          expect(outsideFired).to.equal(0)
        if (sessionLevelsActive === SessionLevelsActiveEnum.outside) {
          expect(insideFired).to.equal(0)
          // a level comparison (gt) holds somewhere on 15 days; a crossing
          // may not
          if (cond === C.gt) expect(outsideFired).to.be.greaterThan(0)
        }
        if (
          sessionLevelsActive === SessionLevelsActiveEnum.always &&
          cond === C.gt
        )
          expect(fired).to.be.greaterThan(0)
      })

  it('SESSION levels: sessionLevelsActive is not part of the room', () => {
    const at = (sessionLevelsActive?: SessionLevelsActiveEnum) =>
      buildIndicatorConfig(
        settings(IndicatorEnum.session, {
          sessionRule: SessionRuleEnum.levels,
          sessionDays: [1],
          sessionLevelsActive,
        }),
      )
    expect(at(SessionLevelsActiveEnum.outside)).to.deep.equal(at())
    expect(at(SessionLevelsActiveEnum.always)).to.deep.equal(at())
  })

  describe('DIV pivots', () => {
    const div = (extra: Record<string, unknown>) =>
      settings(IndicatorEnum.div, {
        divOscillators: [IndicatorEnum.rsi],
        divType: DivTypeEnum.abear,
        ...(extra as Partial<SettingsIndicators>),
      })

    it('no pivot fields ⇒ the room is exactly the one before the change', () => {
      const before = {
        type: IndicatorEnum.div,
        oscillators: [IndicatorEnum.rsi],
      }
      expect(buildIndicatorConfig(div({}))).to.deep.equal(before)
      expect(
        buildIndicatorConfig(
          div({
            divPivotLeft: '',
            divPivotRight: null,
            divRangeUpper: undefined,
          }),
        ),
      ).to.deep.equal(before)
      expect(Object.keys(buildIndicatorConfig(div({})))).to.deep.equal([
        'type',
        'oscillators',
      ])
    })

    it('a set field joins the room and reaches the DIV', () => {
      const config = buildIndicatorConfig(
        div({ divPivotLeft: '5', divRangeUpper: 90 }),
      )
      expect(config).to.deep.equal({
        type: IndicatorEnum.div,
        oscillators: [IndicatorEnum.rsi],
        leftBars: 5,
        rangeUpper: 90,
      })
      const ind = createIndicator(config as never) as unknown as {
        leftBars?: number
      }
      expect(ind).to.not.equal(null)
    })

    it('divRangeLower must be below divRangeUpper (defaults 1 / 60)', () => {
      const gaps = (extra: Record<string, unknown>) =>
        conditionSettingsGaps(div(extra)).map((g) => g.field)
      expect(gaps({})).to.deep.equal([])
      expect(gaps({ divRangeLower: 5, divRangeUpper: 30 })).to.deep.equal([])
      expect(gaps({ divRangeLower: 30, divRangeUpper: 30 })).to.deep.equal([
        'divRangeUpper',
      ])
      expect(gaps({ divRangeLower: 61 })).to.deep.equal(['divRangeUpper'])
      expect(gaps({ divRangeUpper: 1 })).to.deep.equal(['divRangeUpper'])
    })
  })
})
