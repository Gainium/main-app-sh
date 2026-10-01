process.env.NODE_ENV = 'testing'

/**
 * Tests for spec `122`. An add-funds fill that lands in the same tick as a
 * safety-order fill must still count toward the deal's cost.
 *
 * Production shape: a part-filled LIMIT base order rested its remainder as a
 * LIMIT add-funds order (spec `111`). The remainder and two safety orders
 * filled in the same millisecond. The deal's balances came out holding the
 * remainder's coins but not what was paid for them, so cost, size and
 * unrealized P&L left the remainder out.
 *
 * Drives the REAL `updateDeal`, `saveDeal`, `updateUsage` and
 * `updateDealBalances` over the mixin with a minimal base class (harness shape
 * from `trailingTpRebase.harness.spec.ts`). Only the I/O-shaped collaborators
 * are stubbed, and each of them yields, so the interleaving of the per-deal
 * locks is the real one.
 *
 * Fixture ids are synthetic: this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'

const DEAL_ID = '000000000000000000000d22'
const BOT_ID = '000000000000000000000b22'
const SYMBOL = 'ABC-USD'
const ENTRY_ID = '00000000-0000-4000-8000-000000000122'

/** The yield every stubbed I/O collaborator takes. Set per test. */
let io: () => Promise<unknown> = () => Promise.resolve()
const micro = () => Promise.resolve()
const macro = () => new Promise((r) => setImmediate(r))

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u22'
  isLong = true
  futures = false
  coinm = false
  combo = false
  botType = 'dca'
  data: any = {
    settings: {},
    status: 'open',
    exchange: ExchangeEnum.paperKraken,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const row = (
  clientOrderId: string,
  typeOrder: string,
  qty: string,
  price: string,
  over: Record<string, unknown> = {},
) => ({
  clientOrderId,
  dealId: DEAL_ID,
  botId: BOT_ID,
  symbol: SYMBOL,
  side: 'BUY',
  type: 'LIMIT',
  typeOrder,
  price,
  origPrice: price,
  origQty: qty,
  executedQty: qty,
  status: 'FILLED',
  updateTime: 1000,
  ...over,
})

/** Base order: 100 of 311.64024 filled before it was settled (spec `111`). */
const BASE = row('D-BO-122', 'dealStart', '311.64024', '0.06938', {
  status: 'CANCELED',
  executedQty: '100',
})
/** The rested remainder, and two safety orders, all filled in one tick. */
const REMAINDER = row('D-ROA-122', 'dealRegular', '211.64024', '0.06938', {
  addFundsId: ENTRY_ID,
})
const SO_1 = row('D-RO-122a', 'dealRegular', '111.19282', '0.06799')
const SO_2 = row('D-RO-122b', 'dealRegular', '104.81875', '0.06869')

const LADDER = [
  [104.81875, 0.06869],
  [111.19282, 0.06799],
  [117.94948, 0.0673],
  [125.14865, 0.0666],
]
const initialOrders = LADDER.map(([qty, price]) => ({
  type: 'dealRegular',
  side: 'BUY',
  qty,
  price,
}))
const ladderQuote = initialOrders.reduce((a, o) => a + o.qty * o.price, 0)
const spent = (orders: any[]) =>
  orders.reduce((a, o) => a + +o.executedQty * +o.price, 0)
const held = (orders: any[]) => orders.reduce((a, o) => a + +o.executedQty, 0)

/**
 * The deal as `addDealFunds` leaves it once the remainder rests:
 * `updateDealBalances` counts the pending entry in `initialBalances`.
 */
const makeBot = () => {
  const remainderQuote = 211.64024 * 0.06938
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    symbol: { symbol: SYMBOL, baseAsset: 'ABC', quoteAsset: 'USD' },
    initialBalances: {
      base: 0,
      quote: ladderQuote + spent([BASE]) + remainderQuote,
    },
    currentBalances: { base: 100, quote: ladderQuote + remainderQuote },
    pendingAddFunds: [
      {
        id: ENTRY_ID,
        qty: '211.64024',
        asset: 'base',
        useLimitPrice: true,
        limitPrice: 0.06938,
        type: 'fixed',
        baseRemainder: true,
      },
    ],
    funds: [],
    reduceFunds: [],
    levels: { complete: 1, all: 6 },
    avgPrice: 0.06938,
    displayAvg: 0.06938,
    initialPrice: 0.06938,
    lastPrice: 0.06938,
    profit: { total: 0, totalUsd: 0 },
    settings: { avgPrice: 0.06938 },
    usage: {},
    createTime: 1,
  }
  const book: any[] = [BASE]
  class TestBot extends Helper {
    allowedMethods = new Set(['updateDeal'])
    ordersInBetweenUpdates = new Set<string>()
    dealUpdateOrders = new Map<string, Set<string>>()
    orders = new Map([['any', {}]])
    deals = new Map<string, any>([
      [
        DEAL_ID,
        {
          deal,
          initialOrders,
          currentOrders: [],
          previousOrders: [],
          closeBySl: false,
          notCheckSl: false,
        },
      ],
    ])
    dealsDb = { updateData: async () => ({ status: 'OK' }) }
    getDeal(id: string) {
      return this.deals.get(id)
    }
    setDeal(d: any) {
      this.deals.set(`${d.deal._id}`, d)
    }
    setDealToRedis() {}
    getOrdersByStatusAndDealId({ status }: any = {}) {
      const statuses: string[] | null = status ? [].concat(status) : null
      return book.filter((o) => !statuses || statuses.includes(o.status))
    }
    startMethod() {
      return 'm'
    }
    endMethod() {}
    async computeObservedFeeLedger() {
      await io()
      return { feeByAsset: [], feePaid: { base: 0, quote: 0 } }
    }
    async createCurrentDealOrders() {
      await io()
      return []
    }
    async createInitialDealOrders() {
      return initialOrders
    }
    async aggregateBreakpoint() {
      return []
    }
    async checkDealSlMethods() {
      await io()
    }
    checkDealsPriceExtremum() {}
    carryStopLossLatches() {}
    async placeOrders() {}
    findDiff() {
      return []
    }
    async updateAssets(id: string, d?: any) {
      const f = d ?? this.getDeal(id)
      await io()
      this.saveDeal(f, { assets: {} })
    }
    updateDealLastPrices() {}
    sendSafetyOrderFilledAlert() {}
    async getLeverageMultipler() {
      await io()
      return 1
    }
    async profitBase() {
      return false
    }
    async getUsdRate() {
      return 1
    }
    async getAggregatedSettings() {
      return { useDca: true, ordersCount: LADDER.length }
    }
    dcaLadderSize() {
      return LADDER.length
    }
    sendEightyAlert() {}
    async sendHundredAlert() {}
    calculateBotUsage() {}
    async getUserFee() {
      return { maker: 0 }
    }
    shouldProceed() {
      return true
    }
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  const bot = new TestBot() as any
  /** What `processFilledOrder` does: book the row, then queue the update. */
  bot.fill = (o: any) => {
    book.push(o)
    bot.ordersInBetweenUpdates.add(o.clientOrderId)
    return bot.updateDeal(BOT_ID, { ...o })
  }
  bot.live = () => bot.getDeal(DEAL_ID).deal
  return { bot, book }
}

const settle = async () => {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

/** §1.1: what the deal must show once every fill has been applied. */
const expectMatchesFills = (bot: any, book: any[]) => {
  const deal = bot.live()
  const filled = book.filter((o) => +o.executedQty > 0)
  expect(deal.currentBalances.base, 'coins held').to.be.closeTo(
    held(filled),
    1e-9,
  )
  expect(
    deal.initialBalances.quote - deal.currentBalances.quote,
    'quote spent',
  ).to.be.closeTo(spent(filled), 1e-9)
  expect(deal.usage.current.quote, 'usage').to.be.closeTo(spent(filled), 1e-9)
  expect(deal.cost, 'cost').to.be.closeTo(spent(filled), 1e-9)
}

describe('spec 122: an add-funds fill in the same tick as a safety order', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§2.1 control: one fill at a time already books every fill', async () => {
    io = macro
    const { bot, book } = makeBot()
    for (const o of [REMAINDER, SO_1, SO_2]) {
      await bot.fill(o)
      await settle()
    }
    expectMatchesFills(bot, book)
  })

  it('§1.1.1 remainder and a safety order in one tick: cost includes the remainder', async () => {
    // The production order: the remainder and one safety order arrive
    // together, the second safety order on the next tick.
    io = macro
    const { bot, book } = makeBot()
    bot.fill(REMAINDER)
    bot.fill(SO_1)
    await new Promise((r) => setTimeout(r, 20))
    bot.fill(SO_2)
    await settle()
    expectMatchesFills(bot, book)
  })

  it('§1.1.2 three fills back to back: no safety order is counted twice', async () => {
    io = micro
    const { bot, book } = makeBot()
    bot.fill(REMAINDER)
    bot.fill(SO_1)
    bot.fill(SO_2)
    await settle()
    expectMatchesFills(bot, book)
  })

  it('§1.1.3 the take profit still sizes off the whole position', async () => {
    io = macro
    const { bot, book } = makeBot()
    bot.fill(REMAINDER)
    bot.fill(SO_1)
    bot.fill(SO_2)
    await settle()
    expect(bot.live().currentBalances.base).to.be.closeTo(
      100 + 211.64024 + 111.19282 + 104.81875,
      1e-9,
    )
    expect(book).to.have.length(4)
  })
})
