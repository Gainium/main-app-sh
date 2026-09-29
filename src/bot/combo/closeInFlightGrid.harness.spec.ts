process.env.NODE_ENV = 'testing'

/**
 * Spec `120` — a combo deal close must not place grid orders for the partly
 * filled grid orders its own cancel-all turns up.
 *
 * Drives the REAL `closeDealById` override and the REAL `updateMinigrid` →
 * `generateGridsOnPrice` → `findDiffCombo` chain. The base class's
 * `closeDealById` is stood in for by what it does in production, in the same
 * order: cancel every resting order, hand each part-filled one to the fill
 * path WITHOUT awaiting it (`cancelAllOrder` → `handleUnknownOrder` →
 * `processFilledOrder` → `updateMinigrid`), rest a limit close order, return.
 * `placeOrders` is the venue.
 *
 * The minigrid is the production one (Kraken spot SN64-USD long combo, a
 * deal minigrid: low 21.985, top 22.548725, 10 levels, sell displacement
 * 0.0016, price precision 3). The sequence is 2026-09-28 18:57:12–18:57:48,
 * with synthetic ids because this file is public:
 *
 *   18:57:12.745  close of the deal starts
 *   18:57:12.882  SELL 22.585 CANCELED, executed 0.9
 *   18:57:12.884  SELL 22.472 CANCELED, executed 1.99966
 *   18:57:13.070  limit close order SELL 21.652 NEW
 *   18:57:13.667  ~10 grid BUYs 21.985–22.492 NEW, above a 21.65 market,
 *                 filled at 21.646 during the close
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  CloseDCATypeEnum,
  ComboMinigridStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'

const SYMBOL = 'SN64-USD'
const BOT_ID = '000000000000000000000b20'
const DEAL_ID = '000000000000000000000d20'
const MINIGRID_ID = '000000000000000000000a20'

const LOW = 21.985
const TOP = 22.548725
const BUDGET = 515.5082373
/** The limit close order's price; the market was ~21.65. */
const CLOSE_PRICE = 21.652
/** Venue time of the cancel reports (18:57:12.855). */
const T = 1790621832855

let LEVELS: { number: number; price: { buy: number; sell: number } }[] = []

let Combo: any
let MainBot: any
let Base: any
let baseCloseDealById: any

const makeBot = () => {
  let seq = 0
  const minigrid: any = {
    schema: {
      _id: MINIGRID_ID,
      dealId: DEAL_ID,
      botId: BOT_ID,
      status: ComboMinigridStatusEnum.active,
      lockClose: true,
      symbol: { symbol: SYMBOL, baseAsset: 'SN64', quoteAsset: 'USD' },
      initialPrice: 22.549,
      lastPrice: 0,
      settings: { lowPrice: LOW, topPrice: TOP, levels: 10, budget: BUDGET },
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
      symbol: { symbol: SYMBOL, baseAsset: 'SN64', quoteAsset: 'USD' },
      settings: {},
      profit: { total: 0, totalUsd: 0, gridProfit: 0, gridProfitUsd: 0 },
      currentBalances: { base: 0, quote: 0 },
      tags: [],
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
    closeBySl: false,
    closeByTp: false,
    notCheckSl: false,
  }

  class TestBot extends Combo {
    math = new MathHelper()
    botId = BOT_ID
    userId = '000000000000000000000420'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = false
    loadingComplete = true
    minigrid = minigrid
    deal = deal
    /** Every order `placeOrders` sent: `SIDE price`. */
    placed: string[] = []
    /** `updateMinigrid` runs the close spawned and did not await. */
    spawned: Promise<unknown>[] = []
    data: any = {
      _id: BOT_ID,
      exchange: ExchangeEnum.kraken,
      paperContext: false,
      created: new Date('2026-09-17T00:00:00.000Z'),
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
    generateBasicGrids(a: any) {
      return MainBot.prototype.generateBasicGrids.call(this, a)
    }
    generateGridsOnPrice(...a: any[]) {
      return MainBot.prototype.generateGridsOnPrice.apply(this, a)
    }
    getSellBuyCount(...a: any[]) {
      return MainBot.prototype.getSellBuyCount.apply(this, a)
    }
    async baseAssetPrecision() {
      return 5
    }
    async getAggregatedSettings() {
      return { futures: false, coinm: false, profitCurrency: 'quote' }
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 3,
        baseAsset: { minAmount: 0.1, step: 0.00001, name: 'SN64' },
        quoteAsset: { minAmount: 0.5, step: 0.00001, name: 'USD' },
      }
    }
    async getUserFee() {
      return { maker: 0.0025, taker: 0.004 }
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
      for (const g of diff.new) {
        const o = this.rest(g)
        this.placed.push(`${o.side} ${o.origPrice}`)
      }
    }
    rest(g: any) {
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
        transactTime: T - 60_000,
        updateTime: T - 60_000,
      }
      this.orders.set(o.clientOrderId, o)
      return o
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

/** The ladder as it rested before the close: sells at 22.472–22.585. */
const settle = async (bot: any) => {
  const lastBuy = LEVELS[LEVELS.length - 4].price.buy
  const grids = await bot.generateGridsOnPrice(
    {
      pair: SYMBOL,
      initialGrids: bot.minigrid.initialGrids,
      lowPrice: LOW,
      topPrice: TOP,
      levels: 10,
      updatedBudget: true,
      _budget: BUDGET,
      _lastPrice: lastBuy,
      _initialPriceStart: 22.549,
      _side: OrderSideEnum.buy,
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
    bot.rest(g)
  }
  bot.minigrid.schema.lastPrice = lastBuy
  bot.minigrid.schema.lastSide = OrderSideEnum.buy
  bot.lastMinigridOrder.set(MINIGRID_ID, {
    price: lastBuy,
    time: T - 60_000,
    side: OrderSideEnum.buy,
  })
}

/** The part fills the venue reported on the 18:57:12 cancel. */
const PARTIALS: Record<string, string> = {
  '22.585': '0.9',
  '22.472': '1.99966',
}

const restingPrices = (bot: any, side: string) =>
  [...bot.orders.values()]
    .filter((o: any) => o.status === 'NEW' && o.side === side)
    .map((o: any) => +o.origPrice)

/**
 * What the base `closeDealById` does, in production order. `spawnAfterReturn`
 * puts the spawned fill processing after the method has returned (18:57:13.6,
 * the close order already resting); otherwise it is awaited inside it
 * (18:57:12.875, the close still running).
 */
const stubBaseClose = (opts: {
  spawnAfterReturn: boolean
  restsCloseOrder: boolean
}) =>
  async function (this: any, _botId: string, dealId: string) {
    const fills: any[] = []
    for (const o of [...this.orders.values()]) {
      if (o.status !== 'NEW' || o.dealId !== dealId) {
        continue
      }
      o.status = 'CANCELED'
      const part = PARTIALS[o.origPrice]
      if (part) {
        // cancelOrderOnExchange promotes a part-filled cancel to FILLED.
        o.status = 'FILLED'
        o.executedQty = part
        o.updateTime = T
        fills.push(o)
      }
    }
    const run = () => fills.map((o) => this.updateMinigrid(o))
    if (opts.spawnAfterReturn) {
      this.spawned.push(
        new Promise((r) => setTimeout(r, 5)).then(() => Promise.all(run())),
      )
    } else {
      await Promise.all(run())
    }
    if (opts.restsCloseOrder) {
      this.orders.set('D-TP-close', {
        symbol: SYMBOL,
        clientOrderId: 'D-TP-close',
        dealId,
        typeOrder: TypeOrderEnum.dealTP,
        side: 'SELL',
        status: 'NEW',
        price: `${CLOSE_PRICE}`,
        origPrice: `${CLOSE_PRICE}`,
        origQty: '109.13191',
        executedQty: '0',
      })
    }
  }

describe('combo deal close vs its own cancelled partial fills (spec 120)', () => {
  before(async function () {
    this.timeout(240000)
    Combo = createRequire(__filename)('../comboHelper').default()
    MainBot = createRequire(__filename)('../main').default
    Base = Object.getPrototypeOf(Combo.prototype)
    baseCloseDealById = Base.closeDealById
    LEVELS = await makeBot().generateBasicGrids({
      pair: SYMBOL,
      topPrice: TOP,
      lowPrice: LOW,
      sellDisplacement: 0.0016,
      gridType: 'arithmetic',
      levels: 10,
    })
  })
  after(() => {
    Base.closeDealById = baseCloseDealById
  })

  it('§0 fixture: the ladder rests the two sells the close part-filled', async () => {
    const bot = makeBot()
    await settle(bot)
    expect(restingPrices(bot, 'SELL')).to.include.members([22.585, 22.472])
  })

  /** §0 control — the same fill with no close requested re-places a ladder. */
  it('§4.5 with no close requested the fill still rebuilds the ladder', async () => {
    const bot = makeBot()
    await settle(bot)
    const o = [...bot.orders.values()].find(
      (r: any) => r.side === 'SELL' && +r.origPrice === 22.585,
    )
    o.status = 'FILLED'
    o.executedQty = o.origQty
    o.updateTime = T
    await bot.updateMinigrid(o)
    expect(bot.placed.length).to.be.greaterThan(0)
  })

  for (const spawnAfterReturn of [false, true]) {
    const when = spawnAfterReturn
      ? '§4.2 after the close returned with its order resting'
      : '§4.1 while the close is running'
    describe(when, () => {
      const replay = async () => {
        const bot = makeBot()
        await settle(bot)
        Base.closeDealById = stubBaseClose({
          spawnAfterReturn,
          restsCloseOrder: true,
        })
        await bot.closeDealById(BOT_ID, DEAL_ID, CloseDCATypeEnum.closeByLimit)
        await Promise.all(bot.spawned)
        return bot
      }

      it('places no grid order for the deal', async () => {
        const bot = await replay()
        // 18:57:13.667 in production: BUYs at 21.985–22.492, every one of
        // them above the close price and the market.
        expect(bot.placed).to.deep.equal([])
      })

      it('§4.3 still records both part fills on the minigrid', async () => {
        const bot = await replay()
        expect(bot.minigrid.schema.transactions.sell).to.equal(2)
      })
    })
  }

  it('§4.4 a close that rests no order stops blocking once it returns', async () => {
    const bot = makeBot()
    await settle(bot)
    Base.closeDealById = stubBaseClose({
      spawnAfterReturn: false,
      restsCloseOrder: false,
    })
    // Keep the ladder so a later fill has something to rebuild from.
    const ladder = bot.minigrid.currentOrders
    await bot.closeDealById(BOT_ID, DEAL_ID, CloseDCATypeEnum.closeByMarket)
    bot.minigrid.currentOrders = ladder
    bot.placed = []
    const o = bot.rest(
      ladder.find((g: any) => g.side === OrderSideEnum.buy && g.price < 22.2),
    )
    o.status = 'FILLED'
    o.executedQty = o.origQty
    o.updateTime = T + 60_000
    await bot.updateMinigrid(o)
    expect(bot.placed.length).to.be.greaterThan(0)
  })
})
