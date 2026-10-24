process.env.NODE_ENV = 'testing'

/**
 * A hedge-mode futures account runs a long bot and a short bot on one symbol.
 * The venue liquidates both positions in the same millisecond. Binance sends
 * two `ORDER_TRADE_UPDATE` FILLED reports — a SELL closing the long and a BUY
 * closing the short — and every liquidation on the account carries ONE shared
 * client order id (`autoclose-<n>`); only the venue order id tells them apart.
 *
 * Both reports reach both bots. The SELL was processed; the BUY never was, so
 * the short bot kept an open deal on a position that no longer existed.
 *
 * Spec: `specs/197.a-second-same-millisecond-liquidation-is-dropped.md`.
 * Run: `npm test` (mocha). No network / DB — the real `accountCallback` and
 * `processOrderQueue` run off the prototype, with the real DCA `sortQueue`.
 * Identifiers are synthetic (this file is public).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import { ExchangeEnum } from '../../types'

const Helper: any = createDCABotHelper(MainBot as any)

const SYMBOL = 'MAGMAUSDT'
const SHARED_CLIENT_ID = 'autoclose-1000000000000000001'
const AT = 1792769471342

/** The Binance USD-M mapping of an ORDER_TRADE_UPDATE (websocket-connector). */
function liquidationReport(
  side: 'BUY' | 'SELL',
  qty: string,
  price: string,
  averagePrice: string,
  orderId: number,
) {
  return {
    eventType: 'ORDER_TRADE_UPDATE',
    eventTime: AT + 1,
    transactionTime: AT,
    symbol: SYMBOL,
    clientOrderId: SHARED_CLIENT_ID,
    side,
    orderType: 'LIMIT',
    quantity: qty,
    price,
    averagePrice,
    orderStatus: 'FILLED',
    executionType: 'TRADE',
    orderId,
    totalTradeQuantity: qty,
    orderTime: AT,
    positionSide: side === 'SELL' ? 'LONG' : 'SHORT',
    liquidation: true,
  } as any
}

function hedgeBot(isLong: boolean) {
  const rec = { liquidations: [] as any[], logs: [] as string[] }
  const bot: any = Object.create((MainBot as any).prototype)
  bot.botId = isLong ? 'long-bot' : 'short-bot'
  bot.userId = 'user'
  bot.botType = 'combo'
  bot.data = {
    exchange: ExchangeEnum.binanceUsdm,
    exchangeUUID: '',
    paperContext: false,
    settings: { futures: true, pair: [SYMBOL], leverage: 1 },
    flags: [],
  }
  bot.orders = new Map()
  bot.ordersKeys = new Set()
  bot.orderQueue = []
  bot.processedOrders = new Map()
  bot.lockProcessQueueMethod = false
  bot.math = { round: (v: number, p = 8) => +(+v).toFixed(p) }
  bot.handleLog = (m: string) => rec.logs.push(m)
  bot.handleDebug = () => undefined
  bot.handleWarn = (m: string) => rec.logs.push(m)
  bot.getExchangeInfo = async () => {
    // the real one awaits a cache: let the second report land meanwhile
    await new Promise((r) => setTimeout(r, 5))
    return {
      pair: SYMBOL,
      priceAssetPrecision: 5,
      baseAsset: { minAmount: 1, step: 1, name: 'MAGMA' },
      quoteAsset: { minAmount: 5, name: 'USDT', precision: 8 },
    }
  }
  bot.saveOrderToDb = async () => undefined
  const sort = Helper.prototype.sortQueue.bind({ isLong })
  bot.cbFunctions = {
    sort,
    onFilled: async () => undefined,
    onPartiallyFilled: async () => undefined,
    onCanceled: async () => undefined,
    onNew: async () => undefined,
    onLiquidation: async (o: any) => {
      rec.liquidations.push({ ...o })
    },
  }
  return { bot, rec }
}

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms))

async function deliver(bot: any, reports: any[]) {
  // the stream delivers them ~2 ms apart: the second arrives while the first
  // is still being processed
  for (const r of reports) {
    void bot.accountCallback(r)
    await tick(2)
  }
  for (let i = 0; i < 200 && bot.orderQueue.length; i++) {
    await tick(2)
  }
  await tick(5)
  expect(bot.orderQueue.length, 'queue drained').to.equal(0)
}

describe('hedge pair liquidated in one millisecond (spec 197)', () => {
  for (const isLong of [true, false]) {
    it(`§3.1 the ${isLong ? 'long' : 'short'} bot is handed BOTH liquidation fills`, async () => {
      const { bot, rec } = hedgeBot(isLong)
      // a long's liquidation is booked at a price below the short's
      await deliver(bot, [
        liquidationReport('SELL', '59', '0.40000', '0.41086', 1000000001),
        liquidationReport('BUY', '15', '0.42500', '0.41090', 1000000002),
      ])
      expect(
        rec.liquidations.map((o) => `${o.side} ${o.orderId}`).sort(),
      ).to.deep.equal(['BUY 1000000002', 'SELL 1000000001'])
    })
  }

  it('§3.2 two same-size liquidations on one symbol are not merged', async () => {
    const { bot, rec } = hedgeBot(false)
    await deliver(bot, [
      liquidationReport('SELL', '15', '0.40000', '0.41086', 1000000001),
      liquidationReport('BUY', '15', '0.40000', '0.41086', 1000000002),
    ])
    expect(rec.liquidations.map((o) => o.side).sort()).to.deep.equal([
      'BUY',
      'SELL',
    ])
  })

  it('§3.3 a re-delivered liquidation report is still processed once', async () => {
    const { bot, rec } = hedgeBot(false)
    const r = liquidationReport('BUY', '15', '0.42500', '0.41090', 1000000002)
    await deliver(bot, [r, { ...r }])
    expect(rec.liquidations.length).to.equal(1)
  })

  for (const [side, closes] of [
    ['BUY', true],
    ['SELL', false],
  ] as const) {
    it(`§3.4 the short bot ${closes ? 'closes its deals and says so' : 'says nothing'} on a ${side} liquidation`, async () => {
      const closed: string[] = []
      const said: string[] = []
      const bot: any = Object.create(Helper.prototype)
      bot.data = {
        exchange: ExchangeEnum.binanceUsdm,
        settings: { futures: true, pair: [SYMBOL] },
      }
      bot.isLong = false
      bot.getOpenDeals = () => [{ deal: { _id: 'deal', symbol: SYMBOL } }]
      bot.closeAllDeals = async () => {
        closed.push('deal')
      }
      bot.linkLiquidationOrderToDeals = async () => undefined
      bot.handleLog = () => undefined
      bot.handleErrors = (m: string) => said.push(m)
      await bot.processLiquidationOrder({
        symbol: SYMBOL,
        side,
        price: '0.41090',
        updateTime: AT,
        clientOrderId: SHARED_CLIENT_ID,
        orderId: '1000000002',
      })
      expect(closed.length, 'deals closed').to.equal(closes ? 1 : 0)
      expect(
        said.some((m) => m.includes('closed due to position liquidation')),
        'liquidation message',
      ).to.equal(closes)
    })
  }
})
