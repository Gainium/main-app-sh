process.env.NODE_ENV = 'testing'

/**
 * A "stop after X consecutive winning/losing deals" limit must count the
 * trailing run of closed deals only, and must not fire on a shorter history.
 *
 * Run: `npm test` (mocha) from `core/`.
 *
 * The distinction that matters is against the cumulative `closeAfterXwin` /
 * `closeAfterXloss` counters that already exist: those never reset, so a bot
 * with 3 wins scattered among 20 losses trips a 3-win cumulative limit. A
 * consecutive limit must not — one opposite outcome inside the window clears
 * the streak. The engine feeds outcomes NEWEST FIRST (a `closeTime`-descending
 * read), so index 0 is the deal that closed last.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { hasConsecutiveStreak } from './consecutiveStreak'

const W = true
const L = false

describe('hasConsecutiveStreak', () => {
  it('fires when the last `target` deals are all the wanted outcome', () => {
    expect(hasConsecutiveStreak([W, W, W], W, 3)).to.equal(true)
    expect(hasConsecutiveStreak([L, L, L], L, 3)).to.equal(true)
  })

  it('ignores anything older than the window', () => {
    expect(hasConsecutiveStreak([W, W, W, L, W, L], W, 3)).to.equal(true)
    expect(hasConsecutiveStreak([L, L, L, W, W, W], L, 3)).to.equal(true)
  })

  it('does not fire when an opposite outcome breaks the run', () => {
    // The newest deal lost: the win streak is 0, not 2.
    expect(hasConsecutiveStreak([L, W, W], W, 3)).to.equal(false)
    // The oldest deal in the window lost: the streak is 2, one short.
    expect(hasConsecutiveStreak([W, W, L], W, 3)).to.equal(false)
  })

  it('does not fire on a history shorter than the target', () => {
    // Every deal this bot ever closed was a win, but there have only been two.
    expect(hasConsecutiveStreak([W, W], W, 3)).to.equal(false)
    expect(hasConsecutiveStreak([], W, 1)).to.equal(false)
  })

  it('fires on a target of 1 as soon as one deal matches', () => {
    expect(hasConsecutiveStreak([W, L, L], W, 1)).to.equal(true)
    expect(hasConsecutiveStreak([L, W, W], W, 1)).to.equal(false)
  })

  it('never fires when the limit is off', () => {
    expect(hasConsecutiveStreak([W, W, W], W, 0)).to.equal(false)
    expect(hasConsecutiveStreak([W, W, W], W, -1)).to.equal(false)
  })

  it('treats the two directions as mutually exclusive on one window', () => {
    const outcomes = [W, W, W]
    expect(hasConsecutiveStreak(outcomes, W, 3)).to.equal(true)
    expect(hasConsecutiveStreak(outcomes, L, 3)).to.equal(false)
  })
})
