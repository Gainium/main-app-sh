process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `102.okx-linear-fill-value-is-booked-in-contracts`.
 *
 * OKX sizes USDT-margined swaps in contracts of `ctVal` base units, and both
 * the connector (`getOrder` / placement answer) and the user stream state the
 * filled value as `avgPx × accFillSz` — a count of CONTRACTS. The engine
 * converted `executedQty` to base and stored the quote as stated, so the row's
 * `cummulativeQuoteQty` was off by `1 / ctVal`: 1000× on gold (`ctVal 0.001`),
 * and far too SMALL where `ctVal > 1`.
 *
 * Drives the REAL `getOrder`, `convertExecutionReportToOrder` and
 * `sendOrderToExchange` off the prototype (harness shape from
 * `nanOrderRefusal.spec.ts`), with the real `convertOrderExecutedQty` and
 * `getOKXDenominator` doing the unit conversion.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

const CLIENT_ID = 'D-BO-okxLinearQuoteQtyXAU000000001'

type Row = Record<string, any>

/** `pairs` rows as the exchange-info loader stores OKX swaps. */
const pairs: Record<string, Row> = {
  // Gold: one contract is 0.001 XAU.
  'XAU-USDT': {
    pair: 'XAU-USDT',
    priceAssetPrecision: 1,
    baseAsset: {
      name: 'XAU',
      minAmount: 0.001,
      step: 0.001,
      multiplier: 0.001,
      maxMarketAmount: 1e9,
    },
    quoteAsset: { name: 'USDT', minAmount: 1, precision: 6 },
  },
  // One contract is 1,000,000 SHIB — the stored value was 1e6× too SMALL.
  'SHIB-USDT': {
    pair: 'SHIB-USDT',
    priceAssetPrecision: 10,
    baseAsset: {
      name: 'SHIB',
      minAmount: 1000000,
      step: 1000000,
      multiplier: 1000000,
      maxMarketAmount: 1e15,
    },
    quoteAsset: { name: 'USDT', minAmount: 1, precision: 6 },
  },
}

const makeOrdersDb = () => {
  const rows = new Map<string, Row>()
  return {
    rows,
    createData: async (doc: Row) => {
      rows.set(doc.clientOrderId, { ...doc })
      return { status: StatusEnum.ok, reason: null, data: { result: doc } }
    },
    updateData: async (filter: Row, update: Row) => {
      const { $unset: _unset, ...set } = update
      const row = rows.get(filter.clientOrderId)
      if (row) rows.set(filter.clientOrderId, { ...row, ...set })
      return { status: StatusEnum.ok, reason: null, data: { result: null } }
    },
    readData: async (filter: Row) => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: rows.get(filter.clientOrderId) ?? null },
    }),
    deleteManyData: async () => ({
      status: StatusEnum.ok,
      reason: 'Deleted: 0 records',
      data: null,
    }),
  }
}

/** What the OKX connector answers for 508 contracts of XAU at 4837.9. */
const okxXauAnswer = (over: Row = {}) => ({
  symbol: 'XAU-USDT',
  orderId: '3480131234933104640',
  clientOrderId: CLIENT_ID,
  transactTime: 1776218392860,
  updateTime: 1776218393015,
  price: '4837.9',
  origQty: '508',
  executedQty: '508',
  cummulativeQuoteQty: `${4837.9 * 508}`,
  status: 'FILLED',
  type: 'MARKET',
  side: 'BUY',
  fills: [],
  ...over,
})

const makeOrder = (over: Row = {}) => ({
  clientOrderId: CLIENT_ID,
  symbol: 'XAU-USDT',
  side: 'BUY',
  type: 'MARKET',
  status: 'NEW',
  orderId: '-1',
  origQty: '0.508',
  executedQty: '0',
  price: '4837.8',
  origPrice: '4837.8',
  exchange: ExchangeEnum.okxLinear,
  typeOrder: 'dealStart',
  dealId: '69def118b8e4e5a20d154f46',
  reduceOnly: false,
  positionSide: 'LONG',
  updateTime: 1776218392800,
  transactTime: 1776218392800,
  ...over,
})

const makeBot = (
  exchange: ExchangeEnum = ExchangeEnum.okxLinear,
  sizedInContracts = true,
) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const errors: string[] = []

  Object.assign(bot, {
    botId: '69afbac8dfe0fd455c823da6',
    userId: '6966e885bf86ea769817d41a',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    reconcileBatch: null,
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    errors,
    venueAnswer: okxXauAnswer(),
    data: {
      exchange,
      exchangeUUID: '',
      paperContext: false,
      settings: {
        futures: true,
        leverage: 5,
        marginType: BotMarginTypeEnum.cross,
      },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return { status: StatusEnum.ok, reason: null, data: bot.venueAnswer }
      },
      getOrder: async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: { ...bot.venueAnswer },
      }),
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: (m: string) => {
      errors.push(m)
    },
    handleOrderErrors: (m: string) => {
      errors.push(m)
    },
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => 'XAU-USDT-BUY',
    getUserFee: async () => ({ maker: 0.0002, taker: 0.0005 }),
    getExchangeInfo: async (symbol: string) => pairs[symbol] ?? null,
  })

  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: true,
    coinm: false,
    hedge: false,
    hyperliquid: false,
    sizedInContracts,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 5,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

/** Quote value of the base quantity actually filled. */
const baseValue = (row: Row) => +row.executedQty * +row.price

describe('okxLinear fill value is booked in base units (spec 102)', () => {
  it('§4.1 rescales a contract-denominated quote by the contract size', async () => {
    const bot = makeBot()
    expect(
      +(await bot.convertOrderQuoteQty('XAU-USDT', `${4837.9 * 508}`)),
    ).to.be.closeTo(4837.9 * 0.508, 1e-6)
    // ctVal above 1: the stated value was too SMALL, not too large.
    expect(
      +(await bot.convertOrderQuoteQty('SHIB-USDT', `${0.0000123 * 3}`)),
    ).to.be.closeTo(0.0000123 * 3_000_000, 1e-9)
  })

  it('§4.1 leaves every other venue and an absent value alone', async () => {
    for (const [exchange, sized] of [
      [ExchangeEnum.okx, false],
      [ExchangeEnum.kucoinLinear, true],
      [ExchangeEnum.binanceUsdm, false],
    ] as const) {
      const bot = makeBot(exchange, sized)
      expect(await bot.convertOrderQuoteQty('XAU-USDT', '2457653.2')).to.equal(
        '2457653.2',
      )
    }
    const bot = makeBot()
    expect(await bot.convertOrderQuoteQty('XAU-USDT', undefined)).to.equal(
      undefined,
    )
    expect(await bot.convertOrderQuoteQty('XAU-USDT', '')).to.equal('')
  })

  it('§4.2 getOrder returns the quote in base units', async () => {
    const bot = makeBot()

    const res = await bot.getOrder(CLIENT_ID, 'XAU-USDT', false)

    expect(res.data.executedQty).to.equal('0.508')
    expect(+res.data.cummulativeQuoteQty).to.be.closeTo(
      baseValue(res.data),
      1e-6,
    )
  })

  it('§4.3 a stream execution report is booked in base units', async () => {
    const bot = makeBot()
    bot.orders.set(CLIENT_ID, makeOrder())
    bot.getOrderFromMap = (id: string) => bot.orders.get(id)

    // websocket-connector's OKX mapping: totalTradeQuantity = accFillSz,
    // totalQuoteTradeQuantity = avgPx × accFillSz.
    const order = await bot.convertExecutionReportToOrder({
      eventType: 'executionReport',
      eventTime: 1776218393015,
      symbol: 'XAU-USDT',
      newClientOrderId: CLIENT_ID,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '508',
      price: '4837.9',
      orderStatus: 'FILLED',
      orderId: '3480131234933104640',
      totalTradeQuantity: '508',
      totalQuoteTradeQuantity: `${4837.9 * 508}`,
      orderTime: 1776218393015,
    })

    expect(order.executedQty).to.equal('0.508')
    expect(order.price).to.equal('4837.9')
    expect(+order.cummulativeQuoteQty).to.be.closeTo(baseValue(order), 1e-6)
  })

  it('§4.4 the placement answer is saved in base units', async () => {
    const bot = makeBot()

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.venueCalls, 'order reached the venue').to.have.length(1)
    expect(bot.venueCalls[0].quantity).to.equal(508)
    const row = bot.orders.get(CLIENT_ID)
    expect(row.executedQty).to.equal('0.508')
    expect(row.price).to.equal('4837.9')
    expect(+row.cummulativeQuoteQty).to.be.closeTo(baseValue(row), 1e-6)
  })

  it('§1.3 a venue sized in base keeps the stated quote', async () => {
    const bot = makeBot(ExchangeEnum.binanceUsdm, false)
    bot.venueAnswer = okxXauAnswer({
      executedQty: '0.508',
      origQty: '0.508',
      cummulativeQuoteQty: '2457.6532',
    })

    const res = await bot.getOrder(CLIENT_ID, 'XAU-USDT', false)

    expect(res.data.executedQty).to.equal('0.508')
    expect(res.data.cummulativeQuoteQty).to.equal('2457.6532')
  })
})
