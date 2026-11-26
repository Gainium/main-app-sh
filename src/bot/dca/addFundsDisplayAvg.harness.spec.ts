process.env.NODE_ENV = 'testing'

/**
 * An add-funds fill must refresh the deal's break-even average
 * (`displayAvg`) from the position that includes it.
 *
 * `updateDeal`'s add-funds branch used to call `getAvgPrice` before it added
 * the fill to the deal's balances. `avg` folds the order rows, so it was
 * right; `display` reads the balances, so it kept the previous fills' figure
 * and the deal list showed the base order's break-even after the addition.
 *
 * Drives the REAL `updateDeal`, `getAvgPrice` and `updateDealBalances` over
 * the mixin with a minimal base class (harness shape from
 * `addFundsFillLostUpdate.harness.spec.ts`). Fixture ids are synthetic: this
 * file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'

const DEAL_ID = '000000000000000000000d91'
const BOT_ID = '000000000000000000000b91'
const SYMBOL = 'ABC-USD'
const ENTRY_ID = '00000000-0000-4000-8000-000000000291'
const FEE = 0.0005

let io: () => Promise<unknown> = () => Promise.resolve()
const micro = () => Promise.resolve()

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

/** A small base order, then a much larger addition at a higher price. */
const BASE = row('D-BO-291', 'dealStart', '0.5', '100')
const ADDITION = row('D-ROA-291', 'dealRegular', '5', '110', {
  type: 'MARKET',
  addFundsId: ENTRY_ID,
})
const initialOrders: any[] = []

/** The deal as `addDealFunds` leaves it once the addition is pending. */
const makeBot = () => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    symbol: { symbol: SYMBOL, baseAsset: 'ABC', quoteAsset: 'USD' },
    initialBalances: { base: 0, quote: 50 + 550 },
    currentBalances: { base: 0.5, quote: 550 },
    pendingAddFunds: [
      { id: ENTRY_ID, qty: '550', asset: 'quote', type: 'fixed' },
    ],
    funds: [],
    reduceFunds: [],
    levels: { complete: 1, all: 1 },
    avgPrice: 100,
    displayAvg: 100 / (1 - FEE),
    initialPrice: 100,
    lastPrice: 100,
    profit: { total: 0, totalUsd: 0 },
    settings: { avgPrice: 100 },
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
      return { useDca: false, ordersCount: 0 }
    }
    dcaLadderSize() {
      return 0
    }
    sendEightyAlert() {}
    async sendHundredAlert() {}
    calculateBotUsage() {}
    async getUserFee() {
      return { maker: FEE }
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

describe('an add-funds fill refreshes the break-even average', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('displayAvg follows the whole position, not the fills before the addition', async () => {
    io = micro
    const { bot } = makeBot()
    await bot.fill(ADDITION)
    await settle()
    const deal = bot.live()
    const avg = (0.5 * 100 + 5 * 110) / 5.5
    expect(deal.currentBalances.base, 'coins held').to.be.closeTo(5.5, 1e-9)
    expect(deal.avgPrice, 'avgPrice').to.be.closeTo(avg, 1e-9)
    expect(deal.displayAvg, 'displayAvg').to.be.closeTo(avg / (1 - FEE), 1e-9)
  })

  it('on start, a deal holding a stale value from an earlier addition is corrected', async () => {
    io = micro
    const { bot, book } = makeBot()
    book.push(ADDITION)
    const deal = bot.live()
    // The stored state the old fill path left behind.
    deal.funds = [{ price: 110, qty: 5 }]
    deal.pendingAddFunds = []
    deal.initialBalances = { base: 0, quote: 600 }
    deal.currentBalances = { base: 5.5, quote: 0 }
    deal.displayAvg = 100 / (1 - FEE)
    const avg = (0.5 * 100 + 5 * 110) / 5.5
    await bot.refreshAddFundsDisplayAvg(bot.getDeal(DEAL_ID))
    expect(deal.displayAvg).to.be.closeTo(avg / (1 - FEE), 1e-9)
    // Idempotent: a second pass leaves it alone.
    const saved: any[] = []
    bot.saveDeal = (_d: any, set: any) => saved.push(set)
    await bot.refreshAddFundsDisplayAvg(bot.getDeal(DEAL_ID))
    expect(saved).to.deep.equal([])
  })

  it('on start, a deal with no addition is not touched', async () => {
    io = micro
    const { bot } = makeBot()
    const deal = bot.live()
    deal.displayAvg = 123
    await bot.refreshAddFundsDisplayAvg(bot.getDeal(DEAL_ID))
    expect(deal.displayAvg).to.equal(123)
  })
})
