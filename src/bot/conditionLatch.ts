/**
 * A latch for reporting a STANDING condition once instead of once per check.
 *
 * The bot engine re-evaluates some conditions on a loop — "can this account
 * fund a base order?" runs about once a minute per (bot, pair). When the answer
 * is no for a reason only the user can fix, nothing about that is news after the
 * first time, but every reporting path in `MainBot` is built for *events*:
 * `handleErrors` inserts a `botevents` document per call and `processError`'s
 * only repeat gate keys on `BotStatusEnum.error`, which a warning never sets. So
 * a condition that simply persists was reported forever — 8.3 M log lines and
 * 56 % of all `botevents` written in a day (spec 008 §2).
 *
 * Deduplicating on the rendered message does not work and must not be
 * attempted: those messages embed live numbers (`required`, `price`) that drift
 * every cycle while the condition itself is unchanged. The key has to name the
 * condition — a stable reason plus the pair it holds for.
 *
 * Deliberately in-memory, unlike {@link RetryBackoff}, which is Redis-backed
 * because it gates whether an ORDER reaches a venue and so must hold across
 * workers. This gates only whether a REPORT is written, and a bot lives in one
 * worker at a time, so a per-instance map is already per-(bot, condition). A
 * worker restart re-arms it and re-reports once, which is correct: the restarted
 * worker has no record that the user was ever told.
 */
export class ConditionLatch {
  /** key → when it was last reported (ms epoch). */
  private readonly reportedAt = new Map<string, number>()

  /**
   * @param reArmAfterMs Report again after the condition has held this long
   *   without clearing, so a persistent condition keeps whatever periodic
   *   reminder the user already gets. `0` disables the periodic re-arm, leaving
   *   a pure transition latch.
   */
  constructor(private readonly reArmAfterMs = 0) {}

  /**
   * True when this occurrence should be reported: the first time the condition
   * holds, and again once `reArmAfterMs` has elapsed while it kept holding.
   * False for every occurrence in between.
   */
  shouldReport(key: string, now: number): boolean {
    const last = this.reportedAt.get(key)
    if (last !== undefined) {
      if (this.reArmAfterMs <= 0 || now - last < this.reArmAfterMs) {
        return false
      }
    }
    this.reportedAt.set(key, now)
    return true
  }

  /**
   * The condition ended. The next occurrence is a new one and reports again.
   * Safe to call for a key that never fired — the common case, since callers
   * clear on the success path without knowing whether it ever failed.
   */
  clear(key: string): void {
    this.reportedAt.delete(key)
  }

  /** Number of conditions currently latched. For tests and diagnostics. */
  get size(): number {
    return this.reportedAt.size
  }
}

/**
 * Key a standing condition by what it IS — a stable internal reason and the
 * pair it holds for — never by the message rendered for it. Bot-level
 * conditions pass no symbol.
 */
export function standingConditionKey(reason: string, symbol?: string): string {
  return `${reason}|${symbol ?? ''}`
}

/** `openNewDeal` refused because the account cannot fund the base order. */
export const notEnoughBalanceNewDeal = 'notEnoughBalanceNewDeal'

/**
 * How long a standing condition may hold before it is reported again. Matches
 * the `logWindowSec: 86400` the `Cannot start deal` subType is already
 * configured with, so the user's existing daily reminder is unchanged while the
 * per-cycle repeats are gone.
 */
export const STANDING_CONDITION_REARM_MS = 24 * 60 * 60 * 1000
