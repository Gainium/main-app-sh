import { isMainThread, threadId } from 'worker_threads'

import { feeDb, globalVarsDb, pairDb, userDb } from '../db/dbInit'
import { IdMute, IdMutex } from '../utils/mutex'
import logger from '../utils/logger'
import RedisClient, { RedisWrapper } from '../db/redis'
import ExpirableMap from '../utils/expirableMap'

import {
  type FeesSchema,
  type ClearPairsSchema,
  type UserSchema,
  type ExchangeEnum,
  type ExcludeDoc,
  type SchemaI,
  type GlobalVariablesSchema,
  type CleanGlobalVariablesSchema,
} from '../../types'
import type DB from '../db'
import type { ProjectionFields, QueryFilter } from 'mongoose'

const mutex = new IdMutex()

type Fee = { maker: number; taker: number }

export type StreamData = { price: number; time: number }

let prefix = '[BotSharedData]'

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

type UserType = {
  timezone: UserSchema['timezone']
  onboardingSteps: UserSchema['onboardingSteps']
  exchanges: UserSchema['exchanges']
  _id: string
}

export class SharedStore<T, D = T & SchemaI> {
  private redisSub: RedisWrapper | null = null

  private map: Map<string, T> = new Map()

  private subscribers: Map<string, Set<string>> = new Map()

  private prefix: string

  constructor(
    private db: DB<D>,
    private name: string,
    private redisUpdateCb: (msg: string) => void,
  ) {
    this.prefix = `${loggerPrefix} ${prefix}: ${this.name}`
    this.log('Init')
    this.init()
  }

  private log(...msg: unknown[]) {
    logger.debug(this.prefix, ...msg)
  }

  private async init() {
    this.redisSub = await RedisClient.getInstance(true, 'shared')
    this.redisSub.subscribe(`update${this.name}`, this.redisUpdateCb)
  }

  @IdMute(mutex, (name: string, key: string) => `subscribeTo:${name}${key}`)
  private async _subscribeTo(_name: string, key: string, subId: string) {
    let subs = this.subscribers.get(key)
    if (subs?.has(subId)) {
      return
    }
    if (!subs) {
      this.log(`Add new key ${key} to subscribers map`)
      subs = new Set()
      this.subscribers.set(key, subs)
    }

    this.log(`Add new subId ${subId} to key ${key}`)
    subs.add(subId)
  }

  public async subscribeTo(key: string, subId: string) {
    return await this._subscribeTo(this.name, key, subId)
  }

  @IdMute(mutex, (name: string, key: string) => `subscribeTo:${name}${key}`)
  private async _unsubscribeFrom(_name: string, key: string, subId: string) {
    const subs = this.subscribers.get(key)
    if (!subs) {
      this.log(`Key ${key} not found in subscribers`)
      this.map.delete(key)
      return
    }
    this.log(`Remove subId ${subId} from key ${key}`)
    subs.delete(subId)

    if (subs.size === 0) {
      this.log(`Remove key ${key} from subscribers`)
      this.subscribers.delete(key)
      this.map.delete(key)
    }
  }

  public async unsubscribeFrom(key: string, subId: string) {
    return await this._unsubscribeFrom(this.name, key, subId)
  }

  @IdMute(mutex, (name: string, key: string) => `getData:${name}${key}`)
  private async _getData(
    _name: string,
    key: string,
    subId: string,
    filter: QueryFilter<ExcludeDoc<D>>,
    fields?: ProjectionFields<ExcludeDoc<D>>,
    force = false,
  ): Promise<T | undefined> {
    let data: T | undefined
    if (!force) {
      const get = this.map.get(key)
      if (get) {
        data = get
      }
    }

    if (!data) {
      data = (await this.db.readData({ ...filter }, { ...fields })).data
        ?.result as T | undefined
      if (data) {
        this.map.set(key, data)
      }
    }

    this.subscribeTo(key, subId)

    return data
  }

  public async getData(
    key: string,
    subId: string,
    filter: QueryFilter<ExcludeDoc<D>>,
    fields?: ProjectionFields<ExcludeDoc<D>>,
    force = false,
  ) {
    return await this._getData(this.name, key, subId, filter, fields, force)
  }

  @IdMute(mutex, (name: string, key: string) => `getData:${name}${key}`)
  private async _updateData(
    _name: string,
    key: string,
    filter: QueryFilter<ExcludeDoc<D>>,
  ) {
    const result = (await this.db.readData({ ...filter }))?.data?.result as
      | T
      | undefined

    if (result) {
      this.map.set(key, result)
    }
  }

  public async updateData(key: string, filter: QueryFilter<ExcludeDoc<D>>) {
    return await this._updateData(this.name, key, filter)
  }

  public async deleteData(key: string) {
    this.subscribers.delete(key)
    this.map.delete(key)
  }
}

export class SimpleStore<T> {
  private map: Map<string, T> = new Map()

  private subscribers: Map<string, Set<string>> = new Map()

  constructor(private name: string) {}

  @IdMute(mutex, (name: string, key: string) => `subscribeTo:${name}${key}`)
  private async _subscribeTo(_name: string, key: string, subId: string) {
    let subs = this.subscribers.get(key)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(key, subs)
    }
    subs.add(subId)
  }

  public async subscribeTo(key: string, subId: string) {
    return await this._subscribeTo(this.name, key, subId)
  }

  @IdMute(mutex, (name: string, key: string) => `subscribeTo:${name}${key}`)
  private async _unsubscribeFrom(_name: string, key: string, subId: string) {
    const subs = this.subscribers.get(key)
    if (!subs) {
      this.map.delete(key)
      return
    }
    subs.delete(subId)

    if (subs.size === 0) {
      this.subscribers.delete(key)
      this.map.delete(key)
    }
  }

  public async unsubscribeFrom(key: string, subId: string) {
    return await this._unsubscribeFrom(this.name, key, subId)
  }

  @IdMute(
    mutex,
    (name: string, _subId: string, key: string) => `data:${name}${key}`,
  )
  private async _getData(
    _name: string,
    subId: string,
    key: string,
  ): Promise<T | undefined> {
    this.subscribeTo(key, subId)
    return this.map.get(key)
  }

  public async getData(key: string, subId: string) {
    return await this._getData(this.name, subId, key)
  }

  @IdMute(
    mutex,
    (name: string, _subId: string, key: string) => `data:${name}${key}`,
  )
  private async _setData(_name: string, subId: string, key: string, data: T) {
    this.subscribeTo(key, subId)
    return this.map.set(key, data)
  }

  public async setData(key: string, subId: string, data: T) {
    return await this._setData(this.name, subId, key, data)
  }
}

let i = 0

class BotSharedData {
  static instance: BotSharedData
  static getInstance() {
    if (!BotSharedData.instance) {
      prefix = `${prefix} ${i}`
      i++
      BotSharedData.instance = new BotSharedData()
    }
    return BotSharedData.instance
  }

  private redis: RedisWrapper | null = null

  protected userStore = new SharedStore<UserType, UserSchema>(
    userDb,
    'userStore',
    this.updateUserStore.bind(this),
  )

  private exchangeInfo = new SharedStore<ClearPairsSchema>(
    pairDb,
    'exchangeInfo',
    this.updateExchangeInfoUpdate.bind(this),
  )

  private userFee = new SharedStore<Fee, FeesSchema>(
    feeDb,
    'userFee',
    this.updateUserFee.bind(this),
  )

  public streamData = new SimpleStore<StreamData>('streamData')

  public usdCache = new SimpleStore<StreamData>('usdCache')

  public globalVars = new SharedStore<
    CleanGlobalVariablesSchema,
    GlobalVariablesSchema
  >(globalVarsDb, 'globalVars', this.updateGlobalVars.bind(this))

  private pairByCodeCache = new ExpirableMap<string, string>(10 * 60 * 1000)

  constructor() {
    this.initRedis = this.initRedis.bind(this)
    this.initRedis()
  }

  private async initRedis() {
    this.redis = await RedisClient.getInstance()
  }

  protected async updateUserStore(msg: string) {
    try {
      const { userId, uuid } = JSON.parse(msg) as {
        userId: string
        uuid: string
      }
      await this.userStore.updateData(userId, { _id: userId })
      this.redis?.publish(`botUpdateUserExchange${threadId}`, uuid)
    } catch (e) {
      logger.error(`${prefix} cannot process updateUserStore ${e}`)
    }
  }

  public async subscribeToUser(userId: string, subId: string) {
    this.userStore.subscribeTo(userId, subId)
  }

  public async unsubscribeFromUser(userId: string, subId: string) {
    this.userStore.unsubscribeFrom(userId, subId)
  }

  public async getUserSchema(
    userId: string,
    subId: string,
    force = false,
  ): Promise<UserType | undefined> {
    return this.userStore.getData(
      userId,
      subId,
      { _id: `${userId}` },
      { timezone: 1, onboardingSteps: 1, exchanges: 1 },
      force,
    )
  }

  private async updateExchangeInfoUpdate(msg: string) {
    try {
      const data = JSON.parse(msg) as
        | {
            exchange: ExchangeEnum
            pairs: string[]
          }
        | {
            exchange: ExchangeEnum
            deletePairs: string[]
          }
      if ('pairs' in data) {
        const { pairs, exchange } = data
        for (const pair of pairs) {
          await this.exchangeInfo.updateData(`${exchange}@${pair}`, {
            exchange,
            pair,
          })
        }
        this.redis?.publish(
          `botUpdateExchangeInfo${threadId}`,
          JSON.stringify({ exchange, pairs }),
        )
      }
      if ('deletePairs' in data) {
        const { deletePairs, exchange } = data
        for (const pair of deletePairs) {
          await this.exchangeInfo.deleteData(`${exchange}@${pair}`)
        }
      }
    } catch (e) {
      logger.error(`${prefix} cannot process updateExchangeInfoUpdate ${e}`)
    }
  }

  public async subscribeToExchange(
    exchange: ExchangeEnum,
    pair: string,
    subId: string,
  ) {
    this.exchangeInfo.subscribeTo(`${exchange}@${pair}`, subId)
  }

  public async unsubscribeFromExchange(
    exchange: ExchangeEnum,
    pair: string,
    subId: string,
  ) {
    this.exchangeInfo.unsubscribeFrom(`${exchange}@${pair}`, subId)
  }

  public async getExchangeInfo(
    exchange: ExchangeEnum,
    pair: string,
    subId: string,
    force = false,
  ): Promise<ClearPairsSchema | undefined> {
    return this.exchangeInfo.getData(
      `${exchange}@${pair}`,
      subId,
      { exchange, pair },
      {},
      force,
    )
  }

  private async updateUserFee(msg: string) {
    try {
      const { userId, uuid, pair } = JSON.parse(msg) as {
        userId: string
        uuid: string
        pair: string
      }
      await this.userFee.updateData(`${uuid}@${pair}`, {
        userId,
        exchangeUUID: uuid,
        pair,
      })
      this.redis?.publish(
        `botUpdateUserFee${threadId}`,
        JSON.stringify({ uuid, pair }),
      )
    } catch (e) {
      logger.error(`${prefix} cannot process updateUserFee ${e}`)
    }
  }

  public async subscribeToUserFee(
    exchangeUUID: string,
    pair: string,
    subId: string,
  ) {
    this.userFee.subscribeTo(`${exchangeUUID}@${pair}`, subId)
  }

  public async unsubscribeFromUserFee(
    exchangeUUID: string,
    pair: string,
    subId: string,
  ) {
    this.userFee.unsubscribeFrom(`${exchangeUUID}@${pair}`, subId)
  }

  public async getUserFee(
    exchangeUUID: string,
    pair: string,
    userId: string,
    subId: string,
    force = false,
  ): Promise<Fee | undefined> {
    return this.userFee.getData(
      `${exchangeUUID}@${pair}`,
      subId,
      { exchangeUUID, pair, userId },
      {},
      force,
    )
  }

  private async updateGlobalVars(msg: string) {
    try {
      const { _id } = JSON.parse(msg) as { _id: string }
      await this.globalVars.updateData(_id, { _id })
      this.redis?.publish(
        `botUpdateGlobalVars${threadId}`,
        JSON.stringify({ _id }),
      )
    } catch (e) {
      logger.error(`${prefix} cannot process updateGlobalVars ${e}`)
    }
  }

  public async subscribeToGlobalVars(_id: string, subId: string) {
    this.globalVars.subscribeTo(_id, subId)
  }

  public async unsubscribeFromGlobalVars(_id: string, subId: string) {
    this.globalVars.unsubscribeFrom(_id, subId)
  }

  public async getGlobalVars(
    _id: string,
    userId: string,
    subId: string,
    force = false,
  ): Promise<CleanGlobalVariablesSchema | undefined> {
    return this.globalVars.getData(_id, subId, { _id, userId }, {}, force)
  }

  public async getPairByCode(
    exchange: ExchangeEnum,
    code: string,
  ): Promise<string | undefined> {
    const key = `${exchange}@${code}`
    const cached = this.pairByCodeCache.get(key)
    if (cached) {
      return cached
    }
    const res = await pairDb.readData({ exchange, code })
    const pair = res.data?.result?.pair
    if (pair) {
      this.pairByCodeCache.set(key, pair)
    }
    return pair
  }
}

export default BotSharedData
