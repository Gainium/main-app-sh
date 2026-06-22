import RedisClient from '../db/redis'
import logger from '../utils/logger'

/** A settled funding event for one exchange@symbol. */
export type FundingEvent = {
  /** Settlement time (ms) */
  time: number
  /** Funding rate as a fraction */
  rate: number
  /** Mark price at settlement, when the publisher could resolve it */
  markPrice?: number
}

/** 7 days of retention is enough for any restarted bot to catch up. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Per-symbol sorted set of settled funding events; score = settlement time. */
const storeKey = (exchange: string, symbol: string) =>
  `funding:store:${exchange}:${symbol}`

/** O(1) "latest settlement time written" marker, so the cron only notifies on new events. */
const headKey = (exchange: string, symbol: string) =>
  `funding:head:${exchange}:${symbol}`

// Member encodes the event; score is the time so we can range/prune by it.
const encode = (e: FundingEvent) => `${e.time}|${e.rate}|${e.markPrice ?? ''}`

const decode = (member: string): FundingEvent | null => {
  const [time, rate, mark] = member.split('|')
  const t = +time
  const r = parseFloat(rate)
  if (!Number.isFinite(t) || !Number.isFinite(r)) {
    return null
  }
  const m = mark === '' ? undefined : parseFloat(mark)
  return {
    time: t,
    rate: r,
    markPrice: Number.isFinite(m as number) ? m : undefined,
  }
}

/**
 * Source of truth for settled funding. The cron writes events here (and prunes
 * old ones); bots read events newer than their committed offset. Pub/sub is
 * only a wake-up — correctness comes from this store + the per-deal/bot offset.
 */
export class FundingStore {
  /**
   * Append settled events for a symbol and prune anything past retention.
   * Members are content-addressed, so re-writing the same settlement is a no-op.
   */
  static async addEvents(
    exchange: string,
    symbol: string,
    events: FundingEvent[],
  ): Promise<void> {
    if (!events.length) {
      return
    }
    const key = storeKey(exchange, symbol)
    const redis = await RedisClient.getInstance()
    await redis.zAdd(
      key,
      events.map((e) => ({ score: e.time, value: encode(e) })),
    )
    const cutoff = +new Date() - RETENTION_MS
    await redis.zRemRangeByScore(key, '-inf', `(${cutoff}`)
    const maxTime = Math.max(...events.map((e) => e.time))
    const head = await FundingStore.getHead(exchange, symbol)
    if (maxTime > head) {
      await redis.set(headKey(exchange, symbol), `${maxTime}`)
    }
  }

  /** Latest settlement time written for a symbol (0 if none). */
  static async getHead(exchange: string, symbol: string): Promise<number> {
    const redis = await RedisClient.getInstance()
    const v = await redis.get(headKey(exchange, symbol))
    return v ? +v : 0
  }

  /** Settled events strictly newer than `offset` (ms), ascending by time. */
  static async getEventsAfter(
    exchange: string,
    symbol: string,
    offset: number,
  ): Promise<FundingEvent[]> {
    const key = storeKey(exchange, symbol)
    const redis = await RedisClient.getInstance()
    const members = await redis
      .zRangeByScore(key, `(${offset}`, '+inf')
      .catch((e) => {
        logger.error(`[FundingStore] getEventsAfter ${key}: ${e}`)
        return [] as string[]
      })
    const events = (members ?? [])
      .map(decode)
      .filter((e): e is FundingEvent => !!e)
    // Dedup by time (a re-publish could leave two members for one settlement).
    const byTime = new Map<number, FundingEvent>()
    for (const e of events) {
      byTime.set(e.time, e)
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time)
  }
}

export default FundingStore
