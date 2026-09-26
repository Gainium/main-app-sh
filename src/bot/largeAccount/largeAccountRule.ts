/**
 * Large account mode — the pure decision (main-app spec 019 §2).
 *
 * The v2 dashboard stops doing per-row client work for accounts whose bot or
 * deal counts would make that work scale past a frame. Whether an account is
 * "large" is decided here, per trading context, from three counts, with
 * hysteresis so an account hovering at a threshold does not flip modes as bots
 * start and stop, and with a tri-state override on the user.
 *
 * No I/O: counts and the previously decided state are passed in.
 */

export type LargeAccountOverride = 'auto' | 'on' | 'off'
export type LargeAccountOverrideBy = 'user' | 'admin'
export type LargeAccountSignal = 'bots' | 'openDeals' | 'terminalBots'
export type LargeAccountReason = LargeAccountSignal | 'override'

export type LargeAccountCounts = {
  activeBots: number
  openDeals: number
  terminalBots: number
}

export type LargeAccountThreshold = { enter: number; leave: number }

export type LargeAccountThresholds = {
  activeBots: LargeAccountThreshold
  openDeals: LargeAccountThreshold
  terminalBots: LargeAccountThreshold
}

/** Leave below 80 % of the enter value (spec §2.1). */
const withHysteresis = (enter: number): LargeAccountThreshold => ({
  enter,
  leave: Math.floor(enter * 0.8),
})

export const LARGE_ACCOUNT_THRESHOLDS: LargeAccountThresholds = {
  activeBots: withHysteresis(400),
  openDeals: withHysteresis(1000),
  terminalBots: withHysteresis(1000),
}

const SIGNALS: { key: keyof LargeAccountCounts; reason: LargeAccountSignal }[] =
  [
    { key: 'activeBots', reason: 'bots' },
    { key: 'openDeals', reason: 'openDeals' },
    { key: 'terminalBots', reason: 'terminalBots' },
  ]

export const normalizeOverride = (value: unknown): LargeAccountOverride =>
  value === 'on' || value === 'off' ? value : 'auto'

/**
 * The automatic rule alone. `previouslyActive` is the last AUTOMATIC decision
 * for this context (not the override): once active, the account stays active
 * until every count is below its `leave` value.
 */
export const evaluateAutoLargeAccount = (
  counts: LargeAccountCounts,
  previouslyActive: boolean,
  thresholds: LargeAccountThresholds = LARGE_ACCOUNT_THRESHOLDS,
): { active: boolean; reason: LargeAccountSignal | null } => {
  for (const { key, reason } of SIGNALS) {
    const bound = previouslyActive
      ? thresholds[key].leave
      : thresholds[key].enter
    if ((counts[key] ?? 0) >= bound) {
      return { active: true, reason }
    }
  }
  return { active: false, reason: null }
}

export type LargeAccountDecision = {
  active: boolean
  source: 'auto' | 'override'
  reason: LargeAccountReason | null
  /** The automatic decision, persisted as the hysteresis memory. */
  autoActive: boolean
}

export const decideLargeAccount = (
  counts: LargeAccountCounts,
  previouslyAutoActive: boolean,
  override: LargeAccountOverride,
  thresholds: LargeAccountThresholds = LARGE_ACCOUNT_THRESHOLDS,
): LargeAccountDecision => {
  const auto = evaluateAutoLargeAccount(
    counts,
    previouslyAutoActive,
    thresholds,
  )
  if (override === 'on') {
    return {
      active: true,
      source: 'override',
      reason: 'override',
      autoActive: auto.active,
    }
  }
  if (override === 'off') {
    return {
      active: false,
      source: 'override',
      reason: null,
      autoActive: auto.active,
    }
  }
  return {
    active: auto.active,
    source: 'auto',
    reason: auto.reason,
    autoActive: auto.active,
  }
}

/**
 * What a USER (not an admin) may do with the override (spec §2.3, Ares Q3):
 * switch the mode ON, and undo their own ON. Never OFF, and never touch a
 * value an admin set.
 */
export const userModeChange = (
  current: { override: LargeAccountOverride; by?: LargeAccountOverrideBy },
  requested: string,
):
  | {
      ok: true
      override: LargeAccountOverride
      by: LargeAccountOverrideBy | null
    }
  | { ok: false; reason: string } => {
  const adminSet = current.override !== 'auto' && current.by === 'admin'
  if (requested === 'on') {
    if (adminSet && current.override !== 'on') {
      return {
        ok: false,
        reason: 'Large account mode is set by support for this account',
      }
    }
    if (current.override === 'on') {
      return { ok: true, override: 'on', by: current.by ?? 'user' }
    }
    return { ok: true, override: 'on', by: 'user' }
  }
  if (requested === 'auto') {
    if (current.override === 'auto') {
      return { ok: true, override: 'auto', by: null }
    }
    if (adminSet || current.override !== 'on') {
      return {
        ok: false,
        reason: 'Large account mode is set by support for this account',
      }
    }
    return { ok: true, override: 'auto', by: null }
  }
  if (requested === 'off') {
    return {
      ok: false,
      reason: 'Large account mode cannot be switched off from the dashboard',
    }
  }
  return { ok: false, reason: `Unknown mode ${requested}` }
}

export const userCanEnable = (override: LargeAccountOverride) =>
  override === 'auto'

export const userCanRevert = (
  override: LargeAccountOverride,
  by?: LargeAccountOverrideBy | null,
) => override === 'on' && by === 'user'
