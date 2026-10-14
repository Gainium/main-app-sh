process.env.NODE_ENV = 'testing'

/**
 * A combo bot — and each side of a hedge combo bot — refuses a deal whose Base
 * or DCA order the exchange minimum would inflate, like a DCA bot, unless
 * `allowRaiseToExchangeMin` is on. A missing value refuses.
 *
 * Drives the inherited `refuseDealBelowExchangeMin` through the REAL combo
 * `getBaseOrder` and `createInitialDealOrders` (with the engine's grid
 * generators borrowed from `MainBot`), so the floors it judges are the ones the
 * combo sizing records. No stack, DB, Redis or venue.
 *
 * Fixture: a spot combo long on a pair whose base minimum is 200 units at
 * 0.1831 (≈ 36.6 quote), configured with a 10.8 base order and 3.6 DCA orders.
 *
 * Fixture ids are synthetic — this file is public.
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
import { ConditionLatch } from './conditionLatch'

const PAIR = 'SYN-USD'
const PRICE = 0.1831

let Combo: any

const makeBot = (
  overrides: Record<string, unknown> = {},
  stored: { allowRaiseToExchangeMin?: boolean } = {},
) => {
  class TestBot extends Combo {
    math = new MathHelper()
    botId = '000000000000000000000d12'
    userId = '000000000000000000000d13'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = false
    useCompountReduce = false
    standingConditionLatch = new ConditionLatch()
    reported: string[] = []
    data: any = {
      _id: '000000000000000000000d12',
      userId: '000000000000000000000d13',
      exchange: ExchangeEnum.paperBinance,
      paperContext: true,
      created: new Date('2026-06-01'),
      symbol: { symbol: PAIR, baseAsset: 'SYN', quoteAsset: 'USD' },
      flags: [],
      settings: { name: 'combo', pair: [PAIR], futures: false },
    }
    db = {
      async readData() {
        return { status: 'OK', data: { result: { settings: stored } } }
      },
    }
    botEventDb = { createData() {} }
    async processError(...a: any[]) {
      this.reported.push(a[5])
    }
    get isLong() {
      return true
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
        type: 'regular',
        futures: false,
        coinm: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
        orderSizeType: OrderSizeTypeEnum.quote,
        baseOrderSize: '10.8',
        orderSize: '3.6',
        ordersCount: 3,
        useDca: true,
        step: '1',
        stepScale: '1',
        volumeScale: '1',
        baseStep: '1',
        baseGridLevels: '1',
        gridLevel: '1',
        ...overrides,
      }
    }
    async getExchangeInfo() {
      return {
        pair: PAIR,
        priceAssetPrecision: 4,
        maxOrders: 500,
        baseAsset: { name: 'SYN', minAmount: 200, step: 1e-8 },
        quoteAsset: { name: 'USD', minAmount: 0.5, step: 0.0001 },
      }
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async getLatestPrice() {
      return PRICE
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
  }
  return new (TestBot as any)()
}

describe('combo — refuse instead of inflating Base/DCA orders', () => {
  before(function () {
    // One ts-node compile of the combo mixin over the 10k-line base.
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  it('refuses when the setting is missing and names the orders', async () => {
    const bot = makeBot()
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
    expect(bot.reported).to.have.length(1)
    expect(bot.reported[0]).to.contain('Base Order')
  })

  it('refuses when the setting is off', async () => {
    const bot = makeBot({ allowRaiseToExchangeMin: false })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
  })

  it('raises as before when the setting is on', async () => {
    const bot = makeBot({ allowRaiseToExchangeMin: true })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
    expect(bot.reported).to.deep.equal([])
  })

  it('reads a value missing in memory from Mongo', async () => {
    const bot = makeBot({}, { allowRaiseToExchangeMin: true })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
  })

  it('refuses on a DCA order alone', async () => {
    const bot = makeBot({ baseOrderSize: '37' })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
    expect(bot.reported[0]).to.not.contain('Base Order')
  })

  it('opens when every order clears the minimum', async () => {
    const bot = makeBot({ baseOrderSize: '37', orderSize: '37' })
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(false)
  })

  it('refuses on a hedge combo side like on a combo bot', async () => {
    const bot = makeBot()
    bot.data = { ...bot.data, parentBotId: '000000000000000000000d99' }
    expect(await bot.refuseDealBelowExchangeMin(PAIR)).to.equal(true)
  })
})
