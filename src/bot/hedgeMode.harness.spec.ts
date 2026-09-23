process.env.NODE_ENV = 'testing'

/**
 * Spec `091` — the account's position mode must come from the venue.
 *
 * Driven over the REAL `MainBot.loadData` and the REAL
 * `MainBot.sendOrderToExchange`, because the defect IS what those two do: the
 * first substituted the stored `user.exchanges[].hedge` for a live read on a
 * service restart, and the second had no answer at all for the refusal that
 * substitution produces.
 *
 * The production sequence (OKX Europe linear, a combo LONG, 2026-09-23; the
 * identifiers are synthetic because this file is public):
 *
 *   stored   hedge:false, written a month earlier
 *   venue    hedge mode, switched by the user at the exchange
 *   restart  "Get hedge" / "Got hedge: false" in the SAME millisecond — no
 *            round trip, i.e. the stored copy
 *   +36s     Parameter posSide error, on every order, forever
 *
 * No network, no Mongo, no Redis: the venue, the broker-code read and the user
 * write are all fakes.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import {
  BotStatusEnum,
  ExchangeEnum,
  FuturesStrategyEnum,
  PositionSide,
  StatusEnum,
  StrategyEnum,
  type Order,
} from '../../types'
import { resetHedgeModeCacheForTests } from './hedgeModeGuard'

const BOT_ID = '000000000000000000000b91'
const USER_ID = '000000000000000000000491'
const UUID = '00000000-0000-4000-8000-000000000091'
const SYMBOL = 'SOL-USD_UM_XPERP'

const loadModule = createRequire(__filename)
const MainBot = loadModule('./main').default
const dbInit = loadModule('../db/dbInit')
const AuthFailureGuard = loadModule('./authGuard').default

/** What the fake venue was asked, in order. */
type VenueLog = {
  hedgeReads: number
  orders: { positionSide?: PositionSide; clientOrderId: string }[]
  setHedgeCalls: number
}

/** What the engine wrote back to the connection. */
type UserWrite = { search: any; update: any }

const buildBot = (opts: {
  /** What the venue says the account's position mode is. */
  venueHedge: boolean | 'unreadable'
  /** What `user.exchanges[].hedge` holds. */
  storedHedge: boolean
  /** The bot's own direction. */
  strategy?: StrategyEnum
  futuresStrategy?: FuturesStrategyEnum
  /** false = the user pressed start, rather than the service coming back up. */
  serviceRestart?: boolean
}) => {
  const venue: VenueLog = { hedgeReads: 0, orders: [], setHedgeCalls: 0 }
  const writes: UserWrite[] = []
  const logs: string[] = []
  const bot: any = Object.create(MainBot.prototype)

  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = 'combo'
  bot.serviceRestart = opts.serviceRestart !== false
  bot.secondRestart = false
  bot.hedge = opts.storedHedge
  bot.math = new MathHelper()
  bot.pairs = new Set<string>()
  bot.precisions = new Map()
  bot.basePrecisions = new Map()
  bot.orders = new Map<string, Order>()
  bot.data = {
    _id: BOT_ID,
    userId: USER_ID,
    exchange: ExchangeEnum.okxLinear,
    exchangeUUID: UUID,
    paperContext: false,
    status: BotStatusEnum.open,
    flags: [],
    settings: {
      futures: true,
      coinm: false,
      pair: [SYMBOL],
      leverage: 1,
      marginType: 'isolated',
      strategy: opts.strategy,
      futuresStrategy: opts.futuresStrategy,
    },
  }

  // Only read on a user-initiated start, where the restart snapshot is skipped.
  bot.db = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: bot.data },
      reason: null,
    }),
  }

  bot.exchange = {
    getHedge: async () => {
      venue.hedgeReads++
      return opts.venueHedge === 'unreadable'
        ? { status: StatusEnum.notok, data: null, reason: 'socket hang up' }
        : { status: StatusEnum.ok, data: opts.venueHedge, reason: null }
    },
    setHedge: async () => {
      venue.setHedgeCalls++
      return { status: StatusEnum.ok, data: true, reason: null }
    },
    // Only reached on a user-initiated start — the restart arm skips them.
    futures_getPositions: async () => ({
      status: StatusEnum.ok,
      data: [],
      reason: null,
    }),
    changeLeverage: async () => ({
      status: StatusEnum.ok,
      data: true,
      reason: null,
    }),
    changeMargin: async () => ({
      status: StatusEnum.ok,
      data: true,
      reason: null,
    }),
    // A venue that enforces its OWN mode, which is the whole point: it refuses
    // the posSide that does not match `venueHedge`, exactly as OKX 51000 does
    // in both directions.
    openOrder: async (req: any) => {
      venue.orders.push({
        positionSide: req.positionSide,
        clientOrderId: req.newClientOrderId,
      })
      const wants =
        opts.venueHedge === true
          ? [PositionSide.LONG, PositionSide.SHORT]
          : [PositionSide.BOTH, undefined]
      if (!wants.includes(req.positionSide)) {
        return {
          status: StatusEnum.notok,
          data: null,
          reason: 'Parameter posSide error',
        }
      }
      // Deliberately not a success: the success path is a different method's
      // job and needs the whole fill pipeline. A second, unrelated refusal
      // proves the re-send happened and carried the corrected mode, which is
      // all this spec is about.
      return {
        status: StatusEnum.notok,
        data: null,
        reason: 'Order price is not within the price limit',
      }
    },
  }

  // --- collaborators the two methods under test reach for -------------------
  bot.startMethod = () => ''
  bot.endMethod = () => undefined
  bot.handleLog = (l: string) => logs.push(l)
  bot.handleWarn = (l: string) => logs.push(`WARN ${l}`)
  bot.handleDebug = () => undefined
  bot.handleErrors = (l: string) => logs.push(`ERROR ${l}`)
  bot.handleOrderErrors = (l: string) => logs.push(`ORDERERROR ${l}`)
  bot.emit = () => undefined
  bot.getFromRedis = async () => null
  bot.getUser = async () => ({
    timezone: 'UTC',
    onboardingSteps: { deployLiveBot: true },
    exchanges: [
      {
        uuid: UUID,
        provider: ExchangeEnum.okxLinear,
        key: 'k',
        secret: 's',
        passphrase: 'p',
        hedge: opts.storedHedge,
        zeroFee: false,
      },
    ],
  })
  bot.setExchangeCredentials = async () => undefined
  bot.shouldContinueLoad = () => true
  bot.updatePairs = async () => undefined
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 2,
    baseAsset: {
      name: 'SOL',
      step: 0.01,
      minAmount: 0.01,
      maxMarketAmount: 1e9,
    },
    quoteAsset: { name: 'USD', precision: 2, minAmount: 1 },
  })
  bot.getUserFee = async () => ({ maker: 0.0005, taker: 0.0005 })
  bot.getOKXDenominator = async () => 1
  bot.setOrder = () => undefined
  bot.getOrderFromMap = () => undefined
  bot.saveOrderToDb = async () => undefined
  bot.updateOrderOnDb = async () => undefined
  bot.deleteOrder = () => undefined
  bot.deleteOrderFromDb = async () => undefined
  bot.getNotEnoughOrdersIdByOrder = () => `${SYMBOL}|BUY`
  bot.isComplianceGateable = () => false
  bot.needToSendOrder = () => false
  bot.markDealStartBlocked = async () => undefined
  bot.isErrorNotEnoughBalance = () => false
  bot.getErrorSubType = () => ''
  bot.requiredForOrder = () => 0

  return { bot, venue, writes, logs }
}

const futuresOrder = (positionSide?: PositionSide): Order =>
  ({
    symbol: SYMBOL,
    clientOrderId: 'CMB-GR-0000000000000091',
    orderId: '-1',
    dealId: '000000000000000000000d91',
    typeOrder: 'dealRegular',
    type: 'LIMIT',
    side: 'BUY',
    price: '117.56',
    origPrice: '117.56',
    origQty: '0.01',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    reduceOnly: false,
    positionSide,
    exchange: ExchangeEnum.okxLinear,
    exchangeUUID: UUID,
    botId: BOT_ID,
    userId: USER_ID,
  }) as unknown as Order

describe('spec 091 — a futures bot reads the account position mode', () => {
  let userWrites: UserWrite[]
  let restoreUserUpdate: any
  let restoreBrokerRead: any
  let restoreAuthCheck: any

  beforeEach(() => {
    resetHedgeModeCacheForTests()
    userWrites = []
    restoreUserUpdate = dbInit.userDb.updateData
    dbInit.userDb.updateData = async (search: any, update: any) => {
      userWrites.push({ search, update })
      return { status: StatusEnum.ok, data: { message: 'ok' }, reason: null }
    }
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

  describe('§1.2 / §3 — the load', () => {
    it('takes the mode from the venue on a service restart, not from the stored copy', async () => {
      const { bot, venue, logs } = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })

      await bot.loadData()

      // The defect: `skipFutures` answered this from `keys.hedge` with no call.
      expect(venue.hedgeReads).to.equal(1)
      expect(bot.hedge).to.equal(true)
      expect(logs).to.include('Got hedge: true')
    })

    it('§4.3 writes the venue-read mode back, scoped to the one connection', async () => {
      const { bot } = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })

      await bot.loadData()

      expect(userWrites).to.have.length(1)
      expect(userWrites[0].search).to.deep.equal({
        _id: USER_ID,
        exchanges: { $elemMatch: { uuid: UUID, hedge: { $ne: true } } },
      })
      expect(userWrites[0].update).to.deep.equal({
        $set: { 'exchanges.$.hedge': true },
      })
    })

    it('§4.1 falls back to the stored copy when the venue does not answer', async () => {
      const { bot, venue } = buildBot({
        venueHedge: 'unreadable',
        storedHedge: true,
        strategy: StrategyEnum.long,
      })

      await bot.loadData()

      expect(venue.hedgeReads).to.equal(1)
      // Exactly the behaviour the substitution had, for the one case it was
      // ever right about: no answer means keep what we stored.
      expect(bot.hedge).to.equal(true)
      expect(userWrites).to.have.length(0)
    })

    it('§4.7 leaves an account nobody changed exactly as it was', async () => {
      const { bot } = buildBot({
        venueHedge: false,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })

      await bot.loadData()

      expect(bot.hedge).to.equal(false)
      expect(userWrites).to.have.length(0)
    })

    it('§4.2 does NOT serve a cached answer to a user-initiated start', async () => {
      // `setHedge` runs in the API process and cannot reach a bot worker's
      // cache, so a user who changes the mode here and presses start must get
      // the venue's answer, not the window-old one.
      const warm = buildBot({
        venueHedge: false,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })
      await warm.bot.loadData()
      expect(warm.venue.hedgeReads).to.equal(1)

      const started = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
        serviceRestart: false,
      })
      await started.bot.loadData()

      expect(started.venue.hedgeReads).to.equal(1)
      expect(started.bot.hedge).to.equal(true)
    })

    it('§4.2 answers every bot on one connection with a single venue read', async () => {
      const first = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })
      const second = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })

      await Promise.all([first.bot.loadData(), second.bot.loadData()])

      expect(first.venue.hedgeReads + second.venue.hedgeReads).to.equal(1)
      expect(first.bot.hedge).to.equal(true)
      expect(second.bot.hedge).to.equal(true)
    })
  })

  describe('§4.5 / §4.6 — the refusal', () => {
    it('re-reads the mode and re-sends the order under it', async () => {
      const { bot, venue } = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })
      // The bot is already running with the wrong mode — the user changed it at
      // the exchange after this bot loaded, so no load is coming to fix it.
      bot.hedge = false

      const result = await bot.sendOrderToExchange(
        futuresOrder(PositionSide.BOTH),
        true,
      )

      expect(venue.orders.map((o) => o.positionSide)).to.deep.equal([
        PositionSide.BOTH,
        PositionSide.LONG,
      ])
      expect(bot.hedge).to.equal(true)
      expect(userWrites).to.have.length(1)
      // The re-sent order is refused by the fake venue for an unrelated
      // reason, which is what the caller sees — NOT the posSide error.
      expect(result).to.equal('Order price is not within the price limit')
    })

    it('corrects the mirror case — a hedge order on a one-way account', async () => {
      const { bot, venue } = buildBot({
        venueHedge: false,
        storedHedge: true,
        strategy: StrategyEnum.long,
      })
      bot.hedge = true

      await bot.sendOrderToExchange(futuresOrder(PositionSide.LONG), true)

      expect(venue.orders.map((o) => o.positionSide)).to.deep.equal([
        PositionSide.LONG,
        PositionSide.BOTH,
      ])
      expect(bot.hedge).to.equal(false)
    })

    it('does not retry a second time once the mode is already right', async () => {
      // The venue refuses BOTH and the bot already believes one-way: nothing
      // the re-read can change, so it must not loop.
      const { bot, venue } = buildBot({
        venueHedge: true,
        storedHedge: true,
        strategy: StrategyEnum.long,
      })
      bot.hedge = true

      await bot.sendOrderToExchange(futuresOrder(PositionSide.BOTH), true)

      expect(venue.orders).to.have.length(1)
    })

    it('§4.6 does not re-send a bot whose settings name no leg', async () => {
      const { bot, venue } = buildBot({
        venueHedge: true,
        storedHedge: false,
        futuresStrategy: FuturesStrategyEnum.neutral,
      })
      bot.hedge = false

      const result = await bot.sendOrderToExchange(
        futuresOrder(PositionSide.BOTH),
        true,
      )

      // The mode is corrected and stored — the next order this bot builds is
      // right — but this one is NOT guessed into a leg.
      expect(bot.hedge).to.equal(true)
      expect(userWrites).to.have.length(1)
      expect(venue.orders).to.have.length(1)
      expect(result).to.equal('Parameter posSide error')
    })

    it('§4.4 never changes the mode on the exchange', async () => {
      const { bot, venue } = buildBot({
        venueHedge: true,
        storedHedge: false,
        strategy: StrategyEnum.long,
      })
      bot.hedge = false

      await bot.loadData()
      await bot.sendOrderToExchange(futuresOrder(PositionSide.BOTH), true)

      expect(venue.setHedgeCalls).to.equal(0)
    })
  })
})
