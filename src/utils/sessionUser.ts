import jwt from 'jsonwebtoken'
import { JWT_SECRET } from '../config'
import { StatusEnum } from '../../types'
import logger from './logger'

import type DB from '../db'
import type { UserSchema } from '../../types'

/**
 * Resolve a session token to its user, with the same three checks on every
 * path that authenticates by token value:
 *
 *   1. signature + `exp` claim  — `jwt.verify`, exactly what the HTTP gate
 *      (`authenticateJWT`) enforces before any resolver runs;
 *   2. presence in `user.tokens[]` — what `findUser` enforces, and what makes
 *      logout / "sign out other sessions" take effect;
 *   3. optionally, that the token belongs to the `userId` the caller claims.
 *
 * The GraphQL path gets (1) from the middleware and (2) from `findUser`. Paths
 * that sit outside that middleware (the Socket.IO user stream, REST routes
 * registered ahead of it) must come through here instead of querying
 * `tokens[]` on their own, or they keep honouring a session the rest of the
 * app has already expired.
 *
 * Expiry is the token's own `exp` claim, not the `expiredAt` stored beside it:
 * the stored value is derived from the claim when the session is created
 * (see `sessionTtl.ts`), and the claim is the one the HTTP gate enforces. A
 * token signed without `exp` verifies here just as it does there.
 *
 * The public `demo` token is never a session and never resolves a user here.
 */
export enum SessionRejection {
  /** Not a non-empty string. */
  malformed = 'malformed',
  /** The public demo token. */
  demo = 'demo',
  /** Signature is valid, `exp` has passed. */
  expired = 'expired',
  /** Not a token signed by this installation. */
  invalid = 'invalid',
  /** Verifies, but is not (or no longer) in any user's `tokens[]`. */
  unknown = 'unknown',
  /** The user lookup itself failed. */
  unreadable = 'unreadable',
}

export const SESSION_EXPIRED_REASON = 'Session is expired, please login again'
export const SESSION_USER_NOT_FOUND_REASON = 'User not found'

export type SessionUserResult<T> =
  | { ok: true; user: T; rejection: undefined; reason: null }
  | { ok: false; user: null; rejection: SessionRejection; reason: string }

let warnedNoSecret = false

/**
 * @param opts.source  short label of the calling path, for the rejection log
 * @param opts.userId  when given (even as a bad value), the token must belong
 *                     to exactly this user
 */
export const resolveSessionUser = async <T extends UserSchema>(
  token: unknown,
  userDb: DB<T>,
  opts: { source: string; userId?: unknown; secret?: string },
): Promise<SessionUserResult<T>> => {
  const byUserId = 'userId' in opts
  const reject = (
    rejection: SessionRejection,
    reason: string = SESSION_USER_NOT_FOUND_REASON,
  ) => {
    // One line per refused session, countable per path and per cause. Never
    // the token; the user id only when it is shaped like one.
    const who =
      typeof opts.userId === 'string' && /^[a-f0-9]{24}$/i.test(opts.userId)
        ? ` | user ${opts.userId}`
        : ''
    logger.warn(`Session rejected | ${opts.source} | ${rejection}${who}`)
    return { ok: false as const, user: null, rejection, reason }
  }
  if (typeof token !== 'string' || token === '') {
    return reject(SessionRejection.malformed)
  }
  if (byUserId && (typeof opts.userId !== 'string' || opts.userId === '')) {
    return reject(SessionRejection.malformed)
  }
  if (token === 'demo') {
    return reject(SessionRejection.demo)
  }
  const secret = opts.secret ?? JWT_SECRET
  if (secret) {
    try {
      jwt.verify(token, secret)
    } catch (e) {
      return e instanceof jwt.TokenExpiredError
        ? reject(SessionRejection.expired, SESSION_EXPIRED_REASON)
        : reject(SessionRejection.invalid, SESSION_EXPIRED_REASON)
    }
  } else if (!warnedNoSecret) {
    // A process started without the signing secret cannot verify anything.
    // Refusing every session would silently take the live feed away from all
    // users, so fall back to the presence check alone and say so loudly.
    warnedNoSecret = true
    logger.error(
      'Session check | JWT_SECRET is not set in this process: session signature and expiry are NOT verified here, only presence',
    )
  }
  const filter = { tokens: { $elemMatch: { token } } }
  const userFind = await userDb.readData(
    (byUserId
      ? { $and: [filter, { _id: opts.userId }] }
      : filter) as Parameters<DB<T>['readData']>[0],
  )
  if (userFind.status === StatusEnum.notok) {
    return reject(SessionRejection.unreadable, `${userFind.reason}`)
  }
  const user = userFind.data?.result
  if (!user) {
    return reject(SessionRejection.unknown)
  }
  return { ok: true, user: user as T, rejection: undefined, reason: null }
}

export default resolveSessionUser
