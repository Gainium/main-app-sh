import logger from '../utils/logger'
import RedisClient from '../db/redis'
import { LOG_PREFIX, RestingOrder } from './types'

/**
 * L3 reconcile publisher (spec §3.3). On a CONFIRMED divergence between the
 * exchange truth and the local registry state, publish the EXISTING per-account
 * signal `redis.publish('userStreamInfo'+exchangeUUID, 'RECONCILE VIA SWEEP')`.
 * Every bot on that account already handles it (core `bot/main.ts:1091-1100`) →
 * runs `checkOrdersAfterReconnect` → books fills the normal way → writes
 * `reconcilesweepcatches`. The detector supplies NO fill data (§7.2a safety
 * envelope) — it only nudges the account to re-sync from the exchange.
 *
 * In shadow mode (FF_SHADOW or Redis gainium:failsafe:shadow) it logs
 * `WOULD-RECONCILE` and never publishes. A per-account cooldown
 * (FF_SWEEP_COOLDOWN_MS) suppresses repeat publishes — sibling misses on the
 * same account are caught by the same sweep.
 */

/**
 * Divergence test (spec §3.3): order after timeout not changed.
 */
export function isDivergent(
  local: RestingOrder,
  remote: RestingOrder | null,
): boolean {
  if (remote === null) return false // no longer open in the db in open state
  if (remote.status === 'FILLED') return false
  const remoteExec = Number(remote.executedQty ?? 0)
  if (Number.isFinite(remoteExec) && remoteExec > local.executedQty)
    return false
  if (remote.status === 'CANCELED' && remoteExec > 0) return false
  return true
}

export class SweepPublisher {
  /** exchangeUUID -> last publish ms (per-account cooldown). */
  private lastPublish = new Map<string, number>()

  /**
   * Called after every publish that reached ≥ 1 receiver, so the prober can
   * open the acknowledgement window for it (spec 001 §4.2). `receivers` is
   * NOT proof a bot heard it — the API process holds a subscription on every
   * live account's channel — which is the whole reason the window exists.
   */
  constructor(
    private onPublished?: (uuid: string, at: number, order: string) => void,
  ) {}

  /**
   * exchangeUUID -> dormant-until ms. Set when a publish reaches ZERO
   * subscribers: no bot process is listening on that account (stopped /
   * archived / deleted), so sweeping it is a guaranteed no-op — park the
   * whole account instead of re-sweeping into the void every cooldown.
   */
  private dormantUntil = new Map<string, number>()

  /** Is the account parked after a 0-subscriber sweep? */
  isDormant(uuid: string, now: number = Date.now()): boolean {
    return (this.dormantUntil.get(uuid) ?? 0) > now
  }

  /**
   * Decide + act for one confirmed candidate. Returns:
   *  - 'diverged-published' — divergence, publish sent (>=1 receiver)
   *  - 'diverged-shadow'    — divergence, shadow (logged only)
   *  - 'diverged-cooldown'  — divergence, suppressed by per-account cooldown
   *  - 'diverged-dormant'   — divergence, but account has no listener (parked)
   *  - 'clean'              — no divergence (false positive)
   */
  async handle(
    local: RestingOrder,
    result: RestingOrder,
    shadow: boolean,
    cooldownMs: number,
    now: number = Date.now(),
    dormantMs = 21_600_000,
  ): Promise<
    | 'diverged-published'
    | 'diverged-shadow'
    | 'diverged-cooldown'
    | 'diverged-dormant'
    | 'clean'
  > {
    if (!isDivergent(local, result)) return 'clean'

    const uuid = local.exchangeUUID
    const remoteStatus = result?.status ?? 'ABSENT'
    if (this.isDormant(uuid, now)) return 'diverged-dormant'
    if (shadow) {
      logger.info(
        `${LOG_PREFIX} WOULD-RECONCILE uuid=${uuid} order=${local.clientOrderId} ` +
          `symbol=${local.symbol} side=${local.side} local=NEW/${local.executedQty} ` +
          `remote=${remoteStatus}/${result?.executedQty ?? '-'} paper=${local.paperContext}`,
      )
      return 'diverged-shadow'
    }

    const last = this.lastPublish.get(uuid) ?? 0
    if (now - last < cooldownMs) return 'diverged-cooldown'

    this.lastPublish.set(uuid, now)
    try {
      const redis = await RedisClient.getInstance()
      // Raw client returns the RECEIVER COUNT — the zombie-account signal.
      const receivers = redis.instance
        ? await redis.instance.publish(
            `userStreamInfo${uuid}`,
            'RECONCILE VIA SWEEP',
          )
        : (await redis.publish(`userStreamInfo${uuid}`, 'RECONCILE VIA SWEEP'),
          undefined)
      if (receivers === 0) {
        // Nobody listening: dead/stopped account — park it.
        this.dormantUntil.set(uuid, now + dormantMs)
        logger.info(
          `${LOG_PREFIX} sweep for uuid=${uuid} had 0 subscribers — account ` +
            `dormant ${Math.round(dormantMs / 60000)}m ` +
            `(order=${local.clientOrderId} remote=${remoteStatus})`,
        )
        return 'diverged-dormant'
      }
      logger.info(
        `${LOG_PREFIX} RECONCILE VIA SWEEP published uuid=${uuid} ` +
          `receivers=${receivers ?? '?'} ` +
          `(triggered by order=${local.clientOrderId} remote=${remoteStatus})`,
      )
      this.onPublished?.(uuid, now, local.clientOrderId)
    } catch (e) {
      // Roll back the cooldown so a failed publish can retry next cycle.
      this.lastPublish.set(uuid, last)
      logger.error(`${LOG_PREFIX} publish error uuid=${uuid}: ${e}`)
    }
    return 'diverged-published'
  }
}
