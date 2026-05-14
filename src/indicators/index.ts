import { Worker, isMainThread, threadId } from 'worker_threads'
import { ExchangeEnum, ExchangeIntervals, StatusEnum } from '../../types'
import logger from '../utils/logger'
import {
  mapPaperToReal,
  paperExchanges,
  PaperExchangeType,
} from '../exchange/paper/utils'
import type {
  IndicatorConfig,
  IndicatorCreationConfig,
  SubscribeInternalIndicatorReponse,
  IndicatorServiceParentMessageCreateIndicator,
  IndicatorServiceChildMessageCreateIndicator,
  IndicatorServiceParentMessageSubscribeIndicator,
  IndicatorServiceChildMessageSubscribeIndicator,
  IdicatorServiceChildMessageUnsubscribeIndicator,
  IndicatorServiceParentMessageUnsubscribeIndicator,
  IndicatorServiceParentMessageRemoveCallback,
  IndicatorServiceChildMessageDeleteIndicator,
  IndicatorServiceParentMessageDeleteIndicator,
  IndicatorServiceParentMessageGetState,
  IndicatorServiceChildMessageGetState,
  IndicatorState,
  LogLevel,
} from '../../types'
import { IdMute, IdMutex } from '../utils/mutex'
import { v4 } from 'uuid'
import { pairDb } from '../db/dbInit'
import ExpirableMap from '../utils/expirableMap'
import { INIDCATORS_PER_WORKER } from '../config'
import { CandlesProvider } from './candleProvider'

const mutex = new IdMutex()

const binanceSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.threeM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.twoH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.eightH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

const bybitSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.threeM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.twoH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

const kucoinSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.threeM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.twoH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.eightH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

const kucoinFuturesSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.twoH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.eightH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

const okxSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.threeM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.twoH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

const coinbaseSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.twoH,
  ExchangeIntervals.oneD,
]

const mexcSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

const krakenSupported = [
  ExchangeIntervals.oneM,
  ExchangeIntervals.fiveM,
  ExchangeIntervals.fifteenM,
  ExchangeIntervals.thirtyM,
  ExchangeIntervals.oneH,
  ExchangeIntervals.fourH,
  ExchangeIntervals.oneD,
  ExchangeIntervals.oneW,
]

export const filterIndicatorIntervalsByExchange = (
  intervals: ExchangeIntervals[],
  exchange: ExchangeEnum,
) => {
  if (
    [
      ExchangeEnum.binance,
      ExchangeEnum.binanceCoinm,
      ExchangeEnum.binanceUsdm,
    ].includes(exchange)
  ) {
    return intervals.filter((i) => binanceSupported.includes(i))
  }
  if (
    [
      ExchangeEnum.bybit,
      ExchangeEnum.bybitCoinm,
      ExchangeEnum.bybitUsdm,
    ].includes(exchange)
  ) {
    return intervals.filter((i) => bybitSupported.includes(i))
  }
  if (
    [ExchangeEnum.kucoinInverse, ExchangeEnum.kucoinLinear].includes(exchange)
  ) {
    return intervals.filter((i) => kucoinFuturesSupported.includes(i))
  }
  if ([ExchangeEnum.kucoin].includes(exchange)) {
    return intervals.filter((i) => kucoinSupported.includes(i))
  }
  if (
    [
      ExchangeEnum.okx,
      ExchangeEnum.okxLinear,
      ExchangeEnum.okxInverse,
    ].includes(exchange)
  ) {
    return intervals.filter((i) => okxSupported.includes(i))
  }
  if ([ExchangeEnum.coinbase].includes(exchange)) {
    return intervals.filter((i) => coinbaseSupported.includes(i))
  }
  if ([ExchangeEnum.mexc].includes(exchange)) {
    return intervals.filter((i) => mexcSupported.includes(i))
  }
  if (
    [ExchangeEnum.hyperliquid, ExchangeEnum.hyperliquidLinear].includes(
      exchange,
    )
  ) {
    return intervals.filter((i) => binanceSupported.includes(i))
  }
  if ([ExchangeEnum.kraken, ExchangeEnum.krakenUsdm].includes(exchange)) {
    return intervals.filter((i) => krakenSupported.includes(i))
  }
  return intervals
}

export const getId = (
  indicatorConfig: IndicatorConfig,
  exchange: ExchangeEnum,
  symbol: string,
  interval: ExchangeIntervals,
  limitMultiplier?: number,
) =>
  `${indicatorConfig.type}-${Object.keys(indicatorConfig).reduce(
    (acc, k) => `${acc}${indicatorConfig[k as keyof IndicatorConfig]}`,
    '',
  )}-${
    paperExchanges.includes(exchange)
      ? mapPaperToReal(exchange as PaperExchangeType)
      : exchange
  }-${symbol}-${interval}${limitMultiplier ? `-${limitMultiplier}` : ''}`

type WorkerType = {
  worker: Worker
  indicators: number
  id: number
  created: number
  updated: number
  check: {
    status: boolean
    time: number
  }
  limit: number
  heap?: {
    used: number
    limit: number
    code: number
  }
  heapHistory?: {
    used: number
    time: number
  }[]
  logLevel?: LogLevel
}

class InternalIndicatorsFactory {
  static instance: InternalIndicatorsFactory

  static getInstance(candlesProvider = CandlesProvider) {
    if (!InternalIndicatorsFactory.instance) {
      InternalIndicatorsFactory.instance = new InternalIndicatorsFactory(
        candlesProvider,
      )
    }
    return InternalIndicatorsFactory.instance
  }

  private indicators = new Map<
    string,
    {
      id: string
      workerId: number
      config: IndicatorCreationConfig
      subcribersSet: Set<string>
    }
  >()
  protected loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`
  protected subscribersCount = 0
  private splitPhrase = `@gainium@`
  protected workers: WorkerType[] = []

  private pairs = new ExpirableMap<string, { code: string }>(
    10 * 60 * 1000,
    true,
    true,
  )
  private pairsSize = 0
  constructor(candlesProvider = CandlesProvider) {
    this.handleWorkerTerminate = this.handleWorkerTerminate.bind(this)
    if (isMainThread) {
      logger.debug(`${this.loggerPrefix} InternalIndicatorsFactory initialized`)
      candlesProvider.getInstance()
    }
  }

  private getWorkerById(workerId: number) {
    return this.workers.find((w) => `${w.id}` === `${workerId}`)?.worker
  }

  private async createIndicator(id: string, config: IndicatorCreationConfig) {
    const worker = await this.getWorkerForNewIndicator()
    await this.changeWorkerIndicators(worker.threadId, 1)
    await new Promise(async (resolve, reject) => {
      const response = v4()
      const timeoutId = setTimeout(() => {
        worker.off('message', cb)
        reject(new Error('Create indicator timeout'))
      }, 30000) // 30 second timeout
      const cb = (m: any) => {
        const msg = m as IndicatorServiceChildMessageCreateIndicator
        if (msg && msg.response === response) {
          clearTimeout(timeoutId)
          worker.off('message', cb)
          resolve([])
        }
      }
      const payload: IndicatorServiceParentMessageCreateIndicator = {
        event: 'createIndicator',
        payload: config,
        response,
        id,
      }
      worker.on('message', cb)
      worker.postMessage(payload)
    })
    this.indicators.set(id, {
      id,
      workerId: worker.threadId,
      config,
      subcribersSet: new Set(),
    })
  }

  private async deleteIndicator(id: string) {
    const indicator = this.indicators.get(id)
    if (!indicator) {
      logger.error(
        `${this.loggerPrefix} Indicator not found in unsubscribe: ${id}`,
      )
      return null
    }
    const worker = this.getWorkerById(indicator.workerId)
    await new Promise(async (resolve, reject) => {
      const response = v4()
      const timeoutId = setTimeout(() => {
        worker?.off('message', cb)
        reject(new Error('Delete indicator timeout'))
      }, 30000)
      const cb = (m: any) => {
        const msg = m as IndicatorServiceChildMessageDeleteIndicator
        if (msg && msg.response === response) {
          clearTimeout(timeoutId)
          worker?.off('message', cb)
          resolve([])
        }
      }
      const payload: IndicatorServiceParentMessageDeleteIndicator = {
        event: 'deleteIndicator',
        response,
        id,
      }
      worker?.on('message', cb)
      worker?.postMessage(payload)
    })
    if (worker) {
      await this.changeWorkerIndicators(worker.threadId, -1)
    }
    this.indicators.delete(id)
  }

  private async subscribeIndicator(idi: string, id?: string, load1d?: boolean) {
    const indicator = this.indicators.get(idi)
    if (!indicator) {
      logger.error(
        `${this.loggerPrefix} Indicator not found in subscribe: ${idi}`,
      )
      return null
    }
    const worker = this.getWorkerById(indicator.workerId)
    return await new Promise<SubscribeInternalIndicatorReponse>(
      async (resolve, reject) => {
        const response = v4()
        const timeoutId = setTimeout(() => {
          worker?.off('message', cb)
          reject(new Error('Subscribe indicator timeout'))
        }, 30000)
        const cb = (m: any) => {
          const msg = m as IndicatorServiceChildMessageSubscribeIndicator
          if (msg && msg.response === response) {
            clearTimeout(timeoutId)
            worker?.off('message', cb)
            resolve(msg.data)
          }
        }
        const payload: IndicatorServiceParentMessageSubscribeIndicator = {
          event: 'subscribe',
          payload: [id, load1d],
          id: idi,
          response,
        }
        worker?.on('message', cb)
        worker?.postMessage(payload)
      },
    )
  }

  private async unsubscribeIndicator(idi: string, id: string) {
    const indicator = this.indicators.get(idi)
    if (!indicator) {
      logger.error(
        `${this.loggerPrefix} Indicator not found in unsubscribe: ${idi}`,
      )
      return null
    }
    const worker = this.getWorkerById(indicator.workerId)
    return await new Promise<number>(async (resolve, reject) => {
      const response = v4()
      const timeoutId = setTimeout(() => {
        worker?.off('message', cb)
        reject(new Error('Unsubscribe indicator timeout'))
      }, 30000)
      const cb = (m: any) => {
        const msg = m as IdicatorServiceChildMessageUnsubscribeIndicator
        if (msg && msg.response === response) {
          clearTimeout(timeoutId)
          worker?.off('message', cb)
          resolve(msg.data)
        }
      }
      const payload: IndicatorServiceParentMessageUnsubscribeIndicator = {
        event: 'unsubscribe',
        payload: [id],
        id: idi,
        response,
      }
      worker?.on('message', cb)
      worker?.postMessage(payload)
    })
  }

  private async removeCallbackIndicator(id: string) {
    const indicator = this.indicators.get(id)
    if (!indicator) {
      logger.error(
        `${this.loggerPrefix} Indicator not found in unsubscribe: ${id}`,
      )
      return null
    }
    const worker = this.getWorkerById(indicator.workerId)
    const payload: IndicatorServiceParentMessageRemoveCallback = {
      event: 'removeCallback',
      payload: [id],
      id: id,
      response: '',
    }
    worker?.postMessage(payload)
  }

  @IdMute(mutex, (id: number) => `handleWorkerTerminate${id}`)
  protected async handleWorkerTerminate(id: number) {
    logger.error(`${this.loggerPrefix} Worker terminated: ${id}`)
    const worker = this.workers.find((w) => w.id === id)
    this.workers = this.workers.filter((w) => w.id !== id)
    if (worker && worker.indicators > 0) {
      const indicators = [...this.indicators.values()].filter(
        (b) => b.workerId === id,
      )
      if (indicators.length) {
        for (const i of indicators) {
          this.indicators.delete(i.id)
          logger.debug(
            `${this.loggerPrefix} Worker terminated: ${id} | Indicator ${i.id} restarted`,
          )
          await this.createIndicator(i.id, i.config)
          for (const s of i.subcribersSet) {
            await this.subscribeIndicator(i.id, s.split(this.splitPhrase)[0])
            const find = this.indicators.get(i.id)
            if (find) {
              find.subcribersSet.add(s)
            }
          }
        }
      }
    }
  }

  @IdMute(mutex, () => 'workerUpdate')
  protected async getWorkerForNewIndicator() {
    const limit = +INIDCATORS_PER_WORKER
    const lowestWorker = [...this.workers]
      .filter((w) => w.indicators < limit)
      .sort((a, b) => b.indicators - a.indicators)?.[0]
    if (lowestWorker && lowestWorker.indicators < limit) {
      lowestWorker.updated = +new Date()
      // Update in place instead of reconstructing array
      const index = this.workers.findIndex((w) => w.id === lowestWorker.id)
      if (index !== -1) {
        this.workers[index] = lowestWorker
      }
      return lowestWorker.worker
    } else {
      const worker = new Worker(`${__dirname}/worker.js`)
      const threadId = +`${worker.threadId}`
      worker.on('error', (e) => {
        logger.error(
          `${this.loggerPrefix} Worker ${threadId} error: ${
            (e as Error)?.message || e
          } `,
        )
        logger.error(e)
        if (`${(e as Error)?.message || e}`.includes('terminated')) {
          this.handleWorkerTerminate(threadId)
        }
      })
      worker.on('exit', () => {
        logger.error(`${this.loggerPrefix} Worker ${threadId} exited`)
        this.handleWorkerTerminate(threadId)
      })
      const time = +new Date()
      this.workers.push({
        worker,
        indicators: 0,
        id: threadId,
        created: time,
        updated: time,
        check: {
          status: true,
          time,
        },
        limit,
      })
      return worker
    }
  }

  @IdMute(mutex, () => 'workerUpdate')
  private async changeWorkerIndicators(workerId: number, count: number) {
    const worker = this.workers.find((w) => `${w.id}` === `${workerId}`)
    if (worker) {
      worker.indicators += count

      this.workers = this.workers.filter((w) => `${w.id}` !== `${workerId}`)
      if (worker.indicators > 0) {
        this.workers = this.workers.concat(worker)
      } else {
        worker.worker.terminate()
      }
    }
  }

  @IdMute(mutex, () => 'checkPair')
  private async checkPair(pair: string, exchange: ExchangeEnum) {
    if (this.pairsSize !== this.pairs.size || !this.pairsSize) {
      logger.debug(`${this.loggerPrefix} Loading pairs from db`)
      const pairs = await pairDb.readData(
        { exchange: { $nin: paperExchanges } },
        {},
        {},
        true,
      )
      if (pairs.status === StatusEnum.notok) {
        logger.error(
          `${this.loggerPrefix} Error reading pairs in db: ${pairs.reason}`,
        )
        return true
      } else {
        this.pairsSize = (pairs.data?.result ?? []).length
        logger.debug(
          `${this.loggerPrefix} Loaded ${this.pairsSize} pairs from db`,
        )
        for (const p of pairs.data?.result ?? []) {
          this.pairs.set(`${p.pair}-${p.exchange}`, {
            code: p.code || '',
          })
        }
      }
    }
    return !!this.pairs.get(`${pair}-${exchange}`)
  }

  @IdMute(
    mutex,
    (
      indicatorConfig: IndicatorConfig,
      exchange: ExchangeEnum,
      symbol: string,
      interval: ExchangeIntervals,
      _cb: any,
      _test: boolean,
      limitMultiplier?: number,
    ) =>
      `subscribe${getId(
        indicatorConfig,
        exchange,
        symbol,
        interval,
        limitMultiplier,
      )}`,
  )
  public async subscribe(
    indicatorConfig: IndicatorConfig,
    exchange: ExchangeEnum,
    symbol: string,
    interval: ExchangeIntervals,
    test = false,
    limitMultiplier?: number,
    load1d = false,
  ) {
    let symbolCode: string | undefined
    try {
      /* if (
        [
          ExchangeEnum.hyperliquid,
          ExchangeEnum.hyperliquidLinear,
          ExchangeEnum.paperHyperliquid,
          ExchangeEnum.paperHyperliquidLinear,
        ].includes(exchange)
      ) {
        return {
          id: '',
          indicator: null,
          room: '',
          message: `Hyperliquid is disabled`,
        }
      } */
      if ([ExchangeEnum.mexc, ExchangeEnum.paperMexc].includes(exchange)) {
        return {
          id: '',
          indicator: null,
          room: '',
          message: `MEXC is disabled`,
        }
      }
      const ex = paperExchanges.includes(exchange)
        ? mapPaperToReal(exchange as PaperExchangeType)
        : exchange

      const pairExists = await this.checkPair(symbol, ex)
      if (!pairExists) {
        return {
          id: '',
          indicator: null,
          room: '',
          message: `Pair ${symbol} not found in exchange ${ex}`,
        }
      }

      if (
        [
          ExchangeEnum.hyperliquid,
          ExchangeEnum.paperHyperliquid,
          ExchangeEnum.hyperliquidLinear,
          ExchangeEnum.paperHyperliquidLinear,
        ].includes(exchange)
      ) {
        const find = this.pairs.get(`${symbol}-${exchange}`)
        if (find?.code) {
          symbolCode = find.code
        }
      }

      if (!filterIndicatorIntervalsByExchange([interval], ex).length) {
        return {
          id: '',
          indicator: null,
          room: '',
          message: `Interval ${interval} for ${symbol} not supported by exchange`,
        }
      }
      const id = getId(
        indicatorConfig,
        exchange,
        symbol,
        interval,
        limitMultiplier,
      )
      const find = this.indicators.get(id)
      if (find) {
        const result = await this.subscribeIndicator(id, undefined, load1d)
        if (!result) {
          logger.error(`${this.loggerPrefix} Error in subscribe: ${id}`)
          return null
        }
        find.subcribersSet.add(result.id)
        this.subscribersCount += 1
        return {
          id: result.id,
          room: id,
          data: result.data,
          lastPrice: result.lastPrice,
        }
      } else {
        await this.createIndicator(id, {
          indicatorConfig,
          interval,
          symbol,
          exchange: ex,
          test,
          limitMultiplier,
          load1d,
          symbolCode,
        })
        const subscriberId = await this.subscribeIndicator(
          id,
          undefined,
          load1d,
        )
        if (!subscriberId) {
          logger.error(`${this.loggerPrefix} Error in subscribe: ${id}`)
          return null
        }
        const get = this.indicators.get(id)
        if (get) {
          get.subcribersSet.add(subscriberId.id)
          this.subscribersCount += 1
        }
        return { id: subscriberId.id, room: id }
      }
    } catch (e) {
      logger.error(
        `${this.loggerPrefix} Error in subscribe: ${getId(
          indicatorConfig,
          exchange,
          symbol,
          interval,
        )} - ${e}`,
      )
      return null
    }
  }
  public async unsubscribe(id: string) {
    const [subscriberId, idToFind] = id.split(this.splitPhrase)
    const find = this.indicators.get(idToFind)
    if (find) {
      const left = await this.unsubscribeIndicator(idToFind, subscriberId)
      logger.debug(
        `${this.loggerPrefix} Unsubscribed: ${id} (${idToFind}), left: ${left}`,
      )
      if (left === 0) {
        await this.deleteIndicator(idToFind)
      }
      find.subcribersSet.delete(id)
      this.subscribersCount -= 1
    }
  }
  public async removeCallback(id: string) {
    const find = this.indicators.get(id)
    if (find) {
      this.subscribersCount -= find.subcribersSet.size
      find.subcribersSet = new Set()
      this.indicators.set(id, find)
      await this.removeCallbackIndicator(id)
    }
  }

  public async getRoomState(roomId: string): Promise<IndicatorState | null> {
    const indicator = this.indicators.get(roomId)
    if (!indicator) {
      return null
    }
    const worker = this.getWorkerById(indicator.workerId)
    if (!worker) {
      return null
    }
    return await new Promise<IndicatorState | null>((resolve, reject) => {
      const response = v4()
      const timeoutId = setTimeout(() => {
        worker.off('message', cb)
        reject(new Error('Get room state timeout'))
      }, 10000)
      const cb = (m: any) => {
        const msg = m as IndicatorServiceChildMessageGetState
        if (msg && msg.response === response) {
          clearTimeout(timeoutId)
          worker.off('message', cb)
          resolve(msg.data)
        }
      }
      const payload: IndicatorServiceParentMessageGetState = {
        event: 'getState',
        payload: [],
        id: roomId,
        response,
      }
      worker.on('message', cb)
      worker.postMessage(payload)
    })
  }
}

export default InternalIndicatorsFactory
