import { STALE_THRESHOLD_MS, MAX_RECHECK_MS } from './utils'

export type LastAction = 'selfHeal' | 'escalate'

export interface WatchdogState {
  failureCount: number
  lastAction: LastAction | null
  nextCheckAt: number // epochMs
  /** Missed-fill failsafe escalation (§3.4): epochMs of the last self-heal
   *  triggered from the reconcile-sweep catch-rate path. Optional so old
   *  hashes without the field parse cleanly. */
  ffSelfHealAt?: number
  /** Missed-fill failsafe escalation: epochMs of the last INFORM USERS
   *  dispatched from the catch-rate path. */
  ffInformAt?: number
}

export const EMPTY_STATE: WatchdogState = {
  failureCount: 0,
  lastAction: null,
  nextCheckAt: 0,
}

export type WatchdogAction =
  | { type: 'triggerSelfHeal'; accountId: string; reason?: ActionReason }
  | { type: 'signalReconcile'; accountId: string; reason?: ActionReason }
  | { type: 'signalShowError'; accountId: string; reason?: ActionReason }

/** Which detector produced the action: whole-stream staleness, or the
 *  missed-fill catch-rate escalation (spec §3.4). Consumers may surface this
 *  to ops (admin watchdog notifications feed). */
export type ActionReason = 'stale' | 'catchRate'

interface TickInput {
  accountId: string
  now: number
  isStale: boolean // lastEventTime older than threshold
  hasConsumer: boolean // at least one bot listening
  state: WatchdogState
}

interface TickResult {
  nextState: WatchdogState | null // null = clear state entirely (healthy, no history to keep)
  actions: WatchdogAction[]
}

export function tick(input: TickInput): TickResult {
  const { accountId, now, isStale, hasConsumer, state } = input

  if (!hasConsumer) {
    return { nextState: null, actions: [] }
  }

  if (!isStale) {
    if (state.failureCount === 0) {
      return { nextState: null, actions: [] }
    }
    return {
      nextState: null, // clear history, back to healthy
      actions: [],
    }
  }

  if (state.nextCheckAt > now) {
    return { nextState: state, actions: [] }
  }

  const nextFailureCount = state.failureCount + 1
  const backoffMs = Math.min(
    STALE_THRESHOLD_MS * nextFailureCount,
    MAX_RECHECK_MS,
  )

  if (state.failureCount < 1) {
    return {
      nextState: {
        failureCount: nextFailureCount,
        lastAction: 'selfHeal',
        nextCheckAt: now + backoffMs,
      },
      actions: [
        { type: 'triggerSelfHeal', accountId },
        { type: 'signalReconcile', accountId },
      ],
    }
  }

  return {
    nextState: {
      failureCount: nextFailureCount,
      lastAction: 'escalate',
      nextCheckAt: now + backoffMs,
    },
    actions:
      state.failureCount === 1
        ? [{ type: 'signalShowError', accountId } as WatchdogAction]
        : [],
  }
}

/**
 * Missed-fill failsafe escalation (spec §3.4). A second, independent signal
 * source: chronic reconcile-sweep catches on an account mean the user stream
 * is silently dropping fills even though it isn't whole-stream stale, so the
 * staleness state machine above never fires for it. This escalates the
 * *root cause* (self-heal the stream, then inform the user) without touching
 * the staleness failureCount / backoff.
 *
 * Pure: given the catch counts + current state + now it returns the actions to
 * dispatch and the two ff* fields to persist. It never emits signalReconcile —
 * the detector that produced these catches already reconciled the orders.
 */
export interface CatchRateThresholds {
  windowMs: number // FF_ESCALATE_WINDOW_MS
  selfHealN: number // FF_ESCALATE_SELFHEAL_N
  informN: number // FF_ESCALATE_INFORM_N
}

interface CatchRateTickInput {
  accountId: string
  now: number
  /** reconcilesweepcatches count for this account over the whole window. */
  catchCountWindow: number
  /** reconcilesweepcatches count for this account since ffSelfHealAt (0 if
   *  no self-heal in window). */
  catchCountSinceSelfHeal: number
  state: WatchdogState
  thresholds: CatchRateThresholds
}

interface CatchRateTickResult {
  /** ff* field changes to merge onto the existing hash (undefined = leave the
   *  field untouched — the staleness fields are never modified here). */
  ffSelfHealAt?: number
  ffInformAt?: number
  actions: WatchdogAction[]
}

export function catchRateTick(input: CatchRateTickInput): CatchRateTickResult {
  const {
    accountId,
    now,
    catchCountWindow,
    catchCountSinceSelfHeal,
    state,
    thresholds,
  } = input

  const actions: WatchdogAction[] = []
  const result: CatchRateTickResult = { actions }

  const selfHealInWindow =
    typeof state.ffSelfHealAt === 'number' &&
    state.ffSelfHealAt > now - thresholds.windowMs
  const informInWindow =
    typeof state.ffInformAt === 'number' &&
    state.ffInformAt > now - thresholds.windowMs

  // 1. Enough catches in the window and no self-heal yet → self-heal once.
  if (catchCountWindow >= thresholds.selfHealN && !selfHealInWindow) {
    actions.push({ type: 'triggerSelfHeal', accountId, reason: 'catchRate' })
    result.ffSelfHealAt = now
    return result
  }

  // 2. Already self-healed and still catching → inform the user once.
  if (
    selfHealInWindow &&
    !informInWindow &&
    catchCountSinceSelfHeal >= thresholds.informN
  ) {
    actions.push({ type: 'signalShowError', accountId, reason: 'catchRate' })
    result.ffInformAt = now
  }

  return result
}
