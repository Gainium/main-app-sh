process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `207.unknown-order-lookup-keeps-the-stale-fill-size`.
 *
 * Replays the sequence recorded in prod (spec §2): a Binance EUL/USDT market
 * take-profit for 17.86 whose row last heard a 0.1 partial fill, then a cancel
 * answered "unknown order" and a lookup answering FILLED. The REAL
 * `MainBot._handleUnknownOrder` runs off the prototype against a fake venue,
 * and the order it returns is handed to the REAL `dcaHelper.closeDeal` (the
 * harness of `limitOnlyCloseRemainder.spec.ts`, spec 157), whose remainder
 * sweep is recorded instead of sent.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0207'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0207'
const TP_ID = 'x-BKSVA3NTD-TP-stale-fill-0207'
const SIZE = 17.86
const AVG = 1.25

/** The take-profit row as the user stream last left it (spec §2). */
const staleRow = (): any => ({
  clientOrderId: TP_ID,
  orderId: '9000000207',
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'EULUSDT',
  side: 'SELL',
  type: 'MARKET',
  typeOrder: 'dealTP',
  status: 'PARTIALLY_FILLED',
  price: '1.263',
  origQty: `${SIZE}`,
  executedQty: '0.10000000',
  cummulativeQuoteQty: '0.12630000',
  updateTime: 1793248501020,
})

/** What `GET /api/v3/order` answers, through the connector's convertOrder. */
const venue = (over: any = {}): any => ({
  ...staleRow(),
  status: 'FILLED',
  price: '0.00000000',
  executedQty: '17.86000000',
  cummulativeQuoteQty: '22.55718000',
  updateTime: 1793248528928,
  ...over,
})

/** Real ladder off the MainBot prototype; the venue answers `answer`. */
const lookup = async (answer: any, row: any = {}) => {
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = { exchange: ExchangeEnum.binance, paperContext: false }
  bot.orders = new Map([[TP_ID, { ...staleRow(), ...row }]])
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  const db: any[] = []
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    getOrder: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: answer,
    }),
  }
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = () => undefined
  bot.emit = () => undefined
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  // Spot: the conversion is the identity, so which object is converted is
  // exactly what the assertion sees.
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async (_f: any, o: any) => {
      db.push({ ...o })
      return { status: StatusEnum.ok }
    },
  }
  const order = await bot._handleUnknownOrder(TP_ID, 'EULUSDT')
  return { order, db, row: bot.orders.get(TP_ID) }
}

let Helper: any

const makeDeal = () => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: 'EULUSDT', baseAsset: 'EUL', quoteAsset: 'USDT' },
  size: SIZE,
  avgPrice: AVG,
  lastPrice: 1.263,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  levels: { all: 1, complete: 1 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: SIZE, quote: 0 },
  initialBalances: { base: 0, quote: SIZE * AVG },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1793248501020,
})

/** Real `closeDeal` off the dcaHelper mixin; the sweep is recorded. */
const close = async (tpOrder: any) => {
  const deal = makeDeal()
  const sent: any[] = []
  const closes: any[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public allowToPlaceOrders = new Map()
    public isLong = true
    public futures = false
    public coinm = false
    public hedge = false
    public combo = false
    public botId = BOT_ID
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.binance,
      settings: { name: 'bot', pair: ['EULUSDT'], type: 'regular' },
      flags: [],
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    dealsDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: deal } }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: [] } }),
    }
    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    setDeal() {}
    saveDeal() {
      return Promise.resolve()
    }
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'EULUSDT',
        priceAssetPrecision: 3,
        baseAsset: { minAmount: 0.01, step: 0.01, name: 'EUL' },
        quoteAsset: { minAmount: 5, step: 0.00000001, name: 'USDT' },
      }
    }
    async getLatestPrice() {
      return 1.262
    }
    async baseAssetPrecision() {
      return 2
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    convertGridToOrder(grid: any, additional: any) {
      return { ...grid, ...additional, clientOrderId: grid.newClientOrderId }
    }
    async sendGridToExchange(grid: any, additional: any) {
      sent.push({ ...grid, orderType: additional.type })
      return {
        ...grid,
        clientOrderId: grid.newClientOrderId,
        status: 'FILLED',
        executedQty: `${grid.qty}`,
      }
    }
    async handleOrderErrors() {}
    closeDealById() {}
    closeRemainderByLimit() {}
    getOrdersByStatusAndDealId() {
      return []
    }
    async cancelOrderOnExchange(o: any) {
      return { ...o, status: 'CANCELED' }
    }
    handleUnknownOrder() {}
    async restoreOrReportRefusedClose() {}
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async processDealClose(...args: any[]) {
      closes.push(args)
      return false
    }
    saveProfitToDb() {}
    shouldProceed() {
      return false
    }
    updateUserProfitStep() {}
    updateData() {}
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
  const bot = new (TestBot as any)()
  await bot.closeDeal(BOT_ID, DEAL_ID, tpOrder)
  return { deal, sent, closes }
}

describe('an order lookup answering FILLED records the venue fill size (spec 207)', () => {
  before(function () {
    // One ts-node compile of a 27k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§4.1 takes executedQty and cummulativeQuoteQty from the venue, keeps the local price', async () => {
    const { order, db } = await lookup(venue())
    expect(order?.status).to.equal('FILLED')
    expect(+order.executedQty).to.equal(SIZE)
    expect(+order.cummulativeQuoteQty).to.equal(22.55718)
    expect(order.price).to.equal('1.263')
    expect(+db[0].executedQty, 'the row is written with it').to.equal(SIZE)
  })

  it('§4.2 a venue answer with no fill size keeps the row reading', async () => {
    const { order } = await lookup(
      venue({ executedQty: '0', cummulativeQuoteQty: '0' }),
    )
    expect(+order.executedQty).to.equal(0.1)
    expect(+order.cummulativeQuoteQty).to.equal(0.1263)
  })

  it('§4.3 the confirmed full fill closes the deal with no remainder sweep', async () => {
    const { order } = await lookup(venue())
    const { deal, sent, closes } = await close(order)
    expect(sent, 'no sell-remainder order').to.deep.equal([])
    expect(deal.status).to.equal('closed')
    expect(closes).to.have.length(1)
    expect(Math.abs(deal.currentBalances.base)).to.be.lessThan(1e-9)
  })

  it('§4.4 a genuinely partial take-profit still sweeps the rest at market', async () => {
    // Still resting, part filled: the row is updated, not returned, and the
    // close's cancel later promotes it to FILLED (spec 157's case).
    const { row } = await lookup(
      venue({
        status: 'PARTIALLY_FILLED',
        executedQty: '5.00000000',
        cummulativeQuoteQty: '6.31500000',
      }),
      { status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' },
    )
    expect(+row.executedQty).to.equal(5)
    const { sent } = await close({ ...row, status: 'FILLED' })
    expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
      ['SELL', 12.86, 'MARKET'],
    ])
  })
})
