import { createClient, RedisClientType } from 'redis'
import logger from '../utils/logger'
import { isMainThread, threadId } from 'worker_threads'
import { IdMute, IdMutex } from '../utils/mutex'
import { v4 } from 'uuid'
import { REDIS_HOST, REDIS_PASSWORD, REDIS_PORT } from '../config'

const mutex = new IdMutex()

const mutexConcurrentely = new IdMutex(1000)

const prefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

const reconnectStrategy = (retries: number, cause: Error) => {
  const wait = 3000
  logger.error(
    `${prefix} Reconnecting to Redis, ${cause}. Attempt ${retries}. Waiting ${wait}ms to try again.`,
  )
  if (retries > 1000) {
    logger.error(
      `${prefix} Too many attempts to reconnect. Redis connection was terminated`,
    )
    return new Error('Too many retries.')
  }
  return wait
}

const getClient = async (count = 0): Promise<RedisClientType> => {
  try {
    //@ts-ignore
    const client: RedisClientType = await createClient({
      password: REDIS_PASSWORD,
      socket: {
        port: +REDIS_PORT,
        host: REDIS_HOST,
        reconnectStrategy,
      },
    })
      .on('error', (err) => {
        logger.error(`${prefix} Redis Client Error: ${err}`)
      })
      .on('connect', () => {
        logger.info(`${prefix} Redis Client Connected`)
      })
      .on('reconnecting', () =>
        logger.info(`${prefix} Redis Client reconnecting`),
      )
      .connect()
      .catch((e) => {
        logger.error(
          `${prefix} Redis Client Connect Error: ${e}, count: ${count}, sleep 5s`,
        )
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(getClient(count + 1))
          }, 5000)
        })
      })
    //@ts-ignore
    return client
  } catch (e) {
    logger.error(
      `${prefix} Redis Get Client Error: ${e}, count: ${count}, sleep 5s`,
    )
    return getClient(count + 1)
  }
}

export class RedisWrapper {
  private _instance: RedisClientType | null = null
  private subscribeMap: Map<
    string,
    Set<(msg: string, channel: string) => void>
  > = new Map()
  private checkTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pingInterval = 10 * 1000
  private pingError = 0
  private pingErrorLimit = 60
  private retries = 0
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private id: string | null = null
  private isSub = false
  constructor() {
    this.subscribeAll = this.subscribeAll.bind(this)
    this.ping = this.ping.bind(this)
    this.close = this.close.bind(this)
    this.restart = this.restart.bind(this)
  }
  private async ping() {
    if (this._instance && this._instance.isReady) {
      const _prefix = `${prefix} ${this.id ?? 'main'}${
        this.isSub ? ' (sub)' : ''
      } |`
      await this._instance
        .ping()
        .catch((e) => {
          logger.error(
            `${_prefix} Redis ping Error: ${e}, attempt ${this.pingError + 1}`,
          )
          this.pingError++
          if (this.pingError > this.pingErrorLimit) {
            logger.error(`${_prefix} Redis ping Error: ${e}, quit and retry`)
            this.pingError = 0
            this.restart()
          }
        })
        .then(() => {
          this.pingError = 0
        })
    }
  }
  private async close() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
    }
    this._instance?.quit()
  }
  private async restart() {
    await this.close()
    await this.getInstance()
  }
  private async subscribeAll() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
    }
    if (this._instance && this._instance.isReady) {
      this.retries = 0
      for (const [key, cbs] of this.subscribeMap.entries()) {
        logger.debug(`${prefix} Redis subscribe to ${key} after reconnect`)
        for (const cb of cbs) {
          this.subscribe(key, cb)
        }
      }
    } else {
      this.retries++
      if (this.retries > 15) {
        logger.error(`${prefix} Redis is not ready yet, quit and retry`)
        try {
          this.close()
        } catch (e) {
          logger.error(`${prefix} Redis quit Error: ${e}`)
        }
        await this.restart()
      }
      logger.warn(
        `${prefix} Redis is not ready yet, retry subscribe all in 5s, Retry: ${this.retries}`,
      )
      this.checkTimer = setTimeout(this.subscribeAll, 5000)
    }
  }
  public async getInstance(isSub?: boolean, id?: string) {
    this._instance = await getClient()
    this._instance.on('connect', this.subscribeAll)
    this.pingTimer = setInterval(this.ping, this.pingInterval)
    this.isSub = !!isSub
    this.id = id ?? null
    return this
  }
  get isReady() {
    return this._instance?.isReady
  }
  public async set(key: string, value: string, ttlSec?: number) {
    if (this._instance && this._instance.isReady) {
      // Backward compatible: 2-arg calls behave exactly as before. When a
      // positive TTL is supplied we use SET ... EX so the key self-expires
      // (kills the historical key-leak in the auth limiters).
      const options =
        typeof ttlSec === 'number' && ttlSec > 0
          ? { EX: Math.floor(ttlSec) }
          : undefined
      return await this._instance.set(key, value, options).catch((e) => {
        logger.error(`${prefix} Redis set Error: ${e}`)
      })
    }
  }
  /**
   * Atomic INCR. Returns the new counter value, or undefined when Redis is
   * unavailable (callers must treat undefined as "could not count" and decide
   * their own fail-open/closed policy).
   */
  public async incr(key: string): Promise<number | undefined> {
    if (this._instance && this._instance.isReady) {
      return await this._instance.incr(key).catch((e) => {
        logger.error(`${prefix} Redis incr Error: ${e}`)
        return undefined
      })
    }
    return undefined
  }
  /** Set a TTL (seconds) on an existing key. */
  public async expire(key: string, sec: number) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.expire(key, Math.floor(sec)).catch((e) => {
        logger.error(`${prefix} Redis expire Error: ${e}`)
      })
    }
  }
  /**
   * Remaining TTL (seconds) for a key. Mirrors Redis TTL semantics: -2 if the
   * key does not exist, -1 if it exists without a TTL. Returns undefined when
   * Redis is unavailable.
   */
  public async ttl(key: string): Promise<number | undefined> {
    if (this._instance && this._instance.isReady) {
      return await this._instance.ttl(key).catch((e) => {
        logger.error(`${prefix} Redis ttl Error: ${e}`)
        return undefined
      })
    }
    return undefined
  }
  public async del(key: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.del(key).catch((e) => {
        logger.error(`${prefix} Redis del Error: ${e}`)
      })
    }
  }
  public async get(key: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.get(key).catch((e) => {
        logger.error(`${prefix} Redis get Error: ${e}`)
      })
    }
  }
  public async hSet(key: string, field: string, value: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.hSet(key, field, value).catch((e) => {
        logger.error(`${prefix} Redis hSet Error: ${e}`)
      })
    }
  }
  public async hExpire(key: string, field: string, value: number) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.hExpire(key, field, value).catch((e) => {
        logger.error(`${prefix} Redis hExpire Error: ${e}`)
      })
    }
  }
  public async hDel(key: string, field: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.hDel(key, field).catch((e) => {
        logger.error(`${prefix} Redis hDel Error: ${e}`)
      })
    }
  }
  public async hGet(key: string, field: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.hGet(key, field).catch((e) => {
        logger.error(`${prefix} Redis hGet Error: ${e}`)
      })
    }
  }
  /**
   * Add one or more scored members to a sorted set. Pass an array to add many
   * in a single command (e.g. a heartbeat registry flush).
   */
  public async zAdd(
    key: string,
    members:
      | { score: number; value: string }
      | { score: number; value: string }[],
    gt?: boolean,
  ) {
    if (this._instance && this._instance.isReady) {
      return await this._instance
        .zAdd(
          key,
          members,
          gt
            ? {
                comparison: 'GT',
              }
            : undefined,
        )
        .catch((e) => {
          logger.error(`${prefix} Redis zAdd Error: ${e}`)
        })
    }
  }
  /**
   * Remove scored member from a sorted set.
   */
  public async zRem(key: string, member: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.zRem(key, member).catch((e) => {
        logger.error(`${prefix} Redis zRem Error: ${e}`)
      })
    }
  }
  /**
   * Members with score in [min, max]. Use '-inf'/'+inf' or '(123' (exclusive)
   * per the Redis ZRANGEBYSCORE syntax.
   */
  public async zRangeByScore(
    key: string,
    min: number | string,
    max: number | string,
  ) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.zRangeByScore(key, min, max).catch((e) => {
        logger.error(`${prefix} Redis zRangeByScore Error: ${e}`)
      })
    }
  }
  /** Remove members with score in [min, max]; used to prune stale entries. */
  public async zRemRangeByScore(
    key: string,
    min: number | string,
    max: number | string,
  ) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.zRemRangeByScore(key, min, max).catch((e) => {
        logger.error(`${prefix} Redis zRemRangeByScore Error: ${e}`)
      })
    }
  }
  /**
   * Retturn pipeline for multiple commands. Call exec() on the returned pipeline to run all commands.
   */
  public get instance() {
    if (this._instance && this._instance.isReady) {
      return this._instance
    }
  }
  @IdMute(mutexConcurrentely, () => 'subscribe')
  public async subscribe(
    key: string,
    cb: (msg: string, channel: string) => void,
    timerId?: string,
  ) {
    if (timerId) {
      const get = this.timers.get(timerId)
      if (get) {
        clearTimeout(get)
        this.timers.delete(timerId)
      }
    }
    const setTimer = () => {
      const id = v4()
      this.timers.set(
        id,
        setTimeout(() => {
          this.subscribe(key, cb, id)
        }, 5000),
      )
    }
    if (this._instance && this._instance.isReady) {
      const get = this.subscribeMap.get(key) ?? new Set()
      get.add(cb)
      this.subscribeMap.set(key, get)
      return await this._instance.subscribe(key, cb).catch((e) => {
        logger.error(
          `${prefix} Redis subscribe Error: ${e}, retry subscribe in 5s`,
        )
        get.delete(cb)
        setTimer.bind(this)()
      })
    }
    if (this._instance && !this._instance.isReady) {
      logger.error(`${prefix} Redis is not ready yet, retry subscribe in 5s`)
      setTimer()
    }
  }
  public async pSubscribe(
    key: string,
    cb: (msg: string, channel: string) => void,
  ) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.pSubscribe(key, cb).catch((e) => {
        logger.error(`${prefix} Redis pSubscribe Error: ${e}`)
      })
    }
  }
  public async publish(channel: string, msg: string) {
    if (this._instance && this._instance.isReady) {
      return await this._instance.publish(channel, msg).catch((e) => {
        logger.error(`${prefix} Redis publish Error: ${e}`)
      })
    }
  }
  public async unsubscribe(
    key: string,
    cb?: (msg: string, channel: string) => void,
  ) {
    if (this._instance && this._instance.isReady) {
      if (cb) {
        const get = this.subscribeMap.get(key) ?? new Set()
        get.delete(cb)
        if (get.size === 0) {
          this.subscribeMap.delete(key)
        } else {
          this.subscribeMap.set(key, get)
        }
      } else {
        this.subscribeMap.delete(key)
      }
      return await this._instance.unsubscribe(key, cb).catch((e) => {
        logger.error(`${prefix} Redis unsubscribe Error: ${e}`)
      })
    }
  }
  public async quit() {
    if (this._instance && this._instance.isReady) {
      return await this._instance.quit().catch((e) => {
        logger.error(`${prefix} Redis quit Error: ${e}`)
      })
    }
  }
}

class RedisClient {
  static _instance: RedisWrapper

  static instanceSub: Map<string, RedisWrapper> = new Map()
  @IdMute(mutex, () => 'RedisClient')
  static async getInstance(sub = false, id = '') {
    if (sub) {
      let get = RedisClient.instanceSub.get(id)
      if (!get) {
        get = await new RedisWrapper().getInstance(sub, id)
        RedisClient.instanceSub.set(id, get)
      }
      return get
    }
    if (!RedisClient._instance) {
      RedisClient._instance = await new RedisWrapper().getInstance()
    }
    return RedisClient._instance
  }
  static closeSubInstance(id: string) {
    const get = RedisClient.instanceSub.get(id)
    if (get) {
      get.quit()
    }
    RedisClient.instanceSub.delete(id)
  }
}

export default RedisClient
