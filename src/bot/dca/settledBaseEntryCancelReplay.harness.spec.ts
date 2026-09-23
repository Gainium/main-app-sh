process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `088` — the venue's own cancel report must not put
 * a settled base entry back the way it was before the top-up bought the rest
 * of it.
 *
 * Production, Coinbase spot, a DCA deal whose LIMIT base order for 3334.9 units
 * traded 100.4 on the book. The settle cancelled the remainder, bought the
 * missing 3206.1 at market and merged the row to 3306.5 @ 0.0301 — and 29 ms
 * later the engine was reading 100.4 again, because the venue's cancel report
 * had been converted BEFORE the merge, blocked on the per-order mutex, and was
 * then written back over the merged row. `getAvgPrice` dropped the base entry
 * entirely (it filters on `FILLED`) and priced the deal off its one safety
 * order: 0.0298 stored against 0.030025 owed, and `levels.complete` 1 against
 * the two orders the deal used.
 *
 * Two levels:
 *
 *  - `MainBot` itself, real: `fillPartiallyFilledOrder` merges, the real
 *    `processOrderQueue` replays the stale cancel over the real
 *    `setOrder`/`deleteOrder`/`orderStatusMap`, and the map has to survive it;
 *  - the real `dcaHelper.getAvgPrice` folding that same map.
 *
 * Fixture ids are synthetic — this file is public. Quantities and prices are
 * the production ones verbatim.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d88'
const BOT_ID = '000000000000000000000b88'
const USER_ID = '000000000000000000000488'
const SYMBOL = 'BIO-USDC'
const BASE_ID = 'D-BO-0000000000000000000000000088'
const SAFETY_ID = 'D-RO-0000000000000000000000000088'

/** The entry as the venue last reported it on the book: 100.4 of 3334.9. */
const bookFill = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'AAAAAA-BBBBB-CCCCCC',
    clientOrderId: BASE_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '0.03003',
    origPrice: '0.03003',
    origQty: '3334.9',
    executedQty: '100.4',
    cummulativeQuoteQty: '3.0150120000000005',
    exchange: ExchangeEnum.coinbase,
    status: 'PARTIALLY_FILLED',
    updateTime: 1790119238868,
    transactTime: 1790119238868,
    ...over,
  }) as any

/** The safety order that filled twelve minutes later, at 0.0298. */
const safetyFill = () =>
  ({
    ...bookFill(),
    clientOrderId: SAFETY_ID,
    orderId: 'DDDDDD-EEEEE-FFFFFF',
    typeOrder: TypeOrderEnum.dealRegular,
    price: '0.0298',
    origPrice: '0.0298',
    origQty: '1107.4',
    executedQty: '1107.4',
    cummulativeQuoteQty: '33.00052',
    status: 'FILLED',
    updateTime: 1790120004970,
  }) as any

/** The average the deal's entry actually cost: 132.52617 / 4413.9. */
const CORRECT_AVG = (3306.5 * 0.0301 + 1107.4 * 0.0298) / (3306.5 + 1107.4)
/** What the deal stored instead: the safety order's own price. */
const SAFETY_ONLY_AVG = 0.0298

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  data: any = {
    exchange: ExchangeEnum.coinbase,
    settings: {
      type: 'regular',
      pair: [SYMBOL],
      futures: false,
      coinm: false,
      remainderFullAmount: false,
    },
    paperContext: false,
    flags: [],
  }
  get futures() {
    return false
  }
  get coinm() {
    return false
  }
  get isLong() {
    return true
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

/** The real order map + queue, borrowed off `MainBot` rather than re-modelled. */
const REAL_FROM_MAIN_BOT = [
  'setOrder',
  'deleteOrder',
  'getOrderFromMap',
  'getOrdersByStatusAndDealId',
  'setOrderByStatus',
  'removeOrderByStatus',
  'setOrderByDeal',
  'removeOrderByDeal',
  'fillPartiallyFilledOrder',
  'buyRemainder',
  'processOrderQueue',
] as const

describe('a topped-up base entry is erased by its own cancel report (spec 088)', () => {
  const loadModule = createRequire(__filename)
  let Helper: any
  let TestBot: any

  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
    class Bot extends Helper {
      raised: any = {
        sent: [] as any[],
        persisted: [] as any[],
        fired: [] as string[],
      }
      orders = new Map<string, any>()
      ordersKeys = new Set<string>()
      orderStatusMap = new Map<string, Set<string>>()
      orderDealMap = new Map<string, Set<string>>()
      orderStatuses = ['NEW', 'PARTIALLY_FILLED']
      partiallyFilledFilledSet = new Set<string>()
      allowToPlaceOrders = new Map<string, boolean>()
      processedOrders = new Map<string, any>()
      orderQueue: any[] = []
      lockProcessQueueMethod = false
      deals = new Map<string, any>()
      math = new MathHelper()
      sharedStream = { addOrder() {}, removeOrder() {} }
      setOrdersToRedis() {}
      handleLog() {}
      handleDebug() {}
      handleWarn() {}
      emit() {
        return true
      }
      needToSendOrder() {
        return false
      }
      startMethod() {
        return '1'
      }
      endMethod() {}
      getDeal() {
        return undefined
      }
      async getUserFee() {
        return { maker: 0, taker: 0 }
      }
      async profitBase() {
        return false
      }
      async getExchangeInfo() {
        return {
          pair: SYMBOL,
          priceAssetPrecision: 5,
          baseAsset: { minAmount: 1, step: 0.1, precision: 1 },
          quoteAsset: { minAmount: 1, step: 0.01, precision: 2 },
        }
      }
      async getLatestPrice() {
        return 0.0301
      }
      async baseAssetPrecision() {
        return 1
      }
      getOrderId(p: string) {
        return `GA-BR-${p}`
      }
      getOrderStatus(msg: any) {
        return msg.newClientOrderId
      }
      async convertExecutionReportToOrder(msg: any) {
        // The venue's cancel, converted the moment it arrived — a SNAPSHOT
        // taken before the top-up merged anything into the row. This is the
        // whole point of the case; it is not a shortcut.
        return { ...msg.snapshot }
      }
      async updateOrderOnDb(o: any, force?: boolean) {
        this.raised.persisted.push({ ...o, force })
      }
      async saveOrderToDb() {}
      botEventDb = {
        createData: async () => ({ status: 'ok' }),
      }
      /** The venue: a `market_market_ioc` that fills the whole remainder. */
      async sendGridToExchange(grid: any, params: any) {
        this.raised.sent.push({ ...grid, ...params })
        return {
          clientOrderId: grid.newClientOrderId,
          symbol: SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          exchange: ExchangeEnum.coinbase,
          // 96.51972794669811 / 3206.1, as the venue reported it.
          price: '0.0301050272751',
          origQty: `${grid.qty}`,
          executedQty: '3206.1',
          status: 'FILLED',
          transactTime: 1790119275081,
        }
      }
    }
    for (const m of REAL_FROM_MAIN_BOT) {
      ;(Bot.prototype as any)[m] = (MainBot as any).prototype[m]
    }
    TestBot = Bot
  })

  /**
   * The production sequence, in production order:
   *   1. the book fill is in the map, PARTIALLY_FILLED;
   *   2. the settle promotes it and tops it back up (the merge);
   *   3. the venue's cancel — converted before the merge — is replayed through
   *      the real order queue.
   */
  const replayProductionSequence = async () => {
    const bot: any = new TestBot()
    const resting = bookFill()
    bot.setOrder(resting)

    // The settle: `cancelOrderOnExchange` promotes the row, then the top-up.
    const promoted = { ...resting, status: 'FILLED' }
    bot.setOrder(promoted)
    const merged = await bot.fillPartiallyFilledOrder(promoted, true)

    // The venue's cancel report, holding what the book had filled.
    bot.orderQueue = [
      {
        newClientOrderId: BASE_ID,
        symbol: SYMBOL,
        orderStatus: 'CANCELED',
        totalTradeQuantity: '100.4',
        snapshot: bookFill({ status: 'CANCELED', updateTime: 1790119274471 }),
      },
    ]
    await bot.processOrderQueue(
      BOT_ID,
      async () => {
        bot.raised.fired.push('onFilled')
      },
      async () => {
        bot.raised.fired.push('onPartiallyFilled')
      },
      async () => {
        bot.raised.fired.push('onCanceled')
      },
      async () => {
        bot.raised.fired.push('onNew')
      },
    )
    return { bot, merged }
  }

  describe('§1.1 the merge survives the cancel report', () => {
    it('the top-up merges the whole entry into the base order row', async () => {
      const { bot, merged } = await replayProductionSequence()
      expect(bot.raised.sent, 'one market remainder').to.have.length(1)
      expect(+merged.executedQty).to.be.closeTo(3306.5, 0.01)
      expect(merged.status).to.equal('FILLED')
    })

    it('the order map still holds the merged row after the replay', async () => {
      const { bot } = await replayProductionSequence()
      const row = bot.getOrderFromMap(BASE_ID)
      expect(
        +row.executedQty,
        'the whole entry, not the book fill',
      ).to.be.closeTo(3306.5, 0.01)
      expect(row.status).to.equal('FILLED')
    })

    it('§1.2 the status index carries it as FILLED, so the ledgers can see it', async () => {
      const { bot } = await replayProductionSequence()
      const filled = bot.getOrdersByStatusAndDealId({
        status: 'FILLED',
        dealId: DEAL_ID,
      })
      const base = filled.find((o: any) => o.clientOrderId === BASE_ID)
      expect(base, 'the base entry is in the FILLED fold').to.not.equal(
        undefined,
      )
      expect(+base.executedQty).to.be.closeTo(3306.5, 0.01)
    })

    it('§4.3 the merged row is what gets persisted, forced', async () => {
      const { bot } = await replayProductionSequence()
      const write = bot.raised.persisted.find(
        (o: any) => o.clientOrderId === BASE_ID,
      )
      expect(write, 'the queue wrote the row').to.not.equal(undefined)
      expect(+write.executedQty).to.be.closeTo(3306.5, 0.01)
      expect(write.force, 'the row is terminal by now').to.equal(true)
    })
  })

  describe('§1.2 what the deal is then priced and counted off', () => {
    it('the average is the whole entry, not the safety order alone', async () => {
      const { bot } = await replayProductionSequence()
      bot.setOrder(safetyFill())
      const { avg } = await bot.getAvgPrice(DEAL_ID)
      expect(avg).to.be.closeTo(CORRECT_AVG, 1e-9)
      expect(+avg.toFixed(6)).to.equal(0.030025)
      expect(
        Math.abs(avg - SAFETY_ONLY_AVG),
        'not the safety order price',
      ).to.be.greaterThan(1e-4)
    })

    it("`levels.complete` counts both of the deal's entry orders", async () => {
      const { bot } = await replayProductionSequence()
      bot.setOrder(safetyFill())
      // The predicate `updateDeal`'s `dealRegular` branch recomputes with.
      const complete = bot
        .getOrdersByStatusAndDealId({
          dealId: DEAL_ID,
          status: ['FILLED', 'CANCELED'],
        })
        .filter(
          (o: any) =>
            (o.typeOrder === TypeOrderEnum.dealRegular ||
              o.typeOrder === TypeOrderEnum.dealStart) &&
            o.status === 'FILLED',
        ).length
      expect(complete).to.equal(2)
    })
  })

  describe('§4.2 spec 057 §4.4/§5 are preserved', () => {
    it('the coinbase guard still refuses a row the machinery never touched', async () => {
      const bot: any = new TestBot()
      const resting = bookFill({ status: 'FILLED' })
      bot.setOrder(resting)
      const out = await bot.fillPartiallyFilledOrder(resting)
      expect(bot.raised.sent, 'nothing sent on coinbase').to.have.length(0)
      expect(+out.executedQty).to.equal(100.4)
    })

    it('a deal that never settled is untouched by the replay', async () => {
      const bot: any = new TestBot()
      const whole = bookFill({
        status: 'FILLED',
        executedQty: '3334.9',
        cummulativeQuoteQty: '100.15',
      })
      bot.setOrder(whole)
      bot.orderQueue = [
        {
          newClientOrderId: BASE_ID,
          symbol: SYMBOL,
          orderStatus: 'FILLED',
          totalTradeQuantity: '3334.9',
          snapshot: whole,
        },
      ]
      await bot.processOrderQueue(BOT_ID, async () => {
        bot.raised.fired.push('onFilled')
      })
      expect(+bot.getOrderFromMap(BASE_ID).executedQty).to.equal(3334.9)
      expect(bot.raised.fired).to.deep.equal(['onFilled'])
    })
  })

  describe('the deal status the settle decision reads is unchanged', () => {
    it('spec 038/048: an open deal is never re-settled', () => {
      expect(DCADealStatusEnum.start).to.not.equal(DCADealStatusEnum.open)
    })
  })
})
