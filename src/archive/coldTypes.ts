/**
 * coldTypes.ts — wire contract for the archived-bot cold store (main-app/core ↔
 * market-archive over RabbitMQ RPC).
 *
 * These types + the `COLD_QUEUES` names are the canonical producer-side
 * definition. They are MIRRORED BYTE-IDENTICALLY in `market-archive/src/types.ts`
 * (the CH owner) and re-exported from `main-app/src/archive/types.ts` — a change
 * here MUST be applied to both (root Danger List §6). Drift = silent RPC timeouts.
 *
 * The client lives in `core` (not `main-app/src`) because every call site —
 * `Bot.setArchiveStatus`, `Bot.getBotOrders`/`getDealOrders`/`getBotTransactions`,
 * `Bot.premanenetlyDeleteBots` — is in `core/src/bot/index.ts`, and core cannot
 * import from main-app/src.
 *
 * Design: runbooks/mongo-optimization/phase3-clickhouse-coldstore.md (LOCKED).
 */

/** RabbitMQ queue names for the cold-store RPC. Duplicated verbatim in the
 *  `ARCHIVE_QUEUES` const of both `market-archive/src/types.ts` and
 *  `main-app/src/archive/types.ts`. */
export const COLD_QUEUES = {
  /** Batched insert of one page of a bot's rows (archive copy path). */
  coldInsert: 'coldStoreInsert',
  /** Parity check over a (botId, mongoId-range) — the just-inserted page. */
  coldCount: 'coldStoreCount',
  /** userId+botId-scoped read for drill-down / export. */
  coldRead: 'coldStoreRead',
  /** Batched DELETE WHERE botId IN(…) on archived-bot delete GC (§1b). */
  coldDelete: 'coldStoreDelete',
} as const

/** The two CH cold tables. `transactions` unifies Mongo `transactions` (dca) and
 *  `comboTransactions` (combo), discriminated by the row's `kind`. */
export const COLD_TABLES = ['orders', 'transactions'] as const
export type ColdTable = (typeof COLD_TABLES)[number]

/**
 * One archived-bot order row on the wire. Only the columns reads filter/sort/
 * verify on are promoted; every display field lives once in `raw` (the FULL
 * original Mongo doc as JSON) — the store is delete-backed, so the copy must be
 * lossless, and `coldRead` returns `raw` so downstream shapes are unchanged. No
 * field is stored twice. Field names match the CH columns (camelCase).
 */
export interface ColdOrderRow {
  userId: string
  botId: string
  dealId: string
  status: string
  typeOrder: string
  /** Full original Mongo doc as JSON (lossless). */
  raw: string
  /** ms since epoch. */
  created: number
  /** Original `_id` hex — idempotency + parity key. */
  mongoId: string
}

/** One archived-bot transaction row (dca or combo). `raw` is lossless (see above);
 *  `kind` is provenance (derived, not in the Mongo doc). */
export interface ColdTransactionRow {
  userId: string
  botId: string
  /** combo only; '' for dca. */
  dealId: string
  kind: 'dca' | 'combo'
  /** Full original Mongo doc as JSON (lossless). */
  raw: string
  created: number
  mongoId: string
}

export type ColdRow = ColdOrderRow | ColdTransactionRow

// ─── coldInsert — batched insert of a bot's page (archive path) ──────────────

export interface ColdInsertMessage {
  table: ColdTable
  rows: ColdRow[]
}
export interface ColdInsertResponse {
  ok: boolean
  inserted: number
  error?: string
}

// ─── coldCount — parity over a (botId, mongoId-range) before deleting Mongo ──

export interface ColdCountMessage {
  table: ColdTable
  botId: string
  /** Inclusive lexicographic bounds — the page's first/last `_id` hex. */
  minMongoId: string
  maxMongoId: string
}
export interface ColdCountResponse {
  ok: boolean
  count: number
  error?: string
}

// ─── coldRead — drill-down / export read (returns full Mongo docs) ───────────

export interface ColdReadMessage {
  table: ColdTable
  /** From the session/JWT — a user reads only their own archived rows. */
  userId: string
  botId: string
  /** Restrict to one deal (per-deal drill-down / chart icons). */
  dealId?: string
  /** Restrict to these `status` values (orders table only). */
  statuses?: string[]
  /** Exclude these `typeOrder` values (orders table only; e.g. `br`). */
  typeOrderNotIn?: string[]
  /** Inclusive `created` range (ms epoch). */
  from?: number
  to?: number
  limit?: number
  skip?: number
  /** `created` sort direction; default 'desc' (newest first). */
  sort?: 'asc' | 'desc'
}
export interface ColdReadResponse {
  ok: boolean
  /** Full original Mongo documents (parsed from `raw`) — downstream shapes
   *  stay identical to a Mongo read. */
  rows: Array<Record<string, unknown>>
  /** Total matching rows ignoring limit/skip — for pagination totals. */
  count: number
  error?: string
}

// ─── coldDelete — batched removal on archived-bot delete GC (§1b) ────────────

export interface ColdDeleteMessage {
  botIds: string[]
}
export interface ColdDeleteResponse {
  ok: boolean
  error?: string
}
