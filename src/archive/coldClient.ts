/**
 * coldClient.ts — RPC client for the archived-bot cold store (core → market-
 * archive, which owns the ClickHouse connection). Lives in core because every
 * caller is in `core/src/bot/index.ts`.
 *
 * Write path (archive copy): `coldInsert` then `coldCount` (parity) — both
 * request/response so the archiver can gate the Mongo delete on a verified CH
 * copy (see coldStoreArchiver). Read path (drill-down/export): `coldRead`.
 * GC path (bot delete): `coldDelete` (batched).
 *
 * Feature flag `COLD_STORE_ENABLED` (default OFF). When off, `isColdStoreEnabled`
 * is false → the archiver never copies, read-routing never leaves Mongo, GC skips
 * CH. Self-hosted leaves the flag absent and stays wholly in Mongo (design §0.6).
 * ClickHouse is NEVER a product dependency — a null/failed RPC always falls back
 * to Mongo on the read path, and aborts (never deletes) on the write path.
 */

import Rabbit from '../db/rabbit'
import logger from '../utils/logger'
import {
  COLD_QUEUES,
  type ColdTable,
  type ColdOrderRow,
  type ColdTransactionRow,
  type ColdRow,
  type ColdInsertResponse,
  type ColdCountMessage,
  type ColdCountResponse,
  type ColdReadMessage,
  type ColdReadResponse,
  type ColdDeleteResponse,
} from './coldTypes'

const logPrefix = '[ColdClient]'

const COLD_RPC_TIMEOUT_MS = Number(
  process.env.COLD_STORE_RPC_TIMEOUT_MS ?? 60_000,
)

export function isColdStoreEnabled(): boolean {
  const flag = process.env.COLD_STORE_ENABLED
  if (!flag) return false
  return !['0', 'false', 'no', ''].includes(flag.toLowerCase())
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}
function ms(v: unknown): number {
  if (v == null) return 0
  const t = v instanceof Date ? v.getTime() : new Date(v as string).getTime()
  return Number.isFinite(t) ? t : 0
}

/** Mongo order doc → wire row. Only the read/verify keys are promoted; `raw`
 *  carries every field losslessly (the store is delete-backed). */
export function toColdOrderRow(doc: Record<string, any>): ColdOrderRow {
  return {
    userId: str(doc.userId),
    botId: str(doc.botId),
    dealId: str(doc.dealId),
    status: str(doc.status),
    typeOrder: str(doc.typeOrder),
    raw: JSON.stringify(doc),
    created: ms(doc.created),
    mongoId: str(doc._id),
  }
}

/** Mongo transaction / comboTransaction doc → wire row. `raw` is lossless. */
export function toColdTransactionRow(
  doc: Record<string, any>,
  kind: 'dca' | 'combo',
): ColdTransactionRow {
  return {
    userId: str(doc.userId),
    botId: str(doc.botId),
    dealId: str(doc.dealId),
    kind,
    raw: JSON.stringify(doc),
    created: ms(doc.created),
    mongoId: str(doc._id),
  }
}

export class ColdClient {
  private static _instance: ColdClient | null = null
  static getInstance(): ColdClient {
    if (!ColdClient._instance) ColdClient._instance = new ColdClient()
    return ColdClient._instance
  }

  private rabbit: Rabbit | null = null
  private client(): Rabbit {
    if (!this.rabbit) this.rabbit = new Rabbit()
    return this.rabbit
  }

  /** Batched insert of one page. Synchronous on the CH side (the consumer waits
   *  for the insert to be durable) so the follow-up parity count sees the rows.
   *  Returns `{ ok:false }` on any RPC failure — the archiver then ABORTS (never
   *  deletes) and retries next run. */
  async coldInsert(
    table: ColdTable,
    rows: ColdRow[],
  ): Promise<ColdInsertResponse> {
    if (!rows.length) return { ok: true, inserted: 0 }
    try {
      const res = await this.client().sendWithCallback<
        { table: ColdTable; rows: ColdRow[] },
        ColdInsertResponse
      >(COLD_QUEUES.coldInsert, { table, rows }, COLD_RPC_TIMEOUT_MS)
      if (!res?.response) {
        logger.warn(`${logPrefix} coldInsert: no response (${table})`)
        return { ok: false, inserted: 0, error: 'no response' }
      }
      return res.response
    } catch (e) {
      logger.error(`${logPrefix} coldInsert failed: ${(e as Error).message}`)
      return { ok: false, inserted: 0, error: (e as Error).message }
    }
  }

  /** Count CH rows for `botId` within the just-inserted `[minMongoId,maxMongoId]`
   *  id-range. The archiver compares against the page length (>= => parity OK). */
  async coldCount(msg: ColdCountMessage): Promise<ColdCountResponse> {
    try {
      const res = await this.client().sendWithCallback<
        ColdCountMessage,
        ColdCountResponse
      >(COLD_QUEUES.coldCount, msg, COLD_RPC_TIMEOUT_MS)
      if (!res?.response) {
        logger.warn(`${logPrefix} coldCount: no response (${msg.table})`)
        return { ok: false, count: 0, error: 'no response' }
      }
      return res.response
    } catch (e) {
      logger.error(`${logPrefix} coldCount failed: ${(e as Error).message}`)
      return { ok: false, count: 0, error: (e as Error).message }
    }
  }

  /** Drill-down / export read. Returns `null` on any failure so the caller falls
   *  back to Mongo (CH is never a hard dependency). */
  async coldRead(msg: ColdReadMessage): Promise<ColdReadResponse | null> {
    try {
      const res = await this.client().sendWithCallback<
        ColdReadMessage,
        ColdReadResponse
      >(COLD_QUEUES.coldRead, msg, COLD_RPC_TIMEOUT_MS)
      if (!res?.response || !res.response.ok) {
        logger.warn(
          `${logPrefix} coldRead: ${res?.response?.error ?? 'no response'} (bot ${msg.botId})`,
        )
        return null
      }
      return res.response
    } catch (e) {
      logger.error(`${logPrefix} coldRead failed: ${(e as Error).message}`)
      return null
    }
  }

  /** Batched CH removal on archived-bot delete GC. Idempotent; returns null on
   *  failure so the caller keeps the botIds pending for the next GC pass. */
  async coldDelete(botIds: string[]): Promise<ColdDeleteResponse | null> {
    if (!botIds.length) return { ok: true }
    try {
      const res = await this.client().sendWithCallback<
        { botIds: string[] },
        ColdDeleteResponse
      >(COLD_QUEUES.coldDelete, { botIds }, COLD_RPC_TIMEOUT_MS)
      if (!res?.response) {
        logger.warn(`${logPrefix} coldDelete: no response`)
        return null
      }
      return res.response
    } catch (e) {
      logger.error(`${logPrefix} coldDelete failed: ${(e as Error).message}`)
      return null
    }
  }
}

export default ColdClient
