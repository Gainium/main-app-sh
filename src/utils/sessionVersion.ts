import jwt from 'jsonwebtoken'

/**
 * Per-user session version.
 *
 * `user.tokenVersion` is a counter (absent = 0). A session carries the value
 * the counter had when the session was issued, in the `tv` claim of its JWT.
 * A session is honoured only while the two are equal, so raising the counter
 * ends every session issued before that moment, for that one user.
 *
 * Two deliberate allowances keep existing behaviour intact:
 *
 *  - A token with no `tv` claim counts as version 0. Sessions issued before
 *    this field existed therefore keep working until the user's counter is
 *    first raised; nothing is ended by rolling this code out.
 *  - A `tokens[]` row may carry its own `tv`, which then takes precedence over
 *    the claim. That is how "sign out everything except this session" works:
 *    the counter is raised and the surviving rows are stamped with the new
 *    value in the same write, without re-issuing their tokens.
 *
 * Every caller already holds the user document (it was loaded to find the
 * session), so this check reads nothing.
 */
export const SESSION_VERSION_CLAIM = 'tv'

export type SessionRowLike = {
  token?: string
  source?: string
  tv?: number
}
export type SessionVersionedUser = {
  tokenVersion?: number
  tokens?: SessionRowLike[]
}

const asVersion = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined

/** The user's current session version; 0 when never raised. */
export const userSessionVersion = (
  user: SessionVersionedUser | null | undefined,
): number => asVersion(user?.tokenVersion) ?? 0

/** Claim to merge into the payload of a session token being signed. */
export const sessionVersionClaim = (
  user: SessionVersionedUser | null | undefined,
  raisedBy = 0,
): { tv: number } => ({ tv: userSessionVersion(user) + raisedBy })

/** Whether a `tokens[]` row is the row of this session token. */
export const isSessionRow = (row: SessionRowLike, token: string): boolean =>
  row.token === token

const claimedVersion = (token: string): number | undefined => {
  try {
    const claims = jwt.decode(token)
    return claims && typeof claims === 'object'
      ? asVersion(claims[SESSION_VERSION_CLAIM])
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the session behind `token` is at the user's current version.
 * `user` must be the document the token was found in.
 */
export const isSessionCurrent = (
  token: string,
  user: SessionVersionedUser,
): boolean => {
  const current = userSessionVersion(user)
  const row = user.tokens?.find((t) => isSessionRow(t, token))
  const stamped = asVersion(row?.tv)
  if (stamped !== undefined) {
    return stamped === current
  }
  const claimed = claimedVersion(token)
  // Sessions issued by the admin service carry neither a claim nor a stamp
  // until that service signs `tv` as well. They stay governed by presence in
  // `tokens[]` alone, as before; every "end all sessions" write empties that
  // array too. Remove this once the admin issuer sets the claim.
  if (claimed === undefined && row?.source === 'admin') {
    return true
  }
  return (claimed ?? 0) === current
}

/**
 * The rows that survive a "sign out the others" write, stamped with the
 * version the counter will have after `$inc: { tokenVersion: 1 }`. Use both in
 * ONE update:
 *
 *   { $inc: { tokenVersion: 1 }, $set: { tokens: keepSessions(user, keep) } }
 *
 * To end every session, `$set` `tokens: []` instead.
 */
export const keepSessions = <R extends SessionRowLike>(
  user: { tokenVersion?: number; tokens?: R[] },
  keep: (row: R) => boolean,
): (R & { tv: number })[] => {
  const next = userSessionVersion(user) + 1
  return (user.tokens ?? []).filter(keep).map((t) => ({ ...t, tv: next }))
}
