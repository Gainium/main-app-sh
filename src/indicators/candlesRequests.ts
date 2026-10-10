import { isMainThread, threadId } from 'worker_threads'

import RabbitClient from '../db/rabbit'
import logger from '../utils/logger'

const loggerPrefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

export interface CandlesRequest {
  symbol: string
  exchange: string
  interval: string
}

type Sender = (payload: CandlesRequest) => Promise<void> | void

const FLUSH_DELAY_MS = 250

/**
 * Coalesces the `candlesRequests` an indicator worker publishes.
 *
 * Every indicator instance asks the price connector for its own
 * symbol/exchange/interval stream, and when the connector restarts they all
 * re-ask in the same tick. Many instances share a stream (RSI, MA, ... on one
 * pair), so the burst is mostly duplicates and big enough to overrun the
 * channel's write buffer.
 *
 * Requests are held for a short window and identical ones are sent once. A
 * request is only ever merged with an identical one that has not been sent
 * yet; once a batch is flushed the next request starts a new batch, so no
 * request is ever dropped — at worst it is delayed by the window.
 */
export class CandlesRequestBatcher {
  private static _instance: CandlesRequestBatcher | null = null

  static getInstance(): CandlesRequestBatcher {
    if (!CandlesRequestBatcher._instance) {
      const rabbit = new RabbitClient()
      CandlesRequestBatcher._instance = new CandlesRequestBatcher((payload) =>
        rabbit.send('candlesRequests', payload),
      )
    }
    return CandlesRequestBatcher._instance
  }

  private pending = new Map<string, CandlesRequest>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private sender: Sender,
    private delayMs = FLUSH_DELAY_MS,
  ) {}

  request(payload: CandlesRequest) {
    const key = `${payload.symbol}@${payload.exchange}@${payload.interval}`
    if (!this.pending.has(key)) {
      this.pending.set(key, { ...payload })
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs)
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch = [...this.pending.values()]
    this.pending.clear()
    for (const payload of batch) {
      // sequential: rabbit `send` waits out write-buffer backpressure
      try {
        await this.sender(payload)
      } catch (e) {
        logger.error(
          `${loggerPrefix} candlesRequests send failed for ${payload.symbol}@${payload.exchange}@${payload.interval}: ${e}`,
        )
      }
    }
  }

  get pendingCount() {
    return this.pending.size
  }
}
