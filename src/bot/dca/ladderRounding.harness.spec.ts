process.env.NODE_ENV = 'testing'

/**
 * A percentage safety-order ladder must not accumulate rounding error across
 * levels.
 *
 * Level `i` is configured at `step × Σ scale^k` (k < i) of the start price
 * beyond the start. The ladder used to round each level to the tick and step
 * the next one off the ROUNDED price, so every level's rounding carried into
 * all the levels after it. On a coarse tick (0.001 at a price near 0.25) a
 * 30 × 1% ladder placed its last level 24-36% from the start instead of 30%.
 *
 * Drives the REAL `dcaHelper.createInitialDealOrders` on a minimal base class
 * (same approach as `nanLadderRefusal.harness.spec.ts`): no stack, DB, Redis or
 * exchange connection. Nothing here places or cancels anything.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'

const TICK = 0.001

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
  ordersCount: 30,
  activeOrdersCount: 30,
  orderSizeType: 'quote',
  orderSize: '10',
  baseOrderSize: '10',
  step: '1',
  stepScale: '1',
  volumeScale: '1',
  tpPerc: '1',
  slPerc: '-10',
  indicators: [],
  indicatorGroups: [],
}

// Kraken 0G/USD shape: price tick 0.001, a price near 0.25.
const EXCHANGE_INFO: any = {
  pair: '0G-USD',
  baseAsset: { minAmount: 0, maxAmount: 0, step: 0.01, name: '0G' },
  quoteAsset: { minAmount: 0, step: 0.01, precision: 2, name: 'USD' },
  priceAssetPrecision: 3,
}

const DEAL_ID = 'ladder-rounding-deal'

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
  data: any = {
    settings: baseSettings,
    exchange: ExchangeEnum.kraken,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildLadder = async (overrides: any, startPrice: number) => {
  const settings = { ...baseSettings, ...overrides }
  class TestBot extends Helper {
    getDeal() {
      return undefined
    }
    getOrdersByStatusAndDealId() {
      return []
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
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    getOrderId(prefix: string) {
      return `${prefix}-ladder`
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
  const orders: any[] = await bot.createInitialDealOrders(
    '0G-USD',
    startPrice,
    DEAL_ID,
  )
  return orders.filter((o) => o.type === 'dealRegular').map((o) => o.price)
}

/** Where level `i` belongs before any rounding. */
const target = (
  start: number,
  step: number,
  scale: number,
  i: number,
  dir: 1 | -1,
) => {
  let cumulative = 0
  for (let k = 0; k < i; k++) cumulative += scale ** k
  return start * (1 - dir * step * cumulative)
}

describe('DCA percentage ladder rounding', () => {
  before(function () {
    // One ts-node compile of a 22k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('keeps every level of 30 × 1% within one tick of its configured price', async () => {
    const drift: string[] = []
    for (const start of [0.249, 0.25, 0.251, 0.252, 0.253, 0.254]) {
      const prices = await buildLadder({}, start)
      expect(prices, `levels at ${start}`).to.have.length(30)
      prices.forEach((p, idx) => {
        const want = target(start, 0.01, 1, idx + 1, 1)
        if (Math.abs(p - want) > TICK + 1e-12) {
          drift.push(`${start} SO${idx + 1}: ${p} vs ${want.toFixed(5)}`)
        }
      })
    }
    expect(drift, drift.slice(0, 6).join(' | ')).to.deep.equal([])
  })

  it('places the recorded 0.254 deal at the configured levels', async () => {
    // A paper deal started at 0.254 on this ladder placed its first five
    // levels at 0.251 / 0.248 / 0.245 / 0.242 / 0.239 — 3 ticks apart for a
    // 2.54-tick step, 5.9% down by level 5.
    const prices = await buildLadder({}, 0.254)
    expect(prices.slice(0, 5)).to.deep.equal([
      0.251, 0.249, 0.246, 0.244, 0.241,
    ])
    expect(prices[29]).to.equal(0.178)
  })

  it('keeps a scaled and a short ladder within one tick', async () => {
    const scaled = await buildLadder(
      { ordersCount: 20, stepScale: '1.05' },
      0.254,
    )
    scaled.forEach((p, idx) =>
      expect(p, `scaled SO${idx + 1}`).to.be.closeTo(
        target(0.254, 0.01, 1.05, idx + 1, 1),
        TICK + 1e-12,
      ),
    )
    const short = await buildLadder({ strategy: 'SHORT' }, 0.254)
    expect(short).to.have.length(30)
    short.forEach((p, idx) =>
      expect(p, `short SO${idx + 1}`).to.be.closeTo(
        target(0.254, 0.01, 1, idx + 1, -1),
        TICK + 1e-12,
      ),
    )
  })

  it('still separates levels when the step is under one tick', async () => {
    for (const strategy of ['LONG', 'SHORT']) {
      const prices = await buildLadder(
        { step: '0.1', ordersCount: 10, strategy },
        0.25,
      )
      const dir = strategy === 'LONG' ? -1 : 1
      let prev = 0.25
      for (const p of prices) {
        expect(
          dir * (p - prev),
          `${strategy} ${p} after ${prev}`,
        ).to.be.greaterThan(TICK / 2)
        prev = p
      }
    }
  })
})
