process.env.NODE_ENV = 'testing'

/**
 * Spec `222`: a combo SHORT close below the venue minimum carries its unbought
 * base to the bot's next close.
 *
 * Drives the REAL `closeDealById` -> `prepareTpOrder` -> `getTPOrder` (combo
 * branch) and the real carry bookkeeping, over a synthetic Hyperliquid-shaped
 * spot pair: 10 USDC minimum order, 0.01 base step, price 1. The venue send
 * and `closeDeal` are recorded rather than executed, and `settleShortCloseCarry`
 * is called with the order as `closeDeal` calls it once that order fills.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class. No stack, DB, Redis or exchange connection is needed.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { CloseDCATypeEnum, ExchangeEnum } from '../../../types'
import { MathHelper } from '../../utils/math'
import { createRequire } from 'module'

const BOT_ID = '000000000000000000000222'
const PAIR = 'TKN-USDC'
const PRICE = 1
const FEE = { maker: 0.00015, taker: 0.00045 }

const INFO: any = {
  pair: PAIR,
  baseAsset: { minAmount: 0.01, step: 0.01, name: 'TKN' },
  quoteAsset: { minAmount: 10, step: 0.001, name: 'USDC' },
  priceAssetPrecision: 4,
}

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
  baseOrderSize: '10',
  orderSizeType: 'quote',
  indicators: [],
  pair: [PAIR],
  closeDealType: CloseDCATypeEnum.closeByMarket,
}

/**
 * A SHORT deal that was allocated 1000 base, sold `sold` and has `quote` left.
 * Its books leave `sold` to buy back, less the entry-fee estimate `getTPOrder`
 * subtracts (sold x taker).
 */
const makeDeal = (n: number, sold: number, quote: number): any => ({
  _id: `aaaaaaaaaaaaaaaaaaaa${String(n).padStart(4, '0')}`,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: PAIR, baseAsset: 'TKN', quoteAsset: 'USDC' },
  size: sold,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  lastPrice: PRICE,
  avgPrice: PRICE,
  initialPrice: PRICE,
  levels: { all: 1, complete: 1 },
  profit: { total: 0, totalUsd: 0 },
  initialBalances: { base: 1000, quote: 0 },
  currentBalances: { base: 1000 - sold, quote },
})

const sellFor = (deal: any, sold: number): any => ({
  dealId: deal._id,
  typeOrder: 'dealStart',
  type: 'dealStart',
  status: 'FILLED',
  side: 'SELL',
  executedQty: `${sold}`,
  origQty: `${sold}`,
  price: `${PRICE}`,
  cummulativeQuoteQty: `${sold * PRICE}`,
  orderId: '1',
  clientOrderId: `${deal._id}-BO`,
  newClientOrderId: `${deal._id}-BO`,
})

let Helper: any

const makeBot = (
  data: any = {
    exchange: ExchangeEnum.hyperliquid,
    settings,
    flags: [],
    paperContext: false,
  },
) => {
  let current: { deal: any; orders: any[] } | undefined
  const sent: any[] = []
  const closedWithoutOrder: string[] = []
  const writes: any[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public exchange = {}
    public allowToPlaceOrders = new Map()
    public closeDealTimer = new Map()
    public dealTimersMap = new Map()
    public startTimeoutTime = new Map()
    public loadingComplete = true
    public isLong = false
    public futures = false
    public coinm = false
    public hedge = false
    public combo = true
    public kucoinSpot = false
    public zeroFee = false
    public isBitget = false
    public tpAr = false
    public slAr = false
    public botId = BOT_ID
    public botType = 'combo'
    public orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    public data: any = data
    setDeal(deal: any, orders: any[]) {
      current = { deal, orders }
    }
    getDeal(id: string) {
      return current && id === current.deal._id
        ? { deal: current.deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    getOrdersByStatusAndDealId({ status, dealId }: any) {
      const wanted = status ? [status].flat() : undefined
      return (current?.orders ?? []).filter(
        (o: any) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    findBaseOrderByDeal(id: string) {
      return (current?.orders ?? []).find(
        (o: any) => o.dealId === id && o.typeOrder === 'dealStart',
      )
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return INFO
    }
    async getUserFee() {
      return FEE
    }
    async baseAssetPrecision() {
      return 2
    }
    async getLatestPrice() {
      return PRICE
    }
    async getUsdRate() {
      return 1
    }
    async profitBase() {
      return false
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    updateDealBalances() {}
    getOrderId(prefix: string) {
      return `${prefix}-carry`
    }
    async clearDealTimer() {}
    saveDeal() {
      return Promise.resolve()
    }
    async cancelAllOrder() {
      return []
    }
    async closeSupersededByFill() {
      return false
    }
    async sendGridToExchange(grid: any) {
      sent.push(grid)
      return { ...grid, clientOrderId: grid.newClientOrderId, status: 'NEW' }
    }
    async closeDeal(_botId: string, dealId: string, order?: any) {
      if (!order) {
        closedWithoutOrder.push(dealId)
      }
    }
    updateData(d: any) {
      writes.push(d)
    }
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new (TestBot as any)()
  return { bot, sent, closedWithoutOrder, writes }
}

const closeDeal = async (bot: any, deal: any, sold: number) => {
  bot.setDeal(deal, [sellFor(deal, sold)])
  await bot.closeDealById(
    BOT_ID,
    deal._id,
    CloseDCATypeEnum.closeByMarket,
    true,
    false,
    false,
    false,
    '',
    undefined,
    false,
  )
}

/** What `getTPOrder` asks to buy back for the deal's own part. */
const own = (sold: number) => sold - sold * FEE.taker

const carried = (bot: any) =>
  (bot.data.shortCloseCarry ?? []).find((c: any) => c.symbol === PAIR)?.base ??
  0

describe('combo SHORT close carry below the venue minimum (spec 222)', () => {
  before(function () {
    // One ts-node compile of a 33k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('../dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§1.1/§1.2/§1.3 three sub-minimum closes, then one above it buys the accumulated shortfall', async () => {
    const { bot, sent, closedWithoutOrder, writes } = makeBot()
    // Three deals that each owe ~3 base (3 USDC): below the 10 USDC minimum
    // even with what earlier ones carried (3, 6, 9 < 10).
    for (let n = 1; n <= 3; n++) {
      const deal = makeDeal(n, 3, 3.03)
      await closeDeal(bot, deal, 3)
      expect(closedWithoutOrder).to.include(deal._id)
    }
    expect(sent).to.have.length(0)
    expect(carried(bot)).to.be.closeTo(3 * own(3), 1e-9)
    expect(writes.at(-1)).to.have.property('shortCloseCarry')

    // The fourth owes 20 base and holds 35 USDC: the close buys its own 20
    // plus the 9 carried.
    const fourth = makeDeal(4, 20, 35)
    await closeDeal(bot, fourth, 20)
    expect(sent).to.have.length(1)
    expect(sent[0].side).to.equal('BUY')
    expect(sent[0].qty).to.be.closeTo(own(20) + 3 * own(3), 0.01)

    // It fills: the carry is repaid.
    bot.settleShortCloseCarry(
      { deal: fourth },
      { executedQty: `${sent[0].qty}`, origQty: `${sent[0].qty}` },
    )
    expect(carried(bot)).to.equal(0)
    expect(bot.data.shortCloseCarry).to.deep.equal([])
  })

  it('§1.2 small shortfalls that together clear the minimum are bought by the close that crosses it', async () => {
    const { bot, sent, closedWithoutOrder } = makeBot()
    const a = makeDeal(11, 6, 6.06)
    await closeDeal(bot, a, 6)
    expect(closedWithoutOrder).to.deep.equal([a._id])
    // 6 carried + 6 own = 12 >= 10: placed, though its own part alone is under
    // the minimum.
    const b = makeDeal(12, 6, 12.5)
    await closeDeal(bot, b, 6)
    expect(sent).to.have.length(1)
    expect(sent[0].qty).to.be.closeTo(2 * own(6), 0.01)
    expect(sent[0].qty * PRICE).to.be.at.least(INFO.quoteAsset.minAmount)
  })

  it('§1.2 the carry added is limited to what the deal can pay for; the rest stays carried', async () => {
    const { bot, sent } = makeBot()
    await closeDeal(bot, makeDeal(21, 8, 8.08), 8)
    const before = carried(bot)
    expect(before).to.be.closeTo(own(8), 1e-9)
    // Owes 15, holds 19 USDC: room for ~4 of the ~8 carried.
    const deal = makeDeal(22, 15, 19)
    await closeDeal(bot, deal, 15)
    expect(sent).to.have.length(1)
    expect(sent[0].qty * PRICE).to.be.at.most(19 * (1 - FEE.taker) + 1e-9)
    const inOrder = sent[0].qty - own(15)
    expect(inOrder).to.be.greaterThan(3.9).and.lessThan(before)
    bot.settleShortCloseCarry(
      { deal },
      { executedQty: `${sent[0].qty}`, origQty: `${sent[0].qty}` },
    )
    expect(carried(bot)).to.be.closeTo(before - inOrder, 0.011)
    expect(carried(bot)).to.be.greaterThan(0)
  })

  it('§1.5 unchanged: a sizing call that is not the close path never adds the carry', async () => {
    const { bot } = makeBot({
      exchange: ExchangeEnum.hyperliquid,
      settings,
      flags: [],
      paperContext: false,
      shortCloseCarry: [{ symbol: PAIR, base: 9 }],
    })
    const deal = makeDeal(31, 20, 25)
    bot.setDeal(deal, [sellFor(deal, 20)])
    // `createCurrentDealOrders` / `updateAssets` / coverage shape: no carry arg.
    const tps = await bot.getTPOrder(
      PAIR,
      PRICE,
      [],
      PRICE,
      PRICE,
      deal._id,
      deal,
    )
    expect(tps[0].qty).to.be.closeTo(own(20), 0.01)
  })

  it('§1.5 unchanged: a LONG combo close never reads the carry', async () => {
    const { bot } = makeBot({
      exchange: ExchangeEnum.hyperliquid,
      settings,
      flags: [],
      paperContext: false,
      shortCloseCarry: [{ symbol: PAIR, base: 9 }],
    })
    bot.isLong = true
    const deal = {
      ...makeDeal(41, 0, 0),
      initialBalances: { base: 0, quote: 20 },
      currentBalances: { base: 20, quote: 0 },
    }
    bot.setDeal(deal, [{ ...sellFor(deal, 20), side: 'BUY' }])
    const tp = await bot.prepareTpOrder({
      deal,
      initialOrders: [],
      currentOrders: [],
    })
    expect(tp.qty).to.be.at.most(20)
  })

  it('§1.5 unchanged: a close skipped with nothing owed adds nothing', async () => {
    const { bot, closedWithoutOrder, writes } = makeBot()
    // Already bought back everything it sold.
    const deal = { ...makeDeal(51, 0, 0.5) }
    await closeDeal(bot, deal, 0)
    expect(closedWithoutOrder).to.deep.equal([deal._id])
    expect(carried(bot)).to.equal(0)
    expect(writes).to.have.length(0)
  })
})
