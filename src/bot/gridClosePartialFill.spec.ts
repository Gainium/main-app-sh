process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `273.part-filled-futures-grid-close-stalls-the-close`.
 *
 * A futures grid closed "at limit" re-prices its reduce-only close every few
 * seconds. Once that close had filled in part, `processSellAtStop` found it as
 * a `PARTIALLY_FILLED` stop order and returned without doing anything: no
 * cancel, no new close, no re-price timer. A "close at market" sent after that
 * was swallowed the same way. The final "cancel" then dropped the executed
 * part, so the bot's position and profit never saw it.
 *
 * These drive the REAL `processSellAtStop`, `stop`, `profitAfterPositionClosed`
 * and the position fold (borrowed from `MainBot`). Venue, Mongo and Redis are stubbed.
 * Harness shape from `gridCloseFlatFuturesPosition.spec.ts` (spec 240).
 *
 * Run: `npm test` (mocha) from core/, or
 *   env NODE_NO_WARNINGS=1 NODE_ENV=testing TS_NODE_TRANSPILE_ONLY=true \
 *   npx mocha --timeout 200000 --exit -r ts-node/register \
 *   src/bot/gridClosePartialFill.spec.ts
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import {
  BotType,
  CloseGRIDTypeEnum,
  ExchangeEnum,
  FuturesStrategyEnum,
  OrderSideEnum,
  PositionSide,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'
import MainBot from './main'

const BOT_ID = 'cccccccccccccccccccc0273'
const USER_ID = 'dddddddddddddddddddd0273'
const ENTRY = 0.009068
const CLOSE_PRICE = 0.008881

let Helper: any

/** A LIMIT reduce-only close of 350 at 0.008881, as the venue holds it. */
const closeOrder = (
  id: string,
  status: string,
  executed: number,
  origQty = 350,
) => ({
  clientOrderId: id,
  orderId: `${id}-venue`,
  botId: BOT_ID,
  symbol: 'SKRUSDT',
  baseAsset: 'SKR',
  quoteAsset: 'USDT',
  side: OrderSideEnum.sell,
  type: 'LIMIT',
  status,
  typeOrder: TypeOrderEnum.stop,
  price: `${CLOSE_PRICE}`,
  origPrice: `${CLOSE_PRICE}`,
  origQty: `${origQty}`,
  executedQty: `${executed}`,
  updateTime: 1795553857353,
})

type Answer = (order: any, promote: boolean) => any

const makeBot = (opts: {
  resting?: any[]
  /** What the venue answers to a cancel of a resting close. */
  cancelAnswer?: Answer
  /** What the venue answers to a new close. */
  placeAnswer?: (grid: any, additional: any) => any
  position?: { side: PositionSide; qty: number; price: number }
}) => {
  class TestBot extends Helper {
    public stopped: any[] = []
    public sweeps: any[] = []
    public sent: any[] = []
    public cancels: { id: string; promote: boolean }[] = []
    public filledStops: any[] = []
    public unknown: any[] = []
    public savedProfit: number[] = []
    public updates: any[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public log = false
    public limitRepositionTimeout = 60_000
    public orderMap = new Map<string, any>(
      (opts.resting ?? []).map((o) => [o.clientOrderId, o]),
    )
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.bybitUsdm,
      paperContext: false,
      status: 'open',
      symbol: { symbol: 'SKRUSDT', baseAsset: 'SKR', quoteAsset: 'USDT' },
      settings: {
        pair: 'SKRUSDT',
        futures: true,
        coinm: false,
        strategy: StrategyEnum.long,
        futuresStrategy: FuturesStrategyEnum.long,
        profitCurrency: 'quote',
      },
      position: opts.position ?? {
        side: PositionSide.LONG,
        qty: 350,
        price: ENTRY,
      },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    // The real position fold (as in `gridPositionDoubleBook.spec.ts`).
    calculateAbstractPosition = (MainBot as any).prototype
      .calculateAbstractPosition
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    get hedge() {
      return false
    }
    get isShort() {
      return false
    }
    getOrdersByStatusAndDealId(q: { status?: string | string[] }) {
      const want = Array.isArray(q.status) ? q.status : [q.status]
      return [...this.orderMap.values()].filter((o) => want.includes(o.status))
    }
    deleteOrder(id: string) {
      this.orderMap.delete(id)
    }
    async cancelOrderOnExchange(
      order: any,
      _setErrors = true,
      _remove = true,
      promote = true,
    ) {
      this.cancels.push({ id: order.clientOrderId, promote })
      const answer = opts.cancelAnswer?.(order, promote)
      if (typeof answer === 'string') {
        // A refusal: the real method reports it through `noteCancelRefused`.
        this.noteCancelRefused(order, answer)
        return undefined
      }
      if (answer) {
        // The real method copies the venue's answer onto the held object.
        Object.assign(order, answer)
        if (+order.executedQty === 0 && order.status === 'CANCELED') {
          this.orderMap.delete(order.clientOrderId)
        }
        return order
      }
      return undefined
    }
    async handleUnknownOrder(order: any) {
      this.unknown.push(order)
    }
    async stop(...args: any[]) {
      this.stopped.push(args)
    }
    async afterBotStop() {}
    async cancelAllOrder(...args: any[]) {
      this.sweeps.push(args)
      return undefined
    }
    public refusals: string[] = []
    async reportCloseCancelRefused(r?: string) {
      if (r) {
        this.refusals.push(r)
      }
    }
    async getExchangeInfo() {
      return {
        pair: 'SKRUSDT',
        priceAssetPrecision: 6,
        baseAsset: { minAmount: 1, step: 1, name: 'SKR' },
        quoteAsset: { minAmount: 5, step: 0.000001, name: 'USDT' },
      }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getLatestPrice() {
      return 0.00888
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.00055 }
    }
    async getUsdRate() {
      return 1
    }
    saveProfitToDb(usd: number) {
      this.savedProfit.push(usd)
    }
    updateData(d: any) {
      this.updates.push(d)
    }
    emit() {}
    async sendGridToExchange(grid: any, additional: any) {
      this.sent.push({ grid, additional })
      return opts.placeAnswer?.(grid, additional)
    }
    async processFilledStop(order: any) {
      this.filledStops.push(order)
    }
    updateProgress() {}
    getOrderId(prefix: string) {
      return `${prefix}-${this.sent.length}`
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  return new (TestBot as any)()
}

const rests = (grid: any) => ({
  ...closeOrder(grid.newClientOrderId, 'NEW', 0, grid.qty),
})

const done = (bot: any) => {
  if (bot.closeOrderTimer) {
    clearTimeout(bot.closeOrderTimer)
  }
}

describe('a part-filled futures grid close keeps closing (spec 273)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.1 the re-price of a part-filled LIMIT close', () => {
    it('cancels it without promotion, books 150, re-places 200 reduce-only and keeps the timer', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
        placeAnswer: rests,
      })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      done(bot)

      expect(bot.cancels).to.deep.equal([
        { id: 'GRID-TP-partial', promote: false },
      ])
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.data.position.side).to.equal(PositionSide.LONG)
      // (0.008881 - 0.009068) * 150 - the close fill's fee (spec 276)
      const expected =
        (CLOSE_PRICE - ENTRY) * 150 - CLOSE_PRICE * 150 * 0.0002
      expect(bot.data.profit.total).to.be.closeTo(expected, 1e-12)
      expect(bot.savedProfit).to.have.length(1)
      expect(bot.sweeps).to.have.length(1)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid).to.include({
        side: OrderSideEnum.sell,
        qty: 200,
        type: TypeOrderEnum.stop,
      })
      expect(bot.sent[0].additional).to.include({
        type: 'LIMIT',
        reduceOnly: true,
      })
      expect(bot.closeOrderTimer ?? null).to.not.equal(null)
      expect(bot.stopped).to.have.length(0)
    })

    it('books the part once even when the re-price runs again', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
        placeAnswer: rests,
      })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      done(bot)
      // The terminal row is still held (it has fills); a second pass must
      // neither cancel nor book it again.
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      done(bot)
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.savedProfit).to.have.length(1)
      expect(bot.sent.map((s: any) => s.grid.qty)).to.deep.equal([200, 200])
    })
  })

  describe('§4.2 close at market while a part-filled LIMIT close rests', () => {
    it('cancels the LIMIT, books its part and sweeps the rest at market', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
        placeAnswer: (grid) => ({
          ...closeOrder(grid.newClientOrderId, 'FILLED', grid.qty, grid.qty),
          type: 'MARKET',
        }),
      })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByMarket)
      done(bot)
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid.qty).to.equal(200)
      expect(bot.sent[0].additional).to.include({
        type: 'MARKET',
        reduceOnly: true,
      })
      expect(bot.filledStops).to.have.length(1)
    })
  })

  describe('§4.3 the cancel does not go through', () => {
    it('places nothing, books nothing, and retries on the timer', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({ resting: [partial], cancelAnswer: () => null })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      expect(bot.sent).to.have.length(0)
      expect(bot.data.position.qty).to.equal(350)
      expect(bot.closeOrderTimer ?? null).to.not.equal(null)
      done(bot)
      expect(bot.stopped).to.have.length(0)
    })
  })

  describe('§4.4 the close filled in full before the cancel reached it', () => {
    it('hands it to the fill path and places nothing', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'FILLED', executedQty: '350' }),
      })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      done(bot)
      expect(bot.unknown).to.have.length(1)
      expect(bot.unknown[0].status).to.equal('FILLED')
      expect(bot.sent).to.have.length(0)
      expect(bot.data.position.qty).to.equal(350)
    })
  })

  describe('§4.5 a resting close the stream never reported filled', () => {
    it('is cancelled without promotion, so its part is not booked as a full close', async () => {
      const silent = closeOrder('GRID-TP-silent', 'NEW', 0)
      const bot = makeBot({
        resting: [silent],
        cancelAnswer: (_o, promote) =>
          // What the promoting cancel would have turned this into.
          promote
            ? { status: 'FILLED', executedQty: '150' }
            : { status: 'CANCELED', executedQty: '150' },
        placeAnswer: rests,
      })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      done(bot)
      expect(bot.cancels[0].promote).to.equal(false)
      expect(bot.unknown).to.have.length(0)
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.sent[0].grid.qty).to.equal(200)
    })
  })

  describe('§4.6 "cancel" (stop without closing)', () => {
    it('books the executed part and places no close', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
      })
      // Core's own `stop`, not the harness stub. Teardown past the sweep
      // touches services the harness does not have; only the part up to and
      // including the sweep matters here.
      bot.exchange = undefined
      await Helper.prototype.stop
        .call(bot, true, CloseGRIDTypeEnum.cancel)
        .catch(() => undefined)
      expect(bot.sweeps).to.have.length(1)
      expect(bot.cancels).to.deep.equal([
        { id: 'GRID-TP-partial', promote: false },
      ])
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.sent).to.have.length(0)
    })
  })

  describe('§4.7 the key may not cancel', () => {
    it('reports it once and neither re-places nor re-tries (spec 232)', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => 'Permission denied for this API key',
      })
      await bot.processSellAtStop(CloseGRIDTypeEnum.closeByLimit)
      expect(bot.refusals).to.have.length(1)
      expect(bot.sent).to.have.length(0)
      expect(bot.closeOrderTimer ?? null).to.equal(null)
      done(bot)
    })
  })
})
