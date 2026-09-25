process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `105.a-combo-reload-duplicates-a-safety-order-whose-ladder-price-moved`.
 *
 * Drives the REAL restart branch of `checkOrders` (dcaHelper), and through it
 * the REAL Combo `getDiffForCheckOrders` → `findDiffCombo` → `findDiff`. The
 * exchange lookups, `placeOrders` and the cancel are recorded, not run.
 *
 * The prices are the production ones: a deal whose base filled at 102.35 and
 * whose safety orders rest at 98.26 / 94.17 / 90.08 / 85.99 under the old
 * per-level rounding. After a reload, the same deal's rebuilt ladder is
 * 98.26 / 94.16 / 90.07 / 85.97.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, StatusEnum, TypeOrderEnum } from '../../types'

const DEAL_ID = '000000000000000000000d05'
const BOT_ID = '000000000000000000000b05'
const SYMBOL = 'SOL-EUR'

/** Resting ladder, placed under the old rounding: level → price. */
const RESTING: [number, string, string][] = [
  [2, '98.26', '35.656'],
  [3, '94.17', '37.202'],
  [4, '90.08', '38.891'],
  [5, '85.99', '40.741'],
]
/** The same deal's ladder as a reload rebuilds it today. */
const REBUILT: [number, number, number][] = [
  [2, 98.26, 35.656],
  [3, 94.16, 37.206],
  [4, 90.07, 38.895],
  [5, 85.97, 40.753],
]

const restingOrder = ([level, price, qty]: [number, string, string]) =>
  ({
    symbol: SYMBOL,
    clientOrderId: `CMB-RO-00000000000${level}`,
    orderId: `${level}`,
    botId: BOT_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    side: 'BUY',
    price,
    origPrice: price,
    origQty: qty,
    executedQty: '0',
    status: 'NEW',
    dcaLevel: level,
    updateTime: 1790171253829,
  }) as any

const ladderGrid = ([level, price, qty]: [number, number, number]) =>
  ({
    number: level - 1,
    price,
    qty,
    side: OrderSideEnum.buy,
    newClientOrderId: `CMB-RO-new-${level}`,
    type: TypeOrderEnum.dealRegular,
    dealId: DEAL_ID,
    dcaLevel: level,
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
      symbol: { symbol: SYMBOL, baseAsset: 'SOL', quoteAsset: 'EUR' },
      settings: {},
      lastPrice: 102.35,
      levels: { all: 5, complete: 1 },
    },
    initialOrders: opts.ladder,
    currentOrders: opts.ladder,
    previousOrders: [],
  }
  class TestBot extends (Helper as any) {
    placed = placed
    cancelled = cancelled
    botId = BOT_ID
    botType = 'combo'
    combo = true
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
    getMinigridByDealId() {
      return []
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

/** Resting safety orders per level once the check has run. */
const restingPerLevel = (bot: any) => {
  const perLevel = new Map<number, number>()
  const add = (level: number) =>
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1)
  for (const o of bot.orders.values()) {
    if (o.status === 'NEW' && o.typeOrder === TypeOrderEnum.dealRegular) {
      add(o.dcaLevel)
    }
  }
  for (const g of bot.placed) {
    if (g.type === TypeOrderEnum.dealRegular) add(g.dcaLevel)
  }
  for (const c of bot.cancelled) {
    if (c.dcaLevel) perLevel.set(c.dcaLevel, perLevel.get(c.dcaLevel)! - 1)
  }
  return perLevel
}

describe('a Combo reload whose rebuilt ladder moved by a tick (spec 105)', () => {
  before(function () {
    // One ts-node compile of the combo mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  it('§1.1.1 leaves exactly one resting safety order per level', async () => {
    const bot = buildBot({
      resting: RESTING.map(restingOrder),
      ladder: REBUILT.map(ladderGrid),
    })
    await bot.checkOrders(BOT_ID)
    expect(
      bot.placed.map((g: any) => g.price),
      'nothing placed on top of a resting level',
    ).to.deep.equal([])
    const perLevel = restingPerLevel(bot)
    for (const [level] of REBUILT) {
      expect(perLevel.get(level), `level ${level}`).to.equal(1)
    }
  })

  it('§1.1.2 still places a level that has no resting order', async () => {
    const bot = buildBot({
      // Level 4's order is gone from the venue.
      resting: RESTING.filter(([l]) => l !== 4).map(restingOrder),
      ladder: REBUILT.map(ladderGrid),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed.map((g: any) => [g.dcaLevel, g.price])).to.deep.equal([
      [4, 90.07],
    ])
    const perLevel = restingPerLevel(bot)
    for (const [level] of REBUILT) {
      expect(perLevel.get(level), `level ${level}`).to.equal(1)
    }
  })

  it('§1.1.3 a ladder that matches by price is left untouched', async () => {
    const bot = buildBot({
      resting: RESTING.map(restingOrder),
      ladder: RESTING.map(([l, p, q]) => ladderGrid([l, +p, +q])),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed).to.deep.equal([])
    expect(bot.cancelled).to.deep.equal([])
  })

  it('§4.2 a resting order without a level keeps the price match', async () => {
    const bot = buildBot({
      resting: RESTING.filter(([l]) => l === 3).map((r) => ({
        ...restingOrder(r),
        dcaLevel: undefined,
      })),
      ladder: REBUILT.filter(([l]) => l === 3).map(ladderGrid),
    })
    await bot.checkOrders(BOT_ID)
    expect(bot.placed.map((g: any) => g.price)).to.deep.equal([94.16])
  })
})
