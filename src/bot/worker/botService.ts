import { parentPort, threadId } from 'worker_threads'
import createDCABotHelper from '../../bot/dcaHelper'
import {
  BotType,
  CreateBotDto,
  MethodBotDto,
  BotWorkerDto,
  UpdateBotExchangeDto,
  ExchangeEnum,
  DeleteBotDto,
} from '../../../types'
import { IdMute, IdMutex } from '../../utils/mutex'
import logger from '../../utils/logger'
import v8 from 'v8'
import { monitorEventLoopDelay } from 'perf_hooks'
import { v4 } from 'uuid'
import createComboBotHelper from '../../bot/comboHelper'
import createHedgeBotHelper from '../hedgeHelper'
import createBotHelper from '../../bot/helper'

const mutex = new IdMutex()

const mutexConcurrentely = new IdMutex(1000)

/**
 * Event-loop delay histogram for this worker. A blocked/saturated event loop is
 * the root cause behind the recurring "bot stuck in error, only a manual restart
 * clears it" signature: the loop can't service the bot's orders, so the bot never
 * re-evaluates itself out of the error state. We sample mean/max delay and report
 * it to the parent on each health ping (then reset), so the parent has a leading
 * signal of a wedging worker before the ping itself starts timing out.
 */
const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 })
eventLoopMonitor.enable()

class BotOperations {
  static instance: BotOperations
  static getInstance() {
    if (!BotOperations.instance) {
      BotOperations.instance = new BotOperations()
    }
    return BotOperations.instance
  }

  private bots: {
    id: string
    b: InstanceType<ReturnType<typeof createBotHelper>>
    userId: string
    exchange: ExchangeEnum
  }[] = []

  private dcaBots: {
    id: string
    b: InstanceType<ReturnType<typeof createDCABotHelper>>
    userId: string
    exchange: ExchangeEnum
  }[] = []

  private comboBots: {
    id: string
    b: InstanceType<ReturnType<typeof createComboBotHelper>>
    userId: string
    exchange: ExchangeEnum
  }[] = []

  private hedgeComboBots: {
    id: string
    b: InstanceType<ReturnType<typeof createHedgeBotHelper>>
    userId: string
  }[] = []

  private hedgeDcaBots: {
    id: string
    b: InstanceType<ReturnType<typeof createHedgeBotHelper>>
    userId: string
  }[] = []

  @IdMute(mutex, (data: CreateBotDto) => `createBot${data.botId}`)
  public createBot(data: CreateBotDto) {
    try {
      const { botType, botId, args, userId, exchange } = data
      let create = false
      if (botType === BotType.dca) {
        if (this.dcaBots.find((b) => b.id === botId)) {
          create = true
        } else {
          const DCABotClass = createDCABotHelper()
          const bot = new DCABotClass(
            ...(args as ConstructorParameters<typeof DCABotClass>),
          )
          this.dcaBots.push({ id: botId, b: bot, userId, exchange })
          create = true
        }
      }
      if (botType === BotType.grid) {
        if (this.bots.find((b) => b.id === botId)) {
          create = true
        } else {
          const BotClass = createBotHelper()
          const bot = new BotClass(
            ...(args as ConstructorParameters<typeof BotClass>),
          )
          this.bots.push({ id: botId, b: bot, userId, exchange })
          create = true
        }
      }
      if (botType === BotType.combo) {
        if (this.comboBots.find((b) => b.id === botId)) {
          create = true
        } else {
          const ComboBotClass = createComboBotHelper()
          const bot = new ComboBotClass(
            ...(args as ConstructorParameters<typeof ComboBotClass>),
          )
          this.comboBots.push({ id: botId, b: bot, userId, exchange })
          create = true
        }
      }
      if (botType === BotType.hedgeCombo) {
        if (this.hedgeComboBots.find((b) => b.id === botId)) {
          create = true
        } else {
          const HedgeBotClass = createHedgeBotHelper()
          const bot = new HedgeBotClass(
            ...(args as ConstructorParameters<typeof HedgeBotClass>),
          )
          this.hedgeComboBots.push({ id: botId, b: bot, userId })
          create = true
        }
      }
      if (botType === BotType.hedgeDca) {
        if (this.hedgeDcaBots.find((b) => b.id === botId)) {
          create = true
        } else {
          const HedgeBotClass = createHedgeBotHelper()
          const bot = new HedgeBotClass(
            ...(args as ConstructorParameters<typeof HedgeBotClass>),
          )
          this.hedgeDcaBots.push({ id: botId, b: bot, userId })
          create = true
        }
      }
      parentPort?.postMessage({ event: 'createBot', botId, create })
    } catch (e) {
      logger.error(
        `createBot Rejection at Promise Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }

  @IdMute(mutex, (data: MethodBotDto) =>
    data.method === 'getStats' || data.method === 'openDealBySignal'
      ? v4()
      : data.method === 'mergeDeals'
        ? `mergeDeals${data.botId}`
        : `methodBot${data.botId}`,
  )
  @IdMute(mutexConcurrentely, () => `methodBot`)
  public async methodBot(data: MethodBotDto) {
    try {
      const { botType, botId, method, args, responseId, ping } = data
      let response: unknown = null
      let bot:
        | (typeof this.bots)[0]
        | (typeof this.dcaBots)[0]
        | (typeof this.comboBots)[0]
        | (typeof this.hedgeComboBots)[0]
        | (typeof this.hedgeDcaBots)[0]
        | undefined
      if (botType === BotType.dca) {
        bot = this.dcaBots.find((b) => b.id === botId)
      }
      if (botType === BotType.grid) {
        bot = this.bots.find((b) => b.id === botId)
      }
      if (botType === BotType.combo) {
        bot = this.comboBots.find((b) => b.id === botId)
      }
      if (botType === BotType.hedgeCombo) {
        bot = this.hedgeComboBots.find((b) => b.id === botId)
      }
      if (botType === BotType.hedgeDca) {
        bot = this.hedgeDcaBots.find((b) => b.id === botId)
      }
      if (bot) {
        if (method in bot.b) {
          const fn = bot.b[method as keyof typeof bot.b]
          if (typeof fn === 'function') {
            response = await (fn as any).apply(bot.b, args as any[])
          }
        } else {
          if (botType === BotType.hedgeCombo || botType === BotType.hedgeDca) {
            response = await (
              bot as
                | (typeof this.hedgeComboBots)[0]
                | (typeof this.hedgeDcaBots)[0]
            ).b.sendCommandToBotService(method, ...args)
          }
        }
      }
      if (!bot) {
        logger.warn(`Worker ${threadId} bot not found ${botId} ${botType}`)
      }
      if (responseId) {
        parentPort?.postMessage({
          event: 'response',
          responseId,
          botId,
          response,
        })
      }
      if (ping) {
        const data = v8.getHeapStatistics()
        // ns → ms; reset so each sample reflects the window since the last ping.
        const eventLoopLag = {
          mean: Math.round(eventLoopMonitor.mean / 1e6),
          max: Math.round(eventLoopMonitor.max / 1e6),
        }
        eventLoopMonitor.reset()
        parentPort?.postMessage({
          event: 'pong',
          pong: {
            ping,
            heap: {
              limit: data.heap_size_limit,
              used: data.total_physical_size,
              code: data.total_heap_size_executable,
            },
            eventLoopLag,
          },
        })
      }
    } catch (e) {
      logger.error(
        `methodBot Rejection at Promise Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }

  @IdMute(mutex, (data: UpdateBotExchangeDto) => `updateBot${data.userId}`)
  public async updateBotExchange(data: UpdateBotExchangeDto) {
    try {
      const {
        exchangeUUID,
        key,
        secret,
        passphrase,
        userId,
        keysType,
        okxSource,
        bybitHost,
      } = data
      for (const b of this.bots.filter((b) => b.userId === userId)) {
        b.b.setExchangeCredentials(
          exchangeUUID,
          key,
          secret,
          passphrase,
          keysType,
          okxSource,
          bybitHost,
          true,
        )
      }
      for (const b of this.dcaBots.filter((b) => b.userId === userId)) {
        b.b.setExchangeCredentials(
          exchangeUUID,
          key,
          secret,
          passphrase,
          keysType,
          okxSource,
          bybitHost,
          true,
        )
      }
      for (const b of this.comboBots.filter((b) => b.userId === userId)) {
        b.b.setExchangeCredentials(
          exchangeUUID,
          key,
          secret,
          passphrase,
          keysType,
          okxSource,
          bybitHost,
          true,
        )
      }
    } catch (e) {
      logger.error(
        `updateBot Rejection at Promise Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }

  public deleteBot(data: DeleteBotDto) {
    const { botType, botId } = data
    if (botType === BotType.dca) {
      this.dcaBots = this.dcaBots.filter((b) => {
        if (b.id === botId) {
          ;(b as any).b = undefined
          return false
        }
        return true
      })
    }
    if (botType === BotType.grid) {
      this.bots = this.bots.filter((b) => {
        if (b.id === botId) {
          ;(b as any).b = undefined
          return false
        }
        return true
      })
    }
    if (botType === BotType.combo) {
      this.comboBots = this.comboBots.filter((b) => {
        if (b.id === botId) {
          ;(b as any).b = undefined
          return false
        }
        return true
      })
    }
  }
}

const processMessage = (data: BotWorkerDto) => {
  if (data.do) {
    logger.debug(
      `Worker ${threadId} Message ${data.do} ${
        data.do === 'exchangeInfo' ? '' : JSON.stringify(data)
      }`,
    )
  }
  if (data.do === 'ramDump') {
    logger.debug(`ramDump for ${threadId}`)
    v8.writeHeapSnapshot()
  }
  if (data.do === 'create') {
    BotOperations.getInstance().createBot(data)
  }
  if (data.do === 'method') {
    BotOperations.getInstance().methodBot(data)
  }
  if (data.do === 'update') {
    BotOperations.getInstance().updateBotExchange(data)
  }
  if (data.do === 'delete') {
    BotOperations.getInstance().deleteBot(data)
  }
}

parentPort?.on('message', (data: BotWorkerDto | BotWorkerDto[]) => {
  if (Array.isArray(data)) {
    data.forEach((d) => processMessage(d))
  }
  if (data && !Array.isArray(data)) {
    processMessage(data)
  }
})

process
  .on('unhandledRejection', (reason, p) => {
    logger.error(reason, `Unhandled Rejection at Promise Worker ${threadId}`, p)
  })
  .on('uncaughtException', (err) => {
    logger.error(err, `Uncaught Exception thrown Worker ${threadId}`)
  })
