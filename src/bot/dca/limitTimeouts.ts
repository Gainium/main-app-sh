/** How often an unfilled LIMIT order is repositioned to the market. */
export const limitRepositionIntervalMs = 10_000

/**
 * The market fallback the engine has always applied to a bot-driven LIMIT
 * close when the bot's own "Enter Market Timeout" did not override it. Not a
 * base-order default: the entry timer is opt-in (spec `100`).
 */
export const defaultLimitFallbackMs = 35_000

/** What the derivation reads — the bot's aggregated settings. */
export type LimitTimeoutSettings = {
  useLimitTimeout?: boolean | null
  limitTimeout?: string | null
}

export type LimitTimeouts = {
  /** Reposition interval for an unfilled LIMIT order; `0` = never reposition. */
  orderLimitRepositionTimeout: number
  /**
   * When an unfilled LIMIT base order is sent at market; `0` = never. Only
   * the "Enter Market Timeout" switch arms it.
   */
  enterMarketTimeout: number
  /**
   * The same timeout as the engine derived it before spec `100`, for the paths
   * the base-order switch does not govern: the close-by-limit market fallback
   * and the settled-base-entry top-up window (spec `057`).
   */
  limitFallbackTimeout: number
}

/**
 * Derive a DCA bot's LIMIT-order timeouts from its settings.
 *
 * Switch off, or on with no usable seconds: no entry timer, and the order is
 * repositioned indefinitely (unless the bot disabled repositioning). Switch on
 * with N s: enter at market after N s, and a timeout shorter than the
 * reposition interval disables repositioning. Spec `100` §4.1–§4.3.
 */
export function resolveLimitTimeouts(
  settings: LimitTimeoutSettings,
): LimitTimeouts {
  let userMs: number | null = null
  if (settings.useLimitTimeout && settings.limitTimeout) {
    const ms = parseFloat(settings.limitTimeout) * 1000
    userMs = isNaN(ms) ? 0 : ms
  }
  return {
    orderLimitRepositionTimeout:
      userMs && userMs < limitRepositionIntervalMs
        ? 0
        : limitRepositionIntervalMs,
    enterMarketTimeout: userMs ?? 0,
    limitFallbackTimeout: userMs ?? defaultLimitFallbackMs,
  }
}
