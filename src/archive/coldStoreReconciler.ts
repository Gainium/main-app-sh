/**
 * coldStoreReconciler.ts — periodic CH↔Mongo consistency sweep (design §5, PART 2
 * additive safety net). Catches orphans left by any failed delete/GC on either
 * side. Non-destructive to Mongo; the only mutation it makes is GC-ing CH rows
 * that provably no longer belong to a cold-archived bot.
 *
 * Forward (active GC): every distinct botId present in `gainium_cold` whose Mongo
 * bot doc is GONE, or is present but no longer `coldArchived` (e.g. a rehydrate
 * cleared the flag but the CH GC failed), is an orphan → batched `coldDelete`.
 *
 * Reverse (detect + log only): a Mongo bot flagged `coldArchived=true` with NO CH
 * rows is a possible data-loss signal — logged, never auto-"repaired" (clearing
 * the flag would just route reads to an equally-empty Mongo). A brand-new archived
 * bot that never traded legitimately has zero rows, so this is a warning, not an
 * error.
 *
 * Cloud-only (flag). Rides the daily clean cron.
 */

import logger from '../utils/logger'
import { botDb, dcaBotDb, comboBotDb } from '../db/dbInit'
import ColdClient, { isColdStoreEnabled } from './coldClient'

const logPrefix = '[ColdStoreReconciler]'
/** Max botIds per DELETE … WHERE botId IN(…) — keeps each CH mutation bounded. */
const DELETE_CHUNK = Number(process.env.COLD_STORE_GC_CHUNK ?? 500)

interface DaoLike {
  readData: (...args: any[]) => Promise<any>
}

export interface ReconcileResult {
  chBots: number
  orphansGced: number
  missingChWarned: number
}

export class ColdStoreReconciler {
  private static _instance: ColdStoreReconciler | null = null
  static getInstance(): ColdStoreReconciler {
    if (!ColdStoreReconciler._instance) {
      ColdStoreReconciler._instance = new ColdStoreReconciler()
    }
    return ColdStoreReconciler._instance
  }

  private daos(): DaoLike[] {
    return [
      botDb as unknown as DaoLike,
      dcaBotDb as unknown as DaoLike,
      comboBotDb as unknown as DaoLike,
    ]
  }

  async sweep(): Promise<ReconcileResult> {
    const out: ReconcileResult = {
      chBots: 0,
      orphansGced: 0,
      missingChWarned: 0,
    }
    if (!isColdStoreEnabled()) return out
    const cold = ColdClient.getInstance()

    // 1. Every distinct botId currently in CH.
    const listed = await cold.coldListBots()
    if (!listed) {
      logger.warn(`${logPrefix} coldListBots unavailable — sweep skipped`)
      return out
    }
    const chBotIds = Array.from(new Set(listed.bots.map((b) => b.botId)))
    out.chBots = chBotIds.length
    if (!chBotIds.length) return out

    // 2. Which of those bots still exist in Mongo, and with which flag.
    const flagByBot = new Map<string, boolean>()
    for (const db of this.daos()) {
      // Batch by chunk to bound the $in.
      for (let i = 0; i < chBotIds.length; i += DELETE_CHUNK) {
        const slice = chBotIds.slice(i, i + DELETE_CHUNK)
        const res = await db.readData(
          { _id: { $in: slice } },
          { _id: true, coldArchived: true },
          undefined,
          true,
          true,
        )
        for (const b of res?.data?.result ?? []) {
          flagByBot.set(
            `${b._id}`,
            (b as { coldArchived?: boolean }).coldArchived === true,
          )
        }
      }
    }

    // 3. Forward GC: CH botId whose Mongo doc is gone OR not coldArchived.
    const orphans = chBotIds.filter((id) => flagByBot.get(id) !== true)
    for (let i = 0; i < orphans.length; i += DELETE_CHUNK) {
      const slice = orphans.slice(i, i + DELETE_CHUNK)
      const del = await cold.coldDelete(slice)
      if (del?.ok) {
        out.orphansGced += slice.length
      } else {
        logger.error(
          `${logPrefix} orphan GC failed for ${slice.length} bot(s) — will retry next sweep`,
        )
      }
    }
    if (out.orphansGced) {
      logger.info(
        `${logPrefix} GC'd ${out.orphansGced} orphaned cold bot(s) (missing / un-archived)`,
      )
    }

    // 4. Reverse detect: Mongo bots flagged coldArchived with no CH rows.
    const chSet = new Set(chBotIds)
    for (const db of this.daos()) {
      const res = await db.readData(
        { coldArchived: true },
        { _id: true, userId: true },
        undefined,
        true,
        true,
      )
      for (const b of res?.data?.result ?? []) {
        if (!chSet.has(`${b._id}`)) {
          out.missingChWarned++
          logger.warn(
            `${logPrefix} bot ${b._id} (user ${(b as { userId?: string }).userId}) is flagged coldArchived but has NO ClickHouse rows — verify (empty-history bot or possible data loss)`,
          )
        }
      }
    }
    return out
  }
}

export default ColdStoreReconciler
