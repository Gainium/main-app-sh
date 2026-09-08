process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `024.deal-close-books-a-full-volume-loss-from-a-lost-ledger` (issue #716).
 *
 * Drives the REAL `dcaHelper.closeDeal` — not a reimplementation — over the
 * recorded production state of deal `6a9fca447794d53dedbab119` (SWFTC-USDC,
 * coinbase, user `6a8b1db88e06bef801d752bd`), whose closing take-profit
 * `D-TP-m2hygo2sAbY4CBFiarHyCGPBgZ1aVx` is the order named in the report.
 *
 * The deal's `currentBalances` reached `closeDeal` as `{base: 0, quote: 0}`:
 * a NaN (spec `023`) had been laundered into `null` by the Redis deal mirror
 * (`JSON.stringify(NaN) === 'null'`) and restored on a worker restart, and
 * `null + x === x`. `closeDeal` booked
 * `profit.total = -initialBalances.quote - commDeal` = **-2292.60**, a loss
 * equal to the deal's entire allocated volume, against a real result of
 * **-2.26** (spec §2.2).
 *
 * Fees are stubbed to zero so `commDeal` is 0 and both figures are exact:
 *
 *   lost ledger  {0, 0}                  -> booked -2292.597354  (the defect)
 *   real ledger  {51093, 2159.484224}    -> booked    -2.263957  (the truth)
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

const DEAL_ID = '6a9fca447794d53dedbab119'
const TP_ID = 'D-TP-m2hygo2sAbY4CBFiarHyCGPBgZ1aVx'

const settings: any = {
  useTp: true,
  useMulti: false,
  dealCloseCondition: 'tp',
  baseOrderSize: '100',
  orderSizeType: 'quote',
  indicators: [],
}

const EXCHANGE_INFO: any = {
  pair: 'SWFTC-USDC',
  baseAsset: { minAmount: 1, step: 1, name: 'SWFTC' },
  quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
  priceAssetPrecision: 6,
}

/** The deal's four orders exactly as production recorded them. */
const ORDERS: any[] = [
  {
    clientOrderId: 'D-BO-8t0eFTPDVllORQ6vlL2OjYVClkdNph',
    dealId: DEAL_ID,
    side: 'BUY',
    status: 'FILLED',
    type: 'MARKET',
    typeOrder: 'dealStart',
    executedQty: '38332',
    price: '0.002611739121360743',
    symbol: 'SWFTC-USDC',
  },
  {
    clientOrderId: 'D-RO-1GBhbHbbPJ0HB0hIUWr4iYxzVWzVEi',
    dealId: DEAL_ID,
    side: 'BUY',
    status: 'FILLED',
    type: 'LIMIT',
    typeOrder: 'dealRegular',
    executedQty: '12761',
    price: '0.002586',
    symbol: 'SWFTC-USDC',
  },
  {
    // Never filled — must contribute nothing.
    clientOrderId: 'D-RO-MvJsMEFQy7BZ20xqM0rWyGzVDTYkOy',
    dealId: DEAL_ID,
    side: 'BUY',
    status: 'FILLED',
    type: 'MARKET',
    typeOrder: 'dealRegular',
    executedQty: '0',
    price: '0',
    symbol: 'SWFTC-USDC',
  },
  {
    clientOrderId: TP_ID,
    dealId: DEAL_ID,
    side: 'SELL',
    status: 'FILLED',
    type: 'LIMIT',
    typeOrder: 'dealTP',
    executedQty: '51029',
    price: '0.002561',
    symbol: 'SWFTC-USDC',
  },
]

const TP_ORDER: any = ORDERS[3]

const baseDeal = (currentBalances: { base: number; quote: number }): any => ({
  _id: DEAL_ID,
  botId: '6a8b89e98e06bef801add796',
  symbol: { symbol: 'SWFTC-USDC', baseAsset: 'SWFTC', quoteAsset: 'USDC' },
  status: 'open',
  flags: [],
  tpHistory: [],
  funds: [],
  reduceFunds: [],
  size: 51029,
  commission: 0,
  feeBalance: 0,
  lastPrice: 0.002561,
  avgPrice: 0.002605506233730648,
  initialPrice: 0.002611739121360743,
  initialBalances: { base: 0, quote: 2292.5973539999995 },
  currentBalances,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  feePaid: { base: 0, quote: 0 },
  feeByAsset: [],
})

/** What production actually handed `closeDeal`. */
const LOST_LEDGER = { base: 0, quote: 0 }
/** What the deal's own fills say the ledger was (spec §2.2). */
const REAL_LEDGER = { base: 51093, quote: 2159.4842239999997 }

class FakeBase {
  math = new MathHelper()
  botId = '6a8b89e98e06bef801add796'
  userId = '6a8b1db88e06bef801d752bd'
  isLong = true
  futures = false
  coinm = false
  combo = false
  kucoinSpot = false
  zeroFee = true
  isBitget = false
  botType = 'dca'
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

const buildBot = (deal: any, orders: any[]) => {
  class TestBot extends Helper {
    public errors: string[] = []
    public savedProfitUsd: number[] = []
    public soldRemainder = false

    getDeal(id: string) {
      return deal && id === deal._id
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    /** The real index lookup, over the fixture's map rather than a live one. */
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
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async sellRemainder() {
      this.soldRemainder = true
    }
    async processDealClose() {
      return false
    }
    saveProfitToDb(usd: number) {
      this.savedProfitUsd.push(usd)
    }
    updateUserProfitStep() {}
    async saveDeal() {}
    updateData() {}
    emit() {}
    updateDealBalances() {}
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

const close = async (
  currentBalances: { base: number; quote: number },
  orders: any[] = ORDERS,
  tp: any = TP_ORDER,
  dealOverrides: any = {},
) => {
  const deal = { ...baseDeal(currentBalances), ...dealOverrides }
  const bot: any = buildBot(deal, orders)
  await bot.closeDeal(bot.botId, deal._id, tp)
  return {
    deal,
    errors: bot.errors as string[],
    savedProfitUsd: bot.savedProfitUsd as number[],
    soldRemainder: bot.soldRemainder as boolean,
    botProfit: bot.data.profit,
  }
}

describe('closeDeal lost-ledger reconciliation (spec 024, issue #716)', () => {
  before(function () {
    // One ts-node compile of a 22k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 does not book a loss equal to the deal’s whole allocated volume', async () => {
    // Production booked -2292.779482 here: `-initialBalances.quote - commDeal`,
    // the signature of line 2384 having been applied to a `{0, 0}` ledger.
    const { deal } = await close(LOST_LEDGER)
    const allocated = deal.initialBalances.quote
    expect(Math.abs(deal.profit.total + allocated)).to.be.greaterThan(
      100,
      `closeDeal booked ${deal.profit.total} against allocated ${allocated}`,
    )
  })

  it('§4.1 books what the deal’s own fills say it made', async () => {
    const { deal } = await close(LOST_LEDGER)
    expect(deal.profit.total).to.be.closeTo(-2.263957, 1e-6)
  })

  it('§4.1 rebuilds the ledger itself, not only the profit figure', async () => {
    // 51093 bought, 51029 sold: 64 left over (the base-denominated fee), and
    // the quote side back to its real value plus the sale proceeds.
    const { deal } = await close(LOST_LEDGER)
    expect(deal.currentBalances.base).to.be.closeTo(64, 1e-6)
    expect(deal.currentBalances.quote).to.be.closeTo(2290.169493, 1e-6)
  })

  it('§4.1 says so loudly rather than silently repairing', async () => {
    const { errors } = await close(LOST_LEDGER)
    expect(errors.join('\n')).to.contain('ledger')
  })

  it('§4.1 the fabricated loss never reaches the bot aggregate or profit history', async () => {
    const { botProfit, savedProfitUsd } = await close(LOST_LEDGER)
    expect(botProfit.total).to.be.closeTo(-2.263957, 1e-6)
    expect(savedProfitUsd[0]).to.be.closeTo(-2.263957, 1e-6)
  })

  it('§4.2 a healthy deal books exactly the same figure, untouched', async () => {
    // The guard must not move a single unit when the ledger is intact: the
    // real ledger and the repaired one have to agree to the last decimal.
    const healthy = await close(REAL_LEDGER)
    expect(healthy.deal.profit.total).to.be.closeTo(-2.263957, 1e-6)
    expect(healthy.deal.currentBalances.base).to.be.closeTo(64, 1e-6)
    expect(healthy.deal.currentBalances.quote).to.be.closeTo(2290.169493, 1e-6)
    expect(healthy.errors).to.have.length(0)
  })

  it('§4.2 a zero ledger with no filled orders is left alone', async () => {
    // Nothing to reconcile from — the guard must not invent a ledger. Only
    // the closing take-profit exists, so the old arithmetic still stands.
    const { deal } = await close(LOST_LEDGER, [TP_ORDER])
    expect(deal.currentBalances.base).to.be.closeTo(-51029, 1e-6)
  })

  it('§4.1 a non-finite ledger is reconciled too, not just a zeroed one', async () => {
    // The value the Redis mirror actually held was `null`; a NaN can reach
    // closeDeal directly without a restart.
    const nan = await close({ base: NaN, quote: NaN })
    expect(nan.deal.profit.total).to.be.closeTo(-2.263957, 1e-6)
    const nulls = await close({ base: null, quote: null } as any)
    expect(nulls.deal.profit.total).to.be.closeTo(-2.263957, 1e-6)
  })

  it('§4.3 an add-funds (ROA) fill only moves the side it credited', async () => {
    // ROA fills move `initialBalances` as well (dcaHelper L7424-7439), so the
    // quote they were paid for must NOT be subtracted again here — doing so
    // understates the ledger by the whole added amount.
    const roaOrders: any[] = [
      {
        clientOrderId: 'D-BO-roa-fixture',
        dealId: 'roa-deal',
        side: 'BUY',
        status: 'FILLED',
        type: 'LIMIT',
        typeOrder: 'dealStart',
        executedQty: '1000',
        price: '0.05',
        symbol: 'SWFTC-USDC',
      },
      {
        clientOrderId: 'D-ROA-fixture',
        dealId: 'roa-deal',
        side: 'BUY',
        status: 'FILLED',
        type: 'LIMIT',
        typeOrder: 'dealRegular',
        executedQty: '500',
        price: '0.05',
        symbol: 'SWFTC-USDC',
      },
      {
        clientOrderId: 'D-TP-roa-fixture',
        dealId: 'roa-deal',
        side: 'SELL',
        status: 'FILLED',
        type: 'LIMIT',
        typeOrder: 'dealTP',
        executedQty: '1500',
        price: '0.06',
        symbol: 'SWFTC-USDC',
      },
    ]
    const { deal } = await close(LOST_LEDGER, roaOrders, roaOrders[2], {
      _id: 'roa-deal',
      size: 1500,
      lastPrice: 0.06,
      avgPrice: 0.05,
      initialBalances: { base: 0, quote: 125 },
    })
    // Pre-close ledger {1500, 75}; close adds (-1500, +90) -> {0, 165}.
    // total = 165 - 125 = 40. Treating the ROA like a normal buy would
    // subtract its 25 quote twice and book 15.
    expect(deal.currentBalances.quote).to.be.closeTo(165, 1e-6)
    expect(deal.profit.total).to.be.closeTo(40, 1e-6)
  })
})
