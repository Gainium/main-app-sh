import logger from '../utils/logger'
import { orderDb } from '../db/dbInit'
import { removePaperFormExchangeName } from '../exchange/helpers'
import { BaseReturn, ExchangeEnum, StatusEnum } from '../../types'
import { SymbolResolver } from './symbols'
import { LOG_PREFIX, RestingOrder } from './types'

/**
 * Split registry rows into the ones watched and the ones excluded by
 * FF_EXCHANGES_SKIP, counting the excluded ones per real venue (paper rows
 * fold into their real exchange, exactly as the skip match does).
 */
export function partitionSkipped<T extends { exchange: string }>(
  rows: T[],
  skip?: Set<string>,
): { kept: T[]; skippedBy: Map<string, number> } {
  const skippedBy = new Map<string, number>()
  if (!skip?.size) return { kept: rows, skippedBy }
  const kept: T[] = []
  for (const r of rows) {
    const venue = String(
      removePaperFormExchangeName(r.exchange as ExchangeEnum),
    )
    if (skip.has(venue)) {
      skippedBy.set(venue, (skippedBy.get(venue) ?? 0) + 1)
    } else {
      kept.push(r)
    }
  }
  return { kept, skippedBy }
}

/**
 * One INFO line naming the active skip set and what it hides. A skipped venue
 * raises no candidate and bumps no counter, so without this line it is
 * indistinguishable from a venue whose fills are simply never missed.
 */
export function describeSkip(
  skip: Set<string>,
  skippedBy: Map<string, number>,
): string {
  const venues = [...skip]
  if (venues.length === 0) return 'FF_EXCHANGES_SKIP=[] — every venue watched'
  const total = [...skippedBy.values()].reduce((n, c) => n + c, 0)
  return (
    `FF_EXCHANGES_SKIP=[${venues.join(',')}] — ${total} resting order(s) not watched: ` +
    venues.map((v) => `${v}=${skippedBy.get(v) ?? 0}`).join(' ')
  )
}

/**
 * Order registry (spec §3.1). Loads resting LIMIT orders from Mongo every
 * FF_ORDERS_REFRESH_MS and exposes them + the union of `(symbol, realExchange)`
 * pairs the price feed must subscribe to.
 *
 * NOTE (spec §13.1 — indexing decision RESOLVED 2026-07-17): option (a), a partial
 * index on the resting statuses, shipped as `fillFailsafe_resting` in
 * core/src/db/schema.ts. The write-impact validation this note demanded was done
 * first, on a throwaway mongod: `status` stays OUT of the index key and lives only
 * in the partialFilterExpression, so it decides membership of a small index rather
 * than position in a very large one — indexing mutable order fields otherwise
 * regresses writes.
 *
 * Why this still reads Mongo every FF_ORDERS_REFRESH_MS rather than tracking order
 * events in memory: this is the BACKSTOP for lost order events. Sourcing its state
 * from the same event stream it exists to backstop would make the failure it is
 * built to catch invisible — a missed event would mean the order never enters the
 * registry and is never watched. Mongo is the independent source of truth, and
 * `orders` is written by other processes, which is the documented exception to the
 * "don't re-read per tick" rule (main-app CLAUDE.md, "Persistence vs. runtime
 * state"). With the index the poll is an index hit on ~101 entries, not a scan.
 */
export class Registry {
  private orders: RestingOrder[] = []
  private symbols = new SymbolResolver()

  getOrders(): RestingOrder[] {
    return this.orders
  }

  /**
   * Distinct `(priceSymbol, realExchange)` pairs to subscribe to on `trade@`.
   *
   * Keyed on `priceSymbol`, NOT `symbol`: the channel is published under our
   * canonical pair, and an order row may carry the venue's alternate name for
   * the same market (see `symbols.ts`). Subscribing on the order's string is
   * silent when they differ — the channel exists, has us as its only
   * subscriber, and never delivers a message.
   */
  getSymbolExchanges(): { symbol: string; exchange: ExchangeEnum }[] {
    const seen = new Set<string>()
    const out: { symbol: string; exchange: ExchangeEnum }[] = []
    for (const o of this.orders) {
      const k = `${o.priceSymbol}@${o.realExchange}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ symbol: o.priceSymbol, exchange: o.realExchange })
    }
    return out
  }

  async getOrdersFromDb(
    ids?: string[],
  ): Promise<
    BaseReturn<(RestingOrder & { dealId?: string; botId: string })[]>
  > {
    const res = await orderDb.readData(
      {
        status: { $in: ['NEW', 'PARTIALLY_FILLED'] },
        type: 'LIMIT',
        created: { $gt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        ...((ids?.length ?? 0) > 0 && { clientOrderId: { $in: ids } }),
      },
      {
        clientOrderId: 1,
        symbol: 1,
        baseAsset: 1,
        quoteAsset: 1,
        exchange: 1,
        exchangeUUID: 1,
        botId: 1,
        userId: 1,
        side: 1,
        price: 1,
        executedQty: 1,
        paperContext: 1,
        status: 1,
        dealId: 1,
      },
      {},
      true,
    )
    if (res.status !== StatusEnum.ok) {
      return res
    }

    return {
      status: StatusEnum.ok,
      data: res.data.result.map((r) => {
        const exchange = r.exchange as ExchangeEnum
        return {
          clientOrderId: r.clientOrderId,
          symbol: r.symbol,
          // Provisional: `refresh()` resolves this against the pair index once
          // the index covers every exchange in this batch. Callers that only
          // confirm orders on the exchange (`confirmList`) never read it.
          priceSymbol: r.symbol,
          baseAsset: r.baseAsset,
          quoteAsset: r.quoteAsset,
          exchange,
          realExchange: removePaperFormExchangeName(exchange),
          exchangeUUID: r.exchangeUUID,
          botId: r.botId,
          userId: r.userId,
          side: r.side === 'SELL' ? 'SELL' : 'BUY',
          price: Number(r.price),
          executedQty: Number(r.executedQty ?? 0),
          paperContext: !!r.paperContext,
          status: r.status,
          dealId: r.dealId,
        }
      }),
      reason: null,
    }
  }

  /** Reload the registry from Mongo. Returns the new resting orders. */
  async refresh(skip?: Set<string>): Promise<RestingOrder[]> {
    const res = await this.getOrdersFromDb()
    if (res.status !== StatusEnum.ok) {
      logger.error(`${LOG_PREFIX} registry refresh failed: ${res.reason}`)
      return this.orders
    }
    const rows = res.data ?? []
    const { kept, skippedBy } = partitionSkipped(rows, skip)
    const skipped = rows.length - kept.length
    if (skip?.size)
      logger.info(`${LOG_PREFIX} ${describeSkip(skip, skippedBy)}`)

    // Resolve the price-feed symbol for every row BEFORE they become the live
    // registry: thresholds, subscriptions and tick matching are all keyed on
    // `priceSymbol`, so a row must never be published with the provisional
    // value. The index is loaded for exactly the exchanges present here.
    await this.symbols.refresh([
      ...new Set(kept.map((r) => String(r.realExchange))),
    ])
    let remapped = 0
    for (const r of kept) {
      const resolved = this.symbols.resolve(
        String(r.realExchange),
        r.symbol,
        r.baseAsset,
        r.quoteAsset,
      )
      if (resolved !== r.symbol) remapped += 1
      r.priceSymbol = resolved
    }
    this.orders = kept

    logger.debug(
      `${LOG_PREFIX} registry: ${this.orders.length} resting orders, ` +
        `${this.getSymbolExchanges().length} symbol/exchange pairs` +
        (remapped ? `, ${remapped} remapped to a canonical price symbol` : '') +
        (skipped ? `, ${skipped} skipped via FF_EXCHANGES_SKIP` : ''),
    )
    return this.orders
  }
}
