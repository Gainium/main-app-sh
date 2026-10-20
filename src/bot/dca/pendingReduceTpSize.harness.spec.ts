process.env.NODE_ENV = 'testing'

/**
 * A take profit regenerated next to a resting PERCENTAGE reduce-funds order
 * is sized net of that order.
 *
 * A pending reduce entry stores the request (`qty: '40'`, `type: 'perc'`),
 * and `getPendingReduceFunds` read that 40 as a quote amount — 40 / price,
 * about 0.0005 BTC — instead of the 0.002 BTC order resting for it. A take
 * profit rebuilt then (a take-profit-only deal edit, a safety order fill)
 * came back at nearly the whole position, and the take profit plus the
 * reduce sold more than the deal held.
 *
 * Drives the REAL `getTPOrder` and `getPendingReduceFunds` (DCA, long spot);
 * pure cases for `pendingReduceQty` below. Fixture ids are synthetic — this
 * file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { pendingReduceQty } from './pendingReduceQty'

const DEAL_ID = 'deal-red'
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
  baseOrderSize: '0.006',
  orderSizeType: 'base',
  indicators: [],
}
const info = {
  baseAsset: { minAmount: 0.001, step: 0.001, asset: 'BTC' },
  quoteAsset: { minAmount: 5, step: 0.01, asset: 'USDT' },
  priceAssetPrecision: 1,
}
const ENTRY = {
  id: 'rf-1',
  qty: '40',
  type: 'perc',
  asset: 'quote',
  useLimitPrice: true,
  limitPrice: '82241.8',
}
const deal: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  status: 'open',
  size: 0.006,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  flags: [],
  pendingReduceFunds: [ENTRY],
  lastPrice: 82000,
  avgPrice: 82000,
  initialPrice: 82000,
  settings: { avgPrice: 82000 },
  currentBalances: { base: 0.006, quote: 0 },
  initialBalances: { base: 0, quote: 492 },
}
const BO = {
  clientOrderId: 'D-BO-red',
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  status: 'FILLED',
  origQty: '0.006',
  executedQty: '0.006',
  price: '82000',
  side: 'BUY',
  updateTime: 1,
}
const REDUCE = {
  clientOrderId: 'D-TPR-red',
  dealId: DEAL_ID,
  typeOrder: 'dealTP',
  status: 'NEW',
  origQty: '0.002',
  executedQty: '0',
  price: '82241.8',
  side: 'SELL',
  reduceFundsId: 'rf-1',
  updateTime: 2,
}

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
    settings,
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

let Helper: any

const buildBot = (orders: any[]) => {
  class TestBot extends Helper {
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
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return info
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async baseAssetPrecision() {
      return 3
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

const tpQty = async (bot: any) =>
  (
    await bot.getTPOrder(
      deal.symbol.symbol,
      deal.lastPrice,
      [],
      deal.avgPrice,
      deal.initialPrice,
      DEAL_ID,
      deal,
    )
  )?.[0]?.qty

describe('take profit next to a resting percentage reduce-funds order', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('../dcaHelper').default(FakeBase as any)
  })

  it('a 40 % reduce resting 0.002 of 0.006: the take profit is 0.004, not the whole position', async () => {
    const bot = buildBot([BO, REDUCE])
    expect(bot.getPendingReduceFunds({ deal }).base).to.be.closeTo(0.002, 1e-12)
    expect(await tpQty(bot)).to.equal(0.004)
  })

  it('no reduce pending: the take profit is the whole position', async () => {
    const bot = buildBot([BO])
    const saved = deal.pendingReduceFunds
    deal.pendingReduceFunds = []
    try {
      expect(await tpQty(bot)).to.equal(0.006)
    } finally {
      deal.pendingReduceFunds = saved
    }
  })

  describe('pendingReduceQty', () => {
    it('a live order is the withdrawal, whatever the request said', () => {
      expect(pendingReduceQty([ENTRY], [REDUCE])).to.deep.equal({
        base: 0.002,
        quote: 0.002 * 82241.8,
      })
    })

    it('a percentage request with no live order withdraws nothing', () => {
      expect(pendingReduceQty([ENTRY], [])).to.deep.equal({
        base: 0,
        quote: 0,
      })
    })

    it('a fixed request with no live order keeps its stated amount (as before)', () => {
      expect(
        pendingReduceQty(
          [{ ...ENTRY, type: 'fixed', asset: 'base', qty: '0.003' }],
          [],
        ).base,
      ).to.equal(0.003)
      expect(
        pendingReduceQty(
          [{ ...ENTRY, type: 'fixed', asset: 'quote', qty: '164.4836' }],
          [],
        ).base,
      ).to.be.closeTo(0.002, 1e-9)
    })

    it('a market request counts nothing (as before)', () => {
      expect(
        pendingReduceQty([{ ...ENTRY, useLimitPrice: false }], [REDUCE]),
      ).to.deep.equal({ base: 0, quote: 0 })
    })
  })
})
