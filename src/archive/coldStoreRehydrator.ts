/**
 * coldStoreRehydrator.ts — the un-archive copy-verify pipeline (design §1, inverse
 * of coldStoreArchiver). PART 2: archive is now REVERSIBLE.
 *
 * Runs SYNCHRONOUSLY from `Bot.setArchiveStatus` when a cold-archived bot is
 * un-archived — the bot's orders/transactions must be back in Mongo before it can
 * be started again, so this completes (or fails) before the status flip. Per bot,
 * per cold target (orders, then transactions):
 *   1. READ every CH page of THIS bot's rows (userId+botId-scoped, oldest first).
 *   2. UPSERT the page into Mongo by original `_id` (idempotent — a retried run
 *      overwrites rather than duplicate-keys).
 *   3. VERIFY the Mongo row count for the bot covers everything we copied.
 * Then, only after BOTH targets are verified:
 *   4. CLEAR the bot's `coldArchived` flag  → drill-down reads route back to Mongo.
 *   5. DELETE the CH copies (best-effort GC).
 *
 * Fail-safe ordering (mirror of the archiver's copy-verify-delete): the flag is
 * cleared BEFORE the CH delete, and the CH delete is last. So the ONLY thing a
 * crash/failure can leave behind is harmless CH orphan rows (the orphan sweep GCs
 * them) — never a window where reads route to a store that no longer has the data.
 * Any read/upsert/verify failure ABORTS with the bot still fully in CH and
 * `coldArchived=true` (reads keep serving CH); the user just retries un-archive.
 *
 * Scope: grid / dca / combo (same as the archiver; hedge is never cold-archived).
 * Self-hosted never runs this (flag off, design §0.6).
 */

import { StatusEnum } from '../../types'
import logger from '../utils/logger'
import {
  botDb,
  dcaBotDb,
  comboBotDb,
  orderDb,
  transactionDb,
  comboTransactionsDb,
} from '../db/dbInit'
import ColdClient, { isColdStoreEnabled } from './coldClient'
import type { ColdBotType } from './coldStoreArchiver'
import type { ColdTable } from './coldTypes'

const logPrefix = '[ColdStoreRehydrator]'
const PAGE = Number(process.env.COLD_STORE_PAGE ?? 20_000)

interface DaoLike {
  bulkUpsertById: (...args: any[]) => Promise<any>
  countData: (...args: any[]) => Promise<any>
  updateData: (...args: any[]) => Promise<any>
}

export class ColdStoreRehydrator {
  private static _instance: ColdStoreRehydrator | null = null
  static getInstance(): ColdStoreRehydrator {
    if (!ColdStoreRehydrator._instance) {
      ColdStoreRehydrator._instance = new ColdStoreRehydrator()
    }
    return ColdStoreRehydrator._instance
  }

  /** In-flight botIds — never rehydrate the same bot twice concurrently. */
  private running = new Set<string>()

  private botDao(type: ColdBotType): DaoLike {
    return (type === 'grid'
      ? botDb
      : type === 'combo'
        ? comboBotDb
        : dcaBotDb) as unknown as DaoLike
  }

  /**
   * Restore one cold-archived bot's history from ClickHouse back to Mongo and
   * clear its `coldArchived` flag. Returns false on any failure (bot stays in CH,
   * flag stays set) so the caller can reject the un-archive. Idempotent.
   */
  async rehydrateBot(
    userId: string,
    type: ColdBotType,
    botId: string,
  ): Promise<boolean> {
    if (!isColdStoreEnabled()) return false
    const id = `${botId}`
    if (this.running.has(id)) {
      logger.warn(`${logPrefix} bot ${id} rehydrate already in progress`)
      return false
    }
    this.running.add(id)
    try {
      // 1. Orders (all bot types), keyed by botId.
      const ordersOk = await this.copyVerify(
        'orders',
        orderDb as unknown as DaoLike,
        userId,
        id,
      )
      if (!ordersOk) {
        logger.warn(
          `${logPrefix} bot ${id} orders rehydrate aborted — left in CH`,
        )
        return false
      }

      // 2. Transactions — combo → comboTransactions, grid/dca → transactions.
      const txDb = (type === 'combo'
        ? comboTransactionsDb
        : transactionDb) as unknown as DaoLike
      const txOk = await this.copyVerify('transactions', txDb, userId, id)
      if (!txOk) {
        logger.warn(
          `${logPrefix} bot ${id} transactions rehydrate aborted — left in CH`,
        )
        return false
      }

      // 3. Both targets verified in Mongo → clear the flag FIRST (reads now serve
      //    Mongo, which has the data) …
      const cleared = await this.botDao(type).updateData(
        { _id: id, userId },
        { $set: { coldArchived: false } },
      )
      if (cleared?.status !== StatusEnum.ok) {
        logger.error(
          `${logPrefix} bot ${id} copied to Mongo but coldArchived flag not cleared — reads stay on CH until re-run`,
        )
        return false
      }

      // 4. … then GC the CH copies (best-effort — a failure leaves harmless
      //    orphans that the orphan sweep collects; reads already serve Mongo).
      const del = await ColdClient.getInstance().coldDelete([id])
      if (!del?.ok) {
        logger.warn(
          `${logPrefix} bot ${id} un-archived but CH GC failed — orphan sweep will reconcile`,
        )
      }
      logger.info(`${logPrefix} bot ${id} rehydrated from ClickHouse to Mongo`)
      return true
    } catch (e) {
      logger.error(
        `${logPrefix} bot ${id} rehydrate threw: ${(e as Error).message}`,
      )
      return false
    } finally {
      this.running.delete(id)
    }
  }

  /**
   * One cold target for one bot: page every CH row (oldest first), upsert each
   * page into Mongo by `_id`, then verify the Mongo count covers what we copied.
   * Returns false (nothing deleted from CH) on any read/upsert/verify failure.
   */
  private async copyVerify(
    table: ColdTable,
    db: DaoLike,
    userId: string,
    botId: string,
  ): Promise<boolean> {
    const cold = ColdClient.getInstance()
    let skip = 0
    let copied = 0
    for (;;) {
      const res = await cold.coldRead({
        table,
        userId,
        botId,
        limit: PAGE,
        skip,
        sort: 'asc',
      })
      if (!res) {
        logger.error(
          `${logPrefix} ${table} CH read failed for bot ${botId} (skip ${skip})`,
        )
        return false
      }
      const rows = res.rows ?? []
      if (!rows.length) break

      const up = await db.bulkUpsertById(rows)
      if (up?.status !== StatusEnum.ok) {
        logger.error(
          `${logPrefix} ${table} Mongo upsert failed for bot ${botId} (skip ${skip}): ${up?.reason ?? ''}`,
        )
        return false
      }
      copied += rows.length
      skip += rows.length
      if (rows.length < PAGE) break
    }

    // Verify: the bot is read-only and the archiver removed all its Mongo rows,
    // so a correct restore leaves Mongo with >= what we copied.
    const cnt = await db.countData({ botId })
    const mongoCount = cnt?.data?.result ?? 0
    if (cnt?.status !== StatusEnum.ok || mongoCount < copied) {
      logger.error(
        `${logPrefix} ${table} parity FAIL for bot ${botId}: Mongo ${mongoCount} < copied ${copied} — NOT clearing flag / deleting CH`,
      )
      return false
    }
    return true
  }
}

export default ColdStoreRehydrator
