import cron from 'node-cron'
import userUtils from '../utils/user'
import logger from '../utils/logger'
import Bot from '../bot/index'
import cleanJob from '../db/scripts/cleanCron'
import removeOldFiles from '../backtest/process/cron'
import { saveRate, exchangeFullUpdate } from '../utils/cron/exchange'
import { publishFunding } from '../utils/cron/funding'
import { checkBacktests } from '../utils/cron/backtest'
import HealthServer from '../utils/healthServer'

const { userSnapshots, checkTokens } = userUtils

// Start health server
const healthServer = new HealthServer()
healthServer.start()

Bot.getInstance().premanenetlyDeleteBots()

exchangeFullUpdate()

cron.schedule('0 */12 * * *', async () => {
  saveRate()
})

cron.schedule('20 */1 * * *', async () => {
  exchangeFullUpdate()
})

cron.schedule('15 */1 * * *', async () => {
  Bot.getInstance().closeOldStartDeals()
})

// Funding fees: every hour at :05, just after on-the-hour settlements. SH uses
// exchange candles for mark price; cloud overrides with the archive source.
cron.schedule('5 */1 * * *', async () => {
  publishFunding()
})

cron.schedule('0 0 * * *', async () => {
  Bot.getInstance().premanenetlyDeleteBots()
  checkBacktests()
})

cron.schedule('45 0 * * *', async () => {
  userSnapshots()
})

cron.schedule('30 0 * * *', async () => {
  removeOldFiles()
})

cron.schedule('*/1 * * * *', async () => {
  checkTokens()
})

cron.schedule('12 0 * * 7', async () => {
  cleanJob()
})

logger.info('Cron installed')

process
  .on('unhandledRejection', (reason, p) => {
    logger.error(reason, 'Unhandled Rejection at Promise', p)
  })
  .on('uncaughtException', (err) => {
    logger.error(err, 'Uncaught Exception thrown')
  })
