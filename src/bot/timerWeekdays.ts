/**
 * Timer start on selected weekdays (`hodlWeekdays`, 0 = Sunday … 6 =
 * Saturday, in the user's timezone). Empty, missing or all seven means every
 * day. A run on another day opens no deal and the schedule moves to the next
 * selected day. Mirrors `@gainium/backtester` `dca/strategy/timer.ts`.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** The selected weekdays, or null when every day is allowed. */
export const allowedTimerWeekdays = (
  weekdays?: number[] | null,
): Set<number> | null => {
  const days = (Array.isArray(weekdays) ? weekdays : [])
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  const set = new Set(days)
  return set.size && set.size < 7 ? set : null
}

/**
 * The weekday a scheduled run falls on. A daily timer's `hodlNextBuy` only
 * carries a calendar date, read the way `findTimeDiff` reads it
 * (`toDateString`, process timezone), and runs at `hodlAt` on that date in the
 * user's timezone; an hourly one is an instant, read in the user's timezone.
 */
export const timerRunWeekday = (
  nextBuy: number,
  hourly: boolean,
  timeZone: string,
): number =>
  hourly
    ? WEEKDAYS.indexOf(
        new Date(nextBuy).toLocaleDateString('en-US', {
          timeZone,
          weekday: 'short',
        }),
      )
    : new Date(nextBuy).getDay()

export const isTimerRunAllowed = (
  nextBuy: number,
  hourly: boolean,
  timeZone: string,
  weekdays?: number[] | null,
): boolean => {
  const allowed = allowedTimerWeekdays(weekdays)
  return !allowed || allowed.has(timerRunWeekday(nextBuy, hourly, timeZone))
}

/**
 * `nextBuy`, or the first run after it on a selected weekday: a daily timer
 * moves a day at a time (it keeps its set time), an hourly one an hour at a
 * time, so it restarts at the first hour of the selected day.
 */
export const shiftToAllowedWeekday = (
  nextBuy: number,
  hourly: boolean,
  timeZone: string,
  weekdays?: number[] | null,
): number => {
  const allowed = allowedTimerWeekdays(weekdays)
  if (!allowed) {
    return nextBuy
  }
  let next = nextBuy
  for (
    let i = 0;
    i < 7 * 24 && !allowed.has(timerRunWeekday(next, hourly, timeZone));
    i++
  ) {
    next += hourly ? HOUR : DAY
  }
  return next
}
