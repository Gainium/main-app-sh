process.env.NODE_ENV = 'testing'

/**
 * `reduceToAvailableBalance`: when the free balance cannot fund a whole deal,
 * the bot opens it scaled down to what is available — base order and every
 * safety order by the same ratio — instead of skipping it, unless the reduced
 * base order is under the user's floor (`reduceToAvailableMinSize`).
 *
 * Drives the REAL `dcaHelper.reduceToAvailableRatio` / `scaleDealSizes`, and
 * through them the real `getBaseOrder` and `createInitialDealOrders`, over the
 * mixin with a minimal base class: no stack, DB, Redis or venue.
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
      return EXCHANGE_INFO
    }
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

const SHORT = { required: 250, available: 100 }

describe('reduceToAvailableBalance — open a smaller deal instead of none', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('returns the fundable fraction with a 1% reserve', async () => {
    const { bot } = buildBot()
    const r = await bot.reduceToAvailableRatio(SHORT, PAIR)
    expect(r.ratio).to.be.closeTo(0.4 * 0.99, 1e-12)
  })

  it('skips as before when the setting is off or missing', async () => {
    for (const v of [false, undefined]) {
      const { bot } = buildBot({ reduceToAvailableBalance: v })
      expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.equal(
        null,
      )
    }
  })

  it('skips when the reduced base order is under the floor', async () => {
    // 100 × 0.396 = 39.6 < 40
    const { bot } = buildBot({ reduceToAvailableMinSize: '40' })
    const r = await bot.reduceToAvailableRatio(SHORT, PAIR)
    expect(r.ratio).to.equal(null)
    expect(r.belowFloor).to.be.closeTo(39.6, 1e-9)
  })

  it('opens when the reduced base order clears the floor', async () => {
    const { bot } = buildBot({ reduceToAvailableMinSize: '39' })
    expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.be.closeTo(
      0.396,
      1e-12,
    )
  })

  it('treats an empty or zero floor as no floor', async () => {
    for (const v of ['', '0']) {
      const { bot } = buildBot({ reduceToAvailableMinSize: v })
      expect(
        (await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio,
      ).to.not.equal(null)
    }
  })

  it('does not apply to balance-percentage sizes', async () => {
    for (const t of [OrderSizeTypeEnum.percFree, OrderSizeTypeEnum.percTotal]) {
      const { bot } = buildBot({ orderSizeType: t })
      expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.equal(
        null,
      )
    }
  })

  it('does not apply to terminal deals, hedge legs or risk/reward sizing', async () => {
    expect(
      (
        await buildBot({
          type: DCATypeEnum.terminal,
        }).bot.reduceToAvailableRatio(SHORT, PAIR)
      ).ratio,
    ).to.equal(null)
    expect(
      (
        await buildBot({ useRiskReward: true }).bot.reduceToAvailableRatio(
          SHORT,
          PAIR,
        )
      ).ratio,
    ).to.equal(null)
    const { bot } = buildBot()
    bot.data = { ...bot.data, parentBotId: '000000000000000000000p99' }
    expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.equal(null)
  })

  it('does nothing with no balance at all or no shortfall', async () => {
    const { bot } = buildBot()
    expect(
      (await bot.reduceToAvailableRatio({ required: 250, available: 0 }, PAIR))
        .ratio,
    ).to.equal(null)
    expect(
      (
        await bot.reduceToAvailableRatio(
          { required: 250, available: 300 },
          PAIR,
        )
      ).ratio,
    ).to.equal(null)
  })

  it('scales the base order and every safety order by the same ratio', async () => {
    const { bot } = buildBot()
    const ratio = 0.4
    const fullBase = await bot.getBaseOrder(PAIR, undefined, undefined, PRICE)
    const fullLadder = await bot.createInitialDealOrders(PAIR, PRICE, '')
    const sizes = await bot.scaleDealSizes(PAIR, ratio)
    expect(sizes).to.not.equal(null)
    expect(sizes.dca).to.have.length(3)

    const base = await bot.getBaseOrder(
      PAIR,
      undefined,
      undefined,
      PRICE,
      0,
      0,
      sizes,
    )
    expect(+base.origQty).to.be.closeTo(+fullBase.origQty * ratio, 1e-6)

    // The deal carries the sizes, as a real deal does from creation on.
    const ladder = await bot.createInitialDealOrders(PAIR, PRICE, '', {
      sizes,
    })
    expect(ladder).to.have.length(fullLadder.length)
    const regular = (l: any[]) => l.filter((o) => o.type === 'dealRegular')
    expect(regular(ladder)).to.have.length(3)
    regular(ladder).forEach((o: any, i: number) =>
      expect(o.qty).to.be.closeTo(regular(fullLadder)[i].qty * ratio, 1e-6),
    )
    // No base-order row here (as after a restart that lost it): the take-profit
    // falls back to the nominal base order, which must carry the reduction.
    const tp = (l: any[]) => l.find((o) => o.type === 'dealTP')
    expect(tp(ladder).qty).to.be.lessThan(tp(fullLadder).qty * 0.5)
  })

  it('composes with compound/risk-reduction sizes', async () => {
    const { bot } = buildBot()
    const full = await bot.scaleDealSizes(PAIR, 1)
    const compound = {
      base: 5,
      dca: full.origDca.map(() => 2),
      origBase: full.origBase,
      origDca: full.origDca,
    }
    const sizes = await bot.scaleDealSizes(PAIR, 0.5, compound)
    expect(sizes.origBase + sizes.base).to.be.closeTo(
      (full.origBase + 5) * 0.5,
      1e-9,
    )
    sizes.dca.forEach((d: number, i: number) =>
      expect(sizes.origDca[i] + d).to.be.closeTo(
        (full.origDca[i] + 2) * 0.5,
        1e-9,
      ),
    )
  })
  it('gives the available balance to one deal: another open reduced deal blocks', async () => {
    const { bot } = buildBot()
    bot.openDeals = [{ deal: { sizes: { reducedToAvailable: true } } }]
    const r = await bot.reduceToAvailableRatio(SHORT, PAIR)
    expect(r.ratio).to.equal(null)
    expect(r.heldByOtherDeal).to.equal(true)
  })

  it('a full-size or compound-resized open deal does not block', async () => {
    const { bot } = buildBot()
    bot.openDeals = [{ deal: {} }, { deal: { sizes: { base: -1, dca: [] } } }]
    expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.not.equal(
      null,
    )
  })

  it('another pair holding the claim blocks; the same pair does not; release frees it', async () => {
    const { bot } = buildBot()
    expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.not.equal(
      null,
    )
    expect(bot.reduceToAvailableClaim).to.equal(PAIR)
    const other = await bot.reduceToAvailableRatio(SHORT, 'OTHER-USD')
    expect(other.ratio).to.equal(null)
    expect(other.heldByOtherDeal).to.equal(true)
    expect((await bot.reduceToAvailableRatio(SHORT, PAIR)).ratio).to.not.equal(
      null,
    )
    bot.releaseReduceToAvailableClaim(PAIR)
    expect(bot.reduceToAvailableClaim).to.equal(null)
    expect(
      (await bot.reduceToAvailableRatio(SHORT, 'OTHER-USD')).ratio,
    ).to.not.equal(null)
  })

  it('marks the reduced sizes so the deal blocks further reductions', async () => {
    const { bot } = buildBot()
    expect((await bot.scaleDealSizes(PAIR, 0.5)).reducedToAvailable).to.equal(
      true,
    )
  })
})
