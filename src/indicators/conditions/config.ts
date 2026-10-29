/**
 * `SettingsIndicators` → the indicator-service subscription the DCA engine
 * makes for a condition: the indicator config (whose key order and values
 * form the service's room id, so identical settings share one room), the
 * timeframe, and the reference series of MA-vs-MA and cross-oscillator
 * conditions. Pure.
 *
 * Moved verbatim out of `bot/dcaHelper.ts` `connectSettingsIndicator`; the
 * characterization suite pins the engine's configs per type.
 */
import {
  resolveCandleSource,
  resolveOBSwingLength,
  resolveSqueezeSettings,
  resolveVWAPAnchor,
} from '@gainium/indicators'
import {
  ADXModeEnum,
  CandleSourceEnum,
  ExchangeIntervals,
  IndicatorEnum,
  MAEnum,
  PCCompareEnum,
  RangeType,
  SessionRuleEnum,
  TradingviewAnalysisConditionEnum,
  VWAPAnchorEnum,
} from '../../../types'
import type { IndicatorConfig, SettingsIndicators } from '../../../types'
import { smoothingConfig } from './smoothing'

/**
 * The indicator length the engine uses (default 14). The engine subscribes a
 * condition only when this and the timeframe are set (non-zero, not NaN).
 */
export const indicatorLengthOf = (i: SettingsIndicators): number =>
  +(i.indicatorLength ?? 14)

/**
 * A Session indicator with the Price levels rule: unlike the in / out rules
 * (a clock filter), it compares session price levels and is evaluated from
 * the candles of a `SessionLevels` indicator room.
 */
export const isSessionLevels = (
  i: Pick<SettingsIndicators, 'type' | 'sessionRule'>,
): boolean =>
  i.type === IndicatorEnum.session && i.sessionRule === SessionRuleEnum.levels

/** The timeframe the engine subscribes: ADR always runs daily. */
export const indicatorSubscribeInterval = (
  type: IndicatorEnum,
  indicatorInterval: ExchangeIntervals,
): ExchangeIntervals =>
  type === IndicatorEnum.adr ? ExchangeIntervals.oneD : indicatorInterval

/** An ADX condition in DMI mode (+DI against −DI). */
export const isAdxDmi = (
  i: Pick<SettingsIndicators, 'type' | 'adxMode'>,
): boolean => i.type === IndicatorEnum.adx && i.adxMode === ADXModeEnum.dmi

/** A Moving Average condition with the trend filter on. */
export const isMaTrendFilter = (
  i: Pick<SettingsIndicators, 'type' | 'trendFilter'>,
): boolean => i.type === IndicatorEnum.ma && !!i.trendFilter

export function buildIndicatorConfig(i: SettingsIndicators): IndicatorConfig {
  // A smoothable oscillator's smoothing is appended only when it is on, so
  // the room id of an unsmoothed indicator (built from the config's values
  // in key order) is unchanged and a smoothed one gets its own room.
  return {
    ...withIndicatorModes(i, unsmoothedIndicatorConfig(i)),
    ...smoothingConfig(i),
  }
}

/**
 * Modes added on existing types, appended to that type's config only when
 * they are on — so with them off the config (and the room id) is exactly the
 * one before, and with them on the instance gets its own room:
 *  - Moving Average trend filter: `@gainium/indicators` builds MATrendFilter
 *    (result `{ value, trend }`) instead of the plain MA;
 *  - ADX DMI mode: the ADX result also carries +DI / −DI.
 */
function withIndicatorModes(
  i: SettingsIndicators,
  config: IndicatorConfig,
): IndicatorConfig {
  if (config.type === IndicatorEnum.ma && isMaTrendFilter(i))
    return {
      ...config,
      trendFilter: i.trendFilter,
      trendFilterLookback: i.trendFilterLookback,
      trendFilterType: i.trendFilterType,
      trendFilterValue: i.trendFilterValue,
    }
  if (config.type === IndicatorEnum.adx && isAdxDmi(i))
    return { ...config, dmi: true } as IndicatorConfig
  if (config.type === IndicatorEnum.div) {
    const pivots = divergencePivotConfig(i)
    if (Object.keys(pivots).length) return { ...config, ...pivots }
  }
  return config
}

/**
 * A Divergence whose bars range between two pivots is empty (lower bound not
 * below the upper one, after the DIV defaults 1 / 60): it never finds a pair.
 */
export function divergenceRangeInvalid(
  i: Pick<SettingsIndicators, 'type' | 'divRangeLower' | 'divRangeUpper'>,
): boolean {
  if (i.type !== IndicatorEnum.div) return false
  const { rangeLower = 1, rangeUpper = 60 } = divergencePivotConfig(i)
  return !(rangeLower < rangeUpper)
}

/**
 * Price Change `bw` (between): why it can never fire, or null. Needs a
 * second value (pcValue2) with the same sign as pcValue (missing = '5') and
 * a different absolute value — `priceChangeCondition` returns false
 * otherwise. Other compares have no cross-field rule.
 */
export function priceChangeRangeProblem(
  i: Pick<SettingsIndicators, 'type' | 'pcCompare' | 'pcValue' | 'pcValue2'>,
): string | null {
  if (i.type !== IndicatorEnum.pc || i.pcCompare !== PCCompareEnum.bw)
    return null
  const v1 = +(i.pcValue ?? '5')
  const v2 = setNumber(i.pcValue2) ?? NaN
  if (!Number.isFinite(v1) || !Number.isFinite(v2))
    return 'Between needs a second value (pcValue2).'
  if (!((v1 > 0 && v2 > 0) || (v1 < 0 && v2 < 0)))
    return 'pcValue and pcValue2 must both be positive (up move) or both negative (down move).'
  if (Math.abs(v1) === Math.abs(v2))
    return 'pcValue and pcValue2 must be different.'
  return null
}

/** A stored optional number: missing / null / '' is unset (undefined). */
const setNumber = (
  v: number | string | null | undefined,
): number | undefined =>
  v === undefined || v === null || v === '' ? undefined : +v

/**
 * Divergence pivot / range settings as the DIV config's `leftBars`,
 * `rightBars`, `rangeLower`, `rangeUpper` — only the ones that are set, so a
 * Divergence without them keeps exactly the room it always had (the DIV then
 * runs on its defaults 3 / 1 / 1 / 60, as before).
 */
export function divergencePivotConfig(
  i: Pick<
    SettingsIndicators,
    'divPivotLeft' | 'divPivotRight' | 'divRangeLower' | 'divRangeUpper'
  >,
): {
  leftBars?: number
  rightBars?: number
  rangeLower?: number
  rangeUpper?: number
} {
  const fields = {
    leftBars: setNumber(i.divPivotLeft),
    rightBars: setNumber(i.divPivotRight),
    rangeLower: setNumber(i.divRangeLower),
    rangeUpper: setNumber(i.divRangeUpper),
  }
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  )
}

function unsmoothedIndicatorConfig(i: SettingsIndicators): IndicatorConfig {
  const {
    indicatorLength: _indicatorLength,
    type,
    checkLevel: _checkLevel,
    condition,
    maType,
    stochSmoothD: _stochSmoothD,
    stochSmoothK: _stochSmoothK,
    stochRSI: _stochRSI,
    leftBars: _leftBars,
    rightBars: _rightBars,
    basePeriods: _basePeriods,
    pumpPeriods: _pumpPeriods,
    pump: _pump,
    baseCrack: _baseCrack,
    psarInc: _psarInc,
    psarMax: _psarMax,
    psarStart: _psarStart,
    voLong: _voLong,
    voShort: _voShort,
    uoFast: _uoFast,
    uoMiddle: _uoMiddle,
    uoSlow: _uoSlow,
    momSource,
    bbwpLookback,
    xOscillator1,
    percentile,
    mar1length: _mar1length,
    mar1type,
    mar2length,
    mar2type,
    bbwMa,
    bbwMaLength: _bbwMaLength,
    bbwMult: _bbwMult,
    macdFast: _macdFast,
    macdSlow: _macdSlow,
    macdMaSignal,
    macdMaSource,
    divOscillators,
    trendFilter,
    trendFilterLookback,
    trendFilterType,
    trendFilterValue,
    factor: _factor,
    atrLength: _atrLength,
    pcValue,
    ppHighLeft,
    ppHighRight,
    ppLowLeft,
    ppLowRight,
    ppMult,
    athLookback: _athLookback,
    kcMa,
    kcRange,
    kcRangeLength: _kcRangeLength,
    lwMaxDuration,
    lwThreshold,
    oteLeftBars,
    oteMinLegSize,
    kdjLength,
    kdjKSmooth,
    kdjDSmooth,
    vwapAnchor,
    candleSource,
    obSwingLength,
    sqzLength,
    sqzBBMult,
    sqzKCLength,
    sqzKCMult,
    sessionDays,
    sessionStart,
    sessionEnd,
    sessionTimezone,
  } = i
  let { percentileLookback, percentilePercentage } = i
  percentileLookback = percentileLookback ?? 150
  percentilePercentage = percentilePercentage ?? 80
  const macdFast = +(_macdFast ?? 12)
  const macdSlow = +(_macdSlow ?? 26)
  const indicatorLength = +(_indicatorLength ?? 14)
  const factor = +(_factor ?? 3)
  const atrLength = +(_atrLength ?? 10)

  const checkLevel = +(_checkLevel ?? 0)
  const athLookback = +(_athLookback ?? 100)
  const stochSmoothD = +(_stochSmoothD ?? 3)
  const stochSmoothK = +(_stochSmoothK ?? 3)
  const stochRSI = +(_stochRSI ?? 14)
  // Support & Resistance's pivot bars; 15 as in the form, the API defaults
  // and the backtester (5 here made a row without them a different study)
  const leftBars = +(_leftBars ?? 15)
  const rightBars = +(_rightBars ?? 15)
  const mar1length = +(_mar1length ?? 20)
  const basePeriods = +(_basePeriods ?? 36)
  const pumpPeriods = +(_pumpPeriods ?? 8)
  const uoFast = +(_uoFast ?? 7)
  const uoMiddle = +(_uoMiddle ?? 14)
  const uoSlow = +(_uoSlow ?? 28)
  const psarInc = +(_psarInc ?? 0.02)
  const psarMax = +(_psarMax ?? 0.2)
  const psarStart = +(_psarStart ?? 0.02)
  const voLong = +(_voLong ?? 10)
  const voShort = +(_voShort ?? 5)
  const bbwMult = +(_bbwMult ?? 2)
  const kcRangeLength = +(_kcRangeLength ?? 20)
  const bbwMaLength = +(_bbwMaLength ?? 20)
  const pump = +(_pump ?? 3)
  const baseCrack = +(_baseCrack ?? 3)
  // Price levels: only the session window shapes the levels; A, B and the
  // condition are read by the decision, so they share one room.
  if (isSessionLevels(i))
    return {
      type: IndicatorEnum.session,
      sessionRule: SessionRuleEnum.levels,
      sessionDays: [...(sessionDays ?? [1, 2, 3, 4, 5])]
        .map(Number)
        .sort((a, b) => a - b),
      sessionStart: sessionStart || '',
      sessionEnd: sessionEnd || '',
      sessionTimezone: sessionTimezone || 'UTC',
    }
  // KDJ: the three lengths shape the lines; line, compare-to, level and
  // zone are read by the decision. VWAP: only the anchor shapes it (the band
  // multiplier is the decision's), so conditions differing only in line or
  // multiplier share one room.
  if (type === IndicatorEnum.kdj)
    return {
      type: IndicatorEnum.kdj,
      kdjLength: +(kdjLength || 9),
      kdjKSmooth: +(kdjKSmooth || 3),
      kdjDSmooth: +(kdjDSmooth || 3),
    }
  if (type === IndicatorEnum.vwap)
    return {
      type: IndicatorEnum.vwap,
      vwapAnchor: resolveVWAPAnchor(vwapAnchor) as string as VWAPAnchorEnum,
    }
  // Candle colour, Order Blocks, Squeeze Momentum: only the math's
  // parameters, normalised as the indicators package's factory reads them
  // (so equivalent settings share one room); colour / count / trigger,
  // side / level and signal / momentum are read by the decision.
  if (type === IndicatorEnum.candle)
    return {
      type: IndicatorEnum.candle,
      source: resolveCandleSource(candleSource) as string as CandleSourceEnum,
    }
  if (type === IndicatorEnum.ob)
    return {
      type: IndicatorEnum.ob,
      swingLength: resolveOBSwingLength(obSwingLength),
    }
  if (type === IndicatorEnum.sqz)
    return {
      type: IndicatorEnum.sqz,
      ...resolveSqueezeSettings(sqzLength, sqzBBMult, sqzKCLength, sqzKCMult),
    }
  return type === IndicatorEnum.lw
    ? {
        type: IndicatorEnum.lw,
        lwThreshold: +(lwThreshold ?? 2),
        lwMaxDuration: +(lwMaxDuration ?? 1000),
      }
    : type === IndicatorEnum.ote
      ? {
          type: IndicatorEnum.ote,
          oteLeftBars: +(oteLeftBars || 10),
          oteMinLegSize: +(oteMinLegSize || 1),
        }
      : type === IndicatorEnum.obfvg
        ? { type }
        : type === IndicatorEnum.dc
          ? { type, length: indicatorLength }
          : type === IndicatorEnum.macd
            ? {
                type,
                shortInterval: macdFast ?? 12,
                longInterval: macdSlow ?? 26,
                signalInterval: indicatorLength,
                percentile,
                percentileLookback,
                percentilePercentage,
                maSignal: macdMaSignal ?? MAEnum.ema,
                maSource: macdMaSource ?? MAEnum.ema,
              }
            : type === IndicatorEnum.st
              ? {
                  type,
                  factor: factor ?? 3,
                  atrLength: atrLength ?? 10,
                }
              : type === IndicatorEnum.pp
                ? {
                    type,
                    ppHighLeft: +(ppHighLeft ?? 5),
                    ppHighRight: +(ppHighRight ?? 5),
                    ppLowLeft: +(ppLowLeft ?? 5),
                    ppLowRight: +(ppLowRight ?? 5),
                    ppMult: +(ppMult ?? 1),
                  }
                : type === IndicatorEnum.tv
                  ? {
                      type,
                      checkLevel,
                      useAsEntryExitPoints:
                        condition === TradingviewAnalysisConditionEnum.entry,
                    }
                  : type === IndicatorEnum.pc
                    ? {
                        type,
                        pcUp: Math.abs(+(pcValue ?? '5')),
                        pcDown: Math.abs(+(pcValue ?? '5')),
                      }
                    : type === IndicatorEnum.div
                      ? {
                          type,
                          oscillators: divOscillators ?? [],
                        }
                      : type === IndicatorEnum.ma
                        ? {
                            type,
                            interval: indicatorLength,
                            maType: maType || MAEnum.ema,
                          }
                        : type === IndicatorEnum.ath
                          ? {
                              type,
                              lookback: athLookback ?? 100,
                            }
                          : type === IndicatorEnum.xo
                            ? xOscillator1 === IndicatorEnum.vo
                              ? {
                                  type: xOscillator1,
                                  voLong: voLong ?? 10,
                                  voShort: voShort ?? 5,
                                }
                              : {
                                  type: xOscillator1 || IndicatorEnum.rsi,
                                  interval: indicatorLength,
                                }
                            : type === IndicatorEnum.atr
                              ? {
                                  type,
                                  interval: indicatorLength,
                                }
                              : type === IndicatorEnum.adr
                                ? {
                                    type,
                                    interval: indicatorLength,
                                  }
                                : type === IndicatorEnum.stoch
                                  ? {
                                      type,
                                      k: indicatorLength,
                                      dsmooth: stochSmoothD ?? 1,
                                      ksmooth: stochSmoothK ?? 3,
                                    }
                                  : type === IndicatorEnum.stochRSI
                                    ? {
                                        type,
                                        k: indicatorLength,
                                        dsmooth: stochSmoothD ?? 3,
                                        ksmooth: stochSmoothK ?? 3,
                                        interval: stochRSI ?? 14,
                                      }
                                    : type === IndicatorEnum.sr
                                      ? {
                                          type,
                                          leftBars,
                                          rightBars,
                                        }
                                      : type === IndicatorEnum.mar
                                        ? {
                                            type,
                                            mar1type: mar1type || MAEnum.ema,
                                            mar1length: mar1length || 20,
                                            mar2type: mar2type || MAEnum.price,
                                            mar2length: mar2length || 20,
                                            percentile,
                                            percentileLookback,
                                            percentilePercentage,
                                            trendFilter,
                                            trendFilterLookback,
                                            trendFilterType,
                                            trendFilterValue,
                                          }
                                        : type === IndicatorEnum.mfi
                                          ? {
                                              type,
                                              interval: indicatorLength ?? 14,
                                              percentile,
                                              percentileLookback,
                                              percentilePercentage,
                                            }
                                          : type === IndicatorEnum.qfl
                                            ? {
                                                type,
                                                basePeriods: basePeriods ?? 36,
                                                pumpPeriods: pumpPeriods ?? 8,
                                                pump: (pump ?? 3) / 100,
                                                baseCrack:
                                                  (baseCrack ?? 3) / 100,
                                              }
                                            : type === IndicatorEnum.uo
                                              ? {
                                                  type,
                                                  fast: uoFast ?? 7,
                                                  middle: uoMiddle ?? 14,
                                                  slow: uoSlow ?? 28,
                                                  percentile,
                                                  percentileLookback,
                                                  percentilePercentage,
                                                }
                                              : type === IndicatorEnum.mom
                                                ? {
                                                    type,
                                                    interval: indicatorLength,
                                                    source:
                                                      momSource ?? 'close',
                                                    percentile,
                                                    percentileLookback,
                                                    percentilePercentage,
                                                  }
                                                : type === IndicatorEnum.bbwp
                                                  ? {
                                                      type,
                                                      interval: indicatorLength,
                                                      source:
                                                        momSource ?? 'close',
                                                      lookback:
                                                        bbwpLookback ?? 252,
                                                    }
                                                  : type === IndicatorEnum.psar
                                                    ? {
                                                        type,
                                                        start:
                                                          psarStart ?? 0.02,
                                                        inc: psarInc ?? 0.02,
                                                        max: psarMax ?? 0.2,
                                                      }
                                                    : type === IndicatorEnum.vo
                                                      ? {
                                                          type,
                                                          voLong: voLong ?? 10,
                                                          voShort: voShort ?? 5,
                                                          percentile,
                                                          percentileLookback,
                                                          percentilePercentage,
                                                        }
                                                      : type ===
                                                          IndicatorEnum.kc
                                                        ? {
                                                            type,
                                                            interval:
                                                              indicatorLength,
                                                            ma:
                                                              kcMa ||
                                                              MAEnum.ema,
                                                            multiplier:
                                                              bbwMult || 2,
                                                            range:
                                                              kcRange ||
                                                              RangeType.atr,
                                                            rangeLength:
                                                              kcRangeLength ||
                                                              20,
                                                          }
                                                        : type ===
                                                            IndicatorEnum.kcpb
                                                          ? {
                                                              type,
                                                              interval:
                                                                indicatorLength,
                                                              ma:
                                                                kcMa ||
                                                                MAEnum.ema,
                                                              multiplier:
                                                                bbwMult || 2,
                                                              range:
                                                                kcRange ||
                                                                RangeType.atr,
                                                              rangeLength:
                                                                kcRangeLength ||
                                                                20,
                                                              percentile,
                                                              percentileLookback,
                                                              percentilePercentage,
                                                            }
                                                          : type ===
                                                              IndicatorEnum.bb
                                                            ? {
                                                                type,
                                                                interval:
                                                                  indicatorLength,
                                                                bbwMa:
                                                                  bbwMa ||
                                                                  MAEnum.sma,
                                                                bbwMaLength:
                                                                  bbwMaLength ||
                                                                  20,
                                                                bbwMult:
                                                                  bbwMult || 2,
                                                              }
                                                            : type ===
                                                                IndicatorEnum.bbw
                                                              ? {
                                                                  type,
                                                                  interval:
                                                                    indicatorLength,
                                                                  bbwMa:
                                                                    bbwMa ||
                                                                    MAEnum.sma,
                                                                  bbwMaLength:
                                                                    bbwMaLength ||
                                                                    20,
                                                                  bbwMult:
                                                                    bbwMult ||
                                                                    2,
                                                                  percentile,
                                                                  percentileLookback,
                                                                  percentilePercentage,
                                                                }
                                                              : type ===
                                                                  IndicatorEnum.bbpb
                                                                ? {
                                                                    type,
                                                                    interval:
                                                                      indicatorLength,
                                                                    bbwMa:
                                                                      bbwMa ||
                                                                      MAEnum.sma,
                                                                    bbwMaLength:
                                                                      bbwMaLength ||
                                                                      20,
                                                                    bbwMult:
                                                                      bbwMult ||
                                                                      2,
                                                                    percentile,
                                                                    percentileLookback,
                                                                    percentilePercentage,
                                                                  }
                                                                : type ===
                                                                    IndicatorEnum.ecd
                                                                  ? {
                                                                      type,
                                                                    }
                                                                  : ({
                                                                      type,
                                                                      interval:
                                                                        indicatorLength,
                                                                      percentile,
                                                                      percentileLookback,
                                                                      percentilePercentage,
                                                                    } as IndicatorConfig)
}

/** The second MA of an MA-vs-MA condition (`maCrossingValue` is not price). */
export const buildMaCrossReferenceConfig = (
  i: SettingsIndicators,
): IndicatorConfig =>
  ({
    type: i.type,
    interval: i.maCrossingLength,
    maType: i.maCrossingValue,
  }) as IndicatorConfig

/** The second oscillator of a cross-oscillator condition. */
export function buildXoReferenceConfig(i: SettingsIndicators): IndicatorConfig {
  const { xOscillator2, xOscillator2voLong, xOscillator2voShort } = i
  const indicatorLength = +(i.indicatorLength ?? 14)
  const voLong = +(i.voLong ?? 10)
  const voShort = +(i.voShort ?? 5)
  const xOscillator2length = +(i.xOscillator2length ?? 14)
  return xOscillator2 === IndicatorEnum.vo
    ? {
        type: xOscillator2,
        voLong: xOscillator2voLong ?? voLong ?? 10,
        voShort: xOscillator2voShort ?? voShort ?? 5,
      }
    : {
        type: xOscillator2 || IndicatorEnum.mfi,
        interval: xOscillator2length || indicatorLength,
      }
}

export type ReferenceSubscription = {
  /** the engine key prefix of the reference series (`maUUID` / `xoUUID`) */
  uuid: string
  config: IndicatorConfig
  interval: ExchangeIntervals
}

/**
 * The reference series a condition is compared against, when its settings
 * define one — the same settings test the engine applies before subscribing
 * it (the engine additionally skips it for its own risk-reward and adaptive
 * order conditions).
 */
export function referenceSubscription(
  i: SettingsIndicators,
): ReferenceSubscription | null {
  const {
    type,
    maCrossingValue,
    maCrossingInterval,
    maCrossingLength,
    maUUID,
    xOscillator2,
    xOscillator2Interval,
    xoUUID,
    indicatorInterval,
  } = i
  const xOscillator2length = +(i.xOscillator2length ?? 14)
  if (
    type === IndicatorEnum.ma &&
    maCrossingValue !== MAEnum.price &&
    maCrossingInterval &&
    maCrossingLength &&
    maUUID &&
    maCrossingValue
  )
    return {
      uuid: maUUID,
      config: buildMaCrossReferenceConfig(i),
      interval: maCrossingInterval,
    }
  if (
    type === IndicatorEnum.xo &&
    xOscillator2 &&
    xOscillator2Interval &&
    xOscillator2length &&
    xoUUID
  )
    return {
      uuid: xoUUID,
      config: buildXoReferenceConfig(i),
      interval: xOscillator2Interval || indicatorInterval,
    }
  return null
}
