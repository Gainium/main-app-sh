import RedisClient from '../db/redis'
import logger from './logger'

/**
 * Describes how to project a stream's live subscription keys into a Redis
 * sorted-set "presence" registry. Intentionally logic-agnostic: all
 * feature-specific knowledge (which subs count, how to name the ZSET, what the
 * dedup member is) lives in the descriptor, not in the registry itself.
 */
export type HeartbeatRegistryDescriptor = {
  /** Identifier for logs. */
  name: string
  /**
   * Map a subscription channel key to the ZSET it should register in.
   * Return `null` to exclude this key (this is the filter, e.g. futures-only).
   */
  zsetKey: (channelKey: string) => string | null
  /** Dedup member for the ZSET (e.g. the symbol). */
  member: (channelKey: string) => string
  /** How often to refresh scores, in ms. */
  heartbeatMs: number
}

/**
 * Periodically writes a presence heartbeat for a set of subscription keys into
 * per-target Redis sorted sets (`member = dedup key`, `score = now`). Many
 * workers writing the same target ZSET dedup naturally (member uniqueness);
 * crashed/idle workers age out because they stop refreshing scores. The reader
 * (e.g. a cron) owns the stale threshold and pruning — this side only writes.
 */
export class HeartbeatRegistry {
  private timer: NodeJS.Timeout | null = null
  private flushing = false

  /**
   * @param descriptor projection config
   * @param getKeys returns the stream's current live channel keys each beat
   */
  constructor(
    private readonly descriptor: HeartbeatRegistryDescriptor,
    private readonly getKeys: () => Iterable<string>,
  ) {
    this.flush = this.flush.bind(this)
  }

  start() {
    if (this.timer) {
      return
    }
    this.scheduleNext()
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  // Self-rescheduling with a small jitter so many workers don't all flush on the
  // same tick.
  private scheduleNext() {
    const jitter = Math.floor(Math.random() * 5_000)
    this.timer = setTimeout(async () => {
      await this.flush()
      this.scheduleNext()
    }, this.descriptor.heartbeatMs + jitter)
  }

  private async flush() {
    if (this.flushing) {
      return
    }
    this.flushing = true
    try {
      const now = +new Date()
      // Group members per target ZSET so each target is one pipelined zAdd.
      const grouped = new Map<string, { score: number; value: string }[]>()
      for (const key of this.getKeys()) {
        const zsetKey = this.descriptor.zsetKey(key)
        if (!zsetKey) {
          continue
        }
        const members = grouped.get(zsetKey) ?? []
        members.push({ score: now, value: this.descriptor.member(key) })
        grouped.set(zsetKey, members)
      }
      if (grouped.size === 0) {
        return
      }
      // Regular (non-sub) connection — sorted-set writes can't run on a
      // subscriber-mode client.
      const redis = await RedisClient.getInstance()
      for (const [zsetKey, members] of grouped) {
        await redis.zAdd(zsetKey, members)
      }
    } catch (e) {
      logger.error(
        `[HeartbeatRegistry:${this.descriptor.name}] flush error: ${e}`,
      )
    } finally {
      this.flushing = false
    }
  }
}
