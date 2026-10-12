process.env.NODE_ENV = 'testing'

/**
 * Oscillator smoothing — live engine vs `@gainium/backtester`, per smoothable
 * indicator. On one synthetic series, the bars on which the live condition
 * module fires (fed the way the indicator service feeds it: factory instance
 * from `buildIndicatorConfig`, `feedCandle`, `.result`, newest results kept)
 * are the bars on which a real backtester run opens deals, with smoothing
 * off, in `value` mode and in `line` mode.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createIndicator, feedCandle } from '@gainium/indicators'
import DCABacktesting from '@gainium/backtester/dist/dca'
import { StrategyContextManager } from '@gainium/backtester/dist/dca/strategy/context'
import {
  CloseConditionEnum,
  DCAConditionEnum,
  ExchangeEnum,
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum,
  IndicatorsLogicEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  SMOOTHABLE_INDICATORS,
  StartConditionEnum,
  StrategyEnum,
} from '../../../types'
import type { IndicatorHistory, SettingsIndicators } from '../../../types'
import { buildIndicatorConfig, evaluateIndicatorCondition } from '.'

const HOUR = 3600e3
const FROM = Date.UTC(2026, 0, 1)
const PAIR = 'AAA_USDT'
const { cu, cd, gt, lt } = IndicatorStartConditionEnum

type Bar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  symbol: string
}

const bars: Bar[] = Array.from({ length: 700 }, (_, i) => {
  const p = (k: number) =>
    100 + 12 * Math.sin(k / 23) + 4 * Math.sin(k / 5) + k * 0.01
  const open = p(i - 1)
  const close = p(i)
  return {
    time: FROM + i * HOUR,
    open,
    close,
    high: Math.max(open, close) + 0.6 + 0.3 * Math.sin(i / 3),
    low: Math.min(open, close) - 0.6 - 0.3 * Math.cos(i / 4),
    volume: 1000 + 600 * Math.sin(i / 7) + 200 * Math.cos(i / 3),
    symbol: PAIR,
  }
})

const settings = (
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
    groupId: 'g-s',
    uuid: 'u-s',
    ...extra,
  }) as unknown as SettingsIndicators

/** The room's results as the indicator service emits them. */
const emitted = (s: SettingsIndicators) => {
  const ind = createIndicator(buildIndicatorConfig(s) as never)
  const out: { bar: number; value: any }[] = []
  bars.forEach((b, n) => {
    feedCandle(ind, { o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })
    const r = ind.result
    if (r !== undefined && r !== null) out.push({ bar: n, value: r })
  })
  return out
}

/** Deal-start bars that follow from the live signals (signal bar + 1). */
const liveStarts = (s: SettingsIndicators) => {
  const history: IndicatorHistory[] = []
  const out: number[] = []
  emitted(s).forEach(({ bar, value }, k) => {
    history.push({ time: bars[bar].time, type: s.type, value } as never)
    if (history.length > 3) history.shift()
    if (history.length < 2) return
    const { action } = evaluateIndicatorCondition(s, [...history], {
      interval: ExchangeIntervals.oneH,
      symbol: 'AAAUSDT',
      exchange: 'binance',
      showLog: false,
      debug: () => undefined,
      reference: () => undefined,
      setReference: () => undefined,
    })
    // the backtester evaluates once three results exist
    if (action && k >= 2 && bar + 1 < bars.length) out.push(bar + 1)
  })
  return out
}

let runNo = 0
const backtesterStarts = async (s: SettingsIndicators) => {
  StrategyContextManager.setActiveContext(`main-app-smoothing-${++runNo}`)
  const bt = new DCABacktesting({
    exchange: ExchangeEnum.binance,
    symbols: [
      {
        pair: PAIR,
        exchange: ExchangeEnum.binance,
        baseAsset: {
          name: 'AAA',
          minAmount: 0.0001,
          maxAmount: 1e9,
          step: 0.0001,
        },
        quoteAsset: { name: 'USDT', minAmount: 1 },
        maxOrders: 200,
        priceAssetPrecision: 4,
      },
    ],
    interval: ExchangeIntervals.oneH,
    userFee: 0.001,
    prices: [{ symbol: PAIR, price: 100 }],
    balances: [{ asset: 'USDT', free: '1000000', locked: '0' }],
    from: FROM,
    to: FROM + bars.length * HOUR,
    combo: false,
    settings: {
      name: 'smoothing',
      pair: [PAIR],
      strategy: StrategyEnum.long,
      futures: false,
      coinm: false,
      leverage: 1,
      profitCurrency: 'quote',
      orderSizeType: OrderSizeTypeEnum.quote,
      orderFixedIn: 'quote',
      baseOrderSize: '100',
      orderSize: '100',
      startOrderType: OrderTypeEnum.market,
      startCondition: StartConditionEnum.ti,
      dcaCondition: DCAConditionEnum.percentage,
      scaleDcaType: 'percentage',
      useDca: false,
      ordersCount: 4,
      activeOrdersCount: 4,
      step: '1.5',
      stepScale: '1.2',
      volumeScale: '1.3',
      minimumDeviation: '0',
      useTp: true,
      tpPerc: '0.01',
      useSl: false,
      slPerc: '-12',
      dealCloseCondition: CloseConditionEnum.tp,
      dealCloseConditionSL: CloseConditionEnum.tp,
      closeDealType: 'closeByMarket',
      maxNumberOfOpenDeals: '100000',
      maxDealsPerPair: '100000',
      indicators: [s],
      indicatorGroups: [
        {
          id: 'g-s',
          logic: IndicatorsLogicEnum.and,
          action: IndicatorAction.startDeal,
        },
      ],
    },
    fullResult: true,
  } as never)
  const r = (await bt.test([
    { bar: bars, interval: ExchangeIntervals.oneH },
  ] as never)) as { deals: { startTime: number }[] }
  return [...new Set(r.deals.map((d) => (d.startTime - FROM) / HOUR))].sort(
    (a, b) => a - b,
  )
}

const expectParity = async (s: SettingsIndicators, min = 3) => {
  const live = liveStarts(s)
  expect(live.length, `${s.type}: the case opens deals`).to.be.greaterThan(min)
  expect(live, s.type).to.deep.equal(await backtesterStarts(s))
  return live
}

/** A threshold the line crosses often: the median of what it emits. */
const median = (s: SettingsIndicators) => {
  const v = emitted(s)
    .map((e) => +e.value.value)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return `${v[Math.floor(v.length / 2)]}`
}

const ON = { smoothing: 'ema', smoothingLength: 9 }

describe('oscillator smoothing — live engine = backtester', () => {
  for (const type of SMOOTHABLE_INDICATORS) {
    describe(type, () => {
      it('off: crossing the median, fields missing and none', async () => {
        const v = median(settings(type, cu, '0'))
        const got = await expectParity(settings(type, cu, v))
        expect(
          liveStarts(
            settings(type, cu, v, { smoothing: 'none', smoothingLength: 9 }),
          ),
        ).to.deep.equal(got)
      })

      it("'value': cu / lt the median of the smoothed line", async () => {
        const v = median(settings(type, cu, '0', ON))
        const got = await expectParity(settings(type, cu, v, ON))
        expect(got).to.not.deep.equal(liveStarts(settings(type, cu, v)))
        await expectParity(
          settings(type, lt, v, { smoothing: 'sma', smoothingLength: 5 }),
        )
      })

      it("'line': cu / cd / gt against the smoothed line", async () => {
        const line = { ...ON, smoothingCompare: 'line' }
        await expectParity(settings(type, cu, '0', line))
        await expectParity(
          settings(type, cd, '0', { ...line, smoothing: 'hma' }),
        )
        await expectParity(
          settings(type, gt, '0', {
            ...line,
            smoothing: 'tema',
            smoothingLength: 4,
          }),
        )
      })

      it('percentile: smoothed line ranked, line overridden', async () => {
        const pct = {
          percentile: true,
          percentileLookback: 60,
          percentilePercentage: 70,
        }
        await expectParity(
          settings(type, cu, '0', { ...pct, ...ON, smoothingCompare: 'line' }),
        )
      })
    })
  }
})
