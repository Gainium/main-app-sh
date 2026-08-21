import jwt from 'jsonwebtoken'

/**
 * Single source of truth for how long a user session JWT lives.
 *
 * ⚠️ THE TRAP THIS MODULE EXISTS TO CLOSE
 * `jsonwebtoken` reads a NUMERIC `expiresIn` as *seconds from now* — never as
 * an absolute timestamp. Passing a millisecond epoch
 * (`Date.now() + 30 * 24 * 60 * 60 * 1000` ≈ 1.78e12) therefore does not mean
 * the 30 days the literal reads like: it signs an `exp` roughly 56,000 years
 * out, so the token never expires in practice (GHSA-7gxr-ppgj-jjg8).
 *
 * Nothing downstream catches it. `authenticateJWT` is a bare `jwt.verify` with
 * no DB lookup, so the `exp` claim is the *only* expiry that is enforced — the
 * `expiredAt` persisted on `user.tokens[]` is decorative, and it reads as 30
 * days, which is what makes the bug look correct.
 *
 * So: never hand `expiresIn` a timestamp. Go through `signSessionToken`, which
 * takes SECONDS and derives the persisted `createdAt`/`expiredAt` from the
 * signed token's own `iat`/`exp`, so the stored row and the enforced claim
 * cannot drift apart.
 */

const DAY_SECONDS = 24 * 60 * 60

/**
 * Hard ceiling. A session longer than this is almost certainly a units mistake
 * rather than an intent, so clamp instead of trusting the input.
 */
export const MAX_SESSION_TTL_SECONDS = 90 * DAY_SECONDS

function ttlFromEnv(name: string, fallbackSeconds: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallbackSeconds
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // No logger here on purpose: this module is imported by auth code that
    // loads before logger transports are wired in some entrypoints.
    console.error(
      `Invalid ${name}="${raw}", falling back to ${fallbackSeconds}s`,
    )
    return fallbackSeconds
  }
  return Math.min(Math.floor(parsed), MAX_SESSION_TTL_SECONDS)
}

/** Login sessions. Override with `SESSION_TTL_SECONDS`. */
export const LOGIN_SESSION_TTL_SECONDS = ttlFromEnv(
  'SESSION_TTL_SECONDS',
  30 * DAY_SECONDS,
)

export interface SignedSession {
  token: string
  /** Derived from the token's `iat` — when the session actually began. */
  createdAt: Date
  /** Derived from the token's `exp` — what `jwt.verify` will enforce. */
  expiredAt: Date
}

/**
 * Sign a session JWT and report the exact window it carries.
 *
 * `ttlSeconds` is SECONDS. Pass `LOGIN_SESSION_TTL_SECONDS`; never a
 * `Date.now()`-derived value.
 */
export function signSessionToken(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
): SignedSession {
  const token = jwt.sign(payload, secret, { expiresIn: ttlSeconds })
  const claims = jwt.decode(token) as { iat?: number; exp?: number } | null
  const createdAt = claims?.iat ? new Date(claims.iat * 1000) : new Date()
  const expiredAt = claims?.exp
    ? new Date(claims.exp * 1000)
    : new Date(createdAt.getTime() + ttlSeconds * 1000)
  return { token, createdAt, expiredAt }
}
