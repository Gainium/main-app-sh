process.env.NODE_ENV = 'testing'

/**
 * Spec 015 §2/§3/§7, integration-level: drives the REAL dcaHelper methods
 * (createDeal-equivalent seeding, getTPOrder/prepareTpOrder, closeDealById)
 * against real in-memory Mongo (specs/016's harness) with a stubbed
 * `this.exchange` — not a reimplementation of the sizing/retry logic.
 *
 * The bot instance is built by `Object.create`-ing the real dcaHelper
 * prototype (mirrors src/bot/openNewDealRefusal.harness.ts's precedent for
 * driving real bot-engine methods with no Redis/exchange connection), so
 * only the exchange-facing surface is mocked — everything this spec
 * actually changed (getBaseOrder's feeFactor, getTPOrder's quantity
 * multiplier, the sticky feeSizingFallback flag) runs for real, against a
 * real deal document in Mongo.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import MainBot from '../../src/bot/main'
import { MathHelper } from '../../src/utils/math'
import RedisClient from '../../src/db/redis'
// sendOrderToExchange's auth/backoff guards (RetryBackoff/AuthGuard) reach
// for RedisClient.getInstance() directly, independent of the bot instance —
// not one of the `bot.*` fields Object.create lets us stub per-instance.
// Both guards treat "no reading" as "not tripped" and continue, so a no-op
// stub is enough; it just must not try a real connection.
;(RedisClient as any).getInstance = async () => undefined
import { dcaDealsDb, comboDealsDb, orderDb } from '../../src/db/dbInit'
import {
  ExchangeEnum,
  StatusEnum,
  OrderSideEnum,
  TypeOrderEnum,
  DCADealStatusEnum,
  DCADealFlags,
  CloseDCATypeEnum,
  PositionSide,
  type Order,
  type CommonOrder,
} from '../../types'

const SYMBOL = 'BTCUSDT'
const BASE = 'BTC'
const QUOTE = 'USDT'
const BOT_ID = 'feeSizing-bot'
const USER_ID = 'feeSizing-user'

const exchangeInfo = {
  pair: SYMBOL,
  symbol: SYMBOL,
  baseAsset: {
    name: BASE,
    minAmount: 0.0001,
    maxAmount: 1000,
    step: 0.0001,
    maxMarketAmount: 1000,
  },
  quoteAsset: { name: QUOTE, minAmount: 5, maxAmount: 1000000 },
  priceAssetPrecision: 2,
  maxOrders: 200,
  priceMultiplier: { up: 10, down: 10, decimals: 2 },
}

/**
 * Builds a bot instance by `Object.create`-ing the real `createDCABotHelper`
 * prototype. Only the exchange/Redis/socket-facing surface is stubbed;
 * `this.orders`/`this.deals` and friends are the same in-memory index maps
 * the real bot process keeps, initialised empty here the way the real
 * constructor would (which this bypasses on purpose — no Redis connection).
 */
async function makeBot(
  openOrderStub: (req: any) => Promise<{
    status: StatusEnum
    reason: string | null
    data: CommonOrder | null
  }>,
  getOrderStub?: () => Promise<{
    status: StatusEnum
    reason: string | null
    data: CommonOrder | null
  }>,
) {
  const createDCABotHelper = (await import('../../src/bot/dcaHelper')).default
  const DCA = createDCABotHelper(MainBot as any)
  const bot: any = Object.create(DCA.prototype)

  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = 'dca'
  bot.loadingComplete = true
  bot.log = false
  bot.math = new MathHelper()
  bot.brokerCode = ''

  bot.data = {
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'exchange-uuid-1',
    paperContext: false,
    status: 'open',
    flags: [],
    settings: {
      pair: [SYMBOL],
      name: 'fee sizing harness',
    },
  }

  // In-memory indexes the real constructor sets up as class-field
  // initialisers — `Object.create` skips those, so they're set by hand.
  bot.orders = new Map<string, Order>()
  bot.ordersKeys = new Set<string>()
  bot.orderStatusMap = new Map()
  bot.orderDealMap = new Map()
  bot.orderStatuses = ['NEW', 'PARTIALLY_FILLED']
  bot.deals = new Map()
  bot.dealStatusMap = new Map()
  bot.dealSymbolMap = new Map()
  bot.processedFilled = new Map()
  bot.pendingClose = new Set()
  bot.allowToPlaceOrders = new Map()
  bot.dealTimersMap = new Map()
  bot.startTimeoutTime = new Map()
  bot.stopList = new Set()
  bot.pendingOrdersList = new Map()

  for (const [k, v] of [
    ['futures', false],
    ['coinm', false],
    ['isLong', true],
    ['combo', false],
    ['hedge', false],
    ['krakenSpot', false],
    ['okx', false],
    ['mexc', false],
    ['hyperliquid', false],
    ['useCompountReduce', false],
    ['scaleAr', false],
    ['tpAr', false],
    ['slAr', false],
    ['isBitget', false],
    ['sizedInContracts', false],
    ['kucoinFutures', false],
    ['kucoinSpot', false],
    ['kucoinFullFutures', false],
    ['closeAfterTpFilled', false],
    ['slippageRetry', 3],
    ['orderLimitRepositionTimeout', 0],
    ['enterMarketTimeout', 0],
    ['feeOrder', false],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }

  // Logging / lifecycle — no-ops.
  bot.startMethod = () => 'x'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleDebug = () => undefined
  bot.handleError = () => undefined
  const errors: string[] = []
  bot.handleErrors = async (e: Error | string) => {
    errors.push(typeof e === 'string' ? e : e.message)
  }
  bot.handleOrderErrors = async (e: Error | string) => {
    errors.push(typeof e === 'string' ? e : e.message)
  }
  bot.emit = () => undefined
  bot.markDealStartBlocked = async () => undefined

  // Redis / stream — no real connection.
  bot.setOrdersToRedis = () => undefined
  bot.setDealToRedis = () => undefined
  bot.setToRedis = () => undefined
  bot.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  bot.saveOrderToDb = async (order: Order) => {
    await orderDb.createData(order as any)
  }

  // Aggregated settings / exchange info / fee — fixed, spot, long, simple.
  bot.getAggregatedSettings = async () => ({
    pair: SYMBOL,
    useMultiTp: false,
    useMultiSl: false,
    profitCurrency: 'quote',
    orderFixedIn: 'quote',
    terminalDealType: undefined,
    useRiskReward: false,
  })
  bot.getExchangeInfo = async () => exchangeInfo
  bot.getUserFee = async () => ({ maker: 0.001, taker: 0.001 })
  bot.getUsdRate = async () => 1
  bot.getLatestPrice = async () => 50000
  bot.profitBase = async () => false
  bot.checkAssets = async () => new Map()

  bot.dealsDb = dcaDealsDb
  bot.ordersDb = orderDb
  bot.botEventDb = { createData: async () => undefined }
  bot.ratesDb = {
    readData: async () => ({
      status: StatusEnum.notok,
      reason: 'n/a',
      data: null,
    }),
  }

  bot.exchange = {
    openOrder: openOrderStub,
    getAllPrices: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: [],
    }),
    getBalance: async () => ({ status: StatusEnum.ok, reason: null, data: [] }),
    getOrder:
      getOrderStub ??
      (async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found',
        data: null,
      })),
  }

  return { bot, errors }
}

/** Seeds a deal directly — matches what `createDeal` writes for the fields
 * this spec's mechanism reads, without driving `createDeal`'s own
 * settings-derivation (unrelated to what specs 014/015 changed). */
async function seedDeal() {
  const created = await dcaDealsDb.createData({
    flags: [DCADealFlags.newMultiTp, DCADealFlags.feeByAsset],
    botId: BOT_ID,
    userId: USER_ID,
    status: DCADealStatusEnum.open,
    initialBalances: { base: 0, quote: 0 },
    currentBalances: { base: 0.01, quote: 0 },
    initialPrice: 50000,
    avgPrice: 50000,
    displayAvg: 50000,
    lastPrice: 50000,
    profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    feePaid: { base: 0, quote: 0 },
    commission: 0,
    createTime: Date.now(),
    updateTime: Date.now(),
    levels: { all: 5, complete: 0 },
    usage: { current: { base: 0, quote: 0 }, max: { base: 0, quote: 0 } },
    assets: {
      used: { base: 0, quote: 0 },
      required: { base: 0, quote: 0 },
    },
    settings: {
      pair: SYMBOL,
      baseOrderSize: '500',
      orderSize: '500',
      strategy: 'long',
      tpPerc: '1',
      orderSizeType: 'quote',
    },
    parentId: null,
    childIds: [],
    parent: false,
    child: false,
    gridBreakpoints: [],
    paperContext: false,
    symbol: { symbol: SYMBOL, baseAsset: BASE, quoteAsset: QUOTE },
    stats: {
      drawdownPercent: 0,
      runUpPercent: 0,
      timeInProfit: 0,
      timeInLoss: 0,
      trackTime: 0,
      timeCountStart: Date.now(),
      unrealizedProfit: 0,
      usage: 0,
      maxUsage: 0,
    },
  } as any)
  expect(created.status).to.equal(StatusEnum.ok)
  return `${created.data!._id}`
}

/** A FILLED base order — the "mocked exchange response". */
function filledBaseOrder(
  dealId: string,
  overrides: Partial<Order> = {},
): Order {
  return {
    clientOrderId: 'D-BO-1',
    orderId: 'venue-order-1',
    symbol: SYMBOL,
    price: '50000',
    origPrice: '50000',
    origQty: '0.01',
    executedQty: '0.01',
    cummulativeQuoteQty: '500',
    status: 'FILLED',
    type: 'MARKET',
    side: OrderSideEnum.buy,
    typeOrder: TypeOrderEnum.dealStart,
    botId: BOT_ID,
    userId: USER_ID,
    dealId,
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'exchange-uuid-1',
    baseAsset: BASE,
    quoteAsset: QUOTE,
    updateTime: Date.now(),
    positionSide: PositionSide.BOTH,
    ...overrides,
  } as Order
}

describe('Spec 015: TP dust avoidance and two-stage placement (integration)', () => {
  afterEach(async () => {
    await dcaDealsDb.deleteManyData({})
    await comboDealsDb.deleteManyData({})
    await orderDb.deleteManyData({})
  })

  // §2/§3 — a deal whose only fill so far paid its fee entirely in a third
  // asset (BNB) gets a TP sized with NO gross-up: same size as what the
  // base order actually filled.
  it('a base order filled with a third-asset fee produces a TP the same size as the base order', async () => {
    const { bot } = await makeBot(async () => {
      throw new Error('exchange.openOrder should not be called by this test')
    })
    const dealId = await seedDeal()
    const baseOrder = filledBaseOrder(dealId, {
      feePaid: '0.0003',
      feeAsset: 'BNB',
    })
    bot.setOrder(baseOrder)
    await orderDb.createData(baseOrder as any)

    const findDeal = {
      deal: (await dcaDealsDb.readData({ _id: dealId }))!.data!.result,
      initialOrders: [],
      currentOrders: [],
      previousOrders: [],
      closeBySl: false,
      notCheckSl: false,
      closeByTp: false,
    }
    bot.setDeal(findDeal)

    const tpOrders = await bot.getTPOrder(
      SYMBOL,
      50000,
      [],
      50000,
      50000,
      dealId,
      findDeal.deal,
      true,
      false,
      50000,
    )
    expect(tpOrders?.length).to.be.greaterThan(0)
    const tp = tpOrders[0]
    // No gross-up / no fee shave: the TP asks for exactly what the base
    // order filled, not filledQty * (1 ± fee).
    expect(tp.qty).to.equal(0.01)
  })

  // Same setup, but the fee was paid in the QUOTE asset (on-pair) — the
  // existing gross-up must still apply, proving §2's zeroing is gated on
  // "third-asset only", not firing unconditionally for every new-flagged
  // deal.
  it('a base order filled with an on-pair fee keeps the existing gross-up', async () => {
    const { bot } = await makeBot(async () => {
      throw new Error('exchange.openOrder should not be called by this test')
    })
    const dealId = await seedDeal()
    const baseOrder = filledBaseOrder(dealId, {
      feePaid: '0.5',
      feeAsset: QUOTE,
    })
    bot.setOrder(baseOrder)
    await orderDb.createData(baseOrder as any)

    const findDeal = {
      deal: (await dcaDealsDb.readData({ _id: dealId }))!.data!.result,
      initialOrders: [],
      currentOrders: [],
      previousOrders: [],
      closeBySl: false,
      notCheckSl: false,
      closeByTp: false,
    }
    bot.setDeal(findDeal)

    const tpOrders = await bot.getTPOrder(
      SYMBOL,
      50000,
      [],
      50000,
      50000,
      dealId,
      findDeal.deal,
      true,
      false,
      50000,
    )
    const tp = tpOrders[0]
    expect(tp.qty).to.not.equal(0.01)
  })

  // §7 — the real-fee-sized TP is rejected (balance-shaped); the fallback
  // resends at the account-rate (estimated) size. Fork A: the resend is
  // accepted → the sticky flag is CONFIRMED. Fork B: the resend is also
  // rejected → the flag stays PENDING, never confirmed.
  describe('two-stage placement on a size-shaped rejection', () => {
    async function driveClose(secondAttemptSucceeds: boolean) {
      let calls = 0
      const { bot, errors } = await makeBot(async () => {
        calls++
        if (calls === 1) {
          return {
            status: StatusEnum.notok,
            reason: 'Account has insufficient balance for requested action.',
            data: null,
          }
        }
        if (secondAttemptSucceeds) {
          return {
            status: StatusEnum.ok,
            reason: null,
            data: {
              symbol: SYMBOL,
              orderId: 'venue-order-2',
              clientOrderId: 'D-TP-1ef',
              updateTime: Date.now(),
              price: '50500',
              origQty: '0.01',
              executedQty: '0',
              status: 'NEW',
              type: 'LIMIT',
              side: OrderSideEnum.sell,
            } as CommonOrder,
          }
        }
        return {
          status: StatusEnum.notok,
          reason: 'Account has insufficient balance for requested action.',
          data: null,
        }
      })

      const dealId = await seedDeal()
      const baseOrder = filledBaseOrder(dealId, {
        feePaid: '0.0003',
        feeAsset: 'BNB',
      })
      bot.setOrder(baseOrder)
      await orderDb.createData(baseOrder as any)

      const findDeal = {
        deal: (await dcaDealsDb.readData({ _id: dealId }))!.data!.result,
        initialOrders: [],
        currentOrders: [],
        previousOrders: [],
        closeBySl: false,
        notCheckSl: false,
        closeByTp: false,
      }
      bot.setDeal(findDeal)

      await bot.closeDealById(
        BOT_ID,
        dealId,
        CloseDCATypeEnum.closeByMarket,
        false,
      )

      // Not a fresh DB read: saveDeal's Mongo write is fire-and-forget
      // (.then(), never awaited — a pre-existing characteristic of this
      // legacy method, not something spec 015 introduced). The in-memory
      // this.deals cache is what saveDeal updates SYNCHRONOUSLY and what
      // every production caller actually reads back through; a DB read
      // here would race the real write and flake.
      const deal = bot.getDeal(dealId)?.deal
      return { calls, errors, deal }
    }

    it('fork A — the estimated-fee resend succeeds: the sticky flag is confirmed', async () => {
      const { calls, errors, deal } = await driveClose(true)
      // Real-fee attempt rejected, one resend at the estimated size — never
      // a third attempt.
      expect(calls).to.equal(2)
      expect(deal.feeSizingFallback?.status).to.equal('confirmed')
      expect(deal.feeSizingFallback?.confirmedAt).to.be.a('number')
      // §7.3 — confirming also raises the one signal an operator sees.
      expect(errors.some((e) => e.includes('confirmed wrong'))).to.equal(true)
    })

    it('fork B — the estimated-fee resend also fails: the sticky flag is not confirmed', async () => {
      const { calls, errors, deal } = await driveClose(false)
      expect(calls).to.equal(2)
      // §7.3 — written PENDING before the resend, left there (not confirmed,
      // not cleared) when the resend fails too: two rejections in a row
      // don't prove the fee assumption was at fault.
      expect(deal.feeSizingFallback?.status).to.equal('pending')
      expect(deal.feeSizingFallback?.confirmedAt).to.equal(undefined)
      expect(errors.some((e) => e.includes('confirmed wrong'))).to.equal(false)
    })
  })

  // Spec 015 §10 scenario 3 / §7.2: a rejection that is NEITHER balance-
  // shaped NOR notional-shaped must not trigger §7 at all — a regression
  // guard against isFeeSizingRejection's classifier being too broad.
  it('a real-fee TP rejected for an UNRELATED reason does not trigger the fallback', async () => {
    let calls = 0
    const { bot, errors } = await makeBot(async () => {
      calls++
      return {
        status: StatusEnum.notok,
        reason: 'Invalid API-key, IP, or permissions for action.',
        data: null,
      }
    })

    const dealId = await seedDeal()
    const baseOrder = filledBaseOrder(dealId, {
      feePaid: '0.0003',
      feeAsset: 'BNB',
    })
    bot.setOrder(baseOrder)
    await orderDb.createData(baseOrder as any)

    const findDeal = {
      deal: (await dcaDealsDb.readData({ _id: dealId }))!.data!.result,
      initialOrders: [],
      currentOrders: [],
      previousOrders: [],
      closeBySl: false,
      notCheckSl: false,
      closeByTp: false,
    }
    bot.setDeal(findDeal)

    await bot.closeDealById(
      BOT_ID,
      dealId,
      CloseDCATypeEnum.closeByMarket,
      false,
    )

    // No resend — the rejection reason never matched isFeeSizingRejection.
    expect(calls).to.equal(1)
    expect(bot.getDeal(dealId)?.deal.feeSizingFallback).to.equal(undefined)
    // Falls through to the existing generic handling instead.
    expect(
      errors.some((e) => e.includes('Invalid API-key, IP, or permissions')),
    ).to.equal(true)
    expect(errors.some((e) => e.includes('confirmed wrong'))).to.equal(false)
  })

  // Spec 015 §8 item 3 / §10 scenario 4: the real-fee attempt's own venue
  // fate is checked BEFORE resending. A network timeout on that attempt
  // (request sent, response lost) is not the same as a clean rejection —
  // resending blind risks a second live TP landing on top of one that
  // actually reached the venue. Here the rejection is balance-shaped (would
  // otherwise trigger the fallback), but the status check finds the
  // real-fee order alive on the venue, so the fallback must abort instead
  // of firing a resend.
  it('a size-shaped rejection does not resend when the real-fee order is found live on the venue', async () => {
    let calls = 0
    const { bot, errors } = await makeBot(
      async () => {
        calls++
        return {
          status: StatusEnum.notok,
          reason: 'Account has insufficient balance for requested action.',
          data: null,
        }
      },
      // The status check: the real-fee order is NOT "definitively not
      // found" — it's actually resting live on the venue.
      async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: {
          symbol: SYMBOL,
          orderId: 'venue-order-1-actually-landed',
          clientOrderId: 'D-TP-1rf',
          updateTime: Date.now(),
          price: '50500',
          origQty: '0.01',
          executedQty: '0',
          status: 'NEW',
          type: 'LIMIT',
          side: OrderSideEnum.sell,
        } as CommonOrder,
      }),
    )

    const dealId = await seedDeal()
    const baseOrder = filledBaseOrder(dealId, {
      feePaid: '0.0003',
      feeAsset: 'BNB',
    })
    bot.setOrder(baseOrder)
    await orderDb.createData(baseOrder as any)

    const findDeal = {
      deal: (await dcaDealsDb.readData({ _id: dealId }))!.data!.result,
      initialOrders: [],
      currentOrders: [],
      previousOrders: [],
      closeBySl: false,
      notCheckSl: false,
      closeByTp: false,
    }
    bot.setDeal(findDeal)

    await bot.closeDealById(
      BOT_ID,
      dealId,
      CloseDCATypeEnum.closeByMarket,
      false,
    )

    // Only the original real-fee attempt — the ambiguous-outcome check
    // aborted before any resend was sent.
    expect(calls).to.equal(1)
    // Written pending BEFORE the status check runs (§7.3), and never
    // confirmed since no resend ever happened.
    expect(bot.getDeal(dealId)?.deal.feeSizingFallback?.status).to.equal(
      'pending',
    )
    expect(errors.some((e) => e.includes('confirmed wrong'))).to.equal(false)
  })

  // Spec 015 §4/§7.4, extended to combo on review: getTPOrder's combo
  // branch sizes its TP off a balance-based formula, not the plain path's
  // multiplier — but it was still subtracting the account-rate ESTIMATE
  // (filled.reduce(qty * maxFee)) unconditionally, the same gap the plain
  // path had. Both call sites reuse tpQuantityFeeIsThirdAssetOnly, so
  // combo gets the same zeroing and two-stage fallback as DCA for free.
  describe('combo', () => {
    async function seedComboDeal() {
      const created = await comboDealsDb.createData({
        flags: [DCADealFlags.feeByAsset],
        botId: BOT_ID,
        userId: USER_ID,
        status: DCADealStatusEnum.open,
        initialBalances: { base: 0, quote: 0 },
        currentBalances: { base: 0.01, quote: 0 },
        initialPrice: 50000,
        avgPrice: 50000,
        displayAvg: 50000,
        lastPrice: 50000,
        profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
        feePaid: { base: 0, quote: 0 },
        commission: 0,
        createTime: Date.now(),
        updateTime: Date.now(),
        levels: { all: 5, complete: 0 },
        usage: { current: { base: 0, quote: 0 }, max: { base: 0, quote: 0 } },
        assets: {
          used: { base: 0, quote: 0 },
          required: { base: 0, quote: 0 },
        },
        settings: {
          pair: SYMBOL,
          baseOrderSize: '500',
          orderSize: '500',
          strategy: 'long',
          tpPerc: '1',
          orderSizeType: 'quote',
        },
        parentId: null,
        childIds: [],
        parent: false,
        child: false,
        gridBreakpoints: [],
        paperContext: false,
        symbol: { symbol: SYMBOL, baseAsset: BASE, quoteAsset: QUOTE },
        stats: {
          drawdownPercent: 0,
          runUpPercent: 0,
          timeInProfit: 0,
          timeInLoss: 0,
          trackTime: 0,
          timeCountStart: Date.now(),
          unrealizedProfit: 0,
          usage: 0,
          maxUsage: 0,
        },
      } as any)
      expect(created.status).to.equal(StatusEnum.ok)
      return `${created.data!._id}`
    }

    it('a combo TP is sized with NO fee subtraction when the base order fee was third-asset', async () => {
      const { bot } = await makeBot(async () => {
        throw new Error('exchange.openOrder should not be called by this test')
      })
      Object.defineProperty(bot, 'combo', {
        value: true,
        configurable: true,
      })
      bot.dealsDb = comboDealsDb

      const dealId = await seedComboDeal()
      const baseOrder = filledBaseOrder(dealId, {
        feePaid: '0.0003',
        feeAsset: 'BNB',
      })
      bot.setOrder(baseOrder)
      await orderDb.createData(baseOrder as any)

      const findDeal = {
        deal: (await comboDealsDb.readData({ _id: dealId }))!.data!.result,
        initialOrders: [],
        currentOrders: [],
        previousOrders: [],
        closeBySl: false,
        notCheckSl: false,
        closeByTp: false,
      }
      bot.setDeal(findDeal)

      const tpOrders = await bot.getTPOrder(
        SYMBOL,
        50000,
        [],
        50000,
        50000,
        dealId,
        findDeal.deal,
        true,
        false,
        50000,
      )
      const tp = tpOrders[0]
      // The balance-based formula's qty is currentBalances.base (0.01) minus
      // the fee subtraction — no estimate subtracted means qty stays 0.01.
      expect(tp.qty).to.equal(0.01)
    })

    it('a combo TP rejected as size-shaped still falls back to the estimate size and confirms the sticky flag', async () => {
      let calls = 0
      const { bot, errors } = await makeBot(async () => {
        calls++
        if (calls === 1) {
          return {
            status: StatusEnum.notok,
            reason: 'Account has insufficient balance for requested action.',
            data: null,
          }
        }
        return {
          status: StatusEnum.ok,
          reason: null,
          data: {
            symbol: SYMBOL,
            orderId: 'venue-order-2',
            clientOrderId: 'D-TP-1ef',
            updateTime: Date.now(),
            price: '50500',
            origQty: '0.01',
            executedQty: '0',
            status: 'NEW',
            type: 'LIMIT',
            side: OrderSideEnum.sell,
          } as CommonOrder,
        }
      })
      Object.defineProperty(bot, 'combo', {
        value: true,
        configurable: true,
      })
      bot.dealsDb = comboDealsDb

      const dealId = await seedComboDeal()
      const baseOrder = filledBaseOrder(dealId, {
        feePaid: '0.0003',
        feeAsset: 'BNB',
      })
      bot.setOrder(baseOrder)
      await orderDb.createData(baseOrder as any)

      const findDeal = {
        deal: (await comboDealsDb.readData({ _id: dealId }))!.data!.result,
        initialOrders: [],
        currentOrders: [],
        previousOrders: [],
        closeBySl: false,
        notCheckSl: false,
        closeByTp: false,
      }
      bot.setDeal(findDeal)

      await bot.closeDealById(
        BOT_ID,
        dealId,
        CloseDCATypeEnum.closeByMarket,
        false,
      )

      expect(calls).to.equal(2)
      expect(bot.getDeal(dealId)?.deal.feeSizingFallback?.status).to.equal(
        'confirmed',
      )
      expect(errors.some((e) => e.includes('confirmed wrong'))).to.equal(true)
    })
  })
})
