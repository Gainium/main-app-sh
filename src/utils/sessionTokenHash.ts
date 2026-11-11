import crypto from 'crypto'

/**
 * Session tokens at rest.
 *
 * A `tokens[]` row identifies its session by `tokenHash`, the hex SHA-256 of
 * the token. The token is a signed JWT (high entropy), so a plain digest is
 * enough: the stored value cannot be turned back into a usable session.
 *
 * Rows written before the hash existed hold the token itself in `token` and
 * no hash. This release writes both fields on a new row and finds a session
 * by its hash or, failing that, by `token`.
 *
 * Everything that matches a row to a token goes through this module.
 */
export const hashSessionToken = (token: string): string =>
  crypto.createHash('sha256').update(`${token}`).digest('hex')

/** The identifying fields of a new `tokens[]` row: spread into the row. */
export const sessionRowToken = (
  token: string,
): { tokenHash: string; token?: string } => ({
  token,
  tokenHash: hashSessionToken(token),
})

type ByHash = { tokens: { $elemMatch: { tokenHash: string } } }
type ByToken = { tokens: { $elemMatch: { token: string } } }

/** Mongo filter for "the user holding this session". One query either way. */
export const sessionLookup = (
  token: string,
): ByHash | { $or: [ByHash, ByToken] } => ({
  $or: [
    { tokens: { $elemMatch: { tokenHash: hashSessionToken(token) } } },
    { tokens: { $elemMatch: { token } } },
  ],
})

/** Whether a `tokens[]` row is the row of this session token. */
export const isSessionRow = (
  row: { token?: string; tokenHash?: string },
  token: string,
): boolean =>
  row.tokenHash
    ? row.tokenHash === hashSessionToken(token)
    : row.token === token

/**
 * `$pull` condition that removes exactly the given row, by whichever field
 * identifies it.
 */
export const sessionRowPull = (
  row: { token?: string; tokenHash?: string },
  token: string,
): { tokenHash: string } | { token: string } =>
  row.tokenHash ? { tokenHash: row.tokenHash } : { token }
