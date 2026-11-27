process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `292.dca-commission-counts-cancelled-partial-fills`.
 *
 * Drives the REAL `dcaHelper.closeDeal` and `getCommDeal` over a spot LONG
 * deal on a venue that charges fees: the first take-profit filled 4 of 10 and
 * was then cancelled (a CANCELED row with `executedQty > 0` and a real fee),
 * and a second take-profit closed the other 6.
 *
 * `profit.total` is measured from balances that include those 4 coins sold,
 * so the 0.44 fee the venue charged for them has to come off it too — and
 * `commission` has to name it, the same way `feePaid` already does.
 *
 * Nothing here opens a connection. Harness shape from
 * `closeSweepProfitBooking.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0292'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0292'
const Q0 = 5000

const row = (o: any): any => ({
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'SOL-USDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  feeAsset: 'USDT',
  ...o,
})

const BO = row({
  clientOrderId: 'D-BO-0292',
  side: 'BUY',
  type: 'MARKET',
  typeOrder: 'dealStart',
  status: 'FILLED',
  price: '100',
  origQty: '10',
  executedQty: '10',
  cummulativeQuoteQty: '1000',
  feePaid: '1',
  updateTime: 1795260000000,
})

/** Filled 4 of 10, then cancelled — the venue still charged for the 4. */
const CANCELLED_TP = row({
  clientOrderId: 'D-TP-partial-0292',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status: 'CANCELED',
  price: '110',
  origQty: '10',
  executedQty: '4',
  cummulativeQuoteQty: '440',
  feePaid: '0.44',
  updateTime: 1795260100000,
})

const FINAL_TP = row({
  clientOrderId: 'D-TP-final-0292',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status: 'FILLED',
  price: '110',
  origQty: '6',
  executedQty: '6',
  cummulativeQuoteQty: '660',
  feePaid: '0.66',
  updateTime: 1795260200000,
})

const FEES = 1 + 0.44 + 0.66
const EXPECTED_TOTAL = 440 + 660 - 1000 - FEES

const makeDeal = (): any => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: 'SOL-USDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
  size: 10,
  avgPrice: 100,
  lastPrice: 110,
  tpHistory: [{ qty: 4, price: 110, id: CANCELLED_TP.clientOrderId }],
  reduceFunds: [],
  funds: [],
  flags: ['newMultiTp', 'feeByAsset'],
  levels: { all: 5, complete: 1 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: 10, quote: Q0 - 1000 },
  initialBalances: { base: 0, quote: Q0 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1795260000000,
})

let Helper: any

const makeBot = (combo = false) => {
  const deal = makeDeal()
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
    public combo = combo
    public botId = BOT_ID
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.bybit,
      settings: { name: 'bot', pair: ['SOL-USDT'], type: 'regular' },
      flags: [],
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    public rows: any[] = [BO, CANCELLED_TP, FINAL_TP]
    dealsDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: deal } }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: [BO] } }),
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
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'SOL-USDT',
        priceAssetPrecision: 2,
        baseAsset: { minAmount: 0.01, step: 0.01, name: 'SOL' },
        quoteAsset: { minAmount: 1, step: 0.0001, name: 'USDT' },
      }
    }
    async getLatestPrice() {
      return 110
    }
    async baseAssetPrecision() {
      return 2
    }
    getOrdersByStatusAndDealId({ status, dealId }: any) {
      const wanted = [status].flat()
      return this.rows.filter(
        (o: any) => o.dealId === dealId && wanted.includes(o.status),
      )
    }
    handleUnknownOrder() {}
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
  return { bot, deal }
}

const drive = async () => {
  const t = makeBot()
  await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...FINAL_TP })
  return t
}

describe('a DCA close charges the fee of a part-filled, cancelled take-profit (spec 292)', () => {
  before(function () {
    // One ts-node compile of a 37k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§2 the fixture closes the deal in one go: no sweep, status closed', async () => {
    const { deal } = await drive()
    expect(deal.status).to.equal('closed')
    expect(deal.feePaid.quote).to.be.closeTo(FEES, 1e-9)
  })

  it('§3.1 commission includes the cancelled take-profit fee', async () => {
    const { deal } = await drive()
    expect(deal.commission).to.be.closeTo(FEES, 1e-9)
  })

  it('§3.2 profit.total is sold minus cost minus every fee charged', async () => {
    const { deal } = await drive()
    expect(EXPECTED_TOTAL).to.be.closeTo(97.9, 1e-9)
    expect(deal.profit.total).to.be.closeTo(EXPECTED_TOTAL, 1e-9)
  })

  it('§3.3 commission equals feePaid.quote + feePaid.base × lastPrice (no double count)', async () => {
    const { deal } = await drive()
    expect(deal.commission).to.be.closeTo(
      deal.feePaid.quote + deal.feePaid.base * deal.lastPrice,
      1e-9,
    )
  })

  it('§3.4 getCommDeal with no orders still counts only FILLED rows', async () => {
    const { bot, deal } = makeBot(true)
    expect(await bot.getCommDeal(deal)).to.be.closeTo(1 + 0.66, 1e-9)
  })
})
