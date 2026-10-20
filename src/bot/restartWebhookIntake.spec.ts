process.env.NODE_ENV = 'testing'

/**
 * Restart-time webhook intake: a signal for a bot that is still re-loading
 * waits for it at most WEBHOOK_SIGNAL_MAX_AGE_MS and is then refused with the
 * reason; a replayed signal runs as it always did, on its own bot type's
 * queue; the restart resumes the bots a signal is likely to need first and
 * spreads them over its worker threads.
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
} from '../server/tradeSignalContract'
import { restartResumeOrder, restartResumeTier } from './restartResumeOrder'
import {
  BotStartTypeEnum,
  CloseConditionEnum,
  StartConditionEnum,
  StatusEnum,
} from '../../types'

describe('webhook wait cap', () => {
  const now = 1_800_000_000_000
  it('is a small named constant', () => {
    expect(WEBHOOK_SIGNAL_MAX_AGE_MS).to.be.at.most(10_000)
  })
  it('measures age from the API stamp for logs, never negative', () => {
    expect(webhookSignalAgeMs(now - 2500, now)).to.equal(2500)
    expect(webhookSignalAgeMs(now + 500, now)).to.equal(0)
    expect(webhookSignalAgeMs(undefined, now)).to.equal(0)
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

  it('does not refuse an old signal when its bot is running', async () => {
    const { bot } = harness()
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      receivedAt: Date.now() - 10 * 60_000,
    })
    // No bot holds the uuid in this harness: the old answer, not an age refusal.
    expect(res.reason).to.not.match(/arrived|dropped/)
    expect(bot.warnings.join('\n')).to.not.match(/dropped/)
  })

  it('refuses a signal whose bot is not back within the wait', async function () {
    this.timeout(WEBHOOK_SIGNAL_MAX_AGE_MS + 5000)
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const started = Date.now()
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      // An old stamp does not shorten the wait: it is measured from intake.
      receivedAt: Date.now() - 60_000,
    })
    expect(Date.now() - started).to.be.at.least(WEBHOOK_SIGNAL_MAX_AGE_MS - 50)
    expect(res.status).to.equal(StatusEnum.notok)
    expect(res.reason).to.equal(
      'Bot is restarting on our side, so "addFunds" was not executed.',
    )
  })

  it('does not give a second signal queued behind the first a fresh wait', async function () {
    this.timeout(WEBHOOK_SIGNAL_MAX_AGE_MS + 8000)
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const sig = () => ({ action: 'startDeal', uuid: UUID, symbol: 'XRPUSDT' })
    const started = Date.now()
    const [a, b] = await Promise.all([
      bot.webhookProcess(sig()),
      bot.webhookProcess(sig()),
    ])
    const took = Date.now() - started
    expect(a.status).to.equal(StatusEnum.notok)
    expect(b.status).to.equal(StatusEnum.notok)
    expect(took).to.be.lessThan(WEBHOOK_SIGNAL_MAX_AGE_MS + 1500)
  })

  it('does not wait or refuse a replayed signal', async () => {
    const { bot } = harness()
    openWindow(bot, [{ id: BOT_ID, uuid: UUID }])
    const started = Date.now()
    const res = await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      replayed: true,
      receivedAt: Date.now() - 60_000,
    })
    expect(Date.now() - started).to.be.lessThan(500)
    // Straight to the pre-existing not-running answer: no wait, no wait refusal.
    expect(res.reason).to.equal(
      'Bot is restarting on our side, so "addFunds" was not executed.',
    )
    expect(bot.warnings.join('\n')).to.not.match(/still re-loading/)
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
  const rabbitHarness = (consumers: number) => {
    const { bot } = harness()
    const sent: { queue: string; payload: any }[] = []
    const rpc: { queue: string; payload: any }[] = []
    const ensured: string[] = []
    bot.intakeConsumerCache = new Map()
    bot.rabbit = {
      consumerCount: async () => consumers,
      ensureQueue: async (q: string) => ensured.push(q),
      send: (queue: string, payload: any) => sent.push({ queue, payload }),
      sendWithCallback: async (queue: string, payload: any) => {
        rpc.push({ queue, payload })
        return { response: { status: StatusEnum.ok } }
      },
    }
    bot.callExternalBotService = async (type: string, method: string) => {
      rpc.push({ queue: `command:${type}`, payload: { method } })
      return { status: StatusEnum.ok }
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
    expect(rpc.map((r) => r.queue)).to.deep.equal(['command:combo'])
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
