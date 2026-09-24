/**
 * Rate policy for the log line `updateUserBalance` writes when the connector
 * answers a balance refresh with `NOTOK`.
 *
 * That branch used to be silent: nothing stored, nothing logged, so a
 * connection whose balance call the venue refused showed as connected with no
 * balances and left no trace of why. Logging every occurrence is the opposite
 * failure — the snapshot cron refreshes every user every few minutes, so a
 * venue that is simply down would write one line per connection per run.
 *
 * Same shape as the bot-error `coalesce` log policy: the first occurrence is
 * written in full, repeats inside the window are only counted, and the count
 * is reported once the window rolls. Occurrences are grouped by
 * `(provider, reason)`, which is what tells the two cases apart:
 * - one connection refused for its own reason (a key missing a permission)
 *   gets its own line, once per window;
 * - a venue outage returns the same reason for every connection on it, so
 *   only the first `perGroupConnections` get their own line and the rest are
 *   folded into the group's summary.
 *
 * In-process on purpose: this gates a log line, not an alert or a write, so
 * one line per worker per window is fine and a Redis round trip is not.
 */

export type BalanceFailureSummary = {
  provider: string
  reason: string
  /** Occurrences suppressed during the window. */
  failures: number
  /** Distinct connections among them. */
  connections: number
  windowMinutes: number
}

export type BalanceFailureNote = {
  /** Write the full per-connection line for this occurrence. */
  log: boolean
  /** Windows that closed with suppressed occurrences, to report now. */
  summaries: BalanceFailureSummary[]
}

type Group = {
  provider: string
  reason: string
  windowStart: number
  logged: Set<string>
  suppressed: Set<string>
  failures: number
}

export class BalanceFailureLog {
  private groups: Map<string, Group> = new Map()
  private lastSweep = 0

  constructor(
    private readonly windowMs = 60 * 60e3,
    private readonly perGroupConnections = 5,
  ) {}

  note(
    provider: string,
    reason: string,
    connection: string,
    now = Date.now(),
  ): BalanceFailureNote {
    const summaries: BalanceFailureSummary[] = []
    // Reasons can carry venue text that varies, so closed groups are swept
    // rather than left to accumulate; the sweep also reports their counts.
    if (now - this.lastSweep >= this.windowMs) {
      this.lastSweep = now
      for (const [key, g] of this.groups) {
        if (now - g.windowStart >= this.windowMs) {
          this.groups.delete(key)
          const s = this.summarize(g)
          if (s) {
            summaries.push(s)
          }
        }
      }
    }
    const key = `${provider}\u0000${reason}`
    let group = this.groups.get(key)
    if (group && now - group.windowStart >= this.windowMs) {
      const s = this.summarize(group)
      if (s) {
        summaries.push(s)
      }
      group = undefined
    }
    if (!group) {
      group = {
        provider,
        reason,
        windowStart: now,
        logged: new Set(),
        suppressed: new Set(),
        failures: 0,
      }
      this.groups.set(key, group)
    }
    if (
      !group.logged.has(connection) &&
      group.logged.size < this.perGroupConnections
    ) {
      group.logged.add(connection)
      return { log: true, summaries }
    }
    group.failures++
    group.suppressed.add(connection)
    return { log: false, summaries }
  }

  private summarize(g: Group): BalanceFailureSummary | null {
    if (g.failures === 0) {
      return null
    }
    return {
      provider: g.provider,
      reason: g.reason,
      failures: g.failures,
      connections: g.suppressed.size,
      windowMinutes: Math.round(this.windowMs / 60e3),
    }
  }
}
