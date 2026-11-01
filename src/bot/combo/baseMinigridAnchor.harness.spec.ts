process.env.NODE_ENV = 'testing'

/**
 * Main-app spec 218 — a combo deal's base minigrid is laid around the price
 * the base order actually FILLED at, whatever order type the fill came back
 * labelled with.
 *
 * Hyperliquid has no native market order: the connector sends a MARKET as a
 * GTC limit padded 10% through the market. When that order rests for a moment
 * instead of filling at once, the placement answer echoes the un-padded
 * request price and the venue's own `Limit` type, so the engine books the
 * entry as a LIMIT at the request price (`origPrice`). The fill then reports
 * the real execution (`price`). `createMinigrid` anchored every non-MARKET
 * base order on `origPrice`, so the base minigrid sat around a price the deal
 * never traded at: on a thin book 11% above a SHORT's entry, with its
 * buy-backs above the market.
 *
 * Drives the REAL `createMinigrid` → `generateGridsOnPrice` chain with the
 * real grid builders borrowed from MainBot; persistence is stubbed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  OrderTypeEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'

const SYMBOL = 'UANSEM-USDC'
const BOT_ID = '000000000000000000000b18'
const DEAL_ID = '000000000000000000000d18'
/** The request price the placement answer echoed back. */
const REQUESTED = 0.050678
/** The price the base order actually filled at (`REQUESTED * 0.9`). */
const FILLED = 0.04561

let Combo: any
let MainBot: any

const makeBot = (long: boolean, initialPrice: number) => {
  const minigrids: any[] = []
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      initialPrice,
      initialBalances: { base: 0, quote: 0 },
      symbol: { symbol: SYMBOL, baseAsset: 'UANSEM', quoteAsset: 'USDC' },
      settings: {},
      profit: { total: 0, totalUsd: 0, gridProfit: 0, gridProfitUsd: 0 },
      currentBalances: { base: 0, quote: 0 },
      tags: [],
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  let seq = 0
  class TestBot extends Combo {
    math = new MathHelper()
    botId = BOT_ID
    userId = '000000000000000000000018'
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = undefined
    isLong = long
    mgs = minigrids
    data: any = {
      _id: BOT_ID,
      exchange: ExchangeEnum.hyperliquid,
      paperContext: false,
      created: new Date('2026-10-01T00:00:00Z'),
      flags: [],
      settings: {
        name: 'combo',
        pair: [SYMBOL],
        futures: false,
        coinm: false,
        newBalance: false,
        strategy: long ? StrategyEnum.long : StrategyEnum.short,
        profitCurrency: 'quote',
      },
    }
    orders = new Map<string, any>()
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
      return MainBot.prototype.generateBasicGrids.call(this, a)
    }
    generateGridsOnPrice(...a: any[]) {
      return MainBot.prototype.generateGridsOnPrice.apply(this, a)
    }
    getSellBuyCount(...a: any[]) {
      return MainBot.prototype.getSellBuyCount.apply(this, a)
    }
    async baseAssetPrecision() {
      return 0
    }
    async getAggregatedSettings() {
      return {
        futures: false,
        coinm: false,
        profitCurrency: 'quote',
        step: '2',
        stepScale: '1',
        gridLevel: '5',
      }
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 6,
        maxOrders: 500,
        baseAsset: { minAmount: 1, step: 1, name: 'UANSEM' },
        quoteAsset: { minAmount: 10, step: 0.000001, name: 'USDC' },
      }
    }
    async getUserFee() {
      return { maker: 0.0004, taker: 0.0007 }
    }
    minigridDb = {
      createData: async (d: any) => ({
        status: 'OK',
        data: { ...d, _id: `00000000000000000000a${minigrids.length}00` },
      }),
    }
    setMinigrid(m: any) {
      minigrids.push(m)
    }
    getMinigrid(id: string) {
      return minigrids.find((m) => m.schema._id === id)
    }
    getMinigridByDealId() {
      return minigrids
    }
    liveMinigridForOrder() {
      return undefined
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    getOrderId(prefix: string) {
      seq++
      return `${prefix}-${seq}`
    }
    saveDeal() {
      return Promise.resolve()
    }
    saveMinigrid() {
      return Promise.resolve()
    }
    async setToRedis() {}
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

/** A filled base order as the engine holds it after the fill was processed. */
const baseOrder = (
  long: boolean,
  type: OrderTypeEnum,
  price: number,
  origPrice: number,
) => ({
  clientOrderId: '0x7c3c97193a93dfe041643191f9b9e6a5',
  symbol: SYMBOL,
  dealId: DEAL_ID,
  botId: BOT_ID,
  typeOrder: TypeOrderEnum.dealStart,
  type,
  side: long ? 'BUY' : 'SELL',
  price: `${price}`,
  origPrice: `${origPrice}`,
  origQty: '994',
  executedQty: '994',
  cummulativeQuoteQty: `${994 * price}`,
  status: 'FILLED',
  dcaLevel: 1,
  updateTime: 1,
  transactTime: 1,
})

const minigridFor = async (long: boolean, order: any, initialPrice: number) => {
  const bot = makeBot(long, initialPrice)
  const grids = (await bot.createMinigrid(
    bot.getDeal(DEAL_ID).deal,
    order,
    false,
  )) as { side: string; price: number; qty: number }[]
  return { grids, minigrid: bot.mgs[0] }
}

describe('combo base minigrid is anchored on the base fill (spec 218)', () => {
  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    Combo = req('../comboHelper').default()
    MainBot = req('../main').default
  })

  it('§3.1 a SHORT base booked LIMIT at the request price lays its range below the fill', async () => {
    const { grids, minigrid } = await minigridFor(
      false,
      baseOrder(false, OrderTypeEnum.limit, FILLED, REQUESTED),
      FILLED,
    )
    expect(minigrid, 'a minigrid was created').to.exist
    expect(minigrid.schema.settings.topPrice).to.be.closeTo(FILLED, 1e-9)
    expect(minigrid.schema.settings.lowPrice).to.be.closeTo(FILLED * 0.98, 1e-6)
    const buys = grids.filter((g) => g.side === OrderSideEnum.buy)
    expect(buys.length, 'the ladder has buy-backs').to.be.greaterThan(0)
    for (const b of buys) {
      expect(
        b.price,
        `buy-back ${b.price} must not sit above the ${FILLED} entry`,
      ).to.be.at.most(FILLED)
    }
  })

  it('§3.2 a LONG base booked LIMIT at the request price lays its range above the fill', async () => {
    const requested = 0.04561
    const filled = 0.050678
    const { grids, minigrid } = await minigridFor(
      true,
      baseOrder(true, OrderTypeEnum.limit, filled, requested),
      filled,
    )
    expect(minigrid.schema.settings.lowPrice).to.be.closeTo(filled, 1e-9)
    for (const s of grids.filter((g) => g.side === OrderSideEnum.sell)) {
      expect(s.price).to.be.at.least(filled)
    }
  })

  it('§4.1 a MARKET base keeps anchoring on its fill, as before', async () => {
    const { minigrid } = await minigridFor(
      false,
      baseOrder(false, OrderTypeEnum.market, FILLED, REQUESTED),
      FILLED,
    )
    expect(minigrid.schema.settings.topPrice).to.be.closeTo(FILLED, 1e-9)
  })

  it('§4.2 a base whose fill price is not usable falls back to the request price', async () => {
    for (const price of ['0', 'NaN']) {
      const order = {
        ...baseOrder(false, OrderTypeEnum.limit, FILLED, REQUESTED),
        price,
      }
      const { minigrid } = await minigridFor(false, order, REQUESTED)
      expect(minigrid.schema.settings.topPrice, `price ${price}`).to.be.closeTo(
        REQUESTED,
        1e-9,
      )
    }
  })

  it('§4.3 a safety-order minigrid still anchors on its level price', async () => {
    const order = {
      ...baseOrder(false, OrderTypeEnum.limit, 0.0466, 0.046522),
      typeOrder: TypeOrderEnum.regular,
      dcaLevel: 2,
    }
    const { minigrid } = await minigridFor(false, order, FILLED)
    expect(minigrid.schema.settings.topPrice).to.be.closeTo(0.046522, 1e-9)
  })
})
