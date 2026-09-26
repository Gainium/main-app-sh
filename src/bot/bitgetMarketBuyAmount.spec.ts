process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `113.a-bitget-spot-market-buy-is-funded-at-last-trade`.
 *
 * Bitget spot sizes a MARKET BUY in the quote coin and fills
 * `⌊amount ÷ fillPrice⌋` on the base step. The engine funded it at
 * `qty × lastPrice`, so any ask above the last trade came back one step short,
 * and the one-step top-up converted to zero:
 *
 *   PARTIALLY_FILLED, 1608.8, base: 0.002 … not BUY full qty: total - 0.003
 *   Reason parameter verification exception size 0.000 > 0 …
 *   GA-BR-…, qty 0.001, price 1608.37, side BUY
 *
 * Drives the REAL `sendOrderToExchange` off the prototype (harness shape from
 * `zeroSizeOrderRefusal.spec.ts`) and records what the venue would have been
 * asked for. Nothing opens a connection.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

type Row = Record<string, any>

/** ZECUSDT on Bitget spot as `pairs` records it. */
const ZEC_INFO = {
  pair: 'ZECUSDT',
  priceAssetPrecision: 2,
  baseAsset: { maxMarketAmount: 0, step: 0.001, minAmount: 0, name: 'ZEC' },
  quoteAsset: { minAmount: 1, precision: 5, name: 'USDT' },
}

/** ICPUSDT publishes `quotePrecision 7`; the venue validates at 6. */
const ICP_INFO = {
  pair: 'ICPUSDT',
  priceAssetPrecision: 3,
  baseAsset: { maxMarketAmount: 0, step: 0.0001, minAmount: 0, name: 'ICP' },
  quoteAsset: { minAmount: 1, precision: 7, name: 'USDT' },
}

/** The price the engine sized both orders at (the `GA-BR` log line). */
const LAST = 1608.37
/** The price Bitget filled the base order at. */
const FILL = 1608.8

/** What Bitget does with a quote amount: floor it onto the base step. */
const venueFills = (amount: number, fillPrice: number, step: number) =>
  new MathHelper().round(amount / fillPrice, `${step}`.split('.')[1].length, true)

const makeOrder = (over: Row = {}) => ({
  clientOrderId: 'GA-BR-FIy0NSzR6ouiLBsif1GfWKSslMd5k',
  symbol: 'ZECUSDT',
  side: 'BUY',
  type: 'MARKET',
  status: 'NEW',
  orderId: '-1',
  origQty: '0.001',
  price: `${LAST}`,
  origPrice: `${LAST}`,
  exchange: ExchangeEnum.bitget,
  typeOrder: 'br',
  dealId: '6ab6583514fef749dc12a8f6',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeMainBot = (
  info: Row = ZEC_INFO,
  exchange: ExchangeEnum = ExchangeEnum.bitget,
) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  Object.assign(bot, {
    botId: '69515f8c6dcd50bcb1133148',
    userId: '000000000000000000000000',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb: {
      createData: async (doc: Row) => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: doc },
      }),
      updateData: async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: null },
      }),
      deleteManyData: async () => ({
        status: StatusEnum.ok,
        reason: 'Deleted: 1 records',
        data: null,
      }),
    },
    venueCalls,
    data: {
      exchange,
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
          reason: 'parameter verification exception',
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
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
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
    getNotEnoughOrdersIdByOrder: () => `${info.pair}-BUY`,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => info,
  })
  for (const [name, value] of Object.entries({
    isBitget: exchange === ExchangeEnum.bitget,
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

const amountFor = async (order: Row, info: Row = ZEC_INFO) => {
  const bot = makeMainBot(info)
  await bot.sendOrderToExchange(makeOrder(order))
  expect(bot.venueCalls, 'the order must still be sent').to.have.length(1)
  return bot.venueCalls[0].quantity as number
}

describe('a Bitget spot market buy is funded for the quantity it asks for (spec 113)', function () {
  // One ts-node compile of a 25k-line module.
  this.timeout(180000)

  it('§4.3 the one-step top-up no longer converts to zero at the observed fill', async () => {
    const amount = await amountFor({})
    expect(
      venueFills(amount, FILL, 0.001),
      `amount ${amount} at ask ${FILL}`,
    ).to.equal(0.001)
  })

  it('§4.2 the base order fills its full quantity at the observed fill', async () => {
    const amount = await amountFor({
      clientOrderId: 'D-BO-5v2RyhLeHw1sz25JUBqsFL4tEal66g',
      origQty: '0.003',
      typeOrder: 'dealStart',
    })
    expect(
      venueFills(amount, FILL, 0.001),
      `amount ${amount} at ask ${FILL}`,
    ).to.equal(0.003)
  })

  it('§4.1 never funds more than the quantity at the price it was sized at', async () => {
    for (const qty of ['0.001', '0.003', '0.25', '12.345']) {
      const amount = await amountFor({ origQty: qty })
      expect(venueFills(amount, LAST, 0.001), `qty ${qty}`).to.equal(+qty)
    }
  })

  it('§4.4 still carries at most 6 decimals', async () => {
    const amount = await amountFor(
      { symbol: 'ICPUSDT', origQty: '1.6223', price: '3.082', origPrice: '3.082' },
      ICP_INFO,
    )
    expect(`${amount}`.split('.')[1]?.length ?? 0).to.be.at.most(6)
    expect(venueFills(amount, 3.082, 0.0001)).to.equal(1.6223)
  })

  it('§4.5 a Bybit market buy is funded exactly as before', async () => {
    const bot = makeMainBot(ZEC_INFO, ExchangeEnum.bybit)
    await bot.sendOrderToExchange(makeOrder({ exchange: ExchangeEnum.bybit }))
    // round(0.001 × 1608.37, priceAssetPrecision 2)
    expect(bot.venueCalls[0].quantity).to.equal(1.61)
  })

  it('§4.5 a Bitget market sell is sent in base, unchanged', async () => {
    const bot = makeMainBot()
    await bot.sendOrderToExchange(makeOrder({ side: 'SELL', origQty: '0.003' }))
    expect(bot.venueCalls[0].quantity).to.equal(0.003)
  })
})
