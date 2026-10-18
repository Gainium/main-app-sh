process.env.NODE_ENV = 'testing'

/**
 * Spec `176` — a combo minigrid never has two levels at the same price.
 *
 * `createMinigrid` splits the minigrid's range into the bot's `gridLevel`
 * levels and `generateBasicGrids` rounds each one to the price precision. When
 * the range is narrower than `gridLevel` price ticks, several levels round onto
 * one price. After a fill at such a price, `updateMinigrid` rebuilds the ladder
 * there and frees ONE level at the fill price; its twin stays on the ladder as
 * a BUY at the very price that just traded. The next trade at that price fills
 * it, with no SELL above it to pay for it, so the minigrid buys back more than
 * it sold.
 *
 * The minigrid is the production one: a short USDT perpetual combo deal,
 * safety level 2, range 0.0265025–0.0269 (1.5 % of 0.0265), 10 levels, price
 * precision 4. Drives the REAL `createMinigrid` → `updateMinigrid` →
 * `generateGridsOnPrice` → `findDiffCombo` chain with the real grid builders
 * borrowed from MainBot. Balances, persistence and `placeOrders` are recorded
 * or stubbed — no stack, DB, Redis or exchange. `placeOrders` stands in for
 * the venue: a new order rests, a cancel lands.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  OrderTypeEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'

const SYMBOL = 'LONGXIAUSDT'
const BOT_ID = '000000000000000000000b76'
const DEAL_ID = '000000000000000000000d76'

let Combo: any
let MainBot: any

const makeBot = (
  opts: {
    long?: boolean
    precision?: number
    gridLevel?: string
    step?: string
  } = {},
) => {
  const { long = false, precision = 4, gridLevel = '10', step = '1.5' } = opts
  let seq = 0
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      initialPrice: 0.0265,
      symbol: { symbol: SYMBOL, baseAsset: 'LONGXIA', quoteAsset: 'USDT' },
      settings: {},
      profit: { total: 0, totalUsd: 0, gridProfit: 0, gridProfitUsd: 0 },
      currentBalances: { base: 0, quote: 0 },
      tags: [],
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  const minigrids: any[] = []

  class TestBot extends Combo {
    math = new MathHelper()
    botId = BOT_ID
    userId = '000000000000000000000176'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = undefined
    // A field on the base class, so it cannot be a getter here.
    isLong = long
    deal = deal
    /** The minigrids this bot created (the engine's own map is private). */
    mgs = minigrids
    logs: string[] = []
    /** Filled grid quantity per side. */
    filled = { BUY: 0, SELL: 0 }
    trail: string[] = []
    clock = 0
    data: any = {
      _id: BOT_ID,
      exchange: ExchangeEnum.bybitUsdm,
      paperContext: false,
      created: new Date('2026-10-01T00:00:00Z'),
      flags: [],
      settings: {
        name: 'combo',
        pair: [SYMBOL],
        futures: true,
        coinm: false,
        newBalance: false,
        strategy: long ? StrategyEnum.long : StrategyEnum.short,
        futuresStrategy: long ? 'LONG' : 'SHORT',
        profitCurrency: 'quote',
      },
    }
    orders = new Map<string, any>()
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    // --- the real grid routines, borrowed from the engine ---
    generateBasicGrids(a: any) {
      return MainBot.prototype.generateBasicGrids.call(this, a)
    }
    generateGridsOnPrice(...a: any[]) {
      return MainBot.prototype.generateGridsOnPrice.apply(this, a)
    }
    getSellBuyCount(...a: any[]) {
      return MainBot.prototype.getSellBuyCount.apply(this, a)
    }
    // --- I/O, stubbed ---
    async baseAssetPrecision() {
      return 0
    }
    async getAggregatedSettings() {
      return {
        futures: true,
        coinm: false,
        profitCurrency: 'quote',
        step,
        baseStep: step,
        stepScale: '1',
        gridLevel,
        baseGridLevels: gridLevel,
      }
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: precision,
        maxOrders: 500,
        baseAsset: { minAmount: 1, step: 1, name: 'LONGXIA' },
        quoteAsset: { minAmount: 1, step: 0.0001, name: 'USDT' },
      }
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.00055 }
    }
    minigridDb = {
      createData: async (d: any) => ({
        status: 'OK',
        data: { ...d, _id: `00000000000000000000a${minigrids.length}00` },
      }),
    }
    setMinigrid(m: any) {
      minigrids.push(m)
    }
    getMinigrid(id: string) {
      return minigrids.find((m) => m.schema._id === id)
    }
    getMinigridByDealId() {
      return minigrids
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId({ status }: { status?: string | string[] }) {
      const statuses = status ? [status].flat() : undefined
      return [...this.orders.values()].filter(
        (o) => !statuses || statuses.includes(o.status),
      )
    }
    getOrderId(prefix: string) {
      seq++
      return `${prefix}-${seq}`
    }
    async createTransaction() {
      return undefined
    }
    async profitBase() {
      return false
    }
    async avgPrice() {
      return { real: NaN, display: NaN }
    }
    async getCommDeal() {
      return 0
    }
    saveDeal() {
      return Promise.resolve()
    }
    saveMinigrid() {
      return Promise.resolve()
    }
    async calculateDealBalances() {}
    async checkDealSlMethods() {}
    checkDealsPriceExtremum() {}
    updateBotDealStats() {}
    calculateBotBalances() {}
    async updateAssets() {}
    autoRebalancing() {}
    async placeOrders(_b: string, _s: string, _d: string, diff: any) {
      for (const c of diff.cancel) {
        const side = c.side === OrderSideEnum.buy ? 'BUY' : 'SELL'
        for (const o of this.orders.values()) {
          if (
            o.status === 'NEW' &&
            +o.origPrice === c.price &&
            o.side === side
          ) {
            o.status = 'CANCELED'
          }
        }
      }
      for (const g of diff.new) {
        this.rest(g, this.clock)
      }
    }
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange(o: any) {
      o.status = 'CANCELED'
    }
    rest(g: any, at: number) {
      const o = {
        symbol: SYMBOL,
        clientOrderId: g.newClientOrderId,
        botId: BOT_ID,
        dealId: DEAL_ID,
        minigridId: g.minigridId,
        typeOrder: TypeOrderEnum.dealGrid,
        side: g.side === OrderSideEnum.buy ? 'BUY' : 'SELL',
        price: `${g.price}`,
        origPrice: `${g.price}`,
        origQty: `${g.qty}`,
        executedQty: '0',
        status: 'NEW',
        transactTime: at,
        updateTime: at,
      }
      this.orders.set(o.clientOrderId, o)
      return o
    }
    resting() {
      return [...this.orders.values()].filter((o) => o.status === 'NEW')
    }
    /**
     * The market trades at `price` once: every order resting at that moment
     * whose limit the trade reaches fills, and each fill is processed in turn.
     */
    async touch(price: number) {
      const crossed = this.resting().filter((o) =>
        o.side === 'BUY' ? +o.origPrice >= price : +o.origPrice <= price,
      )
      for (const o of crossed) {
        if (o.status !== 'NEW') {
          continue
        }
        this.clock += 1000
        o.status = 'FILLED'
        o.executedQty = o.origQty
        o.updateTime = this.clock
        this.filled[o.side as 'BUY' | 'SELL'] += +o.origQty
        this.trail.push(`@${price} ${o.side} ${o.origPrice}`)
        this.clock += 10
        await this.updateMinigrid(o)
      }
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
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

/** The safety order whose fill opens the minigrid. */
const safetyOrder = (price: number, qty: number, long: boolean) => ({
  clientOrderId: 'CMB-RO-176',
  symbol: SYMBOL,
  dealId: DEAL_ID,
  botId: BOT_ID,
  typeOrder: TypeOrderEnum.regular,
  type: OrderTypeEnum.limit,
  side: long ? 'BUY' : 'SELL',
  price: `${price}`,
  origPrice: `${price}`,
  origQty: `${qty}`,
  executedQty: `${qty}`,
  status: 'FILLED',
  dcaLevel: 2,
  updateTime: 1,
  transactTime: 1,
})

const open = async (bot: any, price = 0.0269, qty = 1720, long = false) => {
  const grids = await bot.createMinigrid(
    bot.deal.deal,
    safetyOrder(price, qty, long),
    false,
  )
  for (const g of grids) {
    bot.rest(g, 0)
  }
  return grids
}

const distinct = (xs: number[]) => new Set(xs).size === xs.length

describe('combo minigrid levels finer than the price tick (spec 176)', () => {
  before(async function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('../comboHelper').default()
    MainBot = createRequire(__filename)('../main').default
  })

  describe('§2 evidence: the requested ladder collapses', () => {
    it('§2.1 10 levels over 0.0265025–0.0269 round onto 5 prices', async () => {
      const levels = await makeBot().generateBasicGrids({
        pair: SYMBOL,
        topPrice: 0.0269,
        lowPrice: 0.0265025,
        sellDisplacement: 0.0004,
        gridType: 'arithmetic',
        levels: 10,
      })
      expect(levels.map((l: any) => l.price.buy)).to.deep.equal([
        0.0265, 0.0265, 0.0266, 0.0266, 0.0267, 0.0267, 0.0267, 0.0268, 0.0268,
        0.0269, 0.0269,
      ])
    })
  })

  describe('§3 the price trading on at one tick', () => {
    /**
     * The production path of 12:12–12:17: the price falls through the
     * ladder, comes back up until a level SELLs, then trades at that price
     * again and again (0.0266 in production).
     */
    const walk = async (bot: any) => {
      for (const p of [0.0268, 0.0267, 0.0266]) {
        await bot.touch(p)
      }
      let soldAt = 0
      for (const p of [0.0267, 0.0268, 0.0269]) {
        await bot.touch(p)
        if (bot.trail.at(-1)?.includes('SELL')) {
          soldAt = p
          break
        }
      }
      expect(soldAt, bot.trail.join('\n')).to.be.greaterThan(0)
      const afterSell = { ...bot.filled }
      for (let i = 0; i < 5; i++) {
        await bot.touch(soldAt)
      }
      return afterSell
    }

    it('§3.1 trading on at the price it just sold at buys nothing back', async () => {
      const bot = makeBot()
      await open(bot)
      const afterSell = await walk(bot)
      expect(bot.filled, bot.trail.join('\n')).to.deep.equal(afterSell)
    })

    it('§3.2 a short minigrid back at its top has bought back what it sold, within a lot per level', async () => {
      const bot = makeBot()
      await open(bot)
      await walk(bot)
      for (const p of [0.0267, 0.0268, 0.0269]) {
        await bot.touch(p)
      }
      // Each level is sized on its own (spec 086 carries the lot residual
      // across levels), so a BUY and the SELL a level above it may differ by
      // one lot. A level traded twice at one price is a whole level: ~172.
      const trail = `${JSON.stringify(bot.filled)}\n${bot.trail.join('\n')}`
      const LOT = 1
      expect(Math.abs(bot.filled.BUY - bot.filled.SELL), trail).to.be.at.most(
        LOT * bot.mgs[0].schema.settings.levels,
      )
    })
  })

  describe('§4 the minigrid createMinigrid builds', () => {
    it('§4.1 has no two levels at one price', async () => {
      const bot = makeBot()
      await open(bot)
      const [m] = bot.mgs
      expect(m.schema.settings.lowPrice).to.be.closeTo(0.0265025, 1e-12)
      expect(m.schema.settings.topPrice).to.equal(0.0269)
      const prices = m.initialGrids.map((l: any) => l.price.buy)
      expect(distinct(prices), `${prices}`).to.equal(true)
      expect(m.schema.settings.levels).to.equal(m.initialGrids.length - 1)
      expect(m.schema.settings.levels).to.be.lessThan(10)
    })

    it('§4.2 keeps every level it can: one more would collapse two', async () => {
      const bot = makeBot()
      await open(bot)
      const [m] = bot.mgs
      const more = await bot.generateBasicGrids({
        pair: SYMBOL,
        topPrice: 0.0269,
        lowPrice: m.schema.settings.lowPrice,
        sellDisplacement: m.schema.settings.sellDisplacement,
        gridType: 'arithmetic',
        levels: m.schema.settings.levels + 1,
      })
      expect(distinct(more.map((l: any) => l.price.buy))).to.equal(false)
    })

    it('§4.3 says so in the bot log', async () => {
      const bot = makeBot()
      await open(bot)
      const levels = bot.mgs[0].schema.settings.levels
      expect(
        bot.logs.some((l: string) =>
          l.includes(`grid levels reduced from 10 to ${levels}`),
        ),
        bot.logs.join('\n'),
      ).to.equal(true)
    })
  })

  describe('§5 what must not move', () => {
    it('§5.1 a ladder whose levels round apart keeps its level count and prices', async () => {
      // [start price, step %, gridLevel, price precision]
      const cases: [number, string, string, number][] = [
        // 4 levels over the production range: a sub-tick step, yet 5 prices.
        [0.0269, '1.5', '4', 4],
        [0.0269, '1.5', '3', 4],
        [0.0269, '5', '10', 4],
        [201.3, '5', '10', 2],
        [0.082564, '2.5', '10', 5],
      ]
      for (const [price, step, gridLevel, precision] of cases) {
        for (const long of [false, true]) {
          const bot = makeBot({ long, step, gridLevel, precision })
          bot.deal.deal.initialPrice = price
          const width = price * (+step / 100)
          const expected = await bot.generateBasicGrids({
            pair: SYMBOL,
            topPrice: long ? price + width : price,
            lowPrice: long ? price : price - width,
            sellDisplacement: 0.0004,
            gridType: 'arithmetic',
            levels: +gridLevel,
          })
          const label = `${long ? 'long' : 'short'} ${price}/${step}%/${gridLevel}`
          expect(
            distinct(expected.map((l: any) => l.price.buy)),
            label,
          ).to.equal(true)
          await open(bot, price, 1720, long)
          const [m] = bot.mgs
          expect(m.schema.settings.levels, label).to.equal(+gridLevel)
          expect(m.initialGrids, label).to.deep.equal(expected)
          expect(
            bot.logs.some((l: string) => l.includes('grid levels reduced')),
            label,
          ).to.equal(false)
        }
      }
    })

    it('§5.2 across prices, steps, levels and precisions: apart stays as is, collapsed comes out apart', async () => {
      let kept = 0
      let reduced = 0
      for (const precision of [2, 4, 5, 6]) {
        for (const price of [0.0265, 0.0269, 0.31, 1.07, 3.3, 201.3]) {
          for (const step of ['0.3', '1', '1.5', '5']) {
            for (const gridLevel of ['1', '2', '5', '10', '25']) {
              const bot = makeBot({ step, gridLevel, precision })
              bot.deal.deal.initialPrice = price
              const width = price * (+step / 100)
              const requested = await bot.generateBasicGrids({
                pair: SYMBOL,
                topPrice: price,
                lowPrice: price - width,
                sellDisplacement: 0.0004,
                gridType: 'arithmetic',
                levels: +gridLevel,
              })
              await open(bot, price, 1720)
              const [m] = bot.mgs
              const label = `${price}/${step}%/${gridLevel}@${precision}`
              const prices = m.initialGrids.map((l: any) => l.price.buy)
              if (distinct(requested.map((l: any) => l.price.buy))) {
                kept++
                expect(m.schema.settings.levels, label).to.equal(+gridLevel)
                expect(m.initialGrids, label).to.deep.equal(requested)
              } else {
                reduced++
                // A single level has nothing to give up.
                if (+gridLevel > 1) {
                  expect(m.schema.settings.levels, label).to.be.lessThan(
                    +gridLevel,
                  )
                }
                // Down to one level only when even two prices are one.
                expect(
                  distinct(prices) || m.schema.settings.levels === 1,
                  `${label}: ${prices}`,
                ).to.equal(true)
              }
            }
          }
        }
      }
      expect(kept, 'cases already apart').to.be.greaterThan(100)
      expect(reduced, 'cases that collapsed').to.be.greaterThan(50)
    })
  })
})
