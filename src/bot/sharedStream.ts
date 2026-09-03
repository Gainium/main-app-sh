import { v4 } from 'uuid'
import { isMainThread, threadId } from 'worker_threads'

import RedisClient, { RedisWrapper } from '../db/redis'
import { IdMute, IdMutex } from '../utils/mutex'
import logger from '../utils/logger'

import type { ExecutionReport } from '../../types'

type CBType = (msg: ExecutionReport) => any

const mutex = new IdMutex()

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

class SharedStream {
  static instance: SharedStream

  static getInstance() {
    if (!SharedStream.instance) {
      SharedStream.instance = new SharedStream()
    }
    return SharedStream.instance
  }
  private redis: RedisWrapper | null = null

  private listeners: Map<string, CBType> = new Map()

  private subscribers: Map<string, Set<string>> = new Map()

  private ordersToBotMap: Map<string, string> = new Map()

  private botToOrdersMap: Map<string, Set<string>> = new Map()

  constructor() {
    this.redisCb = this.redisCb.bind(this)
    this.initRedis = this.initRedis.bind(this)
    this.initRedis()
  }

  private initPromise: Promise<void> | null = null

  private async initRedis() {
    if (!this.initPromise) {
      this.initPromise = RedisClient.getInstance(true, 'global').then((r) => {
        this.redis = r
      })
    }
    return this.initPromise
  }

  /**
   * Re-establish the server subscription for one account channel (spec 002
   * §4.3): `RedisWrapper.resubscribe` puts a real UNSUBSCRIBE + SUBSCRIBE on
   * the wire for our `redisCb`. No-op when nothing is subscribed for `key`.
   */
  public async resubscribe(key: string): Promise<number> {
    await this.initRedis()
    if (!this.subscribers.has(key)) {
      return 0
    }
    return (await this.redis?.resubscribe(key)) ?? 0
  }

  private log(...msg: unknown[]) {
    logger.debug(`[SharedStream]`, ...msg)
  }

  private redisCb(msg: string, key: string) {
    if (
      !msg.includes('executionReport') &&
      !msg.includes('ORDER_TRADE_UPDATE')
    ) {
      return
    }
    const parse = JSON.parse(msg) as ExecutionReport
    const clientOrderId =
      parse.eventType === 'executionReport'
        ? parse.newClientOrderId || (parse.liquidation ? `liq_${v4()}` : '')
        : parse.clientOrderId || (parse.liquidation ? `liq_${v4()}` : '')
    if (!clientOrderId) {
      return
    }
    if (parse.liquidation) {
      const all = this.subscribers.get(key)
      for (const botId of all || []) {
        this.listeners.get(botId)?.(parse)
      }
    } else {
      const order = this.ordersToBotMap.get(clientOrderId)
      if (order) {
        this.listeners.get(order)?.(parse)
      }
    }
  }

  @IdMute(mutex, (key: string) => `addListener:${key}`)
  public async addListener(key: string, botId: string, cb: CBType) {
    this.log(`${loggerPrefix} Adding listener for ${key} | ${botId}`)
    if (!this.subscribers.has(key)) {
      this.log(`${loggerPrefix} Subscribing to ${key}`)
      // The constructor kicks off the connection without awaiting it; the
      // first listener of a fresh worker used to hit `this.redis === null`
      // and skip the subscribe silently while still being recorded as a
      // subscriber (spec 002 §4.8).
      await this.initRedis()
      await this.redis?.subscribe(key, this.redisCb)
    }
    this.subscribers.set(
      key,
      (this.subscribers.get(key) ?? new Set<string>()).add(botId),
    )
    this.listeners.set(botId, cb)
  }

  @IdMute(mutex, (key: string) => `removeListener:${key}`)
  public async removeListener(key: string, botId: string) {
    this.log(`${loggerPrefix} Removing listener for ${key} | ${botId}`)
    const get = this.subscribers.get(key)
    get?.delete(botId)
    this.listeners.delete(botId)
    if (!get?.size) {
      this.log(`${loggerPrefix} Unsubscribing from ${key}`)
      await this.redis?.unsubscribe(key, this.redisCb)
      this.subscribers.delete(key)
    }
    const all = this.botToOrdersMap.get(botId)
    this.botToOrdersMap.delete(botId)
    for (const order of all || []) {
      this.ordersToBotMap.delete(order)
    }
  }

  @IdMute(
    mutex,
    (_botId: string, clientOrderId: string) => `order:${clientOrderId}`,
  )
  public async addOrder(botId: string, clientOrderId: string) {
    this.log(`${loggerPrefix} Adding order ${clientOrderId} to ${botId}`)
    this.ordersToBotMap.set(clientOrderId, botId)
    if (!this.botToOrdersMap.has(botId)) {
      this.botToOrdersMap.set(botId, new Set<string>().add(clientOrderId))
    } else {
      this.botToOrdersMap.get(botId)?.add(clientOrderId)
    }
  }

  @IdMute(
    mutex,
    (_botId: string, clientOrderId: string) => `order:${clientOrderId}`,
  )
  public async removeOrder(botId: string, clientOrderId: string) {
    this.log(`${loggerPrefix} Removing order ${clientOrderId} from ${botId}`)
    this.ordersToBotMap.delete(clientOrderId)
    const get = this.botToOrdersMap.get(botId)
    get?.delete(clientOrderId)
    if (!get?.size) {
      this.botToOrdersMap.delete(botId)
    }
  }
}

export default SharedStream
