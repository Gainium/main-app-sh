process.env.NODE_ENV = 'testing'

/**
 * A combo grid level whose size already sits on the venue lot step must keep
 * that size. `MainBot.generateGridsOnPrice` aligns every level to the lot step
 * with a float remainder (`%`, or `MathHelper.remainder` on newBalance bots)
 * and a ceiling; on an exact multiple the remainder can come back as a hair
 * under a whole step (0.118 % 0.001 = 0.000999…), and the ceiling turns that
 * into one extra lot.
 *
 * Reproduction: a 1x long USDT perpetual, 0.001 lot step, price 201.30, base
 * order 25 quote, one base-grid level at a 5 % step. The pair is described by
 * its filters only — no venue, no Mongo, no Redis, no price stream.
 *
 * Enforces specs/146 §4 (aligned quantities keep their size) and §5 (what
 * must not move).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  OrderSizeTypeEnum,
  StrategyEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

const PRICE = 201.3
const STEP = 0.001
const MIN_QTY = 0.001
const MIN_NOTIONAL = 20
const PRICE_PRECISION = 2
/** What the venue-minimum raise produces in §5.3, unchanged by the fix. */
const MIN_BUMPED = 0.15

let Combo: any

const makeBot = (
  opts: {
    newBalance?: boolean
    step?: number
    minQty?: number
    minNotional?: number
    price?: number
  } = {},
) => {
  const {
    newBalance = false,
    step = STEP,
    minQty = MIN_QTY,
    minNotional = MIN_NOTIONAL,
    price = PRICE,
  } = opts

  class TestBot extends Combo {
    math = new MathHelper()
    botId = '000000000000000000001102'
    userId = '000000000000000000001103'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = undefined
    data: any = {
      _id: '000000000000000000001102',
      userId: '000000000000000000001103',
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      created: new Date('2026-06-01'),
      symbol: { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
      flags: [],
      settings: {
        name: 'combo',
        pair: ['ETHUSDT'],
        futures: true,
        coinm: false,
        newBalance,
        strategy: StrategyEnum.long,
        futuresStrategy: 'LONG',
        profitCurrency: 'quote',
      },
    }
    get isLong() {
      return true
    }
    get futures() {
      return true
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
    async getAggregatedSettings() {
      return {
        futures: true,
        coinm: false,
        profitCurrency: 'quote',
        orderSizeType: OrderSizeTypeEnum.quote,
        baseOrderSize: '25',
        baseGridLevels: '1',
        gridLevel: '1',
        baseStep: '5',
        step: '5',
        stepScale: '1.07',
      }
    }
    async getExchangeInfo() {
      return {
        pair: 'ETHUSDT',
        priceAssetPrecision: PRICE_PRECISION,
        maxOrders: 500,
        baseAsset: { minAmount: minQty, step, name: 'ETH' },
        quoteAsset: { minAmount: minNotional, step: 0.01, name: 'USDT' },
      }
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.0005 }
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

/**
 * The minigrid `createMinigrid` lays over a filled MARKET base order: one
 * level above the fill, spaced by the taker fee, budget = fill notional.
 */
const minigridAfterFill = async (
  bot: any,
  executedQty: number,
  price: number,
  minigridBudget?: number,
) => {
  const fee = 0.0005
  const gridStep = price * 0.05
  const initialGrids = await bot.generateBasicGrids({
    pair: 'ETHUSDT',
    topPrice: price + gridStep,
    lowPrice: price,
    sellDisplacement: fee * 2,
    gridType: 'arithmetic',
    levels: 1,
  })
  const precision = await bot.baseAssetPrecision('ETHUSDT')
  return (await bot.generateGridsOnPrice(
    {
      pair: 'ETHUSDT',
      initialGrids,
      lowPrice: price,
      topPrice: price + gridStep,
      levels: 1,
      updatedBudget: true,
      _budget:
        minigridBudget ?? bot.math.round(executedQty * price, precision, true),
      _lastPrice: price,
      _initialPriceStart: price,
      _side: OrderSideEnum.buy,
      all: true,
      profitCurrency: 'quote',
      orderFixedIn: 'base',
    },
    false,
    bot.data.settings.newBalance,
    undefined,
    false,
  )) as { qty: number; side: string; price: number }[]
}

/**
 * A one-level minigrid whose level comes out of the futures base-fixed sizing
 * (budget / level price) as exactly `qty`, before the lot alignment.
 */
const minigridForQty = async (bot: any, qty: number, price: number) => {
  const [probe] = await minigridAfterFill(bot, qty, price)
  // A hair over, so the precision rounding ahead of the alignment cannot
  // floor qty·price/price back below `qty`.
  return minigridAfterFill(bot, qty, price, qty * probe.price * (1 + 1e-9))
}

describe('combo grid lot alignment keeps aligned quantities (spec 146)', () => {
  before(function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  describe('§3 the reproduction', () => {
    it('§3.1 the base order buys the 118 lots the budget pays for', async () => {
      // `%` read the 0.118 grid pivot as 117.999… lots and rounded it up to
      // 0.119; the base order paid for that lot out of its own size: 0.117.
      for (const newBalance of [false, true]) {
        const bot = makeBot({ newBalance })
        const order = await bot.getBaseOrder('ETHUSDT')
        expect(+order.origQty, `newBalance=${newBalance}`).to.equal(0.118)
      }
    })

    it('§3.2 the minigrid over the filled base order sells what it bought', async () => {
      for (const newBalance of [false, true]) {
        const bot = makeBot({ newBalance })
        const order = await bot.getBaseOrder('ETHUSDT')
        const grids = await minigridAfterFill(
          bot,
          +order.origQty,
          PRICE,
          order.minigridBudget,
        )
        expect(grids, `newBalance=${newBalance}`).to.have.length(1)
        expect(grids[0].side).to.equal(OrderSideEnum.sell)
        expect(grids[0].price).to.equal(211.58)
        expect(grids[0].qty, `newBalance=${newBalance}`).to.equal(0.118)
      }
    })

    it('§3.3 holds at the other reported prices', async () => {
      const cases: [number, number][] = [
        [200.3, 0.118],
        [399.56, 0.059],
        [100.75, 0.236],
      ]
      for (const [price, qty] of cases) {
        const bot = makeBot({ price })
        const order = await bot.getBaseOrder('ETHUSDT')
        const grids = await minigridAfterFill(
          bot,
          +order.origQty,
          price,
          order.minigridBudget,
        )
        expect(+order.origQty, `buy @${price}`).to.equal(qty)
        expect(grids[0].qty, `sell @${price}`).to.equal(qty)
      }
    })

    it('§3.4 the newBalance remainder keeps an aligned 0.29 at a 0.01 step', async () => {
      // `MathHelper.remainder(0.29, 0.01)` is 0.00999…, so the 0.29 pivot
      // gained a lot and the level it sizes came out a lot short: 0.28.
      for (const newBalance of [false, true]) {
        for (const [qty, step] of [
          [0.29, 0.01],
          [0.57, 0.01],
          [1.13, 0.01],
          // On the grid of a step the precision does not divide: the unfixed
          // `%` path produced 0.119, which is not even a multiple of 0.002.
          [0.118, 0.002],
        ]) {
          const bot = makeBot({
            newBalance,
            step,
            minQty: step,
            minNotional: 1,
            price: 100,
          })
          const grids = await minigridForQty(bot, qty, 100)
          expect(
            grids[0].qty,
            `newBalance=${newBalance} ${qty}/${step}`,
          ).to.equal(qty)
        }
      }
    })
  })

  describe('§4 the aligned-quantity test', () => {
    const math = new MathHelper()
    it('§4.1 a quantity exactly on a lot has no remainder', () => {
      expect(math.gridRemainder(0.118, 0.001)).to.equal(0)
      expect(math.gridRemainder(0.29, 0.01)).to.equal(0)
      expect(math.gridRemainder(0.235, 0.001)).to.equal(0)
      expect(math.gridRemainder(0.3, 0.1)).to.equal(0)
      expect(math.gridRemainder(2.2, 0.05)).to.equal(0)
      expect(math.gridRemainder(0.00000491, 1e-8)).to.equal(0)
    })

    it('§4.2 just below and just above a lot keep their remainder', () => {
      expect(math.gridRemainder(0.1179, 0.001)).to.be.closeTo(0.0009, 1e-12)
      expect(math.gridRemainder(0.1181, 0.001)).to.be.closeTo(0.0001, 1e-12)
      expect(math.gridRemainder(0.289, 0.01)).to.be.closeTo(0.009, 1e-12)
      expect(math.gridRemainder(0.291, 0.01)).to.be.closeTo(0.001, 1e-12)
    })

    it('§4.3 every exact multiple reads as aligned, across steps', () => {
      const steps = [
        10, 5, 1, 0.5, 0.25, 0.1, 0.05, 0.01, 0.005, 0.001, 1e-4, 1e-5, 1e-6,
        1e-7, 1e-8,
      ]
      for (const step of steps) {
        const p = Math.max(
          0,
          -Math.floor(Math.log10(step) + 1e-9) +
            (step === 0.25 || step === 0.005 || step === 0.05 || step === 0.5
              ? 1
              : 0),
        )
        for (let k = 1; k <= 5000; k++) {
          const q = +(k * step).toFixed(p)
          expect(math.gridRemainder(q, step), `${q}/${step}`).to.equal(0)
        }
      }
    })
  })

  describe('§5 what must not move', () => {
    const math = new MathHelper()
    it('§5.1 an off-step quantity keeps exactly the remainder it had', () => {
      for (const step of [0.1, 0.01, 0.001, 1e-5, 1e-8, 0.05, 5]) {
        for (let k = 1; k <= 3000; k++) {
          for (const frac of [0.1, 0.5, 0.9]) {
            const q = k * step + frac * step
            expect(math.gridRemainder(q, step), `${q}/${step}`).to.equal(
              math.remainder(q, step),
            )
          }
        }
      }
    })

    it('§5.2 a step the precision does not divide sizes exactly as before', async () => {
      // [step, wanted size, size the unfixed engine produced]. These steps let
      // an off-step size reach the alignment (0.117 at 0.002, 3 at 2, 1 at
      // 0.4); every output is pinned to the pre-fix engine's.
      const cases: [number, number, number][] = [
        [0.002, 0.117, 0.116],
        [0.002, 0.235, 0.234],
        [2, 3, 2],
        [2, 7, 6],
        [0.4, 1, 0.4],
        [0.4, 3, 2],
        [0.02, 0.57, 0.6],
        [5, 23, 25],
        [0.25, 1.1, 1],
      ]
      for (const newBalance of [false, true]) {
        for (const [step, qty, was] of cases) {
          const bot = makeBot({
            newBalance,
            step,
            minQty: step,
            minNotional: 1,
            price: 100,
          })
          const grids = await minigridForQty(bot, qty, 100)
          expect(
            grids[0].qty,
            `newBalance=${newBalance} ${qty}/${step}`,
          ).to.equal(was)
        }
      }
    })

    it('§5.3 the venue minimum still raises a level below it', async () => {
      // 0.118 ETH at ~211.58 is ~25 quote; a 30-quote minimum lifts the level.
      const bot = makeBot({ minNotional: 30 })
      const grids = await minigridForQty(bot, 0.118, PRICE)
      expect(grids[0].qty * grids[0].price).to.be.at.least(30)
      expect(grids[0].qty).to.equal(MIN_BUMPED)
    })
  })
})
