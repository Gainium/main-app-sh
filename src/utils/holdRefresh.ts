/**
 * A hold only the REST balance refresh can see (core spec 070).
 *
 * Kraken spot's user stream reports the wallet TOTAL and carries no hold
 * (websocket-connector-sh spec 002), so `locked` moves only when
 * `updateUserBalance` calls the connector. That happens on connect and on the
 * snapshot cron — hours apart — which leaves a freshly rested order's funds
 * counted as spendable until then, and (since spec 069) a released hold
 * subtracted from `free` long after its order is gone.
 *
 * The order events arrive on the same Redis channel as the balance events, so
 * a refresh can be driven off them. One refresh per connection per window: a
 * ladder that rests twenty orders in a burst, or a deal that fills and
 * re-places, costs one connector call, not twenty.
 */

import { ExchangeEnum } from '../../types'

/**
 * Venues whose stream reports a total with no hold. Everything else already
 * streams `locked`, so an order-driven refresh would be pure extra load.
 */
export const holdFromRestOnly: ReadonlySet<ExchangeEnum> = new Set([
  ExchangeEnum.kraken,
])

/**
 * Long enough that a burst of executions collapses into one call, short enough
 * that the hold is visible well before the next deal-start check.
 */
export const holdRefreshWindowMs = 5000

export type HoldRefreshOptions = {
  windowMs?: number
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (timer: NodeJS.Timeout) => void
  onError?: (uuid: string, error: unknown) => void
}

export type HoldRefresh = {
  /**
   * Returns true when this event scheduled a refresh — false when the event is
   * not an order event, the venue streams its own hold, or a refresh for this
   * connection is already pending.
   */
  schedule(
    provider: ExchangeEnum,
    uuid: string,
    eventType: string | undefined,
    run: () => Promise<unknown> | unknown,
  ): boolean
  /** Drop a pending refresh for a connection that is going away. */
  cancel(uuid: string): void
  pending(): number
}

export function createHoldRefresh({
  windowMs = holdRefreshWindowMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError,
}: HoldRefreshOptions = {}): HoldRefresh {
  const timers: Map<string, NodeJS.Timeout> = new Map()

  return {
    schedule(provider, uuid, eventType, run) {
      if (eventType !== 'executionReport') {
        return false
      }
      if (!holdFromRestOnly.has(provider)) {
        return false
      }
      // Trailing edge, leading-event window: the first event of a burst starts
      // the clock and the rest ride on it, so the refresh reads the state the
      // whole burst left behind rather than the state mid-burst.
      if (timers.has(uuid)) {
        return false
      }
      timers.set(
        uuid,
        setTimer(() => {
          timers.delete(uuid)
          // A failed refresh must not take the stream handler down with it;
          // the next order event schedules another.
          Promise.resolve()
            .then(run)
            .catch((error) => onError?.(uuid, error))
        }, windowMs),
      )
      return true
    },
    cancel(uuid) {
      const timer = timers.get(uuid)
      if (timer) {
        clearTimer(timer)
        timers.delete(uuid)
      }
    },
    pending: () => timers.size,
  }
}
