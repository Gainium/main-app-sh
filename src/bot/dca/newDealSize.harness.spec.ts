process.env.NODE_ENV = 'testing'

/**
 * A new deal's size multiplier from an approval extension: base order and
 * every safety order scaled together, then checked again at the scaled size
 * (balance ×N, exchange minimums); anything that does not hold opens the
 * configured size, with the reason.
 *
 * Drives the REAL `dcaHelper.applyNewDealSize` / `scaleDealSizes`, and through
 * them the real `getBaseOrder` and `createInitialDealOrders`, over the mixin
 * with a minimal base class: no stack, DB, Redis or venue.
 *
 * Fixture: a spot DCA long, 100 USD base order and 3 safety orders of 50 USD,
 * on a pair whose minimums are far below the sizes.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  DCATypeEnum,
  ExchangeEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StrategyEnum,
} from '../../../types'
import { ConditionLatch } from '../conditionLatch'

const PAIR = 'SYN-USD'
const PRICE = 2

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'SYN', minAmount: 0.1, maxAmount: 0, step: 1e-8 },
  quoteAsset: { name: 'USD', minAmount: 0.5, precision: 4 },
  maxOrders: 200,
}

class FakeBase {
  botId = '000000000000000000000b99'
  userId = '000000000000000000000499'
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  kucoinSpot = false
  zeroFee = false
  useCompountReduce = false
  math = new MathHelper()
  standingConditionLatch = new ConditionLatch()
  data: any = {
    settings: { type: 'regular', pair: [PAIR], futures: false },
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '00000000-0000-0000-0000-000000000099',
    paperContext: true,
    flags: [],
  }
  get isLong() {
    return true
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any
let balanceAsked: number[] = []
let balanceOkUpTo = Infinity
let exchangeInfo: any = EXCHANGE_INFO

const buildBot = (overrides: Record<string, unknown> = {}) => {
  const reported: string[] = []
  class TestBot extends Helper {
    exchange = {} as any
    tpAr = false
    slAr = false
    scaleAr = false
    isBitget = false
    async profitBase() {
      return false
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async getExchangeInfo() {
      return exchangeInfo
    }
    async getUsdRate() {
      return 1
    }
    async checkBalance(_symbol: string, m = 1, scope = 'whole') {
      balanceAsked.push(scope === 'base' ? -m : m)
      return { status: m <= balanceOkUpTo, required: 0, available: 0, price: 0 }
    }
    async allowsRaiseToExchangeMin(v?: boolean) {
      return v === true
    }
    async reportOrderBelowExchangeMin() {}
    async baseAssetPrecision() {
      return 8
    }
    async getLatestPrice() {
      return PRICE
    }
    async getAggregatedSettings() {
      return {
        type: DCATypeEnum.regular,
        baseOrderSize: '100',
        baseOrderPrice: '0',
        orderSize: '50',
        ordersCount: 3,
        step: '1',
        stepScale: '1',
        volumeScale: '1',
        orderSizeType: OrderSizeTypeEnum.quote,
        startOrderType: OrderTypeEnum.market,
        useLimitPrice: false,
        strategy: StrategyEnum.long,
        futures: false,
        coinm: false,
        useDca: true,
        useTp: true,
        tpPerc: '1',
        dealCloseCondition: 'tp',
        reduceToAvailableBalance: true,
        ...overrides,
      }
    }
    getOrderId(prefix: string) {
      return `${prefix}-0000000000000000000000000099`
    }
    openDeals: any[] = []
    getOpenDeals() {
      return this.openDeals
    }
    getDeal() {
      return undefined
    }
    findBaseOrderByDeal() {
      return undefined
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors(msg: string) {
      reported.push(msg)
    }
  }
  const bot = new TestBot() as any
  return { bot, reported }
}

const ctx = (m: number, trigger = 'indicator') =>
  ({ botId: 'b', symbol: PAIR, trigger, time: 0, sizeMultiplier: m }) as any
const NO = { reduced: false, fixSize: 0 }
const regular = (l: any[]) => l.filter((o) => o.type === 'dealRegular')

describe('new deal size multiplier — applyNewDealSize', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })
  beforeEach(() => {
    balanceAsked = []
    balanceOkUpTo = Infinity
    exchangeInfo = EXCHANGE_INFO
  })

  for (const type of [
    OrderSizeTypeEnum.quote,
    OrderSizeTypeEnum.base,
    OrderSizeTypeEnum.usd,
  ]) {
    it(`×2 scales the base order and every safety order (${type})`, async () => {
      const { bot } = buildBot({ orderSizeType: type })
      const fullBase = await bot.getBaseOrder(PAIR, undefined, undefined, PRICE)
      const fullLadder = await bot.createInitialDealOrders(PAIR, PRICE, '')
      const r = await bot.applyNewDealSize(PAIR, ctx(2), null, NO)
      expect(r.outcome).to.deep.equal({
        requested: 2,
        applied: 2,
        scope: 'whole',
      })
      expect(r.sizes.multiplier).to.equal(2)
      expect(r.sizes.reducedToAvailable).to.equal(undefined)
      const base = await bot.getBaseOrder(
        PAIR,
        undefined,
        undefined,
        PRICE,
        0,
        0,
        r.sizes,
      )
      expect(+base.origQty).to.be.closeTo(+fullBase.origQty * 2, 1e-6)
      const ladder = await bot.createInitialDealOrders(PAIR, PRICE, '', {
        sizes: r.sizes,
      })
      expect(regular(ladder)).to.have.length(3)
      regular(ladder).forEach((o: any, i: number) =>
        expect(o.qty).to.be.closeTo(regular(fullLadder)[i].qty * 2, 1e-6),
      )
      expect(balanceAsked, 'balance re-checked at ×2').to.deep.equal([2])
    })
  }

  it("scope 'base': only the base order scales; the balance check adds (N−1)× the base order", async () => {
    const { bot } = buildBot()
    const fullBase = await bot.getBaseOrder(PAIR, undefined, undefined, PRICE)
    const fullLadder = await bot.createInitialDealOrders(PAIR, PRICE, '')
    const r = await bot.applyNewDealSize(
      PAIR,
      { ...ctx(2), sizeScope: 'base' },
      null,
      NO,
    )
    expect(r.outcome).to.deep.equal({ requested: 2, applied: 2, scope: 'base' })
    expect(r.sizes.multiplierScope).to.equal('base')
    const base = await bot.getBaseOrder(
      PAIR,
      undefined,
      undefined,
      PRICE,
      0,
      0,
      r.sizes,
    )
    expect(+base.origQty).to.be.closeTo(+fullBase.origQty * 2, 1e-6)
    const ladder = await bot.createInitialDealOrders(PAIR, PRICE, '', {
      sizes: r.sizes,
    })
    regular(ladder).forEach((o: any, i: number) =>
      expect(o.qty).to.be.closeTo(regular(fullLadder)[i].qty, 1e-9),
    )
  })

  it('composes with compound sizes', async () => {
    const { bot } = buildBot()
    const full = await bot.scaleDealSizes(PAIR, 1, null, { reduced: false })
    const compound = {
      base: 5,
      dca: full.origDca.map(() => 2),
      origBase: full.origBase,
      origDca: full.origDca,
    }
    const r = await bot.applyNewDealSize(PAIR, ctx(1.5), compound, NO)
    expect(r.sizes.origBase + r.sizes.base).to.be.closeTo(
      (full.origBase + 5) * 1.5,
      1e-9,
    )
  })

  it('no multiplier or 1× changes nothing and reports nothing', async () => {
    const { bot } = buildBot()
    const s = { base: 1, dca: [], origBase: 1, origDca: [] }
    for (const c of [null, ctx(1), { ...ctx(1), sizeMultiplier: undefined }]) {
      const r = await bot.applyNewDealSize(PAIR, c, s, NO)
      expect(r.sizes).to.equal(s)
      expect(r.outcome).to.equal(null)
    }
  })

  it('the balance re-checked at the scaled size falls back to 1×', async () => {
    const { bot } = buildBot()
    balanceOkUpTo = 1.5
    const r = await bot.applyNewDealSize(PAIR, ctx(2), null, NO)
    expect(r.outcome).to.deep.equal({
      requested: 2,
      applied: 1,
      reason: 'insufficient_balance',
    })
    expect(r.sizes).to.equal(null)
    const ok = await bot.applyNewDealSize(PAIR, ctx(1.5), null, NO)
    expect(ok.outcome.applied).to.equal(1.5)
  })

  it('the balance check scales the whole deal, or only the base order (real checkBalance)', async () => {
    const { bot } = buildBot()
    // real checkBalance over a tiny wallet: the requirement it reports
    const Real = Object.getPrototypeOf(Object.getPrototypeOf(bot))
    bot.checkAssets = async () => new Map([['USD', { free: 1, locked: 0 }]])
    bot.getLeverageMultipler = async () => 1
    bot.pooledMarginOrKeep = async (_a: string, v: number) => v
    bot.createCurrentDealOrders = async (_s: string, _p: number, g: any[]) => g
    const req = async (m: number, scope?: string) =>
      (await Real.checkBalance.call(bot, PAIR, m, scope)).required
    const one = await req(1)
    const base = await bot.getBaseOrder(PAIR, undefined, undefined, PRICE)
    const boValue = +base.origQty * +base.price
    expect(await req(2)).to.be.closeTo(one * 2, 1e-6)
    expect(await req(2, 'base')).to.be.closeTo(one + boValue, 1e-6)
  })

  it('a reduced deal under the exchange minimum falls back unless the bot allows the raise', async () => {
    // 50 USD safety orders × 0.5 = 25 < a 30 USD minimum
    exchangeInfo = {
      ...EXCHANGE_INFO,
      quoteAsset: { ...EXCHANGE_INFO.quoteAsset, minAmount: 30 },
    }
    const { bot } = buildBot()
    const r = await bot.applyNewDealSize(PAIR, ctx(0.5), null, NO)
    expect(r.outcome).to.deep.equal({
      requested: 0.5,
      applied: 1,
      reason: 'below_exchange_min',
    })
    const allow = buildBot({ allowRaiseToExchangeMin: true }).bot
    expect(
      (await allow.applyNewDealSize(PAIR, ctx(0.5), null, NO)).outcome.applied,
    ).to.equal(0.5)
    expect(balanceAsked, 'no balance re-check when smaller').to.deep.equal([])
  })

  it('keeps the configured size where the engine cannot scale', async () => {
    const cases: [Record<string, unknown>, any, string, any?][] = [
      [{ orderSizeType: OrderSizeTypeEnum.percFree }, NO, 'size_type'],
      [{ orderSizeType: OrderSizeTypeEnum.percTotal }, NO, 'size_type'],
      [{ useRiskReward: true }, NO, 'risk_reward'],
      [{}, { reduced: false, fixSize: 3 }, 'risk_reward'],
      [{}, { reduced: true, fixSize: 0 }, 'reduced_to_available'],
      [{ type: DCATypeEnum.terminal }, NO, 'not_supported'],
    ]
    for (const [o, opts, reason] of cases) {
      const r = await buildBot(o).bot.applyNewDealSize(PAIR, ctx(2), null, opts)
      expect(r.outcome, JSON.stringify(o)).to.deep.equal({
        requested: 2,
        applied: 1,
        reason,
      })
    }
    const hedge = buildBot().bot
    hedge.data = { ...hedge.data, parentBotId: '000000000000000000000p99' }
    expect(
      (await hedge.applyNewDealSize(PAIR, ctx(2), null, NO)).outcome.reason,
    ).to.equal('not_supported')
    for (const m of [4, 0.05]) {
      const r = await buildBot().bot.applyNewDealSize(PAIR, ctx(m), null, NO)
      expect(r.outcome.reason).to.equal('out_of_bounds')
    }
    const manual = await buildBot().bot.applyNewDealSize(
      PAIR,
      ctx(2, 'manual'),
      null,
      NO,
    )
    expect(manual.outcome.reason).to.equal('not_supported')
  })

  it('scaleDealSizes still marks a reduction to the balance by default', async () => {
    const { bot } = buildBot()
    expect((await bot.scaleDealSizes(PAIR, 0.5)).reducedToAvailable).to.equal(
      true,
    )
    expect(
      (await bot.scaleDealSizes(PAIR, 2, null, { reduced: false }))
        .reducedToAvailable,
    ).to.equal(undefined)
  })
})
