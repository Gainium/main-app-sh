process.env.NODE_ENV = 'testing'

/**
 * Spec `279` through the REAL engine methods on the DCA helper prototype:
 * `processLiquidationOrder` (the settle that waits for the venue),
 * `bookPartialLiquidation`, `processFilledOrder`'s reduce-funds routing and
 * `sweepPartialLiquidations`. The venue, the DB and the deal booking itself
 * (`updateDeal`, covered by its own specs) are stubbed and recorded.
 *
 * Fixture: a Kraken Futures one-way long, one open deal holding 302, the venue
 * liquidating 120 in ten chunks and stopping at 182. Identifiers are synthetic
 * (this file is public).
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from '../main'
import createDCABotHelper from '../dcaHelper'
import {
  BotStatusEnum,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const Helper: any = createDCABotHelper(MainBot as any)

const SYMBOL = 'ONDO-USD'
const BOT_ID = 'bot-279'
const DEAL_ID = '0000000000000000000d0279'
const OPENED = 1_794_416_370_000
const LIQ_AT = 1_794_640_777_000

const chunkFills = () =>
  Array.from({ length: 10 }, (_, i) => ({
    fillId: `fill-${i}`,
    orderId: `liq-order-${i}`,
    clientOrderId: '',
    symbol: SYMBOL,
    side: 'SELL',
    price: `${0.3262 - i * 0.0001}`,
    quantity: '12',
    timestamp: LIQ_AT + i * 10_000,
    fillType: 'partialLiquidation',
  }))

function makeBot(opts: {
  exchange?: ExchangeEnum
  held?: number
  booked?: { clientOrderId: string; orderId: string }[]
  fills?: any[] | null
}) {
  const rec = {
    saved: [] as any[],
    routed: [] as any[],
    said: [] as string[],
    closed: [] as string[],
    closedAll: 0,
    settles: [] as any[],
    logs: [] as string[],
  }
  const bot: any = Object.create(Helper.prototype)
  bot.botId = BOT_ID
  bot.userId = 'user-279'
  bot.data = {
    exchange: opts.exchange ?? ExchangeEnum.krakenUsdm,
    exchangeUUID: 'uuid',
    status: BotStatusEnum.open,
    settings: { futures: true, coinm: false, pair: [SYMBOL] },
    flags: [],
  }
  Object.defineProperty(bot, 'isLong', { value: true })
  bot.hedge = false
  bot.orders = new Map()
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: 'open',
      createTime: OPENED,
      symbol: { symbol: SYMBOL },
      initialBalances: { base: 0, quote: 95.58 },
      currentBalances: { base: 302, quote: 7 },
      tpHistory: [],
    },
  }
  bot.theDeal = deal
  bot.getOpenDeals = () =>
    deal.deal.status === 'open' ? [deal] : []
  bot.getDeal = (id: string) => (id === DEAL_ID ? deal : undefined)
  bot.venueHoldsPosition = async () => opts.held
  bot.exchange = {
    getAccountFills: async (before?: number) =>
      opts.fills === null
        ? { status: StatusEnum.notok, reason: 'down' }
        : {
            status: StatusEnum.ok,
            data: before ? [] : (opts.fills ?? chunkFills()),
          },
  }
  bot.ordersDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: opts.booked ?? [] },
    }),
  }
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    baseAsset: { name: 'ONDO', step: 1, minAmount: 1 },
    quoteAsset: { name: 'USD', minAmount: 5 },
  })
  bot.saveOrderToDb = async (o: any) => rec.saved.push({ ...o })
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.processFilledOrder = async (o: any) => rec.routed.push(o)
  bot.settleExternallyClosedDeal = async (id: string) => rec.closed.push(id)
  bot.closeAllDeals = async () => {
    rec.closedAll++
  }
  bot.linkLiquidationOrderToDeals = async () => undefined
  bot.venueCloseEvidenceFor = async () => undefined
  bot.handleErrors = (m: string) => rec.said.push(m)
  bot.handleLog = (m: string) => rec.logs.push(m)
  bot.handleDebug = () => undefined
  bot.handleWarn = (m: string) => rec.logs.push(m)
  bot.loadingComplete = true
  bot.shouldProceed = () => true
  return { bot, rec, deal }
}

/** One stream chunk as `MainBot.processOrderQueue` hands it over. */
const streamChunk = (i: number) => ({
  symbol: SYMBOL,
  side: 'SELL',
  price: `${0.3262 - i * 0.0001}`,
  updateTime: LIQ_AT + i * 10_000,
  clientOrderId: `liq-order-${i}`,
  orderId: `liq-order-${i}`,
  executedQty: '0',
  typeOrder: TypeOrderEnum.liquidation,
  liquidation: true,
})

/** Deliver every chunk, then let the settle re-check until it gives up. */
async function liquidate(bot: any, chunks = 10) {
  let last: any
  for (let i = 0; i < chunks; i++) {
    last = streamChunk(i)
    await bot.processLiquidationOrder(last, last.updateTime, 12)
  }
  // Each re-check is the settle timer calling back with the same order.
  for (let i = 0; i < 8; i++) {
    await bot.processLiquidationOrder(last)
  }
  bot.clearLiquidationSettle(SYMBOL)
}

describe('Kraken Futures partial liquidation booked on the deal (spec 279)', () => {
  it('§1.1 the venue stops at 182: one FILLED reduce row of 120 at the chunks’ price, routed as a reduce-funds fill, deal kept open, user told', async () => {
    const { bot, rec } = makeBot({ held: 182 })
    await liquidate(bot)
    expect(rec.closedAll, 'no closeAllDeals').to.equal(0)
    expect(rec.saved).to.have.length(1)
    const row = rec.saved[0]
    expect(row.clientOrderId.startsWith('LIQ-')).to.equal(true)
    expect(row.reduceFundsId).to.equal(row.clientOrderId)
    expect(row.typeOrder).to.equal(TypeOrderEnum.dealTP)
    expect(row.status).to.equal('FILLED')
    expect(row.side).to.equal('SELL')
    expect(row.dealId).to.equal(DEAL_ID)
    expect(+row.executedQty).to.equal(120)
    expect(+row.price).to.be.closeTo(0.32575, 1e-9)
    expect(row.orderId.split(',')).to.have.length(10)
    // persisted before it is booked, and in the order map
    expect(rec.routed.map((o) => o.clientOrderId)).to.deep.equal([
      row.clientOrderId,
    ])
    expect(bot.orders.has(row.clientOrderId)).to.equal(true)
    expect(rec.said.some((m) => m.includes('was liquidated'))).to.equal(true)
    expect(rec.said.some((m) => m.includes('still open'))).to.equal(true)
  })

  it('§1.2 the venue fills cannot be read: the stream chunks are booked instead', async () => {
    const { bot, rec } = makeBot({ held: 182, fills: null })
    await liquidate(bot)
    expect(rec.saved).to.have.length(1)
    expect(+rec.saved[0].executedQty).to.equal(120)
  })

  it('§1.3 a second report of the same chunks books nothing (rows already carry them)', async () => {
    const first = makeBot({ held: 182 })
    await liquidate(first.bot)
    const row = first.rec.saved[0]
    const { bot, rec } = makeBot({
      held: 182,
      booked: [{ clientOrderId: row.clientOrderId, orderId: row.orderId }],
    })
    // the deal now holds what the venue holds
    bot.theDeal.deal.currentBalances.base = 182
    await liquidate(bot)
    expect(rec.saved).to.have.length(0)
    expect(rec.routed).to.have.length(0)
  })

  it('§1.4 a booked row is not booked again even while the books still exceed the venue', async () => {
    const first = makeBot({ held: 182 })
    await liquidate(first.bot)
    const row = first.rec.saved[0]
    const { bot, rec } = makeBot({
      held: 142,
      booked: [{ clientOrderId: row.clientOrderId, orderId: row.orderId }],
    })
    // 40 of drift that is not a liquidation
    bot.theDeal.deal.currentBalances.base = 182
    await bot.sweepPartialLiquidations()
    expect(rec.saved).to.have.length(0)
  })

  it('§1.5 Binance USD-M: the settle keeps the old behaviour (message, no booking)', async () => {
    const { bot, rec } = makeBot({ held: 182, exchange: ExchangeEnum.binanceUsdm })
    await liquidate(bot)
    expect(rec.saved).to.have.length(0)
    expect(rec.said.some((m) => m.includes('stays open on what is left'))).to.equal(true)
  })

  it('§1.6 the venue answers flat: the deal is closed as before (spec 040), nothing booked as a reduction', async () => {
    const { bot, rec } = makeBot({ held: undefined })
    await bot.processLiquidationOrder(streamChunk(0), LIQ_AT, 12)
    expect(rec.closedAll).to.equal(1)
    expect(rec.saved).to.have.length(0)
  })

  it('§1.7 a partial TP carried in tpHistory counts as already sold (DCA)', async () => {
    const { bot, rec } = makeBot({ held: 182 })
    bot.theDeal.deal.tpHistory = [{ id: 'tp', qty: 30, price: 0.4 }]
    await liquidate(bot)
    // books 302 − 30 = 272 → cap 90
    expect(+rec.saved[0].executedQty).to.equal(90)
  })

  it('§3 the sweep books a liquidation the stream never delivered, and skips a symbol the stream is settling', async () => {
    const { bot, rec } = makeBot({ held: 182 })
    bot.liquidationSettleMap().set(SYMBOL, { order: streamChunk(0), checks: 1 })
    await bot.sweepPartialLiquidations()
    expect(rec.saved).to.have.length(0)
    bot.liquidationSettleMap().delete(SYMBOL)
    await bot.sweepPartialLiquidations()
    expect(rec.saved).to.have.length(1)
    expect(+rec.saved[0].executedQty).to.equal(120)
  })

  it('§3 the sweep reads no fills when the books do not exceed the venue', async () => {
    const { bot, rec } = makeBot({ held: 302 })
    let reads = 0
    bot.exchange.getAccountFills = async () => {
      reads++
      return { status: StatusEnum.ok, data: [] }
    }
    await bot.sweepPartialLiquidations()
    expect(reads).to.equal(0)
    expect(rec.saved).to.have.length(0)
  })

  it('§3 the sweep is armed with the heartbeat on Kraken only, and stopped with it', () => {
    const { bot } = makeBot({ held: 182 })
    bot.heartbeatConsumer = () => undefined
    bot.startConsumerHeartbeat()
    expect(bot.liquidationSweepTimers).to.have.length(2)
    bot.stopConsumerHeartbeat()
    expect(bot.liquidationSweepTimers).to.equal(undefined)
    const other = makeBot({ exchange: ExchangeEnum.bybitUsdm }).bot
    other.heartbeatConsumer = () => undefined
    other.startConsumerHeartbeat()
    expect(other.liquidationSweepTimers).to.equal(undefined)
    other.stopConsumerHeartbeat()
  })

  it('§1.8 the row reaches the DCA reduce-funds branch of the real processFilledOrder', async () => {
    const { bot, rec } = makeBot({ held: 182 })
    const updates: any[] = []
    bot.processFilledOrder = Helper.prototype.processFilledOrder
    bot.processedFilled = new Map()
    bot.latestDealFillTime = new Map()
    bot.bookRemainderSweepReport = async () => false
    bot.updateDeal = async (_b: string, o: any) => updates.push(o)
    bot.onSplitSliceFilled = () => undefined
    bot.closeDeal = () => {
      throw new Error('a liquidation reduce must never close through closeDeal')
    }
    await liquidate(bot)
    expect(updates.map((o) => o.clientOrderId)).to.deep.equal([
      rec.saved[0].clientOrderId,
    ])
  })
})
