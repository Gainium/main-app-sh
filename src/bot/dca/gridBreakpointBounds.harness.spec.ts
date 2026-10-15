process.env.NODE_ENV = 'testing'

/**
 * Spec `164`: a flash-wick breakpoint must not wreck the DCA ladder.
 *
 * Drives the REAL `dcaHelper.createInitialDealOrders` and
 * `createCurrentDealOrders` on a minimal base class (same approach as
 * `ladderRounding.harness.spec.ts`): no stack, DB, Redis or exchange
 * connection. Nothing here places or cancels anything.
 *
 * The fixture is the recorded deal: Kraken 0G/USD (tick 0.001), a 1% ladder
 * started at 0.315, raised to 35 levels. A one-second wick to 0.002 during a
 * burst of five safety-order fills stored `{0.258→0.002}` and `{0.255→0.002}`.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum } from '../../../types'
import { createRequire } from 'module'

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
  ordersCount: 35,
  activeOrdersCount: 5,
  orderSizeType: 'quote',
  orderSize: '10',
  baseOrderSize: '20',
  step: '1',
  stepScale: '1',
  volumeScale: '1.05',
  tpPerc: '1',
  slPerc: '-10',
  indicators: [],
  indicatorGroups: [],
}

const EXCHANGE_INFO: any = {
  pair: '0G-USD',
  baseAsset: { minAmount: 0, maxAmount: 0, step: 0.01, name: '0G' },
  quoteAsset: { minAmount: 0, step: 0.01, precision: 2, name: 'USD' },
  priceAssetPrecision: 3,
}

const DEAL_ID = 'wick-breakpoint-deal'
const START = 0.315
const WICK = [
  { price: 0.258, displacedPrice: 0.002 },
  { price: 0.255, displacedPrice: 0.002 },
]

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

const makeBot = (
  overrides: any,
  rows: Row[] = [],
  latestPrice = 0,
  deal?: any,
) => {
  const settings = { ...baseSettings, ...overrides }
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
    getDeal() {
      return deal ? { deal, initialOrders: [], currentOrders: [] } : undefined
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
      return 2
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
      return `${prefix}-wick`
    }
    saveDeal(_d: any, update: any) {
      this.saved.push(update)
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
  const bot: any = new TestBot()
  bot.isLong = settings.strategy === 'LONG'
  bot.data.settings = settings
  return bot
}

const regularPrices = (orders: any[]) =>
  orders.filter((o) => o.type === 'dealRegular').map((o) => o.price)

const ladder = async (overrides: any, gridBreakpoints: any[]) => {
  const bot = makeBot(overrides)
  return regularPrices(
    await bot.createInitialDealOrders('0G-USD', START, DEAL_ID, {
      _id: DEAL_ID,
      initialPrice: START,
      gridBreakpoints,
    }),
  )
}

const filled = (prices: number[]): Row[] =>
  prices.map((p) => ({
    price: `${p}`,
    origPrice: `${p}`,
    status: 'FILLED',
  }))

describe('spec 164 — a flash-wick breakpoint must not wreck the DCA ladder', () => {
  before(function () {
    // One ts-node compile of a 27k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§1.3 ignores stored breakpoints beyond the deepest level when the ladder is built', async () => {
    const clean = await ladder({}, [])
    expect(clean).to.have.length(35)
    expect(clean[34]).to.equal(0.205)
    const withWick = await ladder({}, WICK)
    expect(withWick).to.deep.equal(clean)
  })

  it('§1.3 ignores a breakpoint that is not a positive finite price on every ladder type', async () => {
    for (const displacedPrice of [0, -1, NaN]) {
      const custom = {
        dcaCondition: 'custom',
        ordersCount: 5,
        dcaCustom: [1, 1, 1, 1, 1].map(() => ({ step: '1', size: '10' })),
      }
      const clean = await ladder(custom, [])
      const bad = await ladder(custom, [{ price: clean[1], displacedPrice }])
      expect(bad, `custom ${displacedPrice}`).to.deep.equal(clean)
    }
  })

  it('§1.4 still applies a breakpoint inside the ladder range', async () => {
    const prices = await ladder({}, [{ price: 0.258, displacedPrice: 0.25 }])
    expect(prices).to.have.length(35)
    expect(prices).to.include(0.25)
    expect(prices).to.not.include(0.258)
  })

  // The burst: 0.261 is processed while 0.271/0.268/0.265 are not yet marked
  // FILLED, so `left` is three too high and the slice starts at 0.258 — a
  // level that has itself already FILLED. The market is at the wick.
  const burstFilled = [
    0.312, 0.309, 0.306, 0.302, 0.299, 0.296, 0.293, 0.29, 0.287, 0.284, 0.28,
    0.277, 0.274, 0.261, 0.258,
  ]

  const runCurrent = async (
    rows: Row[],
    latestPrice: number,
    price: number,
    gridBreakpoints: any[] = [],
    overrides: any = { ordersCount: 30 },
  ) => {
    const deal: any = {
      _id: DEAL_ID,
      initialPrice: START,
      gridBreakpoints: [...gridBreakpoints],
      symbol: { symbol: '0G-USD' },
      settings: {},
    }
    const bot = makeBot(overrides, rows, latestPrice, deal)
    const initial = await bot.createInitialDealOrders(
      '0G-USD',
      START,
      DEAL_ID,
      deal,
    )
    const current = await bot.createCurrentDealOrders(
      '0G-USD',
      price,
      initial,
      0.28,
      START,
      DEAL_ID,
      false,
      deal,
      false,
    )
    return { deal, current: regularPrices(current), bot }
  }

  it('§1.1 neither re-sends nor displaces a level that has already filled', async () => {
    // Market just below 0.258 and inside the ladder: only the "already
    // filled" rule can keep 0.258 out.
    const { deal, current } = await runCurrent(
      filled(burstFilled),
      0.257,
      0.261,
    )
    expect(deal.gridBreakpoints).to.deep.equal([])
    expect(current).to.not.include(0.258)
    expect(current[0]).to.equal(0.255)
  })

  it('§1.1 does not re-send a filled level whose fill was processed first', async () => {
    // 0.258 was processed before 0.261 (so it is no longer "between
    // updates"), and the three higher fills are still unmarked.
    const { current } = await runCurrent(filled(burstFilled), 0.26, 0.261)
    expect(current).to.not.include(0.258)
  })

  it('§1.1 keeps a partly filled level as a current order', async () => {
    const rows: Row[] = [
      ...filled(burstFilled.slice(0, -1)),
      { price: '0.258', origPrice: '0.258', status: 'PARTIALLY_FILLED' },
    ]
    const { current } = await runCurrent(rows, 0.26, 0.261)
    expect(current[0]).to.equal(0.258)
  })

  it('§1.2 records no breakpoint at a market price beyond the deepest level', async () => {
    // 0.255 has not filled; the market is at the wick, past every level.
    const { deal, current } = await runCurrent(
      filled([...burstFilled, 0.271, 0.268, 0.265]),
      0.002,
      0.258,
    )
    expect(deal.gridBreakpoints).to.deep.equal([])
    expect(current[0]).to.equal(0.255)
  })

  it('§1.4 still records a breakpoint when the market gapped inside the ladder', async () => {
    const { deal } = await runCurrent(
      filled([...burstFilled, 0.271, 0.268, 0.265]),
      0.25,
      0.258,
    )
    expect(deal.gridBreakpoints).to.deep.equal([
      { price: 0.255, displacedPrice: 0.25 },
    ])
  })

  it('§1.3 the recorded deal raised to 35 levels places its real next levels', async () => {
    // Every ladder fill the deal has today; its last fill was 0.227. The
    // settings edit runs this with the check on, and the market was 0.236.
    const allFilled = [
      0.312, 0.309, 0.306, 0.302, 0.299, 0.296, 0.293, 0.29, 0.287, 0.284, 0.28,
      0.277, 0.274, 0.271, 0.268, 0.265, 0.261, 0.258, 0.255, 0.252, 0.249,
      0.239, 0.236, 0.233, 0.23, 0.227,
    ]
    const { current } = await runCurrent(
      filled(allFilled),
      0.236,
      0.227,
      WICK,
      { ordersCount: 35 },
    )
    expect(current.length).to.be.greaterThan(0)
    expect(Math.min(...current)).to.be.greaterThan(0.2)
    expect(current).to.include.members([0.224, 0.221])
    expect(current).to.not.include(0.002)
    expect(current).to.not.include(0.001)
  })
})
