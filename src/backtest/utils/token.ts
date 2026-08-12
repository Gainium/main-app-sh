import crypto from 'crypto'
import { INTERNAL_API_SECRET, JWT_SECRET } from '../../config'

/**
 * Shared secret for the backtest callbacks main-app makes to itself
 * (`/api/serverSideBacktest`, `/api/serverSideBacktestSaveFile`).
 *
 * Those routes are registered above `app.use(authenticateJWT)`, so the global
 * middleware never sees them — deliberately, because the backtest worker calls
 * them host-to-host with no user token and moving them below the middleware
 * would break server-side backtests. They therefore have to carry their own
 * check, which is what this provides.
 *
 * Cloud does the same thing with a constant pair compiled into its (private)
 * source. That cannot be repeated here: this repo is public, so a literal in
 * this file is a published credential and every self-hosted install would
 * share it. The value is derived per-install from configuration instead —
 * `JWT_SECRET` is already required for the server to boot, so a correctly
 * configured install gets a unique secret with nothing new to set.
 *
 * Derived rather than sent directly so the wire value never reveals the
 * signing secret if it lands in a log or a proxy trace.
 */
const LABEL = 'gainium-internal-backtest-v1'

const secret = () => INTERNAL_API_SECRET || JWT_SECRET

export const internalToken = () => {
  const s = secret()
  if (!s) {
    return ''
  }
  return crypto.createHmac('sha256', s).update(LABEL).digest('hex')
}

/**
 * Fails closed: no secret configured means no caller can be recognised, so
 * every request is refused rather than every request being let through.
 */
export const checkToken = (candidate?: unknown) => {
  const expected = internalToken()
  if (!expected || typeof candidate !== 'string') {
    return false
  }
  // Uint8Array views rather than Buffers: timingSafeEqual's declared parameter
  // type does not accept Buffer's generic under this @types/node.
  const given = new Uint8Array(Buffer.from(candidate))
  const want = new Uint8Array(Buffer.from(expected))
  // timingSafeEqual throws on a length mismatch, so that is checked first —
  // length is not secret here, the digest is fixed-width.
  if (given.length !== want.length) {
    return false
  }
  return crypto.timingSafeEqual(given, want)
}

export default internalToken
