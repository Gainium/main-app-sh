process.env.NODE_ENV = 'testing'

/**
 * Spec `148` — a settings reload does not re-apply leverage to every pair.
 *
 * Driven over the REAL `MainBot.loadData`, because the defect is what its
 * futures loop does. Every load asked the venue to set leverage and margin for
 * every pair, one round trip each, inside the bot's per-bot method lock. On a
 * Combo bot with a few hundred pairs, a settings save held that lock for
 * minutes, and a manual deal close queued behind it.
 *
 * No network, no Mongo, no Redis: the venue, the broker-code read and the user
 * are fakes. The pair list and identifiers are synthetic.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import {
  BotStatusEnum,
  ExchangeEnum,
  StatusEnum,
  StrategyEnum,
  type Order,
} from '../../types'
import { resetHedgeModeCacheForTests } from './hedgeModeGuard'

const BOT_ID = '000000000000000000000b48'
const USER_ID = '000000000000000000000448'
const UUID = '00000000-0000-4000-8000-000000000148'
const PAIRS = Array.from({ length: 40 }, (_, i) => `COIN${i}USDT`)

const loadModule = createRequire(__filename)
const MainBot = loadModule('./main').default
const dbInit = loadModule('../db/dbInit')
const AuthFailureGuard = loadModule('./authGuard').default

type Call = { symbol: string; leverage: number; margin?: string }

const buildBot = () => {
  const venue = {
    leverage: [] as Call[],
    margin: [] as Call[],
    failLeverage: new Set<string>(),
    /** Position rows the venue reports (flat rows still carry leverage). */
    positions: [] as Record<string, unknown>[],
  }
  const bot: any = Object.create(MainBot.prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = 'combo'
  bot.hedge = false
  // A constructed MainBot starts with an empty map (field initializer).
  bot.appliedFuturesSettings = new Map<string, string>()
  bot.math = new MathHelper()
  bot.pairs = new Set<string>()
  bot.precisions = new Map()
  bot.basePrecisions = new Map()
  bot.orders = new Map<string, Order>()
  bot.data = {
    _id: BOT_ID,
    userId: USER_ID,
    exchange: ExchangeEnum.bybitUsdm,
    exchangeUUID: UUID,
    paperContext: false,
    status: BotStatusEnum.open,
    flags: [],
    deals: { active: 1 },
    settings: {
      futures: true,
      coinm: false,
      pair: [...PAIRS],
      leverage: 5,
      marginType: 'cross',
      strategy: StrategyEnum.long,
    },
  }
  bot.db = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: bot.data },
      reason: null,
    }),
  }
  bot.exchange = {
    getHedge: async () => ({
      status: StatusEnum.ok,
      data: false,
      reason: null,
    }),
    // A per-symbol venue: the engine fetches this once and reuses it.
    futures_getPositions: async () => ({
      status: StatusEnum.ok,
      data: venue.positions,
      reason: null,
    }),
    changeLeverage: async (req: any) => {
      venue.leverage.push({ symbol: req.symbol, leverage: req.leverage })
      return venue.failLeverage.has(req.symbol)
        ? { status: StatusEnum.notok, data: null, reason: 'rejected' }
        : { status: StatusEnum.ok, data: true, reason: null }
    },
    changeMargin: async (req: any) => {
      venue.margin.push({
        symbol: req.symbol,
        leverage: req.leverage,
        margin: req.margin,
      })
      return { status: StatusEnum.ok, data: true, reason: null }
    },
  }
  bot.startMethod = () => ''
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.emit = () => undefined
  bot.getFromRedis = async () => null
  bot.getUser = async () => ({
    timezone: 'UTC',
    onboardingSteps: { deployLiveBot: true },
    exchanges: [
      {
        uuid: UUID,
        provider: ExchangeEnum.bybitUsdm,
        key: 'k',
        secret: 's',
        hedge: false,
        zeroFee: false,
      },
    ],
  })
  bot.setExchangeCredentials = async () => undefined
  bot.shouldContinueLoad = () => true
  bot.updatePairs = async () => undefined

  /** The user pressed start: every pair is applied. */
  const userStart = async () => {
    bot.serviceRestart = false
    bot.secondRestart = false
    bot.reload = false
    await bot.loadData()
  }
  /** A settings save: `reloadBot(id, replaceOrders = false)`. */
  const settingsReload = async () => {
    bot.serviceRestart = true
    bot.secondRestart = true
    bot.reload = true
    await bot.loadData()
  }
  const reset = () => {
    venue.leverage.length = 0
    venue.margin.length = 0
  }
  return { bot, venue, userStart, settingsReload, reset }
}

describe('spec 148 — a settings reload does not re-apply leverage per pair', () => {
  let restoreUserUpdate: any
  let restoreBrokerRead: any
  let restoreAuthCheck: any

  beforeEach(() => {
    resetHedgeModeCacheForTests()
    restoreUserUpdate = dbInit.userDb.updateData
    dbInit.userDb.updateData = async () => ({
      status: StatusEnum.ok,
      data: { message: 'ok' },
      reason: null,
    })
    restoreBrokerRead = dbInit.brokerCodesDb.readData
    dbInit.brokerCodesDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: null },
      reason: null,
    })
    restoreAuthCheck = AuthFailureGuard.check
    AuthFailureGuard.check = async () => ({
      failed: false,
      reason: null,
      until: null,
    })
  })

  afterEach(() => {
    dbInit.userDb.updateData = restoreUserUpdate
    dbInit.brokerCodesDb.readData = restoreBrokerRead
    AuthFailureGuard.check = restoreAuthCheck
  })

  it('§1.1.3 / §1.1.4 a user start applies every pair with the bot settings', async () => {
    const { venue, userStart } = buildBot()
    await userStart()
    expect(venue.leverage.map((c) => c.symbol)).to.deep.equal(PAIRS)
    expect(venue.margin.map((c) => c.symbol)).to.deep.equal(PAIRS)
    expect(venue.leverage.every((c) => c.leverage === 5)).to.equal(true)
    expect(venue.margin.every((c) => c.margin === 'CROSSED')).to.equal(true)
  })

  it('§1.1.1 a keep-orders reload does not re-apply unchanged pairs', async () => {
    const { venue, userStart, settingsReload, reset } = buildBot()
    await userStart()
    reset()
    await settingsReload()
    // The defect: 40 + 40 venue round trips on every settings save.
    expect(venue.leverage).to.have.length(0)
    expect(venue.margin).to.have.length(0)
  })

  it('§1.1.2 a keep-orders reload applies a newly added pair only', async () => {
    const { bot, venue, userStart, settingsReload, reset } = buildBot()
    await userStart()
    reset()
    bot.data.settings.pair = [...PAIRS, 'NEWUSDT']
    await settingsReload()
    expect(venue.leverage).to.deep.equal([{ symbol: 'NEWUSDT', leverage: 5 }])
    expect(venue.margin.map((c) => c.symbol)).to.deep.equal(['NEWUSDT'])
  })

  it('§1.1.2 a keep-orders reload re-applies every pair after a leverage change', async () => {
    const { bot, venue, userStart, settingsReload, reset } = buildBot()
    await userStart()
    reset()
    bot.data.settings.leverage = 10
    await settingsReload()
    expect(venue.leverage.map((c) => c.symbol)).to.deep.equal(PAIRS)
    expect(venue.leverage.every((c) => c.leverage === 10)).to.equal(true)
    expect(venue.margin.map((c) => c.symbol)).to.deep.equal(PAIRS)
  })

  it('§1.1.2 a keep-orders reload re-applies every pair after a margin type change', async () => {
    const { bot, venue, userStart, settingsReload, reset } = buildBot()
    await userStart()
    reset()
    bot.data.settings.marginType = 'isolated'
    await settingsReload()
    expect(venue.margin.map((c) => c.symbol)).to.deep.equal(PAIRS)
    expect(venue.margin.every((c) => c.margin === 'ISOLATED')).to.equal(true)
  })

  it('§1.1.1 a keep-orders reload still corrects a symbol the venue reports at other values', async () => {
    const { venue, userStart, settingsReload, reset } = buildBot()
    await userStart()
    reset()
    // Changed at the exchange after the start: the venue now says 3x.
    venue.positions.push({
      symbol: 'COIN0USDT',
      positionAmt: '0',
      positionSide: 'BOTH',
      leverage: '3',
      isolated: false,
    })
    await settingsReload()
    expect(venue.leverage).to.deep.equal([{ symbol: 'COIN0USDT', leverage: 5 }])
    expect(venue.margin).to.have.length(0)
  })

  it('§1.1.1 a keep-orders reload retries a symbol whose leverage call failed', async () => {
    const { venue, userStart, settingsReload, reset } = buildBot()
    venue.failLeverage.add('COIN3USDT')
    await userStart()
    reset()
    await settingsReload()
    expect(venue.leverage.map((c) => c.symbol)).to.deep.equal(['COIN3USDT'])
  })

  it('§1.1.3 a user start after a reload re-applies every pair', async () => {
    const { venue, userStart, settingsReload, reset } = buildBot()
    await userStart()
    await settingsReload()
    reset()
    await userStart()
    expect(venue.leverage.map((c) => c.symbol)).to.deep.equal(PAIRS)
    expect(venue.margin.map((c) => c.symbol)).to.deep.equal(PAIRS)
  })

  it('§4.2 the first reload of a fresh instance still applies every pair', async () => {
    const { venue, settingsReload } = buildBot()
    await settingsReload()
    expect(venue.leverage.map((c) => c.symbol)).to.deep.equal(PAIRS)
  })
})
