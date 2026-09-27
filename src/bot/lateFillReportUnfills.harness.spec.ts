process.env.NODE_ENV = 'testing'

/**
 * Spec `114` §1.2/§4.2 — a `PARTIALLY_FILLED` report delivered after the
 * `FILLED` one, with the same timestamp, must not make a filled grid order
 * look live again.
 *
 * Driven over the REAL `convertExecutionReportToOrder`, `setOrder`/`deleteOrder`
 * (the status index) and `isOrderExistInDeal` (`dcaHelper.ts`) — the three
 * steps between the stale report and the counter order that was never placed.
 *
 * The production sequence (Kraken spot, a combo deal-grid BUY, 2026-09-26; the
 * quantities and timestamp are the real ones, identifiers are synthetic because
 * this file is public):
 *
 *   21:50:03.103  FILLED            base 506.53547  t 1790459402861
 *   21:50:03.104  PARTIALLY_FILLED  base 506.53547  t 1790459402861   ← same t
 *   22:16:10.307  Order already exist qty: 506.53547, price: 0.08215, side: BUY
 *
 * Run: `npm test` (mocha). No network / DB.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import {
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
  type ExecutionReport,
  type Grid,
  type Order,
} from '../../types'

const SYMBOL = 'GNOT-USD'
const CLIENT_ORDER_ID = 'CMB-GR-00000000114'
const DEAL_ID = '000000000000000000000d14'
const MINIGRID_ID = '000000000000000000000a14'
const BOT_ID = '000000000000000000000b14'
const USER_ID = '000000000000000000000414'

const PRICE = '0.08215'
const QTY = '506.53547'
const QUOTE = '41.61189'
const AT = 1790459402861

const restingGridBuy = () =>
  ({
    symbol: SYMBOL,
    baseAsset: 'GNOT',
    quoteAsset: 'USD',
    orderId: 'OAAAAA-BBBBB-CCCCCC',
    clientOrderId: CLIENT_ORDER_ID,
    dealId: DEAL_ID,
    minigridId: MINIGRID_ID,
    typeOrder: TypeOrderEnum.dealGrid,
    type: 'LIMIT',
    side: 'BUY',
    price: PRICE,
    origPrice: PRICE,
    origQty: QTY,
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    updateTime: AT - 96_000,
    transactTime: AT - 96_000,
    botId: BOT_ID,
    userId: USER_ID,
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '',
  }) as unknown as Order

const report = (orderStatus: string): ExecutionReport =>
  ({
    eventType: 'executionReport',
    eventTime: AT,
    creationTime: AT,
    orderTime: AT,
    newClientOrderId: CLIENT_ORDER_ID,
    originalClientOrderId: CLIENT_ORDER_ID,
    orderId: 'OAAAAA-BBBBB-CCCCCC',
    orderStatus,
    orderType: 'LIMIT',
    price: PRICE,
    quantity: QTY,
    side: 'BUY',
    symbol: SYMBOL,
    totalTradeQuantity: QTY,
    totalQuoteTradeQuantity: QUOTE,
  }) as unknown as ExecutionReport

/** The ladder's counter-buy for the level, as `updateMinigrid` hands it over. */
const counterBuy: Grid = {
  number: 1,
  price: +PRICE,
  qty: +QTY,
  side: OrderSideEnum.buy,
  type: TypeOrderEnum.dealGrid,
  newClientOrderId: 'CMB-GR-00000000115',
  dealId: DEAL_ID,
  minigridId: MINIGRID_ID,
}

const loadModule = createRequire(__filename)
let Helper: new (...args: unknown[]) => unknown

const buildBot = () => {
  const logs: string[] = []
  const bot: any = Object.create((Helper as any).prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.data = { exchange: ExchangeEnum.kraken, exchangeUUID: '', settings: {} }
  bot.math = new MathHelper()
  // The REAL order map and its indexes — `isOrderExistInDeal` reads these.
  bot.orders = new Map<string, Order>()
  bot.ordersKeys = new Set<string>()
  bot.orderStatusMap = new Map()
  bot.orderDealMap = new Map()
  bot.orderStatuses = ['NEW', 'PARTIALLY_FILLED']
  bot.ordersInBetweenUpdates = new Set<string>()
  bot.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  bot.setOrdersToRedis = () => undefined
  bot.getExchangeInfo = async () => ({
    baseAsset: { name: 'GNOT', minAmount: 0 },
    quoteAsset: { name: 'USD', minAmount: 0 },
    priceAssetPrecision: 5,
    baseAssetPrecision: 5,
  })
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.logs = logs
  bot.handleLog = (l: string) => logs.push(l)
  bot.handleDebug = (l: string) => logs.push(l)
  bot.handleWarn = (l: string) => logs.push(l)
  bot.handleErrors = () => undefined
  bot.setOrder(restingGridBuy(), false)
  return bot
}

/** `processOrderQueue`'s write-back: drop on `null`, else replace the row. */
const deliver = async (bot: any, msg: ExecutionReport) => {
  const converted = (await bot.convertExecutionReportToOrder(
    msg,
    true,
  )) as Order | null
  if (converted) {
    bot.deleteOrder(converted.clientOrderId, false)
    bot.setOrder(converted, false)
  }
  return converted
}

describe('a part-fill report delivered after the fill (spec 114)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('./dcaHelper').default()
  })

  it('§1.2 keeps the filled grid order FILLED', async () => {
    const bot = buildBot()
    await deliver(bot, report('FILLED'))
    await deliver(bot, report('PARTIALLY_FILLED'))
    expect(bot.getOrderFromMap(CLIENT_ORDER_ID).status).to.equal('FILLED')
  })

  it('§1.2 leaves no live order at the level, so its counter can be placed', async () => {
    const bot = buildBot()
    await deliver(bot, report('FILLED'))
    await deliver(bot, report('PARTIALLY_FILLED'))
    expect(
      bot.isOrderExistInDeal(counterBuy, TypeOrderEnum.dealGrid, DEAL_ID),
      'a ghost order at the level blocks the counter-buy',
    ).to.equal(false)
  })

  it('§4.2 is dropped, and says so where it can be read in production', async () => {
    const bot = buildBot()
    await deliver(bot, report('FILLED'))
    bot.logs.length = 0
    const dropped = await deliver(bot, report('PARTIALLY_FILLED'))
    expect(dropped, 'the report is not processed').to.equal(null)
    expect(bot.logs.join('\n')).to.match(/FILLED row/)
  })

  it('§4.1 still applies the ordinary PARTIALLY_FILLED → FILLED sequence', async () => {
    const bot = buildBot()
    const part = await deliver(bot, report('PARTIALLY_FILLED'))
    expect(part, 'a part fill of a resting order is processed').to.not.equal(
      null,
    )
    const fill = await deliver(bot, report('FILLED'))
    expect(fill, 'the fill is processed').to.not.equal(null)
    expect(bot.getOrderFromMap(CLIENT_ORDER_ID).status).to.equal('FILLED')
  })

  it('§4.1 still blocks a duplicate while the order really rests', async () => {
    const bot = buildBot()
    expect(
      bot.isOrderExistInDeal(counterBuy, TypeOrderEnum.dealGrid, DEAL_ID),
    ).to.equal(true)
  })
})
