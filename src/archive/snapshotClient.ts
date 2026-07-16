/**
 * snapshotClient.ts — client for the portfolio-snapshot cloud mirror (core →
 * market-archive, which owns the ClickHouse connection). Lives in core because
 * the writer (`userSnapshots`) and the read routing (resolvers) are in core.
 *
 * WRITE (`pushSnapshot`/`pushSnapshotPerExchange`): buffered, fire-and-forget —
 * rows pool per-table and flush as ONE rabbit message per table per batch (size
 * or age), never one per row. A failed/queued-full flush is DROPPED and logged;
 * it must never block or fail the snapshot cron or a user request. This is safe
 * because Mongo already holds the row (source-of-truth, both editions) — CH is a
 * mirror. Mirrors main-app's AnalyticsClient (incl. the in-flight cap).
 *
 * READ (`snapshotRead`) / DELETE (`snapshotDeleteByUser`): request/response RPC —
 * a null/failed read makes the caller fall back to Mongo (CH is never a product
 * dependency); delete is idempotent and null-on-fail just retries next call.
 *
 * Flag `SNAPSHOT_CH_ENABLED` (default OFF). When off, `push*` are no-ops and the
 * read helper returns null → Mongo. Self-hosted leaves the flag absent and stays
 * wholly in Mongo (design §0.1).
 */

import Rabbit from '../db/rabbit'
import logger from '../utils/logger'
import {
  SNAPSHOT_QUEUES,
  type SnapshotTable,
  type SnapshotRow,
  type SnapshotPerExchangeRow,
  type SnapshotReadMessage,
  type SnapshotReadResponse,
  type SnapshotDeleteResponse,
} from './snapshotTypes'

const logPrefix = '[SnapshotClient]'

const MAX_ROWS = Number(process.env.SNAPSHOT_BATCH_MAX_ROWS ?? 2_000)
const FLUSH_MS = Number(process.env.SNAPSHOT_BATCH_MAX_AGE_MS ?? 2_000)
const MAX_IN_FLIGHT = Number(process.env.SNAPSHOT_MAX_IN_FLIGHT ?? 10)
const RPC_TIMEOUT_MS = Number(process.env.SNAPSHOT_RPC_TIMEOUT_MS ?? 30_000)

/** Write side: dual-write, account-purge, backfill. */
export function isSnapshotChEnabled(): boolean {
  const flag = process.env.SNAPSHOT_CH_ENABLED
  if (!flag) return false
  return !['0', 'false', 'no', ''].includes(flag.toLowerCase())
}

/** Read side: route the chart/per-exchange reads to the CH mirror. Separate
 *  from the write flag so the rollout can enable dual-write + backfill FIRST and
 *  only flip reads to CH once it holds the full history (design §7 steps 3–5).
 *  A read never leaves Mongo until this is on; when on, a failed read still
 *  falls back to Mongo (CH is never a hard dependency). */
export function isSnapshotChReadEnabled(): boolean {
  const flag = process.env.SNAPSHOT_CH_READ
  if (!flag) return false
  return !['0', 'false', 'no', ''].includes(flag.toLowerCase())
}

type AnyRow = SnapshotRow | SnapshotPerExchangeRow

export class SnapshotClient {
  private static _instance: SnapshotClient | null = null
  static getInstance(): SnapshotClient {
    if (!SnapshotClient._instance)
      SnapshotClient._instance = new SnapshotClient()
    return SnapshotClient._instance
  }

  private rabbit: Rabbit | null = null
  private pools = new Map<SnapshotTable, Array<AnyRow>>()
  private pooled = 0
  private timer: NodeJS.Timeout | null = null
  private inFlight = 0
  private droppedBatches = 0

  private client(): Rabbit {
    if (!this.rabbit) this.rabbit = new Rabbit()
    return this.rabbit
  }

  pushSnapshot(row: SnapshotRow): void {
    this.push('snapshots', row)
  }

  pushSnapshotPerExchange(row: SnapshotPerExchangeRow): void {
    this.push('snapshots_per_exchange', row)
  }

  private push(table: SnapshotTable, row: AnyRow): void {
    if (!isSnapshotChEnabled()) return
    const pool = this.pools.get(table)
    if (pool) pool.push(row)
    else this.pools.set(table, [row])
    this.pooled++
    if (this.pooled >= MAX_ROWS) {
      void this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
      this.timer.unref()
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pooled === 0) return
    const pools = this.pools
    this.pools = new Map()
    this.pooled = 0
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.droppedBatches++
      if (this.droppedBatches % 10 === 1) {
        logger.error(
          `${logPrefix} ${this.inFlight} sends in flight — dropped batch (${this.droppedBatches} total)`,
        )
      }
      return
    }
    this.inFlight++
    try {
      // One message per table.
      for (const [table, rows] of pools) {
        await this.client().send(SNAPSHOT_QUEUES.snapshotWrite, { table, rows })
      }
    } catch (e) {
      logger.error(`${logPrefix} flush failed, dropping batch: ${String(e)}`)
    } finally {
      this.inFlight--
    }
  }

  /** Reliable batched send for the one-time backfill — awaits the publish (no
   *  in-flight-cap drop, unlike the live `push*` path), so every page durably
   *  reaches the write queue. Idempotent downstream (ReplacingMergeTree). */
  async sendBatch(table: SnapshotTable, rows: Array<AnyRow>): Promise<void> {
    if (!isSnapshotChEnabled() || !rows.length) return
    await this.client().send(SNAPSHOT_QUEUES.snapshotWrite, { table, rows })
  }

  /** Historical time-series read. Returns null on ANY failure (RPC down, CH
   *  unreachable, flag off) so the caller falls back to Mongo. */
  async snapshotRead(
    msg: SnapshotReadMessage,
  ): Promise<SnapshotReadResponse | null> {
    if (!isSnapshotChReadEnabled()) return null
    try {
      const res = await this.client().sendWithCallback<
        SnapshotReadMessage,
        SnapshotReadResponse
      >(SNAPSHOT_QUEUES.snapshotRead, msg, RPC_TIMEOUT_MS)
      if (!res?.response || !res.response.ok) {
        logger.warn(
          `${logPrefix} snapshotRead: ${res?.response?.error ?? 'no response'} (${msg.table})`,
        )
        return null
      }
      return res.response
    } catch (e) {
      logger.error(`${logPrefix} snapshotRead failed: ${(e as Error).message}`)
      return null
    }
  }

  /** Account CH purge (reset / GDPR). DELETE WHERE userId=… across both snapshot
   *  tables; `paperContext` (when set) scopes it to a paper-only / live-only
   *  reset. Idempotent; null on failure so the caller can retry. */
  async snapshotDeleteByUser(
    userId: string,
    paperContext?: boolean,
  ): Promise<SnapshotDeleteResponse | null> {
    if (!isSnapshotChEnabled() || !userId) return { ok: true }
    try {
      const res = await this.client().sendWithCallback<
        { userId: string; paperContext?: boolean },
        SnapshotDeleteResponse
      >(
        SNAPSHOT_QUEUES.snapshotDeleteByUser,
        { userId, paperContext },
        RPC_TIMEOUT_MS,
      )
      if (!res?.response) {
        logger.warn(`${logPrefix} snapshotDeleteByUser: no response`)
        return null
      }
      return res.response
    } catch (e) {
      logger.error(
        `${logPrefix} snapshotDeleteByUser failed: ${(e as Error).message}`,
      )
      return null
    }
  }
}

export default SnapshotClient
