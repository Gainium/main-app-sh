process.env.NODE_ENV = 'testing'

/**
 * Spec `159.canceled-reduce-funds-stays-pending` — a reduce-funds order the
 * venue cancels after a partial fill is settled, and the close is sized for
 * everything the deal still holds.
 *
 * Drives the REAL `dcaHelper` — `processCanceledOrder`, `updateDeal`,
 * `getTPOrder`, `getPendingReduceFunds`, `cancelTerminalDealOrder` — over the
 * recorded production state of a Coinbase BLAST-USDC deal (read-only,
 * 2026-10-13):
 *
 *   36 entry rows (dealStart + dealRegular) FILLED     155,913,933 base
 *   D-TPR-MH5U…  reduce TP FILLED                        9,868,421
 *   D-TPR-MD42…  reduce TP origQty 69,444,444 (1000 USDC @ 0.0000144), ended
 *                by the venue PARTIALLY_FILLED 21,651,044 then CANCELED
 *
 * Afterwards the deal still listed that order in `pendingReduceFunds`, so every
 * later close was sized 146,045,512 − 21,651,044 − 69,444,444 = 54,950,024 —
 * the order's partial AND its whole pending quantity were both subtracted.
 * The account trades at zero fee, so the close is exactly what the deal holds.
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

const settings: any = {
  useTp: true,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  multiTp: [],
  tpPerc: '1',
  slPerc: '3',
  baseOrderSize: '100',
  orderSizeType: 'quote',
  indicators: [],
}

const EXCHANGE_INFO: any = {
  baseAsset: { minAmount: 1, step: 1, asset: 'BLAST' },
  quoteAsset: { minAmount: 1, step: 0.00000001, asset: 'USDC' },
  priceAssetPrecision: 8,
}

const DEAL_ID = 'deal-blast-usdc'
const REDUCE_ID = 'reduce-funds-2'
const REDUCE_TP = 'D-TPR-MD42Nuzkke3FOJ3hHxMH3vAneimZB'

const BO_FILL = 3885003
const SAFETY_FILLS = [
  1295133, 1373365, 1457048, 1545999, 1640561, 1740384, 1847250, 1960909,
  2081812, 2209488, 2346291, 2491885, 2646863, 2810588, 2986186, 3173202,
  3372419, 3582975, 3809038, 4049993, 4306878, 4578524, 4870515, 5182019,
  5511564, 5866127, 6244662, 6648897, 7537873, 7076820, 8030636, 8557446,
  9115540, 9717788, 10362252,
]
const GROSS = 155913933
const FIRST_REDUCE = 9868421
const PARTIAL = 21651044
/** Held before the cancelled reduce: GROSS − FIRST_REDUCE. */
const HELD_BEFORE = 146045512
/** What the deal holds once the venue cancels it. */
const HELD_AFTER = HELD_BEFORE - PARTIAL // 124,394,468
/** What production sized every close at. */
const PROD_CLOSE = 54950024

const ENTRY_ROWS = [
  {
    clientOrderId: 'D-BO-yMCoYRbhMv89vinvq0L3sbkuyM9bet',
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    status: 'FILLED',
    origQty: `${BO_FILL}`,
    executedQty: `${BO_FILL}`,
    price: '0.00002574',
    side: 'BUY',
    updateTime: 1,
  },
  ...SAFETY_FILLS.map((qty, i) => ({
    clientOrderId: `D-RO-fixture${i}`,
    dealId: DEAL_ID,
    typeOrder: 'dealRegular',
    status: 'FILLED',
    origQty: `${qty}`,
    executedQty: `${qty}`,
    price: '0.00002',
    side: 'BUY',
    updateTime: 10 + i,
  })),
  {
    clientOrderId: 'D-TPR-MH5U6je3F6D4kvDYVaeBAmIJbPVY6',
    dealId: DEAL_ID,
    typeOrder: 'dealTP',
    status: 'FILLED',
    origQty: `${FIRST_REDUCE}`,
    executedQty: `${FIRST_REDUCE}`,
    price: '0.0000152',
    side: 'SELL',
    updateTime: 100,
    reduceFundsId: 'reduce-funds-1',
  },
]

/** The reduce order as the venue ended it. */
const reduceTp = (executedQty: number, status = 'CANCELED') => ({
  clientOrderId: REDUCE_TP,
  orderId: '1',
  symbol: 'BLAST-USDC',
  dealId: DEAL_ID,
  botId: 'bot',
  typeOrder: 'dealTP',
  status,
  type: 'LIMIT',
  origQty: '69444444',
  executedQty: `${executedQty}`,
  price: '0.00001519',
  origPrice: '0.00001519',
  side: 'SELL',
  updateTime: 1791893604933,
  reduceFundsId: REDUCE_ID,
})

const PENDING = {
  qty: '1000',
  useLimitPrice: true,
  limitPrice: '0.0000144',
  asset: 'quote',
  id: REDUCE_ID,
  type: 'fixed',
}

/** The deal as it stood when the cancel arrived. */
const freshDeal = (tpHistory: any[] = []): any => ({
  _id: DEAL_ID,
  botId: 'bot',
  symbol: { symbol: 'BLAST-USDC', baseAsset: 'BLAST', quoteAsset: 'USDC' },
  status: 'open',
  size: HELD_BEFORE,
  tpHistory,
  reduceFunds: [{ price: 0.0000152, qty: FIRST_REDUCE }],
  pendingReduceFunds: [{ ...PENDING }],
  pendingAddFunds: [],
  funds: [],
  flags: [],
  levels: { all: 36, complete: 36 },
  profit: { total: 0, totalUsd: 0 },
  commission: 0,
  lastPrice: 0.00001519,
  avgPrice: 0.000019758145566374753,
  initialPrice: 0.00002574,
  settings: { avgPrice: 0.000019758145566374753 },
  currentBalances: { base: HELD_BEFORE, quote: 0 },
  initialBalances: { base: 0, quote: 2930.57 },
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
  // The account is zero-fee, so the close is rounded to the nearest unit —
  // what makes production's 54,950,024 (54,950,023.56) come out exactly.
  zeroFee = true
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  orders = []
  data: any = {
    settings,
    exchange: ExchangeEnum.coinbase,
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
    public cancelled: string[] = []
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
    isOwnCancel(id: string) {
      return own.includes(id)
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getLatestPrice() {
      return deal.lastPrice
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
    async cancelOrderOnExchange(o: any) {
      this.cancelled.push(o.clientOrderId)
    }
    saveDeal() {
      return Promise.resolve()
    }
    async checkDealSlMethods() {}
    checkDealsPriceExtremum() {}
    carryStopLossLatches() {}
    updateUserProfitStep() {}
    updateUsage() {}
    updateAssets() {}
    updateDealBalances() {}
    sendDealClosedAlert() {}
    armCanceledTpRestore() {}
    updateData() {}
    emit() {}
    getOrderId(prefix: string) {
      return `${prefix}-test`
    }
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

const closeQty = async (bot: any) => {
  const { deal } = bot.full
  const tps = await bot.getTPOrder(
    deal.symbol.symbol,
    deal.lastPrice,
    [],
    deal.avgPrice,
    deal.initialPrice,
    DEAL_ID,
    deal,
  )
  return tps?.[0]?.qty
}

describe('reduce-funds order cancelled by the venue (spec 159)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('fixture: the entry rows add up to the deal’s gross entry', () => {
    expect(BO_FILL + SAFETY_FILLS.reduce((a, b) => a + b, 0)).to.equal(GROSS)
  })

  it('§2.1 reproduces production: the stale entry sizes the close at 54,950,024', async () => {
    // The state production was left in: partial in tpHistory, entry pending.
    const deal = freshDeal([{ qty: PARTIAL, price: 0.00001519, id: REDUCE_TP }])
    const bot = buildBot(deal, [...ENTRY_ROWS, reduceTp(PARTIAL)])
    expect(await closeQty(bot)).to.equal(PROD_CLOSE)
  })

  it('§3.1 a venue cancel after a partial fill: the close covers everything held', async () => {
    const deal = freshDeal([{ qty: PARTIAL, price: 0.00001519, id: REDUCE_TP }])
    const order = reduceTp(PARTIAL)
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    expect(deal.pendingReduceFunds).to.deep.equal([])
    // The executed part is a withdrawal, booked once — not a partial close.
    expect(deal.tpHistory.map((h: any) => h.id)).to.not.include(REDUCE_TP)
    expect(deal.reduceFunds.map((r: any) => r.qty)).to.deep.equal([
      FIRST_REDUCE,
      PARTIAL,
    ])
    expect(deal.size).to.equal(HELD_AFTER)
    expect(await closeQty(bot)).to.equal(HELD_AFTER)
    // The close is re-placed for the new size.
    expect(bot.placed.length).to.equal(1)
  })

  it('§3.1 same answer when no PARTIALLY_FILLED event preceded the cancel', async () => {
    const deal = freshDeal()
    const order = reduceTp(PARTIAL)
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    expect(deal.pendingReduceFunds).to.deep.equal([])
    expect(await closeQty(bot)).to.equal(HELD_AFTER)
  })

  it('§3.2 a venue cancel with nothing filled drops the entry', async () => {
    const deal = freshDeal()
    const order = reduceTp(0)
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    expect(deal.pendingReduceFunds).to.deep.equal([])
    expect(deal.reduceFunds.map((r: any) => r.qty)).to.deep.equal([
      FIRST_REDUCE,
    ])
    expect(await closeQty(bot)).to.equal(HELD_BEFORE)
    expect(bot.placed.length).to.equal(1)
  })

  it('§3.3 unchanged: the bot’s own cancel of a still-pending reduce keeps it for re-send', async () => {
    // A reload / settings update cancels the order and `resendPendingFunds`
    // (spec 110) places it again from the entry — so the entry must stay.
    const deal = freshDeal()
    const order = reduceTp(0)
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order], [REDUCE_TP])
    await bot.processCanceledOrder(order, order.updateTime, false)
    expect(deal.pendingReduceFunds.map((p: any) => p.id)).to.deep.equal([
      REDUCE_ID,
    ])
    expect(bot.placed.length).to.equal(0)
  })

  it('§3.4 a user cancel of a resting reduce order drops its entry', async () => {
    const deal = freshDeal()
    const order = reduceTp(0, 'NEW')
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.cancelTerminalDealOrder('bot', DEAL_ID, REDUCE_TP)
    expect(deal.pendingReduceFunds).to.deep.equal([])
    expect(bot.cancelled).to.deep.equal([REDUCE_TP])
  })

  it('§3.5 a partial-fill event arriving after the settlement is not booked again', async () => {
    const deal = freshDeal()
    const order = reduceTp(PARTIAL)
    const bot: any = buildBot(deal, [...ENTRY_ROWS, order])
    await bot.processCanceledOrder(order, order.updateTime, false)
    await bot.processPartiallyFilledOrder({
      ...order,
      status: 'PARTIALLY_FILLED',
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(deal.tpHistory).to.deep.equal([])
    expect(await closeQty(bot)).to.equal(HELD_AFTER)
  })
})
