/**
 * snapshotRead.ts — read-routing helpers for the portfolio-snapshot cloud mirror.
 *
 * On cloud (flag on) the historical time-series lives in ClickHouse with 12-month
 * retention; Mongo keeps only a thin hot buffer (design §0.6). These helpers fetch
 * the series over the snapshot RPC and return it in the SAME shape the current
 * Mongo read returns, so a call site swaps its Mongo read for the helper and
 * everything downstream is unchanged.
 *
 * Return `null` on ANY failure (RPC down, CH unreachable, flag off) so the caller
 * FALLS BACK to Mongo — ClickHouse is never a hard product dependency (design §0.1).
 * The CH series carries `updateTime`+`totalUsd` (+`uuid` for per-exchange) only —
 * the portfolio chart needs nothing more; the per-point asset breakdown is not
 * plotted (§0.4).
 */

import SnapshotClient, { isSnapshotChReadEnabled } from './snapshotClient'
import RedisClient from '../db/redis'
import logger from '../utils/logger'
import { StatusEnum } from '../../types'
import type { SnapshotReadRow } from './snapshotTypes'

interface SeriesParams {
  userId: string
  paperContext: boolean
  from?: number
  to?: number
  /** When true, request only `{updateTime,totalUsd}` (the all-coins/all-exchanges
   *  line case) — smaller payload + cheaper CH read. */
  lean?: boolean
}

/** Per-user snapshot-read cache TTL (seconds). The series is daily-immutable
 *  (one new point/day; today's point refreshes on updateBalance), so a short TTL
 *  is safe and cheap. 0 disables the cache. */
const CACHE_TTL = Number(process.env.SNAPSHOT_CH_CACHE_TTL ?? 300)

async function cachedSnapshotRead(
  msg: Parameters<SnapshotClient['snapshotRead']>[0],
): Promise<SnapshotReadRow[] | null> {
  if (CACHE_TTL <= 0) {
    const res = await SnapshotClient.getInstance().snapshotRead(msg)
    return res ? res.rows : null
  }
  const key = `snapchart:v1:${msg.table}:${msg.userId}:${
    msg.paperContext ? 1 : 0
  }:${msg.uuid ?? ''}:${msg.from ?? ''}:${msg.to ?? ''}:${msg.lean ? 'L' : 'F'}`
  try {
    const redis = await RedisClient.getInstance()
    const hit = await redis.get(key)
    if (hit) return JSON.parse(hit) as SnapshotReadRow[]
    const res = await SnapshotClient.getInstance().snapshotRead(msg)
    if (!res) return null // don't cache a failure — let it fall back to Mongo
    await redis.set(key, JSON.stringify(res.rows), CACHE_TTL)
    return res.rows
  } catch (e) {
    // Cache path must never break the read — go direct on any Redis error.
    logger.warn(`[snapshotRead] cache bypass: ${(e as Error).message}`)
    const res = await SnapshotClient.getInstance().snapshotRead(msg)
    return res ? res.rows : null
  }
}

/**
 * Portfolio chart series (getPortfolioByUser). Returns the `snapshotDb.aggregate`
 * envelope — `{ status, reason, data: { result } }`, oldest-first — or `null` to
 * fall back to Mongo. In `lean` mode rows are `{updateTime,totalUsd}`; otherwise
 * the FULL Mongo doc (from CH's lossless `raw`) so `assets[]` is available for
 * per-coin/per-exchange filtering. Result is cached per user for `CACHE_TTL`.
 */
export async function snapshotReadSeries(p: SeriesParams): Promise<{
  status: StatusEnum.ok
  reason: null
  data: { result: Array<Record<string, unknown>> }
} | null> {
  if (!isSnapshotChReadEnabled()) return null
  const rows = await cachedSnapshotRead({
    table: 'snapshots',
    userId: p.userId,
    paperContext: p.paperContext,
    from: p.from,
    to: p.to,
    lean: p.lean,
  })
  if (!rows) return null
  return { status: StatusEnum.ok, reason: null, data: { result: rows } }
}

interface PerExchangeParams extends SeriesParams {
  uuid?: string
}

/**
 * Per-exchange series (getSnapshotPerExchange). Returns the array the resolver
 * hands back (`result.data?.result`) — one row per (uuid, day) — or `null` to
 * fall back to Mongo.
 */
export async function snapshotReadPerExchange(
  p: PerExchangeParams,
): Promise<Array<{
  updateTime: number
  totalUsd: number
  uuid: string
  paperContext: boolean
}> | null> {
  if (!isSnapshotChReadEnabled()) return null
  const rows = await cachedSnapshotRead({
    table: 'snapshots_per_exchange',
    userId: p.userId,
    paperContext: p.paperContext,
    uuid: p.uuid,
    from: p.from,
    to: p.to,
  })
  if (!rows) return null
  return rows.map((r) => ({
    updateTime: Number(r.updateTime ?? 0),
    totalUsd: Number(r.totalUsd ?? 0),
    uuid: String(r.uuid ?? ''),
    paperContext: p.paperContext,
  }))
}
