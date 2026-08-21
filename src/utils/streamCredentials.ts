/**
 * Credential-shape guard for the Socket.IO user stream.
 *
 * SECURITY (GHSA-hmxp-q7gj-rr88, issue 1): every stream handler
 * that authenticates a caller does so with a Mongo filter built straight from
 * the socket payload —
 *
 *   { $and: [{ tokens: { $elemMatch: { token: userToken } } }, { _id: userId }] }
 *
 * `userId` and `userToken` are declared `string`, but that type is erased at
 * runtime and the values arrive over the wire. A non-string `userToken` such as
 * `{ $gt: '' }` is therefore forwarded to MongoDB as a query OPERATOR, and
 * matches any user holding any token — so a caller who knows a victim's `_id`
 * could satisfy the token check without the victim's token and join their live
 * feed. (`_id` cannot be wildcarded the same way: the ObjectId cast rejects it.)
 *
 * Call this before the query in EVERY such handler. Current call sites:
 * `userConnectCallback`, `chatMsg`, `permissionResponse`.
 */
export const hasStringCredentials = (
  userId: unknown,
  userToken: unknown,
): boolean => typeof userId === 'string' && typeof userToken === 'string'

export default hasStringCredentials
