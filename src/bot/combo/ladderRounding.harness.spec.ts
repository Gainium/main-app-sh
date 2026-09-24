process.env.NODE_ENV = 'testing'

/**
 * A combo bot's safety-order ladder must not accumulate rounding error across
 * levels (the combo copy of `dca/ladderRounding.harness.spec.ts`).
 *
 * Level `i` is configured at `step × Σ scale^k` (k < i) of the start price
 * beyond the start. `comboHelper.createInitialDealOrders` used to round each
 * level to the tick and step the next one off the ROUNDED price, so on a 0.001
 * tick near 0.25 a 30 × 1% ladder ended 24-36% from the start instead of 30%.
 * Each level's mini-grid keeps its width, `step × scale^(i-1)` of the start
 * price, measured from its own level.
 *
 * Drives the REAL combo `createInitialDealOrders` with the real grid builders
 * borrowed from MainBot (same approach as `comboFuturesBaseGridSizing.spec.ts`):
 * no stack, DB, Redis or exchange connection. Nothing here places anything.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { BotType, ExchangeEnum, OrderSizeTypeEnum } from '../../../types'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'

const TICK = 0.001

const baseSettings: any = {
  useDca: true,
  futures: false,
  coinm: false,
  profitCurrency: 'quote',
  orderSizeType: OrderSizeTypeEnum.quote,
  orderSize: '10',
  baseOrderSize: '10',
  ordersCount: 30,
  step: '1',
  stepScale: '1',
  volumeScale: '1',
  gridLevel: '2',
  strategy: 'LONG',
}

let Combo: any

const build = async (overrides: any, startPrice: number) => {
  const settings = { ...baseSettings, ...overrides }
  const long = settings.strategy === 'LONG'
  const minigrids: any[] = []
  class TestBot extends Combo {
    math = new MathHelper()
    botId = '000000000000000000000950'
    userId = '000000000000000000000951'
    botType = BotType.combo
    exchange = {} as any
    orders = new Map()
    log = false
    hedge = false
    feeOrder = false
    data: any = {
      _id: '000000000000000000000950',
      userId: '000000000000000000000951',
      exchange: ExchangeEnum.paperKraken,
      paperContext: true,
      flags: [],
      settings: { ...settings, newBalance: false },
    }
    get futures() {
      return false
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    generateBasicGrids(a: any) {
      return (MainBot.prototype as any).generateBasicGrids.call(this, a)
    }
    async generateGridsOnPrice(...a: any[]) {
      minigrids.push({ low: a[0].lowPrice, top: a[0].topPrice })
      return (MainBot.prototype as any).generateGridsOnPrice.apply(this, a)
    }
    getSellBuyCount(...a: any[]) {
      return (MainBot.prototype as any).getSellBuyCount.apply(this, a)
    }
    findClosestGrids(...a: any[]) {
      return (MainBot.prototype as any).findClosestGrids.apply(this, a)
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return {
        pair: '0G-USD',
        priceAssetPrecision: 3,
        maxOrders: 500,
        baseAsset: { minAmount: 0, step: 0.01, name: '0G' },
        quoteAsset: { minAmount: 0, step: 0.01, name: 'USD' },
      }
    }
    async baseAssetPrecision() {
      return 2
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    getDeal() {
      return undefined
    }
    getOrderId(prefix: string) {
      return prefix
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
  const bot: any = new (TestBot as any)()
  // `isLong` is an instance field on the DCA base, so a getter cannot shadow it.
  bot.isLong = long
  const orders: any[] = await bot.createInitialDealOrders(
    '0G-USD',
    startPrice,
    'combo-ladder-deal',
  )
  return { prices: orders.map((o) => o.price), minigrids }
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

describe('combo safety-order ladder rounding', () => {
  before(function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('../comboHelper').default()
  })

  it('keeps every level of 30 × 1% within one tick of its configured price', async () => {
    const drift: string[] = []
    for (const start of [0.249, 0.25, 0.2503, 0.2512, 0.252, 0.2535, 0.254]) {
      const { prices } = await build({}, start)
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

  it('keeps a scaled and a short ladder within one tick', async () => {
    const scaled = await build({ ordersCount: 20, stepScale: '1.05' }, 0.254)
    scaled.prices.forEach((p, idx) =>
      expect(p, `scaled SO${idx + 1}`).to.be.closeTo(
        target(0.254, 0.01, 1.05, idx + 1, 1),
        TICK + 1e-12,
      ),
    )
    const short = await build({ strategy: 'SHORT' }, 0.254)
    expect(short.prices).to.have.length(30)
    short.prices.forEach((p, idx) =>
      expect(p, `short SO${idx + 1}`).to.be.closeTo(
        target(0.254, 0.01, 1, idx + 1, -1),
        TICK + 1e-12,
      ),
    )
  })

  it('still separates levels when the step is under one tick', async () => {
    for (const strategy of ['LONG', 'SHORT']) {
      const { prices } = await build(
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

  it('spans each mini-grid step × scale^(i-1) of the start from its own level', async () => {
    for (const strategy of ['LONG', 'SHORT']) {
      const { prices, minigrids } = await build(
        { ordersCount: 10, stepScale: '1.05', strategy },
        0.254,
      )
      expect(minigrids).to.have.length(prices.length)
      prices.forEach((p, idx) => {
        const width = 0.254 * 0.01 * 1.05 ** idx
        const [low, top] = strategy === 'LONG' ? [p, p + width] : [p - width, p]
        expect(
          minigrids[idx].low,
          `${strategy} SO${idx + 1} low`,
        ).to.be.closeTo(low, 1e-12)
        expect(
          minigrids[idx].top,
          `${strategy} SO${idx + 1} top`,
        ).to.be.closeTo(top, 1e-12)
      })
    }
  })
})
