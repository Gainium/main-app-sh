/**
 * The indicator condition decision of the DCA engine, as a pure function: one
 * condition's settings and the latest bars of its indicator room in, the
 * signal (`action`) out. No I/O and no bot state — whatever the engine needs
 * from its runtime (a reference series for MA-vs-MA and oscillator crosses,
 * its logger) comes in through `ctx`.
 *
 * Moved verbatim out of `bot/dcaHelper.ts` `checkIndicatorConditions`; the
 * characterization suite (`bot/indicatorConditions.characterization.spec.ts`)
 * pins that the engine's decisions did not change. Keep it that way: a change
 * here changes every live bot's signals, so it needs its own spec, not a
 * drive-by edit for one consumer.
 *
 * Two in-place effects are part of the engine's behaviour and kept:
 *  - null values inside OBFVG / long-wick / prior-pivot bars are replaced by
 *    NaN on the bar objects passed in (`convertNullToNan`);
 *  - a reference indicator read for an MA or oscillator cross has its `data`
 *    flag cleared (same or lower timeframe) and is handed back through
 *    `ctx.setReference` — the engine's mark that the reference value was
 *    consumed.
 */
import { gt, lt, lte, gte, eq } from '@gainium/indicators'
import type { OBFVGResult, LongWickResult } from '@gainium/indicators'
import type {
  DIVResult,
  PCResult,
  PercentileResult,
  PriorPivotResult,
  QFLResult,
  SuperTrendResult,
} from '@gainium/indicators'
import {
  BBCrossingEnum,
  DCValueEnum,
  DivTypeEnum,
  ECDTriggerEnum,
  ExchangeIntervals,
  IndicatorEnum,
  IndicatorStartConditionEnum,
  LWConditionEnum,
  MAEnum,
  OBFVGRefEnum,
  OBFVGValueEnum,
  PCConditionEnum,
  SRCrossingEnum,
  STConditionEnum,
  StochRangeEnum,
  TradingviewAnalysisSignalEnum,
  TrendFilterOperatorEnum,
  ppValueEnum,
  ppValueTypeEnum,
  rsiValue2Enum,
  rsiValueEnum,
  timeIntervalMap,
} from '../../../types'
import type {
  IndicatorHistory,
  MAResult,
  SettingsIndicators,
} from '../../../types'

/** A reference indicator series (the second MA of an MA cross, the second oscillator of a cross oscillator). */
export type ConditionReference = {
  interval: ExchangeIntervals
  history: IndicatorHistory[]
  data?: boolean
}

export type IndicatorConditionContext = {
  /** the timeframe of the condition's own indicator entry */
  interval: ExchangeIntervals
  symbol: string
  /** for log lines only */
  exchange: string
  /** the engine's per-condition trigger log lines are written when true */
  showLog: boolean
  debug: (message: string) => void
  /**
   * The reference series by its engine key `${uuid}@${symbol}` (`maUUID` /
   * `xoUUID`); undefined when it is not loaded.
   */
  reference: (key: string) => ConditionReference | undefined
  /** called with the reference after it was read (and possibly marked consumed) */
  setReference: (key: string, reference: ConditionReference) => void
}

export type IndicatorConditionResult = {
  /** the condition's signal for the newest bar */
  action: boolean
  /**
   * The compared series of the threshold / crossing comparisons (absent for
   * event-style indicators): `last`/`prev` the indicator side, `value` /
   * `prevValue` the threshold or level it is compared with.
   */
  compared: {
    last: number
    prev: number
    value: number
    prevValue: number
  } | null
}

export function convertNullToNan(obj: Record<string, unknown>) {
  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      convertNullToNan(obj[key] as Record<string, unknown>)
    } else if (obj[key] === null) {
      obj[key] = NaN
    }
  }
  return obj
}

/**
 * Evaluate one condition on its room's bars (any order; the newest two are
 * used). Throws where the engine throws (an OBFVG condition, or a SuperTrend
 * trigger log line, with a single bar).
 */
export function evaluateIndicatorCondition(
  find: SettingsIndicators,
  data: IndicatorHistory[],
  ctx: IndicatorConditionContext,
): IndicatorConditionResult {
  const {
    indicatorValue,
    indicatorValue2,
    indicatorCondition,
    type,
    checkLevel,
    signal,
    maUUID,
    maCrossingValue,
    maType,
    indicatorInterval,
    bbCrossingValue,
    stochUpper,
    stochLower,
    srCrossingValue,
    indicatorAction,
    stochRange,
    ecdTrigger,
    xoUUID,
    xOscillator1,
    percentile,
    divMinCount,
    divType,
    trendFilter,
    trendFilterType,
    stCondition,
    pcValue,
    ppValue,
    ppType,
    dcValue,
    obfvgRef,
    obfvgValue,
    lwValue,
    lwCondition,
  } = find
  const uuid = find.uuid
  const { symbol, showLog } = ctx
  const sortedByTime = [...data].sort((a, b) => b.time - a.time)
  const lastTime = sortedByTime[0].time
  const [lastData, prevData] = sortedByTime
  let action = false
  let skipAction = false
  let trendFilterAction = false
  let lastDataString = ''
  let prevDataString = ''
  let trendValue: number | undefined
  let reported: IndicatorConditionResult['compared'] = null
  let { rsiValue, rsiValue2, valueInsteadof } = find
  rsiValue = rsiValue ?? rsiValueEnum.k
  rsiValue2 = rsiValue2 ?? rsiValue2Enum.d
  valueInsteadof = valueInsteadof ?? 1
  let value = indicatorValue !== undefined ? +indicatorValue : 0
  let prevValue = value
  if (type === IndicatorEnum.obfvg) {
    const [l, p] = [...data].sort((a, b) => b.time - a.time)
    const last = convertNullToNan(l.value as OBFVGResult) as OBFVGResult
    const prev = convertNullToNan(p.value as OBFVGResult) as OBFVGResult
    const lastBull =
      obfvgRef === OBFVGRefEnum.high
        ? last.bullishFVGHigh
        : obfvgRef === OBFVGRefEnum.low
          ? last.bullishFVGLow
          : last.bullishFVGMiddle
    const lastBear =
      obfvgRef === OBFVGRefEnum.high
        ? last.bearishFVGHigh
        : obfvgRef === OBFVGRefEnum.low
          ? last.bearishFVGLow
          : last.bearishFVGMiddle
    const prevBull =
      obfvgRef === OBFVGRefEnum.high
        ? prev.bullishFVGHigh
        : obfvgRef === OBFVGRefEnum.low
          ? prev.bullishFVGLow
          : prev.bullishFVGMiddle
    const prevBear =
      obfvgRef === OBFVGRefEnum.high
        ? prev.bearishFVGHigh
        : obfvgRef === OBFVGRefEnum.low
          ? prev.bearishFVGLow
          : prev.bearishFVGMiddle
    const lastPrice = last.price
    const prevPrice = prev.price
    const bullCd =
      !isNaN(lastBull) &&
      !isNaN(prevBull) &&
      !isNaN(lastPrice) &&
      !isNaN(prevPrice) &&
      ((gt(prevPrice, prevBull) && lt(lastPrice, lastBull)) ||
        (gt(prevPrice, prevBull) && lte(lastPrice, lastBull)))
    const bearCd =
      !isNaN(lastBear) &&
      !isNaN(prevBear) &&
      !isNaN(lastPrice) &&
      !isNaN(prevPrice) &&
      ((gt(prevPrice, prevBear) && lt(lastPrice, lastBear)) ||
        (gt(prevPrice, prevBear) && lte(lastPrice, lastBear)))
    const bullCu =
      !isNaN(lastBull) &&
      !isNaN(prevBull) &&
      !isNaN(lastPrice) &&
      !isNaN(prevPrice) &&
      ((lt(prevPrice, prevBull) && gt(lastPrice, lastBull)) ||
        (lt(prevPrice, prevBull) && gte(lastPrice, lastBull)))
    const bearCu =
      !isNaN(lastBear) &&
      !isNaN(prevBear) &&
      !isNaN(lastPrice) &&
      !isNaN(prevPrice) &&
      ((lt(prevPrice, prevBear) && gt(lastPrice, lastBear)) ||
        (lt(prevPrice, prevBear) && gte(lastPrice, lastBear)))
    const bullGt =
      !isNaN(lastBull) && !isNaN(prevPrice) && gt(lastPrice, lastBull)
    const bearGt =
      !isNaN(lastBear) && !isNaN(lastPrice) && gt(lastPrice, lastBear)
    const bullLt =
      !isNaN(lastBull) && !isNaN(lastPrice) && lt(lastPrice, lastBull)
    const bearLt =
      !isNaN(lastBear) && !isNaN(lastPrice) && lt(lastPrice, lastBear)

    action =
      indicatorCondition === IndicatorStartConditionEnum.cd
        ? obfvgValue === OBFVGValueEnum.bearish
          ? bearCd
          : obfvgValue === OBFVGValueEnum.any
            ? bullCd || bearCd
            : bullCd
        : indicatorCondition === IndicatorStartConditionEnum.cu
          ? obfvgValue === OBFVGValueEnum.bearish
            ? bearCu
            : obfvgValue === OBFVGValueEnum.any
              ? bullCu || bearCu
              : bullCu
          : indicatorCondition === IndicatorStartConditionEnum.gt
            ? obfvgValue === OBFVGValueEnum.bearish
              ? bearGt
              : obfvgValue === OBFVGValueEnum.any
                ? bullGt || bearGt
                : bullGt
            : indicatorCondition === IndicatorStartConditionEnum.lt
              ? obfvgValue === OBFVGValueEnum.bearish
                ? bearLt
                : obfvgValue === OBFVGValueEnum.any
                  ? bullLt || bearLt
                  : bullLt
              : false
  } else if (type === IndicatorEnum.pc) {
    const pcCondition =
      +(pcValue ?? '5') > 0 ? PCConditionEnum.up : PCConditionEnum.down
    const [last] = [...data].sort((a, b) => b.time - a.time)
    action =
      (pcCondition === PCConditionEnum.down && (last.value as PCResult).down) ||
      (pcCondition === PCConditionEnum.up && (last.value as PCResult).up)
    if (action && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger action: up: ${(last.value as PCResult).up}, down: ${
          (last.value as PCResult).down
        }, condition: ${pcCondition}, last time ${new Date(
          lastTime,
        )?.toISOString()}`,
      )
    }
  } else if (type === IndicatorEnum.lw) {
    const [ld, pd] = sortedByTime
    const last = convertNullToNan(ld?.value as LongWickResult) as LongWickResult
    const prev = convertNullToNan(pd?.value as LongWickResult) as LongWickResult
    if (last && prev) {
      const useTop =
        typeof lwValue === 'undefined' || lwValue === 'top' || lwValue === 'any'
      const useBottom =
        typeof lwValue === 'undefined' ||
        lwValue === 'bottom' ||
        lwValue === 'any'
      const cond =
        typeof lwCondition === 'undefined'
          ? LWConditionEnum.during
          : lwCondition
      action =
        (useTop &&
          (cond === LWConditionEnum.during
            ? !isNaN(last.bull)
            : isNaN(prev.bull) && !isNaN(last.bull))) ||
        (useBottom &&
          (cond === LWConditionEnum.during
            ? !isNaN(last.bear)
            : isNaN(prev.bear) && !isNaN(last.bear)))
    }
  } else if (type === IndicatorEnum.st) {
    const [ld, pd] = sortedByTime
    const lastData = ld?.value as SuperTrendResult
    const prevData = pd?.value as SuperTrendResult
    action =
      (stCondition === STConditionEnum.up && lastData?.direction === -1) ||
      (stCondition === STConditionEnum.down && lastData?.direction === 1) ||
      (stCondition === STConditionEnum.upToDown &&
        prevData?.direction === -1 &&
        lastData?.direction === 1) ||
      (stCondition === STConditionEnum.downToUp &&
        prevData?.direction === 1 &&
        lastData?.direction === -1)
    if (action && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger action: ${indicatorAction}. ${
          prevData.direction
        }, ${lastData.direction}, ${prevData.value}, ${
          lastData.value
        }, last time ${new Date(lastTime)?.toISOString()}`,
      )
    }
  } else if (type === IndicatorEnum.div) {
    const [lastData] = sortedByTime
    const result = lastData.value as DIVResult
    const min = +(divMinCount ?? 2)
    action = action =
      ((divType === DivTypeEnum.bear || divType === DivTypeEnum.abear) &&
        result.negdivergence >= min) ||
      ((divType === DivTypeEnum.hbear || divType === DivTypeEnum.abear) &&
        result.negdivergencehidden >= min) ||
      ((divType === DivTypeEnum.bull || divType === DivTypeEnum.abull) &&
        result.posdivergence >= min) ||
      ((divType === DivTypeEnum.hbull || divType === DivTypeEnum.abull) &&
        result.posdivergencehidden >= min)
    if (action && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger action: ${indicatorAction}. ${
          result.negdivergence
        }, ${result.negdivergencehidden}, ${result.posdivergence}, ${
          result.posdivergencehidden
        }, last time ${new Date(lastTime)?.toISOString()}`,
      )
    }
  } else if (type === IndicatorEnum.qfl) {
    action = (lastData.value as QFLResult).action
    if (action && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger action: ${indicatorAction}, last time ${new Date(
          lastTime,
        )?.toISOString()}`,
      )
    }
  } else if (type === IndicatorEnum.tv && checkLevel && signal) {
    /**
     * TradingViews Technical Analysis
     *
     * Result:
     *  - 0 - neutral
     *
     *  - 1 - Buy
     *
     *  - 2 - Strong buy
     *
     *  - 3 - Sell
     *
     *  - 4 - Strong sell
     *
     *  - 5 - No action (for useEntryExitPoints)
     */
    const tvta = lastData.value as number
    if (signal === TradingviewAnalysisSignalEnum.buy && tvta === 1) {
      action = true
    } else if (
      signal === TradingviewAnalysisSignalEnum.strongBuy &&
      tvta === 2
    ) {
      action = true
    } else if (
      signal === TradingviewAnalysisSignalEnum.bothBuy &&
      (tvta === 2 || tvta === 1)
    ) {
      action = true
    } else if (signal === TradingviewAnalysisSignalEnum.sell && tvta === 3) {
      action = true
    } else if (
      signal === TradingviewAnalysisSignalEnum.strongSell &&
      tvta === 4
    ) {
      action = true
    } else if (
      signal === TradingviewAnalysisSignalEnum.bothSell &&
      (tvta === 3 || tvta === 4)
    ) {
      action = true
    }
    if (action && showLog) {
      ctx.debug(
        `${type}@${indicatorInterval}@${ctx.exchange}@${symbol} trigger. ${
          tvta === 0
            ? 'Neutral'
            : tvta === 1
              ? 'Buy'
              : tvta === 2
                ? 'Strong Buy'
                : tvta === 3
                  ? 'Sell'
                  : tvta === 4
                    ? 'Strong Sell'
                    : 'No action'
        } action: ${indicatorAction}, last time ${new Date(
          lastTime,
        )?.toISOString()}`,
      )
    }
  } else if (type === IndicatorEnum.ecd && ecdTrigger) {
    /**
     * Engulfing candle detector
     *
     * Result:
     *  - 0 - na
     *
     *  - 1 - Bearish
     *
     *  - 2 - Bullish
     *
     */
    const [lastData] = sortedByTime
    const ecd = lastData.value as number
    if (
      ecd === 1 &&
      [ECDTriggerEnum.bearish, ECDTriggerEnum.both].includes(ecdTrigger)
    ) {
      action = true
    } else if (
      ecd === 2 &&
      [ECDTriggerEnum.bullish, ECDTriggerEnum.both].includes(ecdTrigger)
    ) {
      action = true
    }
    if (action && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger. ${
          ecd === 1 ? 'Bearish' : ecd === 2 ? 'Bullish' : 'No action'
        } action: ${indicatorAction}, last time ${new Date(
          lastTime,
        )?.toISOString()}`,
      )
    }
  } else if (
    (indicatorValue !== undefined || type === IndicatorEnum.ma) &&
    indicatorCondition &&
    prevData
  ) {
    let last = 0
    let prev = 0
    let checkValue = true
    if (
      (lastData.type === IndicatorEnum.rsi ||
        lastData.type === IndicatorEnum.ao ||
        lastData.type === IndicatorEnum.cci ||
        lastData.type === IndicatorEnum.uo ||
        lastData.type === IndicatorEnum.mom ||
        lastData.type === IndicatorEnum.wr ||
        lastData.type === IndicatorEnum.mfi ||
        lastData.type === IndicatorEnum.adx ||
        lastData.type === IndicatorEnum.bbw ||
        lastData.type === IndicatorEnum.bbpb ||
        lastData.type === IndicatorEnum.kcpb ||
        lastData.type === IndicatorEnum.vo ||
        lastData.type === IndicatorEnum.mar) &&
      (prevData.type === IndicatorEnum.rsi ||
        prevData.type === IndicatorEnum.ao ||
        prevData.type === IndicatorEnum.cci ||
        prevData.type === IndicatorEnum.uo ||
        prevData.type === IndicatorEnum.mom ||
        prevData.type === IndicatorEnum.wr ||
        prevData.type === IndicatorEnum.mfi ||
        prevData.type === IndicatorEnum.adx ||
        prevData.type === IndicatorEnum.bbw ||
        prevData.type === IndicatorEnum.bbpb ||
        prevData.type === IndicatorEnum.kcpb ||
        prevData.type === IndicatorEnum.vo ||
        prevData.type === IndicatorEnum.mar)
    ) {
      last = lastData.value.value
      prev = prevData.value.value
      if (percentile) {
        const tmpValue = lastData.value.percentile
        const tmpPrevValue = prevData.value.percentile
        if (
          typeof tmpValue === 'undefined' ||
          typeof tmpPrevValue === 'undefined'
        ) {
          last = 0
          prev = 0
          value = 0
          prevValue = 0
        } else {
          value = tmpValue
          prevValue = tmpPrevValue
        }
      }
      if (trendFilter) {
        trendFilterAction =
          (trendFilterType === TrendFilterOperatorEnum.lower &&
            lastData.value.trend === 1) ||
          (trendFilterType === TrendFilterOperatorEnum.higher &&
            lastData.value.trend === 2) ||
          (trendFilterType === TrendFilterOperatorEnum.between &&
            lastData.value.trend === 3)
        trendValue = lastData.value.trend
      }
    }
    if (
      lastData.type === IndicatorEnum.dc &&
      prevData.type === IndicatorEnum.dc
    ) {
      last = lastData.value.price
      prev = prevData.value.price
      value =
        dcValue === DCValueEnum.lower
          ? lastData.value.low
          : dcValue === DCValueEnum.upper
            ? lastData.value.high
            : lastData.value.basis
      prevValue =
        dcValue === DCValueEnum.lower
          ? prevData.value.low
          : dcValue === DCValueEnum.upper
            ? prevData.value.high
            : prevData.value.basis
    }
    if (
      lastData.type === IndicatorEnum.bbwp &&
      prevData?.type === IndicatorEnum.bbwp
    ) {
      last = lastData.value
      prev = prevData.value
    }
    if (
      lastData.type === IndicatorEnum.atr &&
      prevData?.type === IndicatorEnum.atr
    ) {
      last = lastData.value
      prev = prevData.value
    }
    if (
      lastData.type === IndicatorEnum.adr &&
      prevData?.type === IndicatorEnum.adr
    ) {
      last = lastData.value
      prev = prevData.value
    }
    if (
      lastData.type === IndicatorEnum.ath &&
      prevData.type === IndicatorEnum.ath
    ) {
      last = lastData.value
      prev = prevData.value
      value = Math.abs(+(indicatorValue ?? '70')) * -1
      prevValue = value
    }
    if (
      lastData.type === IndicatorEnum.macd &&
      prevData?.type === IndicatorEnum.macd
    ) {
      last = lastData.value.histogram
      prev = prevData.value.histogram
    }
    if (
      lastData.type === IndicatorEnum.ma &&
      prevData?.type === IndicatorEnum.ma
    ) {
      last = lastData.value.ma
      prev = prevData.value.ma
      if (maCrossingValue === MAEnum.price) {
        value = lastData.value.price
        prevValue = prevData.value.price
      } else if (lastData.value.maType === maType) {
        const maKey = `${maUUID}@${symbol}`
        const findMA = ctx.reference(maKey)
        if (findMA) {
          const data = [...findMA.history].sort((a, b) => b.time - a.time)
          const prevMAData =
            findMA.interval === ctx.interval
              ? data.find((d) => d.time === prevData.time) || data[1] || 0
              : data[1]
          const dataMA =
            findMA.interval === ctx.interval
              ? data.find((d) => d.time === lastData.time) || data[0] || 0
              : data[0]
          prevValue = prevMAData ? (prevMAData.value as MAResult).ma : 0
          findMA.data =
            findMA.interval === ctx.interval ||
            timeIntervalMap[findMA.interval] < timeIntervalMap[ctx.interval]
              ? false
              : findMA.data
          ctx.setReference(maKey, findMA)
          value = dataMA ? (dataMA.value as MAResult).ma : 0
          if (
            (eq(prevValue, 0) && !eq(value, 0)) ||
            (eq(value, 0) && !eq(prevValue, 0))
          ) {
            ctx.debug(
              `Indicator ${maKey} some values are zero: ${value} value, ${prevValue} prevValue | ${new Date(
                lastData.time,
              )}`,
            )
            value = 0
            prevValue = 0
          }
        } else {
          ctx.debug(`Indicator ${maKey} not found | ${new Date(lastData.time)}`)
          value = 0
          prevValue = 0
          last = 0
          prev = 0
        }
      } else {
        value = 0
        prevValue = 0
        last = 0
        prev = 0
      }
    }
    if (
      find.type === IndicatorEnum.xo &&
      lastData.type === xOscillator1 &&
      prevData?.type === xOscillator1
    ) {
      last = lastData.value.value
      prev = prevData.value.value
      const xoKey = `${xoUUID}@${symbol}`
      const findXO = ctx.reference(xoKey)
      if (findXO) {
        const [dataXO, prevXOData] = [...findXO.history].sort(
          (a, b) => b.time - a.time,
        )
        prevValue = prevXOData
          ? (prevXOData.value as PercentileResult).value
          : 0
        value = dataXO ? (dataXO.value as PercentileResult).value : 0
        findXO.data =
          findXO.interval === ctx.interval ||
          timeIntervalMap[findXO.interval] < timeIntervalMap[ctx.interval]
            ? false
            : findXO.data
        ctx.setReference(xoKey, findXO)
      } else {
        last = 0
        prev = 0
        value = 0
        prevValue = 0
      }
    }
    if (
      lastData.type === IndicatorEnum.psar &&
      prevData.type === IndicatorEnum.psar
    ) {
      last = lastData.value.price
      prev = prevData.value.price
      value = lastData.value.psar
      prevValue = prevData.value.psar
    }
    if (
      (lastData.type === IndicatorEnum.bb ||
        lastData.type === IndicatorEnum.kc) &&
      (prevData.type === IndicatorEnum.bb || prevData.type === IndicatorEnum.kc)
    ) {
      last = lastData.value.price
      prev = prevData.value.price
      value =
        bbCrossingValue === BBCrossingEnum.lower
          ? lastData.value.result.lower
          : bbCrossingValue === BBCrossingEnum.middle
            ? lastData.value.result.middle
            : lastData.value.result.upper
      prevValue =
        bbCrossingValue === BBCrossingEnum.lower
          ? prevData.value.result.lower
          : bbCrossingValue === BBCrossingEnum.middle
            ? prevData.value.result.middle
            : prevData.value.result.upper
    }
    if (type === IndicatorEnum.pp) {
      const [ld, pd] = sortedByTime
      const lastData = convertNullToNan(
        ld.value as PriorPivotResult,
      ) as PriorPivotResult
      const prevData = convertNullToNan(
        pd.value as PriorPivotResult,
      ) as PriorPivotResult
      if (!ppType || ppType === ppValueTypeEnum.price) {
        last = lastData.price
        prev = prevData.price
        value =
          ppValue === ppValueEnum.anyH
            ? isNaN(lastData.hh)
              ? lastData.lh
              : lastData.hh
            : ppValue === ppValueEnum.anyL
              ? isNaN(lastData.ll)
                ? lastData.hl
                : lastData.ll
              : ppValue === ppValueEnum.hh
                ? lastData.hh
                : ppValue === ppValueEnum.hl
                  ? lastData.hl
                  : ppValue === ppValueEnum.ll
                    ? lastData.ll
                    : lastData.lh
        prevValue =
          ppValue === ppValueEnum.anyH
            ? isNaN(prevData.hh)
              ? prevData.lh
              : prevData.hh
            : ppValue === ppValueEnum.anyL
              ? isNaN(prevData.ll)
                ? prevData.hl
                : prevData.ll
              : ppValue === ppValueEnum.hh
                ? prevData.hh
                : ppValue === ppValueEnum.hl
                  ? prevData.hl
                  : ppValue === ppValueEnum.ll
                    ? prevData.ll
                    : prevData.lh
        if (isNaN(value) || isNaN(prevValue)) {
          last = 0
          prev = 0
          value = 0
          prevValue = 0
        }
      }
      if (ppType === ppValueTypeEnum.event) {
        skipAction = true
        action =
          ((ppValue === ppValueEnum.sBullCHoCH ||
            ppValue === ppValueEnum.SanyBull ||
            ppValue === ppValueEnum.bullAnyCHoCH) &&
            lastData.sBullCHoCH) ||
          ((ppValue === ppValueEnum.sBearCHoCH ||
            ppValue === ppValueEnum.SanyBear ||
            ppValue === ppValueEnum.bearAnyCHoCH) &&
            lastData.sBearCHoCH) ||
          ((ppValue === ppValueEnum.sBullBoS ||
            ppValue === ppValueEnum.SanyBull ||
            ppValue === ppValueEnum.bullAnyBoS) &&
            lastData.sBullBoS) ||
          ((ppValue === ppValueEnum.sBearBoS ||
            ppValue === ppValueEnum.SanyBear ||
            ppValue === ppValueEnum.bearAnyBoS) &&
            lastData.sBearBoS) ||
          ((ppValue === ppValueEnum.iBullCHoCH ||
            ppValue === ppValueEnum.IanyBull ||
            ppValue === ppValueEnum.bullAnyCHoCH) &&
            lastData.iBullCHoCH) ||
          ((ppValue === ppValueEnum.iBearCHoCH ||
            ppValue === ppValueEnum.IanyBear ||
            ppValue === ppValueEnum.bearAnyCHoCH) &&
            lastData.iBearCHoCH) ||
          ((ppValue === ppValueEnum.iBullBoS ||
            ppValue === ppValueEnum.IanyBull ||
            ppValue === ppValueEnum.bullAnyBoS) &&
            lastData.iBullBoS) ||
          ((ppValue === ppValueEnum.iBearBoS ||
            ppValue === ppValueEnum.IanyBear ||
            ppValue === ppValueEnum.bearAnyBoS) &&
            lastData.iBearBoS)
        if (action && showLog) {
          ctx.debug(
            `${uuid}@${type}@${indicatorInterval}@${ctx.exchange}@${symbol} trigger. Action: ${ppValue}`,
          )
        }
      }
      if (ppType === ppValueTypeEnum.market) {
        skipAction = true
        action =
          (ppValue === ppValueEnum.bullMarket && lastData.market === 'bull') ||
          (ppValue === ppValueEnum.bearMarket && lastData.market === 'bear')
        if (action && showLog) {
          ctx.debug(
            `${uuid}@${type}@${indicatorInterval}@${ctx.exchange}@${symbol} trigger. Action: ${ppValue}`,
          )
        }
      }
    }
    if (
      (lastData.type === IndicatorEnum.stoch &&
        prevData.type === IndicatorEnum.stoch) ||
      (lastData.type === IndicatorEnum.stochRSI &&
        prevData.type === IndicatorEnum.stochRSI)
    ) {
      if (rsiValue === rsiValueEnum.k) {
        last = lastData.value.stochK
        prev = prevData.value.stochK
      } else if (rsiValue === rsiValueEnum.d) {
        last = lastData.value.stochD
        prev = prevData.value.stochD
      }
      if (rsiValue2 === rsiValue2Enum.d) {
        value = lastData.value.stochD
        prevValue = prevData.value.stochD
      } else if (rsiValue2 === rsiValue2Enum.k) {
        value = lastData.value.stochK
        prevValue = prevData.value.stochK
      } else if (rsiValue2 === rsiValue2Enum.custom) {
        value = valueInsteadof
        prevValue = valueInsteadof
        checkValue = false
      }
    }
    if (
      lastData.type === IndicatorEnum.sr &&
      prevData.type === IndicatorEnum.sr
    ) {
      last = lastData.value.price
      prev = prevData.value.price
      value =
        srCrossingValue === SRCrossingEnum.resistance
          ? lastData.value.high
          : lastData.value.low
      prevValue =
        srCrossingValue === SRCrossingEnum.resistance
          ? lastData.value.high
          : lastData.value.low
    }
    lastDataString = `${last}`
    prevDataString = `${prev}`
    reported = { last, prev, value, prevValue }
    if (
      (indicatorCondition === IndicatorStartConditionEnum.cu ||
        indicatorCondition === IndicatorStartConditionEnum.cd) &&
      data.length < 2
    ) {
      ctx.debug(`Not enough data to count crossing down/up. Wait for next tick`)
    }

    if (
      (indicatorCondition === IndicatorStartConditionEnum.cu ||
        indicatorCondition === IndicatorStartConditionEnum.cd) &&
      data.length >= 2 &&
      !skipAction
    ) {
      if (indicatorCondition === IndicatorStartConditionEnum.cd) {
        action =
          (gt(value, last) && lt(prevValue, prev)) ||
          (gt(value, last) && lte(prevValue, prev))
      }
      if (indicatorCondition === IndicatorStartConditionEnum.cu) {
        action =
          (lt(value, last) && gt(prevValue, prev)) ||
          (lt(value, last) && gte(prevValue, prev))
      }
    }
    if (indicatorCondition === IndicatorStartConditionEnum.gt && !skipAction) {
      action = gt(last, value)
    }
    if (indicatorCondition === IndicatorStartConditionEnum.lt && !skipAction) {
      action = lt(last, value)
    }
    if (indicatorCondition === IndicatorStartConditionEnum.bw && !skipAction) {
      const upper =
        indicatorValue2 !== undefined && indicatorValue2 !== ''
          ? +indicatorValue2
          : NaN
      action =
        !isNaN(upper) &&
        gt(last, Math.min(value, upper)) &&
        lt(last, Math.max(value, upper))
    }

    if (
      ((lastData.type === IndicatorEnum.stoch &&
        prevData.type === IndicatorEnum.stoch) ||
        (lastData.type === IndicatorEnum.stochRSI &&
          prevData.type === IndicatorEnum.stochRSI)) &&
      action &&
      checkValue &&
      stochRange !== StochRangeEnum.none
    ) {
      const upper =
        stochRange === StochRangeEnum.lower
          ? 100
          : stochRange === StochRangeEnum.upper
            ? +(stochLower ?? '')
            : +(stochUpper ?? '')
      const lower =
        stochRange === StochRangeEnum.upper
          ? 0
          : stochRange === StochRangeEnum.lower
            ? +(stochUpper ?? '')
            : +(stochLower ?? '')
      action =
        !isNaN(upper) &&
        !isNaN(lower) &&
        ((last > upper && value > upper && prev > upper && prevValue > upper) ||
          (last < lower && value < lower && prev < lower && prevValue < lower))
    }
    if (trendFilter) {
      action = trendFilterAction && action
    }
    if (action && !trendFilter && !skipAction && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger. ${type} prev: ${prevDataString}, value prev: ${prevValue}, ${type} last: ${lastDataString}, value last: ${value} action: ${indicatorAction}, last time ${new Date(
          lastTime,
        )?.toISOString()}`,
      )
    }
    if (action && trendFilter && !skipAction && showLog) {
      ctx.debug(
        `${uuid}@${type}@${indicatorInterval}@${
          ctx.exchange
        }@${symbol} trigger. ${type} prev: ${prevDataString}, value prev: ${prevValue}, ${type} last: ${lastDataString}, value last: ${value} action: ${indicatorAction} ${type} trend value ${trendValue}, type: ${trendFilterType}, last time ${new Date(
          lastTime,
        )?.toISOString()}`,
      )
    }
  }

  return { action, compared: reported }
}
