/**
 * Trailing guard — the invariant an ARMED trail must never break.
 *
 * Once a trailing take profit (or trailing stop loss) is armed, its level is
 * the best price since arming moved by the trail width. The current price can
 * only be at or behind that best price, so the level can never sit further
 * from the current price than one trail width:
 *
 *   long:  level >= last * (1 - p)        short: level <= last * (1 + p)
 *
 * (and the same with the stop-loss percentage for a trailing stop loss). A
 * level beyond that has stopped following the price — whatever the cause: a
 * stale `bestPrice`, a write lost to a replaced deal copy, a restore. The
 * guard compares against the engine's OWN level formula at `last`, so it can
 * never ask for a level the engine would not have set itself on this tick.
 *
 * Mode, read from Redis at runtime so it can change without a restart:
 *   - `shadow` (default): report the lag, change nothing — the dry run.
 *   - `enforce`: move the level (and `bestPrice`) up to the current price.
 *   - `off`: do nothing.
 *
 * PURE: no I/O here. The engine reads the mode and does the logging.
 */
import { TrailingModeEnum } from '../../../types'

export type TrailingGuardMode = 'off' | 'shadow' | 'enforce'

/** Redis key holding the mode. Absent or unrecognised means `shadow`. */
export const TRAILING_GUARD_MODE_KEY = 'gainium:trailingGuard:mode'

/** How long a worker trusts the mode it read before reading it again. */
export const TRAILING_GUARD_MODE_TTL_MS = 60_000

/**
 * Relative lag ignored as float noise. The engine computes the level from the
 * same formula, so a real stale level lags by at least one tick's move.
 */
export const TRAILING_LAG_TOLERANCE = 0.0001

/** A worker reports the same deal at most this often. */
export const TRAILING_GUARD_REPORT_INTERVAL_MS = 10 * 60_000

export function parseTrailingGuardMode(
  raw: string | null | undefined,
): TrailingGuardMode {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  return v === 'off' || v === 'enforce' ? v : 'shadow'
}

/**
 * The level the engine itself would set at `last` for this trail — the
 * tightest level an armed trail may hold. `null` when the mode or percentage
 * gives nothing to compare against.
 */
export function levelAt(opts: {
  mode: TrailingModeEnum | string | undefined | null
  long: boolean
  last: number
  trailingTpPerc?: string | number | null
  slPerc?: string | number | null
}): number | null {
  const { mode, long, last } = opts
  if (!(last > 0)) return null
  const longMult = long ? 1 : -1
  if (mode === TrailingModeEnum.ttp) {
    const p = Number(opts.trailingTpPerc)
    if (!(p > 0)) return null
    return last * (1 - (p / 100) * longMult)
  }
  if (mode === TrailingModeEnum.tsl) {
    const p = Number(opts.slPerc)
    if (!p || !isFinite(p)) return null
    return last * (1 + (p / 100) * longMult)
  }
  return null
}

/**
 * How far `level` lags behind `expected`, as a fraction of `expected`.
 * Positive only when the level has fallen behind the price (below it for a
 * long, above it for a short); 0 otherwise.
 */
export function trailingLag(
  level: number,
  expected: number,
  long: boolean,
): number {
  if (!(level > 0) || !(expected > 0)) return 0
  const lag = long
    ? (expected - level) / expected
    : (level - expected) / expected
  return lag > 0 ? lag : 0
}
