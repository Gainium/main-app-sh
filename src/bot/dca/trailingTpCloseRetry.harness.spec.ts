process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `050.a-rejected-trailing-take-profit-is-never-retried`.
 *
 * Drives the REAL engine methods — `handleTrailingCloseRefusal`,
 * `retryTrailingClose`, `resumeTrailingCloseRetry`, `checkDealsStopLoss`,
 * `checkTrailing`, `clearTrailingRetryTimers` — over a minimal base class, so
 * a broken wiring shows up as a missing `closeDealById` call or a missing
 * persisted field rather than as a stubbed assertion. Nothing here places,
 * cancels or saves anything.
 *
 * The defect: a trailing take profit fires on a deal that is in profit, the
 * venue refuses the market close for a reason of its own (the reported case is
 * Kraken's `EGeneral:Temporary lockout`), and the engine makes exactly one
 * attempt — there is no retry, the "a close is in flight" flag it leaves
 * behind is in-memory only, and the user is never told the profitable exit was
 * missed (spec §1.2, §2.1).
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MathHelper } from '../../utils/math'
import {
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  CloseConditionEnum,
  ExchangeEnum,
  TrailingModeEnum,
} from '../../../types'
import { TRAILING_TP_RETRY_DELAYS_MS } from './trailingCloseRetry'

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b03'
const DEAL_ID = '000000000000000000000d03'
const SYMBOL = 'LAB-EUR'

/** The reporter's numbers (spec 049 §2.1), still in profit at the refusal. */
const AVG = 86.84381886931739
const ARMED_LEVEL = 89.63038
const TAKER = 0.0026
/** The fee-adjusted take-profit price `checkTrailing` arms `ttp` on. */
const ARMING_LINE = AVG * (1 + 0.008 + TAKER * 2)

const LOCKOUT = 'EGeneral:Temporary lockout'

const SETTINGS: Record<string, unknown> = {
  useSl: false,
  trailingSl: false,
  slPerc: '-10',
  useTp: true,
  trailingTp: true,
  trailingTpPerc: '0.200',
  tpPerc: '0.800',
  dealCloseCondition: CloseConditionEnum.tp,
  dealCloseConditionSL: CloseConditionEnum.tp,
  useMultiTp: false,
  multiTp: [],
  useMultiSl: false,
  multiSl: [],
  useMinTP: false,
  moveSL: false,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u03'
  isLong = true
  futures = false
  coinm = false
  combo = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    status: 'open',
    exchange: ExchangeEnum.kraken,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type DealOverrides = {
  status?: DCADealStatusEnum
  trailingMode?: TrailingModeEnum
  trailingLevel?: number
  trailingClose?: Record<string, unknown>
  avgPrice?: number
}

const makeDeal = (o: DealOverrides = {}): any => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'LAB', quoteAsset: 'EUR' },
  status: o.status ?? DCADealStatusEnum.open,
  trailingMode: 'trailingMode' in o ? o.trailingMode : TrailingModeEnum.ttp,
  trailingLevel: o.trailingLevel ?? ARMED_LEVEL,
  trailingClose: o.trailingClose,
  bestPrice: 89.81,
  avgPrice: o.avgPrice ?? AVG,
  initialPrice: AVG,
  lastPrice: ARMED_LEVEL,
  size: 10,
  settings: {},
  tpSlTargetFilled: [],
})

/**
 * A bot whose every outward call is captured. Built on the real helper, so the
 * methods under test are the shipped ones.
 */
const makeBot = (deal: any, price = ARMED_LEVEL, opts: any = {}) => {
  class TestBot extends Helper {
    public closes: any[][] = []
    public saved: Record<string, unknown>[] = []
    public logs: string[] = []
    public events: any[] = []
    public reported: any[] = []
    public disarmed = 0
    public registered = 0
    allowedMethods = new Set(['checkDealsStopLoss', 'checkTrailing'])
    dealsForStopLoss = new Map([[DEAL_ID, deal.trailingLevel]])
    dealsForTrailing = new Map([
      [
        DEAL_ID,
        {
          trailingTp: true,
          skipTp: false,
          trailingSl: false,
          skipSl: true,
          trailingTpPrice: opts.armingLine ?? ARMING_LINE,
        },
      ],
    ])
    full: any = { deal, closeBySl: opts.closeBySl ?? false, notCheckSl: false }

    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    getLastStreamData() {
      return { price: opts.price ?? price }
    }
    async getAggregatedSettings() {
      return SETTINGS
    }
    async getUserFee() {
      return { maker: TAKER, taker: TAKER }
    }
    async getTrailingSettings() {
      return {
        trailingTp: true,
        skipTp: false,
        trailingSl: false,
        skipSl: true,
        trailingTpPrice: opts.armingLine ?? ARMING_LINE,
      }
    }
    async closeDealById(...args: any[]) {
      this.closes.push(args)
    }
    /**
     * Models the REAL `saveDeal`, copy-on-write and all: it replaces both the
     * wrapper and the deal in the map with copies built from the wrapper it
     * was handed and the deal currently in the map. A caller that saves and
     * then keeps writing to its old object therefore loses those writes — a
     * live hazard in this engine, so the harness reproduces it rather than
     * mutating one shared object and hiding it.
     */
    async saveDeal(d: any, fields?: Record<string, unknown>) {
      if (!fields) {
        return
      }
      this.saved.push(fields)
      this.full = { ...d, deal: { ...this.full.deal, ...fields } }
    }
    async setDealForStopLoss() {
      this.registered++
    }
    async triggerTrailing() {}
    /** Real `disarmTrailing` is exercised by spec 049; count it here. */
    async disarmTrailing(d: any) {
      this.disarmed++
      d.deal.trailingLevel = 0
      d.deal.trailingMode = undefined
      d.deal.bestPrice = 0
      await this.saveDeal(d, {
        trailingLevel: 0,
        trailingMode: undefined,
        bestPrice: 0,
      })
    }
    shouldProceed() {
      return opts.shouldProceed ?? true
    }
    async processError(...args: any[]) {
      this.reported.push(args)
    }
    botEventDb = {
      createData: (e: any) => {
        this.events.push(e)
        return Promise.resolve({ status: 'OK' })
      },
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn(m: string) {
      this.logs.push(`WARN ${m}`)
    }
    handleErrors(m: string) {
      this.logs.push(`ERROR ${m}`)
    }
  }
  return new TestBot() as any
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Bots built in a test that may still hold a pending timer. */
const live: any[] = []
const track = (bot: any) => {
  live.push(bot)
  return bot
}

describe('trailing take profit close retry (spec 050)', () => {
  before(function () {
    // One ts-node compile of a 23k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  afterEach(() => {
    // Every scheduled retry is a real `setTimeout` holding the bot; drop them
    // so the suite cannot be kept alive (and §6.10 is exercised on the way).
    while (live.length) {
      live.pop()?.clearTrailingRetryTimers()
    }
  })

  describe('§6.1 a venue refusal schedules a retry instead of giving up', () => {
    it('takes ownership of the refusal and keeps the trail armed', async () => {
      const deal = makeDeal()
      const bot = track(makeBot(deal))
      const owned = await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      expect(owned, 'the caller must not fall through to 049s disarm').to.be
        .true
      expect(bot.disarmed, 'the level is still the exit we want').to.equal(0)
      expect(bot.full.deal.trailingMode).to.equal(TrailingModeEnum.ttp)
      expect(bot.full.deal.trailingLevel).to.equal(ARMED_LEVEL)
    })

    it('§6.2 persists the retry state on the deal document', async () => {
      const deal = makeDeal()
      const bot = track(makeBot(deal))
      const before = +new Date()
      await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      const written = bot.saved.find((f: any) => 'trailingClose' in f) as any
      expect(
        written,
        'an in-memory-only retry dies with the worker',
      ).to.not.equal(undefined)
      const state = written.trailingClose
      expect(state.status).to.equal('retrying')
      expect(state.attempts).to.equal(1)
      expect(state.reason).to.equal(LOCKOUT)
      expect(state.nextAttempt).to.be.at.least(
        before + TRAILING_TP_RETRY_DELAYS_MS[0],
      )
    })

    it('arms exactly one timer for the deal', async () => {
      const deal = makeDeal()
      const bot = track(makeBot(deal))
      await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      expect(bot.trailingRetryTimers.size).to.equal(1)
      expect(bot.trailingRetryTimers.has(DEAL_ID)).to.be.true
      // A second refusal replaces the timer rather than stacking one.
      await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      expect(bot.trailingRetryTimers.size).to.equal(1)
    })

    it('§6.5 a balance refusal is not retried and clears an open sequence', async () => {
      const deal = makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 2,
          since: 1,
          lastAttempt: 2,
          nextAttempt: 3,
          reason: LOCKOUT,
        },
      })
      const bot = track(makeBot(deal))
      bot.full.closeBySl = true
      const owned = await bot.handleTrailingCloseRefusal(
        bot.full,
        'EOrder:Insufficient funds',
        DCACloseTriggerEnum.trailing,
      )
      expect(owned, 'the caller keeps 049s disarm for this one').to.be.false
      expect(bot.full.deal.trailingClose, 'the sequence is over').to.equal(
        undefined,
      )
      expect(bot.trailingRetryTimers.size).to.equal(0)
      expect(bot.full.closeBySl, 'the deal is managed again').to.be.false
    })

    it('a trailing STOP LOSS refusal is not our business', async () => {
      // Only the take-profit trail is retried: a stop loss is a loss-taking
      // instrument, and spec §1.1 scopes this to securing a profit.
      const deal = makeDeal({ trailingMode: TrailingModeEnum.tsl })
      const bot = track(makeBot(deal))
      const owned = await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      expect(owned).to.be.false
      expect(bot.trailingRetryTimers.size).to.equal(0)
    })

    it('a non-trailing close refusal is not our business', async () => {
      const deal = makeDeal()
      const bot = track(makeBot(deal))
      const owned = await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.manual,
      )
      expect(owned).to.be.false
      expect(bot.trailingRetryTimers.size).to.equal(0)
    })
  })

  describe('§6.3 nothing else closes the deal while a retry is outstanding', () => {
    const retrying = {
      status: 'retrying',
      attempts: 1,
      since: 1,
      lastAttempt: 2,
      nextAttempt: +new Date() + 30_000,
      reason: LOCKOUT,
    }

    it('checkDealsStopLoss does not fire a second close', async () => {
      // The live tick is below the armed level — without the persisted state
      // this is a close. `closeBySl` is false, as it is after a restart.
      const deal = makeDeal({ trailingClose: { ...retrying } })
      const bot = track(makeBot(deal, ARMED_LEVEL - 1))
      await bot.checkDealsStopLoss(BOT_ID, SYMBOL)
      expect(bot.closes.length, 'a retry is already in flight').to.equal(0)
    })

    it('checkTrailing does not touch the armed level', async () => {
      const deal = makeDeal({ trailingClose: { ...retrying } })
      const bot = track(makeBot(deal, ARMED_LEVEL + 10))
      await bot.checkTrailing(BOT_ID, SYMBOL)
      expect(bot.full.deal.trailingLevel).to.equal(ARMED_LEVEL)
      expect(bot.full.deal.bestPrice).to.equal(89.81)
      expect(bot.saved.length).to.equal(0)
    })

    it('§6.11 a stale record no longer blocks the close paths', async () => {
      // Nothing ever acted on this record. It must not leave the deal
      // unmanaged for good — that is the defect spec 049 §6.1 named in
      // `closeBySl`, and it must not be reintroduced in a durable field.
      const deal = makeDeal({
        trailingClose: {
          ...retrying,
          nextAttempt: +new Date() - 3 * 24 * 60 * 60 * 1000,
        },
      })
      const bot = track(makeBot(deal, ARMED_LEVEL))
      await bot.checkDealsStopLoss(BOT_ID, SYMBOL)
      expect(bot.closes.length).to.equal(1)
    })

    it('§6.9 the same tick still closes a deal with no retry outstanding', async () => {
      // The guard must be the state, not the method.
      const deal = makeDeal()
      const bot = track(makeBot(deal, ARMED_LEVEL - 1))
      await bot.checkDealsStopLoss(BOT_ID, SYMBOL)
      expect(bot.closes.length).to.equal(1)
    })
  })

  describe('§6.2 a retry survives a worker restart', () => {
    it('re-arms the timer from the persisted deadline', async () => {
      const deal = makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 1,
          since: 1,
          lastAttempt: 2,
          nextAttempt: +new Date() + 30_000,
          reason: LOCKOUT,
        },
      })
      const bot = track(makeBot(deal))
      await bot.resumeTrailingCloseRetry(bot.full)
      expect(bot.trailingRetryTimers.has(DEAL_ID)).to.be.true
      expect(
        bot.full.closeBySl,
        'the close is still in flight across the restart',
      ).to.be.true
    })

    it('a deadline already in the past retries immediately', async () => {
      const deal = makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 1,
          since: 1,
          lastAttempt: 2,
          // Three days of downtime, exactly the spec-049 restart story.
          nextAttempt: +new Date() - 3 * 24 * 60 * 60 * 1000,
          reason: LOCKOUT,
        },
      })
      const bot = track(makeBot(deal))
      await bot.resumeTrailingCloseRetry(bot.full)
      await sleep(20)
      expect(bot.closes.length, 'the retry actually ran').to.equal(1)
      const args = bot.closes[0]
      expect(args[1]).to.equal(DEAL_ID)
      expect(
        args[10],
        'the close keeps its trailing identity, so 042s label holds',
      ).to.equal(DCACloseTriggerEnum.trailing)
    })

    it('§6.7 a retry is abandoned when the price fell below break even', async () => {
      // Four minutes later the market has moved. Spec 049 forbids this close;
      // the retry must not smuggle it past that floor.
      const deal = makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 3,
          since: 1,
          lastAttempt: 2,
          nextAttempt: +new Date() - 1000,
          reason: LOCKOUT,
        },
      })
      const bot = track(makeBot(deal, 85.44))
      await bot.resumeTrailingCloseRetry(bot.full)
      await sleep(20)
      expect(bot.closes.length, 'no close below break even').to.equal(0)
      expect(bot.disarmed, 'the stale trail is dropped, as in 049').to.equal(1)
      expect(bot.full.deal.trailingClose).to.equal(undefined)
      expect(bot.full.closeBySl).to.be.false
      expect(
        bot.events.length,
        'this is 049s ordinary outcome, not a failure',
      ).to.equal(0)
    })

    it('§6.7 a retry is abandoned when the deal is no longer open', async () => {
      // A previous attempt that did reach the venue closes the deal; the retry
      // must not send a second market order onto a flat position.
      const deal = makeDeal({
        status: DCADealStatusEnum.closed,
        trailingClose: {
          status: 'retrying',
          attempts: 2,
          since: 1,
          lastAttempt: 2,
          nextAttempt: +new Date() - 1000,
          reason: LOCKOUT,
        },
      })
      const bot = track(makeBot(deal))
      await bot.resumeTrailingCloseRetry(bot.full)
      await sleep(20)
      expect(bot.closes.length).to.equal(0)
      expect(bot.full.deal.trailingClose).to.equal(undefined)
    })

    it('a paused record schedules nothing on restart', async () => {
      const deal = makeDeal({
        trailingMode: undefined,
        trailingLevel: 0,
        trailingClose: {
          status: 'paused',
          attempts: 6,
          since: 1,
          lastAttempt: 2,
          reason: LOCKOUT,
          rearmReady: false,
        },
      })
      const bot = track(makeBot(deal))
      await bot.resumeTrailingCloseRetry(bot.full)
      expect(bot.trailingRetryTimers.size).to.equal(0)
      expect(bot.full.closeBySl).to.be.false
    })

    it('a stopped bot does not retry', async () => {
      const deal = makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 1,
          since: 1,
          lastAttempt: 2,
          nextAttempt: +new Date() - 1000,
          reason: LOCKOUT,
        },
      })
      const bot = track(makeBot(deal, ARMED_LEVEL, { shouldProceed: false }))
      await bot.resumeTrailingCloseRetry(bot.full)
      await sleep(20)
      expect(bot.closes.length).to.equal(0)
    })
  })

  describe('§6.6 after the last retry the trail pauses and the user is told', () => {
    /** A state one refusal short of exhaustion. */
    const lastChance = {
      status: 'retrying',
      attempts: TRAILING_TP_RETRY_DELAYS_MS.length,
      since: 1,
      lastAttempt: 2,
      nextAttempt: 3,
      reason: LOCKOUT,
    }

    const exhaust = async () => {
      const deal = makeDeal({ trailingClose: { ...lastChance } })
      const bot = track(makeBot(deal))
      bot.full.closeBySl = true
      const owned = await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      return { deal, bot, owned }
    }

    it('records the pause and disarms the level', async () => {
      const { bot, owned } = await exhaust()
      expect(owned).to.be.true
      expect(bot.full.deal.trailingClose.status).to.equal('paused')
      expect(bot.full.deal.trailingClose.attempts).to.equal(
        TRAILING_TP_RETRY_DELAYS_MS.length + 1,
      )
      expect(bot.full.deal.trailingClose.nextAttempt).to.equal(undefined)
      // The whole point of 049: an armed level must not outlive the attempt.
      expect(bot.disarmed).to.equal(1)
      expect(bot.full.deal.trailingMode).to.equal(undefined)
      expect(bot.full.deal.trailingLevel).to.equal(0)
      expect(bot.trailingRetryTimers.size).to.equal(0)
    })

    it('releases the deal so everything else manages it again', async () => {
      const { bot } = await exhaust()
      expect(bot.full.closeBySl).to.be.false
      expect(bot.full.notCheckSl).to.be.false
      expect(
        bot.registered,
        'whatever the deal still qualifies for is re-registered',
      ).to.be.greaterThan(0)
    })

    it('writes a bot event and raises a bot message', async () => {
      const { bot } = await exhaust()
      expect(bot.events.length, 'the event feed is where users look').to.equal(
        1,
      )
      const event = bot.events[0]
      expect(event.deal).to.equal(DEAL_ID)
      expect(event.symbol).to.equal(SYMBOL)
      expect(event.description.toLowerCase()).to.contain('trailing take profit')
      expect(bot.reported.length, 'and the notification bell').to.equal(1)
      const message = bot.reported[0][5] as string
      expect(message).to.contain(DEAL_ID)
      expect(message).to.contain(LOCKOUT)
    })
  })

  describe('§6.8 a paused trail re-arms only on a real crossing', () => {
    const paused = (rearmReady = false) => ({
      status: 'paused',
      attempts: 6,
      since: 1,
      lastAttempt: 2,
      reason: LOCKOUT,
      rearmReady,
    })

    it('does not arm while price is still above the arming line', async () => {
      const deal = makeDeal({
        trailingMode: undefined,
        trailingLevel: 0,
        trailingClose: paused(),
      })
      const bot = track(makeBot(deal, ARMING_LINE + 1))
      await bot.checkTrailing(BOT_ID, SYMBOL)
      expect(
        bot.full.deal.trailingMode,
        'another five retries would start here',
      ).to.equal(undefined)
      expect(bot.full.deal.trailingClose.status).to.equal('paused')
      expect(bot.full.deal.trailingClose.rearmReady).to.equal(false)
    })

    it('earns the re-arm on a tick below the line, and persists that', async () => {
      const deal = makeDeal({
        trailingMode: undefined,
        trailingLevel: 0,
        trailingClose: paused(),
      })
      const bot = track(makeBot(deal, ARMING_LINE - 1))
      await bot.checkTrailing(BOT_ID, SYMBOL)
      expect(bot.full.deal.trailingMode).to.equal(undefined)
      expect(bot.full.deal.trailingClose.rearmReady).to.equal(true)
      const written = bot.saved.find((f: any) => 'trailingClose' in f) as any
      expect(
        written,
        'a restart must not forget the earned crossing',
      ).to.not.equal(undefined)
      expect(written.trailingClose.rearmReady).to.equal(true)
    })

    it('§5.3 the tick that crosses back arms and clears the record', async () => {
      const deal = makeDeal({
        trailingMode: undefined,
        trailingLevel: 0,
        trailingClose: paused(true),
      })
      const bot = track(makeBot(deal, ARMING_LINE + 1))
      await bot.checkTrailing(BOT_ID, SYMBOL)
      expect(bot.full.deal.trailingMode).to.equal(TrailingModeEnum.ttp)
      expect(
        bot.full.deal.trailingClose,
        'a full re-arm: the next close gets its own budget of five retries',
      ).to.equal(undefined)
      // And the re-armed trail has a LEVEL. Clearing the record mid-loop
      // would have replaced the deal in the map with a copy taken before the
      // level was computed, arming the trail at 0 — a trail that then neither
      // closes nor recomputes until price beats the old extreme.
      expect(
        bot.full.deal.trailingLevel,
        'the re-armed trail must carry the level computed on this tick',
      ).to.be.greaterThan(0)
    })

    it('§6.9 a paused take-profit trail does not block a trailing stop loss', async () => {
      // `tsl` is armed by its own branch, which the pause must not reach.
      const deal = makeDeal({
        trailingMode: undefined,
        trailingLevel: 0,
        trailingClose: paused(),
      })
      const bot = track(
        makeBot(deal, ARMING_LINE + 1, { armingLine: ARMING_LINE }),
      )
      bot.dealsForTrailing = new Map([
        [
          DEAL_ID,
          {
            trailingTp: true,
            skipTp: false,
            trailingSl: true,
            skipSl: false,
            trailingTpPrice: ARMING_LINE,
          },
        ],
      ])
      await bot.checkTrailing(BOT_ID, SYMBOL)
      expect(bot.full.deal.trailingMode).to.equal(TrailingModeEnum.tsl)
    })
  })

  describe('§6.10 nothing outlives the bot', () => {
    it('clearTrailingRetryTimers drops every pending retry', async () => {
      const deal = makeDeal()
      const bot = makeBot(deal)
      await bot.handleTrailingCloseRefusal(
        bot.full,
        LOCKOUT,
        DCACloseTriggerEnum.trailing,
      )
      expect(bot.trailingRetryTimers.size).to.equal(1)
      bot.clearTrailingRetryTimers()
      expect(bot.trailingRetryTimers.size).to.equal(0)
    })

    it('a finished deal drops its timer too', () => {
      // Wiring pin: `processDealClose` needs the whole close path to reach.
      // Scoped to it rather than to `removeDealFromStopLossMethods`, which
      // the settings-change path also calls for an open, mid-retry deal.
      const src = readFileSync(join(__dirname, '..', 'dcaHelper.ts'), 'utf8')
      const marker = src.indexOf('async processDealClose(')
      expect(marker).to.be.greaterThan(-1)
      expect(src.slice(marker, marker + 1200)).to.contain(
        'clearTrailingRetryTimer',
      )
    })

    it('the bot-stop teardown calls it', () => {
      // Wiring pin: a retry timer left armed holds the helper — and everything
      // it closes over — for up to a minute after the bot is gone, and fires a
      // close against a stopped bot. `clearClassProperties` is the single
      // teardown every stop path goes through.
      const src = readFileSync(join(__dirname, '..', 'dcaHelper.ts'), 'utf8')
      // The DEFINITION, not one of its call sites.
      const marker = src.indexOf('clearClassProperties(clearRedis = false')
      expect(marker, 'the teardown still exists').to.be.greaterThan(-1)
      expect(src.slice(marker, marker + 6000)).to.contain(
        'clearTrailingRetryTimers',
      )
    })

    it('the close-rejection branch hands the refusal to the retry', () => {
      // The same wiring pin spec 049 uses for this branch: reaching it for
      // real needs a built close order and a live venue call.
      const src = readFileSync(join(__dirname, '..', 'dcaHelper.ts'), 'utf8')
      const marker = src.indexOf('Send new order request ${tpOrder.')
      expect(
        marker,
        'the close-rejection branch still exists',
      ).to.be.greaterThan(-1)
      const branch = src.slice(marker, marker + 2000)
      expect(branch).to.contain('handleTrailingCloseRefusal')
      // 049s disarm must still be what happens when the retry declines.
      expect(branch).to.contain('disarmTrailing')
    })

    it('restoreWork resumes a persisted retry', () => {
      const src = readFileSync(join(__dirname, '..', 'dcaHelper.ts'), 'utf8')
      const marker = src.indexOf('await this.setCloseByTimer(d.deal)')
      expect(
        marker,
        'the per-deal restore step still exists',
      ).to.be.greaterThan(-1)
      expect(src.slice(marker - 500, marker + 500)).to.contain(
        'resumeTrailingCloseRetry',
      )
    })

    it('§6.13 combo is left out of this entirely', () => {
      // Combo is built on the DCA mixin but has no trailing at all: its
      // `checkDealsForStopLossMethods` override never calls
      // `checkDealsForTrailing`, so `dealsForTrailing` is always empty and no
      // trail can arm — which means no refused trailing close, and nothing to
      // resume in its own `restoreWork` override.
      const src = readFileSync(join(__dirname, '..', 'comboHelper.ts'), 'utf8')
      expect(src).to.not.contain('resumeTrailingCloseRetry')
      expect(
        src,
        'if combo ever grows a trail, this feature needs revisiting',
      ).to.not.contain('checkDealsForTrailing')
    })
  })
})
