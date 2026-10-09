/**
 * Is a price tick older than the deal's latest fill? (spec 142)
 *
 * A fill is a trade the venue executed at its `updateTime`. A tick the venue
 * stamped before that says nothing about the market after it — when the feed
 * lags, it is a price the market has already left. Trailing must not arm or
 * move on it.
 *
 * Both times are the venue's own clock in milliseconds. No recorded fill, or a
 * tick without a usable time, is never "before": those keep today's behaviour.
 *
 * PURE: no I/O here.
 */
export const isTickBeforeLatestFill = (
  tickTime: number | undefined,
  latestFillTime: number | undefined,
): boolean =>
  latestFillTime !== undefined &&
  Number.isFinite(latestFillTime) &&
  tickTime !== undefined &&
  Number.isFinite(tickTime) &&
  tickTime < latestFillTime
