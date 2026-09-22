process.env.NODE_ENV = 'testing'

/**
 * A Combo FUTURES bot must not open a position larger than the base order the
 * user configured.
 *
 * Its base grid divides the base order's own notional across `baseGridLevels`
 * levels, and on futures `comboHelper.getBaseOrder` re-sizes the base order to
 * the sum of those levels (spec 086). When the budget cannot fund every level at
 * the venue's per-order minimum, `MainBot.generateGridsOnPrice` raises every
 * level to that minimum and the inflated sum lands on the position — 1.375× the
 * configured notional at 11 levels, 6.375× at 50.
 *
 * The sizing routine already reports what it wanted against what the minimum
 * forced (`MainBot.lastGridSizing`); grid bots read it in
 * `BotHelper.refuseStartBelowMinimumBudget`. This pins the combo path's reader:
 * `comboHelper.refuseDealBelowMinimumBudget`, per pair, at new-deal time.
 *
 * Real `comboHelper.getBaseOrder` + real `MainBot.generateGridsOnPrice` — the
 * spec 086 harness. No venue, no Mongo, no Redis, no price stream.
 *
 * Enforces specs/087 §5 (the refusal) and §6 (what must not move).
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
import { errorDict } from './utils'

/** OKX Europe Linear SOL-USD_UM_XPERP, as the engine sees it. Spec 087 §2. */
const PRICE = 117.56
const STEP = 0.01
const MIN_QTY = 0.01
const MIN_NOTIONAL = 1
const PRICE_PRECISION = 2

const BASE_ORDER_SIZE = 10
/** The base order's own lot floor: `floor(10 / 117.56, 0.01) × 117.56`. */
const BUDGET = 9.4048
/** 11 × (0.01 × 117.56) = 12.93 needed against a 9.40 budget. */
const UNFUNDABLE_LEVELS = 11

let Combo: any

const makeBot = (
  opts: {
    futures?: boolean
    levels?: number
    step?: number
    price?: number
    minQty?: number
  } = {},
) => {
  const {
    futures = true,
    levels = UNFUNDABLE_LEVELS,
    step = STEP,
    price = PRICE,
    minQty = MIN_QTY,
  } = opts

  class TestBot extends Combo {
    math = new MathHelper()
    botId = '000000000000000000000912'
    userId = '000000000000000000000913'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = false
    reported: string[] = []
    data: any = {
      _id: '000000000000000000000912',
      userId: '000000000000000000000913',
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
        profitCurrency: 'quote',
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
        profitCurrency: 'quote',
        orderSizeType: OrderSizeTypeEnum.quote,
        baseOrderSize: `${BASE_ORDER_SIZE}`,
        baseGridLevels: `${levels}`,
        gridLevel: `${levels}`,
        baseStep: '1',
        step: '1',
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
    handleErrors(msg: string) {
      this.reported.push(msg)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

describe('a combo base grid the venue minimum cannot fund (spec 087)', () => {
  before(function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  describe('§5.1 the refusal', () => {
    it('refuses the deal when the budget cannot fund every level', async () => {
      const bot = makeBot()
      expect(await bot.refuseDealBelowMinimumBudget('SOL-USD')).to.equal(true)
      expect(bot.reported).to.have.length(1)
    })

    it('refuses harder as the level count grows', async () => {
      for (const levels of [11, 20, 50]) {
        const bot = makeBot({ levels })
        expect(
          await bot.refuseDealBelowMinimumBudget('SOL-USD'),
          `levels=${levels}`,
        ).to.equal(true)
      }
    })
  })

  describe('§5.2 the message', () => {
    it('names the configured budget, the needed budget, levels and pair', async () => {
      const bot = makeBot()
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      const msg = bot.reported[0]
      expect(msg).to.contain(`Budget ${BUDGET} USDC`)
      // 11 × 0.01 SOL at 117.56 = 12.93 committed; the figure shown is the
      // budget that would fund it, rounded up so the guard accepts it.
      expect(msg).to.contain('13.01 USDC')
      expect(msg).to.contain(`${UNFUNDABLE_LEVELS} levels`)
      expect(msg).to.contain('SOL-USD')
    })

    it('does not claim the bot will stop — this refuses one pair', async () => {
      const bot = makeBot()
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      expect(bot.reported[0]).to.not.contain('Bot will stop')
    })

    it('is not claimed by any text-matched error classification', async () => {
      const bot = makeBot()
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      const msg = bot.reported[0].toLowerCase()
      const claimed = Object.keys(errorDict).filter(
        (k) => msg.indexOf(`${k}`.toLowerCase()) !== -1,
      )
      expect(claimed).to.deep.equal([])
    })
  })

  describe('§5.3 reported once per pair', () => {
    it('reports the first refusal only, while the condition holds', async () => {
      const bot = makeBot()
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      expect(bot.reported).to.have.length(1)
    })

    it('still refuses every time, it is only the report that latches', async () => {
      const bot = makeBot()
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      expect(await bot.refuseDealBelowMinimumBudget('SOL-USD')).to.equal(true)
    })
  })

  describe('§5.4 a correctly funded pair is untouched', () => {
    it('does not refuse at a level count the budget funds', async () => {
      for (const levels of [2, 3, 5, 7, 8]) {
        const bot = makeBot({ levels })
        expect(
          await bot.refuseDealBelowMinimumBudget('SOL-USD'),
          `levels=${levels}`,
        ).to.equal(false)
        expect(bot.reported, `levels=${levels} reported`).to.have.length(0)
      }
    })

    it('clears the latch when the pair becomes fundable again', async () => {
      const bot = makeBot()
      await bot.refuseDealBelowMinimumBudget('SOL-USD')
      expect(bot.standingConditionLatch.size).to.equal(1)
      // A finer lot step funds the same 11 levels out of the same budget.
      bot.getExchangeInfo = async () => ({
        pair: 'SOL-USD',
        priceAssetPrecision: PRICE_PRECISION,
        maxOrders: 500,
        baseAsset: { minAmount: 0.001, step: 0.001, name: 'SOL' },
        quoteAsset: { minAmount: 0.1, step: 0.01, name: 'USDC' },
      })
      expect(await bot.refuseDealBelowMinimumBudget('SOL-USD')).to.equal(false)
      expect(bot.standingConditionLatch.size).to.equal(0)
    })
  })

  describe('§6 what must not move', () => {
    it('§6.2 never refuses a spot combo bot', async () => {
      const bot = makeBot({ futures: false })
      expect(await bot.refuseDealBelowMinimumBudget('SOL-USD')).to.equal(false)
      expect(bot.reported).to.have.length(0)
    })

    it('fails open when the base grid cannot be sized', async () => {
      const bot = makeBot()
      bot.getLatestPrice = async () => 0
      expect(await bot.refuseDealBelowMinimumBudget('SOL-USD')).to.equal(false)
      expect(bot.reported).to.have.length(0)
    })
  })
})
