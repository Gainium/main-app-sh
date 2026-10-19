process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `179.a-venue-cancel-all-empties-a-combo-minigrid-for-good`.
 *
 * Drives the REAL `comboHelper.processCanceledOrder` (and `updateAssets` when
 * it prunes) off the mixin. The ladder is a futures combo minigrid created with
 * `lockClose`, whose every resting level the venue cancelled in one burst eight
 * hours after the last of them was placed. The prices and timestamps are the
 * production ones; how the levels split between the deal's two minigrids is
 * not in the log, so this fixture puts them on one.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Importing the module opens no connections; instance properties shadow
 * prototype methods. No Mongo, Redis, venue or bot stack is needed, and
 * `placeOrders` is recorded, never sent. Harness shape copied from
 * `comboGridCancelLedger.spec.ts` (spec 077).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, TypeOrderEnum } from '../../types'
import { MathHelper } from '../utils/math'
import {
  GRID_LEVEL_REST_MS,
  wasRestingWhenCanceled,
} from './combo/gridCancelRested'

const DEAL_ID = '000000000000000000000d79'
const BOT_ID = '000000000000000000000b79'
const MINIGRID_ID = '000000000000000000000f79'
const SYMBOL = 'BTCUSDT'
const QTY = 0.0015

/** Venue time the last BUY was placed: 2026-09-24T13:32:13.642Z. */
const PLACED_AT = 1790256733642
/** Venue time of the cancel-all: 2026-09-24T21:40:18.411Z. */
const CANCELED_AT = 1790286018411

const BUY_PRICES = [83262.4]
const SELL_PRICES = [85013.1, 85871.8, 87018.7, 88096.8]

const gridEntry = (price: number, side: OrderSideEnum) =>
  ({
    number: 0,
    price,
    qty: QTY,
    side,
    type: TypeOrderEnum.dealGrid,
    dealId: DEAL_ID,
    minigridId: MINIGRID_ID,
    newClientOrderId: `CMB-GR-${side}-${price}`,
  }) as any

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
    transactTime: PLACED_AT,
    updateTime: PLACED_AT,
    ...over,
  }) as any

/** The cancel report as `processOrderQueue` hands it over. */
const canceled = (
  price: number,
  side: OrderSideEnum,
  over: Record<string, unknown> = {},
) =>
  ({
    ...liveOrder(price, side),
    status: 'CANCELED',
    updateTime: CANCELED_AT,
    ...over,
  }) as any

let Helper: any

const buildBot = (opts: { dealStatus?: string } = {}) => {
  const { dealStatus = 'open' } = opts
  const ladder = [
    ...BUY_PRICES.map((p) => gridEntry(p, OrderSideEnum.buy)),
    ...SELL_PRICES.map((p) => gridEntry(p, OrderSideEnum.sell)),
  ]
  // `processOrderQueue` deletes the cancelled row from the live-order index
  // before calling us, so the index is drained as the burst is processed.
  const live = [
    ...BUY_PRICES.map((p) => liveOrder(p, OrderSideEnum.buy)),
    ...SELL_PRICES.map((p) => liveOrder(p, OrderSideEnum.sell)),
  ]
  const placed: any[] = []
  const savedMinigrid: any[] = []
  const minigrid = {
    initialGrids: [],
    currentOrders: [...ladder],
    schema: {
      _id: MINIGRID_ID,
      botId: BOT_ID,
      dealId: DEAL_ID,
      status: 'active',
      lockClose: true,
      symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
      settings: {},
      grids: { buy: BUY_PRICES.length, sell: SELL_PRICES.length },
      currentBalances: { base: 0, quote: 0 },
      assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
    },
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
      lastPrice: 84000,
      avgPrice: 84000,
      initialPrice: 84000,
      settings: { avgPrice: 84000 },
      assets: {
        used: { base: 0, quote: 0 },
        required: { base: 0, quote: 0 },
      },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  let nextId = 0

  class TestBot extends (Helper as any) {
    math = new MathHelper()
    isLong = true
    futures = false
    coinm = false
    combo = true
    botType = 'combo'
    botId = BOT_ID
    minigridDealMap = new Map<string, Set<string>>()
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      flags: [],
      paperContext: false,
    }
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
    async createCurrentDealOrders() {
      return []
    }
    async getAggregatedSettings() {
      return {
        futures: false,
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
    getOrderId(prefix: string) {
      return `${prefix}-fresh-${++nextId}`
    }
    async placeOrders(
      _botId: string,
      symbol: string,
      dealId: string,
      orders: { new: any[]; cancel: any[] },
    ) {
      placed.push({ symbol, dealId, orders })
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

  /** Process one cancel report the way `processOrderQueue` does. */
  const report = async (bot: any, order: any) => {
    const i = live.findIndex(
      (o) => o.side === order.side && +o.origPrice === +order.origPrice,
    )
    if (i !== -1) live.splice(i, 1)
    await bot.processCanceledOrder(order, order.updateTime, false)
  }

  return {
    bot: new (TestBot as any)(),
    minigrid,
    deal,
    placed,
    savedMinigrid,
    report,
  }
}

describe('a venue cancel-all empties a combo minigrid for good (spec 179)', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  it('keeps and re-places a level that rested', async () => {
    const { bot, minigrid, placed, savedMinigrid, report } = buildBot()
    await report(bot, canceled(83262.4, OrderSideEnum.buy))

    expect(minigrid.currentOrders).to.have.length(5)
    expect(minigrid.schema.grids).to.deep.equal({ buy: 1, sell: 4 })
    expect(savedMinigrid).to.have.length(0)
    expect(placed).to.have.length(1)
    expect(placed[0].dealId).to.equal(DEAL_ID)
    expect(placed[0].orders.cancel).to.have.length(0)
    expect(placed[0].orders.new).to.have.length(1)
    const level = placed[0].orders.new[0]
    expect(level.price).to.equal(83262.4)
    expect(level.side).to.equal(OrderSideEnum.buy)
    expect(level.qty).to.equal(QTY)
    expect(level.type).to.equal(TypeOrderEnum.dealGrid)
    expect(level.minigridId).to.equal(MINIGRID_ID)
    // Never the id of the order the venue just cancelled.
    expect(level.newClientOrderId).to.match(/^CMB-GR-fresh-/)
  })

  it('a cancel-all on a lockClose minigrid does not leave it empty', async () => {
    const { bot, minigrid, placed, report } = buildBot()
    for (const p of BUY_PRICES) {
      await report(bot, canceled(p, OrderSideEnum.buy))
    }
    for (const p of SELL_PRICES) {
      await report(bot, canceled(p, OrderSideEnum.sell))
    }

    expect(minigrid.schema.status).to.equal('active')
    expect(minigrid.schema.grids).to.deep.equal({
      buy: BUY_PRICES.length,
      sell: SELL_PRICES.length,
    })
    expect(minigrid.currentOrders).to.have.length(
      BUY_PRICES.length + SELL_PRICES.length,
    )
    // Every cancelled level is sent again, once.
    expect(
      placed
        .flatMap((p) => p.orders.new)
        .map((g: any) => `${g.side}@${g.price}`)
        .sort(),
    ).to.deep.equal(
      [
        ...BUY_PRICES.map((p) => `${OrderSideEnum.buy}@${p}`),
        ...SELL_PRICES.map((p) => `${OrderSideEnum.sell}@${p}`),
      ].sort(),
    )
  })

  it('prunes an order refused on placement, without retrying it', async () => {
    // Spec 077's case: acknowledged and cancelled in the same instant.
    const { bot, minigrid, placed, report } = buildBot()
    await report(
      bot,
      canceled(83262.4, OrderSideEnum.buy, {
        transactTime: CANCELED_AT - 7,
        updateTime: CANCELED_AT,
      }),
    )
    expect(minigrid.schema.grids).to.deep.equal({ buy: 0, sell: 4 })
    expect(minigrid.currentOrders).to.have.length(4)
    expect(placed).to.have.length(0)
  })

  it('treats an order with no placement time as refused', async () => {
    const { bot, minigrid, placed, report } = buildBot()
    await report(
      bot,
      canceled(83262.4, OrderSideEnum.buy, { transactTime: undefined }),
    )
    expect(minigrid.schema.grids.buy).to.equal(0)
    expect(placed).to.have.length(0)
  })

  it('does not re-place on a deal that is not open', async () => {
    const { bot, minigrid, placed, report } = buildBot({
      dealStatus: 'closed',
    })
    await report(bot, canceled(83262.4, OrderSideEnum.buy))
    expect(minigrid.schema.grids.buy).to.equal(1)
    expect(placed).to.have.length(0)
  })

  it('wasRestingWhenCanceled boundary', () => {
    expect(
      wasRestingWhenCanceled({
        transactTime: PLACED_AT,
        updateTime: PLACED_AT + GRID_LEVEL_REST_MS,
      }),
    ).to.equal(true)
    expect(
      wasRestingWhenCanceled({
        transactTime: PLACED_AT,
        updateTime: PLACED_AT + GRID_LEVEL_REST_MS - 1,
      }),
    ).to.equal(false)
    expect(
      wasRestingWhenCanceled({ transactTime: -1, updateTime: CANCELED_AT }),
    ).to.equal(false)
    expect(wasRestingWhenCanceled({ transactTime: PLACED_AT })).to.equal(false)
  })

  describe('a minigrid already emptied, on a service restart', () => {
    /** A minigrid as the Redis copy carries it across a restart. */
    const fromRedis = (
      id: string,
      over: { status?: string; lastPrice?: number; ladder?: any[] } = {},
    ) => ({
      initialGrids: [{ number: 0, price: { buy: 83262.4, sell: 85013.1 } }],
      currentOrders: over.ladder ?? [],
      schema: {
        _id: id,
        botId: BOT_ID,
        dealId: DEAL_ID,
        status: over.status ?? 'active',
        lockClose: true,
        initialPrice: 84000,
        lastPrice: over.lastPrice ?? 84137.5,
        lastSide: OrderSideEnum.sell,
        symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
        settings: {
          lowPrice: 80000,
          topPrice: 90000,
          levels: 5,
          budget: 600,
          sellDisplacement: 0,
          profitCurrency: 'quote',
          orderFixedIn: 'base',
        },
        grids: { buy: 0, sell: 0 },
        currentBalances: { base: 0, quote: 0 },
        assets: {
          used: { base: 0, quote: 0 },
          required: { base: 0, quote: 0 },
        },
      },
    })

    const restart = async (minigrids: any[]) => {
      const generated: any[] = []
      const saved: any[] = []
      class RestartBot extends (Helper as any) {
        math = new MathHelper()
        isLong = true
        botId = BOT_ID
        serviceRestart = true
        secondRestart = false
        minigridDealMap = new Map<string, Set<string>>()
        data: any = { settings: {}, flags: [], paperContext: false }
        async getFromRedis(key: string) {
          return key === 'minigrids' ? minigrids : undefined
        }
        async baseAssetPrecision() {
          return 4
        }
        // The ladder math is the database load's own; the price it is asked
        // for is what this test checks.
        async generateBasicGrids() {
          return [{ number: 0, price: { buy: 83262.4, sell: 85013.1 } }]
        }
        async generateGridsOnPrice(args: any) {
          generated.push(args)
          return [
            ...BUY_PRICES.map((p) => ({ ...gridEntry(p, OrderSideEnum.buy) })),
            ...SELL_PRICES.map((p) => ({
              ...gridEntry(p, OrderSideEnum.sell),
            })),
          ]
        }
        getDeal() {
          return undefined
        }
        async saveMinigrid(full: any, changed: any) {
          Object.assign(full.schema, changed)
          saved.push({ id: full.schema._id, changed })
        }
        saveMinigridToRedis() {}
        setToRedis() {}
        getOrderId(prefix: string) {
          return `${prefix}-fresh`
        }
        handleLog() {}
        handleDebug() {}
        handleWarn() {}
        startMethod() {
          return '1'
        }
        endMethod() {}
      }
      const bot: any = new (RestartBot as any)()
      await bot.loadMinigrids()
      return { bot, generated, saved }
    }

    it('rebuilds the ladder of an active minigrid left with none', async () => {
      const { bot, generated, saved } = await restart([
        fromRedis(MINIGRID_ID),
      ])
      const m = bot.getMinigrid(MINIGRID_ID)
      expect(m.currentOrders).to.have.length(
        BUY_PRICES.length + SELL_PRICES.length,
      )
      expect(m.schema.status).to.equal('active')
      expect(m.schema.grids).to.deep.equal({
        buy: BUY_PRICES.length,
        sell: SELL_PRICES.length,
      })
      // From the minigrid's own last fill, as the database load rebuilds it.
      expect(generated).to.have.length(1)
      expect(generated[0]._lastPrice).to.equal(84137.5)
      expect(generated[0]._side).to.equal(OrderSideEnum.sell)
      expect(saved).to.have.length(1)
      expect(saved[0].changed.grids).to.deep.equal({
        buy: BUY_PRICES.length,
        sell: SELL_PRICES.length,
      })
    })

    it('leaves a minigrid that still has a ladder as Redis carried it', async () => {
      const ladder = SELL_PRICES.map((p) => gridEntry(p, OrderSideEnum.sell))
      const { bot, generated, saved } = await restart([
        fromRedis(MINIGRID_ID, { ladder }),
      ])
      expect(bot.getMinigrid(MINIGRID_ID).currentOrders).to.have.length(
        SELL_PRICES.length,
      )
      expect(generated).to.have.length(0)
      expect(saved).to.have.length(0)
    })

    it('does not build a ladder the database load would not build', async () => {
      // No last price yet: the database load leaves it empty too.
      const { bot, generated, saved } = await restart([
        fromRedis(MINIGRID_ID, { lastPrice: 0 }),
      ])
      expect(bot.getMinigrid(MINIGRID_ID).currentOrders).to.have.length(0)
      expect(generated).to.have.length(0)
      expect(saved).to.have.length(0)
    })
  })
})
