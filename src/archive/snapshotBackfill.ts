/**
 * snapshotBackfill.ts — one-time copy of the existing Mongo `snapshots` /
 * `snapshotsPerExchange` collections into the ClickHouse mirror.
 *
 * Purely additive — it does NOT delete from Mongo (dual-write keeps Mongo the hot
 * window + fallback). id-paged, resumable, idempotent (ReplacingMergeTree
 * collapses re-runs by (userId, paperContext, updateTime[, uuid])). Each page is
 * sent with `sendBatch` (awaited publish, no fire-and-forget drop) so the whole
 * backlog reliably reaches the write queue.
 *
 * Cloud-only: no-op unless SNAPSHOT_CH_ENABLED. Localhost admin endpoint
 * `POST /api/admin/snapshots/backfill` (main-app). Design §5.
 */

import { Types } from 'mongoose'
import { snapshotDb, snapshotPerExchangeDb } from '../db/dbInit'
import SnapshotClient, { isSnapshotChEnabled } from './snapshotClient'
import type { SnapshotRow, SnapshotPerExchangeRow } from './snapshotTypes'
import logger from '../utils/logger'

const logPrefix = '[SnapshotBackfill]'

export interface SnapshotBackfillResult {
  snapshots: number
  snapshotsPerExchange: number
  pages: number
}

interface BackfillOpts {
  /** Rows per page (Mongo read + one CH write message). Default 5000. */
  batch?: number
  /** Stop after this many rows per collection (0 = all). Default 0. */
  limit?: number
}

const ZERO_ID = new Types.ObjectId('0'.repeat(24))

/**
 * Backfill both snapshot collections into ClickHouse. Returns per-collection
 * row counts and the total number of pages sent.
 */
export async function backfillSnapshots(
  opts: BackfillOpts = {},
): Promise<SnapshotBackfillResult> {
  if (!isSnapshotChEnabled()) {
    throw new Error('SNAPSHOT_CH_ENABLED is off')
  }
  const batch =
    Number.isFinite(opts.batch) && opts.batch! > 0 ? opts.batch! : 5000
  const limit = Number.isFinite(opts.limit) && opts.limit! > 0 ? opts.limit! : 0
  const client = SnapshotClient.getInstance()
  let pages = 0

  const snapshots = await pageCollection(
    snapshotDb,
    batch,
    limit,
    (doc) =>
      ({
        userId: String(doc.userId ?? ''),
        paperContext: !!doc.paperContext,
        updateTime: Number(doc.updateTime ?? 0),
        totalUsd: Number(doc.totalUsd ?? 0),
        updated: msOf(doc.updated ?? doc.created),
        raw: JSON.stringify(doc),
      }) as SnapshotRow,
    async (rows) => {
      await client.sendBatch('snapshots', rows)
      pages++
    },
  )

  const snapshotsPerExchange = await pageCollection(
    snapshotPerExchangeDb,
    batch,
    limit,
    (doc) =>
      ({
        userId: String(doc.userId ?? ''),
        paperContext: !!doc.paperContext,
        uuid: String(doc.uuid ?? ''),
        updateTime: Number(doc.updateTime ?? 0),
        totalUsd: Number(doc.totalUsd ?? 0),
        updated: msOf(doc.updated ?? doc.created),
      }) as SnapshotPerExchangeRow,
    async (rows) => {
      await client.sendBatch('snapshots_per_exchange', rows)
      pages++
    },
  )

  logger.info(
    `${logPrefix} done — snapshots=${snapshots} perExchange=${snapshotsPerExchange} pages=${pages}`,
  )
  return { snapshots, snapshotsPerExchange, pages }
}

/** id-paged scan of one collection: read a page, map each doc to a wire row,
 *  hand the page to `send`, advance the cursor. */
async function pageCollection<Row>(
  db: any,
  batch: number,
  limit: number,
  map: (doc: Record<string, any>) => Row,
  send: (rows: Row[]) => Promise<void>,
): Promise<number> {
  let lastId = ZERO_ID
  let total = 0
  for (;;) {
    const remaining = limit ? limit - total : batch
    if (limit && remaining <= 0) break
    const pageSize = limit ? Math.min(batch, remaining) : batch
    const res = await db.readData(
      { _id: { $gt: lastId } },
      {},
      { sort: { _id: 1 }, limit: pageSize, lean: true },
      true,
    )
    if (res.status !== 'OK') {
      logger.error(`${logPrefix} read failed: ${res.reason}`)
      break
    }
    const docs: Array<Record<string, any>> = res.data?.result ?? []
    if (!docs.length) break
    await send(docs.map(map))
    total += docs.length
    lastId = new Types.ObjectId(String(docs[docs.length - 1]._id))
    if (docs.length < pageSize) break
  }
  return total
}

/** ms epoch from a Date / number / string, 0 on failure. */
function msOf(v: unknown): number {
  if (v == null) return 0
  const t = v instanceof Date ? v.getTime() : new Date(v as string).getTime()
  return Number.isFinite(t) ? t : 0
}
