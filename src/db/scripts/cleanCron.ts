import utils from './cleanDb'
import Bot from '../../bot'
import logger from '../../utils/logger'
import ColdStoreReconciler from '../../archive/coldStoreReconciler'
import { isColdStoreEnabled } from '../../archive/coldClient'

const bot = Bot.getInstance()

const cleanJob = async () => {
  logger.debug('Running clean job')
  await utils.clearNotUsedPaperData()
  await utils.clearPaperOldOrders()
  await utils.clearRealOldCanceledOrders()
  await utils.clearBalances()
  await utils.cleanNotUsedUserFee()
  await bot.premanenetlyDeleteBots(false)
  // Cold-store CH↔Mongo orphan sweep (flag-gated; no-op when off / self-hosted).
  if (isColdStoreEnabled()) {
    try {
      const rec = await ColdStoreReconciler.getInstance().sweep()
      logger.debug(
        `Cold-store sweep: ${rec.chBots} CH bots, ${rec.orphansGced} orphans GC'd, ${rec.missingChWarned} missing-CH warned`,
      )
    } catch (e) {
      logger.error(`Cold-store sweep failed: ${(e as Error).message}`)
    }
  }
  // snapshots (90d), rates (30d) and bot events (30d) now expire via TTL
  // indexes (see registerIndexes) — the age-based deletes were removed here.
  // Bot *warnings* keep their own 14d code-delete (a subset the 30d TTL can't cover).
  await utils.removeOldBotWarnings()
  logger.debug('Clean job finished')
}

export default cleanJob
