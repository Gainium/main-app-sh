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
  for (const type of Object.values(IndicatorEnum)) {
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
