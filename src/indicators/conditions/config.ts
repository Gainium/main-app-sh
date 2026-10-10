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
  ExchangeIntervals,
  IndicatorEnum,
  MAEnum,
  RangeType,
  TradingviewAnalysisConditionEnum,
} from '../../../types'
import type { IndicatorConfig, SettingsIndicators } from '../../../types'

/**
 * The indicator length the engine uses (default 14). The engine subscribes a
 * condition only when this and the timeframe are set (non-zero, not NaN).
 */
export const indicatorLengthOf = (i: SettingsIndicators): number =>
  +(i.indicatorLength ?? 14)

/** The timeframe the engine subscribes: ADR always runs daily. */
export const indicatorSubscribeInterval = (
  type: IndicatorEnum,
  indicatorInterval: ExchangeIntervals,
): ExchangeIntervals =>
  type === IndicatorEnum.adr ? ExchangeIntervals.oneD : indicatorInterval

export function buildIndicatorConfig(i: SettingsIndicators): IndicatorConfig {
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
  const leftBars = +(_leftBars ?? 5)
  const rightBars = +(_rightBars ?? 5)
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
  return type === IndicatorEnum.lw
    ? {
        type: IndicatorEnum.lw,
        lwThreshold: +(lwThreshold ?? 2),
        lwMaxDuration: +(lwMaxDuration ?? 1000),
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
                                        leftBars: leftBars ?? 15,
                                        rightBars: rightBars ?? 15,
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
                                              baseCrack: (baseCrack ?? 3) / 100,
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
                                                  source: momSource ?? 'close',
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
                                                      start: psarStart ?? 0.02,
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
                                                    : type === IndicatorEnum.kc
                                                      ? {
                                                          type,
                                                          interval:
                                                            indicatorLength,
                                                          ma:
                                                            kcMa || MAEnum.ema,
                                                          multiplier:
                                                            bbwMult || 2,
                                                          range:
                                                            kcRange ||
                                                            RangeType.atr,
                                                          rangeLength:
                                                            kcRangeLength || 20,
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
                                                                  bbwMult || 2,
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
