process.env.NODE_ENV = 'testing'

/**
 * Spec `233` end to end: a DCA deal's skipped ladder levels are recorded, are
 * never placed by the bot, and can be executed one by one by the user.
 *
 * Drives the REAL `dcaHelper.createInitialDealOrders`,
 * `createCurrentDealOrders` and `executeNextDcaLevel` on a minimal base class:
 * no stack, DB, Redis or exchange connection. Nothing here places or cancels
 * anything; the venue calls are recorders.
 *
 * Fixtures (`missedLevels.fixture.json`) are recorded live deals, reduced to
 * their settings, ladder fills and stored breakpoints, with the market price
 * at the time:
 * - `long-gap-then-deeper`: level 13 was refused for margin, then moved to the
 *   market and filled there; the slice skipped levels 14–17 and placed 18.
 * - `long-fill-at-breakpoint-price`: level 13 moved to the market, 14 and 15
 *   skipped, 16 and 17 filled; 17's row carries its own price, its fill the
 *   breakpoint's.
 * - `short-wick-beyond-ladder`: a level filled ~4× past the ladder's deepest
 *   level (its breakpoint is ignored by spec 164 §1.3); 21 levels left behind.
 * - `long-precision-drift`: level 1 never rested, level 2 filled; the pair's
 *   price precision changed since, so the rebuilt level 2 is 0.017254, not
 *   the 0.01725 its order was sent at.
 * - `short-out-of-base-coin`: spot short whose venue refuses for balance.
 * - `long-no-skips`, `long-placeholder-row`: nothing was skipped.
 *
 * `baseline` is what the engine placed for each fixture BEFORE spec 233. The
 * change must not place anything new on deploy.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum } from '../../../types'
import { createRequire } from 'module'
import fixtures from './missedLevels.fixture.json'

type Fixture = (typeof fixtures)[keyof typeof fixtures]

/** Pre-spec-233 output of the same checked rebuild, `L<level>=<price>`. */
const baseline: Record<string, string[]> = {
  'long-gap-then-deeper': [],
  'long-fill-at-breakpoint-price': [],
  'short-wick-beyond-ladder': [],
  'long-precision-drift': [],
  'short-out-of-base-coin': [],
  'long-no-skips': ['L18=2.95'],
  'long-placeholder-row': ['L18=0.006675'],
}

const expectedMissed: Record<string, number[]> = {
  'long-gap-then-deeper': [14, 15, 16, 17],
  'long-fill-at-breakpoint-price': [14, 15],
  'short-wick-beyond-ladder': [
    10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31, 32,
  ],
  'long-precision-drift': [1],
  'short-out-of-base-coin': Array.from({ length: 26 }, (_, i) => i + 7),
  'long-no-skips': [],
  'long-placeholder-row': [],
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = true
  futures = false
  coinm = false
  combo = false
  hedge = false
  kucoinSpot = false
  zeroFee = false
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  orders = new Map()
  ordersInBetweenUpdates = new Set()
  data: any = {
    settings: {},
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const DEAL_ID = 'missed-levels-deal'

const build = (f: Fixture, over: { rows?: any[]; deal?: any } = {}) => {
  const long = f.strategy === 'LONG'
  const settings: any = { ...f.settings, strategy: f.strategy }
  const rows: any[] = (over.rows ?? f.rows).map((r: any, i: number) => ({
    clientOrderId: `D-RO-${i}`,
    dealId: DEAL_ID,
    side: long ? 'BUY' : 'SELL',
    typeOrder: TypeOrderEnum.dealRegular,
    executedQty: r.status === 'FILLED' ? `${r.origQty}` : '0',
    ...r,
    origPrice: `${r.origPrice}`,
    price: `${r.price}`,
    origQty: `${r.origQty}`,
  }))
  const ed = {
    pair: f.symbol,
    baseAsset: { ...f.pair.baseAsset, name: 'BASE' },
    quoteAsset: { ...f.pair.quoteAsset, name: 'QUOTE' },
    priceAssetPrecision: f.pair.priceAssetPrecision,
  }
  const dealDoc: any = {
    _id: DEAL_ID,
    status: 'open',
    initialPrice: f.initialPrice,
    lastPrice: f.lastPrice,
    avgPrice: f.avgPrice,
    gridBreakpoints: f.gridBreakpoints.map((b) => ({ ...b })),
    symbol: { symbol: f.symbol, baseAsset: 'BASE', quoteAsset: 'QUOTE' },
    settings: {},
    levels: {
      all: +settings.ordersCount + 1,
      complete: 1 + rows.filter((r) => r.status === 'FILLED').length,
    },
    funds: [],
    strategy: f.strategy,
    ...over.deal,
  }
  class TestBot extends Helper {
    logs: string[] = []
    errors: string[] = []
    events: string[] = []
    saved: any[] = []
    sentGrids: any[] = []
    cancelled: string[] = []
    filledOrders: any[] = []
    dealsByMarketProcessing = new Set<string>()
    botEventDb = {
      createData: (e: any) => {
        this.events.push(e.description)
      },
    }
    dealsDb = { updateData: async () => ({ status: 'OK' }) }
    getDeal() {
      return { deal: dealDoc, initialOrders: [], currentOrders: [] }
    }
    setDeal() {}
    emit() {}
    shouldProceed() {
      return true
    }
    getOrdersByStatusAndDealId(opts: any = {}) {
      const statuses: string[] = opts.defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : [opts.status].flat().filter(Boolean)
      return rows.filter((o) => statuses.includes(o.status))
    }
    findBaseOrderByDeal() {
      return undefined
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return ed
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async baseAssetPrecision() {
      return 8
    }
    async getUsdRate() {
      return 1
    }
    async profitBase() {
      return false
    }
    async getLatestPrice() {
      return f.market
    }
    async getTPOrder() {
      return []
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    getOrderId(prefix: string) {
      return `${prefix}-missed`
    }
    saveDeal(_d: any, update: any) {
      this.saved.push(update)
    }
    async cancelOrderOnExchange(o: any) {
      this.cancelled.push(o.clientOrderId)
      return { ...o, status: 'CANCELED' }
    }
    async sendGridToExchange(grid: any, additional: any) {
      this.sentGrids.push({ ...grid, ...additional })
      return {
        ...grid,
        status: 'FILLED',
        exchange: ExchangeEnum.binance,
      }
    }
    async processFilledOrder(o: any) {
      this.filledOrders.push(o)
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn() {}
    handleErrors(m: string) {
      this.errors.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.isLong = long
  bot.futures = !!settings.futures
  bot.data.settings = settings
  return { bot, dealDoc, rows }
}

const rebuild = async (bot: any, dealDoc: any, f: Fixture) => {
  const initial = await bot.createInitialDealOrders(
    f.symbol,
    dealDoc.initialPrice,
    DEAL_ID,
    dealDoc,
  )
  const current = await bot.createCurrentDealOrders(
    f.symbol,
    dealDoc.lastPrice,
    initial,
    dealDoc.avgPrice,
    dealDoc.initialPrice,
    DEAL_ID,
    false,
    dealDoc,
    false,
  )
  return {
    initial,
    current: current
      .filter((o: any) => o.type === TypeOrderEnum.dealRegular)
      .map((o: any) => `L${o.levelNumber}=${o.price}`),
  }
}

describe('spec 233: skipped DCA ladder levels', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('§1 recording', () => {
    for (const [name, f] of Object.entries(fixtures)) {
      it(`${name}: records ${expectedMissed[name].length} skipped level(s) and places exactly what it placed before`, async () => {
        const { bot, dealDoc } = build(f)
        const { current } = await rebuild(bot, dealDoc, f)
        expect(current).to.deep.equal(baseline[name])
        expect(
          (dealDoc.missedLevels ?? []).map((m: any) => m.level),
        ).to.deep.equal(expectedMissed[name])
        if (expectedMissed[name].length) {
          // Told once, saved once.
          expect(bot.events).to.have.length(1)
          expect(
            bot.saved.filter((s: any) => 'missedLevels' in s),
          ).to.have.length(1)
        } else {
          expect(bot.events).to.deep.equal([])
          expect(bot.saved).to.deep.equal([])
        }
      })
    }

    it('a second rebuild with nothing changed writes nothing and says nothing', async () => {
      const f = fixtures['long-gap-then-deeper']
      const { bot, dealDoc } = build(f)
      await rebuild(bot, dealDoc, f)
      await rebuild(bot, dealDoc, f)
      expect(bot.events).to.have.length(1)
      expect(bot.saved.filter((s: any) => 'missedLevels' in s)).to.have.length(
        1,
      )
    })
  })

  describe('§2 a skipped level is never placed by the bot', () => {
    it('stays out after the last fill moves past it (the user executed another one)', async () => {
      const f = fixtures['long-gap-then-deeper']
      const first = build(f)
      await rebuild(first.bot, first.dealDoc, f)
      const recorded = first.dealDoc.missedLevels
      // The user executes level 14 at the market: a stamped fill, and the
      // deal's last fill price moves up to it, above levels 15–17.
      const rows = [
        ...f.rows,
        {
          status: 'FILLED',
          origPrice: f.market,
          price: f.market,
          origQty: 1.79,
          orderId: 'venue',
          ladderLevel: 14,
        },
      ]
      const after = build(f, {
        rows,
        deal: { lastPrice: f.market, missedLevels: recorded },
      })
      const { current } = await rebuild(after.bot, after.dealDoc, f)
      expect(after.dealDoc.missedLevels.map((m: any) => m.level)).to.deep.equal(
        [15, 16, 17],
      )
      expect(current).to.deep.equal([])
    })

    it('without the record, the same state WOULD place them (why the record must stick)', async () => {
      const f = fixtures['long-gap-then-deeper']
      const rows = [
        ...f.rows,
        {
          status: 'FILLED',
          origPrice: f.market,
          price: f.market,
          origQty: 1.79,
          orderId: 'venue',
          ladderLevel: 14,
        },
      ]
      // Recording on, but nothing recorded before: the levels are on the far
      // side of the new last fill, so they are not "skipped" by price.
      const { bot, dealDoc } = build(f, { rows, deal: { lastPrice: f.market } })
      const { current } = await rebuild(bot, dealDoc, f)
      expect(current.length).to.be.greaterThan(0)
    })

    it('an unchecked rebuild (order cancel, merge) keeps recorded levels out too', async () => {
      const f = fixtures['long-gap-then-deeper']
      const { bot, dealDoc } = build(f, {
        deal: {
          lastPrice: f.market,
          missedLevels: [15, 16, 17].map((level) => ({
            level,
            price: 0,
            qty: 0,
          })),
        },
      })
      const initial = await bot.createInitialDealOrders(
        f.symbol,
        dealDoc.initialPrice,
        DEAL_ID,
        dealDoc,
      )
      const current = await bot.createCurrentDealOrders(
        f.symbol,
        dealDoc.lastPrice,
        initial,
        dealDoc.avgPrice,
        dealDoc.initialPrice,
        DEAL_ID,
        false,
        dealDoc,
      )
      const levels = current
        .filter((o: any) => o.type === TypeOrderEnum.dealRegular)
        .map((o: any) => o.levelNumber)
      for (const l of [15, 16, 17]) {
        expect(levels).to.not.include(l)
      }
    })
  })

  describe('§3 executing a skipped level by hand', () => {
    it('executes exactly the requested skipped level, at market, stamped with its level', async () => {
      const f = fixtures['long-gap-then-deeper']
      const { bot, dealDoc } = build(f)
      await rebuild(bot, dealDoc, f)
      await bot.executeNextDcaLevel('bot', DEAL_ID, { missedLevel: 15 })
      expect(bot.errors).to.deep.equal([])
      expect(bot.sentGrids).to.have.length(1)
      expect(bot.sentGrids[0].levelNumber).to.equal(15)
      expect(bot.sentGrids[0].type).to.equal('MARKET')
      expect(bot.filledOrders).to.have.length(1)
      expect(bot.events.at(-1)).to.match(
        /^Skipped DCA level 15 was executed manually/,
      )
    })

    it('refuses a level that is not skipped (it filled) and sends nothing', async () => {
      const f = fixtures['long-gap-then-deeper']
      const { bot, dealDoc } = build(f)
      await rebuild(bot, dealDoc, f)
      await bot.executeNextDcaLevel('bot', DEAL_ID, { missedLevel: 18 })
      expect(bot.sentGrids).to.deep.equal([])
      expect(bot.errors.join(' ')).to.match(/not a skipped level/)
    })

    it('refuses "execute next" when the counted next level already filled', async () => {
      // 15 ladder fills: the count says level 16 is next, but 16 filled (14
      // and 15 were skipped). Filling 16 again would double it.
      const f = fixtures['long-fill-at-breakpoint-price']
      const { bot, dealDoc } = build(f)
      await rebuild(bot, dealDoc, f)
      await bot.executeNextDcaLevel('bot', DEAL_ID)
      expect(bot.sentGrids).to.deep.equal([])
      expect(bot.errors.join(' ')).to.match(/already filled/)
    })

    it('"execute next" on a deal with no skips is unchanged', async () => {
      const f = fixtures['long-no-skips']
      const { bot, dealDoc } = build(f)
      await rebuild(bot, dealDoc, f)
      await bot.executeNextDcaLevel('bot', DEAL_ID)
      expect(bot.errors).to.deep.equal([])
      expect(bot.sentGrids.map((g: any) => g.levelNumber)).to.deep.equal([18])
    })
  })
})
