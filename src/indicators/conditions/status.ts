/**
 * How long a condition's signal holds — the DCA engine's per-condition status
 * after each new bar, including the "keep condition for N bars" option. Pure:
 * `now` is a parameter and the state object is the caller's.
 *
 * Moved verbatim out of `bot/dcaHelper.ts` `checkIndicatorConditions`; the
 * characterization suite pins the status sequence for each N.
 */
import { ExchangeIntervals, timeIntervalMap } from '../../../types'

export type ConditionStatus = {
  status: boolean
  statusSince?: number
  statusTo?: number
}

/** `keepConditionBars` as the engine reads it: a non-negative number, else 0. */
export function keepConditionBarsMultiplier(keepConditionBars?: string) {
  return keepConditionBars
    ? isNaN(+keepConditionBars)
      ? 0
      : +keepConditionBars < 0
        ? 0
        : +keepConditionBars
    : 0
}

/**
 * Step `i` (mutated in place) with the signal of the bar opening at `barTime`.
 * `onExtendedPastNow` is told when a kept signal's end was already in the past
 * and is pushed one bar further (the engine logs it).
 */
export function applyConditionStatus(
  i: ConditionStatus,
  {
    action,
    barTime,
    indicatorInterval,
    keepConditionBars,
    now,
    onExtendedPastNow,
  }: {
    action: boolean
    barTime: number
    indicatorInterval: ExchangeIntervals
    keepConditionBars?: string
    now: number
    onExtendedPastNow?: (statusTo: number, step: number) => void
  },
): ConditionStatus {
  const toMultiplier = keepConditionBarsMultiplier(keepConditionBars)
  const step = timeIntervalMap[indicatorInterval]
  if (i.statusTo && i.statusTo < barTime + step) {
    i.statusTo = undefined
    i.statusSince = undefined
  }
  if (toMultiplier !== 0) {
    if (action) {
      i.statusSince = barTime + step
      i.statusTo = barTime + step * (2 + toMultiplier) - 1
      if (i.statusTo < now) {
        onExtendedPastNow?.(i.statusTo, step)
        i.statusTo += step
      }
      i.status = true
    } else {
      if (i.statusSince && i.statusTo) {
        i.statusSince += step
        if (i.statusSince > i.statusTo) {
          i.status = false
          i.statusSince = undefined
          i.statusTo = undefined
          i.statusTo = i.statusSince
        } else {
          i.status = true
        }
      } else {
        i.status = action
        i.statusTo = barTime + step * 2 - 1
      }
    }
  } else {
    i.status = action
    i.statusTo = barTime + step * 2 - 1
  }
  return i
}

/** Whether a condition's status counts as signalling at `now`. */
export const isConditionActive = (i: ConditionStatus, now: number) =>
  i.status && (i.statusTo ? i.statusTo >= now : true)
