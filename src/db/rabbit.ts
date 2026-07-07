import { isMainThread, threadId } from 'worker_threads'

import amqplib, {
  type Connection,
  type Channel,
  type Replies,
} from 'amqplib/callback_api'
import { v4 } from 'uuid'

import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import utils from '../utils'
import { rabbitExchange } from '../../types'
import { RABBIT_HOST, RABBIT_PASSWORD, RABBIT_USER } from '../config'

const { sleep } = utils

const prefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

const mutex = new IdMutex()

const sendMutex = new IdMutex(1000)

const sendWithCallbackMutex = new IdMutex(1000)

const retryTimeout = 30 * 1000

// --- RPC-latency counters (Phase 4b) ------------------------------------------
// Module-level (NOT per-instance) so every Rabbit instance in a process
// accumulates into the same table — the main-app publisher reads a snapshot of
// this and computes deltas. Purely additive, zero-dep, and every mutation is
// wrapped so a counter bug can never affect an RPC. Cumulative — never reset
// here; the publisher diffs against its own last snapshot.
interface RpcQueueStat {
  count: number
  sumMs: number
  maxMs: number
  breaches: number
  timeouts: number
}

// A completed sendWithCallback slower than this counts as a latency breach.
const RPC_BREACH_MS = Number(process.env.RPC_LATENCY_BREACH_MS) || 10000

const rpcLatencyStats = new Map<string, RpcQueueStat>()

const rpcStatFor = (queue: string): RpcQueueStat => {
  let s = rpcLatencyStats.get(queue)
  if (!s) {
    s = { count: 0, sumMs: 0, maxMs: 0, breaches: 0, timeouts: 0 }
    rpcLatencyStats.set(queue, s)
  }
  return s
}

/** Record a successfully-completed RPC's round-trip time. Never throws. */
const recordRpcSuccess = (queue: string, totalMs: number): void => {
  try {
    const s = rpcStatFor(queue)
    s.count += 1
    s.sumMs += totalMs
    if (totalMs > s.maxMs) s.maxMs = totalMs
    if (totalMs > RPC_BREACH_MS) s.breaches += 1
  } catch {
    // counters must never affect the RPC
  }
}

/** Record a hard-timeout rejection (a failed RPC → also a breach). Never throws. */
const recordRpcTimeout = (queue: string): void => {
  try {
    const s = rpcStatFor(queue)
    s.count += 1
    s.timeouts += 1
    s.breaches += 1
  } catch {
    // counters must never affect the RPC
  }
}

/**
 * Cumulative RPC-latency counters keyed by queue name, aggregated across every
 * Rabbit instance in this process. Returns a shallow snapshot (copies) so the
 * caller can't mutate the live table. Cumulative — the caller computes deltas.
 */
export const getRpcLatencyStats = (): Record<string, RpcQueueStat> => {
  const out: Record<string, RpcQueueStat> = {}
  for (const [queue, s] of rpcLatencyStats.entries()) {
    out[queue] = {
      count: s.count,
      sumMs: s.sumMs,
      maxMs: s.maxMs,
      breaches: s.breaches,
      timeouts: s.timeouts,
    }
  }
  return out
}
// ------------------------------------------------------------------------------

class ChannelPool {
  private channels: Channel[] = []
  private dedicatedChannels: Channel[] = []
  private currentIndex = 0
  private dedicatedIndex = 0
  private connection: Connection | null = null
  private poolSize = 5

  constructor(connection: Connection) {
    this.connection = connection
  }

  async initialize(): Promise<void> {
    logger.info(
      `${prefix} Initializing channel pool with size ${this.poolSize}`,
    )
    for (let i = 0; i < this.poolSize; i++) {
      await this.addChannel()
    }

    for (let i = 0; i < this.poolSize; i++) {
      await this.addDedicatedChannel()
    }

    logger.info(
      `${prefix} Channel pool initialized with ${this.channels.length} regular and ${this.dedicatedChannels.length} dedicated channels`,
    )
  }

  private async addChannel(): Promise<void> {
    if (!this.connection) {
      throw new Error('No connection available for channel creation')
    }

    await new Promise<void>((resolve) => {
      this.connection?.createChannel(async (err, channel) => {
        if (err || !channel) {
          logger.error(`${prefix} Failed to create channel: ${err}`)
          resolve()
          return
        }

        channel.assertExchange(rabbitExchange, 'direct', {
          durable: true,
        })

        this.channels.push(channel)
        resolve()
      })
    })
  }

  private async addDedicatedChannel(): Promise<void> {
    if (!this.connection) {
      throw new Error('No connection available for channel creation')
    }

    await new Promise<void>((resolve) => {
      this.connection?.createChannel((err, channel) => {
        if (err || !channel) {
          logger.error(`${prefix} Failed to create dedicated channel: ${err}`)
          resolve()
          return
        }

        channel.prefetch(1)

        this.dedicatedChannels.push(channel)
        resolve()
      })
    })
  }

  getChannel(): Channel | null {
    if (this.channels.length === 0) {
      return null
    }

    const channel = this.channels[this.currentIndex]
    this.currentIndex = (this.currentIndex + 1) % this.channels.length
    return channel
  }

  getDedicatedChannel(): Channel | null {
    if (this.dedicatedChannels.length === 0) {
      if (this.connection) {
        let channel: Channel | null = null
        this.connection.createChannel((err, ch) => {
          if (!err && ch) {
            channel = ch
          }
        })
        if (channel) {
          if (this.dedicatedChannels.length < this.poolSize) {
            this.dedicatedChannels.push(channel)
          }
          return channel
        }
      }
      return null
    }

    const channel = this.dedicatedChannels[this.dedicatedIndex]
    this.dedicatedIndex =
      (this.dedicatedIndex + 1) % this.dedicatedChannels.length
    return channel
  }

  close(): void {
    this.channels.forEach((channel) => {
      try {
        channel.close(() => null)
      } catch (err) {
        logger.error(`${prefix} Error closing channel: ${err}`)
      }
    })
    this.dedicatedChannels.forEach((channel) => {
      try {
        channel.close(() => null)
      } catch (err) {
        logger.error(`${prefix} Error closing dedicated channel: ${err}`)
      }
    })
    this.channels = []
    this.dedicatedChannels = []
  }
}

class Client {
  static client: Connection | null = null
  static channelPool: ChannelPool | null = null
  static channel: Channel | null = null // Keep for backward compatibility

  static async reconnect() {
    logger.info(`${prefix} Reconnect RabbitMQ`)
    if (Client.channelPool) {
      Client.channelPool.close()
      Client.channelPool = null
    }
    Client.client = null
    Client.channel = null
    Client.connect()
  }

  @IdMute(mutex, () => 'rabbitconnect')
  static async connect() {
    logger.info(`${prefix} Connect RabbitMQ`)
    if (Client.client) {
      logger.info(`${prefix} RabbitMQ already connected`)
      return
    }
    await new Promise((resolve) => {
      amqplib.connect(
        `amqp://${RABBIT_USER}:${RABBIT_PASSWORD}@${RABBIT_HOST}`,
        async (err, conn) => {
          conn?.on('error', async (_err) => {
            logger.error(`${prefix} RabbitMQ Client Error: ${_err}`)
            await sleep(retryTimeout)
            await Client.reconnect()
          })
          conn?.on('close', async (_err) => {
            logger.error(`${prefix} RabbitMQ Client Closed: ${_err}`)
            await sleep(retryTimeout)
            await Client.reconnect()
          })
          if (err) {
            logger.error(`${prefix} RabbitMQ Client Connection Error: ${err}`)
            await sleep(retryTimeout)
            Client.connect()
            resolve([])
          }
          Client.client = Client.client ?? conn ?? null

          if (Client.client && !Client.channelPool) {
            Client.channelPool = new ChannelPool(Client.client)
            await Client.channelPool.initialize()

            if (!Client.channel && Client.channelPool) {
              Client.channel = Client.channelPool.getChannel()
            }
          }

          resolve([])
        },
      )
    })
  }

  @IdMute(mutex, () => 'rabbitgetclient')
  static async getClient(): Promise<{
    client: Connection | null
    channel: Channel | null
    channelPool: ChannelPool | null
  }> {
    if (!Client.client || !Client.channelPool) {
      await Client.connect()
    }
    return {
      client: Client.client,
      channel: Client.channel,
      channelPool: Client.channelPool,
    }
  }
}

class Rabbit {
  public client: Connection | null = null
  public channel: Channel | null = null
  private logTimeout = 60 * 1000

  private async getClient() {
    return await Client.getClient()
  }

  @IdMute(sendWithCallbackMutex, (queue: string) => `sendWithCallback-${queue}`)
  async sendWithCallback<P, R>(
    queue: string,
    payload: P,
    timeout?: number,
  ): Promise<{ response: R | null } | null> {
    try {
      const startTime = performance.now()
      const { client, channelPool } = await this.getClient()
      if (!client || !channelPool) {
        logger.error(
          `${prefix} No client or channelPool in sendWithCallback for ${queue}`,
        )
        return null
      }

      const dedicatedChannel = channelPool.getDedicatedChannel()
      if (!dedicatedChannel) {
        logger.error(
          `${prefix} Failed to get dedicated channel in sendWithCallback for ${queue}`,
        )
        return null
      }

      const queueStartTime = performance.now()
      const replyQueue = await new Promise<Replies.AssertQueue>((resolve) => {
        dedicatedChannel.assertQueue(
          '',
          { exclusive: true, autoDelete: true },
          (_, q) => {
            resolve(q)
          },
        )
      })
      const queueAssertTime = performance.now() - queueStartTime

      if (queueAssertTime > this.logTimeout) {
        logger.warn(
          `${prefix} Queue assertion took ${queueAssertTime.toFixed(
            2,
          )}ms for ${queue}`,
        )
      }

      const correlationId = v4()
      const message = {
        payload,
        replyTo: replyQueue.queue,
        correlationId,
      }

      const result = dedicatedChannel.publish(
        rabbitExchange,
        queue,
        Buffer.from(JSON.stringify(message)),
        {
          correlationId,
          replyTo: replyQueue.queue,
        },
      )

      if (!result) {
        logger.error(
          `${prefix} Failed to send message to queue ${queue} in sendWithCallback`,
        )
        return null
      }
      let tag: Replies.Consume | null = null

      const cleanUp = async () => {
        if (tag) {
          await new Promise((resolve) => {
            try {
              tag && dedicatedChannel.cancel(tag.consumerTag, resolve)
            } catch (e) {
              logger.error(
                `${prefix} Error in sendWithCallback cancel for ${queue}: ${e}`,
              )
              resolve([])
            }
          })
        }

        await new Promise<void>((resolve) => {
          try {
            dedicatedChannel.deleteQueue(replyQueue.queue, {}, () => {
              resolve()
            })
          } catch (e) {
            logger.error(`${prefix} Error deleting queue for ${queue}: ${e}`)
            resolve()
          }
        })
      }

      return new Promise<{ response: R | null } | null>(
        async (resolve, reject) => {
          let time: NodeJS.Timeout | null = null
          if (timeout) {
            time = setTimeout(async () => {
              logger.error(
                `${prefix} Timeout for ${queue} in sendWithCallback ${JSON.stringify(
                  payload,
                )} ${correlationId}`,
              )
              recordRpcTimeout(queue)
              await cleanUp()
              reject(null)
            }, timeout)
          }

          dedicatedChannel.consume(
            replyQueue.queue,
            async (msg) => {
              if (msg && msg.properties.correlationId === correlationId) {
                if (time) {
                  clearTimeout(time)
                }
                try {
                  dedicatedChannel.ack(msg)
                } catch (ackError) {
                  logger.error(
                    `${prefix} Error acknowledging reply message in ${queue}: ${ackError}`,
                  )
                }

                const result = JSON.parse(msg.content.toString()) as {
                  response: R | null
                }

                const totalTime = performance.now() - startTime
                recordRpcSuccess(queue, totalTime)
                if (totalTime > this.logTimeout) {
                  logger.warn(
                    `${prefix} sendWithCallback operation took ${totalTime.toFixed(
                      2,
                    )}ms for queue ${queue}`,
                  )
                }

                cleanUp()
                resolve(result)
              }
            },
            undefined,
            (_, ok) => {
              tag = ok
            },
          )
        },
      ).catch(() => {
        return null
      })
    } catch (e) {
      logger.error(`${prefix} Error in sendWithCallback for ${queue}: ${e}`)
      return null
    }
  }

  @IdMute(sendMutex, (queue: string) => `rabbit-send-${queue}`)
  async send<P>(queue: string, payload: P): Promise<void> {
    try {
      const { client, channelPool } = await this.getClient()
      if (!client || !channelPool) {
        logger.error(`${prefix} No client or channelPool in send in ${queue}`)
        return
      }

      const channel = channelPool.getChannel()
      if (!channel) {
        logger.error(`${prefix} Failed to get channel for send to ${queue}`)
        return
      }
      const result = channel.publish(
        rabbitExchange,
        queue,
        Buffer.from(JSON.stringify({ payload })),
      )
      if (!result) {
        logger.error(
          `${prefix} Failed to send message to queue ${queue} in send`,
        )
        return
      }
    } catch (e) {
      logger.error(`${prefix} Error in send in ${queue}: ${e}, ${payload}`)
      return
    }
  }

  async listenWithCallback<P, R>(
    queue: string,
    callback: (data: P) => Promise<R> | R | undefined,
    maxSize?: number,
    count = 0,
  ): Promise<string | null> {
    try {
      logger.info(`${prefix} Listen with callback for ${queue}`)
      const { client, channelPool } = await this.getClient()
      if (!client || !channelPool) {
        logger.error(
          `${prefix} No client or channelPool in listenWithCallback for ${queue}`,
        )
        throw new Error('No client or channelPool')
      }

      const channel = channelPool.getChannel()
      if (!channel) {
        logger.error(`${prefix} Failed to get channel for listener ${queue}`)
        throw new Error('Failed to get channel')
      }

      client.on('close', () =>
        this.listenWithCallback.bind(this)(queue, callback, maxSize),
      )

      const queueStartTime = performance.now()
      const q = await new Promise<Replies.AssertQueue>((resolve) => {
        channel.assertQueue(
          queue,
          {
            durable: true,
          },
          (_, q) => {
            resolve(q)
          },
        )
      })
      const queueAssertTime = performance.now() - queueStartTime

      if (queueAssertTime > this.logTimeout) {
        logger.warn(
          `${prefix} Queue assertion took ${queueAssertTime.toFixed(
            2,
          )}ms for listener ${queue}`,
        )
      }

      await new Promise((resolve) =>
        channel.bindQueue(q.queue, rabbitExchange, queue, undefined, resolve),
      )

      const prefetchCount = typeof maxSize === 'number' ? maxSize : 10
      channel.prefetch(prefetchCount)

      const consume = await new Promise<Replies.Consume>((resolve) => {
        channel.consume(
          queue,
          async (msg) => {
            if (!msg) {
              return
            }
            const processStartTime = performance.now()
            const request = JSON.parse(msg.content.toString())
            const payload = request.payload as P

            try {
              const result = await callback(payload)
              try {
                channel.ack(msg)
              } catch (ackError) {
                logger.error(
                  `${prefix} Error acknowledging successful message in ${queue}: ${ackError}`,
                )
              }
              const isNull =
                typeof result === 'undefined' ||
                `${result}` === 'undefined' ||
                `${result}` === 'null'

              const response = isNull
                ? null
                : typeof result === 'object'
                  ? Array.isArray(result)
                    ? [...result]
                    : { ...result }
                  : result

              if (msg.properties.replyTo) {
                const sendResult = channel.sendToQueue(
                  msg.properties.replyTo,
                  Buffer.from(JSON.stringify({ response })),
                  {
                    correlationId: msg.properties.correlationId,
                  },
                )

                if (!sendResult) {
                  logger.error(
                    `${prefix} No sendResult in listenWithCallback for ${queue} ${msg.properties.replyTo}`,
                  )
                }
              }

              const processingTime = performance.now() - processStartTime
              if (processingTime > this.logTimeout) {
                logger.debug(
                  `${prefix} Message processing took ${processingTime.toFixed(
                    2,
                  )}ms for ${queue}`,
                )
              }
            } catch (e) {
              // Only ack if channel is still open to prevent IllegalOperationError
              try {
                channel.ack(msg) // Always ack to prevent queue blocking
              } catch (ackError) {
                logger.error(
                  `${prefix} Error acknowledging message in ${queue}: ${ackError}`,
                )
              }
              logger.error(
                `${prefix} Error in listenWithCallback for ${queue}: ${e}`,
              )
            }
          },
          undefined,
          (_, ok) => {
            resolve(ok)
          },
        )
      })

      return consume.consumerTag
    } catch (e) {
      logger.error(
        `${prefix} Error in listenWithCallback for ${queue}: ${e} ${count}`,
      )
      if (count < 5) {
        logger.warn(`${prefix} Retry listenWithCallback for ${queue}`)
        await sleep(retryTimeout)
        return this.listenWithCallback(queue, callback, maxSize, count + 1)
      }
      return null
    }
  }
}

export default Rabbit
