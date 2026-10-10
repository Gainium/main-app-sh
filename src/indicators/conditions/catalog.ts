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
} from '../../../types'
import type { SettingsIndicators } from '../../../types'
import { indicatorLengthOf, referenceSubscription } from './config'

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
}

/** Every type `evaluateIndicatorCondition` evaluates from room bars. */
export const ROOM_CONDITION_TYPES: IndicatorEnum[] = (
  Object.keys(INDICATOR_CONDITION_KINDS) as IndicatorEnum[]
).filter((t) => INDICATOR_CONDITION_KINDS[t].source === 'room')

export const isRoomConditionType = (t: unknown): t is IndicatorEnum =>
  typeof t === 'string' &&
  INDICATOR_CONDITION_KINDS[t as IndicatorEnum]?.source === 'room'

/** Bars the decision needs before it can signal (1 or 2). */
export const barsNeeded = (type: IndicatorEnum): 1 | 2 =>
  INDICATOR_CONDITION_KINDS[type]?.newestBarOnly ? 1 : 2

/** Types decided by their own rule rather than by a value comparison. */
const OWN_RULE_TYPES = [
  IndicatorEnum.obfvg,
  IndicatorEnum.pc,
  IndicatorEnum.lw,
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
  if (OWN_RULE_TYPES.includes(type)) return gaps
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
  if (
    type !== IndicatorEnum.ma &&
    (i.indicatorValue === undefined || isNaN(+i.indicatorValue))
  )
    gaps.push({ field: 'indicatorValue', message: 'Enter a value.' })
  if (indicatorCondition === IndicatorStartConditionEnum.bw) {
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
