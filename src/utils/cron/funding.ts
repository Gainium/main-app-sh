import ExchangeChooser from '../../exchange/exchangeChooser'
import { getCandles as coreGetCandles } from '../../exchange/additionalAPIs'
import logger from '../../utils/logger'
import RedisClient from '../../db/redis'
import FundingStore, { type FundingEvent } from '../../bot/fundingStore'
import { fundingActiveZset, fundingChannel } from '../../bot/fundingStream'
import {
  ExchangeEnum,
  ExchangeIntervals,
  StatusEnum,
  type CandleResponse,
} from '../../../types'

/**
 * Candle source for mark-price resolution. Defaults to the exchange (SH); the
 * cloud cron injects the archive-first (ClickHouse) variant, which also caches.
 */
export type CandleSource = (params: {
  exchange: ExchangeEnum
  symbol: string
  type: string
  startAt: string
  endAt: string
  limit?: string
}) => Promise<{ status: StatusEnum; data: CandleResponse[] | null }>

/** Drop registry entries no worker has refreshed within this window. */
const STALE_MS = 10 * 60 * 1000
/** First-seen / gap recovery look-back when there's no stored head yet. */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000
/**
 * How long a settlement may stay unvalued before we publish it anyway.
 *
 * Holding an unvalued settlement back is what makes mark-price resolution
 * retryable, but it also parks the head — and therefore every LATER settlement
 * — behind it. A symbol whose candle data never materialises would wedge its
 * whole funding stream forever, which is worse than the single hole we are
 * avoiding. So the hold is bounded: after this long we publish it unvalued
 * (charged as zero, as before) and log loudly, and the stream moves on.
 */
const MARK_RETRY_MS = 6 * 60 * 60 * 1000

/**
 * Real futures exchanges that settle funding. The registry ZSET only exists for
 * exchanges/symbols with live positions, so spot or idle exchanges resolve to an
 * empty set and are skipped. Keys mirror `removePaperFormExchangeName(exchange)`.
 */
const fundingProviders: ExchangeEnum[] = [
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.binanceCoinm,
  ExchangeEnum.bybitUsdm,
  ExchangeEnum.bybitCoinm,
  ExchangeEnum.okxLinear,
  ExchangeEnum.okxInverse,
  ExchangeEnum.bitgetUsdm,
  ExchangeEnum.bitgetCoinm,
  ExchangeEnum.kucoinLinear,
  ExchangeEnum.kucoinInverse,
  ExchangeEnum.hyperliquid,
  ExchangeEnum.hyperliquidLinear,
  ExchangeEnum.kraken,
  ExchangeEnum.krakenUsdm,
  ExchangeEnum.krakenCoinm,
]

/**
 * Most exchanges don't return mark price in funding history (only Binance USDM
 * does). Resolve the rest from mark/close candles at each settlement — one
 * getCandles call per symbol covering the whole new-events window.
 */
async function resolveMarkPrices(
  getCandles: CandleSource,
  provider: ExchangeEnum,
  symbol: string,
  events: FundingEvent[],
): Promise<FundingEvent[]> {
  const missing = events.filter((e) => e.markPrice === undefined)
  if (!missing.length) {
    return events
  }
  const minT = Math.min(...missing.map((e) => e.time))
  const maxT = Math.max(...missing.map((e) => e.time))
  const hour = 60 * 60 * 1000
  const candles = await getCandles({
    exchange: provider,
    symbol,
    type: ExchangeIntervals.oneH,
    startAt: `${minT - hour}`,
    endAt: `${maxT + hour}`,
  })
  if (candles.status !== StatusEnum.ok || !candles.data?.length) {
    // Leave the events unvalued and say so. The caller holds them back rather
    // than publishing a hole, so this is a retry — not a lost settlement.
    logger.warn(
      `[Funding] ${provider}@${symbol}: no candles for ${minT - hour}..${
        maxT + hour
      } (${candles.status}); ${missing.length} settlement(s) left unvalued`,
    )
    return events
  }
  const sorted = (candles.data as { time: number; close: string }[])
    .map((c) => ({ time: c.time, close: +c.close }))
    .sort((a, b) => a.time - b.time)
  return events.map((e) => {
    if (e.markPrice !== undefined) {
      return e
    }
    // `c.time` is the candle's OPEN time (verified on both sources: the
    // archive-first cloud path maps ClickHouse `t`, and the connectors map the
    // venue's own open time), so the candle opening at `c.time` only CLOSES at
    // `c.time + hour`. Funding settles against the mark AT the settlement, so
    // we want the last candle that has already closed by then — `c.time <=
    // e.time` takes the close of the hour that STARTS at the settlement, i.e.
    // the price up to an hour later. The window's `minT - hour` padding exists
    // for exactly this look-back.
    let mark: number | undefined
    for (const c of sorted) {
      if (c.time + hour <= e.time) {
        mark = c.close
      } else {
        break
      }
    }
    if (mark === undefined) {
      mark = sorted[0].close
    }
    return { ...e, markPrice: mark }
  })
}

/**
 * The leading run of settlements that are safe to publish: everything up to the
 * first one we could not value.
 *
 * The store's head is a single high-water mark and the bots' offsets follow it,
 * so publishing across a hole buries that hole permanently — the next poll asks
 * the venue from `head` and keeps only `fundingTime > head`, so the unvalued
 * settlement is never fetched again, and `computeFunding` charges it as zero
 * while still advancing the deal's offset past it. A settlement is therefore
 * only published once it carries a mark price, or once {@link MARK_RETRY_MS}
 * has passed and we accept the zero deliberately.
 *
 * Stopping at the first hole rather than filtering holes out is load-bearing:
 * because the head is a single high-water mark, publishing a LATER valued
 * settlement would bury an earlier unvalued one just the same.
 */
function publishablePrefix(
  events: FundingEvent[],
  now: number,
  provider: ExchangeEnum,
  symbol: string,
): FundingEvent[] {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const out: FundingEvent[] = []
  for (const e of sorted) {
    if (e.markPrice !== undefined) {
      out.push(e)
      continue
    }
    if (now - e.time >= MARK_RETRY_MS) {
      logger.error(
        `[Funding] ${provider}@${symbol}: settlement ${e.time} still unvalued after ${
          MARK_RETRY_MS / 3600000
        }h; publishing it anyway — it will be charged as zero funding`,
      )
      out.push(e)
      continue
    }
    logger.warn(
      `[Funding] ${provider}@${symbol}: settlement ${e.time} unvalued; holding it and ${
        sorted.length - out.length - 1
      } later settlement(s) for the next run`,
    )
    break
  }
  return out
}

let locked = false
const lockedQueue: (() => Promise<void>)[] = []

/**
 * Hourly funding publisher. For each futures exchange: read the active-symbol
 * registry (and prune the stale tail), fetch settled funding since the stored
 * head, resolve mark prices, write to the store, and wake subscribed bots. The
 * store is the source of truth; the pub/sub message is just a notification.
 */
export const publishFunding = async (
  ec = ExchangeChooser,
  getCandles: CandleSource = (params) => coreGetCandles(params, ec),
) => {
  if (locked) {
    lockedQueue.push(() => publishFunding(ec, getCandles))
    return
  }
  locked = true
  logger.debug(`[Funding] Starting publish funding`)
  try {
    const redis = await RedisClient.getInstance()
    const now = +new Date()
    for (const provider of fundingProviders) {
      logger.debug(`[Funding] Check provider ${provider}`)
      const zset = fundingActiveZset(provider)
      let symbols: string[] = []
      try {
        symbols =
          (await redis.zRangeByScore(zset, now - STALE_MS, '+inf')) ?? []
        await redis.zRemRangeByScore(zset, '-inf', `(${now - STALE_MS}`)
      } catch (e) {
        logger.error(`[Funding] registry read ${provider}: ${e}`)
        continue
      }
      if (!symbols.length) {
        logger.debug(`[Funding] Provider ${provider} no symbols`)
        continue
      }
      const choose = ec.chooseExchangeFactory(provider)
      if (!choose) {
        logger.debug(`[Funding] Provider ${provider} no connector`)
        continue
      }
      const exchange = choose('', '')
      for (const symbol of symbols) {
        try {
          const head = await FundingStore.getHead(provider, symbol)
          const from = head || now - LOOKBACK_MS
          const res = await exchange.getFundingRateHistory(symbol, from, now)
          if (res.status !== StatusEnum.ok) {
            // Symbol + reason are what make this triageable: a bad registry
            // member fails identically every hour, and without them the log
            // looks like generic provider degradation instead of one poisoned
            // symbol.
            logger.error(
              `[Funding] Provider ${provider} response error ${res.status} symbol ${symbol}: ${res.reason}`,
            )
            continue
          }
          const fresh = res.data.filter((e) => e.fundingTime > head)
          if (!fresh.length) {
            logger.debug(
              `[Funding] Provider ${provider} no fresh after ${head}`,
            )
            continue
          }
          let events: FundingEvent[] = fresh.map((e) => ({
            time: e.fundingTime,
            rate: e.fundingRate,
            markPrice: e.markPrice,
          }))
          events = await resolveMarkPrices(getCandles, provider, symbol, events)
          const publishable = publishablePrefix(events, now, provider, symbol)
          if (!publishable.length) {
            // Nothing valued yet; the head stays put so the next run retries.
            continue
          }
          await FundingStore.addEvents(provider, symbol, publishable)
          const last = Math.max(...publishable.map((e) => e.time))
          await redis.publish(fundingChannel(provider, symbol), `${last}`)
          logger.debug(`[Funding] Provider ${provider} published last ${last}`)
        } catch (e) {
          logger.error(`[funding] ${provider}@${symbol}: ${e}`)
        }
      }
    }
  } catch (e) {
    logger.error(
      `Catch error during publishFunding ${(e as Error)?.message ?? e}`,
    )
  } finally {
    locked = false
    const prev = lockedQueue.shift()
    if (prev) {
      prev()
    }
  }
}

export default publishFunding
