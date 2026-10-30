process.env.NODE_ENV = 'testing'

/**
 * A spot grid with profit in quote sizes its levels so the start-up spend —
 * the coin bought for the sell levels plus the quote locked in the buy levels —
 * fits the budget. A sell level carries the coin the level below it bought, so
 * it must be reserved at that level's buy price; reserving it at its own sell
 * price committed one grid step too much on every sell (1007 of a 1000 budget
 * at 20 levels, 1023 at 5) and on an exactly funded account the farthest buy
 * was refused for balance. Bots created before the fix keep their sizing.
 *
 * Real sizing routines borrowed from `MainBot`; ETH-like synthetic pair.
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

const LOW = 3000
const TOP = 4000
let LEVELS = 20
const PRICE = 3500
const MIN_NOTIONAL = 5
let STEP = 0.0001

const makeBot = (opts: {
  budget: number
  futures?: boolean
  orderFixedIn?: 'base' | 'quote'
  profitCurrency?: 'base' | 'quote'
  botType?: BotType
  created?: string
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
      exchange: ExchangeEnum.paperBinance,
      paperContext: true,
      created: new Date(opts.created ?? '2026-12-01'),
      symbol: { symbol: 'ABC-USDT', baseAsset: 'ABC', quoteAsset: 'USDT' },
      settings: {
        name: 'ABC grid',
        pair: 'ABC-USDT',
        futures: opts.futures ?? false,
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
        priceAssetPrecision: 2,
        maxOrders: 500,
        baseAsset: { minAmount: STEP, step: STEP, name: 'ABC' },
        quoteAsset: { minAmount: MIN_NOTIONAL, step: 0.000001, name: 'USDT' },
      }
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
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

/** Coin for the sells (bought at the start price, with fee) + quote in buys. */
const startSpend = async (bot: any) => {
  await bot.generateGrids()
  const grids = (await bot.generateCurrentGrids(
    PRICE,
    OrderSideEnum.buy,
    true,
    false,
    true,
  )) as { qty: number; price: number; side: OrderSideEnum }[]
  const buys = grids.filter((g) => g.side === OrderSideEnum.buy)
  const sells = grids.filter((g) => g.side === OrderSideEnum.sell)
  return {
    buys,
    sells,
    total:
      buys.reduce((a, g) => a + g.qty * g.price, 0) +
      sells.reduce((a, g) => a + g.qty, 0) * PRICE * 1.001,
  }
}

describe('grid start-up spend fits the budget (profit in quote)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  for (const levels of [20, 5]) {
    it(`commits no more than the budget at ${levels} levels`, async () => {
      LEVELS = levels
      STEP = 0.00000001
      const bot = makeBot({
        budget: 1000,
        futures: false,
        orderFixedIn: 'quote',
      })
      const { buys, sells, total } = await startSpend(bot)
      expect(buys.length).to.be.greaterThan(0)
      expect(sells.length).to.be.greaterThan(0)
      expect(total).to.be.at.most(1000.01)
      expect(total).to.be.at.least(999)
    })
  }

  it('sizes each sell as the coin the level below it bought', async () => {
    LEVELS = 20
    STEP = 0.00000001
    const bot = makeBot({ budget: 1000, futures: false, orderFixedIn: 'quote' })
    const { buys, sells } = await startSpend(bot)
    // Same quote per level: what a buy spends (fee aside) is what the sell
    // one level up carries, valued at that buy's price.
    const perLevel = (buys[0].qty * buys[0].price) / 1.001
    const levels = bot.initialGrid.map((g: any) => g.price.buy)
    for (const s of sells) {
      const below = levels[levels.indexOf(s.price) - 1]
      expect(s.qty * below).to.be.closeTo(perLevel, 0.01)
    }
  })

  it('leaves a bot created before the fix sized as it was', async () => {
    LEVELS = 20
    STEP = 0.00000001
    const bot = makeBot({
      budget: 1000,
      futures: false,
      orderFixedIn: 'quote',
      created: '2026-01-01',
    })
    const { total } = await startSpend(bot)
    expect(total).to.be.closeTo(1006.68, 0.05)
  })

  it('does not change profit in base, which reserves sells correctly', async () => {
    LEVELS = 20
    STEP = 0.00000001
    const before = await startSpend(
      makeBot({
        budget: 1000,
        futures: false,
        orderFixedIn: 'quote',
        profitCurrency: 'base',
        created: '2026-01-01',
      }),
    )
    const after = await startSpend(
      makeBot({
        budget: 1000,
        futures: false,
        orderFixedIn: 'quote',
        profitCurrency: 'base',
      }),
    )
    expect(after.total).to.equal(before.total)
  })
})
