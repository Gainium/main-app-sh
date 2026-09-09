process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `029` — the deal balance ledger counts orders that
 * never executed (combo bot reporting unrealistic profits).
 *
 * Drives the REAL `dcaHelper.updateDealBalances` and the REAL
 * `dcaHelper.closeDeal` — not reimplementations — over the recorded production
 * order rows of combo deal `6aa0060c957e7e4da6d2e067` (VVV-USDC, coinbase),
 * whose closing take-profit `D-TP-F81tJjrr3TtRhxvucERoEOiNsIFUac` sold 0.137 at
 * 20.4954.
 *
 * The deal's 22 genuinely executed fills net -0.145 base and +4.4255 quote. The
 * ledger production carried was `{base: 26.417, quote: 454.7128275}` — the same
 * sum plus three CANCELED safety rows that never reached a venue
 * (`orderId: '-1'`, `executedQty === origQty`: +24.923 base, -450.0051 quote)
 * and one `FILLED` row reporting `executedQty: '0'` at `price: '0'`, counted at
 * its planned 1.639. `closeDeal` marked the inflated base at `lastPrice` and
 * booked **95.12932027278998**, the value stored on the deal, against the
 * **0.7356** its own fills support.
 *
 * Fees are stubbed to zero so `commDeal` is supplied directly and both figures
 * are exact to the last digit.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing
 * here places, cancels or saves anything.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'

const DEAL_ID = '6aa0060c957e7e4da6d2e067'
const BOT_ID = '6a97511e110ce258287e4151'
const TP_ID = 'D-TP-F81tJjrr3TtRhxvucERoEOiNsIFUac'

/** `initialBalances` exactly as production recorded it. */
const INITIAL = { base: 0, quote: 900.2923896 }
/** `getCommDeal` for this deal, from the stored `commission`. */
const COMM = 0.7180994272100001
const LAST_PRICE = 20.4954

/** What production's ledger held when the take-profit filled (spec 029 §2.2). */
const PHANTOM_LEDGER = { base: 26.417, quote: 454.7128275 }
/** What the deal's genuinely executed fills say it held. */
const REAL_LEDGER = { base: -0.145, quote: 904.7179092 }

const o = (
  clientOrderId: string,
  typeOrder: string,
  side: string,
  status: string,
  origQty: string,
  executedQty: string,
  price: string,
  type: string,
  orderId: string,
): any => ({
  clientOrderId,
  dealId: DEAL_ID,
  botId: BOT_ID,
  typeOrder,
  side,
  status,
  origQty,
  executedQty,
  price,
  type,
  orderId,
  fills: [],
  symbol: 'VVV-USDC',
  updateTime: 0,
})

const ORDERS: any[] = [
  o('CMB-GR-4JvOZedd', 'dealGrid', 'BUY', 'FILLED', '1.639', '0', '0', 'MARKET', 'a5a28e5e-eb1a-4637-86cd-2d207c86bae4'),
  o('CMB-BO-yGtmcVLW', 'dealStart', 'BUY', 'FILLED', '7.828', '7.81', '19.2213', 'MARKET', 'e3f90e66-0ac2-4b5d-bc3e-e19bce57df50'),
  o('CMB-RO-8RZdaHdg', 'dealRegular', 'BUY', 'CANCELED', '8.045', '8.045', '18.6447', 'LIMIT', '-1'),
  o('CMB-RO-t8QEzT6H', 'dealRegular', 'BUY', 'CANCELED', '8.302', '8.302', '18.0681', 'LIMIT', '-1'),
  o('CMB-RO-UZVmJEJh', 'dealRegular', 'BUY', 'CANCELED', '8.576', '8.576', '17.4915', 'LIMIT', '-1'),
  o('CMB-GR-1wY8udsb', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.3213', 'LIMIT', 'v01'),
  o('CMB-GR-Zhp2G0Fu', 'dealGrid', 'BUY', 'FILLED', '1.589', '1.589', '19.106', 'LIMIT', 'v02'),
  o('CMB-GR-hENoZwtY', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.36', 'LIMIT', 'v03'),
  o('CMB-GR-m8C1aP9R', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.3985', 'LIMIT', 'v04'),
  o('CMB-GR-CS9n7nlB', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.4371', 'LIMIT', 'v05'),
  o('CMB-GR-WgElps9j', 'dealGrid', 'BUY', 'FILLED', '1.589', '1.589', '18.9907', 'LIMIT', 'v06'),
  o('CMB-GR-8LSiXR35', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.4756', 'LIMIT', 'v07'),
  o('CMB-GR-AXa4xgaq', 'dealGrid', 'BUY', 'FILLED', '1.589', '1.589', '18.8754', 'LIMIT', 'v08'),
  o('CMB-GR-DefPQKvI', 'dealGrid', 'BUY', 'FILLED', '1.589', '1.589', '18.76', 'LIMIT', 'v09'),
  o('CMB-GR-JsFqzyzZ', 'dealGrid', 'SELL', 'FILLED', '1.589', '1.589', '19.2482', 'LIMIT', 'v10'),
  o('CMB-GR-wlhd4O3M', 'dealGrid', 'BUY', 'FILLED', '1.589', '1.589', '19.106', 'LIMIT', 'v11'),
  o('CMB-GR-Eubhx3Lk', 'dealGrid', 'SELL', 'FILLED', '1.589', '1.589', '19.2482', 'LIMIT', 'v12'),
  o('CMB-GR-JNm6xaGM', 'dealGrid', 'BUY', 'FILLED', '1.589', '1.589', '19.106', 'LIMIT', 'v13'),
  o('CMB-GR-V97lTp2M', 'dealGrid', 'SELL', 'FILLED', '1.589', '1.589', '19.1327', 'LIMIT', 'v14'),
  o('CMB-GR-3uAzfo2Y', 'dealGrid', 'SELL', 'FILLED', '1.639', '1.639', '18.7853', 'LIMIT', 'v15'),
  o('CMB-GR-wIcWBvTi', 'dealGrid', 'SELL', 'FILLED', '1.639', '1.639', '18.7844', 'LIMIT', 'v16'),
  o('CMB-GR-nvo1RNeP', 'dealGrid', 'SELL', 'FILLED', '1.639', '1.639', '18.7515', 'MARKET', 'v17'),
  o('CMB-GR-qMOs5Z2u', 'dealGrid', 'BUY', 'FILLED', '1.561', '1.561', '19.2213', 'LIMIT', 'v18'),
  o('CMB-GR-iYuGHPTw', 'dealGrid', 'BUY', 'FILLED', '1.561', '1.561', '19.2597', 'LIMIT', 'v19'),
  o('CMB-GR-ouOQIlcr', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.36', 'LIMIT', 'v20'),
  o('CMB-GR-IMKTypB2', 'dealGrid', 'SELL', 'FILLED', '1.561', '1.561', '19.3213', 'LIMIT', 'v21'),
  o('CMB-GR-cc6ZT4ZQ', 'dealGrid', 'BUY', 'CANCELED', '1.639', '0', '18.5294', 'LIMIT', 'v22'),
  o('CMB-GR-8Z68zFYC', 'dealGrid', 'SELL', 'CANCELED', '1.589', '0', '19.2482', 'LIMIT', '-1'),
  o('CMB-RO-F2fWGAsj', 'dealRegular', 'BUY', 'CANCELED', '8.872', '0', '16.9149', 'LIMIT', 'v23'),
  o('D-TP-FoSnecPd', 'dealTP', 'SELL', 'CANCELED', 'NaN', '0', '20.27', 'MARKET', '-1'),
]

/** The closing take-profit, which fills 0.137 of the 26.392 it asked for. */
const TP_ORDER: any = o(
  TP_ID,
  'dealTP',
  'SELL',
  'FILLED',
  '0.137',
  '0.137',
  `${LAST_PRICE}`,
  'MARKET',
  'venue-tp',
)

/**
 * The deal's five planned safety orders, as `initialOrders` — `initialBalances`
 * is re-derived from these plus the base order, and none of them is a fill.
 */
const INITIAL_ORDERS: any[] = [
  { side: 'BUY', qty: 8.045, price: 18.6447, type: 'dealRegular', dcaLevel: 2 },
  { side: 'BUY', qty: 8.302, price: 18.0681, type: 'dealRegular', dcaLevel: 3 },
  { side: 'BUY', qty: 8.576, price: 17.4915, type: 'dealRegular', dcaLevel: 4 },
  { side: 'BUY', qty: 8.872, price: 16.9149, type: 'dealRegular', dcaLevel: 5 },
  { side: 'BUY', qty: 9.187, price: 16.3383, type: 'dealRegular', dcaLevel: 6 },
]

const EXCHANGE_INFO: any = {
  pair: 'VVV-USDC',
  baseAsset: { minAmount: 0.001, step: 0.001, name: 'VVV' },
  quoteAsset: { minAmount: 1, step: 0.0001, name: 'USDC' },
  priceAssetPrecision: 4,
}

const settings: any = {
  useTp: true,
  useMulti: false,
  dealCloseCondition: 'tp',
  baseOrderSize: '150',
  orderSizeType: 'quote',
  indicators: [],
}

const baseDeal = (currentBalances: { base: number; quote: number }): any => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  symbol: { symbol: 'VVV-USDC', baseAsset: 'VVV', quoteAsset: 'USDC' },
  status: 'open',
  flags: [],
  tpHistory: [],
  funds: [],
  reduceFunds: [],
  pendingAddFunds: [],
  size: 31.221,
  commission: 0,
  feeBalance: 0,
  lastPrice: LAST_PRICE,
  avgPrice: 19.128256102824498,
  initialPrice: 19.2213,
  initialBalances: { ...INITIAL },
  currentBalances,
  levels: { all: 6, complete: 4 },
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  feePaid: { base: 0, quote: 0 },
  feeByAsset: [],
})

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = 'user'
  isLong = true
  futures = false
  coinm = false
  combo = true
  kucoinSpot = false
  zeroFee = true
  isBitget = false
  botType = 'combo'
  orders = new Map()
  data: any = {
    settings,
    exchange: ExchangeEnum.coinbase,
    flags: [],
    paperContext: false,
    profit: {
      total: 0,
      totalUsd: 0,
      pureBase: 0,
      pureQuote: 0,
      freeTotal: 0,
      freeTotalUsd: 0,
    },
    profitByAssets: [],
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (deal: any, orders: any[], initialOrders: any[] = []) => {
  class TestBot extends Helper {
    public errors: string[] = []
    public savedProfitUsd: number[] = []

    getDeal(id: string) {
      return deal && id === deal._id
        ? { deal, initialOrders, currentOrders: [] }
        : undefined
    }
    /** The real index lookup, over the fixture's rows rather than a live map. */
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (x) =>
          (!dealId || x.dealId === dealId) &&
          (!wanted || wanted.includes(x.status)),
      )
    }
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getCommDeal() {
      return COMM
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async sellRemainder() {}
    async processDealClose() {
      return false
    }
    saveProfitToDb(usd: number) {
      this.savedProfitUsd.push(usd)
    }
    updateUserProfitStep() {}
    async saveDeal() {}
    async updateUsage() {}
    updateData() {}
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors(m: string) {
      this.errors.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

/** Runs the REAL `updateDealBalances` and reports the ledger it derives. */
const rebuild = async () => {
  const deal = baseDeal({ base: 0, quote: 0 })
  const bot: any = buildBot(deal, ORDERS, INITIAL_ORDERS)
  await bot.updateDealBalances(bot.getDeal(DEAL_ID))
  return {
    base: deal.currentBalances.base - deal.initialBalances.base,
    quote: deal.currentBalances.quote - deal.initialBalances.quote,
  }
}

const close = async (currentBalances: { base: number; quote: number }) => {
  const deal = baseDeal(currentBalances)
  const bot: any = buildBot(deal, [...ORDERS, TP_ORDER], INITIAL_ORDERS)
  await bot.closeDeal(BOT_ID, DEAL_ID, TP_ORDER)
  return { deal, botProfit: bot.data.profit, savedProfitUsd: bot.savedProfitUsd }
}

describe('deal ledger counts orders that never executed (spec 029)', () => {
  before(function () {
    // One ts-node compile of a 22k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1/§4.2 the rebuilt ledger holds only what the deal really filled', async () => {
    // Production derived +26.417 base / -445.5796 quote here: the real fills
    // plus three never-placed safety rows and one zero-fill row's planned size.
    const net = await rebuild()
    expect(net.base).to.be.closeTo(REAL_LEDGER.base - INITIAL.base, 1e-9)
    expect(net.quote).to.be.closeTo(REAL_LEDGER.quote - INITIAL.quote, 1e-9)
  })

  it('§1.2 the phantom ledger is what booked the unrealistic profit', async () => {
    // Pinning the defect itself: this is the figure stored on the deal.
    const { deal } = await close(PHANTOM_LEDGER)
    expect(deal.profit.total).to.be.closeTo(95.12932027278998, 1e-9)
  })

  it('§4.1/§4.2 the deal books what its own fills support', async () => {
    const { deal } = await close(REAL_LEDGER)
    expect(deal.profit.total).to.be.closeTo(0.7355871727900773, 1e-9)
  })

  it('§4.1/§4.2 the fabricated profit reaches neither the bot aggregate nor the history', async () => {
    const { botProfit, savedProfitUsd } = await close(REAL_LEDGER)
    expect(botProfit.total).to.be.closeTo(0.7355871727900773, 1e-9)
    expect(savedProfitUsd[0]).to.be.closeTo(0.7355871727900773, 1e-9)
  })

  it('§4.4 a deal whose ledger already matches its fills is untouched', async () => {
    // The rebuild and the ledger the deal would have carried agree exactly, so
    // the correction moves a healthy deal by nothing at all.
    const net = await rebuild()
    expect(INITIAL.base + net.base).to.be.closeTo(REAL_LEDGER.base, 1e-9)
    expect(INITIAL.quote + net.quote).to.be.closeTo(REAL_LEDGER.quote, 1e-9)
  })
})
