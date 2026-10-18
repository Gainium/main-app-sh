/**
 * Funds held by bot-funded deals (main-app spec 044 §5, §8).
 *
 * A short spot deal the bot funded itself records its base order as a virtual
 * entry: nothing was sold, so the quote that entry "produced" is the account's
 * own, still sitting free on the exchange. The deal's take profit spends it to
 * buy the base back. A long hedge leg (phase 3) is the mirror: its virtual
 * entry is backed by base the account holds, which the take profit sells.
 * Nothing on the venue locks either, so every balance check on the account has
 * to subtract them, or another bot can spend what a take profit needs.
 *
 * Also held: the funds a deal's own orders need that are not on the book yet
 * (`deal.fundingHold.remaining`, §8.4) — between the funding trade and the
 * order placement they sit free, the other leg of the same hedge plans in
 * exactly that window, and levels a deal places later (smart orders) sit free
 * for its whole life.
 *
 * A deal's own resting orders that the ENTRY pays for are already locked by
 * the venue, so they come off that deal's entry reserve (floor 0) — counting
 * both refused deals the account could fund. Only those: the take profit and
 * the base level's minigrid orders (short: buys, spending the entry's quote;
 * long: sells, of the entry's base). A safety level's minigrid trades out of
 * that level's own proceeds and does not touch the entry's reserve.
 *
 * Read from the deals collections, across bots and processes; cached briefly
 * because it is asked on every deal-open check. The funding paths read it
 * `fresh` inside the per-account funding lock.
 */
import logger from '../utils/logger'
import { comboDealsDb, dcaDealsDb, minigridDb, orderDb } from '../db/dbInit'
import { DCADealStatusEnum, StatusEnum, TypeOrderEnum } from '../../types'

const logPrefix = 'FundingReservation'

/** Short enough that a deal opened by another worker is seen within a tick. */
const TTL_MS = 5_000

/**
 * How long "this account has no stamped deal holding funds" is trusted. Only
 * stamped deals (`baseFundingBeta`, spec 044 §8.13) ever reserve or hold, so
 * every other account answers 0 without reading the deals collections.
 */
const STAMPED_TTL_MS = 10_000

/**
 * Upper bound for one reservation read. The reads are index-backed (the
 * partial `baseFundingBeta` indexes); a slower answer is a database in
 * trouble, and a balance check must not wait on it. A timed-out read counts
 * nothing (logged), like any other failed read here.
 */
const MAX_TIME_MS = 3_000

const HOLDING_STATUSES = [
  DCADealStatusEnum.start,
  DCADealStatusEnum.open,
  DCADealStatusEnum.error,
]

type Side = 'quote' | 'base'

const FIELDS: Record<Side, { asset: string; entry: string }> = {
  quote: {
    asset: 'symbol.quoteAsset',
    entry: 'botFunding.virtualEntry.quoteReserved',
  },
  base: {
    asset: 'symbol.baseAsset',
    entry: 'botFunding.virtualEntry.baseReserved',
  },
}

export class FundingReservation {
  private static _instance: FundingReservation | null = null
  static getInstance(): FundingReservation {
    if (!FundingReservation._instance) {
      FundingReservation._instance = new FundingReservation()
    }
    return FundingReservation._instance
  }

  private cache = new Map<string, { at: number; value: number }>()

  private stamped = new Map<string, { at: number; value: boolean }>()

  /**
   * Whether the account has a stamped deal that could hold funds. Served by
   * the `{ exchangeUUID, status }` index: it reads only this account's
   * holding deals and stops at the first stamped one. A failed read answers
   * true: the full read then decides (and is bounded).
   */
  private async hasStampedDeals(
    userId: string,
    exchangeUUID: string,
    fresh: boolean,
  ) {
    const stampKey = `${userId}:${exchangeUUID}`
    const hit = this.stamped.get(stampKey)
    if (!fresh && hit && Date.now() - hit.at < STAMPED_TTL_MS) {
      return hit.value
    }
    const filter = {
      exchangeUUID,
      status: { $in: HOLDING_STATUSES },
      userId,
      baseFundingBeta: true,
    }
    const options = { maxTimeMS: MAX_TIME_MS }
    const reads = await Promise.all([
      dcaDealsDb.readData(filter as any, { _id: 1 }, options),
      comboDealsDb.readData(filter as any, { _id: 1 }, options),
    ])
    let value = false
    for (const res of reads) {
      if (res.status !== StatusEnum.ok) {
        logger.error(
          `${logPrefix} | cannot check stamped deals for ${stampKey}: ${res.reason}`,
        )
        value = true
        continue
      }
      if (res.data.result) {
        value = true
      }
    }
    if (this.stamped.size >= 50_000) {
      const oldest = this.stamped.keys().next().value
      if (oldest !== undefined) {
        this.stamped.delete(oldest)
      }
    }
    this.stamped.set(stampKey, { at: Date.now(), value })
    return value
  }

  private key(side: Side, exchangeUUID: string, asset: string) {
    return `${side}:${exchangeUUID}@${asset}`
  }

  private async reserved(
    side: Side,
    userId: string | null | undefined,
    exchangeUUID: string,
    asset: string,
    fresh = false,
  ) {
    if (!userId || !exchangeUUID || !asset) {
      return 0
    }
    const key = this.key(side, exchangeUUID, asset)
    const hit = this.cache.get(key)
    if (!fresh && hit && Date.now() - hit.at < TTL_MS) {
      return hit.value
    }
    if (!(await this.hasStampedDeals(`${userId}`, exchangeUUID, fresh))) {
      this.cache.set(key, { at: Date.now(), value: 0 })
      return 0
    }
    const f = FIELDS[side]
    // Served by `{ exchangeUUID, status }` (the account's holding deals).
    // `userId` stays as a scope guard; `baseFundingBeta` because only stamped
    // deals hold funds. Without an index this scanned the whole deals
    // collection on every new-deal balance check (spec 171, 2026-10-18).
    const filter = {
      userId: `${userId}`,
      baseFundingBeta: true,
      exchangeUUID,
      [f.asset]: asset,
      status: { $in: HOLDING_STATUSES },
      $or: [
        { [f.entry]: { $gt: 0 } },
        { 'fundingHold.asset': side, 'fundingHold.remaining': { $gt: 0 } },
      ],
    }
    const projection = { _id: 1, [f.entry]: 1, fundingHold: 1 }
    let value = 0
    const reads = await Promise.all([
      dcaDealsDb.readData(
        filter as any,
        projection,
        { maxTimeMS: MAX_TIME_MS },
        true,
      ),
      comboDealsDb.readData(
        filter as any,
        projection,
        { maxTimeMS: MAX_TIME_MS },
        true,
      ),
    ])
    const entries = new Map<string, number>()
    let held = 0
    for (const res of reads) {
      if (res.status !== StatusEnum.ok) {
        // An extra guard, not the only one: the venue still refuses an order
        // the account cannot fund. Report and count nothing for this side.
        logger.error(
          `${logPrefix} | cannot read reserved ${side} for ${key}: ${res.reason}`,
        )
        continue
      }
      for (const d of res.data.result) {
        const entry = d.botFunding?.virtualEntry
        const hold = d.fundingHold
        const reserved =
          side === 'quote'
            ? (entry?.quoteReserved ?? 0)
            : (entry?.baseReserved ?? 0)
        if (reserved > 0) {
          const id = `${(d as { _id?: unknown })._id ?? ''}`
          entries.set(id, (entries.get(id) ?? 0) + reserved)
        }
        held += hold?.asset === side ? Math.max(0, hold.remaining ?? 0) : 0
      }
    }
    const locked = await this.restingLocked(side, [...entries.keys()])
    for (const [id, reserved] of entries) {
      value += Math.max(0, reserved - (locked.get(id) ?? 0))
    }
    value += held
    this.cache.set(key, { at: Date.now(), value })
    return value
  }

  /**
   * Per deal: what its resting orders paid by the entry already lock in the
   * reserved asset — quote of resting buys (`quote`), base of resting sells
   * (`base`) — counting only the take profit and the base level's minigrid
   * orders. Funding trades carry no deal id and are never counted.
   */
  private async restingLocked(side: Side, dealIds: string[]) {
    const out = new Map<string, number>()
    const ids = dealIds.filter(Boolean)
    if (!ids.length) {
      return out
    }
    const res = await orderDb.readData(
      {
        dealId: { $in: ids },
        status: { $in: ['NEW', 'PARTIALLY_FILLED'] },
        side: side === 'quote' ? 'BUY' : 'SELL',
      } as any,
      {
        dealId: 1,
        origQty: 1,
        executedQty: 1,
        price: 1,
        typeOrder: 1,
        minigridId: 1,
      },
      {},
      true,
    )
    if (res.status !== StatusEnum.ok) {
      // Count nothing off: the reservation stays whole (the safe side).
      logger.error(
        `${logPrefix} | cannot read resting orders for ${side}: ${res.reason}`,
      )
      return out
    }
    const rows = res.data.result as {
      dealId?: string
      origQty: string
      executedQty?: string
      price: string
      typeOrder?: string
      minigridId?: string
    }[]
    const baseGrids = await this.baseLevelMinigrids(
      rows
        .filter((o) => o.typeOrder === TypeOrderEnum.dealGrid && o.minigridId)
        .map((o) => `${o.minigridId}`),
    )
    for (const o of rows) {
      const paidByEntry =
        o.typeOrder === TypeOrderEnum.dealTP ||
        (o.typeOrder === TypeOrderEnum.dealGrid &&
          !!o.minigridId &&
          baseGrids.has(`${o.minigridId}`))
      if (!paidByEntry) {
        continue
      }
      const left = Math.max(0, +o.origQty - +(o.executedQty ?? 0))
      const lockedHere = side === 'quote' ? left * +o.price : left
      if (o.dealId && Number.isFinite(lockedHere)) {
        out.set(o.dealId, (out.get(o.dealId) ?? 0) + lockedHere)
      }
    }
    return out
  }

  /**
   * Of these combo minigrids, the ones built on a deal's BASE order: the
   * minigrid's `dcaOrderId` is that deal's `dealStart` row. Unknown ⇒ not
   * counted (the reserve stays whole, the safe side).
   */
  private async baseLevelMinigrids(minigridIds: string[]) {
    const out = new Set<string>()
    const ids = [...new Set(minigridIds)]
    if (!ids.length) {
      return out
    }
    const grids = await minigridDb.readData(
      { _id: { $in: ids } } as any,
      { dcaOrderId: 1 },
      {},
      true,
    )
    if (grids.status !== StatusEnum.ok) {
      return out
    }
    const byOrder = new Map<string, string[]>()
    for (const g of grids.data.result as {
      _id: unknown
      dcaOrderId?: string
    }[]) {
      if (g.dcaOrderId) {
        byOrder.set(g.dcaOrderId, [
          ...(byOrder.get(g.dcaOrderId) ?? []),
          `${g._id}`,
        ])
      }
    }
    if (!byOrder.size) {
      return out
    }
    const starts = await orderDb.readData(
      {
        clientOrderId: { $in: [...byOrder.keys()] },
        typeOrder: TypeOrderEnum.dealStart,
      } as any,
      { clientOrderId: 1 },
      {},
      true,
    )
    if (starts.status !== StatusEnum.ok) {
      return out
    }
    for (const o of starts.data.result as { clientOrderId: string }[]) {
      for (const id of byOrder.get(o.clientOrderId) ?? []) {
        out.add(id)
      }
    }
    return out
  }

  /**
   * Σ quote this account's funded deals hold, in `quoteAsset`. `userId` is
   * the account's owner (spec 171); without it the answer is 0.
   */
  async reservedQuote(
    userId: string | null | undefined,
    exchangeUUID: string,
    quoteAsset: string,
    fresh = false,
  ) {
    return this.reserved('quote', userId, exchangeUUID, quoteAsset, fresh)
  }

  /** Σ base this account's funded deals hold, in `baseAsset` (phase 3). */
  async reservedBase(
    userId: string | null | undefined,
    exchangeUUID: string,
    baseAsset: string,
    fresh = false,
  ) {
    return this.reserved('base', userId, exchangeUUID, baseAsset, fresh)
  }

  /**
   * A deal of this account just reserved or released funds. Clears both sides
   * of the pair: a hedge leg's funding moves one asset and reserves the other.
   */
  invalidate(exchangeUUID: string, quoteAsset: string, baseAsset?: string) {
    // A first funded deal turns a user's "no stamped deals" true; rare, so
    // dropping every user's answer is cheaper than tracking whose it was.
    this.stamped.clear()
    this.cache.delete(this.key('quote', exchangeUUID, quoteAsset))
    if (baseAsset) {
      this.cache.delete(this.key('base', exchangeUUID, baseAsset))
    }
  }
}
