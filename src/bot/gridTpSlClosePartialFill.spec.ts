process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `274.part-filled-futures-grid-tp-sl-close-stalls-the-close`.
 *
 * A futures grid whose take profit or stop loss fires with "stop and sell"
 * places a reduce-only close and re-runs `closeBotByTp` on a timer until it
 * fills. When that close was held `PARTIALLY_FILLED`, the re-run returned
 * without cancelling, re-placing or re-arming the timer; the enter-market
 * timer hit the same guard. The rest of the position stayed open with nothing
 * managing it, and the part already sold never reached position or profit.
 *
 * These drive the REAL `closeBotByTp`, `settleRestingCloses`,
 * `profitAfterPositionClosed` and the position fold (borrowed from `MainBot`).
 * Venue, Mongo and Redis are stubbed. Harness shape from
 * `gridClosePartialFill.spec.ts` (spec 273).
 *
 * Run: `npm test` (mocha) from core/, or
 *   env NODE_NO_WARNINGS=1 NODE_ENV=testing TS_NODE_TRANSPILE_ONLY=true \
 *   npx mocha --timeout 200000 --exit -r ts-node/register \
 *   src/bot/gridTpSlClosePartialFill.spec.ts
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
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'
import MainBot from './main'

const BOT_ID = 'cccccccccccccccccccc0274'
const USER_ID = 'dddddddddddddddddddd0274'
const ENTRY = 0.009068
const CLOSE_PRICE = 0.008881

let Helper: any

/** A reduce-only close of `origQty` at 0.008881, as the venue holds it. */
const closeOrder = (
  id: string,
  status: string,
  executed: number,
  origQty = 350,
  type = 'LIMIT',
) => ({
  clientOrderId: id,
  orderId: `${id}-venue`,
  botId: BOT_ID,
  symbol: 'SKRUSDT',
  baseAsset: 'SKR',
  quoteAsset: 'USDT',
  side: OrderSideEnum.sell,
  type,
  status,
  typeOrder: TypeOrderEnum.stop,
  price: `${CLOSE_PRICE}`,
  origPrice: `${CLOSE_PRICE}`,
  origQty: `${origQty}`,
  executedQty: `${executed}`,
  updateTime: 1795553857353,
})

type Answer = (order: any, promote: boolean) => any

const MSG = { symbol: 'SKRUSDT', price: CLOSE_PRICE, time: 0, volume: 0 }
const TP = { value: 'tp', text: 'TP trigger' }
const SL = { value: 'sl', text: 'SL trigger' }

const makeBot = (opts: {
  resting?: any[]
  cancelAnswer?: Answer
  placeAnswer?: (grid: any, additional: any) => any
  futures?: boolean
  tpSlLimit?: boolean
  slLimit?: boolean
  enterMarketTimeout?: number
}) => {
  const futures = opts.futures ?? true
  class TestBot extends Helper {
    public stopped: any[] = []
    public sweeps: any[] = []
    public sent: any[] = []
    public cancels: { id: string; promote: boolean }[] = []
    public unknown: any[] = []
    public savedProfit: number[] = []
    public refusals: string[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public log = false
    public enterMarketTimeout = opts.enterMarketTimeout ?? 0
    public orderLimitRepositionTimeout = 60_000
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
        futures,
        coinm: false,
        strategy: StrategyEnum.long,
        futuresStrategy: FuturesStrategyEnum.long,
        profitCurrency: 'quote',
        tpSlAction: 'stopAndSell',
        slAction: 'stopAndSell',
        tpSlLimit: opts.tpSlLimit ?? true,
        slLimit: opts.slLimit ?? false,
      },
      position: { side: PositionSide.LONG, qty: 350, price: ENTRY },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    public botEventDb: any = {
      createData: () => Promise.resolve({ status: StatusEnum.ok, data: {} }),
    }
    orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    calculateAbstractPosition = (MainBot as any).prototype
      .calculateAbstractPosition
    get futures() {
      return futures
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
    get allOrders() {
      return [...this.orderMap.values()]
    }
    getOrdersByStatusAndDealId(q: {
      status?: string | string[]
      defaultStatuses?: boolean
    }) {
      const want = q.defaultStatuses
        ? this.orderStatuses
        : Array.isArray(q.status)
          ? q.status
          : [q.status]
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
        this.noteCancelRefused(order, answer)
        return undefined
      }
      if (answer) {
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
    /**
     * The sweep as it behaved before spec 274: it cancels every resting
     * order with the default promotion, and a promoted close goes to the
     * unknown-order (fill) path.
     */
    async cancelAllOrder(...args: any[]) {
      this.sweeps.push(args)
      for (const o of this.getOrdersByStatusAndDealId({
        status: this.orderStatuses,
      })) {
        const answer = await this.cancelOrderOnExchange(o, true)
        if (answer?.status === 'FILLED') {
          await this.handleUnknownOrder(answer)
        }
      }
      return undefined
    }
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
      return CLOSE_PRICE
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
    updateData() {}
    emit() {}
    async sendGridToExchange(grid: any, additional: any) {
      this.sent.push({ grid, additional })
      return opts.placeAnswer?.(grid, additional)
    }
    resetPosition() {
      this.data.position = { ...this.data.position, qty: 0 }
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

const rests = (grid: any, additional: any) =>
  closeOrder(grid.newClientOrderId, 'NEW', 0, grid.qty, additional.type)
const fills = (grid: any, additional: any) =>
  closeOrder(
    grid.newClientOrderId,
    'FILLED',
    grid.qty,
    grid.qty,
    additional.type,
  )

const done = (bot: any) => {
  for (const t of ['limitTimer', 'enterMarketTimer', 'closeOrderTimer']) {
    if (bot[t]) {
      clearTimeout(bot[t])
    }
  }
}

/** (close - entry) * qty * (1 - maker), the fold `profitAfterPositionClosed` books. */
const profitOf = (qty: number) => (CLOSE_PRICE - ENTRY) * qty * (1 - 0.0002)

describe('a part-filled futures grid TP/SL close keeps closing (spec 274)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.1 the re-run of a take profit whose LIMIT close part-filled', () => {
    it('cancels it without promotion, books 150, re-places 200 reduce-only and re-arms the timer', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
        placeAnswer: rests,
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      const timer = bot.limitTimer ?? null
      done(bot)

      expect(bot.cancels).to.deep.equal([
        { id: 'GRID-TP-partial', promote: false },
      ])
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.data.profit.total).to.be.closeTo(profitOf(150), 1e-12)
      expect(bot.savedProfit).to.have.length(1)
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
      expect(timer).to.not.equal(null)
      expect(bot.stopped).to.have.length(0)
    })

    it('books the part once even when the re-run comes again', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: (o) =>
          o.clientOrderId === 'GRID-TP-partial'
            ? { status: 'CANCELED', executedQty: '150' }
            : { status: 'CANCELED', executedQty: '0' },
        placeAnswer: rests,
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      // The new 200 close rests unfilled; the next re-run re-prices it.
      bot.orderMap.set(
        bot.sent[0].grid.newClientOrderId,
        rests(bot.sent[0].grid, bot.sent[0].additional),
      )
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.savedProfit).to.have.length(1)
      expect(bot.sent.map((s: any) => s.grid.qty)).to.deep.equal([200, 200])
    })
  })

  describe('§4.2 the enter-market timer while a part-filled LIMIT close rests', () => {
    it('cancels the LIMIT, books its part and closes the rest at market', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
        placeAnswer: fills,
        enterMarketTimeout: 120_000,
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP, true)
      done(bot)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid.qty).to.equal(200)
      expect(bot.sent[0].additional).to.include({
        type: 'MARKET',
        reduceOnly: true,
      })
      // 150 at the LIMIT, then the 200 the MARKET closed.
      expect(bot.data.profit.total).to.be.closeTo(profitOf(350), 1e-12)
      expect(bot.data.position.qty).to.equal(0)
      expect(bot.stopped).to.have.length(1)
    })
  })

  describe('§4.3 a stop loss whose MARKET close part-filled', () => {
    it('books the part and closes the rest', async () => {
      const partial = closeOrder(
        'GRID-SL-partial',
        'PARTIALLY_FILLED',
        150,
        350,
        'MARKET',
      )
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
        placeAnswer: fills,
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, SL)
      done(bot)
      expect(bot.cancels[0]).to.deep.equal({
        id: 'GRID-SL-partial',
        promote: false,
      })
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid.qty).to.equal(200)
      expect(bot.sent[0].additional.type).to.equal('MARKET')
      expect(bot.data.profit.total).to.be.closeTo(profitOf(350), 1e-12)
      expect(bot.stopped).to.have.length(1)
    })
  })

  describe('§4.4 a resting close the stream never reported filled', () => {
    it('is cancelled without promotion, so its part is not booked as a full close', async () => {
      const silent = closeOrder('GRID-TP-silent', 'NEW', 0)
      const bot = makeBot({
        resting: [silent],
        cancelAnswer: (_o, promote) =>
          promote
            ? { status: 'FILLED', executedQty: '150' }
            : { status: 'CANCELED', executedQty: '150' },
        placeAnswer: rests,
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      expect(bot.cancels[0].promote).to.equal(false)
      expect(bot.unknown).to.have.length(0)
      expect(bot.data.position.qty).to.equal(200)
      expect(bot.sent[0].grid.qty).to.equal(200)
    })
  })

  describe('§4.5 the cancel does not go through', () => {
    it('places nothing, books nothing, and retries on the timer', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({ resting: [partial], cancelAnswer: () => null })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      const timer = bot.limitTimer ?? null
      done(bot)
      expect(bot.sent).to.have.length(0)
      expect(bot.data.position.qty).to.equal(350)
      expect(timer).to.not.equal(null)
      expect(bot.stopped).to.have.length(0)
    })
  })

  describe('§4.6 the close filled in full before the cancel reached it', () => {
    it('hands it to the fill path and places nothing', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => ({ status: 'FILLED', executedQty: '350' }),
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      expect(bot.unknown).to.have.length(1)
      expect(bot.sent).to.have.length(0)
      expect(bot.data.position.qty).to.equal(350)
    })
  })

  describe('§4.7 the key may not cancel', () => {
    it('reports it once and neither re-places nor re-tries (spec 232)', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        cancelAnswer: () => 'Permission denied for this API key',
        enterMarketTimeout: 120_000,
      })
      bot.blockLimit = true
      bot.enterMarketTimer = setTimeout(() => undefined, 120_000)
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      const timers = [bot.limitTimer ?? null, bot.enterMarketTimer ?? null]
      done(bot)
      expect(bot.refusals).to.have.length(1)
      expect(bot.sent).to.have.length(0)
      expect(timers).to.deep.equal([null, null])
    })
  })

  describe('§4.8 unchanged behaviour', () => {
    it('a close held FILLED ends the re-run with nothing placed', async () => {
      const filled = closeOrder('GRID-TP-filled', 'FILLED', 350)
      const bot = makeBot({ resting: [filled] })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      expect(bot.cancels).to.have.length(0)
      expect(bot.sent).to.have.length(0)
    })

    it('a first trigger with nothing resting places the full close as before', async () => {
      const bot = makeBot({ placeAnswer: fills })
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      expect(bot.cancels).to.have.length(0)
      expect(bot.sweeps).to.have.length(1)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid.qty).to.equal(350)
      expect(bot.data.profit.total).to.be.closeTo(profitOf(350), 1e-12)
      expect(bot.stopped).to.have.length(1)
    })

    it('spot keeps returning on a part-filled close', async () => {
      const partial = closeOrder('GRID-TP-partial', 'PARTIALLY_FILLED', 150)
      const bot = makeBot({
        resting: [partial],
        futures: false,
        cancelAnswer: () => ({ status: 'CANCELED', executedQty: '150' }),
      })
      bot.blockLimit = true
      await bot.closeBotByTp(BOT_ID, MSG, TP)
      done(bot)
      expect(bot.cancels).to.have.length(0)
      expect(bot.sweeps).to.have.length(0)
      expect(bot.sent).to.have.length(0)
    })
  })

  describe('§4.9 a restart finds the close part-filled', () => {
    const restartBot = (held: string, futures = true) => {
      const close = closeOrder(
        'GRID-TP-partial',
        held,
        held === 'NEW' ? 0 : 100,
      )
      const bot = makeBot({ resting: [close], futures })
      bot.serviceRestart = true
      bot.restart = true
      bot.sellAtStop = [] as any[]
      bot.dbWrites = [] as any[]
      bot.shouldProceed = () => true
      bot.startMethod = () => 'm'
      bot.endMethod = () => undefined
      bot.beginOrderCheckRun = () => undefined
      bot.getOrder = async () => ({
        status: StatusEnum.ok,
        data: { ...close, status: 'PARTIALLY_FILLED', executedQty: '150' },
      })
      bot.mergeCommonOrderWithOrder = async (data: any, held: any) => ({
        ...held,
        ...data,
      })
      bot.setOrder = (o: any) => bot.orderMap.set(o.clientOrderId, o)
      bot.updateOrderOnDb = (o: any) => bot.dbWrites.push(o)
      bot.processSellAtStop = async (type: CloseGRIDTypeEnum) => {
        bot.sellAtStop.push(type)
      }
      return bot
    }

    for (const held of ['PARTIALLY_FILLED', 'NEW']) {
      it(`futures, held ${held}: settles it through the close path`, async () => {
        const bot = restartBot(held)
        await bot.checkOrders(CLOSE_PRICE).catch(() => undefined)
        expect(bot.sellAtStop).to.deep.equal([CloseGRIDTypeEnum.closeByLimit])
        expect(bot.orderMap.get('GRID-TP-partial').executedQty).to.equal('150')
        expect(bot.dbWrites).to.have.length(1)
      })
    }

    it('spot, held NEW: records the part fill and stops there as before', async () => {
      const bot = restartBot('NEW', false)
      await bot.checkOrders(CLOSE_PRICE).catch(() => undefined)
      expect(bot.sellAtStop).to.have.length(0)
      expect(bot.dbWrites).to.have.length(1)
    })
  })
})
