process.env.NODE_ENV = 'testing'

/**
 * Restart-time webhook intake: a signal is executed within
 * WEBHOOK_SIGNAL_MAX_AGE_MS of reaching the API or refused with the reason —
 * never queued and executed late — and the restart resumes the bots a signal
 * is likely to need first.
 *
 * The real methods are driven off the prototype with fake state: no Mongo, no
 * worker threads, no rabbit. Fixture ids are synthetic — this file is public.
 *
 * Run: `cd core && npm test`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Bot from './index'
import {
  WEBHOOK_SIGNAL_MAX_AGE_MS,
  webhookSignalAgeMs,
  webhookSignalDeadline,
  webhookSignalExpired,
  webhookSignalExpiredReason,
} from '../server/tradeSignalContract'
import { restartResumeOrder, restartResumeTier } from './restartResumeOrder'
import {
  BotStartTypeEnum,
  CloseConditionEnum,
  StartConditionEnum,
  StatusEnum,
} from '../../types'

describe('webhook signal age cap', () => {
  const now = 1_800_000_000_000
  it('is a small named constant', () => {
    expect(WEBHOOK_SIGNAL_MAX_AGE_MS).to.be.at.most(10_000)
  })
  it('measures age from the API stamp, never negative', () => {
    expect(webhookSignalAgeMs(now - 2500, now)).to.equal(2500)
    expect(webhookSignalAgeMs(now + 500, now)).to.equal(0)
    expect(webhookSignalAgeMs(undefined, now)).to.equal(0)
  })
  it('expires only a stamped signal past the cap', () => {
    expect(webhookSignalExpired(now - WEBHOOK_SIGNAL_MAX_AGE_MS, now)).to.equal(
      false,
    )
    expect(
      webhookSignalExpired(now - WEBHOOK_SIGNAL_MAX_AGE_MS - 1, now),
    ).to.equal(true)
    // A signal from an API that predates the stamp keeps today's behaviour.
    expect(webhookSignalExpired(undefined, now)).to.equal(false)
  })
  it('measures the deadline from the stamp, or from intake when unstamped', () => {
    expect(webhookSignalDeadline(now - 3000, now)).to.equal(
      now - 3000 + WEBHOOK_SIGNAL_MAX_AGE_MS,
    )
    expect(webhookSignalDeadline(undefined, now)).to.equal(
      now + WEBHOOK_SIGNAL_MAX_AGE_MS,
    )
    // A stamp from a clock ahead of ours cannot extend the budget.
    expect(webhookSignalDeadline(now + 60_000, now)).to.equal(
      now + WEBHOOK_SIGNAL_MAX_AGE_MS,
    )
  })
  it('names the action and says it was not executed', () => {
    expect(webhookSignalExpiredReason('addFunds', 14_200)).to.match(
      /^Bot is restarting on our side, so "addFunds" was not executed\. The signal arrived 14s ago/,
    )
  })
})

describe('restartResumeOrder', () => {
  const row = (
    name: string,
    active: number,
    settings: Record<string, string> = {},
  ) => ({ name, deals: { active }, settings })
  it('resumes webhook-driven bots and open deals first, stable within a tier', () => {
    const rows = [
      row('idle-1', 0),
      row('open-1', 2),
      row('tv-idle', 0, {
        startCondition: StartConditionEnum.tradingviewSignals,
      }),
      row('idle-2', 0),
      row('tv-open', 1, {
        startCondition: StartConditionEnum.tradingviewSignals,
      }),
      row('close-hook', 0, { dealCloseCondition: CloseConditionEnum.webhook }),
      row('open-2', 1),
      row('ctl-hook', 0, { botActualStart: BotStartTypeEnum.webhook }),
      row('sl-hook-open', 3, {
        dealCloseConditionSL: CloseConditionEnum.webhook,
      }),
    ]
    expect(restartResumeOrder(rows).map((r) => r.name)).to.deep.equal([
      'tv-open',
      'sl-hook-open',
      'tv-idle',
      'close-hook',
      'ctl-hook',
      'open-1',
      'open-2',
      'idle-1',
      'idle-2',
    ])
  })
  it('orders a row with no settings or deals as the rest', () => {
    expect(restartResumeTier({})).to.equal(3)
  })
  it('does not mutate its input', () => {
    const rows = [row('a', 0), row('b', 1)]
    restartResumeOrder(rows)
    expect(rows.map((r) => r.name)).to.deep.equal(['a', 'b'])
  })
})

const UUID = 'uuid-restart-1'
const BOT_ID = 'bot-restart-1'

const harness = () => {
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaBots = []
  bot.comboBots = []
  bot.hedgeComboBots = []
  bot.hedgeDcaBots = []
  bot.restartExpectedIds = new Set()
  bot.restartFinishedIds = new Set()
  bot.restartDispatchedIds = new Set()
  bot.restartBotIdByUuid = new Map()
  bot.restartWindowOpen = false
  bot.commandListenerArmed = false
  bot.commandsArmedWaiters = []
  bot.restarted = 0
  bot.estimatedRestart = 0
  bot.warnings = [] as string[]
  bot.handleWarn = (m: string) => bot.warnings.push(m)
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  const status = { value: 'open' as string | undefined }
  const db = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: status.value ? { status: status.value } : null },
    }),
  }
  bot.dcaBotDb = db
  bot.comboBotDb = db
  // Arming starts real timers and listeners; the tests only need the flag.
  bot.armCommandListener = (reason: string) => {
    bot.armedWith = reason
    bot.commandListenerArmed = true
  }
  bot.openEarlyWebhookIntake = () => undefined
  return { bot, status }
}

const openWindow = (bot: any, ids: { id: string; uuid: string }[]) => {
  bot.beginRestartWindow(
    ids.length,
    ids.map((b) => b.id),
    ids,
  )
  clearInterval(bot.armWatchdog)
}

describe('restart arming counts unique bots', () => {
  it('does not arm early when a re-restarted bot is counted twice', () => {
    const { bot } = harness()
    openWindow(bot, [
      { id: 'a', uuid: 'ua' },
      { id: 'b', uuid: 'ub' },
      { id: 'c', uuid: 'uc' },
    ])
    bot.updateRestart('a')
    bot.updateRestart('b')
    // Worker died mid-boot: 'a' and 'b' come through the callback again.
    bot.updateRestart('a')
    bot.updateRestart('b')
    expect(bot.armedWith).to.equal(undefined)
    bot.updateRestart('c')
    expect(bot.armedWith).to.equal('parity')
  })
})

describe('signals during a restart', () => {
  it('reports a registered bot as restarting until it reports back', () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    expect(bot.restartingBotIdForUuid(UUID)).to.equal(BOT_ID)
    expect(bot.restartingBotIdForUuid('someone-else')).to.equal(undefined)
    bot.processWorkerMessage({ event: 'restartFinished', botId: BOT_ID })
    return new Promise((r) => setImmediate(r)).then(() => {
      expect(bot.restartingBotIdForUuid(UUID)).to.equal(undefined)
      // Every expected bot is back: the window closes.
      expect(bot.restartWindowOpen).to.equal(false)
    })
  })

  it('waits for a re-loading bot and proceeds once it is back', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    setTimeout(() => bot.restartFinishedIds.add(BOT_ID), 300)
    const started = Date.now()
    const outcome = await bot.awaitRestartingBot(UUID, Date.now() + 5000)
    expect(outcome).to.equal('ready')
    expect(Date.now() - started).to.be.lessThan(2000)
  })

  it('gives up at the deadline instead of waiting for the bot', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const started = Date.now()
    const outcome = await bot.awaitRestartingBot(UUID, Date.now() + 400)
    expect(outcome).to.equal('expired')
    expect(Date.now() - started).to.be.within(350, 1500)
  })

  it('refuses a stale signal without touching any bot', async () => {
    const { bot } = harness()
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      receivedAt: Date.now() - WEBHOOK_SIGNAL_MAX_AGE_MS - 4000,
    })
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.match(/"addFunds" was not executed/)
    expect(bot.warnings.join('\n')).to.match(/dropped, not executed/)
  })

  it('refuses a signal whose bot is not back within the budget', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      // 300ms of budget left.
      receivedAt: Date.now() - WEBHOOK_SIGNAL_MAX_AGE_MS + 300,
    })
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.equal(
      'Bot is restarting on our side, so "addFunds" was not executed.',
    )
  })

  it('holds non-webhook commands until the listener arms', async () => {
    const { bot } = harness()
    const ran: string[] = []
    bot.someCommand = async () => ran.push('cmd')
    bot.webhookProcess = async () => ran.push('webhook')
    const cmd = bot.processInternalApiCall({ method: 'someCommand', params: [] })
    await bot.processInternalApiCall({ method: 'webhookProcess', params: [] })
    await new Promise((r) => setImmediate(r))
    expect(ran).to.deep.equal(['webhook'])
    bot.commandListenerArmed = true
    bot.commandsArmedWaiters.splice(0).forEach((w: () => void) => w())
    await cmd
    expect(ran).to.deep.equal(['webhook', 'cmd'])
  })
})
