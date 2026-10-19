process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `177.a-restart-mid-order-strands-a-filled-entry-and-a-never-placed-take-profit`.
 *
 * Part 1 drives the REAL DCA `restoreWork` on a `start` deal whose entry the
 * order map (restored from the Redis snapshot) holds FILLED while its Mongo
 * row still says NEW. Harness shape from `restartUnsentBaseOrder.spec.ts`.
 *
 * Part 2 drives the REAL restart branch of `checkOrders` and the REAL
 * `noteOrderNotFound` on a take-profit still at the `-1` placeholder. Harness
 * shape from `restartMidDealStart.spec.ts` part 2.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, StatusEnum, TypeOrderEnum } from '../../types'
import { neverPlacedOrderRetireMinAgeMs } from './main'

const BOT_ID = '000000000000000000000b77'
const DEAL_ID = '000000000000000000000d77'
const SYMBOL = 'APEUSDT'
const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

const NOT_FOUND = {
  status: StatusEnum.notok,
  reason: 'Order does not exist.',
  data: null,
}
const KUCOIN_NOT_FOUND = {
  status: StatusEnum.notok,
  reason: 'validation.queryOrder.orderNotExist | 400100',
  data: null,
}
const TIMEOUT = {
  status: StatusEnum.notok,
  reason: 'timeout of 30000ms exceeded',
  data: null,
}

let Helper: any

before(function () {
  // One ts-node compile of the DCA mixin and everything under it.
  this.timeout(240000)
  Helper = createRequire(__filename)('./dcaHelper').default()
})

describe('a restart books an entry the bot already knew had filled (spec 177 §1.1)', () => {
  /** The entry as the snapshot holds it: the venue's FILLED report. */
  const filledEntry = (over: Record<string, unknown> = {}) =>
    ({
      symbol: SYMBOL,
      clientOrderId: 'x-BO-000000000077',
      orderId: '5500000077',
      botId: BOT_ID,
      dealId: DEAL_ID,
      typeOrder: TypeOrderEnum.dealStart,
      type: 'MARKET',
      side: 'BUY',
      price: '0.13745',
      origQty: '44.62',
      executedQty: '44.41',
      status: 'FILLED',
      transactTime: TEN_MIN_AGO,
      updateTime: TEN_MIN_AGO,
      ...over,
    }) as any

  /** Its Mongo row: the FILLED write died with the process. */
  const staleRow = {
    symbol: SYMBOL,
    clientOrderId: 'x-BO-000000000077',
    orderId: '-1',
    typeOrder: TypeOrderEnum.dealStart,
    status: 'NEW',
    executedQty: '0',
    updateTime: TEN_MIN_AGO,
  }

  const buildBot = (opts: {
    order: any
    venue: any
    row?: any
    serviceRestart?: boolean
  }) => {
    const raised = {
      started: [] as any[],
      checked: [] as string[],
      saved: [] as any[],
      lookups: [] as string[],
      logs: [] as string[],
    }
    const row = opts.row ?? staleRow
    class TestBot extends (Helper as any) {
      raised = raised
      botId = BOT_ID
      userId = '000000000000000000000a77'
      combo = false
      loadingComplete = true
      serviceRestart = opts.serviceRestart ?? true
      secondRestart = false
      exchange = {}
      data: any = {
        settings: { name: 'bot', pair: [SYMBOL] },
        status: 'open',
        exchange: 'bybit',
        flags: [],
        paperContext: false,
      }
      sharedStream = { addOrder() {}, removeOrder() {} }
      ordersDb = {
        readData: async (q: any, _f?: any, _o?: any, isArray?: boolean) => {
          const hit =
            q.clientOrderId === row.clientOrderId ||
            (q.dealId === DEAL_ID && q.typeOrder === TypeOrderEnum.dealStart)
              ? [row]
              : []
          return {
            status: StatusEnum.ok,
            data: { result: isArray ? hit : hit[0] },
          }
        },
      }
      async getOrderForReconcile(o: any) {
        raised.lookups.push(o.clientOrderId)
        return opts.venue
      }
      async mergeCommonOrderWithOrder(d: any, o: any) {
        return { ...o, ...d }
      }
      async startDeal(o: any) {
        raised.started.push(o)
      }
      async checkBaseOrder(_b: string, _s: string, id: string) {
        raised.checked.push(id)
      }
      updateOrderOnDb(o: any) {
        raised.saved.push({ ...o })
      }
      async closeDealById() {}
      setOrdersToRedis() {}
      shouldProceed() {
        return true
      }
      isBaseFundingDeal() {
        return false
      }
      calculateBotDeals() {}
      async getAggregatedSettings() {
        return { type: 'regular', startCondition: 'ASAP' }
      }
      async getSymbolsToOpenAsapDeals() {
        return []
      }
      async checkOrders() {}
      async cancelAllOrder() {}
      async clearAllOrderQuarantine() {}
      getOpenDeals() {
        return [
          {
            deal: {
              _id: DEAL_ID,
              botId: BOT_ID,
              status: 'start',
              symbol: { symbol: SYMBOL },
            },
            initialOrders: [],
            currentOrders: [],
          },
        ]
      }
      getDeal() {
        return this.getOpenDeals()[0]
      }
      async setCloseByTimer() {}
      async resumeTrailingCloseRetry() {}
      resumeBaseEntryRemainder() {}
      async restoreSettledBaseEntryAverage() {}
      updateDealBalances() {}
      async checkPlaceOrders() {}
      updateDealLastPrices() {}
      async openNewDeal() {}
      startTimeBasedTrigger() {}
      async startIndicatorInit() {}
      calculateBotBalances() {}
      async calculateUsage() {}
      emit() {
        return true
      }
      handleLog(m: string) {
        raised.logs.push(m)
      }
      handleWarn(m: string) {
        raised.logs.push(m)
      }
      handleDebug() {}
      handleErrors(m: string) {
        raised.logs.push(m)
      }
      startMethod() {
        return '1'
      }
      endMethod() {}
    }
    const bot = new (TestBot as any)()
    bot.setOrder(opts.order, false)
    return bot
  }

  it('§1.1.1 a FILLED map copy over a NEW row is confirmed with the venue, saved and booked', async () => {
    const bot = buildBot({
      order: filledEntry(),
      venue: { status: StatusEnum.ok, data: { status: 'FILLED' } },
    })
    await bot.restoreWork()
    expect(bot.raised.lookups).to.deep.equal(['x-BO-000000000077'])
    expect(bot.raised.checked, 'not handed to checkBaseOrder').to.deep.equal([])
    expect(bot.raised.started.map((o: any) => [o.clientOrderId, o.status])).to
      .deep.equal([['x-BO-000000000077', 'FILLED']])
    expect(bot.raised.saved.map((o: any) => o.status)).to.deep.equal(['FILLED'])
  })

  it('§1.1.3 a venue that cannot be read leaves the FILLED report standing', async () => {
    const bot = buildBot({ order: filledEntry(), venue: TIMEOUT })
    await bot.restoreWork()
    expect(bot.raised.started.map((o: any) => o.executedQty)).to.deep.equal([
      '44.41',
    ])
  })

  it('§1.1.3 a venue that contradicts the snapshot wins, and checkBaseOrder runs on it', async () => {
    const bot = buildBot({
      order: filledEntry(),
      venue: {
        status: StatusEnum.ok,
        data: { status: 'NEW', executedQty: '0' },
      },
    })
    await bot.restoreWork()
    expect(bot.raised.started).to.deep.equal([])
    expect(bot.raised.checked).to.deep.equal(['x-BO-000000000077'])
    expect(bot.getOrderFromMap('x-BO-000000000077').status).to.equal('NEW')
  })

  it('§1.1.4 a NEW map copy keeps the checkBaseOrder path, with no extra lookup', async () => {
    const bot = buildBot({
      order: filledEntry({ status: 'NEW', executedQty: '0', orderId: '-1' }),
      venue: NOT_FOUND,
    })
    await bot.restoreWork()
    expect(bot.raised.lookups).to.deep.equal([])
    expect(bot.raised.checked).to.deep.equal(['x-BO-000000000077'])
    expect(bot.raised.started).to.deep.equal([])
  })

  it('§1.1.4 a user start keeps the checkBaseOrder path', async () => {
    const bot = buildBot({
      order: filledEntry(),
      venue: NOT_FOUND,
      serviceRestart: false,
    })
    await bot.restoreWork()
    expect(bot.raised.lookups).to.deep.equal([])
    expect(bot.raised.started).to.deep.equal([])
  })
})

describe('a take-profit the venue never received is placed again (spec 177 §1.2)', () => {
  /** The deal's grid rebuilds the same take-profit. */
  const TP_GRID = {
    number: 0,
    price: 0.0072,
    qty: 1500,
    side: OrderSideEnum.sell,
    newClientOrderId: 'x-TP-rebuilt-77',
    type: TypeOrderEnum.dealTP,
    dealId: DEAL_ID,
  } as any

  /** Sent, write-ahead row saved, but no exchange id ever came back. */
  const phantomTp = (over: Record<string, unknown> = {}) =>
    ({
      symbol: SYMBOL,
      clientOrderId: 'x-TP-000000000077',
      orderId: '-1',
      botId: BOT_ID,
      dealId: DEAL_ID,
      typeOrder: TypeOrderEnum.dealTP,
      side: 'SELL',
      price: '0.0072',
      origPrice: '0.0072',
      origQty: '1500',
      executedQty: '0',
      status: 'NEW',
      transactTime: TEN_MIN_AGO,
      updateTime: TEN_MIN_AGO,
      ...over,
    }) as any

  const buildBot = (opts: { tp: any; venue: any; dcaByMarket?: boolean }) => {
    const placed: any[] = []
    const saved: any[] = []
    const deal = {
      deal: {
        _id: DEAL_ID,
        botId: BOT_ID,
        status: 'open',
        symbol: { symbol: SYMBOL },
        tpSlTargetFilled: [],
      },
      initialOrders: [TP_GRID],
      currentOrders: [TP_GRID],
      previousOrders: [],
    }
    class TestBot extends (Helper as any) {
      placed = placed
      saved = saved
      botId = BOT_ID
      loadingComplete = true
      serviceRestart = true
      secondRestart = false
      blockCheck = false
      data: any = {
        settings: { name: 'bot', pair: [SYMBOL] },
        status: 'open',
        exchange: 'binance',
        flags: [],
        paperContext: false,
      }
      orders = new Map<string, any>([[opts.tp.clientOrderId, opts.tp]])
      // The write-ahead row exists, so spec 172's no-row drop does not apply.
      ordersDb = {
        readData: async () => ({
          status: StatusEnum.ok,
          data: { result: { _id: 'row' } },
        }),
      }
      shouldProceed() {
        return true
      }
      getDeal(id?: string) {
        return id === DEAL_ID ? deal : undefined
      }
      setOrder(o: any) {
        this.orders.set(o.clientOrderId, o)
      }
      deleteOrder(id: string) {
        this.orders.delete(id)
      }
      updateOrderOnDb(o: any) {
        saved.push({ ...o })
      }
      getOrdersByStatusAndDealId() {
        return []
      }
      async getAggregatedSettings() {
        return { dcaByMarket: opts.dcaByMarket ?? true }
      }
      async getDiffForCheckOrders() {
        return { new: [], cancel: [] }
      }
      async baseAssetPrecision() {
        return 2
      }
      async isDealForTPLevelCheck() {
        return false
      }
      isOrderQuarantined() {
        return false
      }
      clearOrderStrikes() {}
      async getOrderForReconcile() {
        return opts.venue
      }
      async placeOrders(_b: string, _s: string, _d: string, orders: any) {
        placed.push(...orders.new)
      }
      async cancelOrderOnExchange() {}
      cbEmit() {}
      handleLog() {}
      handleDebug() {}
      handleWarn() {}
      handleErrors() {}
      startMethod() {
        return '1'
      }
      endMethod() {}
    }
    return new (TestBot as any)()
  }

  it('§1.2.1 a -1 take-profit the venue denies is retired and placed again', async () => {
    const bot = buildBot({ tp: phantomTp(), venue: NOT_FOUND })
    await bot.checkOrders(BOT_ID)
    expect(bot.orders.has('x-TP-000000000077'), 'retired').to.equal(false)
    expect(bot.saved.map((o: any) => o.status)).to.deep.equal(['CANCELED'])
    expect(bot.placed.map((g: any) => [g.side, g.price, g.qty])).to.deep.equal([
      [TP_GRID.side, TP_GRID.price, TP_GRID.qty],
    ])
  })

  it('§1.2.4 a -1 safety order the venue denies is retired and sent again', async () => {
    const so = phantomTp({
      clientOrderId: 'x-SO-000000000077',
      typeOrder: TypeOrderEnum.dealRegular,
      side: 'BUY',
      price: '0.0065',
      origPrice: '0.0065',
    })
    const bot = buildBot({ tp: so, venue: NOT_FOUND, dcaByMarket: false })
    await bot.checkOrders(BOT_ID)
    expect(bot.orders.has('x-SO-000000000077'), 'retired').to.equal(false)
    // (The fixture deal also rests no take-profit, so that is placed too.)
    expect(
      bot.placed
        .filter((g: any) => g.side === OrderSideEnum.buy)
        .map((g: any) => [g.side, g.price, g.qty]),
    ).to.deep.equal([[OrderSideEnum.buy, 0.0065, 1500]])
  })

  it('§1.2.3 a take-profit with a real exchange id is not retired', async () => {
    const bot = buildBot({ tp: phantomTp({ orderId: '987654' }), venue: NOT_FOUND })
    await bot.checkOrders(BOT_ID)
    expect(bot.orders.has('x-TP-000000000077')).to.equal(true)
    expect(bot.placed).to.deep.equal([])
    expect(bot.saved.map((o: any) => o.status)).to.deep.equal([])
  })

  it('§1.2.3 KuCoin orderNotExist keeps the 24h floor', async () => {
    const bot = buildBot({ tp: phantomTp(), venue: KUCOIN_NOT_FOUND })
    await bot.checkOrders(BOT_ID)
    expect(bot.orders.has('x-TP-000000000077')).to.equal(true)
    expect(bot.placed).to.deep.equal([])
  })

  it('§1.2.3 a take-profit younger than the short floor is not judged', async () => {
    const now = Date.now() - 60_000
    const bot = buildBot({
      tp: phantomTp({ transactTime: now, updateTime: now }),
      venue: NOT_FOUND,
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.orders.has('x-TP-000000000077')).to.equal(true)
    expect(bot.placed).to.deep.equal([])
  })

  it('§1.2.1/§1.2.3 the floor is short only for a trustworthy not-found', () => {
    const short = neverPlacedOrderRetireMinAgeMs('Order does not exist.')
    expect(short).to.be.below(DAY)
    expect(short).to.equal(5 * 60 * 1000)
    expect(
      neverPlacedOrderRetireMinAgeMs(KUCOIN_NOT_FOUND.reason),
    ).to.equal(DAY)
    expect(neverPlacedOrderRetireMinAgeMs('unknownOid')).to.equal(DAY)
  })
})
