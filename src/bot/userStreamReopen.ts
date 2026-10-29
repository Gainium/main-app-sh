/**
 * Which `serviceLog` messages ask a bot to re-send its user-stream open.
 *
 * Two shapes reach every bot on the `serviceLog` Redis channel:
 *   - `{ restart: 'userStream' }`: a user-stream process booted. Every bot
 *     re-sends its open.
 *   - `{ reopen: 'userStream', uuids: [...] }`: the websocket-connector
 *     balancer moved these connections off a worker that died. It keeps no
 *     copy of the open (that message carries decrypted credentials), so only
 *     the bots on those connections re-send theirs.
 *
 * Pure: takes the parsed message and the bot's connection uuid.
 */
export const wantsUserStreamOpen = (
  msg: unknown,
  exchangeUUID: string | undefined,
): boolean => {
  if (!msg || typeof msg !== 'object') {
    return false
  }
  const m = msg as { restart?: unknown; reopen?: unknown; uuids?: unknown }
  if (m.restart === 'userStream') {
    return true
  }
  return (
    m.reopen === 'userStream' &&
    !!exchangeUUID &&
    Array.isArray(m.uuids) &&
    m.uuids.includes(exchangeUUID)
  )
}
