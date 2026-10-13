process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `153.bybit-minimum-top-up-can-never-fill`.
 *
 * A DCA bot with "Remainder full amount" tops up a short-filled base order with
 * `baseAsset.minAmount`, whatever that is worth. On Bybit spot LTCUSDT
 * (`baseAsset.minAmount 0.00001`, `quoteAsset.minAmount 1`,
 * `priceAssetPrecision 2`) that is a market BUY of
 * `round(0.00001 × 60.48, 2) = 0` USDT, which Bybit refused every time:
 *
 *   Reason An unknown parameter was sent. Method limitOrders() Step Send new
 *   order request GA-BR-…, qty 0.00001, price 60.48, side BUY
 *
 * §1.1 drives the REAL `buyRemainder`, §1.2 the REAL `sendOrderToExchange`,
 * both off the prototype (harness shape from `zeroSizeOrderRefusal.spec.ts`).
 * Nothing opens a connection.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  StatusEnum,
  ExchangeEnum,
  BotMarginTypeEnum,
  BotType,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { isBelowVenueMinOrderValue } from './remainderFill'

type Row = Record<string, any>

/** Bybit spot LTCUSDT exactly as `pairs` records it on prod. */
const LTC_INFO = {
  pair: 'LTCUSDT',
  priceAssetPrecision: 2,
  baseAsset: {
    minAmount: 0.00001,
    maxAmount: 10000,
    step: 0.00001,
    maxMarketAmount: 10000,
    name: 'LTC',
  },
  quoteAsset: { minAmount: 1, name: 'USDT' },
}

/** The base order from the 2026-10-08T13:30:44Z log line. */
const makeBaseOrder = (over: Row = {}) => ({
  clientOrderId: 'D-BO-9IbWtestLTCUSDTbaseOrder00000',
  symbol: 'LTCUSDT',
  side: 'BUY',
  type: 'MARKET',
  status: 'FILLED',
  orderId: '123',
  origQty: '0.10183',
  executedQty: '0.10135',
  price: '60.48',
  origPrice: '60.48',
  exchange: ExchangeEnum.bybit,
  typeOrder: TypeOrderEnum.dealStart,
  dealId: '6ae8c0000000000000000001',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeRemainderBot = (
  info: Row = LTC_INFO,
  price = 60.48,
  exchange: string = ExchangeEnum.bybit,
) => {
  const bot: any = Object.create(MainBot.prototype)
  const sent: Row[] = []
  const logs: string[] = []
  Object.assign(bot, {
    botId: '6ac788d85527688fa313b193',
    botType: BotType.dca,
    math: new MathHelper(),
    partiallyFilledFilledSet: new Set(),
    data: {
      exchange,
      settings: { remainderFullAmount: true },
    },
    sent,
    logs,
    getExchangeInfo: async () => info,
    getLatestPrice: async () => price,
    baseAssetPrecision: async () => 5,
    getOrderId: (p: string) => `${p}-test`,
    handleLog: (m: string) => {
      logs.push(m)
    },
    sendGridToExchange: async (grid: Row) => {
      sent.push(grid)
      return null
    },
  })
  Object.defineProperty(bot, 'coinm', { value: false, configurable: true })
  return bot
}

const makeOrdersDb = () => {
  const rows = new Map<string, Row>()
  return {
    rows,
    createData: async (doc: Row) => {
      rows.set(doc.clientOrderId, { ...doc })
      return { status: StatusEnum.ok, reason: null, data: { result: doc } }
    },
    updateData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: null },
    }),
    deleteManyData: async (filter: Row) => {
      rows.delete(filter.clientOrderId)
      return { status: StatusEnum.ok, reason: 'Deleted: 1 records', data: null }
    },
  }
}

const BR_ID = 'GA-BR-nH5SM1bB8xtCDnrrb2df7FrN3kBJm'

const makeTopUpOrder = (over: Row = {}) => ({
  clientOrderId: BR_ID,
  symbol: 'LTCUSDT',
  side: 'BUY',
  type: 'MARKET',
  status: 'NEW',
  orderId: '-1',
  origQty: '0.00001',
  price: '60.48',
  origPrice: '60.48',
  exchange: ExchangeEnum.bybit,
  typeOrder: TypeOrderEnum.br,
  dealId: '6ae8c0000000000000000001',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeMainBot = (info: Row = LTC_INFO) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const errors: string[] = []

  Object.assign(bot, {
    botId: '6ac788d85527688fa313b193',
    userId: '000000000000000000000000',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    errors,
    data: {
      exchange: ExchangeEnum.bybit,
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return {
          status: StatusEnum.notok,
          reason: 'An unknown parameter was sent.',
          data: null,
        }
      },
      getOrder: async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found',
        data: null,
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
    needToSendOrder: () => false,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => `${info.pair}-BUY`,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => info,
  })

  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: false,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 1,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

describe('a Bybit spot top-up that can never fill (spec 153)', function () {
  // One ts-node compile of a 25k-line module.
  this.timeout(180000)

  describe('§1.1 isBelowVenueMinOrderValue', () => {
    it('Bybit BUY worth less than the minimum order value: below', () => {
      expect(
        isBelowVenueMinOrderValue(ExchangeEnum.bybit, 'BUY', 0.00001, 60.48, 1),
      ).to.equal(true)
    })
    it('Bybit BUY worth the minimum: not below', () => {
      expect(
        isBelowVenueMinOrderValue(ExchangeEnum.bybit, 'BUY', 0.02, 60.48, 1),
      ).to.equal(false)
    })
    // §2.4: a kucoinLinear 0.05 USDT top-up against a stored minimum of 1
    // filled on prod, so the stored minimum is not a refusal threshold there.
    it('other venues are never judged by the stored minimum', () => {
      expect(
        isBelowVenueMinOrderValue(
          ExchangeEnum.kucoinLinear,
          'BUY',
          1,
          0.05142,
          1,
        ),
      ).to.equal(false)
    })
    it('Bybit SELL is not measured, so not judged', () => {
      expect(
        isBelowVenueMinOrderValue(ExchangeEnum.bybit, 'SELL', 0.00001, 60.48, 1),
      ).to.equal(false)
    })
    it('a missing or zero minimum judges nothing', () => {
      expect(
        isBelowVenueMinOrderValue(
          ExchangeEnum.bybit,
          'BUY',
          0.00001,
          60.48,
          undefined,
        ),
      ).to.equal(false)
      expect(
        isBelowVenueMinOrderValue(ExchangeEnum.bybit, 'BUY', 0.00001, 60.48, 0),
      ).to.equal(false)
    })
  })

  describe('§1.1 buyRemainder', () => {
    it('skips the Bybit LTCUSDT minimum top-up', async () => {
      const bot = makeRemainderBot()

      await bot.buyRemainder(makeBaseOrder())

      expect(
        bot.sent.map((g: Row) => g.qty),
        'Bybit was asked for 0.00001 LTC = 0.0006 USDT',
      ).to.deep.equal([])
    })

    it('says why, with the numbers', async () => {
      const bot = makeRemainderBot()

      await bot.buyRemainder(makeBaseOrder())

      expect(bot.logs.join('\n')).to.contain(
        'below the exchange minimum order value 1',
      )
    })

    it('returns the order unchanged', async () => {
      const bot = makeRemainderBot()
      const order = makeBaseOrder()

      const result = await bot.buyRemainder({ ...order })

      expect(result.executedQty).to.equal(order.executedQty)
      expect(result.price).to.equal(order.price)
    })
  })

  describe('§1.3 unchanged', () => {
    it('still sends a Bybit top-up worth the minimum, sized at baseAsset.minAmount', async () => {
      // A gap below baseAsset.minAmount, so only the full-amount branch can
      // send it; its replacement 0.00001 x 120000 = 1.2 USDT >= 1.
      const bot = makeRemainderBot(LTC_INFO, 120000)

      await bot.buyRemainder(makeBaseOrder({ origQty: '0.101355' }))

      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].qty).to.equal(0.00001)
    })

    it('still sends the kucoinLinear top-up that filled on prod', async () => {
      const ZETA = {
        pair: 'ZETAUSDT',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 1, maxMarketAmount: 1e6, name: 'ZETA' },
        quoteAsset: { minAmount: 1, name: 'USDT' },
      }
      const bot = makeRemainderBot(ZETA, 0.05142, ExchangeEnum.kucoinLinear)

      await bot.buyRemainder(
        makeBaseOrder({
          symbol: 'ZETAUSDT',
          exchange: ExchangeEnum.kucoinLinear,
          origQty: '91',
          executedQty: '90',
          price: '0.05142',
        }),
      )

      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].qty).to.equal(1)
    })
  })

  describe('§1.2 the Bybit market-buy quote amount', () => {
    it('never asks Bybit for a zero quote amount', async () => {
      const bot = makeMainBot()

      await bot.sendOrderToExchange(makeTopUpOrder())

      expect(
        bot.venueCalls.map((r: Row) => r.quantity),
        'round(0.00001 x 60.48, 2) = 0',
      ).to.deep.equal([])
    })

    it('leaves no write-ahead row behind, in memory or in the db', async () => {
      const bot = makeMainBot()

      await bot.sendOrderToExchange(makeTopUpOrder())

      expect(bot.ordersDb.rows.get(BR_ID)).to.equal(undefined)
      expect(bot.orders.get(BR_ID)).to.equal(undefined)
    })

    it('reports it as the existing named order-parameter failure', async () => {
      const bot = makeMainBot()

      const result = await bot.sendOrderToExchange(makeTopUpOrder(), true)

      expect(result).to.be.a('string')
      expect(result).to.contain('Order qty must be greater than zero')
    })

    it('still sends a market buy whose amount survives the rounding', async () => {
      const bot = makeMainBot()

      await bot.sendOrderToExchange(makeTopUpOrder({ origQty: '0.02' }))

      expect(bot.venueCalls).to.have.length(1)
      expect(bot.venueCalls[0].quantity).to.equal(1.21)
    })
  })
})
