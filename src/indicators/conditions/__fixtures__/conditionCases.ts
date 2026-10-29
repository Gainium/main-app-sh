/**
 * Deterministic case table for the indicator condition characterization
 * suite. Every indicator type the DCA engine evaluates from an indicator room
 * is crossed with its condition settings and with edge-case bars: equality at
 * the threshold, a value within float epsilon of it, NaN / null values, a
 * single bar (no previous value), bars out of time order, mismatched bar
 * types, missing or zero reference series for MA and oscillator crosses.
 *
 * The order of `conditionCases()` is part of the golden file's format: append
 * new cases at the END only, or regenerate the golden from the untouched
 * engine.
 *
 * Shared by `src/bot/indicatorConditions.characterization.spec.ts` (runs the
 * cases through the DCA engine) and
 * `src/indicators/conditions/evaluate.spec.ts` (runs them through the shared
 * module directly).
 */
import {
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum as C,
  MAEnum,
  BBCrossingEnum,
  SRCrossingEnum,
  DCValueEnum,
  rsiValueEnum,
  rsiValue2Enum,
  StochRangeEnum,
  TrendFilterOperatorEnum,
  ppValueEnum,
  ppValueTypeEnum,
  OBFVGRefEnum,
  OBFVGValueEnum,
  LWValueEnum,
  LWConditionEnum,
  OTELegEnum,
  ADXModeEnum,
  KDJLineEnum,
  KDJCompareToEnum,
  VWAPAnchorEnum,
  VWAPLineEnum,
  CandleSourceEnum,
  CandleColorEnum,
  CandleTriggerEnum,
  OBSideEnum,
  OBLevelEnum,
  SqzSignalEnum,
  SqzMomentumEnum,
  SessionLevelsActiveEnum,
  PCCompareEnum,
  SessionLevelEnum,
  SessionRuleEnum,
  STConditionEnum,
  DivTypeEnum,
  TradingviewAnalysisSignalEnum,
  ECDTriggerEnum,
  RangeType,
  TradingviewAnalysisConditionEnum,
} from '../../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../../types'

export const H = 3_600_000
/** an hour boundary well in the past */
export const T = 1_700_000_000_000 - (1_700_000_000_000 % H)

export type CaseReference = {
  uuid: string
  interval: ExchangeIntervals
  /** null = the reference indicator is not loaded */
  bars: (() => IndicatorHistory[]) | null
}

export type ConditionCase = {
  id: string
  settings: SettingsIndicators
  /** fresh objects on every call — the engine mutates bar values in place */
  bars: () => IndicatorHistory[]
  /** the interval the condition's local indicator entry runs at */
  interval: ExchangeIntervals
  reference?: CaseReference
}

type Layout = 'one' | 'two' | 'rev' | 'three'

/** clone so null/NaN survive and every call gets fresh objects */
const clone = <V>(v: V): V =>
  v === null || typeof v !== 'object'
    ? v
    : Array.isArray(v)
      ? (v.map(clone) as V)
      : (Object.fromEntries(
          Object.entries(v as object).map(([k, x]) => [k, clone(x)]),
        ) as V)

function series(
  type: string,
  prev: unknown,
  last: unknown,
  layout: Layout = 'two',
  older: unknown = prev,
): () => IndicatorHistory[] {
  return () => {
    const p = { time: T, type, value: clone(prev) }
    const l = { time: T + H, type, value: clone(last) }
    const o = { time: T - H, type, value: clone(older) }
    const out =
      layout === 'one'
        ? [l]
        : layout === 'two'
          ? [p, l]
          : layout === 'rev'
            ? [l, p]
            : [p, o, l]
    return out as unknown as IndicatorHistory[]
  }
}

const base = (
  type: IndicatorEnum,
  extra: Partial<SettingsIndicators> = {},
): SettingsIndicators =>
  ({
    type,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.oneH,
    indicatorLength: 14,
    indicatorValue: '50',
    indicatorCondition: C.gt,
    ...extra,
  }) as SettingsIndicators

const CONDS: (C | undefined)[] = [C.gt, C.lt, C.cu, C.cd, C.bw, undefined]
const fmt = (v: unknown) =>
  v === undefined
    ? 'u'
    : v === null
      ? 'null'
      : typeof v === 'number' && Number.isNaN(v)
        ? 'NaN'
        : typeof v === 'object'
          ? JSON.stringify(v)
          : `${v}`

/** threshold-straddling scalar pool: below, equal, within eps, above, NaN, null */
const POOL = [10, 50, 50 + 1e-11, 90, NaN, null]
const SMALL = [10, 50, 90, NaN]

const PERCENTILE_TYPES = [
  IndicatorEnum.rsi,
  IndicatorEnum.cci,
  IndicatorEnum.ao,
  IndicatorEnum.uo,
  IndicatorEnum.mom,
  IndicatorEnum.wr,
  IndicatorEnum.mfi,
  IndicatorEnum.adx,
  IndicatorEnum.bbw,
  IndicatorEnum.bbpb,
  IndicatorEnum.kcpb,
  IndicatorEnum.vo,
  IndicatorEnum.mar,
]

export function conditionCases(): ConditionCase[] {
  const out: ConditionCase[] = []
  const push = (
    id: string,
    settings: SettingsIndicators,
    bars: () => IndicatorHistory[],
    reference?: CaseReference,
    interval = ExchangeIntervals.oneH,
  ) => out.push({ id, settings, bars, interval, reference })

  // ── value-series oscillators (PercentileResult) ──────────────────────────
  for (const type of PERCENTILE_TYPES) {
    const full = type === IndicatorEnum.rsi
    const pool = full ? POOL : SMALL
    for (const cond of CONDS) {
      const values = full ? ['50', undefined, ''] : ['50']
      const uppers =
        cond === C.bw
          ? full
            ? ['90', '10', '', undefined]
            : ['90']
          : [undefined]
      for (const v of values)
        for (const v2 of uppers)
          for (const a of pool)
            for (const b of pool) {
              const s = base(type, {
                indicatorCondition: cond as C,
                indicatorValue: v as string,
                indicatorValue2: v2,
              })
              push(
                `${type}|${fmt(cond)}|v=${fmt(v)}|v2=${fmt(v2)}|${fmt(a)}>${fmt(b)}`,
                s,
                series(type, { value: a }, { value: b }),
              )
            }
    }
    // single bar, reversed order, three bars
    for (const cond of CONDS)
      for (const layout of ['one', 'rev', 'three'] as Layout[])
        push(
          `${type}|${fmt(cond)}|layout=${layout}`,
          base(type, { indicatorCondition: cond as C, indicatorValue2: '90' }),
          series(type, { value: 10 }, { value: 90 }, layout, { value: 95 }),
        )
    // percentile: thresholds come from the bars' own percentile values
    for (const cond of CONDS)
      for (const [pp, lp] of [
        [40, 60],
        [60, 40],
        [undefined, 60],
        [40, undefined],
        [50, 50],
      ])
        for (const [a, b] of [
          [45, 55],
          [55, 45],
          [50, 50],
        ])
          push(
            `${type}|pct|${fmt(cond)}|p=${fmt(pp)}>${fmt(lp)}|${a}>${b}`,
            base(type, {
              indicatorCondition: cond as C,
              percentile: true,
              indicatorValue2: '90',
            }),
            series(
              type,
              { value: a, percentile: pp },
              { value: b, percentile: lp },
            ),
          )
    // trend filter
    for (const tft of [
      TrendFilterOperatorEnum.lower,
      TrendFilterOperatorEnum.higher,
      TrendFilterOperatorEnum.between,
      undefined,
    ])
      for (const trend of [1, 2, 3, undefined])
        for (const cond of [C.gt, C.lt, C.cu])
          push(
            `${type}|trend|${fmt(tft)}|t=${fmt(trend)}|${cond}`,
            base(type, {
              indicatorCondition: cond,
              trendFilter: true,
              trendFilterType: tft,
            }),
            series(type, { value: 40, trend }, { value: 60, trend }),
          )
  }

  // ── plain-number series ──────────────────────────────────────────────────
  for (const type of [
    IndicatorEnum.bbwp,
    IndicatorEnum.atr,
    IndicatorEnum.adr,
    IndicatorEnum.ath,
    IndicatorEnum.bullBear,
  ]) {
    const values =
      type === IndicatorEnum.ath ? ['70', '-70', undefined, '0'] : ['50']
    for (const cond of CONDS)
      for (const v of values)
        for (const a of type === IndicatorEnum.ath
          ? [-80, -70, -60, NaN]
          : POOL)
          for (const b of type === IndicatorEnum.ath
            ? [-80, -70, -60, NaN]
            : POOL)
            push(
              `${type}|${fmt(cond)}|v=${fmt(v)}|${fmt(a)}>${fmt(b)}`,
              base(type, {
                indicatorCondition: cond as C,
                indicatorValue: v as string,
                indicatorValue2: '90',
              }),
              series(type, a, b),
            )
    for (const layout of ['one', 'rev', 'three'] as Layout[])
      push(
        `${type}|layout=${layout}`,
        base(type, { indicatorCondition: C.cu }),
        series(type, 10, 90, layout, 95),
      )
  }

  // ── MACD (histogram) ─────────────────────────────────────────────────────
  for (const cond of CONDS)
    for (const a of SMALL)
      for (const b of SMALL)
        push(
          `MACD|${fmt(cond)}|${fmt(a)}>${fmt(b)}`,
          base(IndicatorEnum.macd, {
            indicatorCondition: cond as C,
            indicatorValue: '50',
            indicatorValue2: '90',
          }),
          series(
            IndicatorEnum.macd,
            { histogram: a, macd: 1, signal: 2 },
            { histogram: b, macd: 1, signal: 2 },
          ),
        )

  // ── MA vs price ──────────────────────────────────────────────────────────
  const maBar = (ma: unknown, price: unknown, maType = 'ema') => ({
    ma,
    price,
    maType,
  })
  for (const cond of CONDS)
    for (const [pm, pp] of [
      [90, 100],
      [100, 90],
      [100, 100],
      [NaN, 100],
    ])
      for (const [lm, lp] of [
        [90, 100],
        [100, 90],
        [100, 100],
        [100, 100 + 1e-11],
        [null, 100],
      ])
        for (const iv of [undefined, '50'])
          push(
            `MA|price|${fmt(cond)}|iv=${fmt(iv)}|${fmt(pm)},${fmt(pp)}>${fmt(lm)},${fmt(lp)}`,
            base(IndicatorEnum.ma, {
              indicatorCondition: cond as C,
              indicatorValue: iv as string,
              maType: MAEnum.ema,
              maCrossingValue: MAEnum.price,
              indicatorValue2: '200',
            }),
            series(IndicatorEnum.ma, maBar(pm, pp), maBar(lm, lp)),
          )
  for (const layout of ['one', 'rev', 'three'] as Layout[])
    push(
      `MA|price|layout=${layout}`,
      base(IndicatorEnum.ma, {
        indicatorCondition: C.cu,
        maCrossingValue: MAEnum.price,
        maType: MAEnum.ema,
      }),
      series(IndicatorEnum.ma, maBar(90, 100), maBar(110, 100), layout),
    )
  // MA crossing another MA (reference series)
  const refBars =
    (prev: unknown, last: unknown, times: [number, number] = [T, T + H]) =>
    () =>
      [
        {
          time: times[0],
          type: IndicatorEnum.ma,
          value: maBar(prev, 0, 'sma'),
        },
        {
          time: times[1],
          type: IndicatorEnum.ma,
          value: maBar(last, 0, 'sma'),
        },
      ] as unknown as IndicatorHistory[]
  const refs: [string, (() => IndicatorHistory[]) | null, ExchangeIntervals][] =
    [
      ['ref', refBars(100, 100), ExchangeIntervals.oneH],
      ['refUp', refBars(80, 120), ExchangeIntervals.oneH],
      ['refZeroPrev', refBars(0, 100), ExchangeIntervals.oneH],
      ['refZeroBoth', refBars(0, 0), ExchangeIntervals.oneH],
      [
        'refOtherTimes',
        refBars(95, 105, [T - 5 * H, T - 4 * H]),
        ExchangeIntervals.oneH,
      ],
      ['refHigherTf', refBars(100, 100), ExchangeIntervals.fourH],
      ['refLowerTf', refBars(100, 100), ExchangeIntervals.fifteenM],
      ['refEmpty', () => [], ExchangeIntervals.oneH],
      ['refMissing', null, ExchangeIntervals.oneH],
    ]
  for (const cond of CONDS)
    for (const [rid, rb, riv] of refs)
      for (const [pm, lm] of [
        [90, 110],
        [110, 90],
        [100, 100],
      ])
        for (const [maType, crossing] of [
          [MAEnum.ema, MAEnum.sma],
          [MAEnum.sma, MAEnum.sma],
          [undefined, MAEnum.sma],
        ])
          push(
            `MA|cross|${fmt(cond)}|${rid}|mt=${fmt(maType)}|${pm}>${lm}`,
            base(IndicatorEnum.ma, {
              indicatorCondition: cond as C,
              indicatorValue: undefined as unknown as string,
              maType: maType as MAEnum,
              maCrossingValue: crossing as MAEnum,
              maCrossingLength: 50,
              maCrossingInterval: ExchangeIntervals.oneH,
              maUUID: 'maref',
              indicatorValue2: '200',
            }),
            series(IndicatorEnum.ma, maBar(pm, 100), maBar(lm, 100)),
            { uuid: 'maref', interval: riv, bars: rb },
          )

  // ── cross oscillator (XO) ────────────────────────────────────────────────
  const xoRef =
    (prev: unknown, last: unknown, n = 2) =>
    () =>
      [
        { time: T, type: IndicatorEnum.mfi, value: { value: prev } },
        { time: T + H, type: IndicatorEnum.mfi, value: { value: last } },
      ].slice(2 - n) as unknown as IndicatorHistory[]
  for (const cond of CONDS)
    for (const [rid, rb, riv] of [
      ['ref', xoRef(50, 50), ExchangeIntervals.oneH],
      ['refOne', xoRef(50, 50, 1), ExchangeIntervals.oneH],
      ['refHigherTf', xoRef(50, 50), ExchangeIntervals.fourH],
      ['refLowerTf', xoRef(50, 50), ExchangeIntervals.fiveM],
      ['refEmpty', () => [], ExchangeIntervals.oneH],
      ['refMissing', null, ExchangeIntervals.oneH],
    ] as [string, (() => IndicatorHistory[]) | null, ExchangeIntervals][])
      for (const x1 of [IndicatorEnum.rsi, undefined])
        for (const [a, b] of [
          [40, 60],
          [60, 40],
          [50, 50],
        ])
          push(
            `XO|${fmt(cond)}|${rid}|x1=${fmt(x1)}|${a}>${b}`,
            base(IndicatorEnum.xo, {
              indicatorCondition: cond as C,
              xOscillator1: x1 as IndicatorEnum.rsi,
              xOscillator2: IndicatorEnum.mfi,
              xOscillator2Interval: ExchangeIntervals.oneH,
              xOscillator2length: 14,
              xoUUID: 'xoref',
              indicatorValue2: '90',
            }),
            series(IndicatorEnum.rsi, { value: a }, { value: b }),
            { uuid: 'xoref', interval: riv, bars: rb },
          )

  // ── price vs a level: PSAR, BB/KC, DC, SR ────────────────────────────────
  const levelPairs: [number, number, number, number][] = [
    // prevPrice, prevLevel, lastPrice, lastLevel
    [90, 100, 110, 100],
    [110, 100, 90, 100],
    [100, 100, 110, 100],
    [100, 100, 90, 100],
    [110, 100, 110, 100],
    [90, 100, 90, 100],
    [NaN, 100, 110, 100],
    [90, 100, 100 + 1e-11, 100],
  ]
  for (const cond of CONDS)
    for (const [pp, pl, lp, ll] of levelPairs) {
      const tag = `${fmt(cond)}|${fmt(pp)},${pl}>${fmt(lp)},${ll}`
      push(
        `PSAR|${tag}`,
        base(IndicatorEnum.psar, { indicatorCondition: cond as C }),
        series(
          IndicatorEnum.psar,
          { price: pp, psar: pl },
          { price: lp, psar: ll },
        ),
      )
      for (const type of [IndicatorEnum.bb, IndicatorEnum.kc])
        for (const bbc of [
          BBCrossingEnum.lower,
          BBCrossingEnum.middle,
          BBCrossingEnum.upper,
          undefined,
        ]) {
          const band = (price: number, lvl: number) => ({
            price,
            result: {
              lower: bbc === BBCrossingEnum.lower ? lvl : lvl - 50,
              middle: bbc === BBCrossingEnum.middle ? lvl : lvl - 25,
              upper: bbc === BBCrossingEnum.upper || !bbc ? lvl : lvl + 50,
            },
          })
          push(
            `${type}|${fmt(bbc)}|${tag}`,
            base(type, { indicatorCondition: cond as C, bbCrossingValue: bbc }),
            series(type, band(pp, pl), band(lp, ll)),
          )
        }
      for (const dcv of [
        DCValueEnum.lower,
        DCValueEnum.upper,
        DCValueEnum.basis,
        undefined,
      ]) {
        const dc = (price: number, lvl: number) => ({
          price,
          low: dcv === DCValueEnum.lower ? lvl : lvl - 30,
          high: dcv === DCValueEnum.upper ? lvl : lvl + 30,
          basis: dcv === DCValueEnum.basis || !dcv ? lvl : lvl + 1,
        })
        push(
          `DC|${fmt(dcv)}|${tag}`,
          base(IndicatorEnum.dc, {
            indicatorCondition: cond as C,
            dcValue: dcv,
          }),
          series(IndicatorEnum.dc, dc(pp, pl), dc(lp, ll)),
        )
      }
      for (const src of [
        SRCrossingEnum.resistance,
        SRCrossingEnum.support,
        undefined,
      ]) {
        // the engine reads the LAST bar's level for both prev and last
        const sr = (price: number, lvl: number) => ({
          price,
          high: src === SRCrossingEnum.resistance ? lvl : lvl + 40,
          low: src === SRCrossingEnum.resistance ? lvl - 40 : lvl,
        })
        push(
          `SR|${fmt(src)}|${tag}`,
          base(IndicatorEnum.sr, {
            indicatorCondition: cond as C,
            srCrossingValue: src,
          }),
          series(IndicatorEnum.sr, sr(pp, pl + 3), sr(lp, ll)),
        )
      }
    }

  // ── Stoch / StochRSI ─────────────────────────────────────────────────────
  for (const type of [IndicatorEnum.stoch, IndicatorEnum.stochRSI])
    for (const cond of CONDS)
      for (const rv of [rsiValueEnum.k, rsiValueEnum.d, undefined])
        for (const rv2 of [
          rsiValue2Enum.d,
          rsiValue2Enum.k,
          rsiValue2Enum.custom,
          undefined,
        ])
          for (const range of [
            StochRangeEnum.none,
            StochRangeEnum.lower,
            StochRangeEnum.upper,
            StochRangeEnum.both,
            undefined,
          ])
            for (const [pk, pd, lk, ld] of [
              [10, 15, 20, 12],
              [90, 85, 80, 88],
              [50, 40, 40, 50],
              [15, 15, 15, 15],
            ])
              push(
                `${type}|${fmt(cond)}|${fmt(rv)}|${fmt(rv2)}|${fmt(range)}|${pk},${pd}>${lk},${ld}`,
                base(type, {
                  indicatorCondition: cond as C,
                  rsiValue: rv,
                  rsiValue2: rv2,
                  valueInsteadof: 30,
                  stochRange: range,
                  stochUpper: '80',
                  stochLower: '20',
                  indicatorValue2: '90',
                }),
                series(
                  type,
                  { stochK: pk, stochD: pd },
                  { stochK: lk, stochD: ld },
                ),
              )

  // ── Prior pivots ─────────────────────────────────────────────────────────
  const lines = (o: Partial<Record<string, unknown>>) => ({
    hh: 100,
    hl: 90,
    ll: 80,
    lh: 95,
    sl: 1,
    wl: 1,
    sh: 1,
    wh: 1,
    ...o,
  })
  const ppBar = (price: number, o: Partial<Record<string, unknown>> = {}) => ({
    ...lines(o),
    all: lines({}),
    price,
    sBullBoS: false,
    sBearBoS: false,
    sBullCHoCH: false,
    sBearCHoCH: false,
    iBullBoS: false,
    iBullCHoCH: false,
    iBearBoS: false,
    iBearCHoCH: false,
    market: null,
    ...o,
  })
  const ppPriceValues = [
    ppValueEnum.hh,
    ppValueEnum.hl,
    ppValueEnum.ll,
    ppValueEnum.lh,
    ppValueEnum.anyH,
    ppValueEnum.anyL,
    undefined,
  ]
  for (const ppType of [ppValueTypeEnum.price, undefined])
    for (const ppValue of ppPriceValues)
      for (const cond of CONDS)
        for (const [pp, po, lp, lo] of [
          [85, {}, 105, {}],
          [105, {}, 85, {}],
          [96, { hh: null }, 94, { hh: null }],
          [79, { ll: null }, 81, { ll: null }],
          [85, { hh: null, lh: null }, 105, {}],
        ] as [
          number,
          Record<string, unknown>,
          number,
          Record<string, unknown>,
        ][])
          push(
            `PP|${fmt(ppType)}|${fmt(ppValue)}|${fmt(cond)}|${pp}${fmt(po)}>${lp}${fmt(lo)}`,
            base(IndicatorEnum.pp, {
              indicatorCondition: cond as C,
              ppType,
              ppValue,
            }),
            series(IndicatorEnum.pp, ppBar(pp, po), ppBar(lp, lo)),
          )
  const events = [
    'sBullCHoCH',
    'sBearCHoCH',
    'sBullBoS',
    'sBearBoS',
    'iBullCHoCH',
    'iBearCHoCH',
    'iBullBoS',
    'iBearBoS',
  ]
  for (const ppValue of Object.values(ppValueEnum))
    for (const ev of [...events, 'none']) {
      push(
        `PP|event|${ppValue}|${ev}`,
        base(IndicatorEnum.pp, {
          indicatorCondition: C.gt,
          ppType: ppValueTypeEnum.event,
          ppValue,
        }),
        series(
          IndicatorEnum.pp,
          ppBar(90),
          ppBar(90, ev === 'none' ? {} : { [ev]: true }),
        ),
      )
    }
  for (const ppValue of [
    ppValueEnum.bullMarket,
    ppValueEnum.bearMarket,
    ppValueEnum.hh,
  ])
    for (const market of ['bull', 'bear', null])
      for (const cond of [C.gt, undefined])
        push(
          `PP|market|${ppValue}|${fmt(market)}|${fmt(cond)}`,
          base(IndicatorEnum.pp, {
            indicatorCondition: cond as C,
            ppType: ppValueTypeEnum.market,
            ppValue,
          }),
          series(IndicatorEnum.pp, ppBar(90), ppBar(90, { market })),
        )
  push(
    'PP|layout=one',
    base(IndicatorEnum.pp, {
      ppType: ppValueTypeEnum.price,
      ppValue: ppValueEnum.hh,
    }),
    series(IndicatorEnum.pp, ppBar(85), ppBar(105), 'one'),
  )

  // ── OBFVG ────────────────────────────────────────────────────────────────
  const fvg = (price: number, bull: number | null, bear: number | null) => ({
    bullishFVGHigh: bull === null ? null : bull + 5,
    bullishFVGLow: bull === null ? null : bull - 5,
    bullishFVGMiddle: bull,
    bearishFVGHigh: bear === null ? null : bear + 5,
    bearishFVGLow: bear === null ? null : bear - 5,
    bearishFVGMiddle: bear,
    price,
  })
  for (const cond of CONDS)
    for (const ref of [
      OBFVGRefEnum.high,
      OBFVGRefEnum.low,
      OBFVGRefEnum.middle,
      undefined,
    ])
      for (const val of [
        OBFVGValueEnum.bullish,
        OBFVGValueEnum.bearish,
        OBFVGValueEnum.any,
        undefined,
      ])
        for (const [pp, lp, bull, bear] of [
          [90, 110, 100, 200],
          [110, 90, 100, 200],
          [190, 210, 100, 200],
          [210, 190, 100, 200],
          [100, 110, 100, null],
          [90, 110, null, null],
          [150, 150, 100, 200],
        ] as [number, number, number | null, number | null][])
          push(
            `OBFVG|${fmt(cond)}|${fmt(ref)}|${fmt(val)}|${pp}>${lp}|${fmt(bull)},${fmt(bear)}`,
            base(IndicatorEnum.obfvg, {
              indicatorCondition: cond as C,
              obfvgRef: ref,
              obfvgValue: val,
            }),
            series(
              IndicatorEnum.obfvg,
              fvg(pp, bull, bear),
              fvg(lp, bull, bear),
            ),
          )
  push(
    'OBFVG|layout=one',
    base(IndicatorEnum.obfvg, { indicatorCondition: C.gt }),
    series(IndicatorEnum.obfvg, fvg(90, 100, 200), fvg(110, 100, 200), 'one'),
  )

  // ── price change ─────────────────────────────────────────────────────────
  for (const pcValue of ['5', '-5', '0', undefined, 'x'])
    for (const [up, down] of [
      [true, false],
      [false, true],
      [false, false],
      [true, true],
    ])
      for (const layout of ['two', 'one'] as Layout[])
        push(
          `PC|${fmt(pcValue)}|${up},${down}|${layout}`,
          base(IndicatorEnum.pc, { pcValue }),
          series(
            IndicatorEnum.pc,
            { up: false, down: false },
            { up, down },
            layout,
          ),
        )

  // ── long wick ────────────────────────────────────────────────────────────
  for (const lwValue of [
    LWValueEnum.top,
    LWValueEnum.bottom,
    LWValueEnum.any,
    undefined,
  ])
    for (const lwCondition of [
      LWConditionEnum.during,
      LWConditionEnum.onStart,
      undefined,
    ])
      for (const [pb, pr, lb, lr] of [
        [null, null, 1, null],
        [1, null, 1, null],
        [null, null, null, 1],
        [null, 1, null, 1],
        [null, null, null, null],
      ])
        for (const layout of ['two', 'one'] as Layout[])
          push(
            `LW|${fmt(lwValue)}|${fmt(lwCondition)}|${fmt(pb)},${fmt(pr)}>${fmt(lb)},${fmt(lr)}|${layout}`,
            base(IndicatorEnum.lw, { lwValue, lwCondition }),
            series(
              IndicatorEnum.lw,
              { bull: pb, bear: pr, price: 1 },
              { bull: lb, bear: lr, price: 1 },
              layout,
            ),
          )

  // ── SuperTrend ───────────────────────────────────────────────────────────
  for (const st of [
    STConditionEnum.up,
    STConditionEnum.down,
    STConditionEnum.upToDown,
    STConditionEnum.downToUp,
    undefined,
  ])
    for (const [pd, ld] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ])
      for (const layout of ['two', 'one'] as Layout[])
        push(
          `ST|${fmt(st)}|${pd}>${ld}|${layout}`,
          base(IndicatorEnum.st, { stCondition: st }),
          series(
            IndicatorEnum.st,
            { direction: pd, value: 1, all: { up: 1, down: 1 } },
            { direction: ld, value: 2, all: { up: 1, down: 1 } },
            layout,
          ),
        )

  // ── divergences ──────────────────────────────────────────────────────────
  for (const divType of [...Object.values(DivTypeEnum), undefined])
    for (const divMinCount of [2, 1, undefined])
      for (const r of [
        [2, 0, 0, 0],
        [0, 2, 0, 0],
        [0, 0, 2, 0],
        [0, 0, 0, 2],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
      ])
        push(
          `DIV|${fmt(divType)}|${fmt(divMinCount)}|${r.join(',')}`,
          base(IndicatorEnum.div, { divType, divMinCount }),
          series(
            IndicatorEnum.div,
            {
              negdivergence: 0,
              negdivergencehidden: 0,
              posdivergence: 0,
              posdivergencehidden: 0,
            },
            {
              negdivergence: r[0],
              negdivergencehidden: r[1],
              posdivergence: r[2],
              posdivergencehidden: r[3],
            },
            'one',
          ),
        )

  // ── QFL ──────────────────────────────────────────────────────────────────
  for (const action of [true, false])
    for (const layout of ['two', 'one'] as Layout[])
      push(
        `QFL|${action}|${layout}`,
        base(IndicatorEnum.qfl),
        series(
          IndicatorEnum.qfl,
          { action: false, base: 1 },
          { action, base: 1 },
          layout,
        ),
      )

  // ── TradingView technical analysis ───────────────────────────────────────
  for (const signal of [
    ...Object.values(TradingviewAnalysisSignalEnum),
    undefined,
  ])
    for (const checkLevel of [1, 0, undefined])
      for (const tv of [0, 1, 2, 3, 4, 5])
        push(
          `TV|${fmt(signal)}|${fmt(checkLevel)}|${tv}`,
          base(IndicatorEnum.tv, { signal, checkLevel }),
          series(IndicatorEnum.tv, 0, tv),
        )

  // ── engulfing candle ─────────────────────────────────────────────────────
  for (const trig of [...Object.values(ECDTriggerEnum), undefined])
    for (const ecd of [0, 1, 2])
      for (const layout of ['two', 'one'] as Layout[])
        push(
          `ECD|${fmt(trig)}|${ecd}|${layout}`,
          base(IndicatorEnum.ecd, { ecdTrigger: trig }),
          series(IndicatorEnum.ecd, 0, ecd, layout),
        )

  // ── Ichimoku (no comparison defined: compares 0 with the value) ──────────
  for (const cond of CONDS)
    push(
      `IC|${fmt(cond)}`,
      base(IndicatorEnum.ic, {
        indicatorCondition: cond as C,
        indicatorValue: '-1',
      }),
      series(
        IndicatorEnum.ic,
        {
          conversionLine: 1,
          baseLine: 1,
          price: 1,
          leadLine1: 1,
          leadLine2: 1,
        },
        {
          conversionLine: 2,
          baseLine: 2,
          price: 2,
          leadLine1: 2,
          leadLine2: 2,
        },
      ),
    )

  // ── bars whose type does not match the condition's type ──────────────────
  for (const cond of CONDS)
    for (const [type, barType] of [
      [IndicatorEnum.rsi, IndicatorEnum.ma],
      [IndicatorEnum.ma, IndicatorEnum.rsi],
      [IndicatorEnum.bb, IndicatorEnum.kc],
      [IndicatorEnum.stoch, IndicatorEnum.stochRSI],
    ] as [IndicatorEnum, IndicatorEnum][])
      push(
        `mismatch|${type}<-${barType}|${fmt(cond)}`,
        base(type, {
          indicatorCondition: cond as C,
          indicatorValue: '-1',
          maCrossingValue: MAEnum.price,
          maType: MAEnum.ema,
        }),
        series(
          barType,
          {
            value: 10,
            ma: 10,
            price: 20,
            maType: 'ema',
            result: { lower: 1, middle: 2, upper: 3 },
            stochK: 1,
            stochD: 2,
          },
          {
            value: 30,
            ma: 30,
            price: 20,
            maType: 'ema',
            result: { lower: 1, middle: 2, upper: 3 },
            stochK: 3,
            stochD: 2,
          },
        ),
      )
  // previous bar of another type
  push(
    'mixed|rsi-prev-ma',
    base(IndicatorEnum.rsi, { indicatorCondition: C.gt, indicatorValue: '-1' }),
    () =>
      [
        { time: T, type: IndicatorEnum.ma, value: maBar(1, 2) },
        { time: T + H, type: IndicatorEnum.rsi, value: { value: 60 } },
      ] as unknown as IndicatorHistory[],
  )

  // ── OTE levels (appended; leg 100 -> 120, its 0.5 level is 110) ─────────
  const oteBar = (price: number | null, direction: number | null, high = 120) =>
    ({ high, low: 100, direction, price }) as unknown
  for (const oteLeg of [
    OTELegEnum.bullish,
    OTELegEnum.bearish,
    OTELegEnum.any,
    undefined,
  ])
    for (const indicatorCondition of [C.cd, C.cu, C.gt, C.lt, undefined])
      for (const oteLevel of ['0.5', undefined])
        for (const [pp, lp, dir, prevHigh] of [
          [112, 108, 1, 120],
          [108, 112, 1, 120],
          [112, 110, 1, 120],
          [108, 110, -1, 120],
          [112, 108, 1, 130],
          [112, 108, null, 120],
          [112, null, 1, 120],
        ] as [number, number | null, number | null, number][])
          for (const layout of ['two', 'one'] as Layout[])
            push(
              `OTE|${fmt(oteLeg)}|${fmt(indicatorCondition)}|${fmt(oteLevel)}|${pp}>${fmt(lp)}|${fmt(dir)}|${prevHigh}|${layout}`,
              base(IndicatorEnum.ote, { oteLeg, indicatorCondition, oteLevel }),
              series(
                IndicatorEnum.ote,
                oteBar(pp, dir, prevHigh),
                oteBar(lp, dir),
                layout,
              ),
            )

  // ── Session Price levels (appended) ──────────────────────────────────────
  // previous session 100..120 (open 105, close 115, mid 110), current open 108
  const sessionBar = (
    price: number | null,
    o: {
      inSession?: number
      key?: number | null
      prevKey?: number | null
    } = {},
  ) =>
    ({
      prevOpen: o.prevKey === null ? null : 105,
      prevHigh: o.prevKey === null ? null : 120,
      prevMid: o.prevKey === null ? null : 110,
      prevLow: o.prevKey === null ? null : 100,
      prevClose: o.prevKey === null ? null : 115,
      curOpen: (o.inSession ?? 1) === 1 ? 108 : null,
      price,
      inSession: o.inSession ?? 1,
      sessionKey:
        (o.inSession ?? 1) === 1
          ? o.key === undefined
            ? 20231115
            : o.key
          : null,
      prevSessionKey: o.prevKey === undefined ? 20231114 : o.prevKey,
    }) as unknown
  const levels = (
    sessionLevelA: SessionLevelEnum | undefined,
    sessionLevelB: SessionLevelEnum | undefined,
    indicatorCondition: C | undefined,
  ) =>
    base(IndicatorEnum.session, {
      sessionRule: SessionRuleEnum.levels,
      sessionDays: [1, 2, 3, 4, 5],
      sessionLevelA,
      sessionLevelB,
      indicatorCondition,
    })
  for (const [a, b] of [
    [SessionLevelEnum.price, SessionLevelEnum.prevHigh],
    [SessionLevelEnum.price, SessionLevelEnum.prevMid],
    [SessionLevelEnum.price, SessionLevelEnum.curOpen],
    [SessionLevelEnum.prevLow, SessionLevelEnum.price],
    [SessionLevelEnum.price, SessionLevelEnum.price],
    [undefined, undefined],
    ['lastHigh' as SessionLevelEnum, SessionLevelEnum.prevHigh],
  ] as (SessionLevelEnum | undefined)[][])
    for (const cond of [C.cd, C.cu, C.gt, C.lt, C.bw, undefined])
      for (const [pp, lp] of [
        [118, 122],
        [122, 118],
        [118, 120],
        [109, 111],
        [111, 109],
        [118, null],
      ] as (number | null)[][])
        for (const layout of ['two', 'one'] as Layout[])
          push(
            `SESSION|levels|${fmt(a)}|${fmt(b)}|${fmt(cond)}|${fmt(pp)}>${fmt(lp)}|${layout}`,
            levels(a, b, cond),
            series(
              IndicatorEnum.session,
              sessionBar(pp),
              sessionBar(lp),
              layout,
            ),
          )
  // session boundaries: out of session, a new session, a new previous
  // session, no previous session yet
  for (const cond of [C.cu, C.gt])
    for (const [label, prevOpts, lastOpts] of [
      ['out', {}, { inSession: 0 }],
      ['prevOut', { inSession: 0 }, {}],
      ['newSession', { key: 20231114 }, {}],
      ['newPrev', { prevKey: 20231113 }, {}],
      ['noPrevBoth', { prevKey: null }, { prevKey: null }],
      ['noPrevLast', {}, { prevKey: null }],
    ] as [
      string,
      Parameters<typeof sessionBar>[1],
      Parameters<typeof sessionBar>[1],
    ][])
      push(
        `SESSION|levels|boundary|${label}|${fmt(cond)}`,
        levels(SessionLevelEnum.price, SessionLevelEnum.prevHigh, cond),
        series(
          IndicatorEnum.session,
          sessionBar(118, prevOpts),
          sessionBar(122, lastOpts),
        ),
      )

  // ── Session current session midpoint (appended) ──────────────────────────
  // curMid moves with the session's running high/low; none outside a session
  const midBar = (
    price: number | null,
    curMid: number | null,
    o: Parameters<typeof sessionBar>[1] = {},
  ) => ({
    ...(sessionBar(price, o) as object),
    curMid: (o.inSession ?? 1) === 1 ? curMid : null,
  })
  // [prev price, prev curMid, last price, last curMid]
  const MID_PAIRS: (number | null)[][] = [
    [118, 119, 122, 120], // price crosses up a rising midpoint
    [122, 120, 118, 121], // price crosses down
    [118, 117, 118, 119], // the midpoint rises through a flat price
    [118, 119, 118, 117], // the midpoint falls through a flat price
    [118, 119, 120, 120], // touching on the latest bar
    [118, 119, 122, null], // no midpoint on the latest bar
    [null, 119, 122, 120], // no price on the previous bar
  ]
  for (const [a, b] of [
    [SessionLevelEnum.price, SessionLevelEnum.curMid],
    [SessionLevelEnum.curMid, SessionLevelEnum.price],
    [SessionLevelEnum.curMid, SessionLevelEnum.prevMid],
    [SessionLevelEnum.curMid, SessionLevelEnum.curOpen],
    [SessionLevelEnum.curMid, SessionLevelEnum.curMid],
  ] as SessionLevelEnum[][])
    for (const cond of [C.cd, C.cu, C.gt, C.lt, undefined])
      for (const [pp, pm, lp, lm] of MID_PAIRS)
        for (const layout of ['two', 'one'] as Layout[])
          push(
            `SESSION|levels|mid|${a}|${b}|${fmt(cond)}|${fmt(pp)}/${fmt(pm)}>${fmt(lp)}/${fmt(lm)}|${layout}`,
            levels(a, b, cond),
            series(
              IndicatorEnum.session,
              midBar(pp, pm),
              midBar(lp, lm),
              layout,
            ),
          )
  // a crossing of the midpoint never counts across a rollover
  for (const cond of [C.cu, C.gt])
    for (const [label, prevOpts, lastOpts] of [
      ['out', {}, { inSession: 0 }],
      ['prevOut', { inSession: 0 }, {}],
      ['newSession', { key: 20231114 }, {}],
      ['newPrev', { prevKey: 20231113 }, {}],
      ['noPrevBoth', { prevKey: null }, { prevKey: null }],
    ] as [
      string,
      Parameters<typeof sessionBar>[1],
      Parameters<typeof sessionBar>[1],
    ][])
      push(
        `SESSION|levels|mid|boundary|${label}|${fmt(cond)}`,
        levels(SessionLevelEnum.price, SessionLevelEnum.curMid, cond),
        series(
          IndicatorEnum.session,
          midBar(118, 119, prevOpts),
          midBar(122, 120, lastOpts),
        ),
      )

  // ── VWAP (appended): the close against the VWAP or a band ───────────────
  // vwap 100, stdev 5: upper/lower 105/95 at multiplier 1, 110/90 at 2
  const P0 = T - (T % (24 * H))
  const vwapBar = (
    price: number | null,
    vwap: number | null = 100,
    periodStart: number | null = P0,
  ) =>
    ({
      vwap,
      stdev: 5,
      upper: vwap === null ? null : vwap + 5,
      lower: vwap === null ? null : vwap - 5,
      price,
      periodStart,
    }) as unknown
  for (const vwapLine of [
    VWAPLineEnum.vwap,
    VWAPLineEnum.upper,
    VWAPLineEnum.lower,
    undefined,
  ])
    for (const vwapBandMultiplier of [2, undefined])
      for (const indicatorCondition of [
        C.cd,
        C.cu,
        C.gt,
        C.lt,
        C.bw,
        undefined,
      ])
        for (const [pp, lp] of [
          [98, 102],
          [102, 98],
          [100, 102],
          [108, 112],
          [112, 108],
          [92, 88],
          [88, 92],
          [null, 102],
        ] as [number | null, number | null][])
          for (const layout of ['two', 'one'] as Layout[])
            push(
              `VWAP|${fmt(vwapLine)}|m=${fmt(vwapBandMultiplier)}|${fmt(indicatorCondition)}|${fmt(pp)}>${fmt(lp)}|${layout}`,
              base(IndicatorEnum.vwap, {
                vwapLine,
                vwapBandMultiplier,
                indicatorCondition: indicatorCondition as C,
              }),
              series(IndicatorEnum.vwap, vwapBar(pp), vwapBar(lp), layout),
            )
  // a crossing never counts across the anchor restart; no volume yet = NaN
  for (const indicatorCondition of [C.cu, C.gt])
    for (const [label, prevBar, lastBar] of [
      ['newPeriod', vwapBar(98), vwapBar(102, 100, P0 + 24 * H)],
      ['noVolume', vwapBar(98), vwapBar(102, null)],
      ['noPeriod', vwapBar(98, 100, null), vwapBar(102, 100, null)],
    ] as [string, unknown, unknown][])
      push(
        `VWAP|boundary|${label}|${indicatorCondition}`,
        base(IndicatorEnum.vwap, { indicatorCondition }),
        series(IndicatorEnum.vwap, prevBar, lastBar),
      )

  // ── KDJ (appended): a line vs a line or the level, Stochastic's zone ────
  const kdjBar = (k: number | null, d: number | null, j: number | null) =>
    ({ k, d, j }) as unknown
  for (const kdjLine of [
    KDJLineEnum.k,
    KDJLineEnum.d,
    KDJLineEnum.j,
    undefined,
  ])
    for (const kdjCompareTo of [
      KDJCompareToEnum.k,
      KDJCompareToEnum.d,
      KDJCompareToEnum.j,
      KDJCompareToEnum.custom,
      undefined,
    ])
      for (const indicatorCondition of [C.cd, C.cu, C.gt, C.lt, undefined])
        for (const [prev, last] of [
          [kdjBar(10, 15, 0), kdjBar(18, 15, 24)],
          [kdjBar(90, 85, 100), kdjBar(82, 85, 76)],
          [kdjBar(50, 50, 50), kdjBar(55, 50, 65)],
          [kdjBar(10, 15, null), kdjBar(18, null, 24)],
        ] as [unknown, unknown][])
          push(
            `KDJ|${fmt(kdjLine)}|${fmt(kdjCompareTo)}|${fmt(indicatorCondition)}|${JSON.stringify(prev)}>${JSON.stringify(last)}`,
            base(IndicatorEnum.kdj, {
              kdjLine,
              kdjCompareTo,
              indicatorCondition: indicatorCondition as C,
              indicatorValue: '20',
            }),
            series(IndicatorEnum.kdj, prev, last),
          )
  // zones, as stored by the Stochastic form (missing range = no zone)
  for (const stochRange of [
    StochRangeEnum.none,
    StochRangeEnum.lower,
    StochRangeEnum.upper,
    StochRangeEnum.both,
    undefined,
  ])
    for (const [stochUpper, stochLower] of [
      ['80', '20'],
      ['', '20'],
    ])
      for (const [prev, last] of [
        [kdjBar(10, 15, 0), kdjBar(18, 15, 24)],
        [kdjBar(5, 12, -9), kdjBar(14, 12, 18)],
        [kdjBar(82, 88, 70), kdjBar(90, 88, 94)],
      ] as [unknown, unknown][])
        for (const layout of ['two', 'one'] as Layout[])
          push(
            `KDJ|zone|${fmt(stochRange)}|${stochUpper}/${stochLower}|${JSON.stringify(prev)}>${JSON.stringify(last)}|${layout}`,
            base(IndicatorEnum.kdj, {
              indicatorCondition: C.cu,
              stochRange,
              stochUpper,
              stochLower,
            }),
            series(IndicatorEnum.kdj, prev, last, layout),
          )

  // ── ADX DMI mode (appended): +DI against −DI, indicatorValue unread ─────
  const dmiBar = (value: number, pdi: number | null, mdi: number | null) =>
    ({ value, pdi, mdi }) as unknown
  for (const adxMode of [ADXModeEnum.dmi, ADXModeEnum.adx])
    for (const indicatorCondition of [C.cd, C.cu, C.gt, C.lt, C.bw, undefined])
      for (const [prev, last] of [
        [dmiBar(10, 18, 22), dmiBar(30, 24, 20)],
        [dmiBar(30, 24, 20), dmiBar(10, 18, 22)],
        [dmiBar(30, 20, 20), dmiBar(10, 24, 20)],
        [dmiBar(30, 24, 20), dmiBar(60, 25, 20)],
        [dmiBar(30, null, 20), dmiBar(60, 25, 20)],
      ] as [unknown, unknown][])
        for (const layout of ['two', 'one'] as Layout[])
          push(
            `ADX|mode=${adxMode}|${fmt(indicatorCondition)}|${JSON.stringify(prev)}>${JSON.stringify(last)}|${layout}`,
            base(IndicatorEnum.adx, {
              adxMode,
              indicatorCondition: indicatorCondition as C,
              indicatorValue2: '90',
            }),
            series(IndicatorEnum.adx, prev, last, layout),
          )

  // ── Moving Average trend filter (appended): comparison AND trend gate ────
  for (const trendFilterType of [
    TrendFilterOperatorEnum.lower,
    TrendFilterOperatorEnum.higher,
    TrendFilterOperatorEnum.between,
    undefined,
  ])
    for (const trend of [0, 1, 2, 3, undefined])
      for (const indicatorCondition of [C.gt, C.lt, C.cu, C.cd])
        push(
          `MA|trend|${fmt(trendFilterType)}|t=${fmt(trend)}|${indicatorCondition}`,
          base(IndicatorEnum.ma, {
            indicatorCondition,
            maType: MAEnum.ema,
            maCrossingValue: MAEnum.price,
            trendFilter: true,
            trendFilterLookback: 10,
            trendFilterType,
            trendFilterValue: 1,
          }),
          series(
            IndicatorEnum.ma,
            { ...maBar(90, 100), trend },
            { ...maBar(110, 100), trend },
          ),
        )
  // the filter off: the stored trend settings are not read
  for (const trendFilter of [false, undefined])
    push(
      `MA|trend|off=${fmt(trendFilter)}`,
      base(IndicatorEnum.ma, {
        indicatorCondition: C.cu,
        maType: MAEnum.ema,
        maCrossingValue: MAEnum.price,
        trendFilter,
        trendFilterType: TrendFilterOperatorEnum.higher,
      }),
      series(IndicatorEnum.ma, maBar(90, 100), maBar(110, 100)),
    )
  // a leftover trend filter on VWAP, KDJ or DMI keeps the condition false
  for (const [label, type, extra, prev, last] of [
    ['VWAP', IndicatorEnum.vwap, {}, vwapBar(98), vwapBar(102)],
    ['KDJ', IndicatorEnum.kdj, {}, kdjBar(10, 15, 0), kdjBar(18, 15, 24)],
    [
      'DMI',
      IndicatorEnum.adx,
      { adxMode: ADXModeEnum.dmi },
      dmiBar(10, 18, 22),
      dmiBar(30, 24, 20),
    ],
  ] as [string, IndicatorEnum, Partial<SettingsIndicators>, unknown, unknown][])
    for (const trendFilter of [true, false])
      push(
        `${label}|leftoverTrendFilter=${trendFilter}`,
        base(type, {
          ...extra,
          indicatorCondition: C.cu,
          trendFilter,
          trendFilterType: TrendFilterOperatorEnum.higher,
        }),
        series(type, prev, last),
      )

  // ── Candle colour (appended): N candles of a colour in a row ────────────
  const candleBar = (color: number | null, streak: number | null) =>
    ({ color, streak, open: 1, high: 2, low: 0.5, close: 1.5 }) as unknown
  for (const candleColor of [
    CandleColorEnum.green,
    CandleColorEnum.red,
    undefined,
  ])
    for (const candleTrigger of [
      CandleTriggerEnum.streak,
      CandleTriggerEnum.start,
      undefined,
    ])
      for (const candleCount of [1, 3, '3', 0, undefined] as (
        | number
        | undefined
      )[])
        for (const [color, streak] of [
          [1, 3],
          [1, 2],
          [1, 4],
          [-1, -3],
          [-1, -1],
          [0, 0],
          [1, -3],
          [null, null],
        ] as (number | null)[][])
          for (const layout of ['two', 'one'] as Layout[])
            push(
              `CANDLE|${fmt(candleColor)}|${fmt(candleTrigger)}|n=${fmt(candleCount)}|${fmt(color)}/${fmt(streak)}|${layout}`,
              base(IndicatorEnum.candle, {
                candleColor,
                candleTrigger,
                candleCount,
              }),
              series(
                IndicatorEnum.candle,
                candleBar(0, 0),
                candleBar(color, streak),
                layout,
              ),
            )

  // ── Order Blocks (appended): the close against a block level ────────────
  // bullish block 100..110 (middle 105, id 1), bearish block 104..116
  // (middle 110, id 2)
  const obBar = (
    price: number | null,
    o: { bullId?: number | null; bearId?: number | null } = {},
  ) =>
    ({
      bullishTop: o.bullId === null ? null : 110,
      bullishBottom: o.bullId === null ? null : 100,
      bullishId: o.bullId === undefined ? 1 : o.bullId,
      bearishTop: o.bearId === null ? null : 116,
      bearishBottom: o.bearId === null ? null : 104,
      bearishId: o.bearId === undefined ? 2 : o.bearId,
      price,
    }) as unknown
  for (const obSide of [OBSideEnum.bullish, OBSideEnum.bearish, undefined])
    for (const obLevel of [
      OBLevelEnum.top,
      OBLevelEnum.middle,
      OBLevelEnum.bottom,
      undefined,
    ])
      for (const indicatorCondition of [
        C.cd,
        C.cu,
        C.gt,
        C.lt,
        C.bw,
        undefined,
      ])
        for (const [pp, lp] of [
          [112, 108],
          [108, 112],
          [104, 106],
          [106, 104],
          [98, 101],
          [101, 98],
          [118, 114],
          [114, 118],
          [112, 110],
          [110, 110],
          [null, 108],
        ] as (number | null)[][])
          for (const layout of ['two', 'one'] as Layout[])
            push(
              `OB|${fmt(obSide)}|${fmt(obLevel)}|${fmt(indicatorCondition)}|${fmt(pp)}>${fmt(lp)}|${layout}`,
              base(IndicatorEnum.ob, {
                obSide,
                obLevel,
                indicatorCondition: indicatorCondition as C,
              }),
              series(IndicatorEnum.ob, obBar(pp), obBar(lp), layout),
            )
  // a new block is never a crossing; no active block = false
  for (const indicatorCondition of [C.cd, C.cu, C.gt, C.lt])
    for (const [label, prevOpts, lastOpts] of [
      ['newBull', { bullId: 0 }, {}],
      ['newBear', { bearId: 0 }, {}],
      ['noBlockLast', {}, { bullId: null, bearId: null }],
      ['noBlockPrev', { bullId: null, bearId: null }, {}],
    ] as [string, Parameters<typeof obBar>[1], Parameters<typeof obBar>[1]][])
      for (const obSide of [OBSideEnum.bullish, OBSideEnum.bearish])
        push(
          `OB|boundary|${label}|${obSide}|${indicatorCondition}`,
          base(IndicatorEnum.ob, { obSide, indicatorCondition }),
          series(
            IndicatorEnum.ob,
            obBar(indicatorCondition === C.cu ? 108 : 118, prevOpts),
            obBar(indicatorCondition === C.cu ? 118 : 108, lastOpts),
          ),
        )

  // ── Squeeze Momentum (appended): squeeze state AND momentum ─────────────
  const sqzBar = (squeeze: number | null, momentum: number | null) =>
    ({ squeeze, momentum }) as unknown
  for (const sqzSignal of [
    SqzSignalEnum.fired,
    SqzSignalEnum.on,
    SqzSignalEnum.off,
    SqzSignalEnum.any,
    undefined,
  ])
    for (const sqzMomentum of [
      SqzMomentumEnum.positive,
      SqzMomentumEnum.negative,
      SqzMomentumEnum.rising,
      SqzMomentumEnum.falling,
      SqzMomentumEnum.crossUp,
      SqzMomentumEnum.crossDown,
      SqzMomentumEnum.any,
      undefined,
    ])
      for (const [ps, ls, pm, lm] of [
        [1, -1, -2, 3],
        [1, 1, 2, 1],
        [-1, -1, 1, -2],
        [1, 0, 0, 0],
        [0, 1, 5, 5],
        [1, -1, null, 3],
        [null, -1, -2, 3],
      ] as (number | null)[][])
        for (const layout of ['two', 'one'] as Layout[])
          push(
            `SQZ|${fmt(sqzSignal)}|${fmt(sqzMomentum)}|${fmt(ps)}/${fmt(pm)}>${fmt(ls)}/${fmt(lm)}|${layout}`,
            base(IndicatorEnum.sqz, { sqzSignal, sqzMomentum }),
            series(IndicatorEnum.sqz, sqzBar(ps, pm), sqzBar(ls, lm), layout),
          )

  // ── Divergence pivots (appended; new settings on an existing type): the
  // decision reads the DIV result only, so pivots never change it ─────────
  for (const pivots of [
    { divPivotLeft: 5, divPivotRight: 2, divRangeLower: 5, divRangeUpper: 30 },
    { divPivotLeft: '5', divRangeUpper: '' },
  ] as Partial<SettingsIndicators>[])
    for (const r of [
      [2, 0, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 0],
    ])
      push(
        `DIV|pivots|${JSON.stringify(pivots)}|${r.join(',')}`,
        base(IndicatorEnum.div, {
          divType: DivTypeEnum.abear,
          divMinCount: 2,
          ...pivots,
        }),
        series(
          IndicatorEnum.div,
          {
            negdivergence: 0,
            negdivergencehidden: 0,
            posdivergence: 0,
            posdivergencehidden: 0,
          },
          {
            negdivergence: r[0],
            negdivergencehidden: r[1],
            posdivergence: r[2],
            posdivergencehidden: r[3],
          },
          'one',
        ),
      )

  // ── Session Price levels outside the session (appended; a new setting on
  // an existing type): sessionLevelsActive session / outside / always ─────
  for (const sessionLevelsActive of [
    SessionLevelsActiveEnum.session,
    SessionLevelsActiveEnum.outside,
    SessionLevelsActiveEnum.always,
    undefined,
    'Outside' as SessionLevelsActiveEnum,
  ])
    for (const [a, b] of [
      [SessionLevelEnum.price, SessionLevelEnum.prevHigh],
      [SessionLevelEnum.price, SessionLevelEnum.curOpen],
    ] as SessionLevelEnum[][])
      for (const cond of [C.cu, C.cd, C.gt, C.lt])
        for (const [label, prevOpts, lastOpts] of [
          ['in', {}, {}],
          ['out', { inSession: 0 }, { inSession: 0 }],
          ['inToOut', {}, { inSession: 0 }],
          ['outToIn', { inSession: 0 }, {}],
          ['outNewPrev', { inSession: 0, prevKey: 20231113 }, { inSession: 0 }],
          ['outNoPrev', { inSession: 0, prevKey: null }, { inSession: 0 }],
        ] as [
          string,
          Parameters<typeof sessionBar>[1],
          Parameters<typeof sessionBar>[1],
        ][])
          push(
            `SESSION|levels|active=${fmt(sessionLevelsActive)}|${a}|${b}|${cond}|${label}`,
            {
              ...levels(a, b, cond),
              sessionLevelsActive,
            },
            series(
              IndicatorEnum.session,
              sessionBar(cond === C.cu || cond === C.gt ? 118 : 122, prevOpts),
              sessionBar(cond === C.cu || cond === C.gt ? 122 : 118, lastOpts),
            ),
          )

  // a leftover trend filter on Candle colour, Order Blocks or Squeeze
  // Momentum keeps the condition false (as in the backtester)
  for (const [label, type, extra, prev, last] of [
    ['CANDLE', IndicatorEnum.candle, {}, candleBar(1, 1), candleBar(1, 2)],
    [
      'OB',
      IndicatorEnum.ob,
      { indicatorCondition: C.cd },
      obBar(112),
      obBar(108),
    ],
    ['SQZ', IndicatorEnum.sqz, {}, sqzBar(1, 1), sqzBar(-1, 2)],
  ] as [string, IndicatorEnum, Partial<SettingsIndicators>, unknown, unknown][])
    for (const trendFilter of [true, false])
      push(
        `${label}|leftoverTrendFilter=${trendFilter}`,
        base(type, {
          ...extra,
          trendFilter,
          trendFilterType: TrendFilterOperatorEnum.higher,
        }),
        series(type, prev, last),
      )

  // ── Price Change range (appended; a new setting on an existing type):
  // pcCompare gt / lt / bw and pcValue2, on the open→high / open→low move ──
  const pcBar = (upPct: number, downPct: number, t = 2) => ({
    up: upPct > t,
    down: downPct > t,
    upPct,
    downPct,
  })
  for (const pcCompare of [
    undefined,
    null,
    PCCompareEnum.gt,
    PCCompareEnum.lt,
    PCCompareEnum.bw,
    'GT' as PCCompareEnum,
  ])
    for (const [pcValue, pcValue2] of [
      ['2', '5'],
      ['5', '2'],
      ['-2', '-5'],
      ['2', '-5'],
      ['2', undefined],
      [undefined, '2'],
      ['0', '3'],
    ] as (string | undefined)[][])
      for (const [up, down] of [
        [1, 6],
        [2, 0],
        [3.5, 0],
        [5, 1],
        [7, 3.5],
        [0, 2],
        [0, 5],
        [NaN, NaN],
      ])
        push(
          `PC|compare=${fmt(pcCompare)}|${fmt(pcValue)}..${fmt(pcValue2)}|${up},${down}`,
          base(IndicatorEnum.pc, {
            pcValue,
            pcValue2,
            pcCompare: pcCompare as PCCompareEnum,
          }),
          series(IndicatorEnum.pc, pcBar(0, 0), pcBar(up, down)),
        )
  // results without the pct fields (stored before the setting existed)
  for (const pcCompare of [
    undefined,
    PCCompareEnum.gt,
    PCCompareEnum.lt,
    PCCompareEnum.bw,
  ])
    for (const [up, down] of [
      [true, false],
      [false, true],
    ])
      push(
        `PC|compare=${fmt(pcCompare)}|noPct|${up},${down}`,
        base(IndicatorEnum.pc, {
          pcValue: '2',
          pcValue2: '5',
          pcCompare,
        }),
        series(IndicatorEnum.pc, { up: false, down: false }, { up, down }),
      )

  // ── Session Price levels: the first candle after the session (appended;
  // indicators 1.14.0). `prev` is the session's last candle (inside session
  // 20231115, levels of 20231114), `last` the first candle after it: that
  // session is now the previous one, so every prev* level jumped. With
  // outside / always, price vs a prev* level crosses against the level
  // `last` sees; every other pairing, and session / missing, stay false.
  const afterBars = (
    p0: number,
    p1: number,
    completed = true,
  ): [unknown, unknown] => [
    {
      prevOpen: 70,
      prevHigh: 80,
      prevMid: 75,
      prevLow: 70,
      prevClose: 78,
      curOpen: 105,
      price: p0,
      inSession: 1,
      sessionKey: 20231115,
      prevSessionKey: 20231114,
    },
    completed
      ? {
          prevOpen: 105,
          prevHigh: 120,
          prevMid: 110,
          prevLow: 100,
          prevClose: p0,
          curOpen: null,
          price: p1,
          inSession: 0,
          sessionKey: null,
          prevSessionKey: 20231115,
        }
      : {
          // the session was not seen whole: the previous one is unchanged
          prevOpen: 70,
          prevHigh: 80,
          prevMid: 75,
          prevLow: 70,
          prevClose: 78,
          curOpen: null,
          price: p1,
          inSession: 0,
          sessionKey: null,
          prevSessionKey: 20231114,
        },
  ]
  for (const sessionLevelsActive of [
    SessionLevelsActiveEnum.session,
    SessionLevelsActiveEnum.outside,
    SessionLevelsActiveEnum.always,
    undefined,
  ])
    for (const [a, b] of [
      [SessionLevelEnum.price, SessionLevelEnum.prevHigh],
      [SessionLevelEnum.prevHigh, SessionLevelEnum.price],
      [SessionLevelEnum.price, SessionLevelEnum.prevLow],
      [SessionLevelEnum.price, SessionLevelEnum.prevMid],
      [SessionLevelEnum.price, SessionLevelEnum.prevClose],
      [SessionLevelEnum.prevHigh, SessionLevelEnum.prevLow],
      [SessionLevelEnum.price, SessionLevelEnum.curOpen],
    ] as SessionLevelEnum[][])
      for (const cond of [C.cu, C.cd, C.gt, C.lt])
        for (const [label, p0, p1, completed] of [
          ['breakUp', 119, 122, true],
          ['breakDown', 101, 98, true],
          ['crossMid', 108, 112, true],
          ['inside', 109, 111, true],
          ['partialSession', 119, 122, false],
        ] as [string, number, number, boolean][])
          push(
            `SESSION|levels|afterSession|active=${fmt(sessionLevelsActive)}|${a}|${b}|${cond}|${label}`,
            {
              ...levels(a, b, cond),
              sessionLevelsActive,
            },
            series(IndicatorEnum.session, ...afterBars(p0, p1, completed)),
          )

  return out
}

/**
 * Settings fixtures for the SettingsIndicators → indicator-service config
 * builder: per type a minimal object (engine defaults), a full object with
 * every option set, numbers as strings, and zero/empty values (which the
 * `||`-defaulted options replace and the `??`-defaulted ones keep).
 */
export function configCases(): { id: string; settings: SettingsIndicators }[] {
  const out: { id: string; settings: SettingsIndicators }[] = []
  const full: Partial<SettingsIndicators> = {
    indicatorLength: 21,
    checkLevel: 2,
    condition: TradingviewAnalysisConditionEnum.entry,
    maType: MAEnum.sma,
    maCrossingValue: MAEnum.wma,
    maCrossingLength: 55,
    maCrossingInterval: ExchangeIntervals.fourH,
    maUUID: 'maref',
    stochSmoothK: 4,
    stochSmoothD: 5,
    stochRSI: 16,
    leftBars: 7,
    rightBars: 8,
    basePeriods: 40,
    pumpPeriods: 9,
    pump: 4,
    baseCrack: 5,
    psarStart: 0.03,
    psarInc: 0.04,
    psarMax: 0.3,
    voShort: 6,
    voLong: 12,
    uoFast: 8,
    uoMiddle: 15,
    uoSlow: 30,
    momSource: 'hl2',
    bbwpLookback: 200,
    xOscillator1: IndicatorEnum.cci,
    xOscillator2: IndicatorEnum.rsi,
    xOscillator2length: 9,
    xOscillator2Interval: ExchangeIntervals.fourH,
    xOscillator2voLong: 20,
    xOscillator2voShort: 7,
    xoUUID: 'xoref',
    mar1length: 25,
    mar1type: MAEnum.wma,
    mar2length: 30,
    mar2type: MAEnum.sma,
    bbwMult: 3,
    bbwMa: MAEnum.ema,
    bbwMaLength: 25,
    macdFast: 10,
    macdSlow: 30,
    macdMaSource: MAEnum.sma,
    macdMaSignal: MAEnum.sma,
    divOscillators: [IndicatorEnum.rsi, IndicatorEnum.macd],
    factor: 4,
    atrLength: 12,
    pcValue: '-7',
    ppHighLeft: 6,
    ppHighRight: 7,
    ppLowLeft: 8,
    ppLowRight: 9,
    ppMult: 2,
    athLookback: 120,
    kcMa: MAEnum.sma,
    kcRange: RangeType.tr,
    kcRangeLength: 25,
    lwThreshold: '3',
    lwMaxDuration: '500',
    oteLeftBars: '7',
    oteMinLegSize: '2.5',
    percentile: true,
    percentileLookback: 100,
    percentilePercentage: 70,
    trendFilter: true,
    trendFilterLookback: 50,
    trendFilterType: TrendFilterOperatorEnum.between,
    trendFilterValue: 5,
  }
  const asStrings = Object.fromEntries(
    Object.entries(full).map(([k, v]) => [
      k,
      typeof v === 'number' ? `${v}` : v,
    ]),
  ) as Partial<SettingsIndicators>
  const zeros = Object.fromEntries(
    Object.entries(full).map(([k, v]) => [
      k,
      typeof v === 'number'
        ? 0
        : typeof v === 'string' && k !== 'momSource'
          ? ''
          : v,
    ]),
  ) as Partial<SettingsIndicators>
  // Types added after the golden's per-type configs were recorded are
  // appended at the end (below), so the recorded entries keep their order.
  const APPENDED_TYPES: IndicatorEnum[] = [
    IndicatorEnum.kdj,
    IndicatorEnum.vwap,
  ]
  // the 1.121.0 types, appended after every config recorded before them
  const APPENDED_TYPES_2: IndicatorEnum[] = [
    IndicatorEnum.candle,
    IndicatorEnum.ob,
    IndicatorEnum.sqz,
  ]
  const pushTypeConfigs = (type: IndicatorEnum) => {
    const min = {
      type,
      uuid: 'cond',
      groupId: 'g1',
      indicatorAction: IndicatorAction.startDeal,
      indicatorInterval: ExchangeIntervals.oneH,
      indicatorValue: '50',
      indicatorCondition: C.gt,
    } as unknown as SettingsIndicators
    out.push({ id: `${type}|min`, settings: min })
    out.push({ id: `${type}|full`, settings: { ...min, ...full } })
    out.push({ id: `${type}|strings`, settings: { ...min, ...asStrings } })
    out.push({
      id: `${type}|zeros`,
      settings: { ...min, ...zeros, indicatorLength: 14 },
    })
    out.push({
      id: `${type}|xoVo`,
      settings: {
        ...min,
        ...full,
        xOscillator1: IndicatorEnum.vo,
        xOscillator2: IndicatorEnum.vo,
        xOscillator2voLong: undefined,
        xOscillator2voShort: undefined,
      },
    })
    out.push({
      id: `${type}|len0`,
      settings: { ...min, indicatorLength: 0 },
    })
    out.push({
      id: `${type}|interval1d`,
      settings: {
        ...min,
        indicatorInterval: ExchangeIntervals.oneD,
        indicatorLength: '9' as unknown as number,
      },
    })
  }
  for (const type of Object.values(IndicatorEnum))
    if (!APPENDED_TYPES.includes(type) && !APPENDED_TYPES_2.includes(type))
      pushTypeConfigs(type)
  // Session Price levels (appended): only the session window is in the room
  const sessionMin = {
    type: IndicatorEnum.session,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.fifteenM,
    indicatorCondition: C.cu,
    sessionRule: SessionRuleEnum.levels,
  } as unknown as SettingsIndicators
  out.push({ id: 'SESSION|levels|min', settings: sessionMin })
  out.push({
    id: 'SESSION|levels|full',
    settings: {
      ...sessionMin,
      sessionDays: [5, 1, 3],
      sessionStart: '09:30',
      sessionEnd: '16:00',
      sessionTimezone: 'America/New_York',
      sessionLevelA: SessionLevelEnum.prevLow,
      sessionLevelB: SessionLevelEnum.price,
    },
  })
  out.push({
    id: 'SESSION|levels|empty',
    settings: {
      ...sessionMin,
      sessionDays: [],
      sessionStart: '',
      sessionEnd: '',
      sessionTimezone: '',
    },
  })
  // McGinley Dynamic as an MA type (appended): maType reaches the room key
  const maMin = {
    type: IndicatorEnum.ma,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.oneH,
    indicatorCondition: C.cu,
    indicatorLength: 14,
    maType: MAEnum.mcginley,
    maCrossingValue: MAEnum.price,
  } as unknown as SettingsIndicators
  out.push({ id: 'MA|mcginley|price', settings: maMin })
  out.push({
    id: 'MA|mcginley|crossesEma',
    settings: {
      ...maMin,
      maCrossingValue: MAEnum.ema,
      maCrossingLength: 50,
      maCrossingInterval: ExchangeIntervals.oneH,
      maUUID: 'maref',
    },
  })
  out.push({
    id: 'MAR|mcginley',
    settings: {
      ...maMin,
      type: IndicatorEnum.mar,
      mar1type: MAEnum.mcginley,
      mar1length: 20,
      mar2type: MAEnum.price,
    },
  })
  // KDJ and VWAP (appended): the per-type configs every type gets
  for (const type of APPENDED_TYPES) pushTypeConfigs(type)
  // KDJ: only the three lengths reach the room
  const kdjMin = {
    type: IndicatorEnum.kdj,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.oneH,
    indicatorLength: 9,
    indicatorCondition: C.cu,
  } as unknown as SettingsIndicators
  out.push({
    id: 'KDJ|lengths',
    settings: {
      ...kdjMin,
      kdjLength: 14,
      kdjKSmooth: 5,
      kdjDSmooth: 4,
      kdjLine: KDJLineEnum.j,
      kdjCompareTo: KDJCompareToEnum.custom,
      indicatorValue: '0',
      stochRange: StochRangeEnum.both,
    },
  })
  out.push({
    id: 'KDJ|lengthsStrings',
    settings: {
      ...kdjMin,
      kdjLength: '14' as unknown as number,
      kdjKSmooth: '5' as unknown as number,
      kdjDSmooth: '' as unknown as number,
    },
  })
  // VWAP: only the (normalised) anchor reaches the room
  for (const vwapAnchor of [
    VWAPAnchorEnum.day,
    VWAPAnchorEnum.week,
    VWAPAnchorEnum.month,
    'Week' as VWAPAnchorEnum,
    '' as VWAPAnchorEnum,
  ])
    out.push({
      id: `VWAP|anchor=${vwapAnchor}`,
      settings: {
        ...kdjMin,
        type: IndicatorEnum.vwap,
        indicatorLength: 20,
        vwapAnchor,
        vwapLine: VWAPLineEnum.upper,
        vwapBandMultiplier: 2,
      },
    })
  // ADX DMI mode (appended; a new setting on an existing type): dmi joins
  // the room only in DMI mode
  const adxMin = {
    ...kdjMin,
    type: IndicatorEnum.adx,
    indicatorLength: 14,
    indicatorValue: '20',
  } as SettingsIndicators
  for (const adxMode of [ADXModeEnum.dmi, ADXModeEnum.adx])
    out.push({ id: `ADX|mode=${adxMode}`, settings: { ...adxMin, adxMode } })
  out.push({
    id: 'ADX|mode=dmi|full',
    settings: { ...adxMin, ...full, adxMode: ADXModeEnum.dmi },
  })
  // Moving Average trend filter (appended; existing settings on an existing
  // type): the filter settings join the room only when trendFilter is on
  for (const maType of [MAEnum.ema, MAEnum.sma, MAEnum.vwma, MAEnum.mcginley])
    out.push({
      id: `MA|trendFilter|${maType}`,
      settings: {
        ...maMin,
        maType,
        trendFilter: true,
        trendFilterLookback: 10,
        trendFilterType: TrendFilterOperatorEnum.higher,
        trendFilterValue: 1,
      },
    })
  out.push({
    id: 'MA|trendFilter|crossesEma',
    settings: {
      ...maMin,
      maCrossingValue: MAEnum.ema,
      maCrossingLength: 50,
      maCrossingInterval: ExchangeIntervals.oneH,
      maUUID: 'maref',
      trendFilter: true,
      trendFilterLookback: '10' as unknown as number,
      trendFilterType: TrendFilterOperatorEnum.lower,
      trendFilterValue: '0.5' as unknown as number,
    },
  })
  out.push({
    id: 'MA|trendFilter|off',
    settings: {
      ...maMin,
      trendFilter: false,
      trendFilterLookback: 10,
      trendFilterType: TrendFilterOperatorEnum.higher,
      trendFilterValue: 1,
    },
  })
  // Candle colour, Order Blocks, Squeeze Momentum (appended): the per-type
  // configs every type gets, then their own math settings
  for (const type of APPENDED_TYPES_2) pushTypeConfigs(type)
  for (const candleSource of [
    CandleSourceEnum.regular,
    CandleSourceEnum.heikinAshi,
    'Regular' as CandleSourceEnum,
    '' as CandleSourceEnum,
  ])
    out.push({
      id: `CANDLE|source=${candleSource}`,
      settings: {
        ...kdjMin,
        type: IndicatorEnum.candle,
        indicatorLength: 1,
        candleSource,
        candleColor: CandleColorEnum.red,
        candleCount: 3,
        candleTrigger: CandleTriggerEnum.start,
      },
    })
  for (const obSwingLength of [3, '8', 0, '', undefined] as (
    | number
    | undefined
  )[])
    out.push({
      id: `OB|swing=${fmt(obSwingLength)}`,
      settings: {
        ...kdjMin,
        type: IndicatorEnum.ob,
        indicatorLength: 5,
        obSwingLength,
        obSide: OBSideEnum.bearish,
        obLevel: OBLevelEnum.middle,
      },
    })
  for (const [label, sqz] of [
    [
      'custom',
      { sqzLength: 14, sqzBBMult: 2.5, sqzKCLength: 18, sqzKCMult: 1.25 },
    ],
    [
      'settingsStrings',
      { sqzLength: '14', sqzBBMult: '1.5', sqzKCLength: '', sqzKCMult: '0' },
    ],
    ['tv', { sqzBBMult: 1.5 }],
  ] as [string, Partial<SettingsIndicators>][])
    out.push({
      id: `SQZ|${label}`,
      settings: {
        ...kdjMin,
        type: IndicatorEnum.sqz,
        indicatorLength: 20,
        ...sqz,
        sqzSignal: SqzSignalEnum.on,
        sqzMomentum: SqzMomentumEnum.rising,
      },
    })
  // Divergence pivots (appended; new settings on an existing type): each
  // joins the room only when it is set — none set = the room it always had
  const divMin = {
    ...kdjMin,
    type: IndicatorEnum.div,
    divOscillators: [IndicatorEnum.rsi, IndicatorEnum.macd],
    divType: DivTypeEnum.abear,
  } as SettingsIndicators
  for (const [label, pivots] of [
    ['none', {}],
    [
      'allEmpty',
      { divPivotLeft: '', divPivotRight: null, divRangeLower: undefined },
    ],
    [
      'all',
      {
        divPivotLeft: 5,
        divPivotRight: 2,
        divRangeLower: 3,
        divRangeUpper: 90,
      },
    ],
    ['strings', { divPivotLeft: '5', divRangeUpper: '90' }],
    ['rightOnly', { divPivotRight: 1 }],
  ] as [string, Record<string, unknown>][])
    out.push({
      id: `DIV|pivots|${label}`,
      settings: { ...divMin, ...pivots } as SettingsIndicators,
    })
  // Session Price levels active (appended): a decision setting, never in
  // the room
  for (const sessionLevelsActive of [
    SessionLevelsActiveEnum.session,
    SessionLevelsActiveEnum.outside,
    SessionLevelsActiveEnum.always,
  ])
    out.push({
      id: `SESSION|levels|active=${sessionLevelsActive}`,
      settings: { ...sessionMin, sessionLevelsActive },
    })
  // Price Change compare / second value (appended): decision settings, never
  // in the room
  for (const [label, extra] of [
    ['gt', { pcValue: '2', pcCompare: PCCompareEnum.gt }],
    ['lt', { pcValue: '-2', pcCompare: PCCompareEnum.lt }],
    ['bw', { pcValue: '2', pcValue2: '5', pcCompare: PCCompareEnum.bw }],
    ['bwDown', { pcValue: '-5', pcValue2: '-2', pcCompare: PCCompareEnum.bw }],
  ] as [string, Partial<SettingsIndicators>][])
    out.push({
      id: `PC|compare=${label}`,
      settings: { ...kdjMin, type: IndicatorEnum.pc, ...extra },
    })
  // Squeeze BB multiplier (appended; indicators 1.14.0 defaults a missing
  // one to 1.5): a stored value keeps its room
  for (const [label, sqzBBMult] of [
    ['2', 2],
    ['2string', '2'],
    ['1.5', 1.5],
    ['empty', ''],
    ['null', null],
  ] as [string, unknown][])
    out.push({
      id: `SQZ|bbMult=${label}`,
      settings: {
        ...kdjMin,
        type: IndicatorEnum.sqz,
        indicatorLength: 20,
        sqzBBMult: sqzBBMult as number,
        sqzSignal: SqzSignalEnum.fired,
        sqzMomentum: SqzMomentumEnum.positive,
      },
    })
  return out
}

/** Stable serialisation that keeps key order, `undefined` and `NaN`. */
export function serialise(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(serialise).join(',')}]`
  return `{${Object.entries(v as object)
    .map(([k, x]) => `${JSON.stringify(k)}:${serialise(x)}`)
    .join(',')}}`
}
