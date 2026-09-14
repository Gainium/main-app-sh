process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `045.grid-position-close-pnl-never-reaches-the-profit-ledger` (issue #764).
 *
 * A grid bot books its per-round-trip profit through `createTransaction()`,
 * which writes a `transactions` row AND `$inc`s the `userProfitByHour` ledger
 * the account statistics read. Its CLOSING leg — the futures position close
 * (`profitAfterPositionClosed`) and the spot stop fill (`processFilledStop`) —
 * updated `bot.profit` but wrote nothing to that ledger, so the statistics kept
 * the round-trip half of a grid bot's result and dropped the close half.
 *
 * Measured on the reported bot `6aa76a7cf3f81f03b9d03735` (paperBinanceUsdm,
 * `settings.futures: true`) on 2026-09-14: `profit.totalUsd` −10.985231 against
 * a transaction sum of +1.407399 — a close leg of −12.392630 that reached no
 * transaction and no ledger row (spec §2.1–§2.3).
 *
 * These drive the REAL `profitAfterPositionClosed` and `processFilledStop` off
 * the mixin, with the REAL `MainBot.saveProfitToDb` doing the hour bucketing
 * over a recording `userProfitByHourDb`. The venue-side position the reported
 * bot held is not recoverable (`resetPosition()` wiped it), so §2.3 is
 * reproduced by a position sized to the reported close, not by its exact legs.
 *
 * No Mongo, Redis, venue or bot stack is needed; nothing here places, cancels
 * or saves anything. Harness shape copied from
 * `evidenceFreeFilledPromotion.spec.ts` (spec 028).
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
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const BOT_ID = '6aa76a7cf3f81f03b9d03735'
const USER_ID = '64c33715e3ee8daa34f19dbb'

/** The close leg the reporter's bot realised and the statistics never saw. */
const REPORTED_CLOSE_USD = -12.39263

let Helper: any

type LedgerRow = { filter: any; update: any }

/**
 * A grid bot built on the real mixin.
 *
 * `futures`/`coinm` are prototype getters on `MainBot`, which this harness does
 * not extend, so they are re-declared as getters over `settings` exactly as
 * `MainBot` derives them. `isShort` and `profitBase` ARE on the mixin and are
 * left alone — they are steered through `settings.strategy` /
 * `settings.profitCurrency`.
 */
const makeBot = (opts: {
  futures: boolean
  position?: { side: PositionSide; qty: number; price: number }
  initialBalances?: { base: number; quote: number }
  currentBalances?: { base: number; quote: number }
  initialPrice?: number
}) => {
  const ledger: LedgerRow[] = []
  const transactions: any[] = []
  /** Models the UNIQUE sparse `index` on the transactions collection. */
  const seenIndexes = new Set<string>()

  class TestBot extends Helper {
    public ledger = ledger
    public transactions = transactions
    /** Every payload the bot persisted — the real `updateData` writes to Mongo
     * and does not mutate `this.data`, so the spot branch is read from here. */
    public updates: any[] = []
    public stopped = 0
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public log = false
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      symbol: { symbol: 'ARK-USDT', baseAsset: 'ARK', quoteAsset: 'USDT' },
      settings: {
        name: 'ARK Natural',
        pair: 'ARK-USDT',
        futures: opts.futures,
        coinm: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
        feeOrder: false,
      },
      feeBalance: 0,
      initialPrice: opts.initialPrice ?? 0,
      initialBalances: opts.initialBalances ?? { base: 0, quote: 0 },
      currentBalances: opts.currentBalances ?? { base: 0, quote: 0 },
      position: opts.position ?? { side: PositionSide.LONG, qty: 0, price: 0 },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    public userProfitByHourDb: any = {
      updateData: (filter: any, update: any) => {
        ledger.push({ filter, update })
        return Promise.resolve({ status: StatusEnum.ok, data: {} })
      },
    }
    public transactionDb: any = {
      createData: (doc: any) => {
        if (doc.index && seenIndexes.has(doc.index)) {
          // What the unique index answers on a replayed fill.
          return Promise.resolve({
            status: StatusEnum.notok,
            reason: `E11000 duplicate key error … index: ${doc.index}`,
          })
        }
        if (doc.index) {
          seenIndexes.add(doc.index)
        }
        transactions.push(doc)
        return Promise.resolve({
          status: StatusEnum.ok,
          data: { ...doc, _id: `t${transactions.length}` },
        })
      },
    }
    get futures() {
      return !!this.data?.settings.futures
    }
    get coinm() {
      return !!this.data?.settings.coinm
    }
    /** The real writer, so the hour bucketing is under test too. */
    saveProfitToDb(usd: number, time: number) {
      return (MainBot.prototype as any).saveProfitToDb.call(this, usd, time)
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    shouldProceed() {
      return true
    }
    async stop() {
      this.stopped += 1
    }
    // --- what `closeBotByTp` needs to reach its spot close branch ---
    /** The closing order the bot places itself, answered FILLED by the venue. */
    public placed: any = null
    get allOrders() {
      return []
    }
    async getExchangeInfo() {
      return {
        pair: 'ARK-USDT',
        priceAssetPrecision: 9,
        baseAsset: { minAmount: 0.1, step: 0.00001, name: 'ARK' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDT' },
      }
    }
    async cancelAllOrder() {}
    async getLatestPrice() {
      return 9
    }
    async sellBaseAmount() {
      return 10
    }
    getOrderId(prefix: string) {
      return prefix
    }
    async sendGridToExchange() {
      return this.placed
    }
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

/** The closing fill, as the venue reported it. */
const closeOrder = (over: any = {}) => ({
  clientOrderId: 'GRID-TP-764',
  orderId: '764',
  symbol: 'ARK-USDT',
  baseAsset: 'ARK',
  quoteAsset: 'USDT',
  side: OrderSideEnum.sell,
  type: 'MARKET',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.stop,
  price: '0.142958585',
  origQty: '672',
  executedQty: '672',
  cummulativeQuoteQty: '96.068',
  updateTime: Date.UTC(2026, 8, 14, 6, 26, 48),
  transactTime: Date.UTC(2026, 8, 14, 6, 26, 48),
  ...over,
})

const booked = (bot: any) =>
  bot.ledger.reduce(
    (sum: number, r: LedgerRow) => sum + r.update.$inc.profitUsd,
    0,
  )

describe('grid close P&L reaches the profit ledger (spec 045, issue #764)', () => {
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

  describe('§4.1 the futures position close books to the ledger', () => {
    const makeFuturesBot = () =>
      makeBot({
        futures: true,
        // Sized to the reported close: 672 ARK entered at 0.1614 and exited at
        // 0.142958585 realises −12.39263 with a zero maker fee.
        position: { side: PositionSide.LONG, qty: 672, price: 0.1614 },
      })

    it('writes the close P&L the statistics read', async () => {
      const bot = makeFuturesBot()
      await bot.profitAfterPositionClosed(closeOrder())
      expect(bot.ledger).to.have.length(1)
      expect(booked(bot)).to.be.closeTo(REPORTED_CLOSE_USD, 1e-4)
    })

    it('books it against the user, the bot type and the paper context', async () => {
      const bot = makeFuturesBot()
      await bot.profitAfterPositionClosed(closeOrder())
      expect(bot.ledger[0].filter).to.include({
        userId: USER_ID,
        botType: BotType.grid,
        paperContext: true,
        terminal: false,
      })
    })

    it('buckets it on the hour of the fill, not the hour of the restart', async () => {
      const bot = makeFuturesBot()
      await bot.profitAfterPositionClosed(closeOrder())
      expect(bot.ledger[0].filter.time).to.equal(Date.UTC(2026, 8, 14, 6, 0, 0))
    })

    it('#764 leaves the ledger and `bot.profit` agreeing on the close', async () => {
      const bot = makeFuturesBot()
      await bot.profitAfterPositionClosed(closeOrder())
      expect(booked(bot)).to.be.closeTo(bot.data.profit.totalUsd, 1e-9)
    })

    it('§4.5 still updates `bot.profit` exactly as before', async () => {
      const bot = makeFuturesBot()
      await bot.profitAfterPositionClosed(closeOrder())
      expect(bot.data.profit.totalUsd).to.be.closeTo(REPORTED_CLOSE_USD, 1e-4)
      expect(bot.data.profit.total).to.be.closeTo(REPORTED_CLOSE_USD, 1e-4)
    })

    it('§4.3 futures: a replayed fill books nothing a second time', async () => {
      const bot = makeFuturesBot()
      await bot.profitAfterPositionClosed(closeOrder())
      // What every caller does immediately after awaiting it.
      bot.resetPosition()
      await bot.profitAfterPositionClosed(closeOrder())
      expect(bot.ledger).to.have.length(1)
      expect(booked(bot)).to.be.closeTo(REPORTED_CLOSE_USD, 1e-4)
    })

    it('books nothing when there is no position to close', async () => {
      const bot = makeBot({ futures: true })
      await bot.profitAfterPositionClosed(closeOrder())
      expect(bot.ledger).to.have.length(0)
    })
  })

  describe('§4.2 the spot stop fill books to the ledger', () => {
    /**
     * 10 base bought for 100 quote, sold at 9: a −10 quote result, and −10 USD
     * at the stubbed rate of 1.
     */
    const makeSpotBot = () =>
      makeBot({
        futures: false,
        initialPrice: 10,
        initialBalances: { base: 0, quote: 100 },
        currentBalances: { base: 10, quote: 0 },
      })

    const spotFill = (over: any = {}) =>
      closeOrder({
        price: '9',
        origQty: '10',
        executedQty: '10',
        cummulativeQuoteQty: '90',
        ...over,
      })

    it('writes the close P&L the statistics read', async () => {
      const bot = makeSpotBot()
      await bot.processFilledStop(spotFill())
      expect(bot.transactions).to.have.length(1)
      expect(bot.ledger).to.have.length(1)
      expect(booked(bot)).to.be.closeTo(-10, 1e-9)
    })

    it('books the same figure the transaction recorded', async () => {
      const bot = makeSpotBot()
      await bot.processFilledStop(spotFill())
      expect(booked(bot)).to.be.closeTo(bot.transactions[0].profitUsdt, 1e-9)
    })

    it('buckets it on the hour of the fill', async () => {
      const bot = makeSpotBot()
      await bot.processFilledStop(spotFill())
      expect(bot.ledger[0].filter.time).to.equal(Date.UTC(2026, 8, 14, 6, 0, 0))
    })

    it('§4.3 spot: a replayed fill the unique index refuses books nothing', async () => {
      const bot = makeSpotBot()
      await bot.processFilledStop(spotFill())
      await bot.processFilledStop(spotFill())
      expect(bot.transactions).to.have.length(1)
      expect(bot.ledger).to.have.length(1)
      expect(booked(bot)).to.be.closeTo(-10, 1e-9)
    })

    it('§4.5 still persists the same `bot.profit` as before', async () => {
      const bot = makeSpotBot()
      await bot.processFilledStop(spotFill())
      const persisted = bot.updates.filter((u: any) => u.profit).pop()
      expect(persisted.profit.totalUsd).to.be.closeTo(-10, 1e-9)
    })

    describe('§4.4 the other `Stop order filled` emitter books the same fill once', () => {
      /**
       * `closeBotByTp` places the closing order and handles a synchronously
       * FILLED answer; the user stream delivers the SAME `clientOrderId` to
       * `processFilledStop`. Whichever runs first, the fill is one fill.
       */
      const driveCloseBotByTp = (bot: any, fill: any) => {
        bot.placed = fill
        bot.data.settings.slAction = 'stopAndSell'
        return bot.closeBotByTp(
          BOT_ID,
          { symbol: 'ARK-USDT', price: 9, time: 0, volume: 0 },
          { value: 'sl', text: 'stop loss' },
          true,
        )
      }

      it('books once when it wins the race with the stream', async () => {
        const bot = makeSpotBot()
        await driveCloseBotByTp(bot, spotFill())
        await bot.processFilledStop(spotFill())
        expect(bot.transactions).to.have.length(1)
        expect(bot.ledger).to.have.length(1)
        expect(booked(bot)).to.be.closeTo(-10, 1e-9)
      })

      it('books once when the stream wins the race with it', async () => {
        const bot = makeSpotBot()
        await bot.processFilledStop(spotFill())
        await driveCloseBotByTp(bot, spotFill())
        expect(bot.transactions).to.have.length(1)
        expect(bot.ledger).to.have.length(1)
        expect(booked(bot)).to.be.closeTo(-10, 1e-9)
      })
    })
  })
})
