process.env.NODE_ENV = 'testing'

/**
 * Price Change range end to end on the live path: the condition's settings →
 * `buildIndicatorConfig` (the room config) → `@gainium/indicators`
 * `createIndicator` / `feedCandle` → the service's stored history value →
 * the engine's decision (`evaluateIndicatorCondition`). On every bar the
 * decision must equal the package's `priceChangeCondition` on the package's
 * own result — the function the backtester calls. The SPEC's invariants are
 * checked on the same walks: pcCompare missing decides exactly as before, and
 * bw never fires outside (lo, hi).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  PCCompareEnum as PkgPCCompareEnum,
  createIndicator,
  feedCandle,
  priceChangeCondition,
} from '@gainium/indicators'
import type { PCResult } from '@gainium/indicators'
import {
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  PCCompareEnum,
} from '../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../types'
import { buildIndicatorConfig, evaluateIndicatorCondition } from '.'
import { indicatorHistoryValue } from '../historyValue'

const H = 3_600_000
const T0 = Date.UTC(2026, 0, 5)

type Candle = {
  o: number
  h: number
  l: number
  c: number
  v: number
  t: number
}

/** deterministic walk (mulberry32) whose open→high / open→low moves span 0..8 % */
function candles(n: number, seed = 5): Candle[] {
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
    const h = o * (1 + rnd() * 0.08)
    const l = o * (1 - rnd() * 0.08)
    c = l + (h - l) * rnd()
    out.push({ o, h, l, c, v: 10, t: T0 + i * H })
  }
  return out
}

const settings = (extra: Partial<SettingsIndicators>): SettingsIndicators =>
  ({
    type: IndicatorEnum.pc,
    uuid: 'cond',
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.oneH,
    indicatorLength: 14,
    ...extra,
  }) as SettingsIndicators

const ctx = {
  interval: ExchangeIntervals.oneH,
  symbol: 'BTCUSDT',
  exchange: 'binance',
  showLog: false,
  debug: () => undefined,
  reference: () => undefined,
  setReference: () => undefined,
}

/** The pre-change decision, verbatim (direction from the sign, the room's boolean). */
const legacy = (pc: PCResult, pcValue?: string) =>
  +(pcValue ?? '5') > 0 ? pc.up : pc.down

function run(
  s: SettingsIndicators,
  series: Candle[],
  onBar: (got: boolean, last: PCResult) => void,
): number {
  const ind = createIndicator(buildIndicatorConfig(s) as never)
  expect(ind, 'factory builds the room').to.not.equal(null)
  const history: IndicatorHistory[] = []
  let fired = 0
  for (const k of series) {
    feedCandle(ind, k)
    const result = ind!.result
    if (result === null || result === undefined) continue
    history.push({
      time: k.t,
      type: s.type,
      value: indicatorHistoryValue(s.type, result, k.c, ''),
    } as IndicatorHistory)
    if (history.length > 3) history.shift()
    if (history.length < 2) continue
    // the bars go through JSON in the engine (Redis)
    const bars = JSON.parse(JSON.stringify(history)) as IndicatorHistory[]
    const got = evaluateIndicatorCondition(s, bars, ctx).action
    const last = JSON.parse(JSON.stringify(result)) as PCResult
    expect(got, `PC at ${new Date(k.t).toISOString()}`).to.equal(
      priceChangeCondition(last, {
        value: s.pcValue,
        value2: s.pcValue2,
        compare: s.pcCompare,
      }),
    )
    onBar(got, last)
    if (got) fired++
  }
  return fired
}

describe('indicators/conditions — Price Change range', () => {
  const series = candles(2000)

  it('the enum is the indicators package’s', () => {
    expect(Object.values(PCCompareEnum)).to.deep.equal(
      Object.values(PkgPCCompareEnum),
    )
  })

  for (const pcValue of [undefined, '5', '2', '-2', '0.5', '-7', '0', 'x'])
    for (const pcCompare of [undefined, null, PCCompareEnum.gt])
      it(`compare ${pcCompare} value ${pcValue} = the decision before the setting`, () => {
        const fired = run(
          settings({
            pcValue,
            pcCompare: pcCompare as PCCompareEnum,
            pcValue2: '1',
          }),
          series,
          (got, last) => expect(got).to.equal(legacy(last, pcValue)),
        )
        if (pcValue !== 'x') expect(fired).to.be.greaterThan(0)
      })

  for (const [pcValue, pcValue2] of [
    ['2', '5'],
    ['5', '2'],
    ['-2', '-5'],
    ['-5', '-2'],
  ])
    it(`bw ${pcValue}..${pcValue2} fires only inside (lo, hi)`, () => {
      const lo = Math.min(Math.abs(+pcValue), Math.abs(+pcValue2))
      const hi = Math.max(Math.abs(+pcValue), Math.abs(+pcValue2))
      const fired = run(
        settings({ pcValue, pcValue2, pcCompare: PCCompareEnum.bw }),
        series,
        (got, last) => {
          const m = +pcValue > 0 ? last.upPct! : last.downPct!
          expect(got).to.equal(m > lo && m < hi)
        },
      )
      expect(fired).to.be.greaterThan(50)
    })

  for (const pcValue of ['2', '-2'])
    it(`lt ${pcValue} is the complement of gt except on the bound`, () => {
      const gt: boolean[] = []
      run(settings({ pcValue }), series, (got) => gt.push(got))
      let i = 0
      const fired = run(
        settings({ pcValue, pcCompare: PCCompareEnum.lt }),
        series,
        (got, last) => {
          const m = +pcValue > 0 ? last.upPct! : last.downPct!
          expect(got && gt[i]).to.equal(false)
          if (m !== 2) expect(got || gt[i]).to.equal(true)
          i++
        },
      )
      expect(fired).to.be.greaterThan(50)
    })

  it('bw with mixed signs never fires', () => {
    expect(
      run(
        settings({ pcValue: '2', pcValue2: '-5', pcCompare: PCCompareEnum.bw }),
        series,
        (got) => expect(got).to.equal(false),
      ),
    ).to.equal(0)
  })

  it('pcCompare / pcValue2 are not part of the room', () => {
    const room = (extra: Partial<SettingsIndicators>) =>
      JSON.stringify(buildIndicatorConfig(settings({ pcValue: '2', ...extra })))
    expect(room({ pcCompare: PCCompareEnum.lt })).to.equal(room({}))
    expect(room({ pcCompare: PCCompareEnum.bw, pcValue2: '5' })).to.equal(
      room({}),
    )
  })

  it('history stored before the setting (no pct): gt reads the boolean, lt / bw are false', () => {
    const bars = [
      { time: T0, type: IndicatorEnum.pc, value: { up: false, down: false } },
      {
        time: T0 + H,
        type: IndicatorEnum.pc,
        value: { up: true, down: false },
      },
    ] as unknown as IndicatorHistory[]
    const at = (extra: Partial<SettingsIndicators>) =>
      evaluateIndicatorCondition(
        settings({ pcValue: '2', ...extra }),
        bars,
        ctx,
      ).action
    expect(at({})).to.equal(true)
    expect(at({ pcCompare: PCCompareEnum.lt })).to.equal(false)
    expect(at({ pcCompare: PCCompareEnum.bw, pcValue2: '5' })).to.equal(false)
  })
})
