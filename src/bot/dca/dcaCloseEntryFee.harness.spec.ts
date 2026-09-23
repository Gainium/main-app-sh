process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `098.a-dca-close-is-sized-gross-of-the-entry-fee-the-venue-took-in-base`.
 *
 * Drives the REAL `dcaHelper.getTPOrder` non-combo (DCA) path over the shape
 * of two production long spot deals on accounts flagged `zeroFee`
 * (`getUserFee` → {maker 0, taker 0}) whose venue nevertheless charged the
 * entry fee in the coin bought:
 *
 *   BNBUSDT   entry 0.015 BNB, commission 0.000015 BNB → holds 0.014985;
 *             close sent for 0.015, refused for balance.
 *   BONKUSDT  entry 6,132,596 BONK, commission 0.1% in BONK → holds
 *             6,126,463.4; close sent for 6,132,596, refused for balance.
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
  baseOrderSize: '10',
  orderSizeType: 'quote',
  indicators: [],
}

type Pair = {
  info: any
  precision: number
  deal: any
  bo: any
}

const bnbDealId = 'deal-bnb'
const BNB: Pair = {
  info: {
    baseAsset: { minAmount: 0.001, step: 0.001, asset: 'BNB' },
    quoteAsset: { minAmount: 5, step: 0.01, asset: 'USDT' },
    priceAssetPrecision: 2,
  },
  precision: 3,
  deal: {
    _id: bnbDealId,
    symbol: { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT' },
    status: 'open',
    size: 0.015,
    tpHistory: [],
    reduceFunds: [],
    funds: [],
    flags: [],
    lastPrice: 620,
    avgPrice: 620,
    initialPrice: 620,
    settings: { avgPrice: 620 },
    currentBalances: { base: 0.015, quote: 0 },
    initialBalances: { base: 0, quote: 9.3 },
  },
  bo: {
    clientOrderId: 'D-BO-bnb',
    dealId: bnbDealId,
    typeOrder: 'dealStart',
    status: 'FILLED',
    origQty: '0.015',
    executedQty: '0.015',
    price: '620',
    side: 'BUY',
    feePaid: 0.000015,
    feeAsset: 'BNB',
    updateTime: 1,
  },
}

const bonkDealId = 'deal-bonk'
const BONK: Pair = {
  info: {
    baseAsset: { minAmount: 1, step: 1, asset: 'BONK' },
    quoteAsset: { minAmount: 5, step: 0.00000001, asset: 'USDT' },
    priceAssetPrecision: 8,
  },
  precision: 0,
  deal: {
    _id: bonkDealId,
    symbol: { symbol: 'BONKUSDT', baseAsset: 'BONK', quoteAsset: 'USDT' },
    status: 'open',
    size: 6132596,
    tpHistory: [],
    reduceFunds: [],
    funds: [],
    flags: [],
    lastPrice: 0.00000364,
    avgPrice: 0.00000364,
    initialPrice: 0.00000364,
    settings: { avgPrice: 0.00000364 },
    currentBalances: { base: 6132596, quote: 0 },
    initialBalances: { base: 0, quote: 22.32 },
  },
  bo: {
    clientOrderId: 'D-BO-bonk',
    dealId: bonkDealId,
    typeOrder: 'dealStart',
    status: 'FILLED',
    origQty: '6132596',
    executedQty: '6132596',
    price: '0.00000364',
    side: 'BUY',
    feePaid: 6132.596,
    feeAsset: 'BONK',
    updateTime: 1,
  },
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
  zeroFee = true
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

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  pair: Pair,
  orders: any[],
  opts: {
    fee?: { maker: number; taker: number }
    zeroFee?: boolean
    deal?: any
  } = {},
) => {
  const fee = opts.fee ?? { maker: 0, taker: 0 }
  const deal = opts.deal ?? pair.deal
  class TestBot extends Helper {
    zeroFee = opts.zeroFee ?? true
    getDeal(id: string) {
      return id === deal._id
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
      return pair.info
    }
    async getUserFee() {
      return fee
    }
    async baseAssetPrecision() {
      return pair.precision
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

const tpQty = async (bot: any, deal: any) => {
  const tps = await bot.getTPOrder(
    deal.symbol.symbol,
    deal.lastPrice,
    [],
    deal.avgPrice,
    deal.initialPrice,
    deal._id,
    deal,
  )
  return tps?.[0]?.qty
}

describe('DCA close sizing net of the observed base entry fee (spec 098)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 zeroFee account, BNB entry fee taken in BNB: close fits what the deal holds', async () => {
    // Production sent 0.015 against 0.014985 held and was refused.
    expect(await tpQty(buildBot(BNB, [BNB.bo]), BNB.deal)).to.equal(0.014)
  })

  it('§4.1 zeroFee account, BONK entry fee taken in BONK: close fits what the deal holds', async () => {
    // Production sent 6,132,596 against 6,126,463.41 held and was refused.
    expect(await tpQty(buildBot(BONK, [BONK.bo]), BONK.deal)).to.equal(6126463)
  })

  it('§4.1 the observed fee is summed across every filled entry row', async () => {
    const half = (o: any, id: string, typeOrder: string) => ({
      ...o,
      clientOrderId: id,
      typeOrder,
      origQty: '3066298',
      executedQty: '3066298',
      feePaid: 3066.298,
    })
    const orders = [
      half(BONK.bo, 'D-BO-bonk', 'dealStart'),
      half(BONK.bo, 'D-RO-bonk', 'dealRegular'),
    ]
    expect(await tpQty(buildBot(BONK, orders), BONK.deal)).to.equal(6126463)
  })

  it('§4.2 configured-rate account, observed ≈ estimate: unchanged', async () => {
    const bot = buildBot(BNB, [BNB.bo], {
      zeroFee: false,
      fee: { maker: 0.001, taker: 0.001 },
    })
    // 0.015 × 0.999 = 0.014985 → floored onto the 0.001 grid, as before.
    expect(await tpQty(bot, BNB.deal)).to.equal(0.014)
  })

  it('§4.2 zeroFee account, fee reported in quote: unchanged (gross)', async () => {
    const quoteFee = { ...BNB.bo, feePaid: 0.0093, feeAsset: 'USDT' }
    expect(await tpQty(buildBot(BNB, [quoteFee]), BNB.deal)).to.equal(0.015)
  })

  it('§4.2 zeroFee account, row with no fee data: unchanged (gross)', async () => {
    const noFee = { ...BNB.bo, feePaid: undefined, feeAsset: undefined }
    expect(await tpQty(buildBot(BNB, [noFee]), BNB.deal)).to.equal(0.015)
  })

  it('§4.3 all-third-asset deal keeps the spec-015 gate (gross)', async () => {
    const thirdAsset = { ...BONK.bo, feePaid: 0.00002, feeAsset: 'BNB' }
    const deal = { ...BONK.deal, flags: ['feeByAsset'] }
    const bot = buildBot(BONK, [thirdAsset], {
      zeroFee: false,
      fee: { maker: 0.001, taker: 0.001 },
      deal,
    })
    expect(await tpQty(bot, deal)).to.equal(6132596)
  })
})
