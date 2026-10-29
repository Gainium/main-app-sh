process.env.NODE_ENV = 'testing'

/**
 * A base order the venue fills short is topped up by `buyRemainder`, and the
 * top-up is merged into the base-order row. The placement answer used to open
 * the deal on the part-fill while that top-up was still in flight on the user
 * stream, so the deal never counted what the top-up bought.
 *
 * The figures are the production case (Bitget spot, 2026-10-28; identifiers
 * dropped, this file is public): a MARKET base order for 7.2923 answered
 * FILLED at 7.2571, topped up to the venue minimum of 5 at 0.2069.
 *
 * Spec: `specs/208.placement-answer-opens-the-deal-before-the-top-up-merges.md`.
 * Run: `npm test` (mocha). No network / DB — the REAL `placeBaseOrder`,
 * `fillPartiallyFilledOrder` and `buyRemainder` run off the prototype; the
 * venue is a stub whose top-up answer the test releases by hand.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import { BotType, ExchangeEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b08'
const DEAL_ID = '000000000000000000000d08'
const SYMBOL = 'SUSHIUSDT'
const BASE_ID = 'D-BO-test0000000000000000000000208'

const loadModule = createRequire(__filename)
let Helper: any

const baseRow = (over: Record<string, unknown> = {}) => ({
  clientOrderId: BASE_ID,
  orderId: '1',
  symbol: SYMBOL,
  side: 'BUY',
  type: 'MARKET',
  typeOrder: TypeOrderEnum.dealStart,
  status: 'FILLED',
  origQty: '7.2923',
  executedQty: '7.2571',
  price: '0.2069',
  origPrice: '0.2069',
  cummulativeQuoteQty: '1.50149399',
  exchange: ExchangeEnum.bitget,
  dealId: DEAL_ID,
  botId: BOT_ID,
  updateTime: 1,
  transactTime: 1,
  ...over,
})

/**
 * @param answer the venue's FILLED answer to the base-order placement
 */
const buildBot = (answer = baseRow()) => {
  const rec = {
    started: [] as any[],
    topUps: [] as any[],
    db: [] as { order: any; force: boolean }[],
  }
  let releaseTopUp: () => void = () => undefined
  const topUpAnswered = new Promise<void>((r) => (releaseTopUp = r))
  const bot: any = Object.create(Helper.prototype)
  Object.assign(bot, {
    botId: BOT_ID,
    userId: 'user',
    botType: BotType.dca,
    loadingComplete: true,
    exchange: {},
    data: {
      exchange: ExchangeEnum.bitget,
      settings: { type: 'regular', remainderFullAmount: true },
      flags: [],
    },
    math: new MathHelper(),
    orders: new Map(),
    partiallyFilledFilledSet: new Set(),
    allowToPlaceOrders: new Map(),
    standingConditionLatch: new ConditionLatch(STANDING_CONDITION_REARM_MS),
    slippageRetry: 5,
    dealTimersMap: new Map(),
    rec,
    shouldProceed: () => true,
    startMethod: () => '1',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    getAggregatedSettings: async () => ({ startOrderType: 'MARKET' }),
    getDeal: () => ({ deal: { _id: DEAL_ID, status: 'start' } }),
    getOrdersByStatusAndDealId: () => [],
    getBaseOrder: async () => ({ ...baseRow(), status: 'NEW' }),
    sendOrderToExchange: async () => ({ ...answer }),
    getExchangeInfo: async () => ({
      pair: SYMBOL,
      priceAssetPrecision: 4,
      baseAsset: { minAmount: 5, step: 0.0001, name: 'SUSHI' },
      quoteAsset: { minAmount: 1, name: 'USDT' },
    }),
    getLatestPrice: async () => 0.2069,
    baseAssetPrecision: async () => 4,
    getOrderId: (p: string) => `${p}-test`,
    sendGridToExchange: async (grid: any) => {
      rec.topUps.push(grid)
      await topUpAnswered
      return {
        clientOrderId: grid.newClientOrderId,
        side: 'BUY',
        status: 'FILLED',
        executedQty: `${grid.qty}`,
        price: '0.2069',
        transactTime: 2,
      }
    },
    updateOrderOnDb: async (order: any, force = false) => {
      rec.db.push({ order: { ...order }, force })
    },
    startDeal: async (order: any) => {
      rec.started.push({ ...order })
    },
  })
  Object.defineProperty(bot, 'coinm', { value: false, configurable: true })
  return { bot, rec, releaseTopUp }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('the placement answer opens the deal on the topped-up base row (spec 208)', () => {
  before(function () {
    // One ts-node compile of the whole DCA helper.
    this.timeout(180000)
    Helper = loadModule('./dcaHelper').default(MainBot as any)
  })

  it('§4.1 stream first: waits for the in-flight top-up and opens on the merged row', async () => {
    const { bot, rec, releaseTopUp } = buildBot()
    // The user stream's FILLED report reaches `fillPartiallyFilledOrder` first
    // and its top-up is on the way to the venue.
    const stream = bot.fillPartiallyFilledOrder(baseRow())
    await tick()
    expect(rec.topUps, 'stream sent the top-up').to.have.length(1)

    const placing = bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
    await tick()
    releaseTopUp()
    await Promise.all([placing, stream])

    expect(rec.started, 'startDeal calls').to.have.length(1)
    expect(+rec.started[0].executedQty).to.equal(12.2571)
    expect(rec.topUps, 'one top-up').to.have.length(1)
  })

  it('§4.2 answer first: tops up, persists the merge and opens on it', async () => {
    const { bot, rec, releaseTopUp } = buildBot()
    releaseTopUp()
    await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)

    expect(rec.started, 'startDeal calls').to.have.length(1)
    expect(+rec.started[0].executedQty).to.equal(12.2571)
    expect(+rec.started[0].price).to.be.closeTo(0.2069, 1e-9)
    const written = rec.db.find((w) => w.order.clientOrderId === BASE_ID)
    expect(written, 'merged row written').to.exist
    expect(+written!.order.executedQty).to.equal(12.2571)
    expect(written!.force, 'forced over the terminal row').to.equal(true)

    // §4.3: the stream's later report of the same order buys nothing more.
    const streamed = await bot.fillPartiallyFilledOrder(baseRow())
    expect(+streamed.executedQty).to.equal(12.2571)
    expect(rec.topUps, 'one top-up').to.have.length(1)
  })

  it('§4.3 the top-up is the same order, of the same size, in both arrivals', async () => {
    const streamFirst = buildBot()
    const s = streamFirst.bot.fillPartiallyFilledOrder(baseRow())
    await tick()
    const p = streamFirst.bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
    streamFirst.releaseTopUp()
    await Promise.all([s, p])

    const answerFirst = buildBot()
    answerFirst.releaseTopUp()
    await answerFirst.bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
    await answerFirst.bot.fillPartiallyFilledOrder(baseRow())

    const shape = (g: any) => ({ qty: g.qty, side: g.side, type: g.type })
    expect(streamFirst.rec.topUps.map(shape)).to.deep.equal(
      answerFirst.rec.topUps.map(shape),
    )
    expect(answerFirst.rec.topUps[0].qty).to.equal(5)
  })

  it('§4.4 a base order filled in full opens as answered, no top-up, no write', async () => {
    const { bot, rec, releaseTopUp } = buildBot(
      baseRow({ executedQty: '7.2923' }),
    )
    releaseTopUp()
    await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)

    expect(rec.started).to.have.length(1)
    expect(+rec.started[0].executedQty).to.equal(7.2923)
    expect(rec.topUps).to.have.length(0)
    expect(rec.db).to.have.length(0)
  })
})
