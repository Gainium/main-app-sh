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

const makeBot = (opts: {
  filled: number
  price: number
  ed?: Ed
  futures?: boolean
}) => {
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
      return !!opts.futures
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
    events: any[] = []
    botEventDb = { createData: (e: any) => this.events.push(e) }
    redisWrites: string[] = []
    redisSnapshot: Record<string, any> = {}
    async setToRedis(key: string, data: any) {
      this.redisWrites.push(key)
      this.redisSnapshot[key] = JSON.parse(JSON.stringify(data))
    }
    async getFromRedis(key: string) {
      return this.redisSnapshot[key]
    }
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

  it('partial (BO + SO1 filled) at 97, +50 %: buys 1.0102 now, SO2 2.0833→3.1250, SO3 4.2553→6.3830, their minigrid budgets ×1.5; filled SO1 is re-placed ×1.5 too', async () => {
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
    // SO1 had filled: its share was bought by the funds order and its
    // minigrid scaled. Should that minigrid close and the level open again,
    // it is re-placed at the scaled size, not the original one.
    expect(ladder.map((o: any) => [o.price, o.qty])).to.deep.equal([
      [98, 1.5306],
      [96, 3.125],
      [94, 6.383],
    ])
    expect(ladder[0].minigridBudget / budgetsBefore[0]).to.be.closeTo(1.5, 1e-3)
    expect(ladder[1].minigridBudget / budgetsBefore[1]).to.be.closeTo(1.5, 1e-3)
    expect(ladder[2].minigridBudget / budgetsBefore[2]).to.be.closeTo(1.5, 1e-3)
    // The filled level's offset is kept apart: it is a re-placement size,
    // not new commitment, so the balances and usage leave it out.
    expect(deal.deal.sizes.fundsDcaHeld[0]).to.be.closeTo(0.5102, 1e-9)
    expect(deal.deal.sizes.fundsDca[0] ?? 0).to.equal(0)
    expect(deal.deal.sizes.fundsDca[1]).to.be.closeTo(1.04165, 1e-9)
    deal.initialOrders = ladder
    expect(bot.fundsHeldOffset(deal).base).to.be.closeTo(0.5102, 1e-9)
    expect(bot.fundsHeldOffset(deal).quote).to.be.closeTo(0.5102 * 98, 1e-9)
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
    // Carried out, not refused: an info event on the deal.
    expect(bot.refusals).to.deep.equal([])
    expect(bot.events).to.have.length(1)
    expect(bot.events[0].type).to.equal('info')
    expect(bot.events[0].description).to.contain('the deal is closed')
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

  describe('review fixes', () => {
    const pct = (qty: string) => ({
      qty,
      asset: OrderSizeTypeEnum.quote,
      type: AddFundsTypeEnum.perc,
      useLimitPrice: false,
    })
    /** A gate the stubbed book rebuild waits on, and the moment it started. */
    const gate = () => {
      let open!: () => void
      let started!: () => void
      const opened = new Promise<void>((r) => (open = r))
      const reached = new Promise<void>((r) => (started = r))
      return { open, started, opened, reached }
    }
    /** The real fill routing, with its per-deal bookkeeping in place. */
    const realRouting = (bot: any) => {
      bot.processedFilled = new Map()
      bot.lastFilledOrderMap = new Map()
      bot.processFilledOrder = (o: any) =>
        Combo.prototype.processFilledOrder.call(bot, o)
    }

    it('a request while a synchronously filled add is still being booked waits, and is sized on the booked position', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      realRouting(bot)
      const g = gate()
      const deal = bot.theDeal.deal
      // The rebuild is what re-reads the balances from the fills.
      bot.rebuildDealOrders = async (d: any, dealId: string, o: any) => {
        bot.rebuilds.push({ dealId, opts: o })
        g.started()
        await g.opened
        const fill = bot.sent[bot.rebuilds.length - 1]
        d.deal.currentBalances = {
          ...d.deal.currentBalances,
          base: d.deal.currentBalances.base + +fill.origQty,
        }
      }
      const first = bot.addDealFunds(BOT_ID, DEAL_ID, pct('50'))
      await g.reached
      const second = bot.addDealFunds(BOT_ID, DEAL_ID, pct('10'))
      await new Promise((r) => setTimeout(r, 20))
      // Nothing is sent while the first fill is half booked.
      expect(bot.sent).to.have.length(1)
      g.open()
      await first
      await second
      expect(bot.refusals).to.deep.equal([])
      expect(bot.sent).to.have.length(2)
      const position = 8.359 + 4.1795
      expect(deal.currentBalances.base).to.be.closeTo(
        position + +bot.sent[1].origQty,
        1e-9,
      )
      // 10 % of the position the first fill left, not of the one before it.
      expect(+bot.sent[1].origQty).to.be.closeTo(0.1 * position, 1e-4)
    })

    it('a request while a reported fill is still being booked is refused', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      realRouting(bot)
      bot.sendOrderToExchange = async (order: any) => {
        bot.sent.push(order)
        const resting = { ...order, status: 'NEW' }
        bot.orders.set(order.clientOrderId, resting)
        return resting
      }
      const g = gate()
      bot.rebuildDealOrders = async () => {
        g.started()
        await g.opened
      }
      await bot.addDealFunds(BOT_ID, DEAL_ID, pct('50'))
      const sent = bot.sent[0]
      const filled = {
        ...sent,
        status: 'FILLED',
        executedQty: sent.origQty,
        price: '90',
        updateTime: 1_800_000_000_999,
      }
      bot.orders.set(sent.clientOrderId, filled)
      const booking = bot.processFilledOrder(filled)
      await g.reached
      await bot.addDealFunds(BOT_ID, DEAL_ID, pct('10'))
      expect(bot.sent).to.have.length(1)
      expect(bot.refusals[0]).to.contain('still being processed')
      g.open()
      await booking
      await bot.addDealFunds(BOT_ID, DEAL_ID, pct('10'))
      expect(bot.sent).to.have.length(2)
    })

    it('a reduce reported PARTIALLY_FILLED 2 then FILLED 5 leaves no partial take profit for the close to count again', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      bot.dealUpdateOrders = bot.dealUpdateOrders ?? new Map()
      bot.sendOrderToExchange = async (order: any) => {
        bot.sent.push(order)
        const resting = { ...order, status: 'NEW' }
        bot.orders.set(order.clientOrderId, resting)
        return resting
      }
      await bot.reduceDealFunds(BOT_ID, DEAL_ID, pct('59.8'))
      const sent = bot.sent[0]
      expect(+sent.origQty).to.equal(4.9987)
      const part = {
        ...sent,
        status: 'PARTIALLY_FILLED',
        executedQty: '2',
        price: '90',
        updateTime: 1_800_000_000_100,
      }
      await bot.processPartiallyFilledOrder(part)
      await new Promise((r) => setTimeout(r, 20))
      const deal = bot.theDeal.deal
      expect(deal.tpHistory ?? []).to.deep.equal([])
      // An entry already there (written before this release, or racing) is
      // taken out when the order is booked.
      deal.tpHistory = [{ id: sent.clientOrderId, qty: 2, price: 90 }]
      const filled = {
        ...sent,
        status: 'FILLED',
        executedQty: '4.9987',
        price: '90',
        updateTime: 1_800_000_000_200,
      }
      bot.orders.set(sent.clientOrderId, filled)
      await bot.applyComboFundsFill(filled)
      expect(deal.tpHistory).to.deep.equal([])
      expect(deal.reduceFunds).to.have.length(1)
      expect(deal.reduceFunds[0].qty).to.equal(4.9987)
      // The close sums its take profit with every other `tpHistory` entry.
      const tpQty = 8.359 - 4.9987
      const closeQty =
        tpQty +
        (deal.tpHistory ?? [])
          .filter((h: any) => h.id !== 'tp')
          .reduce((a: number, h: any) => a + h.qty, 0)
      expect(closeQty).to.be.closeTo(tpQty, 1e-12)
    })

    it('spot average: a reduce fill keeps the average and takes its weight out of the later add', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      const avg0 = bot.theDeal.deal.avgPrice
      bot.orders.set('rf', {
        ...filledRow('rf', TypeOrderEnum.dealTP, 2, 90, 0),
        side: 'SELL',
        reduceFundsId: 'r1',
        updateTime: 1_800_000_000_001,
      })
      const afterReduce = await bot.avgPrice(DEAL_ID, DEAL_ID)
      expect(afterReduce.real).to.be.closeTo(avg0, 1e-9)
      bot.orders.set('af', {
        ...filledRow('af', TypeOrderEnum.dealRegular, 2, 80, 0),
        addFundsId: 'a1',
        updateTime: 1_800_000_000_002,
      })
      const after = await bot.avgPrice(DEAL_ID, DEAL_ID)
      expect(after.real).to.be.closeTo(
        ((8.359 - 2) * avg0 + 2 * 80) / 8.359,
        1e-9,
      )
    })

    it('futures average: the reduce fill takes the position down before the add', async () => {
      const bot = makeBot({ filled: 3, price: 90, futures: true })
      const rows = [
        filledRow('bo', TypeOrderEnum.dealStart, 1, 100, 1),
        ...SO.map((l) =>
          filledRow(
            `so${l.level}`,
            TypeOrderEnum.dealRegular,
            l.qty,
            l.price,
            l.level + 1,
          ),
        ),
        {
          ...filledRow('rf', TypeOrderEnum.dealTP, 2, 90, 0),
          side: 'SELL',
          reduceFundsId: 'r1',
          updateTime: 1_800_000_000_001,
        },
        {
          ...filledRow('af', TypeOrderEnum.dealRegular, 2, 80, 0),
          addFundsId: 'a1',
          updateTime: 1_800_000_000_002,
        },
      ]
      rows.forEach((r: any) => bot.orders.set(r.clientOrderId, r))
      const avg = await bot.avgPrice(DEAL_ID, DEAL_ID)
      // 8.359 at 95.70, 2 sold (average kept), 2 bought at 80.
      expect(avg.real).to.be.closeTo((6.359 * 95.7 + 160) / 8.359, 0.01)
    })

    it('a restart that loads the minigrids from a snapshot written before the booking scales them on load', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      const before = sells(bot)
      await bot.setToRedis('minigrids', bot.allMinigrids)
      bot.redisWrites = []
      await bot.addDealFunds(BOT_ID, DEAL_ID, pct('50'))
      await bot.applyComboFundsFill(bot.orders.get(bot.sent[0].clientOrderId))
      // The booking writes both snapshots at once, not on the delayed timer.
      expect(bot.redisWrites).to.include.members(['minigrids', 'deals'])
      // …but a restart can still find the older one: put it back.
      await bot.setToRedis('minigrids', [])
      bot.redisSnapshot.minigrids = JSON.parse(
        JSON.stringify(
          before.map((_: any, i: number) => {
            const m = bot.allMinigrids[i]
            return {
              ...m,
              schema: {
                ...m.schema,
                appliedFundsScale: [],
                settings: {
                  ...m.schema.settings,
                  budget: m.schema.settings.budget / 1.5,
                },
                initialBalances: {
                  base: m.schema.initialBalances.base / 1.5,
                  quote: m.schema.initialBalances.quote / 1.5,
                },
              },
            }
          }),
        ),
      )
      bot.minigrids = new Map()
      bot.minigridDealMap = new Map()
      bot.serviceRestart = true
      bot.secondRestart = false
      await bot.loadMinigrids()
      const after = sells(bot)
      after.forEach((lines: number[], i: number) =>
        lines.forEach((q: number, j: number) =>
          expect(q / before[i][j], `minigrid ${i} line ${j}`).to.be.closeTo(
            1.5,
            0.002,
          ),
        ),
      )
      // Loaded again, nothing more is applied.
      const budgets = bot.allMinigrids.map((m: any) => m.schema.settings.budget)
      await bot.reconcileMinigridFundsScale()
      expect(
        bot.allMinigrids.map((m: any) => m.schema.settings.budget),
      ).to.deep.equal(budgets)
    })

    it('a cancel reported before the send returns leaves no pending entry behind', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      bot.sendOrderToExchange = async (order: any) => {
        bot.sent.push(order)
        await bot.processCanceledOrder(
          { ...order, status: 'CANCELED', executedQty: '0', updateTime: 0 },
          0,
          false,
        )
        return { ...order, status: 'NEW' }
      }
      await bot.addDealFunds(BOT_ID, DEAL_ID, pct('50'))
      expect(bot.sent).to.have.length(1)
      expect(bot.theDeal.deal.pendingAddFunds ?? []).to.deep.equal([])
    })

    it('an add fill after the deal closed is sold as a late fill and reported', async () => {
      const bot = await setup({ filled: 3, price: 90 })
      const sold: any[] = []
      bot.sellRemainder = async (...a: any[]) => {
        sold.push(a)
      }
      bot.theDeal.deal.status = 'closed'
      await bot.applyComboFundsFill({
        ...filledRow('af', TypeOrderEnum.dealRegular, 2, 90, 0),
        addFundsId: 'a1',
        baseAsset: 'BTC',
      })
      expect(sold).to.have.length(1)
      expect(sold[0][1]).to.equal(2)
      // `lateEntryFill`: sold even when the deal's own remainder was.
      expect(sold[0][7]).to.equal(true)
      expect(bot.refusals[0]).to.match(/after deal .* was closed/)
    })

    it('unstubbed rebuild: an add then a reduce re-place the unfilled levels at the new sizes, under fresh order ids', async () => {
      const bot = await setup({ filled: 1, price: 97 })
      // The deal lives in the engine's own store, as it does in a worker:
      // every save replaces the stored copy.
      const store = bot.theDeal
      bot.deals.set(DEAL_ID, store)
      bot.getDeal = (id?: string) => Combo.prototype.getDeal.call(bot, id)
      bot.saveDeal = (...a: any[]) => Combo.prototype.saveDeal.apply(bot, a)
      bot.dealsDb = { updateData: async () => ({ status: 'OK' }) }
      bot.rebuildDealOrders = (...a: any[]) =>
        Combo.prototype.rebuildDealOrders.apply(bot, a)
      const placed: any[][] = []
      bot.placeOrders = async (_b: string, _s: string, _d: string, g: any) => {
        placed.push(g?.new ?? [])
      }
      for (const m of [
        'removeDealFromStopLossMethods',
        'checkAllowedMethods',
        'setClassProperties',
        'updateUsage',
        'updateAssets',
        'setCloseByTimer',
        'checkTPLevel',
        'checkDealsAllowedMethods',
      ]) {
        bot[m] = async () => undefined
      }
      bot.getLastStreamData = () => undefined
      // The ladder as placed before the request: SO2 and SO3 rest.
      const live0 = bot.getDeal(DEAL_ID)
      live0.currentOrders = await bot.createCurrentDealOrders(
        SYMBOL,
        97,
        live0.initialOrders,
        live0.deal.avgPrice,
        100,
        DEAL_ID,
        false,
        live0.deal,
      )
      const restingIds = live0.currentOrders.map((o: any) => o.newClientOrderId)
      const levels = (grids: any[]) =>
        grids
          .filter((g: any) => g.type === TypeOrderEnum.dealRegular)
          .map((g: any) => [g.price, g.qty])
      expect(levels(live0.currentOrders)).to.deep.equal([
        [96, 2.0833],
        [94, 4.2553],
      ])

      await bot.addDealFunds(BOT_ID, DEAL_ID, pct('50'))
      await bot.applyComboFundsFill(bot.orders.get(bot.sent[0].clientOrderId))
      expect(placed).to.have.length(1)
      expect(levels(placed[0])).to.deep.equal([
        [96, 3.125],
        [94, 6.383],
      ])
      const addIds = placed[0]
        .filter((g: any) => g.type === TypeOrderEnum.dealRegular)
        .map((g: any) => g.newClientOrderId)
      addIds.forEach((id: string) => expect(restingIds).to.not.include(id))
      expect(levels(bot.getDeal(DEAL_ID).currentOrders)).to.deep.equal([
        [96, 3.125],
        [94, 6.383],
      ])

      // The booking's rebuild read the balances back from the fills.
      bot.price = 97
      await bot.reduceDealFunds(BOT_ID, DEAL_ID, pct('20'))
      expect(bot.refusals).to.deep.equal([])
      await bot.applyComboFundsFill(bot.orders.get(bot.sent[1].clientOrderId))
      const last = placed[placed.length - 1]
      const [[p2, q2], [p3, q3]] = levels(last)
      expect([p2, p3]).to.deep.equal([96, 94])
      expect(q2).to.be.closeTo(3.125 * 0.8, 0.0002)
      expect(q3).to.be.closeTo(6.383 * 0.8, 0.0002)
      last
        .filter((g: any) => g.type === TypeOrderEnum.dealRegular)
        .forEach((g: any) => expect(addIds).to.not.include(g.newClientOrderId))
    })
  })
})

describe('combo funds scale: resting exits never exceed the position (spec 047)', () => {
  before(function () {
    this.timeout(240000)
    Combo ??= createRequire(__filename)('../comboHelper').default()
    MainBot ??= createRequire(__filename)('../main').default
  })
  const pct = (qty: string) => ({
    qty,
    asset: OrderSizeTypeEnum.quote,
    type: AddFundsTypeEnum.perc,
    useLimitPrice: false,
  })
  /** The fixture on a coarse 0.1 lot, as XRP trades. */
  const coarse = async (filled: number, price: number) => {
    const bot = await setup({ filled, price })
    const ed = await bot.getExchangeInfo()
    bot.getExchangeInfo = async () => ({
      ...ed,
      baseAsset: { ...ed.baseAsset, step: 0.1, minAmount: 0.1 },
    })
    bot.baseAssetPrecision = async () => 1
    // Re-lay the minigrids on the coarse lot.
    for (const m of bot.allMinigrids) {
      const [p] = await bot.prepareMinigrids([m.schema])
      bot.setMinigrid(p, false)
    }
    return bot
  }
  const position = (bot: any) => {
    const d = bot.theDeal.deal
    return (
      1 +
      SO.slice(0, 3).reduce((a, l) => a + l.qty, 0) +
      (d.funds ?? []).reduce((a: number, f: any) => a + f.qty, 0) -
      (d.reduceFunds ?? []).reduce((a: number, f: any) => a + f.qty, 0)
    )
  }
  const onLot = (q: number) => Math.abs(q * 10 - Math.round(q * 10)) < 1e-9

  for (const [label, dir, qty] of [
    ['reduce 30 %', 'reduce', '30'],
    ['reduce 50 %', 'reduce', '50'],
    ['add 50 %', 'add', '50'],
    ['add 30 %', 'add', '30'],
  ] as const) {
    it(`${label} on a 0.1 lot: Σ resting sells ≤ the position, every line on the lot`, async () => {
      const bot = await coarse(3, 90)
      const before = sum(sells(bot).flat())
      if (dir === 'reduce') {
        await bot.reduceDealFunds(BOT_ID, DEAL_ID, pct(qty))
      } else {
        await bot.addDealFunds(BOT_ID, DEAL_ID, pct(qty))
      }
      expect(bot.refusals).to.deep.equal([])
      await bot.applyComboFundsFill(bot.orders.get(bot.sent[0].clientOrderId))
      const lines = sells(bot).flat()
      lines.forEach((q: number) => expect(onLot(q), `${q}`).to.equal(true))
      expect(sum(lines)).to.be.at.most(position(bot) + 1e-9)
      // ...and the book keeps the scaled holding, less at most a lot a line.
      const k = bot.theDeal.deal.fundsScale[0].k
      expect(sum(lines)).to.be.at.least(before * k - 0.1 * lines.length)
    })
  }
})

/**
 * Spec 047 §2.3.7: a worker stopped while an add's book was being rebuilt.
 * The deal, its minigrids and its orders are in the database as the booking
 * left them; the Redis snapshot a cold restart prefers is from before the
 * add. Drives the REAL cold-restart load (`loadOrders` → `_loadOrders`,
 * `loadMinigrids`) and the REAL resume and book rebuild; the venue and the
 * stores are in-memory stubs.
 */
describe('combo add funds: restart in the middle of the book rebuild (spec 047 §2.3.7)', () => {
  before(function () {
    this.timeout(240000)
    Combo ??= createRequire(__filename)('../comboHelper').default()
    MainBot ??= createRequire(__filename)('../main').default
  })

  const pct = (qty: string) => ({
    qty,
    asset: OrderSizeTypeEnum.quote,
    type: AddFundsTypeEnum.perc,
    useLimitPrice: false,
  })
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
  const path = (row: any, p: string) =>
    p.split('.').reduce((a: any, k) => (a == null ? undefined : a[k]), row)
  /** Enough of a Mongo `find` for the queries a cold restart sends. */
  const matches = (row: any, q: any): boolean =>
    Object.entries(q).every(([k, c]: [string, any]) => {
      if (k === '$and') return c.every((s: any) => matches(row, s))
      if (k === '$or') return c.some((s: any) => matches(row, s))
      // The only `$expr` sent: executedQty > 0.
      if (k === '$expr') return +row.executedQty > 0
      const v = path(row, k)
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        if ('$in' in c && !c.$in.map(String).includes(`${v}`)) return false
        if ('$nin' in c && c.$nin.map(String).includes(`${v}`)) return false
        if ('$type' in c && typeof v !== c.$type) return false
        if ('$exists' in c && (v !== undefined) !== c.$exists) return false
        return true
      }
      return `${v}` === `${c}`
    })
  const setPath = (doc: any, p: string, v: any) => {
    const keys = p.split('.')
    const last = keys.pop() as string
    const target = keys.reduce((a: any, k) => (a[k] ??= {}), doc)
    target[last] = clone(v ?? null)
  }

  /** The database as the bot's writes leave it. */
  type Db = { deal: any; minigrids: Map<string, any>; orders: () => any[] }

  /**
   * Real deal store, saves, book rebuild; the venue, the order placement and
   * the stores recorded. `kill.after` stops the placement after that many
   * orders, as a stopped process does.
   */
  const wire = (bot: any, db: Db, kill: { after?: number; placed: number }) => {
    bot.getDeal = (id?: string) => Combo.prototype.getDeal.call(bot, id)
    bot.saveDeal = (...a: any[]) => Combo.prototype.saveDeal.apply(bot, a)
    bot.rebuildDealOrders = (...a: any[]) =>
      Combo.prototype.rebuildDealOrders.apply(bot, a)
    bot.dealsDb = {
      updateData: async (_q: any, u: any) => {
        for (const [k, v] of Object.entries(u.$set ?? {})) {
          setPath(db.deal, k, v)
        }
        return { status: 'OK' }
      },
      readData: async (q: any) => ({
        status: 'OK',
        data: { result: [db.deal].filter((d) => matches(d, q)).map(clone) },
      }),
      countData: async () => ({ status: 'OK', data: { result: 1 } }),
    }
    bot.saveMinigrid = async (m: any) => {
      db.minigrids.set(`${m.schema._id}`, clone(m.schema))
    }
    bot.minigridDb = {
      readData: async (q: any) => ({
        status: 'OK',
        data: {
          result: [...db.minigrids.values()]
            .filter((m) => matches(m, q))
            .map(clone),
        },
      }),
    }
    bot.ordersDb = {
      readData: async (q: any) => {
        const result = db
          .orders()
          .filter((o) => matches(o, q))
          .map(clone)
        return { status: 'OK', data: { result, count: result.length } }
      },
    }
    bot.placeOrders = async (_b: string, _s: string, _d: string, g: any) => {
      for (const x of g?.new ?? []) {
        if (kill.after !== undefined && kill.placed >= kill.after) {
          throw new Error('process stopped')
        }
        kill.placed++
        bot.orders.set(x.newClientOrderId, {
          clientOrderId: x.newClientOrderId,
          orderId: x.newClientOrderId,
          symbol: SYMBOL,
          botId: BOT_ID,
          dealId: DEAL_ID,
          typeOrder: x.type,
          side: x.side,
          type: 'LIMIT',
          status: 'NEW',
          price: `${x.price}`,
          origPrice: `${x.price}`,
          origQty: `${x.qty}`,
          executedQty: '0',
          minigridId: x.minigridId,
          dcaLevel: x.dcaLevel,
          updateTime: 1_800_000_000_000 + kill.placed,
        })
      }
    }
    // The venue takes the cancels: the deal's resting book is gone.
    bot.cancelAllOrder = async () => {
      bot.cancelSweeps++
      for (const o of bot.orders.values()) {
        if (o.dealId === DEAL_ID && o.status === 'NEW') {
          o.status = 'CANCELED'
        }
      }
    }
    for (const m of [
      'removeDealFromStopLossMethods',
      'checkAllowedMethods',
      'setClassProperties',
      'updateUsage',
      'updateAssets',
      'setCloseByTimer',
      'checkTPLevel',
      'checkDealsAllowedMethods',
      'loadTransactions',
      'recoverClosedBaseMinigrids',
      'setOrdersToRedis',
      'setDealToRedis',
      'scheduleDcaIndicatorSync',
      'calculateBotUsage',
      'sendHundredAlert',
      'sendEightyAlert',
    ]) {
      bot[m] = async () => undefined
    }
    bot.getLastStreamData = () => undefined
    bot.pairs = new Set([SYMBOL])
  }

  const resting = (bot: any) =>
    [...bot.orders.values()].filter(
      (o: any) => o.dealId === DEAL_ID && o.status === 'NEW',
    )
  const restingSellBase = (bot: any) =>
    sum(
      resting(bot)
        .filter(
          (o: any) =>
            o.typeOrder === TypeOrderEnum.dealGrid && o.side === 'SELL',
        )
        .map((o: any) => +o.origQty),
    )
  const restingLevels = (bot: any) =>
    resting(bot)
      .filter((o: any) => o.typeOrder === TypeOrderEnum.dealRegular)
      .map((o: any) => [+o.price, +o.origQty])
      .sort((a: number[], b: number[]) => b[0] - a[0])

  /**
   * BO + SO1 filled (2.0204 BTC), its book resting and snapshotted; +50 % at
   * 97 buys 1.0102 and the worker stops after the first order of the
   * rebuilt book. Returns the database and the pre-add snapshot.
   */
  const stopMidRebuild = async () => {
    const bot = await setup({ filled: 1, price: 97 })
    const store = bot.theDeal
    bot.deals.set(DEAL_ID, store)
    const db: Db = {
      deal: clone(store.deal),
      minigrids: new Map(
        bot.allMinigrids.map((m: any) => [`${m.schema._id}`, clone(m.schema)]),
      ),
      orders: () => [...bot.orders.values()],
    }
    const kill: { after?: number; placed: number } = { placed: 0 }
    wire(bot, db, kill)
    // The book as it rested before the request.
    await bot.rebuildDealOrders(store, DEAL_ID, { keepLevels: true })
    const position = 1 + SO[0].qty
    expect(restingSellBase(bot)).to.be.closeTo(position, 0.002)
    expect(restingLevels(bot)).to.deep.equal([
      [96, 2.0833],
      [94, 4.2553],
    ])
    await bot.flushComboFundsSnapshot(true)
    const snapshot = clone(bot.redisSnapshot)

    await bot.addDealFunds(BOT_ID, DEAL_ID, pct('50'))
    expect(bot.refusals).to.deep.equal([])
    const add = bot.orders.get(bot.sent[0].clientOrderId)
    expect(+add.executedQty).to.equal(1.0102)
    kill.placed = 0
    kill.after = 1
    let stopped: unknown
    await bot.applyComboFundsFill(add).catch((e: unknown) => (stopped = e))
    expect(`${stopped}`).to.contain('process stopped')
    return { db, snapshot, add, position: position + 1.0102 }
  }

  /** A fresh worker on the same database and the given Redis snapshot. */
  const restart = async (db: Db, snapshot: any) => {
    const bot = makeBot({ filled: 1, price: 97 })
    const rows = db.orders().map(clone)
    const dbNow: Db = { ...db, orders: () => rows }
    wire(bot, dbNow, { placed: 0 })
    bot.serviceRestart = true
    bot.secondRestart = false
    bot.redisSnapshot = clone(snapshot)
    await bot.loadOrders()
    // Every row the bot holds is now in the store the venue stub reads.
    rows.length = 0
    await bot.resumeComboFundsChanges()
    return bot
  }

  it('the stopped booking left the database booked and marked, the book half placed', async () => {
    const { db, add } = await stopMidRebuild()
    expect(db.deal.funds.map((f: any) => f.qty)).to.deep.equal([1.0102])
    expect(db.deal.comboFundsRebuild).to.equal(add.addFundsId)
    const live = db.orders().filter((o) => o.status === 'NEW')
    expect(live).to.have.length(1)
    for (const m of db.minigrids.values()) {
      expect(m.appliedFundsScale).to.include(add.addFundsId)
    }
  })

  it('restart on the older snapshot: deal, orders and minigrids load from the database, the book is rebuilt scaled and the marker cleared', async () => {
    const { db, snapshot, add, position } = await stopMidRebuild()
    // The snapshot predates the add: old deal, unscaled minigrids, old book.
    expect(snapshot.deals[0].deal.funds ?? []).to.deep.equal([])
    const bot = await restart(db, snapshot)
    const deal = bot.getDeal(DEAL_ID)
    // The filled add order is in the book the balances are read from.
    expect(bot.orders.get(add.clientOrderId)?.status).to.equal('FILLED')
    expect(deal.deal.currentBalances.base).to.be.closeTo(position, 1e-6)
    // Σ resting grid sells is the position: no oversell, no orphan base.
    expect(restingSellBase(bot)).to.be.at.most(position + 1e-9)
    expect(restingSellBase(bot)).to.be.closeTo(position, 0.002)
    // The unfilled levels rest at the scaled size, once each.
    expect(restingLevels(bot)).to.deep.equal([
      [96, 3.125],
      [94, 6.383],
    ])
    // The size follows the position.
    await Combo.prototype.updateUsage.call(bot, DEAL_ID)
    expect(bot.getDeal(DEAL_ID).deal.size).to.be.closeTo(position, 0.002)
    expect(db.deal.size).to.be.closeTo(position, 0.002)
    // Done: the marker is cleared and every snapshot holds the new book.
    expect(db.deal.comboFundsRebuild).to.equal(null)
    expect(bot.redisSnapshot.deals[0].deal.comboFundsRebuild).to.equal(null)
    const snapOrders = bot.redisSnapshot.orders.filter(
      (o: any) => o.status === 'NEW',
    )
    expect(snapOrders.map((o: any) => o.clientOrderId).sort()).to.deep.equal(
      resting(bot)
        .map((o: any) => o.clientOrderId)
        .sort(),
    )
  })

  it('a second restart after the rebuild finished keeps the snapshot and places nothing', async () => {
    const { db, snapshot } = await stopMidRebuild()
    const first = await restart(db, snapshot)
    const book = resting(first)
      .map((o: any) => o.clientOrderId)
      .sort()
    const second = makeBot({ filled: 1, price: 97 })
    const rows = [...first.orders.values()].map(clone)
    wire(second, { ...db, orders: () => rows }, { placed: 0 })
    second.serviceRestart = true
    second.secondRestart = false
    second.redisSnapshot = clone(first.redisSnapshot)
    await second.loadOrders()
    await second.resumeComboFundsChanges()
    expect(second.cancelSweeps).to.equal(0)
    expect(
      resting(second)
        .map((o: any) => o.clientOrderId)
        .sort(),
    ).to.deep.equal(book)
  })
})
