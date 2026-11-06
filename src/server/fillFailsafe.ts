import logger from '../utils/logger'
import { HealthServer } from '../utils/healthServer'
import { FillFailsafe } from '../fillFailsafe/main'
import { LOG_PREFIX } from '../fillFailsafe/types'

/**
 * Server entry for the missed-fill failsafe detector. Watches resting LIMIT
 * orders against the live trade feed; when price crosses one that the bot
 * still holds as open, it confirms with the exchange and tells the bot to
 * reconcile. Idle unless FF_ENABLED=true. Single-instance (Redis leader lock).
 */
new HealthServer().start()

new FillFailsafe().start().catch((e) => {
  logger.error(`${LOG_PREFIX} fatal boot error: ${e}`)
  process.exit(1)
})
