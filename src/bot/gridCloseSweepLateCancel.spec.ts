process.env.NODE_ENV = 'testing'

/**
 * A grid close sweep must not forget a cancel the venue confirms late.
 *
 * Spec: `specs/231.grid-close-sweep-forgets-a-cancel-the-venue-confirms-late.md`.
 *
 * The shape is a production stop-loss "stop and sell" on a Hyperliquid perp
 * grid. The sweep cancels resting reduce-only sells one by one. The cancel
 * answer is a read-back of the order, and for some orders it still said the
 * order rested (`NEW`) although the venue had accepted the cancel. The engine
 * dropped those orders from local tracking, so the venue's own `canceled`
 * report, a moment later, was discarded by `accountCallback` and the rows
 * stayed `NEW` on a closed bot.
 *
 * Drives the REAL grid `cancelAllOrder` (helper mixin) over the REAL
 * `MainBot` `cancelOrderOnExchange`, `setOrder`/`deleteOrder` and
 * `accountCallback`; transport, Redis and DB are stubbed.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotStatusEnum,
  BotType,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

const SYMBOL = 'ABC-USDC'
const ids = ['a', 'b', 'c'].map((s) => `0x${s.repeat(32)}`)

let Helper: any

const sell = (clientOrderId: string, i: number) => ({
  symbol: SYMBOL,
  orderId: `23100000000${i}`,
  clientOrderId,
  typeOrder: TypeOrderEnum.regular,
  price: `${380 + i}`,
  origPrice: `${380 + i}`,
  origQty: '0.031',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  status: 'NEW',
  side: 'SELL',
  type: 'LIMIT',
  reduceOnly: true,
  updateTime: 1793800000000 + i,
  transactTime: 1793800000000 + i,
  exchange: ExchangeEnum.hyperliquidLinear,
})

/** The venue's user-stream report that the order is cancelled. */
const streamCanceled = (clientOrderId: string) =>
  ({
    eventType: 'executionReport',
    eventTime: 1793889124418,
    symbol: SYMBOL,
    newClientOrderId: clientOrderId,
    originalClientOrderId: clientOrderId,
    orderStatus: 'CANCELED',
    totalTradeQuantity: '0',
    totalQuoteTradeQuantity: '0',
    price: '381',
    orderId: 1,
    side: 'SELL',
  }) as any

/**
 * @param answers per client id, the statuses the venue's cancel calls answer
 *   in turn: `NEW` = accepted but the read-back still shows it resting,
 *   `gone` = refused "already cancelled".
 */
const buildBot = (answers: Record<string, string[]>) => {
  const cancelCalls: string[] = []
  const unknownLookups: string[] = []
  const routed: string[] = []
  const saved: any[] = []

  class Base {
    math = new MathHelper()
    constructor(..._a: any[]) {}
  }
  Object.setPrototypeOf(Base.prototype, (MainBot as any).prototype)
  const Grid = Helper(Base as any)

  class TestBot extends Grid {
    math = new MathHelper()
    botId = '00000000000000000000d231'
    userId = 'test-user'
    botType = BotType.grid
    firstRun = true
    blockLimit = false
    orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    orders = new Map<string, any>()
    ordersKeys = new Set<string>()
    orderStatusMap = new Map()
    orderDealMap = new Map()
    canceledMap = new Map()
    unknownOrderInFlight = new Map()
    orderQueue: any[] = []
    cbFunctions = { sort: () => 0 }
    sharedStream = { addOrder() {}, removeOrder() {} }
    data: any = {
      _id: '00000000000000000000d231',
      status: BotStatusEnum.open,
      exchange: ExchangeEnum.hyperliquidLinear,
      exchangeUUID: '',
      paperContext: false,
      settings: { pair: SYMBOL, futures: true },
    }
    exchange = {
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
      cancelOrder: async ({ newClientOrderId }: any) => {
        cancelCalls.push(newClientOrderId)
        const next = (answers[newClientOrderId] ?? ['CANCELED']).shift()
        if (next === 'gone') {
          return {
            status: StatusEnum.notok,
            reason: 'Order was never placed, already canceled, or filled.',
            data: null,
          }
        }
        const o = this.orders.get(newClientOrderId) ?? {}
        return {
          status: StatusEnum.ok,
          reason: '',
          data: { ...o, status: next, executedQty: '0' },
        }
      },
    }
    // --- I/O, stubbed ---
    setOrdersToRedis() {}
    async getLatestPrice() {
      return 381
    }
    async countBalances() {}
    async primeCancelBatch() {}
    clearCancelBatch() {}
    sendEndProcess() {}
    updateProgress() {}
    updateOrderOnDb(o: any) {
      saved.push({ ...o })
    }
    async convertOrderExecutedQty(o: any) {
      return o.executedQty
    }
    async _handleUnknownOrder(id: string) {
      unknownLookups.push(id)
      return null
    }
    processOrderQueue() {
      for (const m of this.orderQueue) routed.push(m.newClientOrderId)
      this.orderQueue = []
    }
    emit() {}
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
  ids.forEach((id, i) => bot.setOrder(sell(id, i), false))
  return { bot, cancelCalls, unknownLookups, routed, saved }
}

describe('a grid close sweep keeps a cancel the venue confirms late (spec 231)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default
  })

  it('§4.1 a cancel answered NEW keeps the order tracked; the venue report reaches the queue', async () => {
    const { bot, routed } = buildBot({ [ids[1]]: ['NEW', 'NEW'] })
    bot.blockLimit = true
    await bot.cancelAllOrder(true, true, true)
    expect(bot.orders.has(ids[1]), 'still tracked').to.equal(true)
    expect(bot.ordersKeys.has(ids[1])).to.equal(true)
    // The venue's own confirmation arrives after the answer.
    await bot.accountCallback(streamCanceled(ids[1]))
    expect(routed, 'routed to processOrderQueue').to.deep.equal([ids[1]])
  })

  it('§4.2 an order still unconfirmed at the end of the sweep is cancelled once more, and the venue is asked', async () => {
    const { bot, cancelCalls, unknownLookups } = buildBot({
      [ids[1]]: ['NEW', 'gone'],
    })
    await bot.cancelAllOrder(true, true, true)
    expect(cancelCalls).to.deep.equal([ids[0], ids[1], ids[2], ids[1]])
    expect(unknownLookups).to.deep.equal([ids[1]])
  })

  it('§4.2 an order the stream confirmed meanwhile is not cancelled again', async () => {
    const { bot, cancelCalls } = buildBot({ [ids[0]]: ['NEW'] })
    const orig = bot.exchange.cancelOrder
    bot.exchange.cancelOrder = async (a: any) => {
      const r = await orig(a)
      // processOrderQueue finishing ids[0] while ids[1] is being cancelled.
      if (a.newClientOrderId === ids[1]) bot.deleteOrder(ids[0], false)
      return r
    }
    await bot.cancelAllOrder(true, true, true)
    expect(cancelCalls).to.deep.equal(ids)
  })

  it('§4.3 outside a close sweep (start/reload) an answer of NEW still drops the order as before', async () => {
    const { bot, cancelCalls } = buildBot({ [ids[1]]: ['NEW'] })
    await bot.cancelAllOrder()
    expect(bot.orders.has(ids[1])).to.equal(false)
    expect(cancelCalls).to.deep.equal(ids)
  })

  it('§4.4 terminal answers inside a close sweep are deleted and written as before', async () => {
    const { bot, saved, cancelCalls } = buildBot({})
    await bot.cancelAllOrder(true, true, true)
    expect(bot.orders.size).to.equal(0)
    expect(cancelCalls).to.deep.equal(ids)
    expect(saved.map((o) => o.status)).to.deep.equal([
      'CANCELED',
      'CANCELED',
      'CANCELED',
    ])
  })
})
