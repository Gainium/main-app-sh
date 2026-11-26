process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `262.one-way-opposite-direction-deals`.
 *
 * On a one-way futures account the venue keeps ONE net position per symbol.
 * A LONG deal opened while another bot's SHORT deal is open only shrinks the
 * net short; its reduce-only take-profit is then refused as
 * `wouldNotReducePosition`, which `isPositionAlreadyClosedReason` reads as
 * "already flat", and the deal was booked closed as a take-profit with only
 * its fees as profit.
 *
 * §4.1 drives the REAL `refuseNewDealAgainstOpposingPosition` and the REAL
 * `MainBot.findOpposingDealHolder` (DB reads stubbed at the DAO); §4.2 drives
 * the REAL `dcaHelper.closeDealById` over a minimal base class, the same way
 * the sibling `positionFlatDirectionRefusal.harness.spec.ts` does.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import RedisClient from '../../db/redis'
import MainBot, { matchesNotEnoughBalance } from '../main'
import { comboBotDb, comboDealsDb, dcaBotDb, dcaDealsDb } from '../../db/dbInit'
import {
  BotType,
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StartConditionEnum,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'
import { heldAgainst, netPositionSide } from './opposingNetPosition'
import { ConditionLatch } from '../conditionLatch'

const cooldownStore = new Map<string, string>()
let previousGetInstance: unknown
const useEmptyCooldownStore = () => {
  cooldownStore.clear()
  previousGetInstance = (RedisClient as any).getInstance
  ;(RedisClient as any).getInstance = async () => ({
    get: async (k: string) => cooldownStore.get(k) ?? null,
    set: async (k: string, v: string) => {
      cooldownStore.set(k, v)
    },
    del: async (k: string) => {
      cooldownStore.delete(k)
    },
  })
}
const releaseCooldownStore = () => {
  if (previousGetInstance) {
    ;(RedisClient as any).getInstance = previousGetInstance
  }
}

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b62'
const OTHER_BOT_ID = '000000000000000000000c62'
const DEAL_ID = '000000000000000000000d62'
const OTHER_DEAL_ID = '000000000000000000000e62'
const PAIR = 'BTC-USD'

/** The production refusal, verbatim (Kraken Futures). */
const REFUSAL = 'wouldNotReducePosition'

const SIZE = 0.0018
const TP_PRICE = 60000

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 1,
  baseAsset: { name: 'BTC', minAmount: 0.0001 },
  quoteAsset: { name: 'USD', minAmount: 1 },
}

const position = (amt: number, side = 'BOTH') => ({
  symbol: PAIR,
  positionAmt: `${amt}`,
  positionSide: side,
})

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000462'
  botType = 'dca'
  loadingComplete = true
  closeAfterTpFilled = false
  isLong = true
  /** The production shape: a Kraken Futures one-way account. */
  futures = true
  coinm = false
  combo = false
  hedge = false
  orders = new Map()
  exchange: any = {}
  allowToPlaceOrders = new Map()
  openNewDealTimer = new Map()
  /** The real latch, as `MainBot` builds it. */
  standingConditionLatch = new ConditionLatch(60 * 60 * 1000)
  data: any = {
    settings: {
      type: 'regular',
      pair: [PAIR],
      adaptiveClose: false,
      startCondition: StartConditionEnum.asap,
    },
    status: 'open',
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: 'uuid-262',
    flags: [],
    paperContext: false,
    workingShift: [{ start: 1 }],
  }
  shouldProceed() {
    return true
  }
  isErrorNotEnoughBalance(errorString: string) {
    return matchesNotEnoughBalance(errorString)
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Venue =
  | { kind: 'positions'; positions: any[] }
  | { kind: 'notok' }
  | { kind: 'throws' }

type BotOptions = {
  venue: Venue
  isLong?: boolean
  hedge?: boolean
  futures?: boolean
  botType?: string
  holder?: any
}

const buildBot = ({
  venue,
  isLong = true,
  hedge = false,
  futures = true,
  botType = 'dca',
  holder = null,
}: BotOptions) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'BTC', quoteAsset: 'USD' },
    size: SIZE,
    avgPrice: 59000,
    initialPrice: 59000,
    lastPrice: TP_PRICE,
    tpHistory: [],
    reduceFunds: [],
    settings: {},
    tpSlTargetFilled: [],
    levels: { complete: 1 },
  }

  class TestBot extends Helper {
    public logs: string[] = []
    public warns: string[] = []
    public sent: any[] = []
    public closedDeals: string[] = []
    public orderErrors: string[] = []
    public positionReads = 0
    public holderStrategies: any[] = []
    public events: any[] = []
    public userRefusals: string[] = []
    public restoring = false

    isLong = isLong
    hedge = hedge
    futures = futures
    botType = botType
    data: any = { ...new FakeBase().data }
    botEventDb = {
      createData: (e: any) => {
        this.events.push(e)
      },
    }
    exchange: any = {
      futures_getPositions: async () => {
        this.positionReads += 1
        if (venue.kind === 'throws') throw new Error('socket hang up')
        if (venue.kind === 'notok')
          return { status: StatusEnum.notok, reason: 'timeout', data: null }
        return { status: StatusEnum.ok, data: venue.positions }
      },
    }

    async findOpposingDealHolder(_symbol: string, strategy?: StrategyEnum) {
      this.holderStrategies.push(strategy)
      return holder
    }
    async getAggregatedSettings() {
      return this.data.settings
    }
    async reportUserRefusal(m: string) {
      this.userRefusals.push(m)
    }
    async openDealAfterTimer() {}
    getDeal(id: string) {
      if (id !== DEAL_ID) return undefined
      return { deal, initialOrders: [], currentOrders: [] }
    }
    getOpenDeals() {
      return [{ deal, initialOrders: [], currentOrders: [] }]
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async cancelAllOrder() {}
    async prepareTpOrder() {
      return {
        qty: SIZE,
        price: TP_PRICE,
        side: isLong ? OrderSideEnum.sell : OrderSideEnum.buy,
        type: TypeOrderEnum.dealTP,
        newClientOrderId: 'D-TP-fixture262',
      }
    }
    async getExchangeInfo() {
      return this.restoring ? undefined : EXCHANGE_INFO
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange(order: any, sendOptions: any) {
      this.sent.push({ order, sendOptions })
      return REFUSAL
    }
    async checkAssets() {
      return new Map()
    }
    async baseAssetPrecision() {
      return 4
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.0005 }
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async getTPOrder() {
      this.restoring = true
      return [{ qty: SIZE, price: TP_PRICE }]
    }
    async handleOrderErrors(reason: string) {
      this.orderErrors.push(`${reason}`)
    }
    async processError() {}
    getErrorSubType() {
      return REFUSAL
    }
    async handleTrailingCloseRefusal() {
      return false
    }
    async disarmTrailing() {}
    async closeDeal(_botId: string, dealId: string) {
      this.closedDeals.push(dealId)
    }
    saveDeal() {}
    async clearDealTimer() {}
    async updateData() {}
    emit() {}
    trimWorkingShift(w: any) {
      return w
    }
    getWorkingTimeNumber() {
      return 0
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
    handleLog(m: string) {
      this.logs.push(m)
      return m
    }
    handleWarn(m: string) {
      this.warns.push(m)
      return m
    }
    handleDebug() {}
    handleErrors(m: string) {
      this.warns.push(m)
    }
  }
  return new TestBot()
}

const closeRefused = (bot: any) =>
  bot.closeDealById(
    BOT_ID,
    DEAL_ID,
    CloseDCATypeEnum.closeByMarket,
    false,
    false,
    false,
    false,
  )

const clearTimers = (bot: any) => {
  for (const t of bot.openNewDealTimer.values()) clearTimeout(t)
  bot.openNewDealTimer.clear()
}

describe('one-way futures: opposite-direction deals share one net position (spec 262)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  beforeEach(() => useEmptyCooldownStore())
  afterEach(() => releaseCooldownStore())

  describe('§4.0 net position side (pure)', () => {
    it('reads the side of a one-way position from its sign', () => {
      expect(netPositionSide([position(-0.0018)], PAIR)).to.equal('SHORT')
      expect(netPositionSide([position(0.0018)], PAIR)).to.equal('LONG')
      expect(netPositionSide([position(0)], PAIR)).to.equal(null)
      expect(netPositionSide([], PAIR)).to.equal(null)
    })
    it('an unavailable answer is never "held against"', () => {
      expect(heldAgainst({ kind: 'unavailable' }, PAIR, 'LONG')).to.equal(null)
    })
  })

  describe('§4.2 a refused close against an opposite net position is not booked closed', () => {
    it('LONG deal, venue net SHORT: reported as an error, not closed', async () => {
      const bot: any = buildBot({
        venue: { kind: 'positions', positions: [position(-0.0018)] },
      })
      await closeRefused(bot)
      expect(
        bot.closedDeals,
        'deal was booked closed against a net short',
      ).to.deep.equal([])
      expect(bot.orderErrors).to.have.lengthOf(1)
      expect(bot.orderErrors[0]).to.include('SHORT')
      expect(bot.orderErrors[0]).to.include(REFUSAL)
      expect(bot.positionReads).to.equal(1)
    })

    it('SHORT deal, venue net LONG: reported as an error, not closed', async () => {
      const bot: any = buildBot({
        isLong: false,
        venue: { kind: 'positions', positions: [position(0.0008)] },
      })
      await closeRefused(bot)
      expect(bot.closedDeals).to.deep.equal([])
      expect(bot.orderErrors).to.have.lengthOf(1)
      expect(bot.orderErrors[0]).to.include('LONG')
    })
  })

  describe('§4.2 unchanged: everything that is not an opposite position still books closed', () => {
    const cases: [string, BotOptions][] = [
      ['venue flat (no rows)', { venue: { kind: 'positions', positions: [] } }],
      [
        'venue flat (zero row)',
        { venue: { kind: 'positions', positions: [position(0)] } },
      ],
      ['venue unreadable', { venue: { kind: 'notok' } }],
      ['venue read throws', { venue: { kind: 'throws' } }],
      [
        'held on the deal’s own side',
        { venue: { kind: 'positions', positions: [position(0.0018)] } },
      ],
    ]
    for (const [name, opts] of cases) {
      it(`${name}: booked closed without an order, as before`, async () => {
        const bot: any = buildBot(opts)
        await closeRefused(bot)
        expect(bot.closedDeals).to.deep.equal([DEAL_ID])
        expect(bot.orderErrors).to.deep.equal([])
        expect(bot.sent).to.have.lengthOf(1)
      })
    }

    it('hedge account: the venue is not asked, booked closed as before', async () => {
      const bot: any = buildBot({
        hedge: true,
        venue: { kind: 'positions', positions: [position(-0.0018, 'SHORT')] },
      })
      await closeRefused(bot)
      expect(bot.positionReads).to.equal(0)
      expect(bot.closedDeals).to.deep.equal([DEAL_ID])
    })
  })

  describe('§4.1 a new deal against the opposite direction is refused', () => {
    it('an open opposite-strategy deal on another bot refuses the open, without a venue read', async () => {
      const bot: any = buildBot({
        venue: { kind: 'positions', positions: [] },
        holder: {
          dealId: OTHER_DEAL_ID,
          botId: OTHER_BOT_ID,
          botName: 'Short BTC',
          botStopped: false,
        },
      })
      const refused = await bot.refuseNewDealAgainstOpposingPosition(PAIR)
      clearTimers(bot)
      expect(refused).to.equal(true)
      expect(bot.holderStrategies).to.deep.equal([StrategyEnum.short])
      expect(bot.positionReads).to.equal(0)
      expect(bot.events).to.have.lengthOf(1)
      expect(bot.events[0].description).to.include(OTHER_DEAL_ID)
    })

    it('a SHORT bot looks for LONG holders', async () => {
      const bot: any = buildBot({
        isLong: false,
        venue: { kind: 'positions', positions: [] },
      })
      await bot.refuseNewDealAgainstOpposingPosition(PAIR)
      expect(bot.holderStrategies).to.deep.equal([StrategyEnum.long])
    })

    it('no deal holder, venue net opposite: refused', async () => {
      const bot: any = buildBot({
        venue: { kind: 'positions', positions: [position(-0.0008)] },
      })
      const refused = await bot.refuseNewDealAgainstOpposingPosition(PAIR)
      clearTimers(bot)
      expect(refused).to.equal(true)
    })

    it('an ASAP bot is re-armed on a timer, and reported once per window', async () => {
      const bot: any = buildBot({
        venue: { kind: 'positions', positions: [position(-0.0008)] },
      })
      await bot.refuseNewDealAgainstOpposingPosition(PAIR)
      await bot.refuseNewDealAgainstOpposingPosition(PAIR)
      expect(bot.openNewDealTimer.has(PAIR)).to.equal(true)
      clearTimers(bot)
      expect(bot.events).to.have.lengthOf(1)
    })

    it('a manual open is answered, not silently dropped', async () => {
      const bot: any = buildBot({
        venue: { kind: 'positions', positions: [position(-0.0008)] },
      })
      const refused = await bot.refuseNewDealAgainstOpposingPosition(
        PAIR,
        'manual',
      )
      expect(refused).to.equal(true)
      expect(bot.userRefusals).to.have.lengthOf(1)
    })

    const allowed: [string, BotOptions][] = [
      ['venue flat', { venue: { kind: 'positions', positions: [] } }],
      [
        'venue on the same side',
        { venue: { kind: 'positions', positions: [position(0.0008)] } },
      ],
      ['venue unreadable', { venue: { kind: 'notok' } }],
      ['venue read throws', { venue: { kind: 'throws' } }],
    ]
    for (const [name, opts] of allowed) {
      it(`${name}: the deal opens`, async () => {
        const bot: any = buildBot(opts)
        expect(await bot.refuseNewDealAgainstOpposingPosition(PAIR)).to.equal(
          false,
        )
        expect(bot.openNewDealTimer.size).to.equal(0)
      })
    }

    it('hedge accounts, spot and grid bots are never checked', async () => {
      for (const opts of [
        { hedge: true },
        { futures: false },
        { botType: BotType.grid },
      ]) {
        const bot: any = buildBot({
          ...opts,
          venue: { kind: 'positions', positions: [position(-0.0008)] },
          holder: {
            dealId: OTHER_DEAL_ID,
            botId: OTHER_BOT_ID,
            botStopped: false,
          },
        })
        expect(await bot.refuseNewDealAgainstOpposingPosition(PAIR)).to.equal(
          false,
        )
        expect(bot.positionReads).to.equal(0)
        expect(bot.holderStrategies).to.deep.equal([])
      }
    })
  })

  describe('§4.1 findOpposingDealHolder filters by strategy only when asked', () => {
    const saved: any = {}
    const queries: any[] = []
    beforeEach(() => {
      queries.length = 0
      for (const [name, db] of Object.entries({
        dcaDealsDb,
        comboDealsDb,
        dcaBotDb,
        comboBotDb,
      })) {
        saved[name] = (db as any).readData
      }
      ;(dcaDealsDb as any).readData = async (q: any) => {
        queries.push(q)
        return { status: StatusEnum.ok, data: { result: [] } }
      }
      ;(comboDealsDb as any).readData = async (q: any) => {
        queries.push(q)
        return { status: StatusEnum.ok, data: { result: [] } }
      }
    })
    afterEach(() => {
      ;(dcaDealsDb as any).readData = saved.dcaDealsDb
      ;(comboDealsDb as any).readData = saved.comboDealsDb
    })

    const holderOf = () => {
      const bot: any = Object.create(MainBot.prototype)
      bot.userId = '000000000000000000000462'
      bot.botId = BOT_ID
      bot.data = { paperContext: false, exchangeUUID: 'uuid-262' }
      bot.handleWarn = () => undefined
      return bot
    }

    it('with a strategy, both deal collections are filtered on it', async () => {
      await holderOf().findOpposingDealHolder(PAIR, StrategyEnum.short)
      expect(queries).to.have.lengthOf(2)
      for (const q of queries) expect(q.strategy).to.equal(StrategyEnum.short)
    })

    it('without one (bot start), the query is unchanged', async () => {
      await holderOf().findOpposingDealHolder(PAIR)
      expect(queries).to.have.lengthOf(2)
      for (const q of queries) expect(q).to.not.have.property('strategy')
    })
  })
})
