process.env.NODE_ENV = 'testing'

/**
 * Spec 252: a Combo safety order whose stored quantity is the level's PRICE.
 *
 * `dcaHelper.afterUpdateExchangeInfo` used to re-round `price` into `qty`
 * whenever a venue lowered a pair's base precision, and the Redis snapshot
 * kept the result across every later restart: each restart re-sent the level
 * as "qty 3095.89 @ 3095.89", which the venue refused.
 *
 * Drives the REAL combo `afterUpdateExchangeInfo`, `repairRestoredLadder`,
 * `createInitialDealOrders` (with the real grid builders borrowed from
 * MainBot) and `getDiffForCheckOrders`. No stack, DB, Redis or exchange.
 * The deal shape is the production one (spot long, quote order size 1000,
 * volume scale 0.8, profit in base, newBalance, `newSell`); ids are synthetic.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  OrderSizeTypeEnum,
  TypeOrderEnum,
} from '../../../types'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'
import { isOutOfLevelBudget, levelBudgetFactor } from './ladderLevelBudget'

const SYMBOL = 'ETHUSDC'
const DEAL_ID = '000000000000000000000d52'
const settings: any = {
  useDca: true,
  futures: false,
  coinm: false,
  profitCurrency: 'base',
  orderSizeType: OrderSizeTypeEnum.quote,
  orderSize: '1000',
  baseOrderSize: '500',
  ordersCount: 10,
  step: '5',
  stepScale: '1',
  volumeScale: '0.8',
  gridLevel: '7',
  strategy: 'LONG',
  comboActiveMinigrids: '1',
  useActiveMinigrids: true,
  newBalance: true,
  updatedComboAdjustments: true,
}
/** The resting ladder as the deal opened it: level, price, qty. */
const OPENED: [number, number, number][] = [
  [6, 3095.89, 0.1323],
  [7, 2889.5, 0.1134],
  [8, 2683.11, 0.0977],
  [9, 2476.72, 0.08468],
  [10, 2270.33, 0.0739],
  [11, 2063.94, 0.06503],
]
const grid = ([level, price, qty]: [number, number, number]) => ({
  number: level - 1,
  price,
  qty,
  side: OrderSideEnum.buy,
  newClientOrderId: `CMB-RO-${level}`,
  type: TypeOrderEnum.dealRegular,
  dealId: DEAL_ID,
  dcaLevel: level,
  minigridBudget: qty * price,
})

let Combo: any

const buildBot = () => {
  const notices: string[] = []
  const deal: any = {
    _id: DEAL_ID,
    status: 'open',
    newBalance: true,
    tags: ['newSell'],
    flags: ['futuresPrecision'],
    symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'USDC' },
    settings: { ...settings },
    initialPrice: 4127.84,
    lastPrice: 2889.5,
    avgPrice: 3323.86,
    // The corrupted totals; nothing below may read them.
    size: 4626.63,
    cost: 15378270.56,
    sizes: { dca: [] },
    levels: { all: 11, complete: 5 },
  }
  const full: any = {
    deal,
    initialOrders: OPENED.map(grid),
    currentOrders: OPENED.map(grid),
    previousOrders: [],
  }
  class TestBot extends Combo {
    math = new MathHelper()
    botId = '000000000000000000000b52'
    userId = '000000000000000000000a52'
    botType = BotType.combo
    exchange = {} as any
    orders = new Map()
    log = false
    hedge = false
    feeOrder = undefined
    precisions = new Map([[SYMBOL, 2]])
    basePrecisions = new Map([[SYMBOL, 6]])
    allMinigrids: any[] = []
    data: any = {
      _id: '000000000000000000000b52',
      userId: '000000000000000000000a52',
      exchange: ExchangeEnum.bybit,
      created: new Date('2025-08-13'),
      flags: [],
      settings: { ...settings },
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
        pair: SYMBOL,
        priceAssetPrecision: 2,
        maxOrders: 500,
        baseAsset: { minAmount: 0.00001, step: 0.00001, name: 'ETH' },
        quoteAsset: { minAmount: 1, step: 0.0000001, name: 'USDC' },
      }
    }
    async baseAssetPrecision() {
      return 5
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? full : undefined
    }
    getDealsByStatusAndSymbol() {
      return [full]
    }
    saveDeal() {}
    setDealToRedis() {}
    saveMinigridToRedis() {}
    getMinigridByDealId() {
      return []
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async postUserNotice(m: string) {
      notices.push(m)
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
  bot.isLong = true
  return { bot, full, notices }
}

describe('combo safety orders sized by their price (spec 252)', () => {
  before(function () {
    this.timeout(300000)
    Combo = createRequire(__filename)('../comboHelper').default()
  })

  it('§2.1 a lower base precision re-rounds the quantity, not the price', async () => {
    const { bot, full } = buildBot()
    await bot.afterUpdateExchangeInfo(new Set([SYMBOL]))
    const qtys = full.initialOrders.map((g: any) => g.qty)
    expect(qtys).to.deep.equal(OPENED.map(([, , q]) => q))
    expect(full.currentOrders.map((g: any) => g.qty)).to.deep.equal(qtys)
  })

  it('§2.2 a restored level holding qty = price is re-sized from the settings and the user is told', async () => {
    const { bot, full, notices } = buildBot()
    const corrupted = OPENED.map(grid).map((g) => ({ ...g, qty: g.price }))
    const repaired = await bot.repairRestoredLadder(full, corrupted)
    expect(repaired.map((g: any) => g.price)).to.deep.equal(
      OPENED.map(([, p]) => p),
    )
    // Re-derived at the deal's own sizing: within 0.5% of what it opened with.
    repaired.forEach((g: any, i: number) =>
      expect(g.qty, `level ${g.dcaLevel}`).to.be.closeTo(
        OPENED[i][2],
        OPENED[i][2] * 0.005,
      ),
    )
    expect(notices).to.have.length(1)
    expect(notices[0]).to.match(/6 safety order\(s\).*recalculated/)
  })

  it('§2.3 a healthy restored ladder is returned untouched, with no message', async () => {
    const { bot, full, notices } = buildBot()
    const ladder = OPENED.map(grid)
    const out = await bot.repairRestoredLadder(full, ladder)
    expect(out).to.deep.equal(ladder)
    expect(notices).to.deep.equal([])
  })

  it('§2.4 the restart reconcile refuses an oversized level and sends the rest', async () => {
    const { bot, full, notices } = buildBot()
    const ok = grid(OPENED[1])
    const bad = { ...grid(OPENED[0]), qty: OPENED[0][1] }
    bot.findDiffCombo = async () => ({ new: [bad, ok], cancel: [] })
    const diff = await bot.getDiffForCheckOrders(full, [])
    expect(diff.new).to.deep.equal([ok])
    expect(notices).to.have.length(1)
    expect(notices[0]).to.match(/refused 1 safety order/)
  })

  it('§2.5 a level raised to the exchange minimum is never out of budget', () => {
    const factor = levelBudgetFactor('7')
    // Budget 5 USDC, every one of 7 minigrid levels raised to a 1.1 minimum.
    const raised: any = {
      ...grid([2, 100, 0.05]),
      qty: 0.077,
      minigridBudget: 5,
    }
    expect(isOutOfLevelBudget(raised, false, factor)).to.equal(false)
    expect(
      isOutOfLevelBudget({ ...raised, type: TypeOrderEnum.dealTP }, false, 1),
    ).to.equal(false)
    expect(
      isOutOfLevelBudget({ ...raised, minigridBudget: undefined }, false, 1),
    ).to.equal(false)
  })
})
