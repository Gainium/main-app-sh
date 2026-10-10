process.env.NODE_ENV = 'testing'

/**
 * The shared indicator-condition module on its own (no engine): it must give
 * exactly the decisions, statuses and subscription configs the DCA engine
 * gave before the logic moved here — the same golden table the engine's
 * characterization suite (`bot/indicatorConditions.characterization.spec.ts`)
 * checks.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import {
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum,
} from '../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../types'
import {
  applyConditionStatus,
  buildIndicatorConfig,
  evaluateIndicatorCondition,
  indicatorLengthOf,
  indicatorSubscribeInterval,
  isConditionActive,
  referenceSubscription,
  type ConditionReference,
  type ConditionStatus,
} from '.'
import {
  conditionCases,
  configCases,
  serialise,
  H,
  type ConditionCase,
} from './__fixtures__/conditionCases'

const golden = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '__fixtures__/indicatorConditions.golden.json'),
    'utf8',
  ),
) as {
  conditions: string
  conditionIds: number
  status: Record<string, string>
  configs: Record<string, string>
}

function runCase(c: ConditionCase): string {
  const refs = new Map<string, ConditionReference>()
  let ref: ConditionReference | null = null
  if (c.reference?.bars) {
    ref = {
      interval: c.reference.interval,
      history: c.reference.bars(),
      data: true,
    }
    refs.set(`${c.reference.uuid}@BTCUSDT`, ref)
  }
  try {
    const { action } = evaluateIndicatorCondition(c.settings, c.bars(), {
      interval: c.interval,
      symbol: 'BTCUSDT',
      exchange: 'binance',
      showLog: true,
      debug: () => undefined,
      reference: (k) => refs.get(k),
      setReference: (k, r) => refs.set(k, r),
    })
    const ch = action ? 't' : 'f'
    return ref && ref.data === false ? ch.toUpperCase() : ch
  } catch {
    return 'E'
  }
}

describe('indicators/conditions — shared condition module', () => {
  it('decides every characterization case as the engine did', () => {
    const cases = conditionCases()
    expect(cases.length).to.equal(golden.conditionIds)
    const diffs: string[] = []
    cases.forEach((c, n) => {
      const got = runCase(c)
      if (got !== golden.conditions[n] && diffs.length < 25)
        diffs.push(`${c.id}: got ${got} want ${golden.conditions[n]}`)
    })
    expect(diffs).to.deep.equal([])
  })

  it('builds the configs the engine subscribed', () => {
    const diffs: string[] = []
    for (const { id, settings } of configCases()) {
      const want = golden.configs[id]
      let got: string
      if (!indicatorLengthOf(settings) || !settings.indicatorInterval)
        got = 'not subscribed'
      else {
        const parts = [
          `${settings.uuid}@${indicatorSubscribeInterval(settings.type, settings.indicatorInterval)}=${serialise(buildIndicatorConfig(settings))}`,
        ]
        const ref = referenceSubscription(settings)
        if (ref)
          parts.push(`${ref.uuid}@${ref.interval}=${serialise(ref.config)}`)
        got = parts.join(' | ')
      }
      if (got !== want) diffs.push(`${id}: got ${got} want ${want}`)
    }
    expect(diffs).to.deep.equal([])
  })

  it('holds a signal for keep-condition-bars exactly as the engine did', () => {
    const PATTERN = [
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]
    for (const [key, want] of Object.entries(golden.status)) {
      const [base, keepRaw] = key.split('|')
      const keep = keepRaw === 'undefined' ? undefined : keepRaw
      const now = Date.now()
      const start =
        base === 'past'
          ? 1_700_000_000_000 - (1_700_000_000_000 % H)
          : now + 30 * 24 * H - ((now + 30 * 24 * H) % H)
      const st: ConditionStatus = { status: false }
      const steps = PATTERN.map((action, n) => {
        applyConditionStatus(st, {
          action,
          barTime: start + n * H,
          indicatorInterval: ExchangeIntervals.oneH,
          keepConditionBars: keep,
          now: Date.now(),
        })
        const rel = (t: number | undefined) =>
          t === undefined ? 'u' : `${(t - start) / H}`
        return `${st.status ? 1 : 0}:${rel(st.statusSince)}:${rel(st.statusTo)}`
      })
      expect(steps.join(' '), key).to.equal(want)
    }
  })

  it('a status counts until its end time', () => {
    expect(isConditionActive({ status: true }, 5)).to.equal(true)
    expect(isConditionActive({ status: true, statusTo: 5 }, 5)).to.equal(true)
    expect(isConditionActive({ status: true, statusTo: 4 }, 5)).to.equal(false)
    expect(isConditionActive({ status: false, statusTo: 9 }, 5)).to.equal(false)
  })

  it('MA vs price: the MA is compared with the price', () => {
    const s = {
      type: IndicatorEnum.ma,
      uuid: 'c',
      groupId: 'g',
      indicatorAction: IndicatorAction.startDeal,
      indicatorInterval: ExchangeIntervals.oneH,
      indicatorLength: 50,
      indicatorValue: '',
      indicatorCondition: IndicatorStartConditionEnum.lt,
      maCrossingValue: 'price',
    } as unknown as SettingsIndicators
    const bars = [
      {
        time: 0,
        type: IndicatorEnum.ma,
        value: { ma: 100, price: 110, maType: 'ema' },
      },
      {
        time: H,
        type: IndicatorEnum.ma,
        value: { ma: 100, price: 120, maType: 'ema' },
      },
    ] as IndicatorHistory[]
    const r = evaluateIndicatorCondition(s, bars, {
      interval: ExchangeIntervals.oneH,
      symbol: 'X',
      exchange: 'e',
      showLog: false,
      debug: () => undefined,
      reference: () => undefined,
      setReference: () => undefined,
    })
    expect(r.action).to.equal(true) // "MA lower than price"
    expect(r.compared).to.deep.equal({
      last: 100,
      prev: 100,
      value: 120,
      prevValue: 110,
    })
  })
})
