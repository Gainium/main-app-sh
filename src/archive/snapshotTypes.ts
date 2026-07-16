/**
 * snapshotTypes.ts — wire contract for the portfolio-snapshot cloud mirror
 * (main-app/core ↔ market-archive over RabbitMQ).
 *
 * These types + the `SNAPSHOT_QUEUES` names are the canonical producer-side
 * definition. They are MIRRORED BYTE-IDENTICALLY in `market-archive/src/types.ts`
 * (the ClickHouse owner) and re-exported from `main-app/src/archive/types.ts` — a
 * change here MUST be applied to both (root Danger List §6). Drift = silent RPC
 * timeouts / dropped writes.
 *
 * The client lives in `core` (not `main-app/src`) because the writer
 * (`core/src/utils/user.ts userSnapshots`) and the read routing
 * (`core/src/graphql/resolvers.ts`) are both in core, and core cannot import from
 * main-app/src. Same placement rationale as `coldTypes.ts`/`coldClient.ts`.
 *
 * Design: runbooks/mongo-optimization/phase4-snapshots-clickhouse.md.
 *
 * WRITE is fire-and-forget (buffered `{table, rows}` envelope, the analytics
 * pattern) — a mirror, never the only copy, so a dropped write is a cosmetic gap
 * in long-history, never data loss (Mongo is source-of-truth on both editions).
 * READ + DELETE are request/response RPC (the cold-store pattern); a null/failed
 * read falls back to Mongo, so ClickHouse is never a product dependency.
 */

/** RabbitMQ queue names. Duplicated verbatim in the `ARCHIVE_QUEUES` const of
 *  both `market-archive/src/types.ts` and `main-app/src/archive/types.ts`. */
export const SNAPSHOT_QUEUES = {
  /** Fire-and-forget: buffered `{table, rows}` insert (dual-write path). */
  snapshotWrite: 'snapshotWrite',
  /** RPC: userId-scoped historical time-series read (portfolio chart). */
  snapshotRead: 'snapshotRead',
  /** RPC: DELETE WHERE userId=… — whole-account purge (reset / GDPR). */
  snapshotDeleteByUser: 'snapshotDeleteByUser',
} as const

/** The two CH snapshot tables (in the `gainium_snapshots` database). */
export const SNAPSHOT_TABLES = ['snapshots', 'snapshots_per_exchange'] as const
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number]

// ─── write rows (dual-write) ─────────────────────────────────────────────────

/** One portfolio snapshot on the wire (`snapshots` table). `updated` is the
 *  ReplacingMergeTree version — the freshest re-write of a given (userId,
 *  paperContext, updateTime) day wins. `raw` is the lossless original Mongo doc
 *  (JSON) so historical asset composition stays recoverable; the chart reads only
 *  `updateTime`+`totalUsd`. */
export interface SnapshotRow {
  userId: string
  paperContext: boolean
  /** ms epoch — UTC-midnight minus the user's tz offset (the daily bucket key). */
  updateTime: number
  totalUsd: number
  updated: number
  raw?: string
}

/** One per-exchange snapshot on the wire (`snapshots_per_exchange` table). */
export interface SnapshotPerExchangeRow {
  userId: string
  paperContext: boolean
  uuid: string
  updateTime: number
  totalUsd: number
  updated: number
}

/** The generic `{table, rows}` envelope posted onto `snapshotWrite`. One queue
 *  for both tables — the archive allowlists `table`. */
export interface SnapshotWriteMessage {
  table: SnapshotTable
  rows: Array<SnapshotRow | SnapshotPerExchangeRow>
}

// ─── snapshotRead — userId-scoped time-series read (chart) ───────────────────

export interface SnapshotReadMessage {
  table: SnapshotTable
  /** From the session/JWT — a user reads only their own snapshots. */
  userId: string
  paperContext: boolean
  /** per-exchange only: restrict to one exchange connection. */
  uuid?: string
  /** Inclusive `updateTime` range (ms epoch). */
  from?: number
  to?: number
}

/** One deduped point (per (userId, day, paperContext[, uuid])), oldest-first.
 *  The `snapshots` table returns the FULL original Mongo doc (from the lossless
 *  `raw` column) so the shape matches a Mongo read — the chart needs `assets[]`,
 *  not just the total. `snapshots_per_exchange` returns these flat fields. */
export type SnapshotReadRow = {
  updateTime?: number
  totalUsd?: number
  uuid?: string
  [key: string]: unknown
}

export interface SnapshotReadResponse {
  ok: boolean
  /** Full original Mongo docs (snapshots) or flat per-exchange rows. */
  rows: SnapshotReadRow[]
  error?: string
}

// ─── snapshotDeleteByUser — account CH purge (reset / GDPR) ───────────────────

export interface SnapshotDeleteByUserMessage {
  userId: string
  /** When set, scope the purge to that context (paper-only / live-only reset).
   *  Omitted ⇒ purge ALL of the user's snapshots (whole-account reset / GDPR). */
  paperContext?: boolean
}
export interface SnapshotDeleteResponse {
  ok: boolean
  error?: string
}
