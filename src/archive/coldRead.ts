/**
 * coldRead.ts — read-routing helpers for archived (cold) bots.
 *
 * When a bot has `coldArchived=true` its orders/transactions live in ClickHouse,
 * not Mongo (design §4). These helpers fetch that history over the cold RPC and
 * return it in the SAME shape a Mongo `readData(..., isArray, countNeed)` call
 * would — `{ result, count }` — because `coldRead` returns the full original
 * Mongo documents (from the lossless `raw` column). So a call site swaps its
 * `orderDb.readData(...)` for `coldReadOrders(...)` and everything downstream
 * (serialization, chart markers) is unchanged.
 *
 * Return `null` on ANY failure (RPC down, CH unreachable, flag off) so the caller
 * FALLS BACK to Mongo — ClickHouse is never a hard product dependency (design §0.6).
 * Note: advanced datagrid column filters are NOT applied on the cold path (only
 * status / dealId / typeOrder / pagination / created-range) — an archived-bot
 * drill-down degrades gracefully to unfiltered-but-paginated, never errors.
 */

import ColdClient, { isColdStoreEnabled } from './coldClient'

export interface ColdReadResult {
  result: Array<Record<string, unknown>>
  count: number
}

interface ColdOrderReadParams {
  userId: string
  botId: string
  dealId?: string
  statuses?: string[]
  typeOrderNotIn?: string[]
  from?: number
  to?: number
  limit?: number
  skip?: number
  sort?: 'asc' | 'desc'
}

interface ColdTxReadParams {
  userId: string
  botId: string
  dealId?: string
  from?: number
  to?: number
  limit?: number
  skip?: number
  sort?: 'asc' | 'desc'
}

/** Archived-bot orders from CH. `null` → caller falls back to Mongo. */
export async function coldReadOrders(
  p: ColdOrderReadParams,
): Promise<ColdReadResult | null> {
  if (!isColdStoreEnabled()) return null
  const res = await ColdClient.getInstance().coldRead({
    table: 'orders',
    userId: p.userId,
    botId: p.botId,
    dealId: p.dealId,
    statuses: p.statuses,
    typeOrderNotIn: p.typeOrderNotIn,
    from: p.from,
    to: p.to,
    limit: p.limit,
    skip: p.skip,
    sort: p.sort ?? 'desc',
  })
  if (!res) return null
  return { result: res.rows, count: res.count }
}

/** Archived-bot transactions (dca or combo) from CH. `null` → fall back to Mongo. */
export async function coldReadTransactions(
  p: ColdTxReadParams,
): Promise<ColdReadResult | null> {
  if (!isColdStoreEnabled()) return null
  const res = await ColdClient.getInstance().coldRead({
    table: 'transactions',
    userId: p.userId,
    botId: p.botId,
    dealId: p.dealId,
    from: p.from,
    to: p.to,
    limit: p.limit,
    skip: p.skip,
    sort: p.sort ?? 'desc',
  })
  if (!res) return null
  return { result: res.rows, count: res.count }
}
