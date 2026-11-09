process.env.NODE_ENV = 'testing'

/**
 * A long DCA ladder whose step shrinks below one price tick, and a market that
 * gaps through its last levels, must keep its smart orders working.
 *
 * Drives the REAL `dcaHelper.createInitialDealOrders` and
 * `createCurrentDealOrders` on a minimal base class (same approach as
 * `gridBreakpointBounds.harness.spec.ts`): no stack, DB, Redis or exchange
 * connection. Nothing here places or cancels anything.
 *
 * Fixture (`convergingLadder.fixture.json`): a recorded deal, XRP-EUR (tick
 * 1e-5), 200 levels, step 2.1 %, step scale 0.88 from 1.18458. The closed-form
 * depth of that ladder is 17.5 % (0.97728), but its levels converge below one
 * tick from about level 60, so the "not behind the previous level" rule keeps
 * pushing each one a tick deeper and the real ladder runs on to ~0.9757. A fast
 * drop filled 174 levels, 67 of them moved to the market (breakpoints), and
 * left the last fill at 0.97494 with 26 levels unfilled.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum } from '../../../types'
import { createRequire } from 'module'
import fixture from './convergingLadder.fixture.json'

const baseSettings: any = {
  useDca: true,
  useTp: true,
  useSl: false,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dcaCondition: 'percentage',
  scaleDcaType: 'percentage',
  dcaVolumeBaseOn: 'scale',
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  strategy: 'LONG',
  ordersCount: 200,
  activeOrdersCount: 5,
  useSmartOrders: true,
  orderSizeType: 'quote',
  orderSize: '2473.8',
  baseOrderSize: '3710.7',
  step: '2.1',
  stepScale: '0.88',
  volumeScale: '1',
  tpPerc: '1',
  slPerc: '-10',
  indicators: [],
  indicatorGroups: [],
}

const EXCHANGE_INFO: any = {
  pair: 'XRP-EUR',
  baseAsset: { minAmount: 0, maxAmount: 0, step: 0.00000001, name: 'XRP' },
  quoteAsset: { minAmount: 0, step: 0.01, precision: 2, name: 'EUR' },
  priceAssetPrecision: 5,
}

const DEAL_ID = 'converging-ladder-deal'
const START: number = fixture.start

class FakeBase {
  math = new MathHelper()
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
  orders = new Map()
  ordersInBetweenUpdates = new Set()
  data: any = {
    settings: baseSettings,
    exchange: ExchangeEnum.kraken,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Row = { price: string; origPrice: string; status: string }

const makeBot = (rows: Row[], latestPrice: number, deal: any) => {
  const settings = { ...baseSettings }
  const orderRows = rows.map((r, i) => ({
    clientOrderId: `D-RO-${i}`,
    dealId: DEAL_ID,
    side: 'BUY',
    typeOrder: TypeOrderEnum.dealRegular,
    origQty: '1',
    ...r,
  }))
  class TestBot extends Helper {
    saved: any[] = []
    logs: string[] = []
    getDeal() {
      return { deal, initialOrders: [], currentOrders: [] }
    }
    getOrdersByStatusAndDealId(opts: any = {}) {
      const statuses: string[] = opts.defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : Array.isArray(opts.status)
          ? opts.status
          : opts.status
            ? [opts.status]
            : []
      return orderRows.filter((o) => statuses.includes(o.status))
    }
    findBaseOrderByDeal() {
      return undefined
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async baseAssetPrecision() {
      return 8
    }
    async getUsdRate() {
      return 1
    }
    async profitBase() {
      return false
    }
    async getLatestPrice() {
      return latestPrice
    }
    async getTPOrder() {
      return []
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    getOrderId(prefix: string) {
      return `${prefix}-converging`
    }
    saveDeal(_d: any, update: any) {
      this.saved.push(update)
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.isLong = true
  bot.data.settings = settings
  return bot
}

const regularPrices = (orders: any[]) =>
  orders.filter((o) => o.type === 'dealRegular').map((o) => o.price)

const filledRows = (): Row[] =>
  fixture.filledOrigPrices.map((p: number) => ({
    price: `${p}`,
    origPrice: `${p}`,
    status: 'FILLED',
  }))

/** One checked rebuild, as a fill, a reload or "Restart deal" runs it. */
const rebuild = async (latestPrice: number, price: number) => {
  const deal: any = {
    _id: DEAL_ID,
    initialPrice: START,
    gridBreakpoints: fixture.breakpoints.map((b: any) => ({ ...b })),
    symbol: { symbol: 'XRP-EUR' },
    settings: {},
  }
  const bot = makeBot(filledRows(), latestPrice, deal)
  const initial = await bot.createInitialDealOrders(
    'XRP-EUR',
    START,
    DEAL_ID,
    deal,
  )
  const current = await bot.createCurrentDealOrders(
    'XRP-EUR',
    price,
    initial,
    0.9862,
    START,
    DEAL_ID,
    false,
    deal,
    false,
  )
  return {
    initial: regularPrices(initial),
    current: regularPrices(current),
    deal,
    bot,
  }
}

describe('a converging DCA ladder keeps its smart orders after a gap', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('rebuilds the recorded deal with five smart orders below its last fill', async () => {
    // "Restart deal": a checked rebuild at the last fill, market 0.97572.
    const { current, deal } = await rebuild(0.97572, fixture.lastFill)
    expect(current).to.deep.equal([0.97459, 0.97458, 0.97457, 0.97456, 0.97455])
    // Nothing at or above the last fill: no level that has filled is re-sent.
    expect(Math.max(...current)).to.be.lessThan(fixture.lastFill)
    for (const p of current) {
      expect(fixture.filledOrigPrices).to.not.include(p)
    }
    // A rebuild below the market needs no new breakpoint.
    expect(deal.gridBreakpoints).to.have.length(fixture.breakpoints.length)
  })

  it('keeps the ladder reaching past the last fill while levels remain', async () => {
    // With the breakpoints past the closed-form depth discarded, the ladder
    // ended at 0.97597, above the last fill: no unfilled level could ever be
    // below it, so no smart order was ever placed again.
    const { initial } = await rebuild(0.97572, fixture.lastFill)
    expect(initial).to.have.length(200)
    const deeper = initial.filter((p: number) => p < fixture.lastFill)
    expect(deeper.length).to.be.at.least(200 - fixture.filledOrigPrices.length)
  })

  it('still refuses a wick far past the ladder', async () => {
    // Market at a wick to ~1 % of the price; the next level gaps.
    const { current, deal } = await rebuild(0.0098, 0.9746)
    expect(deal.gridBreakpoints).to.have.length(fixture.breakpoints.length)
    expect(Math.min(...current)).to.be.greaterThan(0.9)
  })
})
