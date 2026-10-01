/**
 * A bot's `uuid` is the credential its webhook signals are matched on, and
 * `vars` carries the owner's global variables. Both belong to the owner only.
 *
 * Two kinds of viewer can read a bot they do not own:
 *  - anyone holding a share link (`shareId`), and
 *  - the `demo` session, which reads the demo account's public bots *as* that
 *    account — so for demo the owner check alone is not enough.
 *
 * Every other field is left intact, so shared and demo bots (and their deals)
 * still render.
 */

/** Whether `viewerId` must get the redacted copy of a bot owned by `ownerId`. */
export const mustRedactBotCredentials = (
  viewerId: unknown,
  ownerId: unknown,
  demo = false,
): boolean => demo || `${viewerId ?? ''}` !== `${ownerId ?? ''}`

/** A copy of `bot` with its webhook uuid and global variables removed. */
export const redactBotCredentials = <T extends object>(bot: T): T => {
  const copy = { ...bot } as T & { uuid?: string; vars?: unknown }
  if ('uuid' in copy) {
    copy.uuid = ''
  }
  if ('vars' in copy) {
    copy.vars = { list: [], paths: [] }
  }
  return copy
}

/**
 * A bot-list response with every bot redacted, including both legs of a hedge
 * bot (each leg is a bot with its own uuid). Anything without a `data` array —
 * a NOTOK response — is returned untouched.
 */
export const redactBotListResult = <R>(result: R): R => {
  const r = result as { data?: unknown }
  if (!r || !Array.isArray(r.data)) {
    return result
  }
  return {
    ...r,
    data: r.data.map((bot: object) => {
      const redacted = redactBotCredentials(bot) as { bots?: unknown }
      if (Array.isArray(redacted.bots)) {
        redacted.bots = redacted.bots.map((leg: object) =>
          redactBotCredentials(leg),
        )
      }
      return redacted
    }),
  } as R
}
