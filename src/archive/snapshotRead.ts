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
import { StatusEnum } from '../../types'

interface SeriesParams {
  userId: string
  paperContext: boolean
  from?: number
  to?: number
}

/**
 * Portfolio chart series (getPortfolioByUser). Returns the `snapshotDb.aggregate`
 * envelope — `{ status, reason, data: { result } }`, oldest-first — or `null` to
 * fall back to Mongo. Rows are the FULL original Mongo docs (from CH's lossless
 * `raw` column), so the shape is identical to the Mongo aggregate — the widget
 * reads `assets[]` (per-coin / per-exchange breakdown), not just the total.
 */
export async function snapshotReadSeries(p: SeriesParams): Promise<{
  status: StatusEnum.ok
  reason: null
  data: { result: Array<Record<string, unknown>> }
} | null> {
  if (!isSnapshotChReadEnabled()) return null
  const res = await SnapshotClient.getInstance().snapshotRead({
    table: 'snapshots',
    userId: p.userId,
    paperContext: p.paperContext,
    from: p.from,
    to: p.to,
  })
  if (!res) return null
  return {
    status: StatusEnum.ok,
    reason: null,
    data: { result: res.rows },
  }
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
  const res = await SnapshotClient.getInstance().snapshotRead({
    table: 'snapshots_per_exchange',
    userId: p.userId,
    paperContext: p.paperContext,
    uuid: p.uuid,
    from: p.from,
    to: p.to,
  })
  if (!res) return null
  return res.rows.map((r) => ({
    updateTime: Number(r.updateTime ?? 0),
    totalUsd: Number(r.totalUsd ?? 0),
    uuid: String(r.uuid ?? ''),
    paperContext: p.paperContext,
  }))
}
