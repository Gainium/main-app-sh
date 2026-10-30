process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `212.ledger-rebuild-counts-partial-take-profits-the-close-subtracts-again`.
 *
 * Drives the REAL `dcaHelper.updateDealBalances` and then the REAL `closeDeal`
 * over the order rows of a Coinbase SUP-USDC deal recorded in prod (spec §2):
 * 25687.1 bought, 11140.3 sold by four take-profits that each part-filled and
 * were cancelled as a re-size. Their fills are partial take profits in
 * `tpHistory`. The close was taken on the last of them; the account held
 * 14546.8, and the remainder sweep was sized 3406.5.
 *
 * Nothing here opens a connection or places anything: the venue send is
 * recorded and answered by the test. Harness shape from
 * `limitOnlyCloseRemainder.spec.ts` (spec 157).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0212'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0212'

const row = (
  clientOrderId: string,
  side: 'BUY' | 'SELL',
  typeOrder: string,
  status: string,
  price: string,
  origQty: string,
  executedQty: string,
) => ({
  clientOrderId,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'SUP-USDC',
  side,
  type: 'LIMIT',
  typeOrder,
  status,
  price,
  origQty,
  executedQty,
  updateTime: 1793233800000,
})

/** Spec §2.2: every row of the deal that executed something (prod, read-only). */
const BASE_ORDER = row(
  'D-BO-base',
  'BUY',
  'dealStart',
  'FILLED',
  '0.0038752537124358',
  '25687.1',
  '11367.2',
)
const CLOSING_TP = row(
  'D-TP-l1Id19',
  'SELL',
  'dealTP',
  'CANCELED',
  '0.003928',
  '6620.2',
  '3929.2',
)
const ROWS = [
  BASE_ORDER,
  row('D-ROA-1', 'BUY', 'dealRegular', 'FILLED', '0.00391', '14319.9', '882'),
  row('D-ROA-2', 'BUY', 'dealRegular', 'CANCELED', '0.003924', '13437.9', '1531.8'),
  row('D-ROA-3', 'BUY', 'dealRegular', 'CANCELED', '0.003924', '11906.1', '1969.2'),
  row('D-ROA-4', 'BUY', 'dealRegular', 'FILLED', '0.003928', '9936.9', '9936.9'),
  row('D-TP-p56j', 'SELL', 'dealTP', 'CANCELED', '0.003922', '11367.2', '7116'),
  row('D-TP-KVm5', 'SELL', 'dealTP', 'CANCELED', '0.003924', '5133.2', '44.8'),
  CLOSING_TP,
  row('D-TP-2vNV', 'SELL', 'dealTP', 'CANCELED', '0.003933', '4660.2', '50.3'),
  // never executed — must contribute nothing either way
  row('D-RO-unfilled', 'BUY', 'dealRegular', 'CANCELED', '0.003836', '8602.7', '0'),
]

const TP_HISTORY = [
  { qty: 7116, price: 0.003922, id: 'D-TP-p56j' },
  { qty: 44.8, price: 0.003924, id: 'D-TP-KVm5' },
  { qty: 3929.2, price: 0.003928, id: 'D-TP-l1Id19' },
  { qty: 50.3, price: 0.003933, id: 'D-TP-2vNV' },
]

const FUNDS = [
  { price: 0.00391, qty: 882 },
  { price: 0.003924, qty: 1531.8 },
  { price: 0.003924, qty: 1969.2 },
  { price: 0.003928, qty: 9936.9, baseRemainder: true },
]

const makeDeal = (withTpHistory: boolean) => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  strategy: 'LONG',
  symbol: { symbol: 'SUP-USDC', baseAsset: 'SUP', quoteAsset: 'USDC' },
  size: 25687.1,
  avgPrice: 0.0039032638933122715,
  lastPrice: 0.003928,
  tpHistory: withTpHistory ? TP_HISTORY.map((h) => ({ ...h })) : [],
  reduceFunds: [],
  funds: FUNDS.map((f) => ({ ...f })),
  pendingAddFunds: [],
  levels: { all: 6, complete: 6 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: 0, quote: 0 },
  initialBalances: { base: 0, quote: 0 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1793233800000,
})

let Helper: any

const makeBot = (opts: { withTpHistory?: boolean; rows?: any[] } = {}) => {
  const deal = makeDeal(opts.withTpHistory ?? true)
  const rows = opts.rows ?? ROWS
  const sent: any[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public allowToPlaceOrders = new Map()
    public ordersInBetweenUpdates = new Set<string>()
    public isLong = true
    public futures = false
    public coinm = false
    public hedge = false
    public combo = false
    public botId = BOT_ID
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.coinbase,
      settings: { name: 'bot', pair: ['SUP-USDC'], type: 'regular' },
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
    findBaseOrderByDeal() {
      return BASE_ORDER
    }
    getPendingAddFunds() {
      return { base: 0, quote: 0 }
    }
    fundsHeldOffset() {
      return { base: 0, quote: 0 }
    }
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = [status].flat()
      return rows.filter((o: any) => wanted.includes(o.status))
    }
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
        pair: 'SUP-USDC',
        priceAssetPrecision: 6,
        baseAsset: { minAmount: 0.1, step: 0.1, name: 'SUP' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
      }
    }
    async getLatestPrice() {
      return 0.003922
    }
    async baseAssetPrecision() {
      return 1
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    convertGridToOrder(grid: any, additional: any) {
      return { ...grid, ...additional, clientOrderId: grid.newClientOrderId }
    }
    async sendGridToExchange(grid: any, additional: any) {
      sent.push({ ...grid, orderType: additional.type })
      // The market sweep fills in full at the take-profit book price.
      return {
        ...grid,
        clientOrderId: grid.newClientOrderId,
        status: 'FILLED',
        type: additional.type,
        executedQty: `${grid.qty}`,
        origQty: `${grid.qty}`,
        price: '0.003922',
        updateTime: 1793233881000,
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
  return { bot, deal, sent }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

describe('ledger rebuild vs partial take profits (spec 212)', () => {
  before(function () {
    // One ts-node compile of a 33k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1.1 the rebuild leaves partial take profits to tpHistory', () => {
    it('an open deal is rebuilt holding every coin it bought, net of nothing tpHistory owns', async () => {
      const { bot, deal } = makeBot()
      await bot.updateDealBalances(bot.getDeal(DEAL_ID))
      // 25687.1 bought; all four sales are in `tpHistory`.
      expect(round(deal.currentBalances.base)).to.equal(25687.1)
    })

    it('the close sweeps exactly what the account holds: 14546.8', async () => {
      const { bot, deal, sent } = makeBot()
      await bot.updateDealBalances(bot.getDeal(DEAL_ID))
      await bot.closeDeal(BOT_ID, DEAL_ID, {
        ...CLOSING_TP,
        status: 'FILLED',
      })
      expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
        ['SELL', 14546.8, 'MARKET'],
      ])
      expect(deal.status).to.equal('closed')
    })

    it('§1.2 the close books the held remainder once, not net of the sales twice', async () => {
      const { bot, deal } = makeBot()
      await bot.updateDealBalances(bot.getDeal(DEAL_ID))
      await bot.closeDeal(BOT_ID, DEAL_ID, {
        ...CLOSING_TP,
        status: 'FILLED',
      })
      // The sweep sold what was held, so the deal ends holding nothing.
      expect(round(deal.currentBalances.base)).to.equal(0)
      // quote: initial − every buy + every take-profit sale + the sweep, each once.
      const buysQuote = ROWS.filter((o) => o.side === 'BUY').reduce(
        (a, o) => a + +o.executedQty * +o.price,
        0,
      )
      const sellsQuote = ROWS.filter((o) => o.side === 'SELL').reduce(
        (a, o) => a + +o.executedQty * +o.price,
        0,
      )
      expect(round(deal.currentBalances.quote)).to.equal(
        round(
          deal.initialBalances.quote - buysQuote + sellsQuote + 14546.8 * 0.003922,
        ),
      )
    })
  })

  describe('§1.3 unchanged: rows that are not partial take profits', () => {
    it('with no tpHistory, the rebuild still counts every executed row', async () => {
      const { bot, deal } = makeBot({ withTpHistory: false })
      await bot.updateDealBalances(bot.getDeal(DEAL_ID))
      expect(round(deal.currentBalances.base)).to.equal(14546.8)
    })

    it('a combo deal is rebuilt as before: its take-profit is sized off this ledger', async () => {
      const { bot, deal } = makeBot()
      bot.combo = true
      await bot.updateDealBalances(bot.getDeal(DEAL_ID))
      expect(round(deal.currentBalances.base)).to.equal(14546.8)
    })

    it('a closed deal is rebuilt as before, tpHistory or not', async () => {
      const { bot, deal } = makeBot()
      deal.status = 'closed'
      await bot.updateDealBalances(bot.getDeal(DEAL_ID))
      expect(round(deal.currentBalances.base)).to.equal(14546.8)
    })
  })
})
