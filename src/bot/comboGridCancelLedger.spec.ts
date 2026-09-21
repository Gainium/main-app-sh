process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `077.a-cancelled-grid-order-keeps-its-reservation`.
 *
 * Drives the REAL `comboHelper.processCanceledOrder` and the REAL
 * `comboHelper.updateAssets` off the mixin, over the ladder a production LONG
 * spot combo bot held after six BUY grid orders were reported `CANCELED` by
 * the venue within twenty-four seconds.
 *
 * `updateAssets` derives `deal.assets.used.quote` from the minigrids'
 * `currentOrders` (`comboHelper.ts` §"minigridsQuote"), so a level that is off
 * the book but still in that array is quote the deal believes it has reserved
 * and will not spend. The numbers below are the production ones: the six
 * cancelled BUYs are worth 315.1189 USD and the deal's `used.quote` was
 * 1363.629 against 1048.510 actually resting.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Importing the module opens no connections; instance properties shadow
 * prototype methods. No Mongo, Redis, venue or bot stack is needed and nothing
 * here places or cancels anything. Harness shape copied from
 * `remainderDoubleCount.spec.ts` (spec 060).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, TypeOrderEnum } from '../../types'
import { MathHelper } from '../utils/math'

const DEAL_ID = '000000000000000000000d77'
const BOT_ID = '000000000000000000000b77'
const MINIGRID_ID = '000000000000000000000f77'
const OTHER_MINIGRID_ID = '000000000000000000000f78'
const SYMBOL = 'SN64-USD'

/** Every BUY on this ladder is the same size — the production one. */
const QTY = 2.62656

/** The three BUY levels that are still resting on the venue. */
const LIVE_BUY_PRICES = [20.104, 20.026, 19.948]
/** The six BUY levels the venue cancelled; the hole the reporter sees. */
const CANCELED_BUY_PRICES = [20.181, 20.259, 20.337, 20.415, 20.48, 20.545]
/** The SELL side, which reconciles correctly today — the control. */
const LIVE_SELL_PRICES = [20.609, 20.688, 20.767, 20.846]

const notional = (prices: number[]) =>
  prices.reduce((acc, p) => acc + p * QTY, 0)

const gridEntry = (
  price: number,
  side: OrderSideEnum,
  over: Record<string, unknown> = {},
) =>
  ({
    number: 0,
    price,
    qty: QTY,
    side,
    type: TypeOrderEnum.dealGrid,
    dealId: DEAL_ID,
    minigridId: MINIGRID_ID,
    // Regenerated on every fill — never the id of the order actually resting
    // at this level. Spec 077 §4.2.
    newClientOrderId: `CMB-GR-${side}-${price}`,
    ...over,
  }) as any

/** A resting order as the engine's own live-order index holds it. */
const liveOrder = (
  price: number,
  side: OrderSideEnum,
  over: Record<string, unknown> = {},
) =>
  ({
    clientOrderId: `CMB-GR-live-${side}-${price}`,
    dealId: DEAL_ID,
    minigridId: MINIGRID_ID,
    symbol: SYMBOL,
    side,
    status: 'NEW',
    typeOrder: TypeOrderEnum.dealGrid,
    price: `${price}`,
    origPrice: `${price}`,
    origQty: `${QTY}`,
    executedQty: '0',
    ...over,
  }) as any

/**
 * The cancel report as the venue delivered it: `CANCELED`, never `EXPIRED`.
 * `expired` is the third argument `processOrderQueue` passes, and it is
 * `order.status === 'EXPIRED'` — false for every row in this case.
 */
const canceledGridOrder = (
  price: number,
  side: OrderSideEnum = OrderSideEnum.buy,
  over: Record<string, unknown> = {},
) =>
  ({
    ...liveOrder(price, side),
    clientOrderId: `CMB-GR-canceled-${side}-${price}`,
    status: 'CANCELED',
    ...over,
  }) as any

let Helper: any

type Harness = {
  bot: any
  minigrid: any
  deal: any
  savedMinigrid: any[]
}

const buildBot = (opts: {
  isLong?: boolean
  futures?: boolean
  /** Entries on the minigrid ladder. */
  ladder?: any[]
  /** Rows the live-order index still holds. */
  live?: any[]
  /** Entries on the deal ladder (safety orders). */
  dealOrders?: any[]
  /** Starting `deal.assets`, i.e. what the deal believed before the cancel. */
  assets?: any
}): Harness => {
  const {
    isLong = true,
    futures = false,
    ladder = [
      ...LIVE_BUY_PRICES.map((p) => gridEntry(p, OrderSideEnum.buy)),
      ...CANCELED_BUY_PRICES.map((p) => gridEntry(p, OrderSideEnum.buy)),
      ...LIVE_SELL_PRICES.map((p) => gridEntry(p, OrderSideEnum.sell)),
    ],
    live = [
      ...LIVE_BUY_PRICES.map((p) => liveOrder(p, OrderSideEnum.buy)),
      ...LIVE_SELL_PRICES.map((p) => liveOrder(p, OrderSideEnum.sell)),
    ],
    dealOrders = [],
    assets = {
      used: {
        base: notional([]) + LIVE_SELL_PRICES.length * QTY,
        quote: notional([...LIVE_BUY_PRICES, ...CANCELED_BUY_PRICES]),
      },
      required: { base: 0, quote: 0 },
    },
  } = opts

  const savedMinigrid: any[] = []
  const minigrid = {
    initialGrids: [],
    currentOrders: [...ladder],
    schema: {
      _id: MINIGRID_ID,
      botId: BOT_ID,
      dealId: DEAL_ID,
      status: 'active',
      symbol: { symbol: SYMBOL, baseAsset: 'SN64', quoteAsset: 'USD' },
      settings: {},
      grids: {
        buy: ladder.filter((g) => g.side === OrderSideEnum.buy).length,
        sell: ladder.filter((g) => g.side === OrderSideEnum.sell).length,
      },
      currentBalances: { base: 0, quote: 0 },
      assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
    },
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      symbol: { symbol: SYMBOL, baseAsset: 'SN64', quoteAsset: 'USD' },
      lastPrice: 20.1,
      avgPrice: 19.5,
      initialPrice: 19.5,
      settings: { avgPrice: 19.5 },
      assets,
    },
    initialOrders: [],
    currentOrders: [...dealOrders],
    previousOrders: [],
  }

  class TestBot extends (Helper as any) {
    math = new MathHelper()
    isLong = isLong
    futures = futures
    coinm = false
    combo = true
    botType = 'combo'
    minigridDealMap = new Map<string, Set<string>>()
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      flags: [],
      paperContext: false,
    }
    savedMinigrid = savedMinigrid
    constructor() {
      super()
      this.setMinigrid(minigrid)
    }
    shouldProceed() {
      return true
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    saveDeal(full: any, changed?: any) {
      if (changed) {
        Object.assign(full.deal, changed)
      }
      return Promise.resolve()
    }
    async saveMinigrid(full: any, changed: any) {
      Object.assign(full.schema, changed)
      savedMinigrid.push(changed)
    }
    saveMinigridToRedis() {}
    setToRedis() {}
    getOrdersByStatusAndDealId({ dealId }: { dealId?: string }) {
      return dealId === DEAL_ID ? live : []
    }
    // The regular (safety-order) ladder — none on this deal, so `used` is the
    // minigrids' ladder alone, which is what spec 077 is about.
    async createCurrentDealOrders() {
      return []
    }
    async getAggregatedSettings() {
      return {
        futures,
        coinm: false,
        profitCurrency: 'quote',
        useSmartOrders: false,
        activeOrdersCount: 2,
        ordersCount: 4,
      }
    }
    async getLeverageMultipler() {
      return 1
    }
    updateBotAssets() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }

  return { bot: new (TestBot as any)(), minigrid, deal, savedMinigrid }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

describe('a cancelled grid order keeps its reservation (spec 077)', () => {
  before(function () {
    // One ts-node compile of the combo mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  describe('§1.1 / §2.3 the money', () => {
    it('used.quote equals the live BUY notional after the cancels', async () => {
      const { bot, deal } = buildBot({})
      // The state the reporter's deal was in: six phantom BUYs still counted.
      expect(round(deal.deal.assets.used.quote)).to.equal(
        round(notional([...LIVE_BUY_PRICES, ...CANCELED_BUY_PRICES])),
      )

      for (const price of CANCELED_BUY_PRICES) {
        await bot.processCanceledOrder(
          canceledGridOrder(price),
          1790023332404,
          false,
        )
      }

      expect(round(deal.deal.assets.used.quote)).to.equal(
        round(notional(LIVE_BUY_PRICES)),
      )
      // The control: the SELL side never leaked, and must not start to.
      expect(round(deal.deal.assets.used.base)).to.equal(
        round(LIVE_SELL_PRICES.length * QTY),
      )
    })

    it('leaves nothing reserved for a level that is gone', async () => {
      const { bot, deal } = buildBot({})
      const before = deal.deal.assets.used.quote
      await bot.processCanceledOrder(
        canceledGridOrder(20.415),
        1790023332404,
        false,
      )
      expect(round(before - deal.deal.assets.used.quote)).to.equal(
        round(20.415 * QTY),
      )
    })
  })

  describe('§2.2 the level counts', () => {
    it('the level count drops with the order', async () => {
      const { bot, minigrid } = buildBot({})
      expect(minigrid.schema.grids.buy).to.equal(9)

      for (const price of CANCELED_BUY_PRICES) {
        await bot.processCanceledOrder(
          canceledGridOrder(price),
          1790023332404,
          false,
        )
      }

      expect(minigrid.schema.grids.buy).to.equal(LIVE_BUY_PRICES.length)
      expect(minigrid.schema.grids.sell).to.equal(LIVE_SELL_PRICES.length)
      expect(minigrid.currentOrders).to.have.length(
        LIVE_BUY_PRICES.length + LIVE_SELL_PRICES.length,
      )
      expect(
        minigrid.currentOrders.filter((g: any) =>
          CANCELED_BUY_PRICES.includes(g.price),
        ),
      ).to.have.length(0)
    })

    it('persists the recomputed counts and balances', async () => {
      const { bot, savedMinigrid, minigrid } = buildBot({})
      await bot.processCanceledOrder(
        canceledGridOrder(20.415),
        1790023332404,
        false,
      )
      expect(savedMinigrid).to.have.length(1)
      expect(savedMinigrid[0]).to.have.keys([
        'currentBalances',
        'assets',
        'grids',
      ])
      expect(round(minigrid.schema.currentBalances.quote)).to.equal(
        round(
          notional([
            ...LIVE_BUY_PRICES,
            ...CANCELED_BUY_PRICES.filter((p) => p !== 20.415),
          ]),
        ),
      )
    })
  })

  describe('§2.4 / §4.1 which cancels are acted on', () => {
    it('prunes on CANCELED, the state the venue actually reports', async () => {
      const { bot, minigrid } = buildBot({})
      // `expired` is false — this is the third argument `processOrderQueue`
      // passes, and it is only ever true for status `EXPIRED`.
      await bot.processCanceledOrder(
        canceledGridOrder(20.415),
        1790023332404,
        false,
      )
      expect(minigrid.schema.grids.buy).to.equal(8)
    })

    it('still prunes on EXPIRED', async () => {
      const { bot, minigrid } = buildBot({})
      await bot.processCanceledOrder(
        canceledGridOrder(20.415, OrderSideEnum.buy, { status: 'EXPIRED' }),
        1790023332404,
        true,
      )
      expect(minigrid.schema.grids.buy).to.equal(8)
    })

    it('prunes the cancelled side on a long bot', async () => {
      // The whole of the reported defect: on a long bot the cancelled side is
      // BUY, which the old `positionChanged` gate excluded.
      const { bot, minigrid } = buildBot({ isLong: true })
      await bot.processCanceledOrder(
        canceledGridOrder(20.415, OrderSideEnum.buy),
        1790023332404,
        false,
      )
      expect(minigrid.schema.grids.buy).to.equal(8)
    })

    it('prunes both sides on a short bot', async () => {
      const short = buildBot({ isLong: false })
      await short.bot.processCanceledOrder(
        canceledGridOrder(20.415, OrderSideEnum.buy),
        1790023332404,
        false,
      )
      expect(short.minigrid.schema.grids.buy).to.equal(8)

      // 20.609 is on the ladder but no longer resting — the SELL-side twin of
      // the reported case, which the old `positionChanged` gate excluded on a
      // short bot.
      const shortSell = buildBot({
        isLong: false,
        live: [
          ...LIVE_BUY_PRICES.map((p) => liveOrder(p, OrderSideEnum.buy)),
          ...LIVE_SELL_PRICES.filter((p) => p !== 20.609).map((p) =>
            liveOrder(p, OrderSideEnum.sell),
          ),
        ],
      })
      await shortSell.bot.processCanceledOrder(
        canceledGridOrder(20.609, OrderSideEnum.sell),
        1790023332404,
        false,
      )
      expect(shortSell.minigrid.schema.grids.sell).to.equal(
        LIVE_SELL_PRICES.length - 1,
      )
    })

    it('ignores orders that are not grid orders', async () => {
      const { bot, minigrid, deal } = buildBot({})
      const quoteBefore = deal.deal.assets.used.quote
      for (const typeOrder of [
        TypeOrderEnum.dealRegular,
        TypeOrderEnum.dealStart,
        TypeOrderEnum.dealTP,
      ]) {
        await bot.processCanceledOrder(
          canceledGridOrder(20.415, OrderSideEnum.buy, { typeOrder }),
          1790023332404,
          false,
        )
      }
      expect(minigrid.schema.grids.buy).to.equal(9)
      expect(deal.deal.assets.used.quote).to.equal(quoteBefore)
    })
  })

  describe('§4.2 / §4.3 what must never be pruned', () => {
    it('leaves a level another live order still rests on', async () => {
      // A cancel for 20.415 arriving after the engine re-placed 20.415 under a
      // new client order id. The ladder is matched by level, so without this
      // guard the replacement would be dropped from the ledger.
      const { bot, minigrid, deal } = buildBot({
        live: [
          ...LIVE_BUY_PRICES.map((p) => liveOrder(p, OrderSideEnum.buy)),
          liveOrder(20.415, OrderSideEnum.buy),
          ...LIVE_SELL_PRICES.map((p) => liveOrder(p, OrderSideEnum.sell)),
        ],
      })
      const quoteBefore = deal.deal.assets.used.quote
      await bot.processCanceledOrder(
        canceledGridOrder(20.415),
        1790023332404,
        false,
      )
      expect(minigrid.schema.grids.buy).to.equal(9)
      expect(deal.deal.assets.used.quote).to.equal(quoteBefore)
    })

    it('leaves a level resting under another minigrid alone', async () => {
      const { bot, minigrid } = buildBot({})
      await bot.processCanceledOrder(
        canceledGridOrder(20.415, OrderSideEnum.buy, {
          minigridId: OTHER_MINIGRID_ID,
        }),
        1790023332404,
        false,
      )
      expect(minigrid.schema.grids.buy).to.equal(9)
    })

    it('never touches a regular order at the same price', async () => {
      const regular = {
        ...gridEntry(20.415, OrderSideEnum.buy),
        type: TypeOrderEnum.dealRegular,
        minigridId: undefined,
        newClientOrderId: 'CMB-RO-regular',
      }
      const { bot, deal } = buildBot({ dealOrders: [regular] })
      await bot.processCanceledOrder(
        canceledGridOrder(20.415),
        1790023332404,
        false,
      )
      expect(deal.currentOrders).to.have.length(1)
      expect(deal.currentOrders[0].newClientOrderId).to.equal('CMB-RO-regular')
    })
  })
})
