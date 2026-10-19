process.env.NODE_ENV = 'testing'

/**
 * Combo add / reduce funds through the REAL engine methods: `addDealFunds` /
 * `reduceDealFunds` (sizing, refusals, the order sent), `processFilledOrder`
 * (routing), the fill booking that scales the minigrids through the real
 * `prepareMinigrids` → `generateGridsOnPrice`, and `createInitialDealOrders`
 * for the unfilled levels resized through `deal.sizes.fundsDca`.
 *
 * Persistence, the venue and the book rebuild are recorded or stubbed — no
 * stack, DB, Redis or exchange.
 *
 * Fixture: long spot Combo, start 100, base order 100 USDT, three DCA levels
 * of 100 / 200 / 400 USDT at 98 / 96 / 94 (step 2 %, step scale 1, volume
 * scale 2), 4 grid levels per minigrid, no fee.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  AddFundsTypeEnum,
  BotType,
  ComboMinigridStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  OrderSizeTypeEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'

const SYMBOL = 'BTCUSDT'
const BOT_ID = '000000000000000000000b47'
const DEAL_ID = '000000000000000000000d47'

const round4 = (n: number) => Math.round(n * 1e4) / 1e4
const SO = [
  { level: 1, price: 98, qty: round4(100 / 98) },
  { level: 2, price: 96, qty: round4(200 / 96) },
  { level: 3, price: 94, qty: round4(400 / 94) },
]

let Combo: any
let MainBot: any

type Ed = {
  minBase: number
  minQuote: number
}

const makeBot = (opts: { filled: number; price: number; ed?: Ed }) => {
  let seq = 0
  const settings: any = {
    name: 'combo',
    pair: [SYMBOL],
    futures: false,
    coinm: false,
    newBalance: false,
    feeOrder: false,
    strategy: StrategyEnum.long,
    profitCurrency: 'quote',
    useDca: true,
    ordersCount: 3,
    orderSize: '100',
    orderSizeType: OrderSizeTypeEnum.quote,
    step: '2',
    stepScale: '1',
    volumeScale: '2',
    gridLevel: '4',
    baseGridLevels: '4',
  }
  const levelsFilled = SO.slice(0, opts.filled)
  const positionBase = 1 + levelsFilled.reduce((a, l) => a + l.qty, 0)
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
      settings: { ...settings },
      profit: { total: 0, totalUsd: 0, gridProfit: 0, gridProfitUsd: 0 },
      initialPrice: 100,
      lastPrice: 100,
      avgPrice: 0,
      initialBalances: { base: 0, quote: 800 },
      currentBalances: {
        base: positionBase,
        quote:
          800 - 100 - levelsFilled.reduce((a, l) => a + l.qty * l.price, 0),
      },
      levels: { all: 4, complete: 1 + opts.filled },
      lastFilledLevel: 1 + opts.filled,
      tags: [],
      flags: [],
    },
    initialOrders: [] as any[],
    currentOrders: [] as any[],
    previousOrders: [] as any[],
  }

  class TestBot extends Combo {
    math = new MathHelper()
    botId = BOT_ID
    userId = '000000000000000000000447'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    loadingComplete = true
    price = opts.price
    sent: any[] = []
    refusals: string[] = []
    closes: any[] = []
    cancelSweeps = 0
    rebuilds: any[] = []
    routed: string[] = []
    data: any = {
      _id: BOT_ID,
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'uuid',
      paperContext: false,
      created: new Date('2026-10-01T00:00:00.000Z'),
      flags: [],
      settings,
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
    shouldProceed() {
      return true
    }
    // --- the real grid routines ---
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
      return 4
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 2,
        baseAsset: {
          minAmount: opts.ed?.minBase ?? 0.0001,
          step: 0.0001,
          name: 'BTC',
        },
        quoteAsset: {
          minAmount: opts.ed?.minQuote ?? 1,
          step: 0.01,
          name: 'USDT',
        },
      }
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getLatestPrice() {
      return this.price
    }
    async getUsdRate() {
      return 1
    }
    async profitBase() {
      return false
    }
    async getCommDeal() {
      return 0
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    get theDeal() {
      return deal
    }
    saveDeal(full: any, partial?: any) {
      if (partial) {
        for (const [k, v] of Object.entries(partial)) {
          if (!k.includes('.')) {
            full.deal[k] = v
          }
        }
      }
      return Promise.resolve()
    }
    saveMinigrid() {
      return Promise.resolve()
    }
    saveMinigridToRedis() {}
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string | string[]
    }) {
      const statuses = status ? [status].flat() : undefined
      const deals = dealId ? [dealId].flat() : undefined
      return [...this.orders.values()].filter(
        (o) =>
          (!statuses || statuses.includes(o.status)) &&
          (!deals || deals.includes(o.dealId)),
      )
    }
    getOrderId(prefix: string) {
      seq++
      return `${prefix}-${seq}`
    }
    async sendOrderToExchange(order: any) {
      this.sent.push(order)
      const filled = {
        ...order,
        status: 'FILLED',
        executedQty: order.origQty,
        price: `${this.price}`,
        updateTime: 1_800_000_000_000 + seq,
      }
      this.orders.set(filled.clientOrderId, filled)
      return filled
    }
    // The routing is pinned on its own below; here the fill is booked by the
    // test so it can be awaited.
    processFilledOrder(order: any) {
      this.routed.push(order.clientOrderId)
    }
    async reportUserRefusal(reason: string) {
      this.refusals.push(reason)
    }
    async closeDealById(...args: any[]) {
      this.closes.push(args)
    }
    async cancelAllOrder() {
      this.cancelSweeps++
    }
    async rebuildDealOrders(d: any, dealId: string, o: any) {
      this.rebuilds.push({ dealId, opts: o, sizes: d.deal.sizes })
    }
    updateBotDealStats() {}
    sendDealClosedAlert() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot = new (TestBot as any)()
  return bot
}

/** A filled entry row the deal's average is read from. */
const filledRow = (
  id: string,
  typeOrder: TypeOrderEnum,
  qty: number,
  price: number,
  dcaLevel: number,
) => ({
  clientOrderId: id,
  symbol: SYMBOL,
  botId: BOT_ID,
  dealId: DEAL_ID,
  typeOrder,
  side: 'BUY',
  status: 'FILLED',
  price: `${price}`,
  origPrice: `${price}`,
  origQty: `${qty}`,
  executedQty: `${qty}`,
  dcaLevel,
  updateTime: 1_700_000_000_000 + dcaLevel,
})

/** The deal with its base order and `filled` DCA levels done at `price`. */
const setup = async (opts: { filled: number; price: number; ed?: Ed }) => {
  const bot = makeBot(opts)
  const deal = bot.theDeal
  deal.initialOrders = await bot.createInitialDealOrders(
    SYMBOL,
    100,
    DEAL_ID,
    deal.deal,
  )
  bot.orders.set('bo', filledRow('bo', TypeOrderEnum.dealStart, 1, 100, 1))
  const rungs = [
    { id: 'bo', qty: 1, price: 100, budget: 100, level: 1 },
    ...SO.slice(0, opts.filled).map((l) => ({
      id: `so${l.level}`,
      qty: l.qty,
      price: l.price,
      budget: l.qty * l.price,
      level: l.level + 1,
    })),
  ]
  for (const r of rungs.slice(1)) {
    bot.orders.set(
      r.id,
      filledRow(r.id, TypeOrderEnum.dealRegular, r.qty, r.price, r.level),
    )
  }
  for (const r of rungs) {
    const schema: any = {
      _id: `mg-${r.id}`,
      botId: BOT_ID,
      dealId: DEAL_ID,
      dcaOrderId: r.id,
      status: ComboMinigridStatusEnum.active,
      symbol: deal.deal.symbol,
      initialPrice: r.price,
      lastPrice: r.price,
      lastSide: OrderSideEnum.buy,
      initialBalances: { base: r.qty, quote: 0 },
      currentBalances: { base: r.qty, quote: 0 },
      settings: {
        lowPrice: r.price,
        topPrice: r.price * 1.02,
        levels: 4,
        budget: r.budget,
        sellDisplacement: 0,
        profitCurrency: 'quote',
        orderFixedIn: 'base',
      },
      grids: { buy: 0, sell: 4 },
      assets: {},
      transactions: { buy: 0, sell: 0 },
      profit: { total: 0, totalUsd: 0 },
    }
    const [prepared] = await bot.prepareMinigrids([schema])
    bot.setMinigrid(prepared, false)
  }
  const avg = await bot.avgPrice(DEAL_ID, DEAL_ID)
  deal.deal.avgPrice = avg.real
  return bot
}

const sells = (bot: any) =>
  bot
    .getMinigridByDealId({ dealId: DEAL_ID })
    .map((m: any) =>
      m.currentOrders
        .filter((g: any) => g.side === OrderSideEnum.sell)
        .map((g: any) => g.qty),
    )

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)

describe('combo add / reduce funds through the engine (spec 047)', () => {
  before(async function () {
    this.timeout(240000)
    Combo = createRequire(__filename)('../comboHelper').default()
    MainBot = createRequire(__filename)('../main').default
  })

  it('fixture: the ladder and the minigrids as the engine builds them', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    const ladder = bot.theDeal.initialOrders.map((o: any) => [o.price, o.qty])
    expect(ladder).to.deep.equal([
      [98, 1.0204],
      [96, 2.0833],
      [94, 4.2553],
    ])
    const lines = sells(bot)
    // Every minigrid holds its rung's base in four sell lines.
    expect(lines.map((l: number[]) => l.length)).to.deep.equal([4, 4, 4, 4])
    expect(lines[0][0]).to.be.closeTo(0.25, 0.0002)
    expect(lines[1][0]).to.be.closeTo(0.2551, 0.0002)
    expect(lines[2][0]).to.be.closeTo(0.5208, 0.0002)
    expect(lines[3][0]).to.be.closeTo(1.0638, 0.0002)
    expect(bot.theDeal.deal.avgPrice).to.be.closeTo(95.7, 0.005)
  })

  it('all filled, +50 % at 90: one market buy of 4.1795, every sell line ×1.5, avg 93.80, no minigrid, no level', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    const before = sells(bot)
    const levelsBefore = { ...bot.theDeal.deal.levels }
    const minigridsBefore = bot.getMinigridByDealId({ dealId: DEAL_ID }).length
    await bot.addDealFunds(BOT_ID, DEAL_ID, {
      qty: '50',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    expect(bot.refusals).to.deep.equal([])
    expect(bot.sent).to.have.length(1)
    const order = bot.sent[0]
    expect(order.side).to.equal('BUY')
    expect(order.type).to.equal('MARKET')
    expect(order.typeOrder).to.equal(TypeOrderEnum.dealRegular)
    expect(order.addFundsId).to.be.a('string')
    expect(+order.origQty).to.equal(4.1795)
    expect(+order.origQty * 90).to.be.closeTo(376.16, 0.01)
    expect(bot.routed).to.deep.equal([order.clientOrderId])

    await bot.applyComboFundsFill(bot.orders.get(order.clientOrderId))
    const after = sells(bot)
    after.forEach((lines: number[], i: number) => {
      lines.forEach((q: number, j: number) =>
        expect(q / before[i][j], `minigrid ${i} line ${j}`).to.be.closeTo(
          1.5,
          0.002,
        ),
      )
    })
    expect(after[0][0]).to.be.closeTo(0.375, 0.0002)
    expect(after[1][0]).to.be.closeTo(0.3827, 0.0002)
    expect(after[2][0]).to.be.closeTo(0.7813, 0.0002)
    expect(after[3][0]).to.be.closeTo(1.5957, 0.0002)
    // Invariant: the grids hold the position — no orphan base.
    const position = 1 + SO.reduce((a, l) => a + l.qty, 0) + 4.1795
    expect(sum(after.flat())).to.be.closeTo(position, 0.002)
    const deal = bot.theDeal.deal
    expect(deal.avgPrice).to.be.closeTo(93.8, 0.005)
    expect(deal.funds).to.have.length(1)
    expect(deal.funds[0].qty).to.equal(4.1795)
    expect(deal.fundsScale[0].k).to.be.closeTo(1.5, 1e-4)
    // Invariant: the funds fill is not a safety order.
    expect(deal.levels).to.deep.equal(levelsBefore)
    expect(bot.getMinigridByDealId({ dealId: DEAL_ID })).to.have.length(
      minigridsBefore,
    )
    // Budgets persist scaled.
    const budgets = bot
      .getMinigridByDealId({ dealId: DEAL_ID })
      .map((m: any) => m.schema.settings.budget)
    expect(budgets[0]).to.be.closeTo(150, 1e-9)
    expect(bot.rebuilds).to.have.length(1)
    expect(bot.rebuilds[0].opts).to.deep.equal({ keepLevels: true })
  })

  it('partial (BO + SO1 filled) at 97, +50 %: buys 1.0102 now, SO2 2.0833→3.1250, SO3 4.2553→6.3830, their minigrid budgets ×1.5', async () => {
    const bot = await setup({ filled: 1, price: 97 })
    const budgetsBefore = bot.theDeal.initialOrders.map(
      (o: any) => o.minigridBudget,
    )
    await bot.addDealFunds(BOT_ID, DEAL_ID, {
      qty: '50',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    expect(bot.refusals).to.deep.equal([])
    expect(+bot.sent[0].origQty).to.equal(1.0102)
    await bot.applyComboFundsFill(bot.orders.get(bot.sent[0].clientOrderId))
    const deal = bot.theDeal
    // The ladder the rebuild regenerates from the new offsets.
    const ladder = await bot.createInitialDealOrders(
      SYMBOL,
      100,
      DEAL_ID,
      deal.deal,
    )
    expect(ladder.map((o: any) => [o.price, o.qty])).to.deep.equal([
      [98, 1.0204],
      [96, 3.125],
      [94, 6.383],
    ])
    expect(ladder[1].minigridBudget / budgetsBefore[1]).to.be.closeTo(1.5, 1e-3)
    expect(ladder[2].minigridBudget / budgetsBefore[2]).to.be.closeTo(1.5, 1e-3)
    // The filled level keeps its size: its growth is in its minigrid.
    expect(ladder[0].minigridBudget).to.be.closeTo(budgetsBefore[0], 1e-9)
    const after = sells(bot)
    expect(sum(after.flat())).to.be.closeTo(1 + SO[0].qty + 1.0102, 0.002)
  })

  it('reduce 25 % at 90 sells 2.0898 at market, books it, shrinks every line ×0.75 and does not close the deal', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    const before = sells(bot)
    const avg = bot.theDeal.deal.avgPrice
    await bot.reduceDealFunds(BOT_ID, DEAL_ID, {
      qty: '25',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    expect(bot.refusals).to.deep.equal([])
    // The grid sells hold the base: the book comes down before the sale.
    expect(bot.cancelSweeps).to.equal(1)
    const order = bot.sent[0]
    expect(order.side).to.equal('SELL')
    expect(order.typeOrder).to.equal(TypeOrderEnum.dealTP)
    expect(order.reduceFundsId).to.be.a('string')
    expect(+order.origQty).to.equal(2.0898)
    await bot.applyComboFundsFill(bot.orders.get(order.clientOrderId))
    const deal = bot.theDeal.deal
    expect(deal.status).to.equal('open')
    expect(bot.closes).to.deep.equal([])
    expect(deal.reduceFunds).to.have.length(1)
    // Realized at the deal's average.
    expect(deal.profit.total).to.be.closeTo(2.0898 * (90 - avg), 1e-9)
    sells(bot).forEach((lines: number[], i: number) =>
      lines.forEach((q: number, j: number) =>
        expect(q / before[i][j]).to.be.closeTo(0.75, 0.002),
      ),
    )
  })

  it('a reduce fill is routed to the funds booking, never to the deal close', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    const calls: string[] = []
    bot.processedFilled = new Map()
    bot.lastFilledOrderMap = new Map()
    bot.closeDeal = () => calls.push('closeDeal')
    bot.updateDeal = () => calls.push('updateDeal')
    bot.updateMinigrid = () => calls.push('updateMinigrid')
    bot.applyComboFundsFill = (o: any) =>
      calls.push(`funds ${o.reduceFundsId || o.addFundsId}`)
    const route = Combo.prototype.processFilledOrder
    await route.call(bot, {
      ...filledRow('r1', TypeOrderEnum.dealTP, 2, 90, 0),
      side: 'SELL',
      reduceFundsId: 'rf',
    })
    await route.call(bot, {
      ...filledRow('a1', TypeOrderEnum.dealRegular, 2, 90, 0),
      addFundsId: 'af',
    })
    expect(calls).to.deep.equal(['funds rf', 'funds af'])
  })

  it('a reduce that leaves a grid line below the exchange minimum is refused, nothing sent', async () => {
    // Smallest line 0.25 BTC at ~100; a 20 USDT minimum notional allows k ≥ 0.8.
    const bot = await setup({
      filled: 3,
      price: 90,
      ed: { minBase: 0.0001, minQuote: 20 },
    })
    await bot.reduceDealFunds(BOT_ID, DEAL_ID, {
      qty: '50',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    expect(bot.sent).to.deep.equal([])
    expect(bot.cancelSweeps).to.equal(0)
    expect(bot.refusals).to.have.length(1)
    expect(bot.refusals[0]).to.match(
      /largest reduction possible now is 2\d(\.\d+)?%/,
    )
  })

  it('a reduce of the whole position closes the deal instead', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    await bot.reduceDealFunds(BOT_ID, DEAL_ID, {
      qty: '100',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    expect(bot.sent).to.deep.equal([])
    expect(bot.closes).to.have.length(1)
    expect(bot.closes[0][1]).to.equal(DEAL_ID)
  })

  it('a limit price is refused for Combo', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    await bot.addDealFunds(BOT_ID, DEAL_ID, {
      qty: '50',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: true,
      limitPrice: '89',
    })
    expect(bot.sent).to.deep.equal([])
    expect(bot.refusals[0]).to.contain('limit price is not supported')
  })

  it('a second request waits for the first fill', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    const settings = {
      qty: '10',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    }
    await bot.addDealFunds(BOT_ID, DEAL_ID, settings)
    await bot.addDealFunds(BOT_ID, DEAL_ID, settings)
    expect(bot.sent).to.have.length(1)
    expect(bot.refusals[0]).to.contain('still being processed')
    await bot.applyComboFundsFill(bot.orders.get(bot.sent[0].clientOrderId))
    await bot.addDealFunds(BOT_ID, DEAL_ID, settings)
    expect(bot.sent).to.have.length(2)
  })

  it('a cancelled reduce with nothing filled scales nothing and puts the book back', async () => {
    const bot = await setup({ filled: 3, price: 90 })
    const before = sells(bot)
    bot.sendOrderToExchange = async (order: any) => {
      bot.sent.push(order)
      const resting = { ...order, status: 'NEW' }
      bot.orders.set(order.clientOrderId, resting)
      return resting
    }
    await bot.reduceDealFunds(BOT_ID, DEAL_ID, {
      qty: '25',
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    const order = bot.orders.get(bot.sent[0].clientOrderId)
    expect(bot.theDeal.deal.pendingReduceFunds).to.have.length(1)
    expect(bot.theDeal.deal.pendingReduceFunds[0].positionBase).to.be.closeTo(
      8.359,
      1e-9,
    )
    order.status = 'CANCELED'
    await bot.processCanceledOrder(order, 1, false)
    expect(bot.theDeal.deal.pendingReduceFunds).to.deep.equal([])
    expect(bot.theDeal.deal.reduceFunds ?? []).to.deep.equal([])
    expect(sells(bot)).to.deep.equal(before)
    expect(bot.rebuilds).to.have.length(1)
  })
})
