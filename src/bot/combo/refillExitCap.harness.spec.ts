process.env.NODE_ENV = 'testing'

/**
 * Main-app spec 048 — a combo minigrid's resting exits never sum to more base
 * than it holds, however often its levels refill.
 *
 * On a USDT perpetual the ladder carries the lot residual across levels (spec
 * 086), so neighbouring levels differ by a lot (0.027 / 0.028 ETH). After a
 * grid fill `updateMinigrid` regenerates the whole ladder, and the sell handed
 * back over a refilled buy is sized as ITS level, not as the buy that filled:
 * a buy of 0.027 answered by a sell of 0.028. Each refill cycle rested one more
 * lot than the minigrid held, until the last sell would have flipped the
 * position (one-way futures) or been refused (spot).
 *
 * Drives the REAL `createMinigrid` → `updateMinigrid` → `generateGridsOnPrice`
 * → `findDiffCombo` chain with the real grid builders borrowed from MainBot;
 * persistence and `placeOrders` are recorded or stubbed. `placeOrders` stands
 * in for the venue: a new order rests, a cancel lands. The deal's position is
 * the opening level ± the grid fills.
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

const SYMBOL = 'ETHUSDT'
const BOT_ID = '000000000000000000000b48'
const DEAL_ID = '000000000000000000000d48'

let Combo: any
let MainBot: any

const makeBot = (
  opts: {
    long?: boolean
    precision?: number
    gridLevel?: string
    step?: string
    /** false: the engine without the spec 048 cap, to show the drift. */
    cap?: boolean
  } = {},
) => {
  const {
    long = true,
    precision = 2,
    gridLevel = '9',
    step = '1',
    cap = true,
  } = opts
  let seq = 0
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      initialPrice: 2500,
      initialBalances: { base: 0, quote: 0 },
      symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'USDT' },
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
    userId = '000000000000000000000048'
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
      return 3
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
        baseAsset: { minAmount: 0.001, step: 0.001, name: 'ETH' },
        quoteAsset: { minAmount: 5, step: 0.01, name: 'USDT' },
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
    /** The deal's position: the level that opened the minigrid, ± grid fills. */
    position = 0
    async setToRedis() {}
    ordersDb = { readData: async () => ({ data: { result: null } }) }
    async calculateDealBalances() {
      deal.deal.currentBalances = {
        base: long ? this.position : 0,
        quote: 0,
      }
      deal.deal.initialBalances = { base: long ? 0 : this.position, quote: 0 }
    }
    async capMinigridExitsAfterFill(input: any) {
      if (cap) {
        return super.capMinigridExitsAfterFill(input)
      }
    }
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
        this.position += (o.side === 'BUY') === long ? +o.origQty : -o.origQty
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
  clientOrderId: 'CMB-RO-048',
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

const OPEN_QTY = 0.25

const open = async (bot: any, long = true) => {
  bot.position = OPEN_QTY
  await bot.calculateDealBalances()
  const grids = await bot.createMinigrid(
    bot.deal.deal,
    safetyOrder(2500, OPEN_QTY, long),
    false,
  )
  for (const g of grids) {
    bot.rest(g, 0)
  }
  return grids
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

/** Σ resting exit base: sells of a long, buy-backs of a short. */
const restingExits = (bot: any, long = true) =>
  round(
    bot
      .resting()
      .filter((o: any) => o.side === (long ? 'SELL' : 'BUY'))
      .reduce((a: number, o: any) => a + +o.origQty, 0),
  )

/**
 * The price swings across the minigrid's two lowest levels `cycles` times:
 * a long's sell above them fills, then the buy it handed back refills, then
 * the sell handed back over that. `check` runs after every trade.
 */
const whipsaw = async (
  bot: any,
  cycles: number,
  check: (bot: any) => void,
  long = true,
) => {
  const [m] = bot.mgs
  const levels = m.initialGrids
  const lo = long ? levels[1].price.sell : levels[levels.length - 2].price.buy
  const hi = long ? levels[0].price.buy : levels[levels.length - 1].price.sell
  for (let i = 0; i < cycles; i++) {
    await bot.touch(lo)
    check(bot)
    await bot.touch(hi)
    check(bot)
  }
}

describe('combo minigrid exits held to what it holds across refills (main-app spec 048)', () => {
  before(async function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('../comboHelper').default()
    MainBot = createRequire(__filename)('../main').default
  })

  it('§0 fixture: the ladder alternates a lot between levels (spec 086 carry)', async () => {
    const grids = await open(makeBot({ cap: false }))
    const qtys = grids.map((g: any) => g.qty)
    expect(new Set(qtys).size, `${qtys}`).to.equal(2)
    const sum = round(qtys.reduce((a: number, q: number) => a + q, 0))
    expect(sum)
      .to.be.at.most(OPEN_QTY)
      .and.at.least(OPEN_QTY - 0.001)
  })

  it('§1 without the cap: every refill cycle rests one more lot than the deal holds', async () => {
    const bot = makeBot({ cap: false })
    await open(bot)
    let worst = 0
    await whipsaw(bot, 5, (b) => {
      worst = Math.max(worst, round(restingExits(b) - b.position))
    })
    // 0.001 ETH (one lot) a cycle over 5 cycles.
    expect(worst, bot.trail.join('\n')).to.be.at.least(0.003)
  })

  it('§2 after every fill the resting sells sum to no more than the position', async () => {
    const bot = makeBot()
    await open(bot)
    expect(restingExits(bot)).to.be.at.most(OPEN_QTY)
    await whipsaw(bot, 10, (b) => {
      expect(
        restingExits(b),
        `${b.position} held\n${b.trail.join('\n')}`,
      ).to.be.at.most(round(b.position))
    })
    expect(bot.filled.SELL).to.be.greaterThan(0)
    expect(bot.filled.BUY).to.be.greaterThan(0)
  })

  it('§3 the sell handed back over a refilled buy is no larger than that buy', async () => {
    const bot = makeBot()
    await open(bot)
    const [m] = bot.mgs
    const levels = m.initialGrids
    await bot.touch(levels[1].price.sell)
    const before = new Set(bot.resting().map((o: any) => o.clientOrderId))
    await bot.touch(levels[0].price.buy)
    const buy = [...bot.orders.values()].find(
      (o: any) => o.side === 'BUY' && o.status === 'FILLED',
    )
    const handedBack = bot
      .resting()
      .filter((o: any) => o.side === 'SELL' && !before.has(o.clientOrderId))
    expect(handedBack, bot.trail.join('\n')).to.have.length(1)
    expect(+handedBack[0].origQty).to.be.at.most(+buy.executedQty)
  })

  it('§4 the minigrid sells out to zero, never below (without the cap: a negative base)', async () => {
    const sellOut = async (cap: boolean) => {
      const bot = makeBot({ cap })
      await open(bot)
      await whipsaw(bot, 6, () => undefined)
      // Then the price runs through every level above.
      const [m] = bot.mgs
      for (const l of m.initialGrids) {
        await bot.touch(l.price.sell)
      }
      return bot
    }
    const without = await sellOut(false)
    expect(round(without.position), without.trail.join('\n')).to.be.below(0)
    const bot = await sellOut(true)
    expect(round(bot.position), bot.trail.join('\n')).to.be.at.least(0)
  })

  it('§5 a futures short buys back no more than it sold', async () => {
    const bot = makeBot({ long: false })
    await open(bot, false)
    expect(restingExits(bot, false)).to.be.at.most(OPEN_QTY)
    await whipsaw(
      bot,
      10,
      (b) => {
        expect(
          restingExits(b, false),
          `${b.position} sold\n${b.trail.join('\n')}`,
        ).to.be.at.most(round(b.position))
      },
      false,
    )
  })
})
