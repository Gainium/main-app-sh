process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `084.a-zero-remainder-and-an-over-scaled-market-buy-amount` (issue #871,
 * finding F819).
 *
 * Bitget spot kept refusing live orders this engine had already written ahead
 * to `orders`. Two independent producers build an order the venue can only
 * refuse:
 *
 *   §4.1  `sellRemainder` measures its two minimum checks against the raw
 *         remainder but SENDS that value floored onto the symbol's base step.
 *         On 2026-09-20 the two disagreed and the venue was asked to buy zero:
 *
 *           Reason parameter verification exception delegateamount
 *           Method limitOrders() Step Send new order request
 *           D-SR-RIgYkWoUcQp15FwDQEQrbd8DIuOwHu, qty 0, price 108.7, side BUY
 *
 *         `baseAsset.minAmount` cannot catch it: Bitget reports
 *         `minTradeAmount "0"` for every spot symbol, so `qty >= minAmount`
 *         is `x >= 0`.
 *
 *   §4.2  the Bitget market-buy amount is rounded to the symbol's own
 *         `quotePrecision`, which Bitget publishes as high as 13 but its
 *         order-entry validator caps at 6:
 *
 *           Reason parameter verification exception delegateamount
 *           checkbdscale error value=4.9999286 checkscale=6
 *           … qty 1.6223, price 3.082, side BUY      (ICPUSDT, quotePrecision 7)
 *
 *   §4.3  the submission boundary that already refuses a non-finite quantity
 *         (spec `025`) lets a zero through, so any producer that floors a size
 *         to zero reaches the venue.
 *
 * Both fixtures are production rows. Nothing here opens a connection, places
 * or cancels anything: §4.1 drives the REAL `sellRemainder` off the dcaHelper
 * mixin (harness shape from `remainderDoubleCount.spec.ts`), §4.2/§4.3 drive
 * the REAL `sendOrderToExchange` off the prototype (harness shape from
 * `nanOrderRefusal.spec.ts`).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

type Row = Record<string, any>

/* ------------------------------------------------------------------ §4.1 */

const DEAL_ID = '6aad4189679acc018fcf623c'

/**
 * `SOLUSDC` on Bitget spot, exactly as `pairs` records it: `minTradeAmount`
 * comes back `"0"` from the venue, so `baseAsset.minAmount` is 0 and can never
 * refuse anything.
 */
const SOL_INFO = {
  pair: 'SOLUSDC',
  priceAssetPrecision: 2,
  baseAsset: { minAmount: 0, maxAmount: 9e20, step: 0.01, name: 'SOL' },
  quoteAsset: { minAmount: 1, precision: 4, name: 'USDC' },
}

/**
 * The deal's filled SELL legs (a SHORT spot deal): 0.02 + 0.03 + 0.03 = 0.08
 * SOL sold. Its take-profit BUY of 0.08 filled only 0.07, leaving 0.01 for
 * `sellRemainder` to buy back.
 */
const FILLED_SELLS = [
  { executedQty: '0.02' },
  { executedQty: '0.03' },
  { executedQty: '0.03' },
]

const makeDeal = (): Row => ({
  _id: DEAL_ID,
  status: 'closed',
  symbol: { symbol: 'SOLUSDC' },
  levels: { complete: 3 },
  currentBalances: { base: 0, quote: 0 },
  initialBalances: { base: 0, quote: 0 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  commission: 0,
})

let Helper: any

function makeDcaBot(filledSells: Row[] = FILLED_SELLS) {
  const sent: Row[] = []
  const debug: string[] = []
  class TestBot extends (Helper as any) {
    math = new MathHelper()
    futures = false
    coinm = false
    hedge = false
    /** The bot is SHORT, so the remainder is bought back — side BUY. */
    isLong = false
    botId = '6958087e4a8df46c47f77892'
    userId = '000000000000000000000000'
    sent = sent
    debug = debug
    deals = new Map()
    data = {
      exchange: ExchangeEnum.bitget,
      settings: { type: 'regular' },
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    dealsDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: makeDeal() },
      }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
    }
    ordersDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: filledSells },
      }),
    }
    async profitBase() {
      return false
    }
    async getExchangeInfo() {
      return SOL_INFO
    }
    async getUserFee() {
      return { maker: 0.002, taker: 0.002 }
    }
    async getLatestPrice() {
      return 108.7
    }
    async baseAssetPrecision() {
      return 2
    }
    getOrderId(prefix: string) {
      return `${prefix}-RIgYkWoUcQp15FwDQEQrbd8DIuOwHu`
    }
    /** Records what the venue would have been asked for. */
    async sendGridToExchange(grid: Row) {
      sent.push(grid)
      return null
    }
    shouldProceed() {
      return false
    }
    setDeal() {}
    handleLog() {}
    handleDebug(m: string) {
      debug.push(m)
    }
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

/* ------------------------------------------------------------- §4.2/§4.3 */

/** The ICPUSDT base order Bitget refused for `checkscale=6`. */
const ICP_CLIENT_ID = 'D-BO-YjsKfGA4qSkOadggmPF5FKhWHhjZ0Z'

/** `pairs` records ICPUSDT's `quoteAsset.precision` as 7 — Bitget's own value. */
const ICP_INFO = {
  pair: 'ICPUSDT',
  priceAssetPrecision: 3,
  baseAsset: { maxMarketAmount: 0, step: 0.0001, minAmount: 0, name: 'ICP' },
  quoteAsset: { minAmount: 1, precision: 7, name: 'USDT' },
}

/** ZECUSDT sits at 5 — under the cap, so nothing about it may change. */
const ZEC_INFO = {
  pair: 'ZECUSDT',
  priceAssetPrecision: 2,
  baseAsset: { maxMarketAmount: 0, step: 0.001, minAmount: 0, name: 'ZEC' },
  quoteAsset: { minAmount: 1, precision: 5, name: 'USDT' },
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

const makeOrder = (over: Row = {}) => ({
  clientOrderId: ICP_CLIENT_ID,
  symbol: 'ICPUSDT',
  side: 'BUY',
  type: 'MARKET',
  status: 'NEW',
  orderId: '-1',
  origQty: '1.6223',
  price: '3.082',
  origPrice: '3.082',
  exchange: ExchangeEnum.bitget,
  typeOrder: 'dealStart',
  dealId: '6a9fdc736665333e16e0bbf3',
  reduceOnly: false,
  positionSide: undefined,
  ...over,
})

const makeMainBot = (info: Row = ICP_INFO) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const errors: string[] = []

  Object.assign(bot, {
    botId: '69404241884fe476003a48a4',
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
      exchange: ExchangeEnum.bitget,
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
    getNotEnoughOrdersIdByOrder: () => `${info.pair}-BUY`,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.002, taker: 0.002 }),
    getExchangeInfo: async () => info,
  })

  for (const [name, value] of Object.entries({
    isBitget: true,
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

/* -------------------------------------------------------------- the suite */

describe('orders the venue can only refuse (spec 084, issue #871)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.1 sellRemainder', () => {
    it('never sends a remainder that floors to zero on the base step', async () => {
      const bot = makeDcaBot()

      // The production call: 0.01 SOL left unbought, netted for the fee the
      // deal's three filled SELL legs already paid (`sellNotByOrder`).
      //   0.01 - 0.08 x 0.002 = 0.00984, which clears BOTH minimums
      //   (0.00984 >= 0 and 0.00984 x 108.7 = 1.0696 >= 1)
      // and then rounds DOWN onto SOL's 0.01 step to nothing at all.
      await bot.sellRemainder(DEAL_ID, 0.01, undefined, true)

      expect(
        bot.sent.map((g: Row) => g.qty),
        'the venue was asked to trade zero units',
      ).to.deep.equal([])
    })

    it('says so on the way out', async () => {
      const bot = makeDcaBot()

      await bot.sellRemainder(DEAL_ID, 0.01, undefined, true)

      expect(bot.debug.join('\n')).to.contain('less than minimals qty')
    })

    it('still sends a remainder that survives the rounding', async () => {
      const bot = makeDcaBot()

      // 0.03 - 0.00016 = 0.02984 -> 0.02 on the step: a real, tradeable size.
      await bot.sellRemainder(DEAL_ID, 0.03, undefined, true)

      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].qty).to.equal(0.02)
      expect(bot.sent[0].side).to.equal('BUY')
    })
  })

  describe('§4.2 the Bitget market-buy amount', () => {
    it('carries no more decimals than the venue accepts', async () => {
      const bot = makeMainBot(ICP_INFO)

      await bot.sendOrderToExchange(makeOrder())

      expect(bot.venueCalls, 'the order must still be sent').to.have.length(1)
      const amount = bot.venueCalls[0].quantity
      const decimals = `${amount}`.split('.')[1]?.length ?? 0
      expect(
        decimals,
        `Bitget refused value=4.9999286 with checkscale=6, got ${amount}`,
      ).to.be.at.most(6)
    })

    it('leaves a symbol already inside the cap untouched', async () => {
      const bot = makeMainBot(ZEC_INFO)

      await bot.sendOrderToExchange(
        makeOrder({
          clientOrderId: 'D-BO-7k37uepkmVa0pfaByAx5olbnrjNSDZ',
          symbol: 'ZECUSDT',
          origQty: '0.001',
          price: '1529.15',
          origPrice: '1529.15',
        }),
      )

      // Still ZEC's own scale of 5 — unchanged by the cap. The amount is
      // funded for 0.001 plus half a base step (spec `113`), so it is
      // round(0.0015 x 1529.15, 5) rather than round(0.001 x 1529.15, 5).
      expect(bot.venueCalls[0].quantity).to.equal(
        new MathHelper().round((0.001 + 0.001 / 2) * 1529.15, 5),
      )
      expect(`${bot.venueCalls[0].quantity}`.split('.')[1].length).to.equal(5)
    })
  })

  describe('§4.3 the money-safety boundary', () => {
    it('never asks the venue for a zero quantity', async () => {
      const bot = makeMainBot(ICP_INFO)

      await bot.sendOrderToExchange(makeOrder({ origQty: '0' }))

      expect(bot.venueCalls).to.have.length(0)
    })

    it('leaves no zero-quantity write-ahead row behind', async () => {
      const bot = makeMainBot(ICP_INFO)

      await bot.sendOrderToExchange(makeOrder({ origQty: '0' }))

      expect(bot.ordersDb.rows.get(ICP_CLIENT_ID)).to.equal(undefined)
    })

    it('reports it as a named order-parameter failure', async () => {
      const bot = makeMainBot(ICP_INFO)

      const result = await bot.sendOrderToExchange(
        makeOrder({ origQty: '0' }),
        true,
      )

      expect(result).to.be.a('string')
      expect(result).to.contain('Order qty must be greater than zero')
    })

    it('still refuses a non-finite quantity with its own message (spec 025)', async () => {
      const bot = makeMainBot(ICP_INFO)

      const result = await bot.sendOrderToExchange(
        makeOrder({ origQty: 'NaN' }),
        true,
      )

      expect(result).to.contain('Order qty is not a number')
    })
  })
})
