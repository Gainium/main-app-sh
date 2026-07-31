import logger from '../utils/logger'
import Indicators from '../indicators'
import Rabbit from '../db/rabbit'
import RedisClient, { RedisWrapper } from '../db/redis'
import HealthServer from '../utils/healthServer'

import { BotType, rabbitIndicatorsKey, serviceLogRedis } from '../../types'
import type {
  BotParentIndicatorEventDto,
  BotParentUnsubscribeIndicatorEventDto,
  IndicatorHistory,
} from '../../types'
import { IdMute, IdMutex } from '../utils/mutex'

const mutex = new IdMutex()
const cbMutex = new IdMutex(1000)

type RequestMessage =
  | BotParentIndicatorEventDto
  | BotParentUnsubscribeIndicatorEventDto

class IndicatorsService {
  private rabbitClient: Rabbit = new Rabbit()
  private redisClient: RedisWrapper | null = null
  private redisSubClient: RedisWrapper | null = null
  private rabbitIdRoomsMapDca: Map<string, Set<string>> = new Map()
  private rabbitIdRoomsMapCombo: Map<string, Set<string>> = new Map()
  private indicatorsFactory = Indicators.getInstance()
  constructor() {
    this.redisServiceLogListener = this.redisServiceLogListener.bind(this)
    this.initRedis = this.initRedis.bind(this)

    // Start health server
    const healthServer = new HealthServer()
    healthServer.start()

    this.initRedis()

    this.requestCallback = this.requestCallback.bind(this)
    this.getRedisCb = this.getRedisCb.bind(this)

    this.handleLog(
      `>🔬 Indicators service ready in ${rabbitIndicatorsKey} queue`,
    )
  }

  private async initRedis() {
    this.redisClient = await RedisClient.getInstance(false, 'indicators')
    this.redisSubClient = await RedisClient.getInstance(true, 'indicators')
    this.rabbitListener()
    this.redisClient.publish(
      serviceLogRedis,
      JSON.stringify({ restart: 'indicators' }),
    )
    this.redisSubClient.subscribe(serviceLogRedis, this.redisServiceLogListener)
  }

  @IdMute(mutex, (channel: string) => `${channel}getRedisCb`)
  @IdMute(cbMutex, () => 'getRedisCb')
  private getRedisCb(channel: string, payload: Record<string, unknown>) {
    const data = JSON.stringify(payload)
    this.redisClient?.publish(channel, data)
  }

  private redisServiceLogListener(msg: string) {
    try {
      const parse = JSON.parse(msg) as { restart?: unknown }
      // `serviceLog` is a shared bus: it also carries priceConnectorAlive
      // beacons, userStreamFlap and userStreamAuthReject, none of which have a
      // `.restart`. Only the restart beacons matter here, so guard before
      // calling string methods — otherwise every such message throws and is
      // logged as an error. Mirrors the safe pattern in the other consumers
      // (src/indicators/service.ts:processServiceLog, src/bot/main.ts).
      const restart = parse?.restart
      if (typeof restart !== 'string') {
        return
      }
      if (restart.startsWith('botService')) {
        const type = restart.replace('botService', '')
        this.handleDebug(
          `Bot service restarted, remove indicator callbacks for ${type}`,
        )
        const map =
          type === BotType.dca
            ? this.rabbitIdRoomsMapDca
            : this.rabbitIdRoomsMapCombo
        for (const k of map.keys()) {
          this.indicatorsFactory.removeCallback(k)
          map.delete(k)
        }
      }
    } catch (e) {
      this.handleError(`Failed to parse message: ${msg}, ${e}`)
    }
  }

  private rabbitListener() {
    this.rabbitClient?.listenWithCallback<
      RequestMessage,
      Promise<
        | {
            id: string
            status: boolean
            room: string
            message?: string
            data?: IndicatorHistory[]
            lastPrice?: number
          }
        | boolean
        | undefined
        | null
      >
    >(
      rabbitIndicatorsKey,
      async (msg) => {
        const result = await this.requestCallback(msg)
        if (typeof result === 'object' || typeof result === 'boolean') {
          return result
        }
      },
      200,
    )
  }

  private handleLog(...msg: any[]) {
    return logger.info(...msg)
  }

  private handleError(...msg: any[]) {
    return logger.error(...msg)
  }

  private handleDebug(...msg: any[]) {
    return logger.debug(...msg)
  }

  @IdMute(
    mutex,
    (msg: BotParentIndicatorEventDto) =>
      `${msg.responseParams.uuid}@${msg.responseParams.symbol}`,
  )
  private async subscribeIndicatorEvent(msg: BotParentIndicatorEventDto) {
    try {
      const subscriptionResult = await this.indicatorsFactory.subscribe(
        msg.data.indicatorConfig,
        msg.data.exchange,
        msg.data.symbol,
        msg.data.interval,
        msg.data.test,
        msg.data.limitMultiplier,
        msg.data.load1d,
      )
      if (!subscriptionResult) {
        this.handleError(
          `Failed to subscribe indicator: ${JSON.stringify(msg)}`,
        )
        return null
      }
      const { room, id, message, data, lastPrice } = subscriptionResult
      const map =
        msg.type === BotType.dca
          ? this.rabbitIdRoomsMapDca
          : this.rabbitIdRoomsMapCombo
      const get = map.get(room) ?? new Set()
      get.add(id)
      map.set(room, get)
      if (id && room) {
        this.handleDebug('Subscribed:', 'room', room, 'id', id)
      }
      if (this.rabbitClient) {
        return {
          id,
          status: !!id && !!room,
          room: room,
          message,
          data,
          lastPrice,
        }
      }
    } catch (e) {
      this.handleError(
        `Failed to subscribe indicator: ${JSON.stringify(msg)}`,
        e,
      )
      return null
    }
  }

  @IdMute(mutex, (msg: BotParentUnsubscribeIndicatorEventDto) => `${msg.id}`)
  private async unsubscribeIndicatorEvent(
    msg: BotParentUnsubscribeIndicatorEventDto,
  ) {
    const { id } = msg
    await this.indicatorsFactory.unsubscribe(id)

    const map =
      msg.type === BotType.dca
        ? this.rabbitIdRoomsMapDca
        : this.rabbitIdRoomsMapCombo
    for (const [room, ids] of map.entries()) {
      if (ids.has(id)) {
        ids.delete(id)
        if (ids.size === 0) {
          map.delete(room)
        }
        this.handleDebug('Unsubscribed:', 'room', room, 'id', id)
        return true
      }
    }
    return true
  }
  private async requestCallback(msg: RequestMessage) {
    this.handleDebug('Request:', msg.event)
    if (msg.event === 'subscribeIndicator') {
      return await this.subscribeIndicatorEvent(msg)
    }
    if (msg.event === 'unsubscribeIndicator') {
      return await this.unsubscribeIndicatorEvent(msg)
    }
  }
}

new IndicatorsService()

process
  .on('unhandledRejection', (reason, p) => {
    logger.error(reason, 'Unhandled Rejection at Promise', p)
  })
  .on('uncaughtException', (err) => {
    logger.error(err, 'Uncaught Exception thrown')
  })
