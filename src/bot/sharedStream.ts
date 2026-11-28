import { v4 } from 'uuid'
import { isMainThread, threadId } from 'worker_threads'

import RedisClient, { RedisWrapper } from '../db/redis'
import { IdMute, IdMutex } from '../utils/mutex'
import logger from '../utils/logger'

import type { ExecutionReport } from '../../types'
import { lateFillFeeFields } from './orderFee'

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

  /**
   * How long a removed route still carries a late fee report (spec 286 §4.1).
   * The answer books a fill on arrival and the deal can close and drop its
   * orders before the stream report stating the fee lands (~0.5 s on Kraken
   * Futures); a minute covers a slow stream without keeping routes around.
   */
  static RETIRED_ROUTE_TTL_MS = 60_000

  /**
   * Routes `removeOrder` ended: clientOrderId → owning bot and when the route
   * ended. Insertion order is removal order, so expiry prunes from the front.
   * Only a FILLED report with a fee is delivered through one (spec 286 §4.1).
   */
  private retiredRoutes: Map<string, { botId: string; at: number }> =
    new Map()

  /**
   * Slack past the TTL before a lingering listener is torn down, so a report
   * that lands right at the TTL edge still finds its listener (spec 286 §4.6).
   */
  static LINGER_MARGIN_MS = 1_000

  /**
   * Bots whose stream closed while one of their routes was retired: the
   * pending teardown per `${key}|${botId}` (spec 286 §4.6).
   */
  private lingering: Map<string, ReturnType<typeof setTimeout>> = new Map()

  private lingerKey(key: string, botId: string) {
    return `${key}|${botId}`
  }

  private cancelLinger(key: string, botId: string) {
    const lk = this.lingerKey(key, botId)
    const timer = this.lingering.get(lk)
    if (timer) {
      clearTimeout(timer)
      this.lingering.delete(lk)
    }
  }

  private lingersOn(key: string) {
    for (const lk of this.lingering.keys()) {
      if (lk.startsWith(`${key}|`)) {
        return true
      }
    }
    return false
  }

  /** A fee-bearing FILLED report SharedStream could not deliver (spec 286 §4.7). */
  private logFeeDrop(
    parse: ExecutionReport,
    clientOrderId: string,
    reason: string,
    level: 'info' | 'debug' = 'info',
  ) {
    if (lateFillFeeFields(parse)) {
      logger[level](
        `[SharedStream] ${loggerPrefix} LATE-FEE-DROP ${clientOrderId} ${reason}`,
      )
    }
  }

  private pruneRetiredRoutes(now = Date.now()) {
    for (const [id, route] of this.retiredRoutes) {
      if (now - route.at <= SharedStream.RETIRED_ROUTE_TTL_MS) {
        break
      }
      this.retiredRoutes.delete(id)
    }
  }

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
        const listener = this.listeners.get(order)
        if (!listener) {
          this.logFeeDrop(parse, clientOrderId, 'route present but no listener')
        }
        listener?.(parse)
        return
      }
      const retired = this.retiredRoutes.get(clientOrderId)
      if (!retired) {
        // Every worker subscribed to the account sees every report: one
        // worker cannot tell "nobody owns it" from "another worker owns it".
        this.logFeeDrop(parse, clientOrderId, 'no route', 'debug')
        return
      }
      if (Date.now() - retired.at > SharedStream.RETIRED_ROUTE_TTL_MS) {
        this.pruneRetiredRoutes()
        this.logFeeDrop(parse, clientOrderId, 'route expired')
        return
      }
      if (lateFillFeeFields(parse)) {
        const listener = this.listeners.get(retired.botId)
        if (!listener) {
          this.logFeeDrop(parse, clientOrderId, 'route present but no listener')
          return
        }
        listener(parse)
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
    // A restart inside the window of spec 286 §4.6: the old instance's
    // pending teardown must not remove the new listener.
    this.cancelLinger(key, botId)
    this.subscribers.set(
      key,
      (this.subscribers.get(key) ?? new Set<string>()).add(botId),
    )
    this.listeners.set(botId, cb)
  }

  /**
   * Spec 286 §4.6: the bot's stream can close in the same tick as the fill
   * that closed its last deal, before the report stating that fill's fee.
   * Its live routes are retired like `removeOrder` does, and while any of its
   * retired routes is unexpired the listener and the channel subscription are
   * kept for `RETIRED_ROUTE_TTL_MS`. Only a fee-bearing FILLED report goes
   * through a retired route, and the bot is out of `subscribers`, so it gets
   * nothing else (no liquidation broadcast) in that window.
   */
  @IdMute(mutex, (key: string) => `removeListener:${key}`)
  public async removeListener(key: string, botId: string) {
    this.log(`${loggerPrefix} Removing listener for ${key} | ${botId}`)
    this.cancelLinger(key, botId)
    const now = Date.now()
    const live = this.botToOrdersMap.get(botId)
    this.botToOrdersMap.delete(botId)
    if (live?.size) {
      this.pruneRetiredRoutes(now)
    }
    for (const order of live || []) {
      if (this.ordersToBotMap.get(order) === botId) {
        this.retiredRoutes.delete(order)
        this.retiredRoutes.set(order, { botId, at: now })
      }
      this.ordersToBotMap.delete(order)
    }
    this.subscribers.get(key)?.delete(botId)
    let retiredAt = 0
    for (const route of this.retiredRoutes.values()) {
      if (
        route.botId === botId &&
        now - route.at <= SharedStream.RETIRED_ROUTE_TTL_MS
      ) {
        retiredAt = Math.max(retiredAt, route.at)
      }
    }
    if (!retiredAt) {
      await this.dropListener(key, botId)
      return
    }
    this.log(`${loggerPrefix} Keeping listener for ${key} | ${botId}`)
    const lk = this.lingerKey(key, botId)
    const timer = setTimeout(
      () => void this.endLinger(key, botId, timer),
      retiredAt +
        SharedStream.RETIRED_ROUTE_TTL_MS +
        SharedStream.LINGER_MARGIN_MS -
        now,
    )
    timer.unref?.()
    this.lingering.set(lk, timer)
  }

  /** The window of spec 286 §4.6 is over: tear down as `removeListener` did. */
  @IdMute(mutex, (key: string) => `removeListener:${key}`)
  private async endLinger(
    key: string,
    botId: string,
    timer: ReturnType<typeof setTimeout>,
  ) {
    const lk = this.lingerKey(key, botId)
    if (this.lingering.get(lk) !== timer) {
      return
    }
    this.lingering.delete(lk)
    await this.dropListener(key, botId)
  }

  private async dropListener(key: string, botId: string) {
    const get = this.subscribers.get(key)
    get?.delete(botId)
    this.listeners.delete(botId)
    if (!get?.size && !this.lingersOn(key)) {
      this.log(`${loggerPrefix} Unsubscribing from ${key}`)
      await this.redis?.unsubscribe(key, this.redisCb)
      this.subscribers.delete(key)
    }
    for (const [id, route] of this.retiredRoutes) {
      if (route.botId === botId) {
        this.retiredRoutes.delete(id)
      }
    }
  }

  @IdMute(
    mutex,
    (_botId: string, clientOrderId: string) => `order:${clientOrderId}`,
  )
  public async addOrder(botId: string, clientOrderId: string) {
    this.log(`${loggerPrefix} Adding order ${clientOrderId} to ${botId}`)
    this.retiredRoutes.delete(clientOrderId)
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
    if (this.ordersToBotMap.get(clientOrderId) === botId) {
      this.pruneRetiredRoutes()
      this.retiredRoutes.delete(clientOrderId)
      this.retiredRoutes.set(clientOrderId, { botId, at: Date.now() })
    }
    this.ordersToBotMap.delete(clientOrderId)
    const get = this.botToOrdersMap.get(botId)
    get?.delete(clientOrderId)
    if (!get?.size) {
      this.botToOrdersMap.delete(botId)
    }
  }
}

export default SharedStream
