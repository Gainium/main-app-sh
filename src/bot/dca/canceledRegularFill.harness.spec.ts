process.env.NODE_ENV = 'testing'

/**
 * Spec `216.a-venue-cancelled-part-filled-safety-or-add-funds-order-is-never-booked`.
 *
 * Drives the REAL `dcaHelper` — `processCanceledOrder`, `updateDeal`,
 * `getAvgPrice`, `updateDealBalances`, `updateUsage` — over the recorded
 * production state of a Hyperliquid spot VIRT-USDC long deal (read-only,
 * 2026-11-01):
 *
 *   4 entry rows FILLED                                   251.1 base / 188.974042 USDC
 *   add-funds order, limit 0.5836, origQty 325.6, ended by the venue
 *                CANCELED with 317.1 executed (185.05956 USDC)
 *
 * Afterwards the deal still read funds [], the add-funds entry pending,
 * size 251.1 — the 317.1 bought were in no deal.
 *
 * `createDCABotHelper` is a mixin factory; the helper is built on a minimal
 * base class. No stack, DB, Redis or exchange connection is touched.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'
import {
  isDatedCanceledRegularFill,
  shouldBookCanceledRegularFill,
} from './canceledRegularFill'

const settings: any = {
  useTp: true,
  useDca: true,
  ordersCount: 6,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  multiTp: [],
  tpPerc: '1',
  slPerc: '3',
  baseOrderSize: '10',
  orderSizeType: 'quote',
  indicators: [],
}

const DEAL_ID = 'deal-virt-usdc'
const ADD_ID = 'add-funds-1'
const ADD_ORDER = '0xadd-funds-partial'
const SO_ORDER = '0xso-partial'

const ENTRIES: [string, string, number, string][] = [
  ['0xentry-bo', 'dealStart', 12.1, '0.82862'],
  ['0xentry-so1', 'dealRegular', 24.5, '0.81619'],
  ['0xentry-so2', 'dealRegular', 51.6, '0.77456'],
  ['0xentry-so3', 'dealRegular', 162.9, '0.73041'],
]
const ENTRY_ROWS = ENTRIES.map(([id, typeOrder, qty, price], i) => ({
  clientOrderId: id,
  orderId: `${100 + i}`,
  dealId: DEAL_ID,
  symbol: 'VIRT-USDC',
  typeOrder,
  status: 'FILLED',
  origQty: `${qty}`,
  executedQty: `${qty}`,
  price,
  origPrice: price,
  side: 'BUY',
  updateTime: 1791303388612 + i,
}))
const ENTRY_BASE = 251.1
const ENTRY_QUOTE = 188.974042
const ADD_EXECUTED = 317.1
const ADD_QUOTE = ADD_EXECUTED * 0.5836 // 185.05956

const canceled = (over: Record<string, unknown> = {}): any => ({
  clientOrderId: ADD_ORDER,
  orderId: '9001',
  symbol: 'VIRT-USDC',
  dealId: DEAL_ID,
  botId: 'bot',
  typeOrder: 'dealRegular',
  status: 'CANCELED',
  type: 'LIMIT',
  origQty: '325.6',
  executedQty: `${ADD_EXECUTED}`,
  cummulativeQuoteQty: '185.05955999999998',
  price: '0.5836',
  origPrice: '0.5836',
  side: 'BUY',
  updateTime: 1790000000000,
  addFundsId: ADD_ID,
  ...over,
})

const PENDING = {
  qty: '190',
  useLimitPrice: true,
  limitPrice: '0.5836',
  asset: 'quote',
  id: ADD_ID,
  type: 'fixed',
}

/** The deal as production held it when the cancel arrived. */
const freshDeal = (status = 'open'): any => ({
  _id: DEAL_ID,
  botId: 'bot',
  symbol: { symbol: 'VIRT-USDC', baseAsset: 'VIRT', quoteAsset: 'USDC' },
  status,
  size: ENTRY_BASE,
  tpHistory: [],
  reduceFunds: [],
  pendingReduceFunds: [],
  pendingAddFunds: [{ ...PENDING }],
  funds: [],
  flags: [],
  levels: { all: 4, complete: 4 },
  profit: { total: 0, totalUsd: 0 },
  commission: 0,
  lastPrice: 0.5836,
  avgPrice: ENTRY_QUOTE / ENTRY_BASE,
  initialPrice: 0.82862,
  settings: { avgPrice: ENTRY_QUOTE / ENTRY_BASE },
  currentBalances: { base: ENTRY_BASE, quote: 190 },
  initialBalances: { base: 0, quote: ENTRY_QUOTE + 190 },
})

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = true
  futures = false
  coinm = false
  combo = false
  kucoinSpot = false
  zeroFee = true
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  orders = []
  data: any = {
    settings,
    exchange: ExchangeEnum.hyperliquid,
    flags: [],
    paperContext: false,
    dealsReduceForBot: [],
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (deal: any, orders: any[], own: string[] = []) => {
  class TestBot extends Helper {
    public logs: string[] = []
    public placed: any[] = []
    public sold: any[] = []
    full = { deal, initialOrders: [], currentOrders: [], previousOrders: [] }

    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    getOrderFromMap(id: string) {
      return orders.find((o) => o.clientOrderId === id)
    }
    findBaseOrderByDeal() {
      return orders.find((o) => o.typeOrder === 'dealStart')
    }
    isOwnCancel(id: string) {
      return own.includes(id)
    }
    async getAggregatedSettings() {
      return settings
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    async getLeverageMultipler() {
      return 1
    }
    async profitBase() {
      return false
    }
    async getCommDeal() {
      return 0
    }
    async computeObservedFeeLedger() {
      return undefined
    }
    async aggregateBreakpoint() {
      return []
    }
    async createInitialDealOrders() {
      return []
    }
    async createCurrentDealOrders() {
      return []
    }
    findDiff() {
      return { new: [], cancel: [] }
    }
    placeOrders(...a: any[]) {
      this.placed.push(a)
    }
    async sellRemainder(...a: any[]) {
      this.sold.push(a)
    }
    // `updateUsage` writes `size` only through the save patch.
    saveDeal(_d: any, patch: any) {
      if (patch && 'size' in patch) {
        deal.size = patch.size
      }
      return Promise.resolve()
    }
    async checkDealSlMethods() {}
    checkDealsPriceExtremum() {}
    carryStopLossLatches() {}
    calculateBotUsage() {}
    sendEightyAlert() {}
    async sendHundredAlert() {}
    sendSafetyOrderFilledAlert() {}
    updateDealLastPrices() {}
    updateAssets() {}
    armNextPositionEntry() {}
    armCanceledTpRestore() {}
    updateData() {}
    emit() {}
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
  return new TestBot()
}

/** Let the `saveDeal(...).then(updateUsage)` chain run. */
const settle = async (bot: any) => {
  await new Promise((r) => setTimeout(r, 20))
  await bot.updateUsage(DEAL_ID)
}

const close = (a: number, b: number) => expect(a).to.be.closeTo(b, 1e-6)

describe('part-filled dealRegular cancelled by the venue (spec 216)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('fixture: the entries add up to what the deal booked', () => {
    close(
      ENTRY_ROWS.reduce((a, o) => a + +o.executedQty, 0),
      ENTRY_BASE,
    )
    close(
      ENTRY_ROWS.reduce((a, o) => a + +o.executedQty * +o.price, 0),
      ENTRY_QUOTE,
    )
  })

  it('§1.1.1 an add-funds order cancelled part filled is booked into the deal', async () => {
    const deal = freshDeal()
    const order = canceled()
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    await settle(bot)
    expect(deal.funds).to.deep.equal([{ price: 0.5836, qty: ADD_EXECUTED }])
    // Settled: a reload must not re-send it (spec 110).
    expect(deal.pendingAddFunds).to.deep.equal([])
    close(deal.currentBalances.base, ENTRY_BASE + ADD_EXECUTED)
    // §1.2 the average, and the size derived from it, cover every coin bought.
    close(
      deal.avgPrice,
      (ENTRY_QUOTE + ADD_QUOTE) / (ENTRY_BASE + ADD_EXECUTED),
    )
    close(deal.size, ENTRY_BASE + ADD_EXECUTED)
    expect(bot.placed.length).to.equal(1)
  })

  it('§1.1 booked once: a second cancel report, or a late fill, books nothing more', async () => {
    const deal = freshDeal()
    const order = canceled()
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    await bot.processCanceledOrder({ ...order }, order.updateTime, false)
    await settle(bot)
    expect(deal.funds.length).to.equal(1)
    close(deal.size, ENTRY_BASE + ADD_EXECUTED)
  })

  it('§1.1.2 a safety order cancelled part filled is booked like a filled one', async () => {
    const deal = freshDeal()
    deal.pendingAddFunds = []
    deal.initialBalances.quote = ENTRY_QUOTE
    deal.currentBalances.quote = 0
    const order = canceled({
      clientOrderId: SO_ORDER,
      addFundsId: undefined,
      origQty: '300',
      executedQty: '120',
    })
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    await settle(bot)
    expect(deal.funds).to.deep.equal([])
    close(deal.currentBalances.base, ENTRY_BASE + 120)
    close(deal.currentBalances.quote, -120 * 0.5836)
    close(deal.avgPrice, (ENTRY_QUOTE + 120 * 0.5836) / (ENTRY_BASE + 120))
    close(deal.size, ENTRY_BASE + 120)
    // The partial does not count as a completed level.
    expect(deal.levels.complete).to.equal(4)
  })

  describe('§1.3 unchanged', () => {
    const untouched = (deal: any, bot: any) => {
      expect(deal.funds).to.deep.equal([])
      expect(deal.pendingAddFunds.map((p: any) => p.id)).to.deep.equal([ADD_ID])
      close(deal.currentBalances.base, ENTRY_BASE)
      expect(bot.placed.length).to.equal(0)
      expect(bot.sold.length).to.equal(0)
    }

    it('§1.3.1 nothing executed', async () => {
      const deal = freshDeal()
      const order = canceled({ executedQty: '0' })
      const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
      await bot.processCanceledOrder(order, order.updateTime, false)
      untouched(deal, bot)
    })

    it('§1.3.1 everything executed', async () => {
      const deal = freshDeal()
      const order = canceled({ executedQty: '325.6' })
      const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
      await bot.processCanceledOrder(order, order.updateTime, false)
      untouched(deal, bot)
    })

    it('§1.3.2 a quantity with no usable updateTime', async () => {
      const deal = freshDeal()
      const order = canceled({ updateTime: -1 })
      const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
      await bot.processCanceledOrder(order, order.updateTime, false)
      untouched(deal, bot)
    })

    it('§1.3.3 the bot’s own cancel', async () => {
      const deal = freshDeal()
      const order = canceled()
      const bot: any = buildBot(deal, [...ENTRY_ROWS, order], [ADD_ORDER])
      await bot.processCanceledOrder(order, order.updateTime, false)
      untouched(deal, bot)
    })

    it('§1.3.4 already processed as a fill', async () => {
      const deal = freshDeal()
      const order = canceled()
      const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
      bot.processedFilled = new Map([[DEAL_ID, new Set([ADD_ORDER])]])
      await bot.processCanceledOrder(order, order.updateTime, false)
      untouched(deal, bot)
    })

    it('§1.3.5 a deal that is not open is not sold into', async () => {
      const deal = freshDeal('closed')
      const order = canceled()
      const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
      await bot.processCanceledOrder(order, order.updateTime, false)
      untouched(deal, bot)
    })
  })

  describe('predicates', () => {
    it('§1.2 the average admits only dated, venue-backed partial dealRegular cancels', () => {
      expect(isDatedCanceledRegularFill(canceled())).to.equal(true)
      expect(isDatedCanceledRegularFill(canceled({ updateTime: -1 }))).to.equal(
        false,
      )
      expect(isDatedCanceledRegularFill(canceled({ orderId: '-1' }))).to.equal(
        false,
      )
      expect(
        isDatedCanceledRegularFill(canceled({ executedQty: '0' })),
      ).to.equal(false)
      expect(
        isDatedCanceledRegularFill(canceled({ typeOrder: 'dealTP' })),
      ).to.equal(false)
      expect(
        isDatedCanceledRegularFill(canceled({ status: 'FILLED' })),
      ).to.equal(false)
    })

    it('§1.1 books only an open deal’s unattributed partial', () => {
      const base = {
        order: canceled(),
        dealStatus: 'open',
        ownCancel: false,
        alreadyProcessed: false,
      }
      expect(shouldBookCanceledRegularFill(base)).to.equal(true)
      expect(
        shouldBookCanceledRegularFill({ ...base, dealStatus: 'closed' }),
      ).to.equal(false)
      expect(
        shouldBookCanceledRegularFill({ ...base, ownCancel: true }),
      ).to.equal(false)
      expect(
        shouldBookCanceledRegularFill({ ...base, alreadyProcessed: true }),
      ).to.equal(false)
      expect(
        shouldBookCanceledRegularFill({
          ...base,
          order: canceled({ executedQty: '325.6' }),
        }),
      ).to.equal(false)
    })
  })
})
