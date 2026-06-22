import { isMainThread, threadId } from 'worker_threads'

import RedisClient, { RedisWrapper } from '../db/redis'
import { IdMute, IdMutex } from '../utils/mutex'
import { HeartbeatRegistry } from '../utils/heartbeatRegistry'
import logger from '../utils/logger'

/** Funding notify callback. `channelKey` is `funding@<exchange>@<symbol>`. */
type CBType = (msg: string, channelKey: string) => any

const mutex = new IdMutex()

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

/** Channel a bot subscribes to for funding events of an exchange@symbol. */
export const fundingChannel = (exchange: string, symbol: string) =>
  `funding@${exchange}@${symbol}`

/** Per-exchange ZSET the cron reads to know which symbols to poll. */
export const fundingActiveZset = (exchange: string) =>
  `funding:active:${exchange}`

/**
 * Shared funding notify stream. Mirrors {@link SharedStream}'s fan-out shape —
 * one Redis subscription per `funding@<exchange>@<symbol>` channel, fanned out
 * to every bot subscribed to that symbol — but tracks channels per bot so a
 * bot listening to many symbols keeps its callback until its last channel goes.
 *
 * Also drives the active-symbol heartbeat registry the cron consumes.
 */
class FundingStream {
  static instance: FundingStream

  static getInstance() {
    if (!FundingStream.instance) {
      FundingStream.instance = new FundingStream()
    }
    return FundingStream.instance
  }

  private redis: RedisWrapper | null = null

  /** channelKey -> bots subscribed to it */
  private subscribers: Map<string, Set<string>> = new Map()

  /** botId -> its funding callback */
  private listeners: Map<string, CBType> = new Map()

  /** botId -> channels it is subscribed to (so we drop its cb only when empty) */
  private botChannels: Map<string, Set<string>> = new Map()

  private registry: HeartbeatRegistry

  constructor() {
    this.redisCb = this.redisCb.bind(this)
    this.initRedis = this.initRedis.bind(this)
    this.initRedis()
    this.registry = new HeartbeatRegistry(
      {
        name: 'funding',
        // 'funding@<exchange>@<symbol>' -> 'funding:active:<exchange>'
        zsetKey: (key) => {
          const parts = key.split('@')
          return parts.length === 3 ? fundingActiveZset(parts[1]) : null
        },
        member: (key) => key.split('@')[2] ?? key,
        heartbeatMs: 60_000,
      },
      () => this.subscribers.keys(),
    )
    this.registry.start()
  }

  private async initRedis() {
    this.redis = await RedisClient.getInstance(true, 'funding')
  }

  private redisCb(msg: string, channelKey: string) {
    const bots = this.subscribers.get(channelKey)
    if (!bots) {
      return
    }
    for (const botId of bots) {
      try {
        this.listeners.get(botId)?.(msg, channelKey)
      } catch (e) {
        logger.error(
          `[FundingStream] ${loggerPrefix} listener error ${botId} ${channelKey}: ${e}`,
        )
      }
    }
  }

  @IdMute(mutex, (channelKey: string) => `funding:add:${channelKey}`)
  public async addListener(channelKey: string, botId: string, cb: CBType) {
    if (!this.subscribers.has(channelKey)) {
      await this.redis?.subscribe(channelKey, this.redisCb)
    }
    this.subscribers.set(
      channelKey,
      (this.subscribers.get(channelKey) ?? new Set<string>()).add(botId),
    )
    this.listeners.set(botId, cb)
    this.botChannels.set(
      botId,
      (this.botChannels.get(botId) ?? new Set<string>()).add(channelKey),
    )
  }

  /** Remove a bot from every funding channel it holds (teardown on stop). */
  @IdMute(mutex, (botId: string) => `funding:removeBot:${botId}`)
  public async removeAllForBot(botId: string) {
    const channels = this.botChannels.get(botId)
    if (!channels) {
      return
    }
    for (const channelKey of [...channels]) {
      const bots = this.subscribers.get(channelKey)
      bots?.delete(botId)
      if (!bots?.size) {
        await this.redis?.unsubscribe(channelKey, this.redisCb)
        this.subscribers.delete(channelKey)
      }
    }
    this.botChannels.delete(botId)
    this.listeners.delete(botId)
  }

  @IdMute(mutex, (channelKey: string) => `funding:remove:${channelKey}`)
  public async removeListener(channelKey: string, botId: string) {
    const bots = this.subscribers.get(channelKey)
    bots?.delete(botId)
    if (!bots?.size) {
      await this.redis?.unsubscribe(channelKey, this.redisCb)
      this.subscribers.delete(channelKey)
    }
    const channels = this.botChannels.get(botId)
    channels?.delete(channelKey)
    if (!channels?.size) {
      this.botChannels.delete(botId)
      this.listeners.delete(botId)
    }
  }
}

export default FundingStream
