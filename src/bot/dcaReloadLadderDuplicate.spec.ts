process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `106.a-dca-reload-duplicates-a-safety-order-whose-ladder-price-moved`.
 *
 * Drives the REAL restart branch of `checkOrders` and through it the REAL DCA
 * `getDiffForCheckOrders` → `findDiff`. The exchange lookups, `placeOrders`
 * and the cancel are recorded, not run. Harness shape from
 * `comboReloadLadderDuplicate.spec.ts` (spec 105).
 *
 * The prices are the production ones: an ETH-USD deal whose safety orders
 * rest at 2589.9 / 2505.2 / 2407.8 / 2295.8 / 2167 / 2018.9 under the old
 * per-level rounding. After a reload the same deal's rebuilt ladder is
 * 2589.9 / 2505.2 / 2407.9 / 2295.9 / 2167.2 / 2019.1. DCA orders carry no
 * `dcaLevel`, so levels are known only by rank.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, StatusEnum, TypeOrderEnum } from '../../types'

const DEAL_ID = '000000000000000000000d06'
const BOT_ID = '000000000000000000000b06'
const SYMBOL = 'ETH-USD'

/** Resting ladder, placed under the old rounding: [price, qty]. */
const RESTING: [string, string][] = [
  ['2589.9', '0.004'],
  ['2505.2', '0.007'],
  ['2407.8', '0.011'],
  ['2295.8', '0.017'],
  ['2167', '0.026'],
  ['2018.9', '0.042'],
]
/** The same deal's ladder as a reload rebuilds it today. */
const REBUILT: [number, number][] = [
  [2589.9, 0.004],
  [2505.2, 0.007],
  [2407.9, 0.011],
  [2295.9, 0.017],
  [2167.2, 0.026],
  [2019.1, 0.042],
]

const flip = (side: 'BUY' | 'SELL') => (side === 'BUY' ? 'SELL' : 'BUY')

const restingOrder = ([price, qty]: [string, string], i: number, side = 'BUY') =>
  ({
    symbol: SYMBOL,
    clientOrderId: `D-RO-00000000000${i}`,
    orderId: `${i}`,
    botId: BOT_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    side,
    price,
    origPrice: price,
    origQty: qty,
    executedQty: '0',
    status: 'NEW',
    updateTime: 1790174505362,
  }) as any

const ladderGrid = ([price, qty]: [number, number], i: number, side = 'BUY') =>
  ({
    number: i,
    price,
    qty,
    side: side === 'BUY' ? OrderSideEnum.buy : OrderSideEnum.sell,
    newClientOrderId: `D-RO-new-${i}`,
    type: TypeOrderEnum.dealRegular,
    dealId: DEAL_ID,
  }) as any

let Helper: any

const buildBot = (opts: { resting: any[]; ladder: any[] }) => {
  const placed: any[] = []
  const cancelled: any[] = []
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'USD' },
      settings: {},
      lastPrice: 2663.5,
      levels: { all: 9, complete: 3 },
    },
    initialOrders: opts.ladder,
    currentOrders: opts.ladder,
    previousOrders: [],
  }
  class TestBot extends (Helper as any) {
    placed = placed
    cancelled = cancelled
    botId = BOT_ID
    loadingComplete = true
    serviceRestart = true
    secondRestart = true
    blockCheck = false
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'coinbase',
      flags: [],
      paperContext: false,
    }
    orders = new Map<string, any>(opts.resting.map((r) => [r.clientOrderId, r]))
    shouldProceed() {
      return true
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const statuses = status ? [status].flat() : undefined
      return [...this.orders.values()].filter(
        (o) =>
          (!statuses || statuses.includes(o.status)) &&
          (!dealId || o.dealId === dealId),
      )
    }
    async getAggregatedSettings() {
      return {}
    }
    async isDealForTPLevelCheck() {
      return false
    }
    isOrderQuarantined() {
      return false
    }
    clearOrderStrikes() {}
    async getOrderForReconcile(o: any) {
      return { status: StatusEnum.ok, data: { ...o } }
    }
    async mergeCommonOrderWithOrder(_d: any, o: any) {
      return o
    }
    async placeOrders(_b: string, _s: string, _d: string, orders: any) {
      placed.push(...orders.new)
      cancelled.push(...orders.cancel)
    }
    async cancelOrderOnExchange(o: any) {
      cancelled.push(o)
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

describe('a DCA reload whose rebuilt ladder moved by a tick (spec 106)', () => {
  before(function () {
    // One ts-node compile of the DCA mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§1.1.1 places nothing next to a resting safety order', async () => {
    const bot = buildBot({
      resting: RESTING.map((r, i) => restingOrder(r, i)),
      ladder: REBUILT.map((g, i) => ladderGrid(g, i)),
    })
    await bot.checkOrders(BOT_ID)
    expect(
      bot.placed.map((g: any) => g.price),
      'nothing placed on top of a resting level',
    ).to.deep.equal([])
    expect(bot.cancelled).to.deep.equal([])
  })

  it('§1.1.1 a short deal keeps its resting sell ladder too', async () => {
    const bot = buildBot({
      resting: RESTING.map((r, i) => restingOrder(r, i, 'SELL')),
      ladder: REBUILT.map((g, i) => ladderGrid(g, i, 'SELL')),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed.map((g: any) => g.price)).to.deep.equal([])
  })

  it('§1.1.1 pairs per side: a resting order of the other side pairs nothing', async () => {
    const bot = buildBot({
      // The one shifted level rests on the wrong side.
      resting: RESTING.map((r, i) =>
        restingOrder(r, i, i === 5 ? flip('BUY') : 'BUY'),
      ),
      ladder: REBUILT.filter((_g, i) => i !== 2 && i !== 3 && i !== 4).map(
        (g, i) => ladderGrid(g, i),
      ),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed.map((g: any) => g.price)).to.deep.equal([2019.1])
  })

  it('§1.1.2 a missing level is still placed (counts differ, no pairing)', async () => {
    const bot = buildBot({
      // 2167's order is gone from the venue.
      resting: RESTING.filter(([p]) => p !== '2167').map((r, i) =>
        restingOrder(r, i),
      ),
      ladder: REBUILT.map((g, i) => ladderGrid(g, i)),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed.map((g: any) => g.price)).to.deep.equal([
      2407.9, 2295.9, 2167.2, 2019.1,
    ])
  })

  it('§1.1.3 a ladder that matches by price is left untouched', async () => {
    const bot = buildBot({
      resting: RESTING.map((r, i) => restingOrder(r, i)),
      ladder: RESTING.map(([p, q], i) => ladderGrid([+p, +q], i)),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed).to.deep.equal([])
    expect(bot.cancelled).to.deep.equal([])
  })
})
