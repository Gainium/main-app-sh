process.env.NODE_ENV = 'testing'

/**
 * A DCA bot must refuse a deal whose orders the exchange minimum would inflate,
 * and say why, instead of placing a base or safety order several times the
 * configured size — unless `allowRaiseToExchangeMin` is on. A missing value
 * refuses (every pre-existing bot was backfilled `true`).
 *
 * Drives the REAL `dcaHelper.refuseDealBelowExchangeMin` — and through it the
 * real `getBaseOrder` and `createInitialDealOrders` clamps — over the mixin with
 * a minimal base class: no stack, DB, Redis or venue.
 *
 * Fixture: a spot DCA long on a pair whose base minimum is 200 units at 0.1831
 * (≈ 36.6 quote), configured with a 10.8 base order and 3.6 safety orders —
 * the shape that placed a 10.80 base order as 39.59.
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
import { errorDict } from '../utils'
import { ConditionLatch } from '../conditionLatch'
import {
  MIN_ORDER_FLOOR_TOLERANCE,
  minOrderRefusalMessage,
  raisedPastConfigured,
} from '../minOrderFloor'

const PAIR = 'SYN-USD'
const PRICE = 0.1831

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'SYN', minAmount: 200, maxAmount: 0, step: 1e-8 },
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
        baseOrderSize: '10.8',
        baseOrderPrice: '0',
        orderSize: '3.6',
        ordersCount: 3,
        step: '1',
        stepScale: '1',
        volumeScale: '1.05',
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
        ...overrides,
      }
    }
    getOrderId(prefix: string) {
      return `${prefix}-0000000000000000000000000099`
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

describe('exchange minimum — refuse instead of inflating BO/SO', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('refuses the deal and names the base and safety orders', async () => {
    const { bot, reported } = buildBot()
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
    expect(reported).to.have.length(1)
    const msg = reported[0]
    expect(msg).to.contain('SYN/USD')
    expect(msg).to.contain('200 SYN')
    expect(msg).to.contain('Base Order 10.8')
    expect(msg).to.contain('Safety Order 1 3.6')
    expect(msg).to.contain('Remove SYN/USD from the bot')
    expect(msg).to.contain('Allow increasing orders to exchange minimum')
  })

  it('reports a standing condition once, not once per cycle', async () => {
    const { bot, reported } = buildBot()
    for (let i = 0; i < 5; i++) {
      expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
    }
    expect(reported).to.have.length(1)
  })

  it('refuses when the setting is missing — the default for new bots', async () => {
    const { bot } = buildBot({ allowRaiseToExchangeMin: undefined })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
  })

  it('refuses when the setting is explicitly off', async () => {
    const { bot } = buildBot({ allowRaiseToExchangeMin: false })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
  })

  it('raises as before when allowRaiseToExchangeMin is on', async () => {
    const { bot, reported } = buildBot({ allowRaiseToExchangeMin: true })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
    expect(reported).to.deep.equal([])
  })

  it('leaves terminal deals raising — their form has no switch', async () => {
    const { bot } = buildBot({ type: DCATypeEnum.terminal })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
  })

  it('leaves hedge-DCA legs raising — their form has no switch', async () => {
    const { bot } = buildBot()
    bot.data = { ...bot.data, parentBotId: '000000000000000000000p99' }
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
  })

  it('opens when every order clears the minimum', async () => {
    // 200 SYN at 0.1831 ≈ 36.6 USD; lower ladder levels need less quote.
    const { bot, reported } = buildBot({ baseOrderSize: '37', orderSize: '37' })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
    expect(reported).to.deep.equal([])
  })

  it('refuses on a safety order alone', async () => {
    const { bot, reported } = buildBot({ baseOrderSize: '37' })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
    expect(reported[0]).to.not.contain('Base Order')
    expect(reported[0]).to.contain('Safety Order 1')
  })

  it('ignores safety orders when DCA is off', async () => {
    const { bot } = buildBot({ baseOrderSize: '37', useDca: false })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
  })
})

describe('minOrderFloor — the pure verdict and message', () => {
  it('tolerates rounding next to the minimum', () => {
    const f = { configuredQty: 100, price: 1 }
    expect(
      raisedPastConfigured({
        ...f,
        raisedQty: 100 * (1 + MIN_ORDER_FLOOR_TOLERANCE),
      }),
    ).to.equal(false)
    expect(raisedPastConfigured({ ...f, raisedQty: 111 })).to.equal(true)
  })

  it('fails open on an unsizeable order', () => {
    expect(
      raisedPastConfigured({ configuredQty: NaN, raisedQty: 10, price: 1 }),
    ).to.equal(false)
    expect(
      raisedPastConfigured({ configuredQty: 0, raisedQty: 10, price: 1 }),
    ).to.equal(false)
  })

  it('summarises past three orders and matches no errorDict key', () => {
    const msg = minOrderRefusalMessage({
      pair: 'AKE/USD',
      baseAsset: 'AKE',
      quoteAsset: 'USD',
      minBase: 600,
      minQuote: 0,
      violations: [0, 1, 2, 3, 4].map((level) => ({
        level,
        configuredQty: 100,
        raisedQty: 600,
        price: 0.066,
      })),
    })
    expect(msg).to.contain('(600 AKE per order)')
    expect(msg).to.contain('2 more safety orders')
    const lower = msg.toLowerCase()
    expect(
      Object.keys(errorDict).filter((k) => lower.includes(k.toLowerCase())),
    ).to.deep.equal([])
  })
})
