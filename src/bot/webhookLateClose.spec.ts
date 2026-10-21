process.env.NODE_ENV = 'testing'

/**
 * Close signals may run later than other signals, but only against deals that
 * were already open when they arrived; every signal that is not executed, or
 * a close that ran late, is reported to the bot's owner.
 *
 * Driven off the prototypes with fake state: no Mongo, no workers, no rabbit.
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import Bot from './index'
import {
  WEBHOOK_CLOSE_SIGNAL_MAX_AGE_MS,
  WEBHOOK_SIGNAL_MAX_AGE_MS,
  formatSignalCap,
  lateCloseNoticeReason,
  webhookCloseOpenedBefore,
  webhookSignalExpiredReason,
  webhookSignalMaxAgeMs,
} from '../server/tradeSignalContract'
import {
  CloseConditionEnum,
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  ExchangeEnum,
  StatusEnum,
} from '../../types'
import { MathHelper } from '../utils/math'

describe('per-action signal caps', () => {
  it('gives close signals a longer cap than every other action', () => {
    expect(WEBHOOK_CLOSE_SIGNAL_MAX_AGE_MS).to.equal(15 * 60_000)
    for (const a of ['closeDeal', 'closeDealSl']) {
      expect(webhookSignalMaxAgeMs(a)).to.equal(WEBHOOK_CLOSE_SIGNAL_MAX_AGE_MS)
    }
    for (const a of [
      'startDeal',
      'addFunds',
      'reduceFunds',
      'stopBot',
      'startBot',
      'changePairs',
      undefined,
    ]) {
      expect(webhookSignalMaxAgeMs(a)).to.equal(WEBHOOK_SIGNAL_MAX_AGE_MS)
    }
  })
  it('writes caps the way a user reads them', () => {
    expect(formatSignalCap(60_000)).to.equal('60s')
    expect(formatSignalCap(15 * 60_000)).to.equal('15 min')
    expect(webhookSignalExpiredReason('closeDeal', 1_000_000)).to.match(
      /within 15 min are dropped/,
    )
    expect(webhookSignalExpiredReason('addFunds', 70_000)).to.match(
      /within 60s are dropped/,
    )
  })
  it('restricts a close to older deals only once it is past the ordinary cap', () => {
    const t = 1_800_000_000_000
    expect(webhookCloseOpenedBefore(t - 30_000, t)).to.equal(undefined)
    expect(webhookCloseOpenedBefore(t - 60_000, t)).to.equal(undefined)
    expect(webhookCloseOpenedBefore(t - 90_000, t)).to.equal(t - 90_000)
    expect(webhookCloseOpenedBefore(undefined, t)).to.equal(undefined)
  })
  it('tells the user when the close arrived and that newer deals were spared', () => {
    const t = Date.UTC(2026, 9, 21, 14, 2, 5)
    expect(lateCloseNoticeReason('closeDeal', t, t + 125_000)).to.equal(
      '"closeDeal" received at 14:02:05 UTC ran 125s later, because the bot was not ready when it arrived. It acted only on deals that were already open at 14:02:05 UTC.',
    )
  })
})

const UUID = 'uuid-late-1'
const BOT_ID = 'bot-late-1'

const orchestrator = (status?: string) => {
  const bot: any = Object.create((Bot as any).prototype)
  const notices: any[] = []
  const posted: any[] = []
  bot.useBots = true
  bot.dcaBots = []
  bot.comboBots = []
  bot.hedgeComboBots = []
  bot.hedgeDcaBots = []
  bot.restartWindowOpen = false
  bot.restartBotIdByUuid = new Map()
  bot.restartFinishedIds = new Set()
  bot.handleWarn = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.onWebhookSignalNotice = async (n: any) => {
    notices.push(n)
  }
  bot.claimWebhookSignal = async () => true
  const db = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: status ? { status } : null },
    }),
  }
  bot.dcaBotDb = db
  bot.comboBotDb = db
  bot.botEventDb = { createData: async () => undefined }
  bot.running = () => {
    bot.dcaBots = [
      { id: BOT_ID, uuid: UUID, worker: 1, type: 'dca', userId: 'u' },
    ]
    bot.getWorkerById = () => ({ postMessage: (m: any) => posted.push(m) })
  }
  return { bot, notices, posted }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('late close signals', () => {
  it('runs a close past 60s, against deals opened before it arrived', async () => {
    const { bot, notices, posted } = orchestrator('open')
    bot.running()
    const receivedAt = Date.now() - 2 * 60_000
    await bot.singleWebhookProcess({
      action: 'closeDeal',
      uuid: UUID,
      receivedAt,
    })
    await flush()
    expect(posted).to.have.length(1)
    expect(posted[0].method).to.equal('closeDealBySignal')
    expect(posted[0].args[3]).to.equal(receivedAt)
    expect(notices.map((n) => n.kind)).to.deep.equal(['lateClose'])
  })
  it('runs an on-time close with no deal restriction and no notice', async () => {
    const { bot, notices, posted } = orchestrator('open')
    bot.running()
    await bot.singleWebhookProcess({
      action: 'closeDeal',
      uuid: UUID,
      receivedAt: Date.now() - 5_000,
    })
    await flush()
    expect(posted[0].args[3]).to.equal(undefined)
    expect(notices).to.have.length(0)
  })
  it('still drops a close past its own cap, and says so', async () => {
    const { bot, notices, posted } = orchestrator('open')
    bot.running()
    const res = await bot.singleWebhookProcess({
      action: 'closeDeal',
      uuid: UUID,
      receivedAt: Date.now() - WEBHOOK_CLOSE_SIGNAL_MAX_AGE_MS - 1_000,
    })
    await flush()
    expect(res.status).to.equal(StatusEnum.notok)
    expect(posted).to.have.length(0)
    expect(notices.map((n) => n.kind)).to.deep.equal(['expired'])
  })
  it('keeps the 60s cap for an addFunds', async () => {
    const { bot, notices, posted } = orchestrator('open')
    bot.running()
    await bot.singleWebhookProcess({
      action: 'addFunds',
      uuid: UUID,
      qty: '10',
      asset: 'quote',
      receivedAt: Date.now() - 2 * 60_000,
    })
    await flush()
    expect(posted).to.have.length(0)
    expect(notices.map((n) => n.kind)).to.deep.equal(['expired'])
  })
})

describe('notices for signals that did not run', () => {
  it('tells the owner of a stopped bot', async () => {
    const { bot, notices } = orchestrator('closed')
    const res = await bot.singleWebhookProcess({
      action: 'startDeal',
      uuid: UUID,
      receivedAt: Date.now(),
    })
    await flush()
    expect(res.reason).to.match(/^Bot is stopped/)
    expect(notices).to.have.length(1)
    expect(notices[0]).to.include({
      uuid: UUID,
      action: 'startDeal',
      kind: 'refused',
    })
    expect(notices[0].reason).to.equal(res.reason)
  })
  it('tells no one about a uuid no bot holds', async () => {
    const { bot, notices } = orchestrator(undefined)
    await bot.singleWebhookProcess({
      action: 'startDeal',
      uuid: 'nobody',
      receivedAt: Date.now(),
    })
    await flush()
    expect(notices).to.have.length(0)
  })
  it('never lets a failing notice change the reply', async () => {
    const { bot } = orchestrator('closed')
    bot.onWebhookSignalNotice = async () => {
      throw new Error('alert service down')
    }
    const res = await bot.singleWebhookProcess({
      action: 'startDeal',
      uuid: UUID,
      receivedAt: Date.now(),
    })
    await flush()
    expect(res.reason).to.match(/^Bot is stopped/)
  })
})

class FakeBase {
  math = new MathHelper()
  botId = 'bot-late-engine'
  userId = 'user-late-engine'
  botType = 'dca'
  loadingComplete = true
  isLong = true
  futures = false
  combo = false
  hedge = false
  exchange: any = {}
  orders = new Map()
  data: any = {
    settings: { type: 'regular', pair: ['ETH-USDC'] },
    status: 'open',
    exchange: ExchangeEnum.binance,
    paperContext: true,
  }
  shouldProceed() {
    return true
  }
  handleLog() {}
  handleDebug() {}
  constructor(..._a: any[]) {}
}

describe('closeAllDeals for a late close', () => {
  let DcaHelper: any
  before(function () {
    this.timeout(180000)
    DcaHelper = createRequire(__filename)('./dcaHelper').default(
      FakeBase as any,
    )
  })
  const build = () => {
    const closed: string[] = []
    const deals = [
      {
        deal: { _id: 'old', createTime: 1_000, symbol: { symbol: 'ETH-USDC' } },
      },
      {
        deal: { _id: 'new', createTime: 5_000, symbol: { symbol: 'ETH-USDC' } },
      },
    ]
    class TestBot extends DcaHelper {
      getOpenDeals() {
        return deals
      }
      getDeal(id: string) {
        return deals.find((d) => d.deal._id === id)
      }
      async getAggregatedSettings() {
        return { useTp: true, dealCloseCondition: CloseConditionEnum.webhook }
      }
      async checkMinTp() {
        return true
      }
      requestDealCloseApproval() {
        return true
      }
      async closeDealById(_b: string, id: string) {
        closed.push(id)
      }
    }
    return { bot: new TestBot(), closed }
  }
  const close = (bot: any, openedBefore?: number) =>
    bot.closeAllDeals(
      CloseDCATypeEnum.closeByMarket,
      'ETH-USDC',
      true,
      true,
      false,
      false,
      undefined,
      DCACloseTriggerEnum.webhook,
      openedBefore,
    )
  it('closes only the deals created before the signal arrived', async () => {
    const { bot, closed } = build()
    await close(bot, 3_000)
    expect(closed).to.deep.equal(['old'])
  })
  it('closes every deal when the close is on time', async () => {
    const { bot, closed } = build()
    await close(bot)
    expect(closed).to.deep.equal(['old', 'new'])
  })
})
