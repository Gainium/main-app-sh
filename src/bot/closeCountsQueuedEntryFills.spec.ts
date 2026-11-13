process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `238.a-close-misses-entry-fills-still-queued-for-booking`.
 *
 * A Binance spot SHORT TIAUSDT deal (spec §2.1): three safety orders filled in
 * one venue message, only the first was booked into `currentBalances`, and the
 * take-profit — sized from every FILLED row — bought back the whole 205.12.
 * The close measured the position from the ledger, which was missing the two
 * queued fills, and their queued `updateDeal`s then bought them again at
 * market as "late" fills.
 *
 * Drives the REAL `closeDeal`, `updateDeal` and `sellRemainder`; the venue send
 * is recorded. Harness shape from `tpHistoryLedgerRebuild.spec.ts` (spec 212).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0238'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0238'

type Row = Record<string, any>

const row = (
  clientOrderId: string,
  side: 'BUY' | 'SELL',
  typeOrder: string,
  status: string,
  price: string,
  qty: string,
): Row => ({
  clientOrderId,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'TIAUSDT',
  side,
  type: 'LIMIT',
  typeOrder,
  status,
  price,
  origPrice: price,
  origQty: qty,
  executedQty: qty,
  updateTime: 1794487325043,
})

/** Booked into the ledger before the take-profit filled. */
const BOOKED = [
  row('D-BO-base', 'SELL', 'dealStart', 'FILLED', '0.4108', '20'),
  row('D-RO-so1', 'SELL', 'dealRegular', 'FILLED', '0.4167', '20'),
  row('D-RO-so2', 'SELL', 'dealRegular', 'FILLED', '0.4223', '32'),
]
/** FILLED in the same venue message, still queued for `updateDeal` (§2.1). */
const QUEUED = [
  row('D-RO-so4', 'SELL', 'dealRegular', 'FILLED', '0.4757', '81.92'),
  row('D-RO-so3', 'SELL', 'dealRegular', 'FILLED', '0.4428', '51.2'),
]
const SOLD = [...BOOKED, ...QUEUED]
const sum = (rows: Row[], f: (r: Row) => number) =>
  rows.reduce((a, r) => a + f(r), 0)

const tp = (qty: string) =>
  row('D-TP-close', 'BUY', 'dealTP', 'FILLED', '0.4089', qty)

const PLANNED_BASE = 545.91

let Helper: any

const makeBot = (opts: { queuedAtClose?: boolean; refuse?: string } = {}) => {
  const queuedAtClose = opts.queuedAtClose ?? true
  const rows: Row[] = [
    ...BOOKED.map((r) => ({ ...r })),
    ...QUEUED.map((r) =>
      queuedAtClose ? { ...r } : { ...r, status: 'NEW', executedQty: '0' },
    ),
  ]
  const bookedQuote = sum(BOOKED, (r) => +r.executedQty * +r.price)
  const deal: Row = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    strategy: 'SHORT',
    symbol: { symbol: 'TIAUSDT', baseAsset: 'TIA', quoteAsset: 'USDT' },
    size: 72,
    avgPrice: 0.4454,
    lastPrice: 0.4223,
    tpHistory: [],
    reduceFunds: [],
    funds: [],
    pendingAddFunds: [],
    levels: { all: 7, complete: 3 },
    commission: 0,
    profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    initialBalances: { base: PLANNED_BASE, quote: 0 },
    currentBalances: { base: PLANNED_BASE - 72, quote: bookedQuote },
    assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
    updateTime: 1794487325043,
  }
  const sent: Row[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public allowToPlaceOrders = new Map()
    public ordersInBetweenUpdates = new Set<string>()
    public isLong = false
    public futures = false
    public coinm = false
    public hedge = false
    public combo = false
    public botId = BOT_ID
    public botType = 'dca'
    public rows = rows
    public data: any = {
      exchange: ExchangeEnum.binance,
      settings: { name: 'bot', pair: ['TIAUSDT'], type: 'regular' },
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
    private full = { deal, initialOrders: [], currentOrders: [] }
    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    setDeal() {}
    saveDeal() {
      return Promise.resolve()
    }
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = status ? [status].flat() : ['NEW', 'PARTIALLY_FILLED']
      return rows.filter((o) => wanted.includes(o.status))
    }
    settleShortCloseCarry() {}
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'TIAUSDT',
        priceAssetPrecision: 4,
        baseAsset: { minAmount: 0.01, step: 0.01, name: 'TIA' },
        quoteAsset: { minAmount: 5, step: 0.00000001, name: 'USDT' },
      }
    }
    async getLatestPrice() {
      return 0.4086
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
      if (opts.refuse) {
        return opts.refuse
      }
      return {
        ...grid,
        clientOrderId: grid.newClientOrderId,
        status: 'FILLED',
        type: additional.type,
        executedQty: `${grid.qty}`,
        origQty: `${grid.qty}`,
        price: '0.4095',
        updateTime: 1794487326579,
      }
    }
    async handleOrderErrors() {}
    isErrorNotEnoughBalance() {
      return false
    }
    closeDealById() {}
    closeRemainderByLimit() {}
    async cancelOrderOnExchange(o: any) {
      return { ...o, status: 'CANCELED' }
    }
    handleUnknownOrder() {}
    async restoreOrReportRefusedClose() {}
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async processDealClose() {
      return false
    }
    async computeObservedFeeLedger() {
      return null
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
  if (queuedAtClose) {
    // What `processFilledOrder` does for each fill of the message (§1.2.1).
    for (const q of QUEUED) bot.ordersInBetweenUpdates.add(q.clientOrderId)
  }
  /** The queued `updateDeal` of each fill, run after the close. */
  const runQueued = async () => {
    for (const q of QUEUED) {
      const live = rows.find((r) => r.clientOrderId === q.clientOrderId)!
      Object.assign(live, { status: 'FILLED', executedQty: q.executedQty })
      bot.ordersInBetweenUpdates.add(q.clientOrderId)
      await bot.updateDeal(BOT_ID, { ...live })
    }
  }
  return { bot, deal, sent, runQueued }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
const swept = (sent: Row[]) => sent.map((g) => [g.side, g.qty, g.orderType])

describe('close counts entry fills still queued for booking (spec 238)', () => {
  before(function () {
    // One ts-node compile of a 34k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1.1.1 a take-profit that closed the whole position', () => {
    it('sends no remainder order, at close or from the queued updates', async () => {
      const { bot, deal, sent, runQueued } = makeBot()
      await bot.closeDeal(BOT_ID, DEAL_ID, tp('205.12'))
      expect(deal.status).to.equal('closed')
      await runQueued()
      expect(swept(sent)).to.deep.equal([])
    })

    it('§1.1.2 books the queued fills: flat ledger, profit at their own prices', async () => {
      const { bot, deal, runQueued } = makeBot()
      await bot.closeDeal(BOT_ID, DEAL_ID, tp('205.12'))
      await runQueued()
      expect(round(deal.currentBalances.base)).to.equal(PLANNED_BASE)
      const proceeds = sum(SOLD, (r) => +r.executedQty * +r.price)
      expect(round(deal.profit.total)).to.equal(
        round(proceeds - 205.12 * 0.4089),
      )
      expect(deal.profit.total).to.be.greaterThan(0)
    })
  })

  describe('§1.1.3 unchanged: a remainder the take-profit did not close', () => {
    it('a take-profit sized before the queued fills still leaves them swept', async () => {
      const { bot, deal, sent, runQueued } = makeBot()
      await bot.closeDeal(BOT_ID, DEAL_ID, tp('72'))
      await runQueued()
      expect(deal.status).to.equal('closed')
      // Swept once, all of it: 81.92 + 51.2.
      expect(sum(sent, (g) => +g.qty)).to.equal(133.12)
      expect(sent.every((g) => g.side === 'BUY')).to.equal(true)
      expect(round(deal.currentBalances.base)).to.equal(PLANNED_BASE)
    })

    it('fills the venue reports after the close are still sold per fill (spec 112)', async () => {
      const { bot, sent, runQueued } = makeBot({ queuedAtClose: false })
      await bot.closeDeal(BOT_ID, DEAL_ID, tp('72'))
      expect(sent).to.have.length(0)
      await runQueued()
      expect(swept(sent)).to.deep.equal([
        ['BUY', 81.92, 'MARKET'],
        ['BUY', 51.2, 'MARKET'],
      ])
    })
  })

  describe('§1.1.4 unchanged: a close that does not commit', () => {
    it('leaves the queued fills to their own updateDeal', async () => {
      const { bot, deal, sent } = makeBot({
        refuse: 'Orderbook is in limit only mode - please use limit order type',
      })
      await bot.closeDeal(BOT_ID, DEAL_ID, tp('72'))
      expect(deal.status).to.equal('open')
      // The refused pre-close sweep was measured over the queued fills too.
      expect(swept(sent)).to.deep.equal([['BUY', 133.12, 'MARKET']])
      expect(round(deal.currentBalances.base)).to.equal(round(PLANNED_BASE - 72))
      expect([...bot.ordersInBetweenUpdates].sort()).to.deep.equal(
        QUEUED.map((q) => q.clientOrderId).sort(),
      )
    })
  })
})
