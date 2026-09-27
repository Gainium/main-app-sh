process.env.NODE_ENV = 'testing'

/**
 * Spec `116` — a combo minigrid rebuilt after a fill must not count an order
 * placed after that fill as filled.
 *
 * Drives the REAL `updateMinigrid` → `isLastMinigridOrder` →
 * `generateGridsOnPrice` → `findDiffCombo` → `findDiff` chain. Balances, the
 * transaction ledger, persistence and `placeOrders` are recorded or stubbed —
 * no stack, DB, Redis or exchange. `placeOrders` stands in for the venue: a
 * new order rests (stamped with the harness clock as its placement time), a
 * cancel lands.
 *
 * The grid is the production one (Kraken spot, a long combo's deal minigrid:
 * low 0.0805, top 0.082564, 10 levels, sell displacement 0.002, price
 * precision 5), built by the engine's own `generateBasicGrids`. The burst is
 * the production one of 2026-09-27 04:41:31–33, with its venue times. Client
 * order ids are synthetic because this file is public:
 *
 *   04:41:31.596  SELL 0.08252 FILLED                 t 1790484091582
 *   04:41:31.597  SELL 0.08273 FILLED                 t 1790484091582
 *   04:41:31.673  BUY  0.08215 NEW  (counter)         t 1790484091660
 *   04:41:31.782  BUY  0.08215 FILLED                 t 1790484091769
 *   04:41:32.291  BUY  0.08236 NEW  (counter)         t 1790484092280
 *   04:41:32.968  BUY  0.08236 CANCELED  ← ladder rebuilt from the 0.08215 fill
 *   04:41:33.006  SELL 0.08252 NEW
 *   04:41:33.563  SELL 0.08273 refused: free 0 GNOT
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  ComboMinigridStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'

const SYMBOL = 'GNOT-USD'
const BOT_ID = '000000000000000000000b16'
const DEAL_ID = '000000000000000000000d16'
const MINIGRID_ID = '000000000000000000000a16'

/** The minigrid's levels, as the engine builds them (filled in `before`). */
let LEVELS: { number: number; price: { buy: number; sell: number } }[] = []
const buyAt = (n: number) => LEVELS[n].price.buy
const sellAt = (n: number) => LEVELS[n].price.sell
const BUY = (n: number) => `BUY ${buyAt(n)}`
const SELL = (n: number) => `SELL ${sellAt(n)}`

/** Venue time of the burst's first fill (04:41:31.582). */
const T = 1790484091582

let Combo: any
let MainBot: any

const makeBot = () => {
  let seq = 0
  const minigrid: any = {
    schema: {
      _id: MINIGRID_ID,
      dealId: DEAL_ID,
      botId: BOT_ID,
      status: ComboMinigridStatusEnum.active,
      // The deal's base minigrid, as in production: it never closes itself.
      lockClose: true,
      symbol: { symbol: SYMBOL, baseAsset: 'GNOT', quoteAsset: 'USD' },
      initialPrice: 0.08256,
      lastPrice: 0,
      settings: {
        lowPrice: 0.0805,
        topPrice: 0.082564,
        levels: 10,
        budget: 412.466775035,
      },
      transactions: { buy: 0, sell: 0 },
      profit: { total: 0, totalUsd: 0 },
      currentBalances: { base: 0, quote: 0 },
      assets: {},
    },
    initialGrids: LEVELS.map((l) => ({ ...l, price: { ...l.price } })),
    currentOrders: [] as any[],
  }
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      symbol: { symbol: SYMBOL, baseAsset: 'GNOT', quoteAsset: 'USD' },
      settings: {},
      profit: { total: 0, totalUsd: 0, gridProfit: 0, gridProfitUsd: 0 },
      currentBalances: { base: 0, quote: 0 },
      tags: [],
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }

  class TestBot extends Combo {
    math = new MathHelper()
    botId = BOT_ID
    userId = '000000000000000000000416'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = false
    minigrid = minigrid
    /** What each `updateMinigrid` sent: `SIDE price`. */
    placed: string[] = []
    cancelled: string[] = []
    /** The harness clock — the placement time the venue stamps on an order. */
    clock = 0
    /** Grid orders' worth of base the deal holds (one per level's quantity). */
    held = 0
    data: any = {
      _id: BOT_ID,
      exchange: ExchangeEnum.kraken,
      paperContext: false,
      created: new Date('2026-09-23T22:15:51.275Z'),
      flags: [],
      settings: {
        name: 'combo',
        pair: [SYMBOL],
        futures: false,
        coinm: false,
        newBalance: false,
        feeOrder: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
      },
    }
    /** Every exchange order of the deal, by client order id. */
    orders = new Map<string, any>()
    get isLong() {
      return true
    }
    get futures() {
      return false
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
      return 5
    }
    async getAggregatedSettings() {
      return { futures: false, coinm: false, profitCurrency: 'quote' }
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 80, step: 0.00001, name: 'GNOT' },
        quoteAsset: { minAmount: 0.5, step: 0.00001, name: 'USD' },
      }
    }
    async getUserFee() {
      return { maker: 0.002275, taker: 0.002275 }
    }
    getMinigrid(id: string) {
      return id === MINIGRID_ID ? minigrid : undefined
    }
    getMinigridByDealId() {
      return [minigrid]
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
            this.cancelled.push(`${side} ${c.price}`)
          }
        }
      }
      for (const g of diff.new) {
        const o = this.rest(g, this.clock)
        this.placed.push(`${o.side} ${o.origPrice}`)
      }
    }
    /** An order resting on the book for this grid level, placed at `at`. */
    rest(g: any, at: number) {
      const o = {
        symbol: SYMBOL,
        clientOrderId: g.newClientOrderId,
        botId: BOT_ID,
        dealId: DEAL_ID,
        minigridId: MINIGRID_ID,
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
    /** The venue fills the resting order at this price and side, at `at`. */
    fill(side: 'BUY' | 'SELL', price: number, at: number) {
      const o = [...this.orders.values()].find(
        (r) => r.status === 'NEW' && r.side === side && +r.origPrice === price,
      )
      if (!o) {
        throw new Error(`no resting ${side} at ${price}`)
      }
      o.status = 'FILLED'
      o.executedQty = o.origQty
      o.updateTime = at
      this.held += side === 'BUY' ? 1 : -1
      return o
    }
    /** Process a fill at harness time `at`, recording only what it sends. */
    async process(o: any, at: number) {
      this.clock = at
      this.placed = []
      this.cancelled = []
      await this.updateMinigrid(o)
    }
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

/** Resting orders per side, as sorted price lists. */
const book = (bot: any) => {
  const resting = [...bot.orders.values()].filter(
    (o: any) => o.status === 'NEW',
  )
  const prices = (side: string) =>
    resting
      .filter((o: any) => o.side === side)
      .map((o: any) => +o.origPrice)
      .sort((a: number, b: number) => a - b)
  return { buys: prices('BUY'), sells: prices('SELL') }
}

/**
 * A minigrid at rest after its last fill (`side` at `price`): the ladder the
 * engine rebuilt then, every level of it resting since `T - 60s`.
 */
const settle = async (bot: any, side: OrderSideEnum, price: number) => {
  const grids = await bot.generateGridsOnPrice(
    {
      pair: SYMBOL,
      initialGrids: bot.minigrid.initialGrids,
      lowPrice: 0.0805,
      topPrice: 0.082564,
      levels: 10,
      updatedBudget: true,
      _budget: 412.466775035,
      _lastPrice: price,
      _initialPriceStart: 0.08256,
      _side: side,
      all: true,
      profitCurrency: 'quote',
      orderFixedIn: 'base',
    },
    false,
    false,
    false,
    false,
  )
  bot.minigrid.currentOrders = grids.map((g: any) => ({
    ...g,
    newClientOrderId: bot.getOrderId('CMB-GR'),
    dealId: DEAL_ID,
    type: TypeOrderEnum.dealGrid,
    minigridId: MINIGRID_ID,
  }))
  for (const g of bot.minigrid.currentOrders) {
    bot.rest(g, T - 60_000)
  }
  bot.held = book(bot).sells.length
  bot.minigrid.schema.lastPrice = price
  bot.minigrid.schema.lastSide = side
  bot.lastMinigridOrder.set(MINIGRID_ID, { price, time: T - 60_000, side })
}

/** Every resting SELL is backed by base, every resting BUY by quote. */
const expectBacked = (bot: any, lots: number) => {
  expect(book(bot).sells.length, 'sells vs base held').to.equal(bot.held)
  expect(book(bot).buys.length, 'buys vs quote held').to.equal(lots - bot.held)
}

describe('combo minigrid rebuild vs orders placed after the fill (spec 116)', () => {
  before(async function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('../comboHelper').default()
    MainBot = createRequire(__filename)('../main').default
    LEVELS = await makeBot().generateBasicGrids({
      pair: SYMBOL,
      topPrice: 0.082564,
      lowPrice: 0.0805,
      sellDisplacement: 0.002,
      gridType: 'arithmetic',
      levels: 10,
    })
  })

  it('§0 fixture: the production levels', () => {
    expect(LEVELS.map((l) => l.price.buy)).to.deep.equal([
      0.0805, 0.08071, 0.08091, 0.08112, 0.08133, 0.08153, 0.08174, 0.08194,
      0.08215, 0.08236, 0.08256,
    ])
    expect(LEVELS.map((l) => l.price.sell)).to.deep.equal([
      0.08066, 0.08087, 0.08107, 0.08128, 0.08149, 0.08169, 0.0819, 0.0821,
      0.08231, 0.08252, 0.08273,
    ])
  })

  /** Ten levels' worth of capital: each is either one unit of base or quote. */
  const LOTS = 10

  describe('§1.1.1 the 04:41:31–33 burst', () => {
    const replay = async () => {
      const bot = makeBot()
      // After the 0.08215 buy: buys rest at 0-7, sells at 9 and 10.
      await settle(bot, OrderSideEnum.buy, buyAt(8))
      expect(book(bot).sells).to.deep.equal([sellAt(9), sellAt(10)])
      const s9 = bot.fill('SELL', sellAt(9), T)
      const s10 = bot.fill('SELL', sellAt(10), T)
      await bot.process(s9, T + 78)
      expect(bot.placed).to.deep.equal([BUY(8)])
      const b8 = bot.fill('BUY', buyAt(8), T + 187)
      await bot.process(s10, T + 698)
      expect(bot.placed).to.deep.equal([BUY(9)])
      await bot.process(b8, T + 1369)
      return bot
    }

    it('sends no sell for base already sold', async () => {
      const bot = await replay()
      expect(bot.placed).to.not.include(SELL(9))
      expect(
        bot.placed.filter((p: string) => p.startsWith('SELL')),
      ).to.have.length(1)
      expectBacked(bot, LOTS)
    })

    it('the next fills keep every order backed', async () => {
      const bot = await replay()
      // Price keeps falling through the highest resting buy…
      const top = Math.max(...book(bot).buys)
      await bot.process(bot.fill('BUY', top, T + 20_000), T + 20_078)
      expect(
        bot.placed.filter((p: string) => p.startsWith('SELL')),
      ).to.have.length(1)
      expectBacked(bot, LOTS)
      // …then turns back up through the lowest resting sell.
      const low = Math.min(...book(bot).sells)
      await bot.process(bot.fill('SELL', low, T + 40_000), T + 40_078)
      expect(
        bot.placed.filter((p: string) => p.startsWith('BUY')),
      ).to.have.length(1)
      expectBacked(bot, LOTS)
    })

    it('records the rebuilt ladder, so a restart rebuilds the same one', async () => {
      const bot = await replay()
      const again = await bot.generateGridsOnPrice(
        {
          pair: SYMBOL,
          initialGrids: bot.minigrid.initialGrids,
          lowPrice: 0.0805,
          topPrice: 0.082564,
          levels: 10,
          updatedBudget: true,
          _budget: 412.466775035,
          _lastPrice: bot.minigrid.schema.lastPrice,
          _initialPriceStart: 0.08256,
          _side: bot.minigrid.schema.lastSide,
          all: true,
          profitCurrency: 'quote',
          orderFixedIn: 'base',
        },
        false,
        false,
        false,
        false,
      )
      const sides = (gs: any[]) => gs.map((g) => `${g.side} ${g.price}`).sort()
      expect(sides(again)).to.deep.equal(sides(bot.minigrid.currentOrders))
      expect(sides(again)).to.deep.equal(
        [
          ...book(bot).buys.map((p) => `BUY ${p}`),
          ...book(bot).sells.map((p) => `SELL ${p}`),
        ].sort(),
      )
    })
  })

  describe('§1.1.2 the mirror: a dip, then straight back up', () => {
    const replay = async () => {
      const bot = makeBot()
      // After the 0.08169 sell: buys rest at 0-4, sells at 6-10.
      await settle(bot, OrderSideEnum.sell, sellAt(5))
      const b4 = bot.fill('BUY', buyAt(4), T)
      const b3 = bot.fill('BUY', buyAt(3), T)
      await bot.process(b4, T + 78)
      expect(bot.placed).to.deep.equal([SELL(5)])
      const s5 = bot.fill('SELL', sellAt(5), T + 187)
      await bot.process(b3, T + 698)
      expect(bot.placed).to.deep.equal([SELL(4)])
      await bot.process(s5, T + 1369)
      return bot
    }

    it('leaves no base without a sell, and buys no more than the quote held', async () => {
      const bot = await replay()
      expectBacked(bot, LOTS)
    })
  })

  describe('§1.3.1 fills whose rebuild meets no later order are unchanged', () => {
    it('a sell fill places its counter buy, and nothing else', async () => {
      const bot = makeBot()
      await settle(bot, OrderSideEnum.buy, buyAt(8))
      await bot.process(bot.fill('SELL', sellAt(9), T), T + 78)
      expect(bot.placed).to.deep.equal([BUY(8)])
      expect(bot.cancelled).to.deep.equal([])
    })

    it('a buy fill places its counter sell, and nothing else', async () => {
      const bot = makeBot()
      await settle(bot, OrderSideEnum.buy, buyAt(8))
      await bot.process(bot.fill('BUY', buyAt(7), T), T + 78)
      expect(bot.placed).to.deep.equal([SELL(8)])
      expect(bot.cancelled).to.deep.equal([])
    })

    it('a round trip: sell, its counter buy fills after it was placed, the sell comes back', async () => {
      const bot = makeBot()
      await settle(bot, OrderSideEnum.buy, buyAt(8))
      await bot.process(bot.fill('SELL', sellAt(9), T), T + 78)
      await bot.process(bot.fill('BUY', buyAt(8), T + 500), T + 578)
      expect(bot.placed).to.deep.equal([SELL(9)])
      expect(bot.cancelled).to.deep.equal([])
      expectBacked(bot, LOTS)
    })

    it('catch-up: a sell resting since before the fill still turns into a buy', async () => {
      const bot = makeBot()
      await settle(bot, OrderSideEnum.buy, buyAt(8))
      // The venue reports the 0.08273 fill first; the 0.08252 sell below it,
      // resting all along, is still unreported when the rebuild runs.
      await bot.process(bot.fill('SELL', sellAt(10), T), T + 78)
      expect(bot.cancelled).to.deep.equal([SELL(9)])
      expect(bot.placed).to.have.members([BUY(8), BUY(9)])
    })
  })
})
