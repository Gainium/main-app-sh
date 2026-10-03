process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `127.grid-stop-and-sell-stops-on-a-flat-futures-position`.
 *
 * `closeBotByTp`'s `stopAndSell` branch cancels the grid and blocks new
 * orders, then builds a closing order — for a futures bot only while
 * `position.qty !== 0` — and called `stop(true)` only from inside the
 * "a closing order was built" block. A futures grid whose position was
 * already flat (a grid order filled on the same tick the take profit fired)
 * built no order and never stopped: it stayed `open` with every grid order
 * cancelled and nothing left to place one again (spec §1.2, §2).
 *
 * These drive the REAL `closeBotByTp` off the mixin. Venue, Mongo and Redis
 * are stubbed; nothing here places, cancels or saves anything. Harness shape
 * copied from `gridCloseProfitLedger.spec.ts` (spec 045).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import {
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  PositionSide,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const BOT_ID = '6aa76a7cf3f81f03b9d03736'
const USER_ID = '64c33715e3ee8daa34f19dbc'

let Helper: any

const makeBot = (opts: {
  futures: boolean
  position?: { side: PositionSide; qty: number; price: number }
  /** What the venue answers to the closing order. */
  answer?: any
}) => {
  class TestBot extends Helper {
    public stopped = 0
    public cancelled = 0
    public sent: any[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public log = false
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      symbol: { symbol: 'SYNUSDT', baseAsset: 'SYN', quoteAsset: 'USDT' },
      settings: {
        pair: 'SYNUSDT',
        futures: opts.futures,
        coinm: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
        feeOrder: false,
        tpSlAction: 'stopAndSell',
        slAction: 'stopAndSell',
        tpSlLimit: false,
        slLimit: false,
      },
      feeBalance: 0,
      initialPrice: 0.18,
      initialBalances: { base: 0, quote: 300 },
      currentBalances: { base: 0, quote: 300 },
      position: opts.position ?? { side: PositionSide.LONG, qty: 0, price: 0 },
      profit: { total: 3.55, totalUsd: 3.55, freeTotal: 0, freeTotalUsd: 0 },
    }
    public botEventDb: any = {
      createData: () => Promise.resolve({ status: StatusEnum.ok, data: {} }),
    }
    public transactionDb: any = {
      createData: (doc: any) =>
        Promise.resolve({ status: StatusEnum.ok, data: { ...doc, _id: 't1' } }),
    }
    public userProfitByHourDb: any = {
      updateData: () => Promise.resolve({ status: StatusEnum.ok, data: {} }),
    }
    get futures() {
      return !!this.data?.settings.futures
    }
    get coinm() {
      return !!this.data?.settings.coinm
    }
    get allOrders() {
      return []
    }
    async stop() {
      this.stopped += 1
    }
    async cancelAllOrder() {
      this.cancelled += 1
    }
    async getExchangeInfo() {
      return {
        pair: 'SYNUSDT',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 1, name: 'SYN' },
        quoteAsset: { minAmount: 5, step: 0.00001, name: 'USDT' },
      }
    }
    async getLatestPrice() {
      return 0.18122
    }
    async sellBaseAmount() {
      return 76
    }
    async sendGridToExchange(grid: any, additional: any) {
      this.sent.push({ grid, additional })
      return opts.answer
    }
    async profitAfterPositionClosed() {}
    resetPosition() {
      this.data.position = { ...this.data.position, qty: 0, price: 0 }
    }
    saveProfitToDb() {}
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    getOrderId(prefix: string) {
      return prefix
    }
    updateData() {}
    emit() {}
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

const tick = { symbol: 'SYNUSDT', price: 0.18122, time: 0, volume: 0 }

const fire = (bot: any, value: 'tp' | 'sl') =>
  bot.closeBotByTp(BOT_ID, tick, {
    value,
    text: `${value} trigger`,
  })

const filled = (side: OrderSideEnum, qty: number) => ({
  clientOrderId: 'GRID-TP',
  orderId: '1',
  symbol: 'SYNUSDT',
  side,
  type: 'MARKET',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.stop,
  price: '0.18122',
  origQty: `${qty}`,
  executedQty: `${qty}`,
  cummulativeQuoteQty: `${qty * 0.18122}`,
  updateTime: Date.UTC(2026, 9, 3, 4, 5, 39),
})

describe('grid stop-and-sell stops on a flat futures position (spec 127)', () => {
  before(function () {
    // One ts-node compile of a 5k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.1 a flat futures position stops the bot', () => {
    for (const value of ['tp', 'sl'] as const) {
      it(`${value}: places no order and stops once`, async () => {
        const bot = makeBot({ futures: true })
        await fire(bot, value)
        expect(bot.cancelled).to.equal(1)
        expect(bot.sent).to.have.length(0)
        expect(bot.stopped).to.equal(1)
      })
    }
  })

  describe('§4.2 an open futures position is closed, then the bot stops', () => {
    it('sends one reduce-only close for the whole position and stops once', async () => {
      const bot = makeBot({
        futures: true,
        position: { side: PositionSide.LONG, qty: 76, price: 0.17839 },
        answer: filled(OrderSideEnum.sell, 76),
      })
      await fire(bot, 'tp')
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid).to.include({
        side: OrderSideEnum.sell,
        qty: 76,
      })
      expect(bot.sent[0].additional).to.include({ reduceOnly: true })
      expect(bot.stopped).to.equal(1)
    })
  })

  describe('§4.3 a pending close order does not stop the bot', () => {
    it('returns without stopping while the close is not FILLED', async () => {
      const bot = makeBot({
        futures: true,
        position: { side: PositionSide.LONG, qty: 76, price: 0.17839 },
        answer: { ...filled(OrderSideEnum.sell, 76), status: 'NEW' },
      })
      bot.orderLimitRepositionTimeout = 60_000
      bot.enterMarketTimeout = 0
      await fire(bot, 'tp')
      clearTimeout(bot.limitTimer)
      expect(bot.sent).to.have.length(1)
      expect(bot.stopped).to.equal(0)
    })
  })

  describe('§4.4 spot sells and stops', () => {
    it('sells sellBaseAmount() and stops once', async () => {
      const bot = makeBot({
        futures: false,
        answer: filled(OrderSideEnum.sell, 76),
      })
      await fire(bot, 'tp')
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid).to.include({ qty: 76 })
      expect(bot.stopped).to.equal(1)
    })
  })
})
