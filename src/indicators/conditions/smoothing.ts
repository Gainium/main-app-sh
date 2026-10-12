/**
 * Oscillator smoothing — mode resolution and operand selection, kept
 * identical to `@gainium/backtester` so the live engine, server-side
 * backtests and the dashboards' client-side backtests decide the same bars.
 *
 * In scope: SMOOTHABLE_INDICATORS, the value oscillators whose single main
 * line the value / percentile conditions read as `value`. When smoothing is
 * on the indicator emits `value` = S = MA(R) and `raw` = R.
 */
import { resolveSmoothing as resolveLibrarySmoothing } from '@gainium/indicators'
import {
  IndicatorEnum,
  IndicatorStartConditionEnum,
  SMOOTHABLE_INDICATORS,
  SMOOTHING_VALUES,
  SmoothingCompareEnum,
} from '../../../types'
import type { SettingsIndicators } from '../../../types'

/** Longest smoothing length the API accepts. */
export const SMOOTHING_MAX_LENGTH = 1000

export const isSmoothableIndicator = (type: unknown): type is IndicatorEnum =>
  (SMOOTHABLE_INDICATORS as readonly string[]).includes(`${type}`)

/**
 * The normalisation rule is the indicators library's own, so this side and
 * the indicator instance always agree on whether smoothing is on.
 */
export const resolveSmoothing = (
  type: unknown,
  length: unknown,
): { type: string; length: number } | null =>
  resolveLibrarySmoothing(
    typeof type === 'string' ? type : null,
    typeof length === 'number' || typeof length === 'string' ? length : null,
  )

/**
 * How an indicator entry is evaluated:
 * - `off`: no smoothing (or not a smoothable indicator) — unchanged behaviour.
 * - `value`: conditions (cu / cd / gt / lt / bw / percentile) read the
 *   smoothed line, which the indicator emits as `value`.
 * - `line`: the indicator's line is compared against its smoothed line.
 *   Percentile mode overrides `line` (evaluates as `value`).
 */
export type SmoothingMode = 'off' | 'value' | 'line'

export const getSmoothingMode = (
  settings: Pick<
    SettingsIndicators,
    'type' | 'smoothing' | 'smoothingLength' | 'smoothingCompare' | 'percentile'
  >,
): SmoothingMode => {
  if (
    !isSmoothableIndicator(settings.type) ||
    !resolveSmoothing(settings.smoothing, settings.smoothingLength)
  ) {
    return 'off'
  }
  if (
    !settings.percentile &&
    `${settings.smoothingCompare ?? ''}`.toLowerCase() ===
      SmoothingCompareEnum.line
  ) {
    return 'line'
  }
  return 'value'
}

/**
 * Smoothing fields for a smoothable indicator's config. Empty when smoothing
 * is off or the type is not smoothable, so an unsmoothed config — and the
 * indicator room id built from its values — is exactly what it was before.
 */
export const smoothingConfig = (
  settings: Pick<SettingsIndicators, 'type' | 'smoothing' | 'smoothingLength'>,
): { smoothing?: string; smoothingLength?: number } => {
  if (!isSmoothableIndicator(settings.type)) return {}
  const cfg = resolveSmoothing(settings.smoothing, settings.smoothingLength)
  return cfg ? { smoothing: cfg.type, smoothingLength: cfg.length } : {}
}

type SmoothedResult = { value: number; raw?: number }

/**
 * Operands for `line` mode, in the engine's crossing convention: `last` /
 * `prev` are the series being tested (the indicator's line, `raw`), `value`
 * / `prevValue` the reference it is tested against (the smoothed line).
 * Returns null when a bar lacks the raw reading, which then never fires.
 */
export const smoothingLineOperands = (
  lastValue: SmoothedResult,
  prevValue: SmoothedResult,
): { last: number; prev: number; value: number; prevValue: number } | null => {
  if (
    typeof lastValue?.raw !== 'number' ||
    typeof prevValue?.raw !== 'number'
  ) {
    return null
  }
  return {
    last: lastValue.raw,
    prev: prevValue.raw,
    value: lastValue.value,
    prevValue: prevValue.value,
  }
}

const isUnset = (v: unknown) => v === undefined || v === null || v === ''

export type SmoothingSettingsGap = {
  field: 'smoothing' | 'smoothingLength' | 'smoothingCompare'
  message: string
}

/**
 * Problems with the three smoothing fields, as the API rejects them: the
 * type must be `none` or one of the allowed averages (case-insensitive), the
 * length a whole number 1..1000, the compare mode `value` or `line`; `line`
 * cannot be combined with `bw` while smoothing is on; and an indicator that
 * cannot be smoothed refuses any smoothing other than `none`. Unset fields are
 * fine (smoothing off / defaults).
 */
export function smoothingSettingsGaps(
  i: Pick<
    SettingsIndicators,
    | 'type'
    | 'smoothing'
    | 'smoothingLength'
    | 'smoothingCompare'
    | 'percentile'
    | 'indicatorCondition'
  >,
): SmoothingSettingsGap[] {
  const gaps: SmoothingSettingsGap[] = []
  const type = isUnset(i.smoothing)
    ? null
    : `${i.smoothing}`.trim().toLowerCase()
  if (type !== null && !(SMOOTHING_VALUES as readonly string[]).includes(type))
    gaps.push({
      field: 'smoothing',
      message: `Choose a smoothing: ${SMOOTHING_VALUES.join(', ')}.`,
    })
  else if (type !== null && type !== 'none' && !isSmoothableIndicator(i.type))
    gaps.push({
      field: 'smoothing',
      message: `Smoothing is not available for ${i.type}.`,
    })
  // a numeric string is read as its number (as the indicators library does)
  const len =
    typeof i.smoothingLength === 'string'
      ? Number(i.smoothingLength)
      : i.smoothingLength
  if (
    !isUnset(i.smoothingLength) &&
    !(
      typeof len === 'number' &&
      Number.isInteger(len) &&
      len >= 1 &&
      len <= SMOOTHING_MAX_LENGTH
    )
  )
    gaps.push({
      field: 'smoothingLength',
      message: `Enter a whole number from 1 to ${SMOOTHING_MAX_LENGTH}.`,
    })
  if (
    !isUnset(i.smoothingCompare) &&
    !(Object.values(SmoothingCompareEnum) as string[]).includes(
      `${i.smoothingCompare}`.toLowerCase(),
    )
  )
    gaps.push({ field: 'smoothingCompare', message: 'Choose value or line.' })
  if (
    i.indicatorCondition === IndicatorStartConditionEnum.bw &&
    getSmoothingMode(i) === 'line'
  )
    gaps.push({
      field: 'smoothingCompare',
      message:
        'Between is not available when comparing with the smoothed line.',
    })
  return gaps
}

const SMOOTHING_FIELD_LABELS: Record<SmoothingSettingsGap['field'], string> = {
  smoothing: 'smoothing',
  smoothingLength: 'smoothing length',
  smoothingCompare: 'smoothing compare',
}

type SmoothingEntry = Partial<
  Pick<
    SettingsIndicators,
    | 'type'
    | 'smoothing'
    | 'smoothingLength'
    | 'smoothingCompare'
    | 'percentile'
    | 'indicatorCondition'
  >
>

/**
 * The smoothing problems of a bot's indicator list as one refusal reason, or
 * null when every entry passes `smoothingSettingsGaps`. Entries are numbered
 * from 1 in the order they were sent.
 */
export function smoothingIndicatorsError(
  indicators: readonly SmoothingEntry[] | null | undefined,
): string | null {
  const problems = (indicators ?? []).flatMap((i, n) =>
    i && typeof i === 'object'
      ? smoothingSettingsGaps(
          i as Parameters<typeof smoothingSettingsGaps>[0],
        ).map(
          (g) =>
            `Indicator ${n + 1} (${i.type}) ${SMOOTHING_FIELD_LABELS[g.field]}: ${g.message}`,
        )
      : [],
  )
  return problems.length ? problems.join(' ') : null
}

const SMOOTHING_FIELDS = [
  'smoothing',
  'smoothingLength',
  'smoothingCompare',
] as const

/**
 * The three smoothing fields as they are stored. Smoothing off — or a type
 * that cannot be smoothed — drops all three, so an unsmoothed indicator is
 * stored exactly as it was before the fields existed; smoothing on stores the
 * lower-case average, the whole length and the effective compare mode
 * (percentile reads as `value`). An entry carrying none of the fields is
 * returned as it is, the same object. Run it on settings that already passed
 * `smoothingSettingsGaps`.
 */
export function normalizeSmoothingFields<T extends SmoothingEntry>(i: T): T {
  if (!i || typeof i !== 'object' || !SMOOTHING_FIELDS.some((k) => k in i)) {
    return i
  }
  const {
    smoothing: _type,
    smoothingLength: _length,
    smoothingCompare: _compare,
    ...rest
  } = i
  const cfg = isSmoothableIndicator(i.type)
    ? resolveSmoothing(i.smoothing, i.smoothingLength)
    : null
  if (!cfg) return rest as T
  return {
    ...rest,
    smoothing: cfg.type,
    smoothingLength: cfg.length,
    smoothingCompare:
      getSmoothingMode(i as Parameters<typeof getSmoothingMode>[0]) === 'line'
        ? SmoothingCompareEnum.line
        : SmoothingCompareEnum.value,
  } as T
}
