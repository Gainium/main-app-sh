import { parentPort, threadId } from 'worker_threads'
import InternalIndicator from './service'
import {
  IndicatorServiceChildMessageCreateIndicator,
  IndicatorServiceParentMessageMethods,
  IndicatorServiceParentMessageCreateIndicator,
  IndicatorServiceParentMessageDeleteIndicator,
  IndicatorServiceChildMessageDeleteIndicator,
  IndicatorServiceParentMessage,
} from '../../types'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'

const mutex = new IdMutex()

class IndicatorOperations {
  static instance: IndicatorOperations
  static getInstance() {
    if (!IndicatorOperations.instance) {
      IndicatorOperations.instance = new IndicatorOperations()
    }
    return IndicatorOperations.instance
  }

  private indicators = new Map<
    string,
    {
      id: string
      instance: InternalIndicator
    }
  >()

  public async createIndicator({
    id,
    payload,
    response,
  }: IndicatorServiceParentMessageCreateIndicator) {
    try {
      const instance = new InternalIndicator({
        ...payload,
      })
      this.indicators.set(id, { id, instance })
      parentPort?.postMessage({
        response,
      } as IndicatorServiceChildMessageCreateIndicator)
    } catch (e) {
      logger.error(
        `createIndicator Rejection at Promise Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }

  @IdMute(
    mutex,
    (data: IndicatorServiceParentMessageMethods) => `methodIndicator${data.id}`,
  )
  public async methodIndicator(data: IndicatorServiceParentMessageMethods) {
    try {
      const { event, payload, response, id } = data
      const i = this.indicators.get(id)
      if (i) {
        if (typeof i.instance[event] === 'function') {
          const result = await (i.instance[event] as any)(...payload)
          parentPort?.postMessage({ response, data: result })
        }
      }
      if (!i) {
        logger.error(`Worker ${threadId} indicator not found ${id}`)
      }
    } catch (e) {
      logger.error(
        `methodBot Rejection at Promise Worker ${threadId}, ${
          (e as Error)?.message ?? e
        } ${(e as Error)?.stack ?? ''}`,
      )
    }
  }

  public deleteIndicator(data: IndicatorServiceParentMessageDeleteIndicator) {
    const { id, response } = data
    const get = this.indicators.get(id)
    if (get) {
      delete (get as any).instance
    }
    this.indicators.delete(id)
    parentPort?.postMessage({
      response,
    } as IndicatorServiceChildMessageDeleteIndicator)
  }
}

parentPort?.on('message', (data: IndicatorServiceParentMessage) => {
  if (data.event === 'createIndicator') {
    IndicatorOperations.getInstance().createIndicator(data)
  }
  if (
    data.event === 'removeCallback' ||
    data.event === 'subscribe' ||
    data.event === 'unsubscribe' ||
    data.event === 'getState'
  ) {
    IndicatorOperations.getInstance().methodIndicator(data)
  }
  if (data.event === 'deleteIndicator') {
    IndicatorOperations.getInstance().deleteIndicator(data)
  }
})

process
  .on('unhandledRejection', (reason, p) => {
    logger.error(reason, `Unhandled Rejection at Promise Worker ${threadId}`, p)
  })
  .on('uncaughtException', (err) => {
    logger.error(err, `Uncaught Exception thrown Worker ${threadId}`)
  })
