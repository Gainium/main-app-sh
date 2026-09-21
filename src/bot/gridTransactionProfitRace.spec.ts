process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `073.concurrent-grid-fills-share-one-realized-profit-base`.
 *
 * `processFilledOrder` calls `createTransaction(order)` WITHOUT awaiting it,
 * and `createTransaction` used to take its `IdMute` key per FILL
 * (`${botId}transaction${clientOrderId}`). Several grid levels filling in one
 * price message therefore ran concurrently, and every one of them read the
 * same `this.data.profit.total` across the awaits before the insert — so all
 * of them wrote the running `cummulativeProfit*` from one stale base and N-1
 * legs vanished from the ledger.
 *
 * Measured on the reported bot on prod `transactions` (2026-09-21): six rows
 * at `06:57:48.222`–`.224` all carrying the base `6.526895456404655` written
 * by the fill before them, and an earlier batch at `06:40:19.68x` all carrying
 * `5.213324115604653`.
 *
 * The close leg has the mirror of the same problem: `processFilledStop` and
 * `processSellAtStop` persisted the closing profit with `updateData` but never
 * carried it into `this.data.profit`, so the next `createTransaction` — which
 * `$set`s an absolute profit built from `this.data` — discarded it.
 *
 * These drive the REAL `createTransaction` and `processFilledStop` off the
 * mixin with a fake base class. No Mongo, Redis, venue or bot stack is needed;
 * nothing here places, cancels or saves anything. Harness shape copied from
 * `gridCloseProfitLedger.spec.ts` (spec 045).
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

const BOT_ID = '6aad003076fb82dc7f706cad'
const USER_ID = '64c33715e3ee8daa34f19dbb'

/**
 * A two-level grid: a buy at 9 and a sell at 11, one base unit each. A SELL
 * that fills at 11 is matched against the buy at 9 and realises +2 quote.
 */
const LEG_PROFIT = 2

let Helper: any

const makeBot = () => {
  const transactions: any[] = []
  const seenIndexes = new Set<string>()

  class TestBot extends Helper {
    public transactions = transactions
    public updates: any[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public math = new MathHelper()
    public orderQueue: any[] = []
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.binance,
      paperContext: true,
      symbol: { symbol: 'KOMAUSDT', baseAsset: 'KOMA', quoteAsset: 'USDT' },
      settings: {
        name: 'race',
        pair: 'KOMAUSDT',
        futures: false,
        coinm: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
        newProfit: false,
        feeOrder: false,
        topPrice: 11,
      },
      transactionsCount: { buy: 0, sell: 0 },
      initialPrice: 10,
      initialPriceStart: 10,
      initialBalances: { base: 0, quote: 100 },
      currentBalances: { base: 10, quote: 0 },
      position: { side: PositionSide.LONG, qty: 0, price: 0 },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    /** The grid the bot was built on — `prices` is read off this. */
    public initialGrid: any[] = [
      { price: { buy: 9, sell: 10 } },
      { price: { buy: 10, sell: 11 } },
    ]
    /** Truthy is all `createTransaction` asks of it before the branch below. */
    public exchange: any = {}
    public transactionDb: any = {
      countData: async () => ({
        status: StatusEnum.ok,
        data: { result: 0 },
      }),
      createData: async (doc: any) => {
        if (doc.index && seenIndexes.has(doc.index)) {
          return { status: StatusEnum.notok, reason: 'E11000 duplicate key' }
        }
        if (doc.index) {
          seenIndexes.add(doc.index)
        }
        transactions.push(doc)
        return {
          status: StatusEnum.ok,
          data: { ...doc, _id: `t${transactions.length}`, updateTime: 0 },
        }
      },
    }
    get futures() {
      return false
    }
    get coinm() {
      return false
    }
    /**
     * Every stub here resolves on the MICROTASK queue, like a warm cache or an
     * already-buffered driver answer. That is what makes two concurrent calls
     * ping-pong through the awaits in lockstep and reach the read of
     * `this.data.profit.total` together — a `setTimeout` stub would not: Node
     * drains the microtask queue after each timer callback, so the first call
     * would run to completion before the second's timer ever fired, and the
     * race would be hidden rather than reproduced.
     */
    async getExchangeInfo() {
      return {
        pair: 'KOMAUSDT',
        priceAssetPrecision: 9,
        baseAsset: { minAmount: 0.1, step: 0.00001, name: 'KOMA' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDT' },
      }
    }
    async generateCurrentGrids() {
      return [{ price: 9, side: OrderSideEnum.buy, qty: 1 }]
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    updateUserProfitStep() {}
    saveProfitToDb() {}
    limitOrders() {}
    shouldProceed() {
      return true
    }
    async stop() {}
    updateProgress() {}
    deleteOrder() {}
    updateData(data: any) {
      this.updates.push(data)
    }
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

/** A grid SELL that fills at the top level, matched against the buy at 9. */
const sellFill = (id: string) => ({
  clientOrderId: id,
  orderId: id,
  botId: BOT_ID,
  symbol: 'KOMAUSDT',
  baseAsset: 'KOMA',
  quoteAsset: 'USDT',
  side: OrderSideEnum.sell,
  type: 'LIMIT',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.regular,
  price: '11',
  origPrice: '11',
  origQty: '1',
  executedQty: '1',
  cummulativeQuoteQty: '11',
  updateTime: Date.UTC(2026, 8, 21, 6, 57, 48),
  transactTime: Date.UTC(2026, 8, 21, 6, 57, 48),
})

describe('concurrent grid fills each book their own profit base (spec 073)', () => {
  before(function () {
    // One ts-node compile of a 5k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1.1 the running cumulative advances once per fill', () => {
    it('one fill books one leg', async () => {
      const bot = makeBot()
      await bot.createTransaction(sellFill('GRID-RO-a'))
      expect(bot.transactions).to.have.length(1)
      expect(bot.transactions[0].profitQuote).to.be.closeTo(LEG_PROFIT, 1e-9)
      expect(bot.transactions[0].cummulativeProfitQuote).to.be.closeTo(
        LEG_PROFIT,
        1e-9,
      )
    })

    it('two fills delivered together do not share one base', async () => {
      const bot = makeBot()
      // Exactly what `processFilledOrder` does: fire and do not await.
      await Promise.all([
        bot.createTransaction(sellFill('GRID-RO-a')),
        bot.createTransaction(sellFill('GRID-RO-b')),
      ])
      expect(bot.transactions).to.have.length(2)
      const bases = bot.transactions.map(
        (t: any) => t.cummulativeProfitQuote - t.profitQuote + t.feeQuote,
      )
      expect(bases[0], 'the first leg starts from nothing').to.be.closeTo(
        0,
        1e-9,
      )
      expect(
        bases[1],
        'and the second starts from where the first left off',
      ).to.be.closeTo(LEG_PROFIT, 1e-9)
    })

    it('the last cumulative written is the sum of every leg', async () => {
      const bot = makeBot()
      const ids = ['a', 'b', 'c', 'd', 'e', 'f']
      await Promise.all(
        ids.map((id) => bot.createTransaction(sellFill(`GRID-RO-${id}`))),
      )
      expect(bot.transactions).to.have.length(ids.length)
      const cumulatives = bot.transactions.map(
        (t: any) => t.cummulativeProfitQuote,
      )
      expect(Math.max(...cumulatives)).to.be.closeTo(
        ids.length * LEG_PROFIT,
        1e-9,
      )
      // The reported symptom: every row carrying the same base.
      expect(
        new Set(cumulatives.map((c: number) => c.toFixed(9))).size,
      ).to.equal(ids.length)
    })

    it('leaves `bot.profit.total` equal to the sum of the legs booked', async () => {
      const bot = makeBot()
      const ids = ['a', 'b', 'c', 'd', 'e', 'f']
      await Promise.all(
        ids.map((id) => bot.createTransaction(sellFill(`GRID-RO-${id}`))),
      )
      expect(bot.data.profit.total).to.be.closeTo(ids.length * LEG_PROFIT, 1e-9)
      const persisted = bot.updates.filter((u: any) => u.profit).pop()
      expect(persisted.profit.total).to.be.closeTo(
        ids.length * LEG_PROFIT,
        1e-9,
      )
    })
  })

  describe('§1.2 the close leg is not discarded by the next fill', () => {
    /** 10 base bought for 100 quote, sold at 9: a −10 quote close. */
    const makeSpotCloseBot = () => {
      const bot = makeBot()
      bot.data.currentBalances = { base: 10, quote: 0 }
      return bot
    }

    const stopFill = () => ({
      ...sellFill('GRID-TP-close'),
      typeOrder: TypeOrderEnum.stop,
      price: '9',
      origPrice: '9',
      origQty: '10',
      executedQty: '10',
      cummulativeQuoteQty: '90',
    })

    it('carries the close into memory, not only into the document', async () => {
      const bot = makeSpotCloseBot()
      await bot.processFilledStop(stopFill())
      const persisted = bot.updates.filter((u: any) => u.profit).pop()
      expect(persisted, 'the close is persisted').to.not.equal(undefined)
      expect(bot.data.profit.total).to.be.closeTo(persisted.profit.total, 1e-9)
    })

    it('books the close once when the same fill is delivered twice', async () => {
      // `closeBotByTp` and the user stream both handle the closing fill, and
      // the engine logs `Stop order filled` twice for it. The unique `index`
      // refuses the second insert, and the profit must not advance with it.
      const bot = makeSpotCloseBot()
      await bot.processFilledStop(stopFill())
      const once = bot.data.profit.total
      await bot.processFilledStop(stopFill())
      expect(bot.transactions).to.have.length(1)
      expect(bot.data.profit.total).to.be.closeTo(once, 1e-9)
      const persisted = bot.updates.filter((u: any) => u.profit).pop()
      expect(persisted.profit.total).to.be.closeTo(once, 1e-9)
    })

    it('a round-trip booked after the close keeps the close in the total', async () => {
      const bot = makeSpotCloseBot()
      await bot.processFilledStop(stopFill())
      const afterClose = bot.data.profit.total
      await bot.createTransaction(sellFill('GRID-RO-after'))
      const persisted = bot.updates.filter((u: any) => u.profit).pop()
      expect(persisted.profit.total).to.be.closeTo(
        afterClose + LEG_PROFIT,
        1e-9,
      )
    })
  })
})
