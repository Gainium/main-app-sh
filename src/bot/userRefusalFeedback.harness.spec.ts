process.env.NODE_ENV = 'testing'

/**
 * A user-initiated action the engine refuses, drops or fails is answered with
 * a bot message instead of only a log line.
 *
 * Each case drives the REAL engine method over a minimal base, so the exit
 * under test is the one production takes:
 *
 *  1. a crash inside start() / stop() (DCA and grid);
 *  2. start() stopping the bot because the exchange returned no trading rules;
 *  3. a manual "+ New deal" refused (balance, deal limit, unreadable balance)
 *     is answered on EVERY click, not once per day;
 *  4. a close request on a deal in `error`;
 *  5. a webhook signal the bot's settings ignore (semantics unchanged);
 *  6. a user action routed to a worker that does not hold the bot;
 *  7. a manual entry into a single position while another is in flight;
 *  8. a stop that closes deals says so before the slow part starts.
 *
 * Plus the helper itself: one shown row and one emit per call, no grouping,
 * never an error status, silent under `ignoreErrors`.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import sinon from 'sinon'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import {
  BotStatusEnum,
  BotType,
  CloseConditionEnum,
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  MessageTypeEnum,
  StartConditionEnum,
  StatusEnum,
} from '../../types'
import { userActionRefused, webhookSignalIgnored } from './utils'
import {
  botNotLoadedMessage,
  closeRefusedForStatusMessage,
  exchangeInfoMissingStopMessage,
  manualNewDealMaxDealsMessage,
  startFailedMessage,
  stopFailedMessage,
  stoppingNoticeMessage,
} from './userNotice'
import {
  reportBotNotLoaded,
  userInitiatedBotMethods,
} from './worker/botNotLoadedNotice'

const BOT_ID = '000000000000000000000901'
const USER_ID = '000000000000000000000902'
const PARENT_ID = '000000000000000000000903'
const DEAL_ID = '000000000000000000000904'
const PAIR = 'ALT-USDT'

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'ALT', minAmount: 0.01, step: 0.01 },
  quoteAsset: { name: 'USDT', minAmount: 1 },
  maxOrders: 200,
}

type Seen = {
  refusals: { reason: string; symbol?: string; type?: string }[]
  ignored: string[]
  errors: string[]
  closes: string[]
  order: string[]
  placedBase: number
}

/** Base for the helper mixins: records what the engine tells the user. */
const makeBase = (seen: Seen) =>
  class FakeBase {
    math = new MathHelper()
    botId = BOT_ID
    userId = USER_ID
    botType = BotType.dca
    loadingComplete = true
    isLong = true
    futures = false
    coinm = false
    combo = false
    hedge = false
    exchange: any = {}
    orders = new Map()
    standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
    ignoreErrors = false
    shouldProceed() {
      return true
    }
    async reportUserRefusal(reason: string, symbol?: string, type?: string) {
      if (this.ignoreErrors) {
        return
      }
      seen.order.push('notice')
      seen.refusals.push({ reason, symbol, type })
    }
    async reportIgnoredWebhookSignal(reason: string) {
      seen.ignored.push(reason)
    }
    constructor(..._a: any[]) {}
  }

const newSeen = (): Seen => ({
  refusals: [],
  ignored: [],
  errors: [],
  closes: [],
  order: [],
  placedBase: 0,
})

const loadModule = createRequire(__filename)
let createDca: (base: any) => any
let createGrid: (base: any) => any

/** A DCA bot on the real helper, with the I/O around the method stubbed. */
const dcaBot = (
  seen: Seen,
  o: {
    status?: BotStatusEnum
    settings?: Record<string, unknown>
    balance?: { status: boolean; unknown?: boolean }
    maxDeals?: boolean
  } = {},
) => {
  const Helper = createDca(makeBase(seen))
  class TestBot extends Helper {
    data: any = {
      settings: {
        type: 'regular',
        name: 'Test bot',
        pair: [PAIR],
        startCondition: StartConditionEnum.asap,
        useTp: true,
        dealCloseCondition: CloseConditionEnum.tp,
        ...(o.settings ?? {}),
      },
      status: o.status ?? BotStatusEnum.open,
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'uuid-901',
      profit: { total: 0 },
      flags: [],
      paperContext: false,
      workingShift: [{ start: 1 }],
    }
    pairs = new Set([PAIR])
    openNewDealTimer = new Map()
    botEventDb = { createData: async (d: any) => ({ status: 'OK', data: d }) }
    async checkBalanceGate() {
      return {
        status: o.balance?.status ?? true,
        unknown: o.balance?.unknown,
        required: 257.78,
        available: 85.69,
        price: 0.35,
      }
    }
    async reduceToAvailableRatio() {
      return { ratio: null }
    }
    async getAggregatedSettings() {
      return { ...this.data.settings }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async refuseNewDealNearDelivery() {
      return false
    }
    async checkMaxDeals() {
      return o.maxDeals ?? true
    }
    async checkInRange() {
      return true
    }
    async refuseDealBelowExchangeMin() {
      return false
    }
    async getLatestPrice() {
      return 0.35
    }
    async checkCooldownStart() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async checkCooldownStop() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async approveNewDeal() {
      return true
    }
    resetPending() {}
    updateDealLastTime() {}
    releaseReduceToAvailableClaim() {}
    async placeBaseOrder() {
      seen.placedBase++
    }
    getOpenDeals(..._a: any[]): any[] {
      return []
    }
    handleErrors(m: string) {
      seen.errors.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
    handleLog(m: string) {
      return m
    }
    handleWarn(m: string) {
      return m
    }
    handleDebug(m: string) {
      return m
    }
  }
  return new TestBot() as any
}

describe('user-initiated actions are answered, not only logged', () => {
  let clock: sinon.SinonFakeTimers | undefined

  before(function () {
    // One ts-node compile of the DCA and grid helpers over a 10k-line base.
    this.timeout(240000)
    createDca = loadModule('./dcaHelper').default
    createGrid = loadModule('./helper').default
  })

  afterEach(() => {
    clock?.restore()
    clock = undefined
  })

  describe('MainBot.reportUserRefusal', () => {
    const harness = (data: any = {}) => {
      const rows: any[] = []
      const emits: any[] = []
      const events: any[] = []
      const touched: string[] = []
      const bot: any = Object.create((MainBot as any).prototype)
      bot.botId = BOT_ID
      bot.userId = USER_ID
      bot.botType = BotType.dca
      bot.ignoreErrors = false
      bot.data = {
        status: BotStatusEnum.open,
        exchange: ExchangeEnum.binance,
        paperContext: false,
        settings: { name: 'Test bot', type: 'regular' },
        ...data,
      }
      bot.handleWarn = () => undefined
      bot.pushLogs = () => undefined
      bot.botEventDb = { createData: (e: any) => events.push(e) }
      bot.messagesDb = {
        createData: async (r: any) => {
          rows.push(r)
          return { status: StatusEnum.ok, data: { _id: `row-${rows.length}` } }
        },
        updateData: async () => {
          touched.push('messagesDb.updateData')
          return { status: StatusEnum.ok, data: null }
        },
      }
      bot.emit = (event: string, payload: any) => emits.push({ event, payload })
      bot.updateData = () => touched.push('updateData')
      bot.setRangeOrError = () => touched.push('setRangeOrError')
      return { bot, rows, emits, events, touched }
    }

    it('writes one shown row and one emit per call — a second click is answered too', async () => {
      const { bot, rows, emits, events, touched } = harness()
      await bot.reportUserRefusal('Not enough balance to start new deal', PAIR)
      await bot.reportUserRefusal('Not enough balance to start new deal', PAIR)
      expect(rows).to.have.length(2)
      for (const r of rows) {
        expect(r).to.include({
          userId: USER_ID,
          botId: BOT_ID,
          subType: userActionRefused,
          type: MessageTypeEnum.warning,
          showUser: true,
          isDeleted: false,
          symbol: PAIR,
        })
        expect(r).to.not.have.property('bucket')
      }
      expect(emits.map((e) => e.event)).to.deep.equal([
        'bot message',
        'bot message',
      ])
      expect(emits.map((e) => e.payload._id)).to.deep.equal(['row-1', 'row-2'])
      expect(events).to.have.length(2)
      expect(
        touched,
        'never an error status, never a coalesced row',
      ).to.deep.equal([])
    })

    it('files a hedge leg under its parent', async () => {
      const { bot, rows } = harness({ parentBotId: PARENT_ID })
      await bot.reportUserRefusal('x')
      expect(rows[0]).to.include({
        botId: PARENT_ID,
        botType: BotType.hedgeDca,
      })
    })

    it('stays silent while errors are ignored (delete / reset teardown)', async () => {
      const { bot, rows, emits } = harness()
      bot.ignoreErrors = true
      await bot.reportUserRefusal('x')
      expect(rows).to.have.length(0)
      expect(emits).to.have.length(0)
    })

    it('reportIgnoredWebhookSignal keeps the ordinary backoff and never errors the bot', async () => {
      const { bot } = harness()
      const calls: any[] = []
      bot.processError = async (...a: any[]) => calls.push(a)
      bot.handleLog = () => undefined
      await bot.reportIgnoredWebhookSignal('ignored', PAIR)
      expect(calls).to.have.length(1)
      const [, subType, , setError, sendError, , , , force, symbol] = calls[0]
      expect({ subType, setError, sendError, force, symbol }).to.deep.equal({
        subType: webhookSignalIgnored,
        setError: false,
        sendError: true,
        force: false,
        symbol: PAIR,
      })
    })
  })

  describe('1. a crash inside start() / stop()', () => {
    const startHarness = (seen: Seen, serviceRestart: boolean) => {
      const bot = dcaBot(seen)
      bot.db = null
      bot.serviceRestart = serviceRestart
      bot.clearClassProperties = () => undefined
      bot.loadData = async () => {
        bot.data = undefined
        return false
      }
      bot.setClassProperties = async () => {
        throw new Error('boom')
      }
      return bot
    }

    it('DCA: a user start that crashes is reported', async () => {
      const seen = newSeen()
      await startHarness(seen, false).start()
      expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
        startFailedMessage('boom'),
      ])
    })

    it('DCA: a service restart that crashes stays quiet', async () => {
      const seen = newSeen()
      await startHarness(seen, true).start()
      expect(seen.refusals).to.have.length(0)
    })

    const stopHarness = (seen: Seen) => {
      const bot = dcaBot(seen)
      bot.getOpenDeals = () => [
        { deal: { _id: DEAL_ID, status: DCADealStatusEnum.open } },
      ]
      bot.clearDealTimer = async () => {
        throw new Error('venue down')
      }
      return bot
    }

    it('DCA: a stop that crashes is reported', async () => {
      const seen = newSeen()
      await stopHarness(seen).stop(CloseDCATypeEnum.closeByMarket)
      expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
        stopFailedMessage('venue down'),
      ])
    })

    it('DCA: a stop with errors ignored (delete / reset) stays quiet', async () => {
      const seen = newSeen()
      await stopHarness(seen).stop(CloseDCATypeEnum.closeByMarket, false, true)
      expect(seen.refusals).to.have.length(0)
    })

    const gridStart = (seen: Seen, serviceRestart: boolean) => {
      const Grid = createGrid(makeBase(seen))
      const bot: any = new Grid()
      bot.botType = BotType.grid
      bot.serviceRestart = serviceRestart
      bot.startMethod = () => '1'
      bot.endMethod = () => undefined
      bot.clearClassProperties = () => undefined
      bot.handleErrors = (m: string) => seen.errors.push(m)
      bot.handleLog = () => undefined
      bot.loadData = async () => false
      bot.data = { status: BotStatusEnum.closed, settings: { pair: PAIR } }
      bot.startPriceTimer = () => {
        throw new Error('boom')
      }
      return bot
    }

    it('grid: a user start that crashes is reported', async () => {
      const seen = newSeen()
      await gridStart(seen, false).start()
      expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
        startFailedMessage('boom'),
      ])
    })

    it('grid: a service restart that crashes stays quiet', async () => {
      const seen = newSeen()
      await gridStart(seen, true).start()
      expect(seen.refusals).to.have.length(0)
    })
  })

  describe('2. start() stops the bot for missing exchange info', () => {
    it('DCA: the user is told why the bot stopped', async () => {
      const seen = newSeen()
      const bot = dcaBot(seen)
      let stopped = 0
      bot.db = null
      bot.clearClassProperties = () => undefined
      bot.loadData = async () => false
      bot.data = undefined
      bot.setClassProperties = async () => undefined
      bot.fillExchangeInfo = async () => {
        bot.data = {
          status: BotStatusEnum.open,
          settings: { pair: [PAIR] },
          workingShift: [],
        }
        bot.pairsNotFound = new Set([PAIR])
      }
      bot.getUserFees = async () => undefined
      bot.loadOrders = async () => undefined
      bot.checkAllowedMethods = async () => undefined
      bot.checkSettingsPairs = async () => undefined
      bot.updateData = async () => undefined
      bot.emit = () => undefined
      bot.stop = async () => {
        stopped++
      }
      await bot.start()
      expect(stopped).to.equal(1)
      expect(bot.data.status).to.equal(BotStatusEnum.closed)
      expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
        exchangeInfoMissingStopMessage([PAIR]),
      ])
    })

    it('grid: the user is told why the bot stopped', async () => {
      const seen = newSeen()
      const Grid = createGrid(makeBase(seen))
      const bot: any = new Grid()
      let stopped = 0
      bot.botType = BotType.grid
      bot.serviceRestart = false
      bot.startMethod = () => '1'
      bot.endMethod = () => undefined
      bot.clearClassProperties = () => undefined
      bot.handleErrors = (m: string) => seen.errors.push(m)
      bot.handleLog = () => undefined
      bot.handleWarn = () => undefined
      bot.loadData = async () => false
      bot.data = {
        status: BotStatusEnum.closed,
        haveStarted: true,
        settings: { pair: PAIR },
        workingShift: [],
      }
      bot.startPriceTimer = () => undefined
      bot.startConsumerHeartbeat = () => undefined
      bot.checkPriceToStart = async () => true
      bot.fillExchangeInfo = async () => {
        bot.pairsNotFound = new Set([PAIR])
      }
      bot.loadOrders = async () => undefined
      bot.getUserFees = async () => undefined
      bot.generateGrids = async () => undefined
      bot.avgPrice = () => undefined
      bot.cancelAllOrder = async () => undefined
      bot.updateData = async () => undefined
      bot.emit = () => undefined
      bot.stop = async () => {
        stopped++
      }
      await bot.start()
      expect(stopped).to.equal(1)
      expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
        exchangeInfoMissingStopMessage([PAIR]),
      ])
    })
  })

  describe('3. a manual "+ New deal" is answered on every click', () => {
    const fake = () => {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      return clock
    }
    const open = async (bot: any, trigger?: string) => {
      const c = clock as sinon.SinonFakeTimers
      const p = bot.openNewDeal(
        BOT_ID,
        PAIR,
        trigger === 'manual',
        false,
        0,
        undefined,
        trigger,
      )
      await c.tickAsync(5_000)
      await p
    }

    it('not enough balance: two clicks, two answers', async () => {
      fake()
      const seen = newSeen()
      const bot = dcaBot(seen, { balance: { status: false } })
      await open(bot, 'manual')
      await open(bot, 'manual')
      expect(seen.refusals).to.have.length(2)
      for (const r of seen.refusals) {
        expect(r.reason).to.match(/^Not enough balance to start new deal/)
        expect(r.symbol).to.equal(PAIR)
      }
      expect(seen.errors, 'not routed through the grouped path').to.have.length(
        0,
      )
      expect(seen.placedBase).to.equal(0)
    })

    it('an automatic refusal keeps its latched, grouped report', async () => {
      fake()
      const seen = newSeen()
      const bot = dcaBot(seen, { balance: { status: false } })
      await open(bot)
      await open(bot)
      expect(seen.refusals).to.have.length(0)
      expect(seen.errors).to.have.length(1)
    })

    it('the deal limit is answered on every click', async () => {
      fake()
      const seen = newSeen()
      const bot = dcaBot(seen, { maxDeals: false })
      await open(bot, 'manual')
      await open(bot, 'manual')
      expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
        manualNewDealMaxDealsMessage(PAIR),
        manualNewDealMaxDealsMessage(PAIR),
      ])
    })

    it('an unreadable balance is answered instead of dropped', async () => {
      fake()
      const seen = newSeen()
      const bot = dcaBot(seen, { balance: { status: false, unknown: true } })
      await open(bot, 'manual')
      expect(seen.refusals).to.have.length(1)
      expect(seen.refusals[0].reason).to.contain('could not be read')
    })

    it('a stopped bot answers every click', async () => {
      const seen = newSeen()
      const bot = dcaBot(seen, { status: BotStatusEnum.closed })
      await bot.openNewDealMan()
      await bot.openNewDealMan()
      expect(seen.refusals).to.have.length(2)
    })
  })

  describe('4. a close request on a deal in error', () => {
    const closeHarness = (seen: Seen) => {
      const bot = dcaBot(seen)
      const deal = {
        _id: DEAL_ID,
        status: DCADealStatusEnum.error,
        symbol: { symbol: PAIR },
        profit: { total: 0, totalUsd: 0 },
      }
      bot.clearDealTimer = async () => undefined
      bot.getDeal = () => ({ deal })
      bot.processDealClose = async () => {
        seen.closes.push('processDealClose')
        return false
      }
      bot.saveDeal = () => undefined
      bot.profitBase = async () => false
      return { bot, deal }
    }

    for (const trigger of [
      DCACloseTriggerEnum.manual,
      DCACloseTriggerEnum.api,
    ]) {
      it(`answers a ${trigger} close by market`, async () => {
        const seen = newSeen()
        const { bot } = closeHarness(seen)
        await bot.closeDealById(
          BOT_ID,
          DEAL_ID,
          CloseDCATypeEnum.closeByMarket,
          ...Array(7).fill(undefined),
          trigger,
        )
        expect(seen.refusals.map((r) => r.reason)).to.deep.equal([
          closeRefusedForStatusMessage(DEAL_ID, PAIR, DCADealStatusEnum.error),
        ])
      })
    }

    it('stays quiet for the engine closing its own deal', async () => {
      const seen = newSeen()
      const { bot } = closeHarness(seen)
      await bot.closeDealById(
        BOT_ID,
        DEAL_ID,
        CloseDCATypeEnum.closeByMarket,
        ...Array(7).fill(undefined),
        DCACloseTriggerEnum.bot,
      )
      expect(seen.refusals).to.have.length(0)
    })

    it('a Cancel still cancels the deal and reports nothing', async () => {
      const seen = newSeen()
      const { bot, deal } = closeHarness(seen)
      await bot.closeDealById(
        BOT_ID,
        DEAL_ID,
        CloseDCATypeEnum.cancel,
        ...Array(7).fill(undefined),
        DCACloseTriggerEnum.manual,
      )
      expect(deal.status).to.equal(DCADealStatusEnum.canceled)
      expect(seen.closes).to.deep.equal(['processDealClose'])
      expect(seen.refusals).to.have.length(0)
    })
  })

  describe('5. webhook signals the settings ignore', () => {
    it('a close signal on a bot that does not close by webhook is still ignored, and said so', async () => {
      const seen = newSeen()
      const bot = dcaBot(seen)
      let closed = 0
      bot.closeAllDeals = () => {
        closed++
      }
      await bot.closeDealBySignal(PAIR)
      expect(closed).to.equal(0)
      expect(seen.ignored).to.have.length(1)
      expect(seen.ignored[0]).to.contain('close condition is not Webhook')
    })

    it('a close signal on a webhook-closing bot closes and reports nothing', async () => {
      const seen = newSeen()
      const bot = dcaBot(seen, {
        settings: { dealCloseCondition: CloseConditionEnum.webhook },
      })
      let closed = 0
      bot.closeAllDeals = () => {
        closed++
      }
      bot.convertSymbol = async () => PAIR
      await bot.closeDealBySignal(PAIR)
      expect(closed).to.equal(1)
      expect(seen.ignored).to.have.length(0)
    })

    it('a start signal on a bot that does not start by webhook is still ignored, and said so', async () => {
      const seen = newSeen()
      const bot = dcaBot(seen)
      let opened = 0
      bot.getSymbolsToOpenAsapDeals = async () => [PAIR]
      bot.openNewDeal = async () => {
        opened++
      }
      await bot.openDealBySignal(BOT_ID)
      expect(opened).to.equal(0)
      expect(seen.ignored).to.have.length(1)
    })

    it('a start-bot signal on a bot in error is still ignored, and said so', async () => {
      const seen = newSeen()
      const bot = dcaBot(seen, { status: BotStatusEnum.error })
      let started = 0
      bot.start = async () => {
        started++
      }
      const res = await bot.setStatus(
        BOT_ID,
        BotStatusEnum.open,
        undefined,
        true,
      )
      expect(res).to.equal(false)
      expect(started).to.equal(0)
      expect(seen.ignored).to.have.length(1)
      expect(seen.ignored[0]).to.contain('the bot is in error')
    })
  })

  describe('6. a user action routed to a worker that does not hold the bot', () => {
    const deps = (bot: any) => {
      const rows: any[] = []
      const published: { channel: string; msg: any }[] = []
      return {
        rows,
        published,
        deps: {
          readBot: async () => bot,
          createMessage: async (r: any) => {
            rows.push(r)
            return { status: StatusEnum.ok, data: { _id: 'row-1' } }
          },
          publish: async (channel: string, msg: string) =>
            published.push({ channel, msg: JSON.parse(msg) }),
        },
      }
    }

    it('writes and publishes a bot message on the user feed', async () => {
      const d = deps({
        userId: USER_ID,
        exchange: ExchangeEnum.binance,
        settings: { name: 'Test bot' },
      })
      await reportBotNotLoaded(BOT_ID, BotType.dca, d.deps)
      expect(d.rows).to.have.length(1)
      expect(d.rows[0]).to.include({
        userId: USER_ID,
        botId: BOT_ID,
        message: botNotLoadedMessage,
        showUser: true,
      })
      expect(d.published).to.have.length(1)
      expect(d.published[0].channel).to.equal(`liveupdate${USER_ID}`)
      expect(d.published[0].msg.event).to.equal('bot sends message')
      expect(d.published[0].msg.data.data._id).to.equal('row-1')
    })

    it('writes nothing for a bot it cannot find', async () => {
      const d = deps(null)
      await reportBotNotLoaded(BOT_ID, BotType.dca, d.deps)
      expect(d.rows).to.have.length(0)
      expect(d.published).to.have.length(0)
    })

    it('covers the dashboard actions, not internal dispatches', () => {
      for (const m of ['setStatus', 'closeDealById', 'openNewDealMan']) {
        expect(userInitiatedBotMethods.has(m), m).to.equal(true)
      }
      for (const m of ['getStats', 'reloadBot', 'openDealBySignal']) {
        expect(userInitiatedBotMethods.has(m), m).to.equal(false)
      }
    })
  })

  describe('7. a manual entry into a single position', () => {
    const singleBot = (seen: Seen) => {
      const bot = dcaBot(seen, { settings: { singlePosition: true } })
      const position = {
        deal: {
          _id: DEAL_ID,
          status: DCADealStatusEnum.open,
          createTime: 1,
          symbol: { symbol: PAIR },
        },
      }
      bot.getOpenDeals = () => [position]
      bot.positionEntryInFlight = () => true
      return bot
    }

    it('an entry in flight answers a manual click', async () => {
      const seen = newSeen()
      await singleBot(seen).openNewDeal(
        BOT_ID,
        PAIR,
        true,
        false,
        0,
        undefined,
        'manual',
      )
      expect(seen.refusals).to.have.length(1)
      expect(seen.refusals[0].reason).to.contain('previous entry')
    })

    it('an entry in flight skips a start signal quietly, as before', async () => {
      const seen = newSeen()
      await singleBot(seen).openNewDeal(
        BOT_ID,
        PAIR,
        false,
        false,
        0,
        undefined,
        'webhook',
      )
      expect(seen.refusals).to.have.length(0)
    })

    it('a second signal while one is being handled answers a manual click', async () => {
      const seen = newSeen()
      const bot = singleBot(seen)
      bot.singlePositionBusy = new Set([PAIR])
      await bot.openNewDeal(BOT_ID, PAIR, true, false, 0, undefined, 'manual')
      expect(seen.refusals).to.have.length(1)
      expect(seen.refusals[0].reason).to.contain('being processed')
    })
  })

  describe('8. a stop that closes deals says so first', () => {
    const stopBot = (seen: Seen, deals: number) => {
      const bot = dcaBot(seen)
      const open = Array.from({ length: deals }, (_, i) => ({
        deal: { _id: `deal-${i}`, status: DCADealStatusEnum.open },
      }))
      let calls = 0
      bot.getOpenDeals = () => (calls++ === 0 ? open : [])
      bot.clearDealTimer = async () => undefined
      bot.closeDealById = async (_b: string, id: string) => {
        seen.order.push('close')
        seen.closes.push(id)
      }
      bot.updateData = async () => undefined
      bot.emit = () => undefined
      bot.afterBotStop = async () => undefined
      bot.trimWorkingShift = (w: unknown) => w
      bot.getWorkingTimeNumber = () => 0
      return bot
    }

    it('announces the closes before the first one runs', async () => {
      const seen = newSeen()
      await stopBot(seen, 2).stop(CloseDCATypeEnum.closeByMarket)
      expect(seen.refusals).to.deep.equal([
        {
          reason: stoppingNoticeMessage(2),
          symbol: undefined,
          type: MessageTypeEnum.info,
        },
      ])
      expect(seen.order).to.deep.equal(['notice', 'close', 'close'])
    })

    it('says nothing when the stop leaves deals open', async () => {
      const seen = newSeen()
      await stopBot(seen, 2).stop(CloseDCATypeEnum.leave)
      expect(seen.refusals).to.have.length(0)
    })
  })
})
