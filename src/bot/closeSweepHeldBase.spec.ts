process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `263.close-sweep-sells-the-base-a-partly-reduced-deal-holds`.
 *
 * Drives the REAL `dcaHelper.closeDeal` → `sellRemainder` (close remainder
 * sweep, spec 157) and the REAL `getTPOrder`, off the mixin, over the shapes
 * recorded in prod (spec §2): a spot LONG deal whose reduce-funds sells
 * (`D-TPR`) took most of the position, then closed.
 *
 * Nothing here opens a connection: the venue send is answered by the test.
 * Harness shape from `limitOnlyCloseRemainder.spec.ts` (spec 157) and
 * `dca/tpSizingFromPosition.harness.spec.ts` (spec 017).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { sweepBaseFeesPaid } from './dca/sweepBaseFee'
import { createRequire } from 'module'

let Helper: any
let DogeHelper: any

// ---------------------------------------------------------------------------
// §2.1 — the Kraken XRP-EUR shape, scaled down. Every fee the venue reported
// was charged in EUR; LIMIT fills reported a zero fee; one MARKET fill carries
// no fee report at all. Account fee: maker 0, taker 0.1%.
// ---------------------------------------------------------------------------
const K_DEAL = 'aaaaaaaaaaaaaaaaaaaa0263'
const K_BOT = 'bbbbbbbbbbbbbbbbbbbb0263'
const K_TP = 'D-TP-final-close-0263'
const K_FEE = { maker: 0, taker: 0.001 }
const row = (o: any) => ({
  botId: K_BOT,
  dealId: K_DEAL,
  symbol: 'XRP-EUR',
  baseAsset: 'XRP',
  quoteAsset: 'EUR',
  status: 'FILLED',
  updateTime: 1,
  ...o,
})
const K_ROWS = [
  row({
    clientOrderId: 'D-BO-k',
    typeOrder: 'dealStart',
    side: 'BUY',
    type: 'MARKET',
    price: '1',
    origQty: '1000',
    executedQty: '1000',
    feeAsset: 'EUR',
    feePaid: '1',
  }),
  row({
    clientOrderId: 'D-RO-limit',
    typeOrder: 'dealRegular',
    side: 'BUY',
    type: 'LIMIT',
    price: '0.99',
    origQty: '99000',
    executedQty: '99000',
    feeAsset: 'EUR',
    feePaid: '0',
  }),
  row({
    clientOrderId: 'D-RO-market-unreported',
    typeOrder: 'dealRegular',
    side: 'BUY',
    type: 'MARKET',
    price: '0.99',
    origQty: '1000',
    executedQty: '1000',
  }),
  row({
    clientOrderId: 'D-TPR-k',
    typeOrder: 'dealTP',
    side: 'SELL',
    type: 'MARKET',
    price: '0.98',
    origQty: '96000',
    executedQty: '96000',
    feeAsset: 'EUR',
    feePaid: '94.08',
    reduceFundsId: 'rf-1',
  }),
]
/** Entered 101000, withdrew 96000: 5000 held. The close sized gross × (1 − 0.1%) − 96000. */
const K_CLOSE_QTY = 101000 * (1 - 0.001) - 96000 // 4899
const K_TP_ORDER = row({
  clientOrderId: K_TP,
  typeOrder: 'dealTP',
  side: 'SELL',
  type: 'MARKET',
  price: '0.98',
  origQty: `${K_CLOSE_QTY}`,
  executedQty: `${K_CLOSE_QTY}`,
  feeAsset: 'EUR',
  feePaid: '4.8',
})

const makeKrakenDeal = () => ({
  _id: K_DEAL,
  botId: K_BOT,
  status: 'open',
  symbol: { symbol: 'XRP-EUR', baseAsset: 'XRP', quoteAsset: 'EUR' },
  size: K_CLOSE_QTY,
  avgPrice: 0.9901,
  lastPrice: 0.98,
  tpHistory: [],
  reduceFunds: [{ price: 0.98, qty: 96000 }],
  funds: [],
  flags: ['newMultiTp', 'feeByAsset'],
  levels: { all: 2, complete: 2 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: 5000, quote: 0 },
  initialBalances: { base: 0, quote: 100000 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1,
})

const makeCloseBot = () => {
  const deal = makeKrakenDeal()
  const sent: any[] = []
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
    public botId = K_BOT
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.kraken,
      settings: { name: 'bot', pair: ['XRP-EUR'], type: 'regular' },
      flags: [],
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    dealsDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: deal } }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
    }
    /** The deal's rows as the DB holds them — the sweep's fee source. */
    ordersDb = {
      readData: async (q: any) => ({
        status: StatusEnum.ok,
        data: {
          result: [...K_ROWS, K_TP_ORDER].filter(
            (o) =>
              o.dealId === q.dealId &&
              (typeof q.status === 'string'
                ? o.status === q.status
                : q.status.$in.includes(o.status)) &&
              (!q.side || o.side === q.side),
          ),
        },
      }),
    }
    getDeal(id: string) {
      return id === K_DEAL
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
      return K_FEE
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'XRP-EUR',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 0.00000001, name: 'XRP' },
        quoteAsset: { minAmount: 0.5, step: 0.00001, name: 'EUR' },
      }
    }
    async getLatestPrice() {
      return 0.98
    }
    async baseAssetPrecision() {
      return 8
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
        ...K_TP_ORDER,
        clientOrderId: grid.newClientOrderId,
        side: grid.side,
        status: 'FILLED',
        origQty: `${grid.qty}`,
        executedQty: `${grid.qty}`,
        price: '0.98',
      }
    }
    async handleOrderErrors() {}
    isErrorNotEnoughBalance() {
      return false
    }
    closeDealById() {}
    closeRemainderByLimit() {}
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = [status].flat()
      return [...K_ROWS, K_TP_ORDER].filter((o: any) =>
        wanted.includes(o.status),
      )
    }
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
    trackRemainderSweep() {}
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
  return { bot: new (TestBot as any)(), deal, sent }
}

// ---------------------------------------------------------------------------
// §2.2 — the live Bybit DOGEUSDC deal, its rows to the unit. Bybit charges a
// spot BUY's fee in the coin bought; six reduce-funds sells (fees in USDC)
// took 1672.1 of the 2176.6 entered. `size` 333.59 against 504.5 on the base
// ledger, 499.0585 actually on the venue.
// ---------------------------------------------------------------------------
const D_DEAL = '6aed98041ff1077ddbf5cc2b'
const dRow = (
  id: string,
  qty: string,
  fee: string,
  type = 'dealRegular',
): any => ({
  clientOrderId: id,
  dealId: D_DEAL,
  typeOrder: type,
  status: 'FILLED',
  side: 'BUY',
  type: 'MARKET',
  price: '0.06',
  origQty: qty,
  executedQty: qty,
  feeAsset: 'DOGE',
  feePaid: fee,
  updateTime: 1,
})
const D_BO = dRow('D-BO-JswpoU09', '260.3', '0.65075', 'dealStart')
const D_SO = [
  dRow('D-ROA-aN2D8OfI', '270.1', '0.67525'),
  dRow('D-ROA-ZcC3yvrz', '282.2', '0.7055'),
  dRow('D-ROA-fXj5oYYj', '295.1', '0.73775'),
  dRow('D-ROA-vDuINOGT', '307.3', '0.76825'),
  dRow('D-ROA-t4K2nQpN', '317.3', '0.79325'),
  dRow('D-ROA-DRk6CE4B', '444.3', '1.11075'),
]
const D_RF = [195.5, 199.9, 203.3, 207.5, 266.9, 599]
const D_HELD_ON_VENUE = 2176.6 - 5.4415 - 1672.1 // 499.0585

const D_SETTINGS: any = {
  useTp: true,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  multiTp: [],
  tpPerc: '1',
  slPerc: '3',
  baseOrderSize: '15',
  orderSizeType: 'quote',
  indicators: [],
}
const makeDogeDeal = (withReduce = true): any => ({
  _id: D_DEAL,
  symbol: { symbol: 'DOGEUSDC', baseAsset: 'DOGE', quoteAsset: 'USDC' },
  status: 'open',
  size: withReduce ? 333.5903992966255 : 2176.6,
  tpHistory: [],
  reduceFunds: withReduce ? D_RF.map((qty) => ({ qty, price: 0.06 })) : [],
  funds: [],
  flags: ['newMultiTp', 'feeByAsset'],
  lastPrice: 0.0604,
  avgPrice: 0.059784988973628585,
  initialPrice: 0.07216,
  settings: { avgPrice: 0.059784988973628585 },
  currentBalances: { base: withReduce ? 504.5 : 2176.6, quote: 33.52603 },
  initialBalances: { base: 0, quote: 60.716176 },
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
  zeroFee = false
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  data: any = {
    settings: D_SETTINGS,
    exchange: ExchangeEnum.bybit,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const dogeTpQty = async (orders: any[], deal: any) => {
  class TestBot extends DogeHelper {
    getDeal(id: string) {
      return id === D_DEAL
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    getOrdersByStatusAndDealId({ status, dealId }: any) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    async getAggregatedSettings() {
      return D_SETTINGS
    }
    async getExchangeInfo() {
      return {
        baseAsset: { minAmount: 0.1, step: 0.1, asset: 'DOGE' },
        quoteAsset: { minAmount: 1, step: 0.00001, asset: 'USDC' },
        priceAssetPrecision: 5,
      }
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async baseAssetPrecision() {
      return 1
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
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    getOrderId(prefix: string) {
      return `${prefix}-test`
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
  const bot: any = new (TestBot as any)()
  const tps = await bot.getTPOrder(
    deal.symbol.symbol,
    deal.lastPrice,
    [],
    deal.avgPrice,
    deal.initialPrice,
    D_DEAL,
    deal,
  )
  return tps?.[0]?.qty as number
}

describe('close sweep sells the base a partly reduced deal holds (spec 263)', () => {
  before(function () {
    // One ts-node compile of a 36k-line module.
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
    DogeHelper = createRequire(__filename)('./dcaHelper').default(
      FakeBase as any,
    )
  })

  describe('§3.1 sweepBaseFeesPaid', () => {
    it('counts nothing for fees the venue reported in quote', () => {
      expect(
        sweepBaseFeesPaid([K_ROWS[0], K_ROWS[3]], K_FEE, 'XRP', 'EUR', true),
      ).to.equal(0)
    })

    it('estimates an entry buy with no usable fee report at its own rate', () => {
      // LIMIT reported 0 → maker 0; MARKET unreported → taker 0.1% of 1000.
      expect(
        sweepBaseFeesPaid([K_ROWS[1], K_ROWS[2]], K_FEE, 'XRP', 'EUR', true),
      ).to.be.closeTo(1, 1e-9)
    })

    it('takes a base fee the venue reported, to the unit', () => {
      expect(
        sweepBaseFeesPaid([D_BO, ...D_SO], { maker: 0.001, taker: 0.001 }, 'DOGE', 'USDC', true),
      ).to.be.closeTo(5.4415, 1e-9)
    })

    it('skips rows that executed nothing', () => {
      expect(
        sweepBaseFeesPaid(
          [{ ...K_ROWS[2], executedQty: '0', status: 'CANCELED' }],
          K_FEE,
          'XRP',
          'EUR',
        ),
      ).to.equal(0)
    })
  })

  describe('§3.2 closeDeal sweeps what the close left behind', () => {
    it('sells the 101 left after the final close, less only the 1 of base fee estimated', async () => {
      const { deal, sent } = await (async () => {
        const t = makeCloseBot()
        await t.bot.closeDeal(K_BOT, K_DEAL, { ...K_TP_ORDER })
        return t
      })()
      // Before: `taker × every entry buy` = 101 was deducted from the 101
      // remainder, the sweep fell under the minimum and sent nothing.
      expect(sent).to.have.length(1)
      expect(sent[0].side).to.equal('SELL')
      expect(sent[0].orderType).to.equal('MARKET')
      expect(sent[0].qty).to.be.closeTo(100, 1e-6)
      expect(deal.status).to.equal('closed')
    })
  })

  describe('§3.3 getTPOrder on a spot long with executed reduce-funds', () => {
    it('with every row in the map, closes what the venue holds', async () => {
      const qty = await dogeTpQty([D_BO, ...D_SO], makeDogeDeal())
      expect(qty).to.be.closeTo(D_HELD_ON_VENUE, 0.1)
    })

    it('with the base-order row absent, still closes what the venue holds, not deal.size', async () => {
      // Before: the base order was re-derived from `size + reduceFunds` =
      // 2005.69, contributing 89.39 instead of 260.3, and the close left
      // ~171 DOGE behind.
      const qty = await dogeTpQty([...D_SO], makeDogeDeal())
      expect(qty).to.be.closeTo(D_HELD_ON_VENUE, 1)
    })

    it('§4 without reduce-funds, the base-order-absent close is sized as before', async () => {
      const qty = await dogeTpQty([...D_SO], makeDogeDeal(false))
      // size 2176.6 is the entry; less the reported base fees.
      expect(qty).to.be.closeTo(2176.6 - 5.4415, 1)
    })
  })
})
