process.env.NODE_ENV = 'testing'

/**
 * A grid bot whose budget cannot fund every level at the exchange's per-order
 * minimum must refuse to start. Before this change the sizing routine raised
 * every level to the exchange minimum and the bot started anyway, so the start
 * order — sized from the inflated grid — committed a multiple of the budget.
 * On futures at high leverage that order passes the balance check and fills.
 *
 * The harness builds a grid bot on the real helper mixin and borrows the real
 * sizing routines from `MainBot`, so the quantities under test are the ones the
 * engine computes. The pair is synthetic: price ~0.05, 100-unit quantity step,
 * minimum order 5 quote — a coarse-step, low-priced perpetual.
 *
 * Enforces specs/068 §3, §4.4–§4.8.
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
  StrategyEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

let Helper: any

const LOW = 0.03
const TOP = 0.09
const LEVELS = 175
const PRICE = 0.0476
const MIN_NOTIONAL = 5
const STEP = 100

const makeBot = (opts: {
  budget: number
  futures?: boolean
  orderFixedIn?: 'base' | 'quote'
  profitCurrency?: 'base' | 'quote'
  botType?: BotType
}) => {
  class TestBot extends Helper {
    public errors: string[] = []
    public stopped = 0
    public sent: any[] = []
    public botId = 'test-grid-bot'
    public userId = 'test-user'
    public botType = opts.botType ?? BotType.grid
    public log = false
    public data: any = {
      _id: 'test-grid-bot',
      userId: 'test-user',
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      created: new Date('2026-01-01'),
      symbol: { symbol: 'ABC-USDT', baseAsset: 'ABC', quoteAsset: 'USDT' },
      settings: {
        name: 'ABC grid',
        pair: 'ABC-USDT',
        futures: opts.futures ?? true,
        coinm: false,
        leverage: 25,
        strategy: StrategyEnum.long,
        futuresStrategy: 'LONG',
        profitCurrency: opts.profitCurrency ?? 'quote',
        orderFixedIn: opts.orderFixedIn ?? 'base',
        gridType: 'geometric',
        lowPrice: LOW,
        topPrice: TOP,
        levels: LEVELS,
        sellDisplacement: 0,
        budget: opts.budget,
        updatedBudget: true,
        feeOrder: false,
      },
      position: { side: PositionSide.LONG, qty: 0, price: 0 },
      initialBalances: { base: 0, quote: 0 },
      currentBalances: { base: 0, quote: 0 },
      workingShift: [],
    }
    get futures() {
      return !!this.data?.settings.futures
    }
    get coinm() {
      return !!this.data?.settings.coinm
    }
    get isBitget() {
      return false
    }
    get currentLeverage() {
      return this.data?.settings.leverage ?? 1
    }
    // --- the real sizing routines, borrowed from the engine ---
    generateBasicGrids(a: any) {
      return (MainBot.prototype as any).generateBasicGrids.call(this, a)
    }
    generateGridsOnPrice(...a: any[]) {
      return (MainBot.prototype as any).generateGridsOnPrice.apply(this, a)
    }
    getSellBuyCount(...a: any[]) {
      return (MainBot.prototype as any).getSellBuyCount.apply(this, a)
    }
    findClosestGrids(...a: any[]) {
      return (MainBot.prototype as any).findClosestGrids.apply(this, a)
    }
    baseAssetPrecision(s: string) {
      return (MainBot.prototype as any).baseAssetPrecision.call(this, s)
    }
    // --- I/O, stubbed ---
    async getExchangeInfo() {
      return {
        pair: 'ABC-USDT',
        priceAssetPrecision: 6,
        maxOrders: 500,
        baseAsset: { minAmount: STEP, step: STEP, name: 'ABC' },
        quoteAsset: { minAmount: MIN_NOTIONAL, step: 0.000001, name: 'USDT' },
      }
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.00055 }
    }
    async getLatestPrice() {
      return PRICE
    }
    async checkAssets() {
      return new Map([['USDT', { free: 1000, locked: 0 }]])
    }
    async sendOrderToExchange(o: any) {
      this.sent.push(o)
      return null
    }
    async sendGridToExchange(o: any) {
      this.sent.push(o)
      return null
    }
    async limitOrders() {}
    async clearAllOrderQuarantine() {}
    async runAfterLoading() {}
    async placeFeeOrder() {}
    generateInitialBalances() {}
    getOrdersByStatusAndDealId() {
      return []
    }
    getOrderId(prefix: string) {
      return prefix
    }
    async stop() {
      this.stopped += 1
    }
    async handleErrors(e: any) {
      this.errors.push(typeof e === 'string' ? e : e?.message)
    }
    sendEndProcess() {}
    updateProgress() {}
    updateData() {}
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

/** Everything `start()` touches that is not the guard or the start order. */
const stubStartIo = (bot: any) => {
  bot.loadData = async () => false
  bot.clearClassProperties = () => {}
  bot.startPriceTimer = () => {}
  bot.startConsumerHeartbeat = () => {}
  bot.checkPriceToStart = async () => true
  bot.fillExchangeInfo = async () => {}
  bot.loadOrders = async () => {}
  bot.getUserFees = async () => {}
  bot.avgPrice = () => {}
  bot.cancelAllOrder = async () => {}
  bot.getActiveOrders = async () => 0
  bot.trimWorkingShift = (w: any) => w
  bot.getWorkingTimeNumber = () => 0
  bot.pairsNotFound = new Set()
}

const fullGrid = async (bot: any) => {
  await bot.generateGrids()
  return (await bot.generateCurrentGrids(
    PRICE,
    OrderSideEnum.buy,
    true,
    false,
    true,
  )) as { qty: number; price: number; side: OrderSideEnum }[]
}

describe('grid bot refuses a budget below the exchange minimum (spec 068)', () => {
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

  describe('§3 the reproduction — the floor, and what it does to the start order', () => {
    it('sizes every level at the exchange minimum, not from the budget', async () => {
      const bot = makeBot({ budget: 5 })
      const grids = await fullGrid(bot)
      expect(grids.length).to.be.greaterThan(100)
      const committed = grids.reduce((a, g) => a + g.qty * g.price, 0)
      // The defect itself: a 5 budget commits hundreds.
      expect(committed).to.be.greaterThan(5 * 50)
      for (const g of grids) {
        expect(g.qty % STEP).to.equal(0)
        expect(g.qty).to.be.at.least(STEP)
      }
    })
  })

  describe('§4.4 the sizing routine reports, it does not decide', () => {
    it('reports the budget-derived level size and the minimum it lost to', async () => {
      const bot = makeBot({ budget: 5 })
      await fullGrid(bot)
      const r = bot.lastGridSizing
      expect(r, 'lastGridSizing').to.be.an('object')
      expect(r.unit).to.equal('base')
      // 5 / Σ(level prices) — well under one unit, against a 200-unit minimum
      // (5 / 0.03 = 166.67, rounded up to the 100 step).
      expect(r.wanted).to.be.greaterThan(0)
      expect(r.wanted).to.be.lessThan(1)
      expect(r.minimum).to.equal(200)
    })

    it('reports in quote for a quote-fixed grid', async () => {
      const bot = makeBot({ budget: 5, orderFixedIn: 'quote' })
      await fullGrid(bot)
      const r = bot.lastGridSizing
      expect(r.unit).to.equal('quote')
      expect(r.wanted).to.be.lessThan(0.1)
      // max(min notional 5, min quantity 100 × highest level price ~0.09)
      expect(r.minimum).to.be.closeTo(100 * TOP, 0.5)
    })

    it('leaves a well-funded grid exactly as sized from the budget', async () => {
      const bot = makeBot({ budget: 5000 })
      const grids = await fullGrid(bot)
      const r = bot.lastGridSizing
      expect(r.wanted).to.be.greaterThan(r.minimum)
      // Base-fixed: one size for every level, the budget-derived one.
      const sizes = new Set(grids.map((g) => g.qty))
      expect(sizes.size).to.equal(1)
      expect([...sizes][0]).to.be.closeTo(r.wanted, STEP)
    })
  })

  describe('§4.5 the start path refuses before any order', () => {
    it('refuses, reports both budgets, stops, and sends nothing', async () => {
      const bot = makeBot({ budget: 5 })
      await bot.generateGrids()
      const refused = await bot.refuseStartBelowMinimumBudget()
      expect(refused).to.equal(true)
      expect(bot.sent).to.have.length(0)
      expect(bot.stopped).to.equal(1)
      expect(bot.errors).to.have.length(1)
      expect(bot.errors[0]).to.contain('Budget 5 USDT')
      expect(bot.errors[0]).to.match(/minimum \d+(\.\d+)? USDT/)
      expect(bot.errors[0]).to.contain(`${LEVELS} levels`)
      expect(bot.errors[0]).to.contain('ABC-USDT')
    })

    it('names a minimum budget that the guard itself then accepts', async () => {
      const bot = makeBot({ budget: 5 })
      await bot.generateGrids()
      await bot.refuseStartBelowMinimumBudget()
      const needed = +bot.errors[0].match(/minimum (\d+(\.\d+)?) USDT/)![1]
      expect(needed).to.be.greaterThan(5 * 50)

      const funded = makeBot({ budget: needed })
      await funded.generateGrids()
      expect(await funded.refuseStartBelowMinimumBudget()).to.equal(false)
      expect(funded.errors).to.have.length(0)
      expect(funded.stopped).to.equal(0)
    })

    it('start() does not reach the start order when the budget is refused', async () => {
      const bot = makeBot({ budget: 5 })
      let swapCalls = 0
      bot.swapAssets = async () => {
        swapCalls += 1
      }
      stubStartIo(bot)
      await bot.start()
      expect(swapCalls).to.equal(0)
      expect(bot.stopped).to.equal(1)
      expect(bot.errors[0]).to.contain('Budget 5 USDT')
    })
  })

  describe('§4.6 a sufficient budget is untouched', () => {
    it('does not refuse, report an error or stop', async () => {
      const bot = makeBot({ budget: 5000 })
      await bot.generateGrids()
      expect(await bot.refuseStartBelowMinimumBudget()).to.equal(false)
      expect(bot.errors).to.have.length(0)
      expect(bot.stopped).to.equal(0)
    })
  })

  describe('§4.7 a service restart is never refused', () => {
    it('start() reaches the start path with the service-restart flag set', async () => {
      const bot = makeBot({ budget: 5 })
      let swapCalls = 0
      bot.swapAssets = async () => {
        swapCalls += 1
      }
      bot.serviceRestart = true
      stubStartIo(bot)
      // A legacy bot with no recorded balances is downgraded from service
      // restart to full restart inside start(); it must still not be refused.
      bot.data.realInitialBalances = null
      bot.data.lastBalanceChange = null
      await bot.start()
      expect(swapCalls).to.equal(1)
      expect(bot.stopped).to.equal(0)
      expect(bot.errors).to.have.length(0)
    })
  })

  describe('§4.7.1 a settings-edit reload is never refused', () => {
    for (const restart of [true, false]) {
      it(`start() reaches the start path during a reload (restart flag ${restart})`, async () => {
        const bot = makeBot({ budget: 5 })
        let swapCalls = 0
        bot.swapAssets = async () => {
          swapCalls += 1
        }
        stubStartIo(bot)
        bot.restartProcess = true
        bot.restart = restart
        await bot.start()
        expect(swapCalls).to.equal(1)
        expect(bot.stopped).to.equal(0)
        expect(bot.errors).to.have.length(0)
      })
    }
  })

  describe('§4.8 combo sizing through the same routine is untouched', () => {
    it('still floors a minigrid to the exchange minimum and never refuses', async () => {
      const bot = makeBot({ budget: 5, botType: BotType.combo })
      const grids = await fullGrid(bot)
      for (const g of grids) {
        expect(g.qty).to.be.at.least(STEP)
      }
      expect(bot.errors).to.have.length(0)
      expect(bot.stopped).to.equal(0)
    })
  })
})
