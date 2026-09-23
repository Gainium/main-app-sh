process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `097.a-combo-close-is-sized-gross-of-the-entry-fee-the-venue-took-in-base`.
 *
 * Drives the REAL `dcaHelper.getTPOrder` combo branch over the recorded state
 * of a production PEPEUSDT (binance spot) combo deal, 2026-09-21:
 *
 *   dealStart  BUY   FILLED  21,645,021 PEPE, commission 21,645.02 PEPE
 *   grid       SELL  FILLED  10,799,135 PEPE
 *   currentBalances.base 10,845,886   (entry − grid sell, gross of the fee)
 *   exchange account flagged zeroFee → getUserFee {maker 0, taker 0}
 *
 * The close went out at 10,845,886, was refused for balance, and the restore
 * re-armed the same size. What the deal holds is 10,824,240.98.
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
  baseOrderSize: '20',
  orderSizeType: 'quote',
  indicators: [],
}

/** PEPEUSDT as the venue describes it: whole-coin steps. */
const EXCHANGE_INFO: any = {
  baseAsset: { minAmount: 1, step: 1, asset: 'PEPE' },
  quoteAsset: { minAmount: 5, step: 0.00000001, asset: 'USDT' },
  priceAssetPrecision: 8,
}

const DEAL_ID = '6ab1446ece4b4eb8d444dd48'

const DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT' },
  status: 'open',
  size: 21645021,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  flags: [],
  feeBalance: 0,
  lastPrice: 0.00000924,
  avgPrice: 0.00000924,
  initialPrice: 0.00000924,
  settings: { avgPrice: 0.00000924 },
  currentBalances: { base: 10845886, quote: 99.78 },
  initialBalances: { base: 0, quote: 200 },
}

const BASE_ORDER = {
  clientOrderId: 'D-BO-pepe',
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  status: 'FILLED',
  origQty: '21645021',
  executedQty: '21645021',
  price: '0.00000924',
  side: 'BUY',
  feePaid: 21645.02,
  feeAsset: 'PEPE',
  updateTime: 1,
}

const GRID_SELL = {
  clientOrderId: 'G-S-pepe',
  dealId: DEAL_ID,
  typeOrder: 'regular',
  status: 'FILLED',
  origQty: '10799135',
  executedQty: '10799135',
  price: '0.00000934',
  side: 'SELL',
  feePaid: 0.1,
  feeAsset: 'USDT',
  updateTime: 2,
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = true
  futures = false
  coinm = false
  combo = true
  kucoinSpot = false
  zeroFee = true
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'combo'
  data: any = {
    settings,
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  orders: any[],
  fee = { maker: 0, taker: 0 },
  deal: any = DEAL,
) => {
  class TestBot extends Helper {
    // The mixin declares its own `combo = false` field, which shadows the
    // base class's — pin it on the subclass or the non-combo path runs.
    combo = true
    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
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
    // The ledger is the fixture's; recomputing it needs the full order book.
    updateDealBalances() {}
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getUserFee() {
      return fee
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
  return new TestBot()
}

const tpQty = async (bot: any, deal: any = DEAL) => {
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

describe('combo close sizing net of the observed base entry fee (spec 097)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 zeroFee account, venue took the entry fee in base: close fits the position', async () => {
    // Production sent 10,845,886 and was refused for balance, twice.
    const qty = await tpQty(buildBot([BASE_ORDER, GRID_SELL]))
    expect(qty).to.equal(10824240)
  })

  it('§4.1 normally-configured account: unchanged (estimate ≈ observed)', async () => {
    const qty = await tpQty(
      buildBot([BASE_ORDER, GRID_SELL], { maker: 0.001, taker: 0.001 }),
    )
    // 10,845,886 − 21,645,021 × 0.001 = 10,824,240.979 → floored.
    expect(qty).to.equal(10824240)
  })

  it('§4.1 a row reporting its fee in quote keeps the estimate', async () => {
    const quoteFee = { ...BASE_ORDER, feePaid: 0.2, feeAsset: 'USDT' }
    const qty = await tpQty(
      buildBot([quoteFee, GRID_SELL], { maker: 0.001, taker: 0.001 }),
    )
    expect(qty).to.equal(10824240)
  })

  it('§4.1 zeroFee account, row with no fee data: no correction to make', async () => {
    const noFee = { ...BASE_ORDER, feePaid: undefined, feeAsset: undefined }
    const qty = await tpQty(buildBot([noFee, GRID_SELL]))
    expect(qty).to.equal(10845886)
  })

  it('§4.2 all-third-asset deal keeps the spec-015 zeroing', async () => {
    const bnb = { ...BASE_ORDER, feePaid: 0.0001, feeAsset: 'BNB' }
    const deal = { ...DEAL, flags: ['feeByAsset'] }
    const qty = await tpQty(
      buildBot([bnb, { ...GRID_SELL, feeAsset: 'BNB' }], {
        maker: 0.001,
        taker: 0.001,
      }, deal),
      deal,
    )
    expect(qty).to.equal(10845886)
  })
})
