process.env.NODE_ENV = 'testing'

/**
 * A Combo FUTURES bot's base order must open the position the user configured.
 *
 * The base order is placed, then `comboHelper.getBaseOrder` lays a base grid
 * over it and — on futures, unconditionally — re-sizes the base order to the
 * sum of that grid's levels, so the position and the ladder that unwinds it
 * agree. `MainBot.generateGridsOnPrice` sizes every combo level by FLOORING the
 * budget-derived level size to the venue's lot step independently, so on a
 * coarse-step contract each level loses up to one step and the base order
 * inherits the whole loss.
 *
 * Reproduction is the reported one: an OKX linear SOL perpetual, 0.01 lot step,
 * price 117.56, base order 10 quote, 5 base-grid levels. The pair is described
 * by its filters only — no venue, no Mongo, no Redis, no price stream.
 *
 * Enforces specs/086 §3 (the reproduction), §4 (the residual carry) and §5
 * (what must not move).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotType,
  ExchangeEnum,
  OrderSizeTypeEnum,
  StrategyEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

/** OKX Europe Linear SOL-USD_UM_XPERP, as the engine sees it. */
const PRICE = 117.56
const STEP = 0.01
const MIN_QTY = 0.01
const MIN_NOTIONAL = 1
const PRICE_PRECISION = 2

/** The reported settings. */
const BASE_ORDER_SIZE = 10
const BASE_GRID_LEVELS = 5
const BASE_STEP = 1

let Combo: any

const makeBot = (
  opts: {
    futures?: boolean
    profitCurrency?: 'base' | 'quote'
    baseOrderSize?: number
    levels?: number
    step?: number
    price?: number
    baseStep?: number
    minQty?: number
  } = {},
) => {
  const {
    futures = true,
    profitCurrency = 'quote',
    baseOrderSize = BASE_ORDER_SIZE,
    levels = BASE_GRID_LEVELS,
    step = STEP,
    price = PRICE,
    baseStep = BASE_STEP,
    minQty = MIN_QTY,
  } = opts

  class TestBot extends Combo {
    math = new MathHelper()
    botId = '000000000000000000000908'
    userId = '000000000000000000000909'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = false
    data: any = {
      _id: '000000000000000000000908',
      userId: '000000000000000000000909',
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      created: new Date('2026-06-01'),
      symbol: { symbol: 'SOL-USD', baseAsset: 'SOL', quoteAsset: 'USDC' },
      flags: [],
      settings: {
        name: 'combo',
        pair: ['SOL-USD'],
        futures,
        coinm: false,
        newBalance: false,
        strategy: StrategyEnum.long,
        futuresStrategy: 'LONG',
        profitCurrency,
      },
    }
    get isLong() {
      return true
    }
    get futures() {
      return futures
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    // --- the real sizing routines, borrowed from the engine ---
    generateBasicGrids(a: any) {
      return (MainBot.prototype as any).generateBasicGrids.call(this, a)
    }
    generateGridsOnPrice(...a: any[]) {
      return (MainBot.prototype as any).generateGridsOnPrice.apply(this, a)
    }
    getSellBuyCount(...a: any[]) {
      return (MainBot.prototype as any).getSellBuyCount.apply(this, a)
    }
    findClosestGrids(...a: any[]) {
      return (MainBot.prototype as any).findClosestGrids.apply(this, a)
    }
    baseAssetPrecision(s: string) {
      return (MainBot.prototype as any).baseAssetPrecision.call(this, s)
    }
    // --- I/O, stubbed ---
    async getAggregatedSettings() {
      return {
        futures,
        coinm: false,
        profitCurrency,
        orderSizeType: OrderSizeTypeEnum.quote,
        baseOrderSize: `${baseOrderSize}`,
        baseGridLevels: `${levels}`,
        gridLevel: `${levels}`,
        baseStep: `${baseStep}`,
        step: `${baseStep}`,
      }
    }
    async getExchangeInfo() {
      return {
        pair: 'SOL-USD',
        priceAssetPrecision: PRICE_PRECISION,
        maxOrders: 500,
        baseAsset: { minAmount: minQty, step, name: 'SOL' },
        quoteAsset: { minAmount: MIN_NOTIONAL, step: 0.01, name: 'USDC' },
      }
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.00055 }
    }
    async getLatestPrice() {
      return price
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
  return new (TestBot as any)()
}

/** The base order the engine would send, plus the grid it was sized from. */
const baseOrderAndGrid = async (bot: any) => {
  const grids: any[] = []
  const real = bot.generateGridsOnPrice.bind(bot)
  bot.generateGridsOnPrice = async (...a: any[]) => {
    const r = await real(...a)
    grids.push(...(r ?? []))
    return r
  }
  const order = await bot.getBaseOrder('SOL-USD')
  return { order, grids, budget: order.minigridBudget as number }
}

describe('combo futures base order is sized by the base grid (spec 086)', () => {
  before(function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  describe('§3 the reproduction', () => {
    it('§3.1 opens the position the configured notional pays for', async () => {
      const bot = makeBot()
      const { order, grids, budget } = await baseOrderAndGrid(bot)

      // What the plain base-order sizing produced before the grid re-sized it:
      // floor(10 / 117.56) at the 0.01 lot step. This is the size spot opens at.
      expect(budget).to.be.closeTo(0.08 * PRICE, 1e-6)

      // The base order IS the grid sum on futures — that part is by design.
      expect(grids).to.have.length(BASE_GRID_LEVELS)
      const sum = grids.reduce((a, g) => a + g.qty, 0)
      expect(+order.origQty).to.be.closeTo(sum, 1e-9)

      // The defect: 5 levels of 0.01 = 0.05 SOL / 5.878 quote against 9.4048.
      expect(+order.origQty).to.be.greaterThan(0.05)
      expect(+order.origQty * PRICE).to.be.at.least(budget - STEP * PRICE)
    })

    it('§3.1 never commits more than the base order budget', async () => {
      const bot = makeBot()
      const { order, budget } = await baseOrderAndGrid(bot)
      expect(+order.origQty * PRICE).to.be.at.most(budget + 1e-9)
    })

    it('§3.2 leaves every level on the venue lot step and at its minimum', async () => {
      const bot = makeBot()
      const { grids } = await baseOrderAndGrid(bot)
      for (const g of grids) {
        expect(g.qty).to.be.at.least(MIN_QTY)
        expect(Math.round(g.qty / STEP) * STEP).to.be.closeTo(g.qty, 1e-9)
      }
    })
  })

  describe('§4 the residual carry', () => {
    it('§4.3 lands within one lot step of the target, at every level count', async () => {
      for (const levels of [2, 3, 5, 7]) {
        const bot = makeBot({ levels })
        const { order, grids, budget } = await baseOrderAndGrid(bot)
        const committed = +order.origQty * PRICE
        // §4.2 — never over the budget.
        expect(committed, `levels=${levels} committed`).to.be.at.most(
          budget + 1e-9,
        )
        // §4.1 — and no further than one lot step under it.
        expect(committed, `levels=${levels} shortfall`).to.be.greaterThan(
          budget - STEP * PRICE,
        )
        for (const g of grids) {
          expect(
            Math.round(g.qty / STEP) * STEP,
            `levels=${levels}`,
          ).to.be.closeTo(g.qty, 1e-9)
        }
      }
    })

    it('§4.3 holds on a finer lot step, where the shortfall was smaller', async () => {
      const bot = makeBot({ step: 0.001, minQty: 0.001 })
      const { order, budget } = await baseOrderAndGrid(bot)
      const committed = +order.origQty * PRICE
      expect(committed).to.be.at.most(budget + 1e-9)
      expect(committed).to.be.greaterThan(budget - 0.001 * PRICE)
    })
  })

  describe('§5 what must not move', () => {
    it('§5.1 a spot combo base order is untouched', async () => {
      const bot = makeBot({ futures: false })
      const { order, grids, budget } = await baseOrderAndGrid(bot)
      // Spot: `useBase` is false and `qtyByGrids` is a quote sum, so the base
      // order is only raised, never replaced by the grid. Levels stay floored
      // to one uniform size and the base order stays at the budget size.
      const sizes = new Set(grids.map((g: any) => g.qty))
      expect(sizes.size).to.equal(1)
      expect([...sizes][0]).to.equal(MIN_QTY)
      expect(+order.origQty * PRICE).to.be.closeTo(budget, 1e-9)
    })

    it('§5.3 a grid the venue minimum cannot fund sizes the same, and is now refused', async () => {
      // 11 levels × (0.01 × ~117.6) needs 12.93 against a 9.40 budget, so every
      // level is floored UP to the venue minimum and the grid over-commits.
      // Spec 086 left that SIZING exactly where it was and pinned it here as a
      // control; it still is, because there is no placeable size below the venue
      // minimum. What changed is that spec 087 stops a deal from reaching it —
      // `refuseDealBelowMinimumBudget` refuses the pair before any base order is
      // placed. Pinned in `comboBaseGridBudgetRefusal.spec.ts`; asserted here so
      // the two cannot drift apart.
      const bot = makeBot({ levels: 11 })
      const { order, grids } = await baseOrderAndGrid(bot)
      expect(grids).to.have.length(11)
      expect(grids.every((g: any) => g.qty === MIN_QTY)).to.equal(true)
      expect(+order.origQty).to.be.closeTo(0.11, 1e-9)
      expect(await bot.refuseDealBelowMinimumBudget('SOL-USD')).to.equal(true)
    })
  })
})
