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
  private instance: RedisClientType | null = null
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
    if (this.instance && this.instance.isReady) {
      const _prefix = `${prefix} ${this.id ?? 'main'}${
        this.isSub ? ' (sub)' : ''
      } |`
      await this.instance
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
    this.instance?.quit()
  }
  private async restart() {
    await this.close()
    await this.getInstance()
  }
  private async subscribeAll() {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer)
    }
    if (this.instance && this.instance.isReady) {
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
    this.instance = await getClient()
    this.instance.on('connect', this.subscribeAll)
    this.pingTimer = setInterval(this.ping, this.pingInterval)
    this.isSub = !!isSub
    this.id = id ?? null
    return this
  }
  get isReady() {
    return this.instance?.isReady
  }
  public async set(key: string, value: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.set(key, value).catch((e) => {
        logger.error(`${prefix} Redis set Error: ${e}`)
      })
    }
  }
  public async del(key: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.del(key).catch((e) => {
        logger.error(`${prefix} Redis del Error: ${e}`)
      })
    }
  }
  public async get(key: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.get(key).catch((e) => {
        logger.error(`${prefix} Redis get Error: ${e}`)
      })
    }
  }
  public async incr(key: string): Promise<number | undefined> {
    if (this.instance && this.instance.isReady) {
      return await this.instance.incr(key).catch((e) => {
        logger.error(`${prefix} Redis incr Error: ${e}`)
        return undefined
      })
    }
    return undefined
  }
  public async expire(key: string, seconds: number) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.expire(key, seconds).catch((e) => {
        logger.error(`${prefix} Redis expire Error: ${e}`)
      })
    }
  }
  public async hSet(key: string, field: string, value: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.hSet(key, field, value).catch((e) => {
        logger.error(`${prefix} Redis hSet Error: ${e}`)
      })
    }
  }
  public async hExpire(key: string, field: string, value: number) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.hExpire(key, field, value).catch((e) => {
        logger.error(`${prefix} Redis hExpire Error: ${e}`)
      })
    }
  }
  public async hDel(key: string, field: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.hDel(key, field).catch((e) => {
        logger.error(`${prefix} Redis hDel Error: ${e}`)
      })
    }
  }
  public async hGet(key: string, field: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.hGet(key, field).catch((e) => {
        logger.error(`${prefix} Redis hGet Error: ${e}`)
      })
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
    if (this.instance && this.instance.isReady) {
      const get = this.subscribeMap.get(key) ?? new Set()
      get.add(cb)
      this.subscribeMap.set(key, get)
      return await this.instance.subscribe(key, cb).catch((e) => {
        logger.error(
          `${prefix} Redis subscribe Error: ${e}, retry subscribe in 5s`,
        )
        get.delete(cb)
        setTimer.bind(this)()
      })
    }
    if (this.instance && !this.instance.isReady) {
      logger.error(`${prefix} Redis is not ready yet, retry subscribe in 5s`)
      setTimer()
    }
  }
  public async pSubscribe(
    key: string,
    cb: (msg: string, channel: string) => void,
  ) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.pSubscribe(key, cb).catch((e) => {
        logger.error(`${prefix} Redis pSubscribe Error: ${e}`)
      })
    }
  }
  public async publish(channel: string, msg: string) {
    if (this.instance && this.instance.isReady) {
      return await this.instance.publish(channel, msg).catch((e) => {
        logger.error(`${prefix} Redis publish Error: ${e}`)
      })
    }
  }
  public async unsubscribe(
    key: string,
    cb?: (msg: string, channel: string) => void,
  ) {
    if (this.instance && this.instance.isReady) {
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
      return await this.instance.unsubscribe(key, cb).catch((e) => {
        logger.error(`${prefix} Redis unsubscribe Error: ${e}`)
      })
    }
  }
  public async quit() {
    if (this.instance && this.instance.isReady) {
      return await this.instance.quit().catch((e) => {
        logger.error(`${prefix} Redis quit Error: ${e}`)
      })
    }
  }
}

class RedisClient {
  static instance: RedisWrapper

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
    if (!RedisClient.instance) {
      RedisClient.instance = await new RedisWrapper().getInstance()
    }
    return RedisClient.instance
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
