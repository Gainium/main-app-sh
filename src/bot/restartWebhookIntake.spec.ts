process.env.NODE_ENV = 'testing'

/**
 * Restart-time webhook intake: a signal runs within WEBHOOK_SIGNAL_MAX_AGE_MS
 * of reaching the API or is dropped with the reason, on every path (waiting
 * for a re-loading bot, taken late from a queue, replayed); a replay goes to
 * its own bot type's queue and runs at most once; the restart resumes the bots
 * a signal is likely to need first and spreads them over its worker threads.
 *
 * The real methods are driven off the prototype with fake state: no Mongo, no
 * worker threads, no rabbit. Fixture ids are synthetic — this file is public.
 *
 * Run: `cd core && npm test`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import Bot, { webhookIntakeQueue, webhookReplayQueue } from './index'
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
  it('is one minute', () => {
    expect(WEBHOOK_SIGNAL_MAX_AGE_MS).to.equal(60_000)
  })
  it('measures age from the API stamp, never negative', () => {
    expect(webhookSignalAgeMs(now - 2500, now)).to.equal(2500)
    expect(webhookSignalAgeMs(now + 500, now)).to.equal(0)
    expect(webhookSignalAgeMs(undefined, now)).to.equal(0)
  })
  it('expires only a stamped signal past the cap', () => {
    expect(webhookSignalExpired(now - 60_000, now)).to.equal(false)
    expect(webhookSignalExpired(now - 60_001, now)).to.equal(true)
    // From an API that predates the stamp: the old behaviour.
    expect(webhookSignalExpired(undefined, now)).to.equal(false)
  })
  it('puts the deadline at the stamp plus the cap, or intake when unstamped', () => {
    expect(webhookSignalDeadline(now - 3000, now)).to.equal(now + 57_000)
    expect(webhookSignalDeadline(undefined, now)).to.equal(now + 60_000)
    // A stamp from a clock ahead of ours cannot extend the budget.
    expect(webhookSignalDeadline(now + 60_000, now)).to.equal(now + 60_000)
  })
  it('names the action, the age and the cap', () => {
    expect(webhookSignalExpiredReason('addFunds', 74_200)).to.equal(
      'Bot is restarting on our side, so "addFunds" was not executed. The signal arrived 74s ago; signals that cannot run within 60s are dropped, not executed late.',
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

  it('drops a signal older than the cap without touching any bot', async () => {
    const { bot } = harness()
    bot.dcaBots = [{ id: BOT_ID, uuid: UUID, worker: 1 }]
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      receivedAt: Date.now() - 61_000,
    })
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.match(
      /"addFunds" was not executed\. The signal arrived 61s ago/,
    )
  })

  it('drops a replayed signal older than the cap too', async () => {
    const { bot } = harness()
    const res = await bot.singleWebhookProcess({
      action: 'startDeal',
      uuid: UUID,
      replayed: true,
      receivedAt: Date.now() - 90_000,
    })
    expect(res.reason).to.match(/arrived 90s ago/)
  })

  it('refuses a signal whose bot is not back by the deadline', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const started = Date.now()
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      // 400ms of budget left: the wait counts from the API stamp.
      receivedAt: Date.now() - WEBHOOK_SIGNAL_MAX_AGE_MS + 400,
    })
    expect(Date.now() - started).to.be.within(300, 1500)
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.equal(
      'Bot is restarting on our side, so "addFunds" was not executed.',
    )
  })

  it('does not give a second signal queued behind the first a fresh wait', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const receivedAt = Date.now() - WEBHOOK_SIGNAL_MAX_AGE_MS + 600
    const sig = () => ({ action: 'startDeal', uuid: UUID, receivedAt })
    const started = Date.now()
    const [a, b] = await Promise.all([
      bot.webhookProcess(sig()),
      bot.webhookProcess(sig()),
    ])
    expect(a.status).to.equal(StatusEnum.notok)
    expect(b.status).to.equal(StatusEnum.notok)
    expect(Date.now() - started).to.be.lessThan(1500)
  })

  it('lets a replayed signal wait for its re-loading bot inside the cap', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    setTimeout(() => bot.restartFinishedIds.add(BOT_ID), 300)
    const res = await bot.singleWebhookProcess({
      action: 'startDeal',
      uuid: UUID,
      replayed: true,
      receivedAt: Date.now() - 30_000,
    })
    // Back in time: it went past the wait to the normal path (no bot in this
    // harness answers "not running"), neither dropped nor refused on the wait.
    expect(res?.reason ?? '').to.not.match(/arrived/)
    expect(bot.warnings.join('\n')).to.not.match(/still re-loading|dropped/)
  })
})

describe('a signal runs at most once', () => {
  it('skips a copy whose signal id already ran', async () => {
    const { bot } = harness()
    const claimed = new Set<string>()
    bot.claimWebhookSignal = async (id: string) =>
      claimed.has(id) ? false : (claimed.add(id), true)
    const sig = {
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      signalId: 'sig-1',
    }
    const first = await bot.singleWebhookProcess({ ...sig })
    const copy = await bot.singleWebhookProcess({ ...sig, replayed: true })
    expect(first.reason ?? '').to.not.match(/already executed/)
    expect(copy.status).to.equal(StatusEnum.notok)
    expect(copy.reason).to.equal('This "addFunds" signal was already executed.')
  })
  it('stamps a fresh id on every item at the API, over the sender value', async () => {
    const { bot } = harness()
    bot.useBots = false
    bot.webhookBotType = async () => undefined
    bot.entityNotFound = () => ({ status: StatusEnum.notok })
    const items = [
      { action: 'startDeal', uuid: 'a', signalId: 'mine', replayed: true },
      { action: 'startDeal', uuid: 'b' },
    ] as any[]
    await bot.webhookProcess(items)
    expect(items[0].signalId).to.be.a('string').and.not.equal('mine')
    expect(items[0].signalId).to.not.equal(items[1].signalId)
    expect(items[0].replayed).to.equal(undefined)
  })
})

describe('webhook queues', () => {
  const rabbitHarness = (consumers: number, intakeExists?: string) => {
    const { bot } = harness()
    const sent: { queue: string; payload: any }[] = []
    const rpc: { queue: string; payload: any }[] = []
    const ensured: string[] = []
    bot.intakeConsumerCache = new Map()
    bot.rabbit = {
      queueInfo: async (q: string) =>
        q === intakeExists || consumers
          ? { consumerCount: q === intakeExists ? 0 : consumers }
          : null,
      ensureQueue: async (q: string) => ensured.push(q),
      send: (queue: string, payload: any) => sent.push({ queue, payload }),
      sendWithCallback: async (queue: string, payload: any) => {
        rpc.push({ queue, payload })
        return { response: { status: StatusEnum.ok } }
      },
    }
    return { bot, sent, rpc, ensured }
  }

  it('gives every bot type its own replay and intake queue', () => {
    const types = ['dca', 'combo', 'hedgeCombo', 'hedgeDca'] as any[]
    expect(new Set(types.map(webhookReplayQueue)).size).to.equal(4)
    expect(new Set(types.map(webhookIntakeQueue)).size).to.equal(4)
    expect(types.map(webhookReplayQueue)).to.not.include('webhookQueue')
  })

  it('sends a signal to the intake queue while it has a consumer', async () => {
    const { bot, rpc } = rabbitHarness(1)
    await bot.sendWebhookToService(
      'dca',
      [{ action: 'startDeal', uuid: 'u' }],
      false,
    )
    expect(rpc.map((r) => r.queue)).to.deep.equal([
      webhookIntakeQueue('dca' as any),
    ])
  })

  it('falls back to the command queue when nobody consumes the intake', async () => {
    const { bot, rpc } = rabbitHarness(0)
    await bot.sendWebhookToService(
      'combo',
      [{ action: 'startDeal', uuid: 'u' }],
      false,
    )
    expect(rpc.map((r) => r.queue)).to.deep.equal(['comboQueue'])
  })

  it('uses the intake queue while its service is down, once the intake exists', async () => {
    const { bot, rpc } = rabbitHarness(0, webhookIntakeQueue('dca' as any))
    await bot.sendWebhookToService(
      'dca',
      [{ action: 'startDeal', uuid: 'u' }],
      false,
    )
    expect(rpc.map((r) => r.queue)).to.deep.equal([
      webhookIntakeQueue('dca' as any),
    ])
  })

  it('drops instead of replaying a signal already past the cap', async () => {
    const { bot, sent } = rabbitHarness(1)
    bot.useBots = false
    bot.webhookBotType = async () => 'dca'
    const realNow = Date.now
    bot.sendWebhookToService = async () => {
      const t = realNow()
      Date.now = () => t + 90_000
      throw new Error('Bots service is unavailable, please try again later')
    }
    try {
      const res = await bot.webhookProcess({ action: 'addFunds', uuid: 'd' })
      expect(res.status).to.equal(StatusEnum.notok)
      expect(res.reason).to.match(/runs only if it can start within 60s/)
      expect(sent).to.have.length(0)
    } finally {
      Date.now = realNow
    }
  })

  it('replays each type on its own queue when its service runs this version', async () => {
    const { bot, sent, ensured } = rabbitHarness(1)
    bot.useBots = false
    const types: Record<string, string> = { d: 'dca', c: 'combo' }
    bot.webhookBotType = async (uuid: string) => types[uuid]
    bot.sendWebhookToService = async (type: string) => {
      if (type === 'dca')
        throw new Error('Bots service is unavailable, please try again later')
      return { status: StatusEnum.ok }
    }
    const res = await bot.webhookProcess([
      { action: 'startDeal', uuid: 'd' },
      { action: 'startDeal', uuid: 'c' },
    ])
    // As before: queued for replay, no refusal reply.
    expect(res).to.equal(undefined)
    expect(sent.map((x) => x.queue)).to.deep.equal([
      webhookReplayQueue('dca' as any),
      webhookReplayQueue('combo' as any),
    ])
    expect(ensured).to.deep.equal(sent.map((x) => x.queue))
    expect(sent[0].payload.uuid).to.equal('d')
    expect(sent[0].payload.signalId).to.be.a('string')
  })

  it('replays on the legacy queue when no current-version service consumes', async () => {
    const { bot, sent } = rabbitHarness(0)
    bot.useBots = false
    bot.webhookBotType = async () => 'dca'
    bot.sendWebhookToService = async () => {
      throw new Error('Bots service is unavailable, please try again later')
    }
    await bot.webhookProcess({ action: 'startDeal', uuid: 'd' })
    expect(sent.map((x) => x.queue)).to.deep.equal(['webhookQueue'])
  })

  it('routes a stamped legacy replay to its type and drops an unstamped copy', async () => {
    const { bot, sent } = rabbitHarness(1)
    const types: Record<string, string> = { d: 'dca', c: 'combo' }
    bot.webhookBotType = async (uuid: string) => types[uuid]
    const handled: any[] = []
    bot.webhookProcess = async (data: any) => handled.push(data)
    await bot.routeLegacyReplay([
      { action: 'startDeal', uuid: 'd', signalId: 's1' },
      { action: 'startDeal', uuid: 'c', signalId: 's2' },
      { action: 'addFunds', uuid: 'c' },
      { action: 'startDeal', uuid: 'nobody', signalId: 's3' },
    ])
    expect(sent.map((x) => [x.queue, x.payload.uuid])).to.deep.equal([
      [webhookReplayQueue('dca' as any), 'd'],
      [webhookReplayQueue('combo' as any), 'c'],
    ])
    expect(handled).to.have.length(0)
  })
})

describe('restart spread over worker threads', () => {
  const w = (id: number, bots: number, userId?: string) => ({
    id,
    bots,
    type: 'dca',
    userId,
  })
  const spreadHarness = () => {
    const { bot } = harness()
    bot.personalLimits = new Map([['vip', 2000]])
    Object.defineProperty(bot, 'botPerWorker', {
      value: {
        dca: 100,
        combo: 100,
        grid: 100,
        hedgeCombo: 100,
        hedgeDca: 100,
      },
    })
    return bot
  }
  it('opens the threads the restart needs, then fills the emptiest', () => {
    const bot = spreadHarness()
    bot.beginRestartSpread('dca', [
      ...Array.from({ length: 250 }, () => ({ userId: 'u' })),
      ...Array.from({ length: 500 }, () => ({ userId: 'vip' })),
    ])
    expect(bot.restartSpreadWorkers).to.equal(3)
    bot.workers = [w(1, 40), w(2, 10)]
    expect(bot.pickWorkerForNewBot('dca', 100, false)).to.equal(undefined)
    bot.workers.push(w(3, 20))
    expect(bot.pickWorkerForNewBot('dca', 100, false).id).to.equal(2)
    // A personal-limit user's worker is never part of the spread.
    bot.workers.push(w(9, 5, 'vip'))
    expect(bot.pickWorkerForNewBot('dca', 2000, false, 'vip').id).to.equal(9)
  })
  it('packs fullest-first once the restart dispatch is over', () => {
    const bot = spreadHarness()
    bot.endRestartSpread()
    bot.workers = [w(1, 40), w(2, 10), w(3, 100)]
    expect(bot.pickWorkerForNewBot('dca', 100, false).id).to.equal(1)
  })
})
