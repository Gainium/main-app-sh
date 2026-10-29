/**
 * Which indicator types can be evaluated as a condition from indicator-room
 * data alone, and what settings a condition needs before the decision in
 * `evaluate.ts` can ever signal. Every `IndicatorEnum` value must be listed
 * (the `Record` type makes a missing one a compile error, and
 * `catalog.spec.ts` checks it again at runtime): adding an indicator means
 * deciding here how it is evaluated.
 */
import {
  IndicatorEnum,
  IndicatorStartConditionEnum,
  MAEnum,
  SessionLevelEnum,
  SqzMomentumEnum,
  SqzSignalEnum,
} from '../../../types'
import type { SettingsIndicators } from '../../../types'
import {
  divergenceRangeInvalid,
  priceChangeRangeProblem,
  indicatorLengthOf,
  isAdxDmi,
  isSessionLevels,
  referenceSubscription,
} from './config'
import { getSmoothingMode, smoothingSettingsGaps } from './smoothing'

export type IndicatorConditionSource =
  /** evaluated by `evaluateIndicatorCondition` from the indicator room's bars */
  | 'room'
  /** needs the bot's open deals (unrealized P&L) — bot-only */
  | 'deal'
  /** a time-of-day rule, not an indicator-service room — bot-only */
  | 'clock'
  /** the engine defines no comparison for it; not offered as a condition */
  | 'none'

export type IndicatorConditionKind = {
  source: IndicatorConditionSource
  /** the decision reads only the newest bar (otherwise it needs two) */
  newestBarOnly?: boolean
}

export const INDICATOR_CONDITION_KINDS: Record<
  IndicatorEnum,
  IndicatorConditionKind
> = {
  [IndicatorEnum.rsi]: { source: 'room' },
  [IndicatorEnum.adx]: { source: 'room' },
  [IndicatorEnum.bbw]: { source: 'room' },
  [IndicatorEnum.bb]: { source: 'room' },
  [IndicatorEnum.macd]: { source: 'room' },
  [IndicatorEnum.stoch]: { source: 'room' },
  [IndicatorEnum.cci]: { source: 'room' },
  [IndicatorEnum.ao]: { source: 'room' },
  [IndicatorEnum.stochRSI]: { source: 'room' },
  [IndicatorEnum.wr]: { source: 'room' },
  [IndicatorEnum.bullBear]: { source: 'none' },
  [IndicatorEnum.uo]: { source: 'room' },
  [IndicatorEnum.ic]: { source: 'none' },
  [IndicatorEnum.tv]: { source: 'room', newestBarOnly: true },
  [IndicatorEnum.ma]: { source: 'room' },
  [IndicatorEnum.sr]: { source: 'room' },
  [IndicatorEnum.qfl]: { source: 'room', newestBarOnly: true },
  [IndicatorEnum.mfi]: { source: 'room' },
  [IndicatorEnum.psar]: { source: 'room' },
  [IndicatorEnum.vo]: { source: 'room' },
  [IndicatorEnum.mom]: { source: 'room' },
  [IndicatorEnum.bbwp]: { source: 'room' },
  [IndicatorEnum.ecd]: { source: 'room', newestBarOnly: true },
  [IndicatorEnum.xo]: { source: 'room' },
  [IndicatorEnum.mar]: { source: 'room' },
  [IndicatorEnum.bbpb]: { source: 'room' },
  [IndicatorEnum.div]: { source: 'room', newestBarOnly: true },
  [IndicatorEnum.st]: { source: 'room' },
  [IndicatorEnum.pc]: { source: 'room', newestBarOnly: true },
  [IndicatorEnum.atr]: { source: 'room' },
  [IndicatorEnum.pp]: { source: 'room' },
  [IndicatorEnum.adr]: { source: 'room' },
  [IndicatorEnum.ath]: { source: 'room' },
  [IndicatorEnum.kc]: { source: 'room' },
  [IndicatorEnum.kcpb]: { source: 'room' },
  [IndicatorEnum.unpnl]: { source: 'deal' },
  [IndicatorEnum.dc]: { source: 'room' },
  [IndicatorEnum.obfvg]: { source: 'room' },
  [IndicatorEnum.session]: { source: 'clock' },
  [IndicatorEnum.lw]: { source: 'room' },
  [IndicatorEnum.ote]: { source: 'room' },
  [IndicatorEnum.kdj]: { source: 'room' },
  [IndicatorEnum.vwap]: { source: 'room' },
  [IndicatorEnum.candle]: { source: 'room', newestBarOnly: true },
  [IndicatorEnum.ob]: { source: 'room' },
  [IndicatorEnum.sqz]: { source: 'room' },
}

/**
 * Every type a bot can run as a condition, in `IndicatorEnum` order. The
 * public API accepts and advertises only these: a `source: 'none'` type would
 * be stored as a condition that never signals.
 */
export const CONDITION_INDICATOR_TYPES: IndicatorEnum[] = Object.values(
  IndicatorEnum,
).filter((t) => INDICATOR_CONDITION_KINDS[t].source !== 'none')

/** Every type `evaluateIndicatorCondition` evaluates from room bars. */
export const ROOM_CONDITION_TYPES: IndicatorEnum[] = (
  Object.keys(INDICATOR_CONDITION_KINDS) as IndicatorEnum[]
).filter((t) => INDICATOR_CONDITION_KINDS[t].source === 'room')

export const isRoomConditionType = (t: unknown): t is IndicatorEnum =>
  typeof t === 'string' &&
  INDICATOR_CONDITION_KINDS[t as IndicatorEnum]?.source === 'room'

const SESSION_LEVELS_KIND: IndicatorConditionKind = { source: 'room' }

/**
 * The condition kind of one configured indicator. It is the kind of its type
 * (`INDICATOR_CONDITION_KINDS`), except for a Session, whose rule decides:
 * in / out (missing = in) stay a `clock` rule, Price levels is a `room`
 * condition. The bot engine subscribes and evaluates by this. Per-type users
 * (automations, `ROOM_CONDITION_TYPES`) keep the type's kind, so a Session
 * stays bot-only whatever its rule.
 */
export const conditionKindOf = (
  i: Pick<SettingsIndicators, 'type' | 'sessionRule'>,
): IndicatorConditionKind | undefined =>
  isSessionLevels(i) ? SESSION_LEVELS_KIND : INDICATOR_CONDITION_KINDS[i.type]

/** Decided by the bot's clock (Session in / out), not by an indicator room. */
export const isClockCondition = (
  i: Pick<SettingsIndicators, 'type' | 'sessionRule'>,
): boolean => conditionKindOf(i)?.source === 'clock'

/** Bars the decision needs before it can signal (1 or 2). */
export const barsNeeded = (type: IndicatorEnum): 1 | 2 =>
  INDICATOR_CONDITION_KINDS[type]?.newestBarOnly ? 1 : 2

/** Types decided by their own rule rather than by a value comparison. */
const OWN_RULE_TYPES = [
  IndicatorEnum.obfvg,
  IndicatorEnum.pc,
  IndicatorEnum.lw,
  IndicatorEnum.ote,
  IndicatorEnum.kdj,
  IndicatorEnum.vwap,
  IndicatorEnum.candle,
  IndicatorEnum.ob,
  IndicatorEnum.sqz,
  IndicatorEnum.st,
  IndicatorEnum.div,
  IndicatorEnum.qfl,
]

export type ConditionSettingsGap = {
  field: keyof SettingsIndicators
  message: string
}

/**
 * Settings with which `evaluateIndicatorCondition` can never signal (the
 * engine silently never fires them), or which the engine would not
 * subscribe. Empty = the condition is evaluable. Derived from the branches
 * of the decision, so it follows them.
 */
export function conditionSettingsGaps(
  i: SettingsIndicators,
): ConditionSettingsGap[] {
  const gaps: ConditionSettingsGap[] = []
  const { type, indicatorCondition } = i
  const len = indicatorLengthOf(i)
  if (!len) gaps.push({ field: 'indicatorLength', message: 'Enter a length.' })
  if (!i.indicatorInterval)
    gaps.push({ field: 'indicatorInterval', message: 'Choose a timeframe.' })
  gaps.push(...smoothingSettingsGaps(i))
  if (type === IndicatorEnum.kdj) {
    // kdjCondition: missing line = k, compare-to = d; the same line on both
    // sides never fires
    if ((i.kdjLine ?? 'k') === (i.kdjCompareTo ?? 'd'))
      gaps.push({
        field: 'kdjCompareTo',
        message: 'Choose a different line or a level to compare with.',
      })
    return gaps
  }
  if (type === IndicatorEnum.sqz) {
    // squeezeCondition: missing signal = fired, momentum = positive; both
    // 'any' never fires
    if (
      (i.sqzSignal ?? SqzSignalEnum.fired) === SqzSignalEnum.any &&
      (i.sqzMomentum ?? SqzMomentumEnum.positive) === SqzMomentumEnum.any
    )
      gaps.push({
        field: 'sqzMomentum',
        message: 'Choose a squeeze state or a momentum.',
      })
    return gaps
  }
  if (type === IndicatorEnum.ob) {
    // orderBlockCondition: missing condition = cd; only cd/cu/gt/lt fire
    if (
      indicatorCondition !== undefined &&
      indicatorCondition !== IndicatorStartConditionEnum.cd &&
      indicatorCondition !== IndicatorStartConditionEnum.cu &&
      indicatorCondition !== IndicatorStartConditionEnum.gt &&
      indicatorCondition !== IndicatorStartConditionEnum.lt
    )
      gaps.push({ field: 'indicatorCondition', message: 'Choose a condition.' })
    return gaps
  }
  if (type === IndicatorEnum.pc) {
    // priceChangeCondition: bw needs pcValue2 with pcValue's sign and a
    // different size, else it never fires
    const problem = priceChangeRangeProblem(i)
    if (problem) gaps.push({ field: 'pcValue2', message: problem })
    return gaps
  }
  if (divergenceRangeInvalid(i)) {
    gaps.push({
      field: 'divRangeUpper',
      message: 'The upper range must be above the lower range.',
    })
    return gaps
  }
  if (OWN_RULE_TYPES.includes(type)) return gaps
  if (isAdxDmi(i)) {
    // DMI mode reads +DI against −DI only; indicatorValue is not read
    if (
      indicatorCondition !== IndicatorStartConditionEnum.cd &&
      indicatorCondition !== IndicatorStartConditionEnum.cu &&
      indicatorCondition !== IndicatorStartConditionEnum.gt &&
      indicatorCondition !== IndicatorStartConditionEnum.lt
    )
      gaps.push({ field: 'indicatorCondition', message: 'Choose a condition.' })
    return gaps
  }
  if (isSessionLevels(i)) {
    // sessionLevelsCondition: missing A = price, B = prevHigh, condition = cu
    const levels = Object.values(SessionLevelEnum) as string[]
    const a = i.sessionLevelA ?? SessionLevelEnum.price
    const b = i.sessionLevelB ?? SessionLevelEnum.prevHigh
    if (!levels.includes(a))
      gaps.push({ field: 'sessionLevelA', message: 'Choose a level.' })
    if (!levels.includes(b) || a === b)
      gaps.push({
        field: 'sessionLevelB',
        message: 'Choose a different level to compare with.',
      })
    if (
      indicatorCondition !== undefined &&
      indicatorCondition !== IndicatorStartConditionEnum.cd &&
      indicatorCondition !== IndicatorStartConditionEnum.cu &&
      indicatorCondition !== IndicatorStartConditionEnum.gt &&
      indicatorCondition !== IndicatorStartConditionEnum.lt
    )
      gaps.push({ field: 'indicatorCondition', message: 'Choose a condition.' })
    return gaps
  }
  if (type === IndicatorEnum.tv) {
    if (!i.checkLevel)
      gaps.push({ field: 'checkLevel', message: 'Choose a level.' })
    if (!i.signal) gaps.push({ field: 'signal', message: 'Choose a signal.' })
    return gaps
  }
  if (type === IndicatorEnum.ecd) {
    if (!i.ecdTrigger)
      gaps.push({ field: 'ecdTrigger', message: 'Choose a trigger.' })
    return gaps
  }
  // every other type goes through the value comparison
  if (
    !indicatorCondition ||
    !Object.values(IndicatorStartConditionEnum).includes(indicatorCondition)
  )
    gaps.push({ field: 'indicatorCondition', message: 'Choose a condition.' })
  // an oscillator vs its smoothed line compares two series; no value is read
  const smoothedLine = getSmoothingMode(i) === 'line'
  if (
    type !== IndicatorEnum.ma &&
    !smoothedLine &&
    (i.indicatorValue === undefined || isNaN(+i.indicatorValue))
  )
    gaps.push({ field: 'indicatorValue', message: 'Enter a value.' })
  if (indicatorCondition === IndicatorStartConditionEnum.bw && !smoothedLine) {
    const upper =
      i.indicatorValue2 !== undefined && i.indicatorValue2 !== ''
        ? +i.indicatorValue2
        : NaN
    if (isNaN(upper))
      gaps.push({ field: 'indicatorValue2', message: 'Enter an upper value.' })
  }
  if (
    type === IndicatorEnum.ma &&
    i.maCrossingValue !== MAEnum.price &&
    !referenceSubscription(i)
  )
    gaps.push({
      field: 'maCrossingValue',
      message: 'Choose what the moving average is compared with.',
    })
  if (type === IndicatorEnum.xo) {
    if (!i.xOscillator1)
      gaps.push({ field: 'xOscillator1', message: 'Choose an oscillator.' })
    if (!referenceSubscription(i))
      gaps.push({
        field: 'xOscillator2',
        message: 'Choose the oscillator to compare with.',
      })
  }
  return gaps
}
