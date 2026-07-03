import { STALE_THRESHOLD_MS, MAX_RECHECK_MS } from './utils'

export type LastAction = 'selfHeal' | 'escalate'

export interface WatchdogState {
  failureCount: number
  lastAction: LastAction | null
  nextCheckAt: number // epochMs
}

export const EMPTY_STATE: WatchdogState = {
  failureCount: 0,
  lastAction: null,
  nextCheckAt: 0,
}

export type WatchdogAction =
  | { type: 'triggerSelfHeal'; accountId: string }
  | { type: 'signalReconcile'; accountId: string }
  | { type: 'signalShowError'; accountId: string }

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
