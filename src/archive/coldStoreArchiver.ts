/**
 * coldStoreArchiver.ts — the archive-time copy-verify-delete pipeline (design §1).
 *
 * Runs when a bot becomes `archived` (fire-and-forget from `Bot.setArchiveStatus`,
 * off the response path). Per bot, per cold target (orders, then transactions):
 *   1. READ a page of THIS bot's rows from Mongo (id-paged, oldest first).
 *   2. INSERT the page to ClickHouse in ONE batched insert (RPC → market-archive).
 *   3. VERIFY parity (CH count for that exact id-range) BEFORE deleting anything.
 *   4. DELETE that verified id-range from Mongo.
 * Then flip the bot's `coldArchived` flag so drill-down reads route to CH.
 *
 * Why it can't lose data: the delete is gated on a verified CH count for the same
 * id-range just inserted. Any insert/verify failure ABORTS — no delete — and the
 * bot stays fully in Mongo, retried on the next archive attempt. The bot is
 * already read-only (`archive` status, one-way — see setArchiveStatus), so no
 * concurrent writer races the copy. ReplacingMergeTree + unique (…, mongoId) sort
 * key makes a partly-completed re-run idempotent.
 *
 * Scope (Part 1): grid / dca / combo bots. Hedge bots are excluded — their orders
 * fan out across child-bot ids; they stay in Mongo under the old (reversible)
 * archive semantics until a follow-up handles the fan-out. Self-hosted never runs
 * this (flag off, design §0.6).
 */

import { StatusEnum, BotStatusEnum } from '../../types'
import logger from '../utils/logger'
import {
  botDb,
  dcaBotDb,
  comboBotDb,
  orderDb,
  transactionDb,
  comboTransactionsDb,
} from '../db/dbInit'
import ColdClient, {
  isColdStoreEnabled,
  toColdOrderRow,
  toColdTransactionRow,
} from './coldClient'
import type { ColdRow, ColdTable } from './coldTypes'

const logPrefix = '[ColdStoreArchiver]'
const PAGE = Number(process.env.COLD_STORE_PAGE ?? 20_000)
const ZERO_ID = '0'.repeat(24)

/** Bot types Part 1 cold-archives. Hedge excluded (child-bot fan-out). */
export type ColdBotType = 'grid' | 'dca' | 'combo'

interface DaoLike {
  readData: (...args: any[]) => Promise<any>
  deleteManyData: (...args: any[]) => Promise<any>
  updateData: (...args: any[]) => Promise<any>
}

export class ColdStoreArchiver {
  private static _instance: ColdStoreArchiver | null = null
  static getInstance(): ColdStoreArchiver {
    if (!ColdStoreArchiver._instance) {
      ColdStoreArchiver._instance = new ColdStoreArchiver()
    }
    return ColdStoreArchiver._instance
  }

  /** In-flight botIds — never run two copies for the same bot at once. */
  private running = new Set<string>()

  private botDao(type: ColdBotType): DaoLike {
    return (type === 'grid'
      ? botDb
      : type === 'combo'
        ? comboBotDb
        : dcaBotDb) as unknown as DaoLike
  }

  /**
   * Fire-and-forget entry point. Copies each bot's history to CH then flips its
   * `coldArchived` flag. Sequential per bot; safe to call again (idempotent) if a
   * prior run aborted before completing — an already-empty Mongo range just
   * no-ops and the flag flip re-asserts.
   */
  async enqueueArchive(
    userId: string,
    type: ColdBotType,
    botIds: string[],
  ): Promise<void> {
    if (!isColdStoreEnabled()) return
    for (const botId of botIds) {
      const id = `${botId}`
      if (this.running.has(id)) continue
      this.running.add(id)
      try {
        await this.archiveBot(userId, type, id)
      } catch (e) {
        logger.error(
          `${logPrefix} bot ${id} archive threw: ${(e as Error).message}`,
        )
      } finally {
        this.running.delete(id)
      }
    }
  }

  private async archiveBot(
    userId: string,
    type: ColdBotType,
    botId: string,
  ): Promise<boolean> {
    // Orders (all bot types), keyed by botId.
    const ordersOk = await this.copyVerifyDelete(
      'orders',
      orderDb as unknown as DaoLike,
      botId,
      (d) => toColdOrderRow(d),
    )
    if (!ordersOk) {
      logger.warn(
        `${logPrefix} bot ${botId} orders copy aborted — left in Mongo`,
      )
      return false
    }

    // Transactions — combo bots use `comboTransactions` (kind='combo'); grid/dca
    // use `transactions` (kind='dca'). Both land in the unified CH `transactions`.
    const txDb = (type === 'combo'
      ? comboTransactionsDb
      : transactionDb) as unknown as DaoLike
    const kind = type === 'combo' ? 'combo' : 'dca'
    const txOk = await this.copyVerifyDelete('transactions', txDb, botId, (d) =>
      toColdTransactionRow(d, kind),
    )
    if (!txOk) {
      logger.warn(
        `${logPrefix} bot ${botId} transactions copy aborted — left in Mongo`,
      )
      return false
    }

    // Both targets fully copied + verified + deleted from Mongo → route reads to CH.
    const marked = await this.botDao(type).updateData(
      { _id: botId, userId },
      { $set: { coldArchived: true } },
    )
    if (marked?.status !== StatusEnum.ok) {
      logger.error(
        `${logPrefix} bot ${botId} copy done but coldArchived flag not set — reads stay on (now-empty) Mongo until re-run`,
      )
      return false
    }
    logger.info(`${logPrefix} bot ${botId} cold-archived to ClickHouse`)
    return true
  }

  /**
   * One-time retroactive backfill (design §5): cold-archive every already-archived
   * grid/dca/combo bot not yet in CH. Resumable + idempotent — a bot flips
   * `coldArchived` on success, so a re-run skips it; FAILED bots keep the flag
   * false but are stepped over (id-paged) this run and retried on the next run.
   * Cloud-only (flag). Bounded per call by `limit` so it can be chunked.
   */
  async backfillArchivedBots(
    opts: { limit?: number; batch?: number } = {},
  ): Promise<{ processed: number; archived: number; failed: number }> {
    const out = { processed: 0, archived: 0, failed: 0 }
    if (!isColdStoreEnabled()) {
      logger.warn(`${logPrefix} backfill skipped — COLD_STORE_ENABLED off`)
      return out
    }
    const batch = Math.max(1, opts.batch ?? 200)
    const limit = opts.limit ?? 0
    const targets: Array<{ type: ColdBotType; db: DaoLike }> = [
      { type: 'grid', db: botDb as unknown as DaoLike },
      { type: 'dca', db: dcaBotDb as unknown as DaoLike },
      { type: 'combo', db: comboBotDb as unknown as DaoLike },
    ]
    for (const { type, db } of targets) {
      let lastId = ZERO_ID
      for (;;) {
        if (limit && out.processed >= limit) break
        const remaining = limit ? Math.min(batch, limit - out.processed) : batch
        const page = await db.readData(
          {
            status: BotStatusEnum.archive,
            coldArchived: { $ne: true },
            _id: { $gt: lastId },
          },
          { _id: true, userId: true },
          { sort: { _id: 1 }, limit: remaining },
          true,
        )
        if (page?.status !== StatusEnum.ok) {
          logger.error(`${logPrefix} backfill ${type} read failed`)
          break
        }
        const bots: Array<{ _id: unknown; userId: string }> =
          page.data?.result ?? []
        if (!bots.length) break
        for (const b of bots) {
          const id = `${b._id}`
          const ok = await this.archiveBot(b.userId, type, id).catch((e) => {
            logger.error(
              `${logPrefix} backfill bot ${id} threw: ${(e as Error).message}`,
            )
            return false
          })
          out.processed++
          if (ok) out.archived++
          else out.failed++
          lastId = id
        }
        logger.info(
          `${logPrefix} backfill ${type}: processed ${out.processed}, archived ${out.archived}, failed ${out.failed}`,
        )
      }
    }
    return out
  }

  /**
   * One cold target for one bot: page Mongo by _id, insert→verify→delete each
   * page. Returns false (abort, nothing deleted for the failing page) on any
   * insert/parity/delete failure so the bot stays recoverable in Mongo.
   */
  private async copyVerifyDelete(
    table: ColdTable,
    db: DaoLike,
    botId: string,
    toRow: (doc: Record<string, any>) => ColdRow,
  ): Promise<boolean> {
    const cold = ColdClient.getInstance()
    let lastId = ZERO_ID
    for (;;) {
      const page = await db.readData(
        { botId, _id: { $gt: lastId } },
        undefined,
        { sort: { _id: 1 }, limit: PAGE },
        true,
        false,
      )
      if (page?.status !== StatusEnum.ok) {
        logger.error(`${logPrefix} ${table} read failed for bot ${botId}`)
        return false
      }
      const rows: Array<Record<string, any>> = page.data?.result ?? []
      if (!rows.length) return true

      const minId = `${rows[0]._id}`
      const maxId = `${rows[rows.length - 1]._id}`

      // 2. INSERT this page to CH (synchronous on the CH side).
      const ins = await cold.coldInsert(table, rows.map(toRow))
      if (!ins.ok) {
        logger.error(
          `${logPrefix} ${table} CH insert failed for bot ${botId} [${minId}..${maxId}]: ${ins.error ?? ''}`,
        )
        return false
      }

      // 3. VERIFY parity for this exact id-range BEFORE deleting anything.
      const cnt = await cold.coldCount({
        table,
        botId,
        minMongoId: minId,
        maxMongoId: maxId,
      })
      if (!cnt.ok || cnt.count < rows.length) {
        logger.error(
          `${logPrefix} ${table} parity FAIL for bot ${botId} [${minId}..${maxId}]: CH ${cnt.count} < Mongo ${rows.length} — NOT deleting`,
        )
        return false
      }

      // 4. DELETE that exact verified id-range from Mongo.
      const del = await db.deleteManyData({
        botId,
        _id: { $gte: rows[0]._id, $lte: rows[rows.length - 1]._id },
      })
      if (del?.status !== StatusEnum.ok) {
        logger.error(
          `${logPrefix} ${table} Mongo delete failed for bot ${botId} [${minId}..${maxId}] — CH has the copy; retry will re-insert (idempotent) and re-delete`,
        )
        return false
      }
      lastId = maxId
    }
  }
}

export default ColdStoreArchiver
