/**
 * Oscillator smoothing on the GraphQL bot mutations: the same settings rules
 * the public API applies (`smoothingSettingsGaps`), then the stored shape
 * (`normalizeSmoothingFields`). Only `indicators` is read; a payload without
 * it, or whose entries carry none of the smoothing fields, passes through
 * unchanged.
 */
import { StatusEnum } from '../../../types'
import type { SettingsIndicators } from '../../../types'
import {
  normalizeSmoothingFields,
  smoothingIndicatorsError,
} from '../../indicators/conditions/smoothing'

type WithIndicators = { indicators?: SettingsIndicators[] | null }

type SmoothingRefusal = {
  status: StatusEnum.notok
  reason: string
  data: null
}

const refusal = (reason: string): SmoothingRefusal => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

// Any settings object: callers whose settings type has no `indicators` (an
// AI tool's patch) still pass, and their payload may carry one at runtime.
const indicatorsOf = (input: object | null | undefined) =>
  (input as WithIndicators | null | undefined)?.indicators

const normalizeIndicators = <T extends object>(input: T): T => {
  const sent = indicatorsOf(input)
  if (!Array.isArray(sent)) return input
  const indicators = sent.map(normalizeSmoothingFields)
  return indicators.some((i, n) => i !== sent[n])
    ? { ...input, indicators }
    : input
}

/** One bot's settings (create or change). */
export const checkBotSmoothing = <T extends object>(
  input: T,
): { input: T } | { error: SmoothingRefusal } => {
  const reason = smoothingIndicatorsError(indicatorsOf(input))
  if (reason) return { error: refusal(reason) }
  return { input: normalizeIndicators(input) }
}

/** A hedge bot's two legs; the refusal names the leg. */
export const checkHedgeBotSmoothing = <
  L extends object,
  T extends { long: L; short: L },
>(
  input: T,
): { input: T } | { error: SmoothingRefusal } => {
  const reasons = (['long', 'short'] as const).flatMap((side) => {
    const reason = smoothingIndicatorsError(indicatorsOf(input?.[side]))
    return reason
      ? [`${side === 'long' ? 'Long' : 'Short'} bot: ${reason}`]
      : []
  })
  if (reasons.length) return { error: refusal(reasons.join(' ')) }
  const long = normalizeIndicators(input.long)
  const short = normalizeIndicators(input.short)
  return {
    input:
      long === input.long && short === input.short
        ? input
        : { ...input, long, short },
  }
}
