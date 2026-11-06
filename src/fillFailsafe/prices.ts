import logger from '../utils/logger'
import RedisClient from '../db/redis'
import { ExchangeEnum, PriceMessage } from '../../types'
import { LOG_PREFIX, Tick, symKey } from './types'

const FLUSH_TIMEOUT = 15_000
/**
 * Price feed (spec §3.1). ONE dedicated Redis subscriber with DYNAMIC
 * `trade@{symbol}@{realExchange}` subscriptions for exactly the registry's
 * symbol/exchange pairs — sub/unsub as the registry changes (paper-trading's
 * pattern). Parsed ticks are forwarded to `onTick`.
 *
 * The 60 s snapshot pass reads the Redis `latestPrice` hash (field
 * `${exchange}${symbol}`, value = JSON `BaseReturn<number>`; spec §3.1) for
 * registry pairs that haven't ticked in the last 60 s, bridging feed-gaps while
 * the built-in price watchdog restarts flapping channels.
 */
export class PriceFeed {
  private subscribed = new Map<
    string,
    { symbol: string; exchange: ExchangeEnum }
  >()
  /** last tick wall-clock ms per (symbol,exchange) — drives the snapshot pass. */
  private lastTickAt = new Map<string, number>()
  private onTick: (tick: Tick) => void
  private cacheTicks: Map<string, Tick> = new Map()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(onTick: (tick: Tick) => void) {
    this.onTick = onTick
    this.handleMessage = this.handleMessage.bind(this)
    this.flushTicks = this.flushTicks.bind(this)
    this.flushTimer = setInterval(() => {
      this.flushTicks()
    }, FLUSH_TIMEOUT)
  }

  private channel(symbol: string, exchange: ExchangeEnum): string {
    return `trade@${symbol}@${exchange}`
  }

  public stop() {
    if (!this.flushTimer) return
    clearInterval(this.flushTimer)
    this.flushTimer = null
  }

  private flushTicks() {
    const values = [...this.cacheTicks.values()]
    for (const tick of values) {
      this.onTick({
        symbol: tick.symbol,
        exchange: tick.exchange,
        minPrice: tick.minPrice,
        maxPrice: tick.maxPrice,
        time: tick.time ?? Date.now(),
      })
    }
    this.cacheTicks = new Map()
  }

  private handleMessage(msg: string, channel: string): void {
    try {
      const parts = channel.split('@')
      const symbol = parts[1]
      const exchange = parts[2] as ExchangeEnum
      const parsed = JSON.parse(msg) as PriceMessage
      if (typeof parsed?.price !== 'number') return
      this.lastTickAt.set(symKey(symbol, exchange), parsed.time ?? Date.now())
      const key = `${symbol}@${exchange}`
      const get = this.cacheTicks.get(key)
      if (!get) {
        this.cacheTicks.set(key, {
          // The CHANNEL's symbol, not the payload's. The channel is the string
          // we subscribed with and the one the registry keys its thresholds
          // and order matching on; a payload that spelled the market
          // differently would produce ticks that match no resting order, which
          // is the same silent blind spot this feed already had on Kraken.
          symbol,
          exchange,
          minPrice: parsed.price,
          maxPrice: parsed.price,
          time: parsed.time ?? Date.now(),
        })
        return
      }
      get.minPrice = Math.min(parsed.price, get.minPrice)
      get.maxPrice = Math.max(parsed.price, get.maxPrice)
    } catch (e) {
      logger.error(`${LOG_PREFIX} price parse error on ${channel}: ${e}`)
    }
  }

  /** Reconcile subscriptions to the registry's current pairs (sub new, unsub gone). */
  async sync(
    pairs: { symbol: string; exchange: ExchangeEnum }[],
  ): Promise<void> {
    const redis = await RedisClient.getInstance(true, 'fillFailsafe')
    const want = new Map<string, { symbol: string; exchange: ExchangeEnum }>()
    for (const p of pairs) want.set(symKey(p.symbol, p.exchange), p)

    // Subscribe to new pairs.
    for (const [k, p] of want.entries()) {
      if (this.subscribed.has(k)) continue
      await redis.subscribe(
        this.channel(p.symbol, p.exchange),
        this.handleMessage,
      )
      this.subscribed.set(k, p)
    }
    // Unsubscribe from pairs no longer in the registry.
    for (const [k, p] of this.subscribed.entries()) {
      if (want.has(k)) continue
      await redis.unsubscribe(
        this.channel(p.symbol, p.exchange),
        this.handleMessage,
      )
      this.subscribed.delete(k)
      this.lastTickAt.delete(k)
    }
  }

  /**
   * Snapshot pass (spec §3.1): for subscribed pairs that haven't ticked in the
   * last `staleMs`, read the `latestPrice` hash and synthesize a tick. Bridges
   * detector gaps across flapping / sparse channels.
   */
  async snapshot(staleMs = 60_000, now: number = Date.now()): Promise<void> {
    const stale: { symbol: string; exchange: ExchangeEnum }[] = []
    for (const [k, p] of this.subscribed.entries()) {
      const last = this.lastTickAt.get(k) ?? 0
      if (now - last > staleMs) stale.push(p)
    }
    if (stale.length === 0) return
    try {
      const redis = await RedisClient.getInstance()
      for (const p of stale) {
        const raw = await redis.hGet('latestPrice', `${p.exchange}${p.symbol}`)
        if (!raw) continue
        const parsed = JSON.parse(raw) as {
          data?: number
          timeProfile?: { exchangeRequestEndTime?: number }
        }
        if (typeof parsed?.data !== 'number') continue
        const time = parsed.timeProfile?.exchangeRequestEndTime ?? now
        this.onTick({
          symbol: p.symbol,
          exchange: p.exchange,
          minPrice: parsed.data,
          maxPrice: parsed.data,
          time,
        })
      }
    } catch (e) {
      logger.error(`${LOG_PREFIX} snapshot pass error: ${e}`)
    }
  }

  subscribedCount(): number {
    return this.subscribed.size
  }
}
