/**
 * User-stream channel liveness — pure decision module (core spec 002 §4.5,
 * §4.6). No I/O, no framework imports; the bot engine feeds it numbers and
 * acts on the verdict.
 *
 * Contract with the fill-failsafe (main-app `src/fillFailsafe/`):
 *  - the failsafe publishes `PING <ms>` on `userStreamInfo<exchangeUUID>`
 *    every `pingMs` for every account holding resting orders, and writes its
 *    liveness heartbeat (JSON with `ts` and `pingMs`) at
 *    {@link FAILSAFE_HEARTBEAT_KEY};
 *  - every bot answers any message on its channel by writing
 *    `HSET <userStreamAckKey(uuid)> <botId> <ms>`.
 * Silence on the channel is a deafness signal ONLY while that prober is
 * alive; without it a quiet account is simply quiet.
 */

/** Written by main-app fill-failsafe (`heartbeat.ts`). Read here, never written. */
export const FAILSAFE_HEARTBEAT_KEY = 'gainium:failsafe:heartbeat'

/** Per-account ack hash: field = botId, value = epoch ms of the last receipt. */
export const userStreamAckKey = (exchangeUUID: string): string =>
  `gainium:userStreamAck:${exchangeUUID}`

/** Acks older than this are dropped by the hash TTL (refreshed on write). */
export const USER_STREAM_ACK_TTL_SEC = 60 * 60

export const PING_PREFIX = 'PING'

export const isPingMessage = (msg: string | undefined | null): boolean =>
  typeof msg === 'string' && msg.startsWith(PING_PREFIX)

export interface ProberHeartbeat {
  ts: number
  /** Probe period the failsafe is running with; absent/0 ⇒ not probing. */
  pingMs?: number
}

/** Parse the failsafe heartbeat payload; null when missing or malformed. */
export function parseProberHeartbeat(
  raw: string | null | undefined,
): ProberHeartbeat | null {
  if (!raw) return null
  try {
    const hb = JSON.parse(raw) as Partial<ProberHeartbeat>
    if (typeof hb?.ts !== 'number' || !Number.isFinite(hb.ts)) return null
    return {
      ts: hb.ts,
      pingMs:
        typeof hb.pingMs === 'number' && Number.isFinite(hb.pingMs)
          ? hb.pingMs
          : undefined,
    }
  } catch {
    return null
  }
}

export interface LivenessInput {
  now: number
  /** Last message received on the channel (0 = never). */
  lastHeardAt: number
  /** When the current subscription was requested (0 = never). */
  subscribedAt: number
  /** When the last repair was attempted (0 = never). */
  lastRepairAt: number
  /** Consecutive repairs that were followed by continued silence. */
  silentRepairs: number
  /** Resting orders the bot currently holds on the venue. */
  restingOrders: number
  prober: ProberHeartbeat | null
  /** How long the channel may stay silent before it counts as deaf. */
  silenceMs: number
  /** Heartbeat older than this ⇒ prober considered down. */
  proberStaleMs: number
}

export type LivenessAction = 'none' | 'repair' | 'repair-and-error'

export interface LivenessVerdict {
  action: LivenessAction
  reason: string
  /** ms since the channel last delivered (or was subscribed / repaired). */
  quietMs: number
}

/**
 * Decide whether a bot must treat its channel as deaf.
 *
 * - Nothing resting on the venue: nothing to protect → `none`.
 * - Prober missing, stale or not pinging: silence proves nothing → `none`.
 * - Heard something (or subscribed / repaired) inside `silenceMs` → `none`.
 * - Otherwise `repair`; once two repairs in a row were followed by silence,
 *   `repair-and-error` so the bot is loudly broken as well as self-healing.
 */
export function assessUserStreamLiveness(i: LivenessInput): LivenessVerdict {
  const lastActivity = Math.max(i.lastHeardAt, i.subscribedAt, i.lastRepairAt)
  const quietMs =
    lastActivity > 0 ? i.now - lastActivity : Number.POSITIVE_INFINITY
  if (i.restingOrders <= 0) {
    return { action: 'none', reason: 'no resting orders', quietMs }
  }
  if (!i.prober) {
    return { action: 'none', reason: 'prober heartbeat absent', quietMs }
  }
  if (i.now - i.prober.ts > i.proberStaleMs) {
    return { action: 'none', reason: 'prober heartbeat stale', quietMs }
  }
  if (!i.prober.pingMs || i.prober.pingMs <= 0) {
    return { action: 'none', reason: 'prober not pinging', quietMs }
  }
  if (i.subscribedAt <= 0) {
    return { action: 'none', reason: 'never subscribed', quietMs }
  }
  if (quietMs < i.silenceMs) {
    return { action: 'none', reason: 'heard recently', quietMs }
  }
  if (i.silentRepairs >= 2) {
    return {
      action: 'repair-and-error',
      reason: `silent for ${Math.round(quietMs / 1000)}s after ${i.silentRepairs} repairs`,
      quietMs,
    }
  }
  return {
    action: 'repair',
    reason: `silent for ${Math.round(quietMs / 1000)}s with a live prober`,
    quietMs,
  }
}
