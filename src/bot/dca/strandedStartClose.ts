import { DCADealStatusEnum } from '../../../types'
import {
  NO_EXCHANGE_ORDER_ID,
  executedFillQty,
  type ExecutableOrderRow,
} from './executedFill'

/**
 * A deal the stuck-start sweep can retire without touching any exchange.
 *
 * `closeOldStartDeals` retires deals that have sat in `start` for more than a
 * day, and it does so through `closeDealById`, which resolves the deal from the
 * bot worker's in-memory map. A deal the worker has forgotten — the Redis
 * restore in `loadOrders` rebuilds that map from a mirror of itself, so a deal
 * missing from one snapshot is missing from every later one — answers
 * `[WARN] Deal <id> not found when close` and nothing else. The sweep then
 * selects the same deal an hour later, forever: one production deal has written
 * that warning hourly since 2026-08-20 without ever moving.
 *
 * The database still holds the truth, and for one narrow shape the truth is
 * enough to act on with no venue call at all: a deal in `start` whose every
 * order row carries the placeholder `main.ts` writes when an order has no
 * venue-side identifier. Nothing was ever acknowledged by an exchange, so
 * nothing is resting and no position exists — the row is inert bookkeeping and
 * cancelling it is a correction, not a trade.
 *
 * Everything else stays read-only, which is the constraint spec `030` §3 was
 * written for: an `open` deal may hold a real position, and a terminal one is a
 * duplicate request. Spec `specs/046…`.
 *
 * Pure, so `unactionedClose.harness.spec.ts` can pin it against the production
 * rows without a database.
 */

/**
 * How old a `start` deal must be before its `NEW`/`-1` rows are read as
 * abandoned rather than in flight.
 *
 * A placement genuinely in progress wears exactly this shape for the seconds
 * between the write-ahead `saveOrderToDb` and the venue's answer. A day is the
 * same very wide margin the `v45` migration uses to tell the two apart, and the
 * sweep's own filter is already 24 h, so this costs it nothing.
 */
export const STRANDED_START_GRACE_MS = 24 * 60 * 60 * 1000

export type StrandedStartInputs = {
  /** The deal's status as the DATABASE reports it, not the worker's map. */
  dealStatus: DCADealStatusEnum | string | null | undefined
  /** `Deal.createTime`, epoch ms. Unreadable means "do not act". */
  createTime: number | null | undefined
  now: number
  /**
   * Every order row the deal holds, in ANY status.
   *
   * An empty list satisfies the row test, deliberately: that is the shape
   * `shouldDiscardUnbuiltBaseEntry` (spec `039`) already retires at placement
   * time, and a deal stranded that way before it shipped arrives here.
   */
  orders: ExecutableOrderRow[]
}

export function isRetirableStrandedStart(args: StrandedStartInputs): boolean {
  const { dealStatus, createTime, now, orders } = args
  if (dealStatus !== DCADealStatusEnum.start) {
    return false
  }
  // `typeof` rather than a `Number()` coercion: `Number(null)` is 0, which would
  // read a deal with no creation time as infinitely old and act on it.
  if (
    typeof createTime !== 'number' ||
    !Number.isFinite(createTime) ||
    now - createTime < STRANDED_START_GRACE_MS
  ) {
    return false
  }
  return (orders ?? []).every(
    (order) =>
      `${order?.orderId}` === NO_EXCHANGE_ORDER_ID &&
      // A row with no venue id that still reports volume is the combo
      // placeholder spec `029` describes (`executedQty === origQty`, written
      // before any venue call). Treat anything that claims to have moved base
      // as evidence this deal is not inert.
      executedFillQty(order) === 0,
  )
}
