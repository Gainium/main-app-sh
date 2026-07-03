import {
  runWatchdogTick,
  type ActionDispatcher,
} from '../streamWatchdog/watchdog'
import { STALE_THRESHOLD_MS } from '../streamWatchdog/utils'
import { log } from '../streamWatchdog/utils'
import RedisClient from '../db/redis'
import RabbitClient from '../db/rabbit'

export const main = (isDispatchAvailable?: () => Promise<boolean>) => {
  let timer: NodeJS.Timeout | null = null
  const dispatch: ActionDispatcher = async (action) => {
    if (isDispatchAvailable && !isDispatchAvailable()) {
      log('warn', 'Dispatch is not available, skipping action', action)
      return
    }
    const redis = await RedisClient.getInstance()
    switch (action.type) {
      case 'triggerSelfHeal':
        log('info', `Triggering self-heal for account ${action.accountId}`)
        const rabbit = new RabbitClient()
        await rabbit.send(`usersStreamAction`, {
          event: 'force restart stream',
          uuid: action.accountId,
        })
        break
      case 'signalReconcile':
        log('info', `Signaling reconcile for account ${action.accountId}`)
        await redis.publish(
          `userStreamInfo${action.accountId}`,
          'RECONCILE VIA SWEEP',
        )
        break
      case 'signalShowError':
        log('info', `Signaling show error for account ${action.accountId}`)
        await redis.publish(`userStreamInfo${action.accountId}`, 'INFORM USERS')
        break
    }
  }

  timer = setInterval(() => {
    runWatchdogTick(dispatch).catch((err) => {
      // don't let one bad tick kill the interval
      console.error('watchdog tick failed', err)
    })
  }, STALE_THRESHOLD_MS)

  log(
    'info',
    'Stream Watchdog started, running every',
    STALE_THRESHOLD_MS,
    'ms',
  )

  process.on('SIGINT', () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    log('info', 'Stream Watchdog stopped')
    process.exit(0)
  })
}
