process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `234.restart-never-asks-about-a-market-close-take-profit`.
 *
 * Drives the REAL restart branch of `checkOrders` on a deal that closes at
 * MARKET (`isDealForTPLevelCheck` true) holding a take-profit it sent before
 * the restart. Harness shape from `restartMidOrder.spec.ts` part 2.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b34'
const DEAL_ID = '000000000000000000000d34'
const SYMBOL = 'APEUSDT'
const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000

const NOT_FOUND = {
  status: StatusEnum.notok,
  reason: 'Order does not exist.',
  data: null,
}

let Helper: any

before(function () {
  this.timeout(240000)
  Helper = createRequire(__filename)('./dcaHelper').default()
})

describe('a restart asks the venue about a market-close take-profit (spec 234)', () => {
  const TP_GRID = {
    price: 0.0072,
    qty: 1500,
    side: OrderSideEnum.sell,
    newClientOrderId: 'x-TP-rebuilt-34',
    type: TypeOrderEnum.dealTP,
    dealId: DEAL_ID,
  } as any

  /** Sent before the restart; the write-ahead row never got an exchange id. */
  const inFlightTp = (over: Record<string, unknown> = {}) =>
    ({
      symbol: SYMBOL,
      clientOrderId: 'x-TP-000000000034',
      orderId: '-1',
      botId: BOT_ID,
      dealId: DEAL_ID,
      typeOrder: TypeOrderEnum.dealTP,
      type: 'MARKET',
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

  const venueSays = (status: string, executedQty: string) => ({
    status: StatusEnum.ok,
    reason: null,
    data: {
      ...inFlightTp(),
      orderId: '1380000000000034',
      status,
      executedQty,
      updateTime: TEN_MIN_AGO + 1000,
    },
  })

  const buildBot = (opts: { tp: any; venue: any; marketClose?: boolean }) => {
    const placed: any[] = []
    const saved: any[] = []
    const filled: any[] = []
    const partial: any[] = []
    const lookups: string[] = []
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
      filled = filled
      partial = partial
      lookups = lookups
      botId = BOT_ID
      loadingComplete = true
      serviceRestart = true
      secondRestart = false
      blockCheck = false
      data: any = {
        settings: { name: 'bot', pair: [SYMBOL] },
        status: 'open',
        exchange: 'bitget',
        flags: [],
        paperContext: false,
      }
      orders = new Map<string, any>([[opts.tp.clientOrderId, opts.tp]])
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
        return { dcaByMarket: true }
      }
      async getDiffForCheckOrders() {
        return { new: [], cancel: [] }
      }
      async baseAssetPrecision() {
        return 2
      }
      async isDealForTPLevelCheck() {
        return opts.marketClose ?? true
      }
      isOrderQuarantined() {
        return false
      }
      clearOrderStrikes() {}
      async getOrderForReconcile(o: any) {
        lookups.push(o.clientOrderId)
        return opts.venue
      }
      async mergeCommonOrderWithOrder(d: any, o: any) {
        return { ...o, ...d }
      }
      async processFilledOrder(o: any) {
        filled.push(o)
      }
      processPartiallyFilledOrder(o: any) {
        partial.push(o)
      }
      async adoptExchangeOrderId() {
        return false
      }
      async placeOrders(_b: string, _s: string, _d: string, orders: any) {
        placed.push(...orders.new)
      }
      async cancelOrderOnExchange() {}
      cbEmit() {}
      emit() {
        return true
      }
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

  it('§4.1 a FILLED answer is booked and goes through the fill path', async () => {
    const bot = buildBot({ tp: inFlightTp(), venue: venueSays('FILLED', '1500') })
    await bot.checkOrders(BOT_ID)
    expect(bot.lookups, 'asked the venue').to.deep.equal(['x-TP-000000000034'])
    expect(bot.filled.map((o: any) => [o.clientOrderId, o.status])).to.deep.equal(
      [['x-TP-000000000034', 'FILLED']],
    )
    expect(bot.saved.map((o: any) => o.status)).to.deep.equal(['FILLED'])
    expect(bot.placed).to.deep.equal([])
  })

  it('§4.2 a PARTIALLY_FILLED answer is booked as one', async () => {
    const bot = buildBot({
      tp: inFlightTp(),
      venue: venueSays('PARTIALLY_FILLED', '400'),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.partial.map((o: any) => o.status)).to.deep.equal([
      'PARTIALLY_FILLED',
    ])
    expect(bot.placed).to.deep.equal([])
  })

  it('§4.3 a CANCELED answer places nothing and leaves the order as it was', async () => {
    const bot = buildBot({ tp: inFlightTp(), venue: venueSays('CANCELED', '0') })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed).to.deep.equal([])
    expect(bot.saved).to.deep.equal([])
    expect(bot.orders.get('x-TP-000000000034').status).to.equal('NEW')
  })

  it('§4.4 a not-found answer retires nothing and places nothing', async () => {
    const bot = buildBot({ tp: inFlightTp(), venue: NOT_FOUND })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed).to.deep.equal([])
    expect(bot.saved).to.deep.equal([])
    expect(bot.orders.has('x-TP-000000000034')).to.equal(true)
  })

  it('§4.5 a LIMIT-close deal still re-places a CANCELED take-profit', async () => {
    const bot = buildBot({
      tp: inFlightTp({ type: 'LIMIT', orderId: '1380000000000034' }),
      venue: venueSays('CANCELED', '0'),
      marketClose: false,
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.saved.map((o: any) => o.status)).to.deep.equal(['CANCELED'])
    expect(bot.placed.length).to.be.greaterThan(0)
  })
})
