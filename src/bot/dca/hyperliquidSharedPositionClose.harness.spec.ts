process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `163.a-hyperliquid-close-of-a-shared-position-is-retried-in-vain`.
 *
 * Drives the REAL `dcaHelper.closeDealById` over a minimal base class — no
 * stack, DB, Redis or exchange connection. The venue refuses every close for
 * value, as Hyperliquid does for a reduce-only order under $10 that is only
 * part of the position, and `futures_getPositions` answers with the position
 * each case needs.
 *
 * Harness shape from `positionFlatDirectionRefusal.harness.spec.ts` (spec 075).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import RedisClient from '../../db/redis'
import { matchesNotEnoughBalance } from '../main'
import {
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

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
const BOT_ID = '000000000000000000000b63'
const DEAL_ID = '000000000000000000000d63'
const PAIR = 'HYPE-USDC'

/** The venue's refusal, verbatim. */
const HL_MIN_VALUE = 'order 0: order must have minimum value of $10. asset=159'

const CLOSE_QTY = 0.11
const CLOSE_PRICE = 81.865

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 3,
  baseAsset: { name: 'HYPE', minAmount: 0.01, step: 0.01 },
  quoteAsset: { name: 'USDC', minAmount: 10 },
}

type Venue = {
  exchange: ExchangeEnum
  refusal: string
  /** What `futures_getPositions` answers: a position size, or no answer. */
  position: number | 'unavailable'
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000463'
  botType = 'dca'
  loadingComplete = true
  closeAfterTpFilled = false
  isLong = true
  futures = true
  coinm = false
  combo = false
  hedge = false
  orders = new Map()
  exchange: any = {}
  allowToPlaceOrders = new Map()
  openNewDealTimer = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR], adaptiveClose: false },
    status: 'open',
    exchange: ExchangeEnum.hyperliquidLinear,
    exchangeUUID: 'uuid-163',
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

const buildBot = (venue: Venue) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'HYPE', quoteAsset: 'USDC' },
    size: CLOSE_QTY,
    avgPrice: 91.971,
    initialPrice: 91.971,
    lastPrice: CLOSE_PRICE,
    tpHistory: [],
    reduceFunds: [],
    settings: {},
    tpSlTargetFilled: [],
    levels: { complete: 1 },
  }

  class TestBot extends Helper {
    public logs: string[] = []
    public sent: any[] = []
    public closedDeals: string[] = []
    public orderErrors: string[] = []
    public trailingReasons: string[] = []
    public positionCalls = 0
    public liveOrders: any[] = []
    public restoring = false

    data: any = { ...new FakeBase().data, exchange: venue.exchange }
    exchange: any = {
      futures_getPositions: async () => {
        this.positionCalls++
        if (venue.position === 'unavailable') {
          return { status: StatusEnum.notok, reason: 'timeout', data: null }
        }
        return {
          status: StatusEnum.ok,
          data: [
            {
              symbol: PAIR,
              positionAmt: `${venue.position}`,
              positionSide: 'BOTH',
            },
          ],
        }
      },
    }

    getDeal(id: string) {
      if (id !== DEAL_ID) return undefined
      return { deal, initialOrders: [], currentOrders: [] }
    }
    getOpenDeals() {
      return [{ deal, initialOrders: [], currentOrders: [] }]
    }
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = Array.isArray(status) ? status : [status]
      return this.liveOrders.filter((x) => wanted.includes(x.status))
    }
    async cancelAllOrder() {
      this.liveOrders = []
    }
    async prepareTpOrder() {
      return {
        qty: CLOSE_QTY,
        price: CLOSE_PRICE,
        side: OrderSideEnum.sell,
        type: TypeOrderEnum.dealTP,
        newClientOrderId: 'D-TP-fixture163',
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
      return venue.refusal
    }
    async checkAssets() {
      return new Map()
    }
    async baseAssetPrecision() {
      return 2
    }
    async getUserFee() {
      return { maker: 0.00015, taker: 0.00045 }
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async getTPOrder() {
      this.restoring = true
      return [{ qty: CLOSE_QTY, price: CLOSE_PRICE }]
    }
    async handleOrderErrors(reason: string) {
      this.orderErrors.push(`${reason}`)
    }
    async processError() {}
    getErrorSubType() {
      return 'Order params'
    }
    async handleTrailingCloseRefusal(_deal: any, reason: string) {
      this.trailingReasons.push(reason)
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
      this.logs.push(m)
      return m
    }
    handleDebug() {}
    handleErrors(m: string) {
      this.logs.push(m)
    }
  }
  return new TestBot()
}

/**
 * The retry ladder re-enters `closeDealById` without awaiting it, so wait
 * until the bot has stopped sending and has reported the terminal refusal.
 */
const closeAndSettle = async (bot: any) => {
  await bot.closeDealById(
    BOT_ID,
    DEAL_ID,
    CloseDCATypeEnum.closeByMarket,
    false,
    false,
    false,
    false,
  )
  let last = -1
  for (let i = 0; i < 100; i++) {
    if (bot.orderErrors.length > 0 && bot.sent.length === last) break
    last = bot.sent.length
    await new Promise((r) => setTimeout(r, 200))
  }
  return bot
}

const HL_SHARED: Venue = {
  exchange: ExchangeEnum.hyperliquidLinear,
  refusal: HL_MIN_VALUE,
  position: 0.22,
}

/** Today's ladder: the first attempt and five retries. */
const LADDER_SENDS = 6

describe('a Hyperliquid close of a shared position (spec 163)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  beforeEach(() => useEmptyCooldownStore())
  afterEach(() => releaseCooldownStore())

  describe('§1.1 the close is only part of the venue position', () => {
    it('is sent once, not retried', async function () {
      this.timeout(30000)
      const bot = await closeAndSettle(buildBot(HL_SHARED))
      expect(bot.sent).to.have.lengthOf(1)
    })

    it('is reported once, saying the position is shared and what to do', async function () {
      this.timeout(30000)
      const bot = await closeAndSettle(buildBot(HL_SHARED))
      expect(bot.orderErrors).to.have.lengthOf(1)
      const msg = bot.orderErrors[0]
      expect(msg).to.contain('only part of the 0.22 HYPE position')
      expect(msg).to.contain('0.11 HYPE')
      expect(msg).to.contain('HYPE-USDC')
      expect(msg).to.contain('close the whole position')
      // Not the venue's text: a rule keyed on it would override this message.
      expect(msg).to.not.contain('must have minimum value of')
    })

    it('leaves the deal open', async function () {
      this.timeout(30000)
      const bot = await closeAndSettle(buildBot(HL_SHARED))
      expect(bot.closedDeals).to.deep.equal([])
    })

    it('hands the trailing-close classifier the venue’s own refusal', async function () {
      this.timeout(30000)
      const bot = await closeAndSettle(buildBot(HL_SHARED))
      expect(bot.trailingReasons).to.deep.equal([HL_MIN_VALUE])
    })
  })

  describe('§1.3 everything else keeps today’s retry ladder', () => {
    const unchanged: [string, Venue][] = [
      [
        'the close is the whole Hyperliquid position',
        { ...HL_SHARED, position: CLOSE_QTY },
      ],
      ['the venue does not answer', { ...HL_SHARED, position: 'unavailable' }],
      [
        'another venue refuses for value',
        {
          exchange: ExchangeEnum.binanceUsdm,
          refusal: "Order's notional must be no smaller than 5",
          position: 0.22,
        },
      ],
    ]
    for (const [name, venue] of unchanged) {
      it(`${name}: retried, then the venue's text reported`, async function () {
        this.timeout(30000)
        const bot = await closeAndSettle(buildBot(venue))
        expect(bot.sent).to.have.lengthOf(LADDER_SENDS)
        expect(bot.orderErrors).to.deep.equal([venue.refusal])
        expect(bot.closedDeals).to.deep.equal([])
      })
    }

    it('another venue is not asked for its position', async function () {
      this.timeout(30000)
      const bot = await closeAndSettle(
        buildBot({
          exchange: ExchangeEnum.binanceUsdm,
          refusal: "Order's notional must be no smaller than 5",
          position: 0.22,
        }),
      )
      expect(bot.positionCalls).to.equal(0)
    })

    it('a Hyperliquid refusal that is not about value: no position probe', async function () {
      this.timeout(30000)
      const bot = await closeAndSettle(
        buildBot({
          ...HL_SHARED,
          refusal: 'Insufficient margin to place order',
        }),
      )
      expect(bot.positionCalls).to.equal(0)
      expect(bot.sent).to.have.lengthOf(1)
    })
  })
})
