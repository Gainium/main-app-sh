import RedisClient from '../db/redis'
import logger from '../utils/logger'
import { LOG_PREFIX } from './types'

/**
 * Detector liveness heartbeat (monitoring). The detector writes this key once
 * per summary cycle (60s); a deterministic checker in a separate process can
 * read it and alert ONLY on a real anomaly.
 *
 * The detector can't watch itself (a dead process can't alert), which is why
 * the reader lives in a separate process. The contract (key + shape + stale
 * window) is owned here, on the producing side.
 */

/** Redis key holding the detector's liveness heartbeat (plain JSON, short TTL). */
export const HEARTBEAT_KEY = 'gainium:failsafe:heartbeat'

/** Older than this ⇒ detector dead/stalled. Heartbeat is written every 60s, so
 *  3 min tolerates a couple of missed cycles before we page. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000

/** Shape persisted at HEARTBEAT_KEY. */
export interface FailsafeHeartbeat {
  /** epoch ms of the write. */
  ts: number
  /** resting-order registry size at write time (0 ⇒ registry dead). */
  registry: number
  /** live `trade@` subscriptions at write time (0 with registry>0 ⇒ feed dead). */
  subscribed: number
  /** sweeps published since the previous heartbeat (informational). */
  sweepsSinceLast: number
  /** main-loop errors since the previous heartbeat (informational). */
  errorsSinceLast: number
  /**
   * `PING` probe period the detector runs with (spec 001 §4.4). Read by core
   * bots (`bot/userStreamLiveness.ts`): silence on their channel only counts
   * as deafness while this is present, fresh and > 0.
   */
  pingMs?: number
}

// TTL well past the stale window so a dead detector's key eventually vanishes;
// reads then treat "missing" identically to "stale".
const HEARTBEAT_TTL_SEC = Math.round((HEARTBEAT_STALE_MS * 4) / 1000)

/** Write the heartbeat. Best-effort; a failed write must never break the loop. */
export async function writeHeartbeat(hb: FailsafeHeartbeat): Promise<void> {
  try {
    const redis = await RedisClient.getInstance()
    await redis.set(HEARTBEAT_KEY, JSON.stringify(hb), HEARTBEAT_TTL_SEC)
  } catch (e) {
    logger.error(`${LOG_PREFIX} heartbeat write error: ${e}`)
  }
}

/** Read + parse the heartbeat. Returns null when missing or malformed. */
export async function readHeartbeat(): Promise<FailsafeHeartbeat | null> {
  try {
    const redis = await RedisClient.getInstance()
    const raw = await redis.get(HEARTBEAT_KEY)
    if (!raw) return null
    const hb = JSON.parse(raw) as FailsafeHeartbeat
    if (typeof hb.ts !== 'number') return null
    return hb
  } catch (e) {
    logger.error(`${LOG_PREFIX} heartbeat read error: ${e}`)
    return null
  }
}
