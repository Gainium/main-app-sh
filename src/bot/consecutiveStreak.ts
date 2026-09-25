/**
 * Does the bot's recent run of closed deals end in a streak of one outcome?
 *
 * `outcomes` is the bot's most recently closed deals ordered NEWEST FIRST,
 * `true` for a deal that closed in profit. `win` picks which outcome the
 * streak must consist of and `target` how many of them it takes.
 *
 * Two things this deliberately does not do:
 *  - it does not fire on a shorter run. `outcomes.length >= target` means a bot
 *    whose whole history is 2 wins never trips a 3-win limit, even though every
 *    deal it ever closed was a win.
 *  - it does not look past `target`. The streak is the trailing run only, so a
 *    single opposite outcome anywhere inside the window resets it — that reset
 *    is the whole difference between this and the cumulative `closeAfterXwin` /
 *    `closeAfterXloss` counters.
 *
 * `target <= 0` means the limit is off and never triggers.
 */
export const hasConsecutiveStreak = (
  outcomes: boolean[],
  win: boolean,
  target: number,
): boolean =>
  target > 0 &&
  outcomes.length >= target &&
  outcomes.slice(0, target).every((o) => o === win)

export default hasConsecutiveStreak
