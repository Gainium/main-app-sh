process.env.NODE_ENV = 'testing'

/**
 * Timer start on selected weekdays (`hodlWeekdays`).
 * Run: `npm test` (mocha). Expects the process timezone to be UTC, like prod.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  allowedTimerWeekdays,
  isTimerRunAllowed,
  shiftToAllowedWeekday,
} from './timerWeekdays'

const HOUR = 3600e3
// a daily timer stores the run's date at UTC noon
const SAT_NOON = Date.UTC(2026, 9, 17, 12)
const MON_NOON = Date.UTC(2026, 9, 19, 12)
const WEEKDAYS = [1, 2, 3, 4, 5]

describe('timer weekdays', () => {
  it('empty, missing, invalid or all seven means every day', () => {
    expect(allowedTimerWeekdays(undefined)).to.equal(null)
    expect(allowedTimerWeekdays([])).to.equal(null)
    expect(allowedTimerWeekdays([0, 1, 2, 3, 4, 5, 6])).to.equal(null)
    expect(allowedTimerWeekdays([7, -1, 1.5])).to.equal(null)
    expect([...allowedTimerWeekdays([1, 1, 3])!]).to.deep.equal([1, 3])
  })

  it('a daily run on an unselected day is not allowed and moves to the next selected day', () => {
    expect(isTimerRunAllowed(SAT_NOON, false, 'Asia/Tokyo', WEEKDAYS)).to.equal(
      false,
    )
    expect(shiftToAllowedWeekday(SAT_NOON, false, 'UTC', WEEKDAYS)).to.equal(
      MON_NOON,
    )
    expect(shiftToAllowedWeekday(MON_NOON, false, 'UTC', WEEKDAYS)).to.equal(
      MON_NOON,
    )
    expect(shiftToAllowedWeekday(SAT_NOON, false, 'UTC', [])).to.equal(SAT_NOON)
  })

  it('an hourly run reads its weekday in the user timezone and restarts at the first hour of the next selected day', () => {
    // Fri 2026-10-16 16:00 UTC is already Saturday 01:00 in Tokyo
    const fri16 = Date.UTC(2026, 9, 16, 16)
    expect(isTimerRunAllowed(fri16, true, 'UTC', WEEKDAYS)).to.equal(true)
    expect(isTimerRunAllowed(fri16, true, 'Asia/Tokyo', WEEKDAYS)).to.equal(
      false,
    )
    // Monday 00:00 in Tokyo = Sun 15:00 UTC
    expect(shiftToAllowedWeekday(fri16, true, 'Asia/Tokyo', WEEKDAYS)).to.equal(
      Date.UTC(2026, 9, 18, 15),
    )
    expect(shiftToAllowedWeekday(fri16 + HOUR, true, 'UTC', WEEKDAYS)).to.equal(
      fri16 + HOUR,
    )
  })
})
