process.env.NODE_ENV = 'testing'

/**
 * Cancelling an order that never reached the venue must not ask the venue.
 *
 * On the three venues addressed by EXCHANGE order id — coinbase, kraken spot
 * and KuCoin full futures — an order still carrying the `'-1'` placeholder has
 * no venue-side identifier, and `cancelOrderOnExchange` sent that literal `'-1'`
 * as the order id. Both siblings that build the same identifier already check
 * for it (`venueOrderId()`, and the unknown-order ladder), so the cancel was the
 * last path spending a rate-limited private call to learn what the local row
 * already says — and error-stating the bot whenever that useless call happened
 * to time out.
 *
 * Spec: `specs/011.cancel-an-order-that-never-reached-the-venue.md`. Issue #671.
 * Run: `npm test` (mocha).
 *
 * No network / DB needed — the real method is driven off the prototype against
 * a recording transport.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

/** The placeholder `sendOrderToExchange` leaves on an order with no venue id. */
const NO_EXCHANGE_ORDER_ID = '-1'

/** The reported Kraken row (issue #671), verbatim. */
function order(over: Record<string, unknown> = {}) {
  return {
    symbol: 'BTC-USDT',
    orderId: NO_EXCHANGE_ORDER_ID,
    clientOrderId: 'GRID-RO-LSPRHVhH667Jmh1Tn6rDZqwoE8o',
    price: '1.3',
    origQty: '384.65384615',
    executedQty: '0',
    status: 'NEW',
    side: 'BUY',
    updateTime: -1,
    transactTime: -1,
    ...over,
  } as any
}

type Recorded = {
  cancel: { newClientOrderId?: string }[]
  getOrder: unknown[]
  unknown: string[]
  errors: string[]
}

/**
 * @param cancelReason what the venue answers if it IS asked. Defaults to the
 * Kraken connector's real wording for a `cl_ord_id` it cannot resolve.
 * @param realLadder drive `_handleUnknownOrder` for real instead of recording it.
 */
function botOn(
  exchange: ExchangeEnum,
  opts: { cancelReason?: string; realLadder?: boolean } = {},
) {
  const rec: Recorded = { cancel: [], getOrder: [], unknown: [], errors: [] }
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = { exchange, exchangeUUID: '', paperContext: false }
  bot.orders = new Map()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async cancelOrder(req: { newClientOrderId?: string }) {
      rec.cancel.push(req)
      return {
        status: StatusEnum.notok,
        reason: opts.cancelReason ?? 'Order not found in open orders',
        data: null,
      }
    },
    async getOrder(req: unknown) {
      rec.getOrder.push(req)
      return {
        status: StatusEnum.notok,
        reason: 'Order not found in open orders',
        data: null,
      }
    },
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = (reason: string) => rec.errors.push(reason)
  bot.emit = () => undefined
  bot.setOrder = () => undefined
  bot.deleteOrder = () => undefined
  bot.updateOrderOnDb = () => undefined
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  if (!opts.realLadder) {
    bot._handleUnknownOrder = async (id: string) => {
      rec.unknown.push(id)
      return null
    }
  }
  return { bot, rec }
}

/** The venues that address an order by its exchange id. */
const BY_EXCHANGE_ID = [
  ExchangeEnum.kraken,
  ExchangeEnum.coinbase,
  ExchangeEnum.kucoinLinear,
  ExchangeEnum.kucoinInverse,
]

/** Everything else, including Kraken FUTURES and KuCoin SPOT. */
const BY_CLIENT_ID = [
  ExchangeEnum.binance,
  ExchangeEnum.bybit,
  ExchangeEnum.okx,
  ExchangeEnum.kucoin,
  ExchangeEnum.krakenUsdm,
  ExchangeEnum.krakenCoinm,
]

describe('cancelOrderOnExchange with no exchange order id (spec 011)', () => {
  it('§4.1 asks the venue nothing when the order never reached it', async () => {
    for (const ex of BY_EXCHANGE_ID) {
      const { bot, rec } = botOn(ex)
      const o = order()
      bot.orders.set(o.clientOrderId, o)
      await bot.cancelOrderOnExchange(o)
      expect(
        rec.cancel.map((c) => c.newClientOrderId),
        `${ex} sent an id to the venue`,
      ).to.deep.equal([])
    }
  })

  it('§4.2 still hands the order to the unknown-order path', async () => {
    for (const ex of BY_EXCHANGE_ID) {
      const { bot, rec } = botOn(ex)
      const o = order()
      bot.orders.set(o.clientOrderId, o)
      await bot.cancelOrderOnExchange(o)
      expect(rec.unknown, ex).to.deep.equal([
        'GRID-RO-LSPRHVhH667Jmh1Tn6rDZqwoE8o',
      ])
    }
  })

  it('§4.2 still retires the order through the real ladder, with no venue call', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, { realLadder: true })
    const o = order()
    bot.orders.set(o.clientOrderId, o)
    const res = await bot.cancelOrderOnExchange(o)
    expect(res?.status, 'order not retired').to.equal('CANCELED')
    // The wasted cancel was the only venue call the whole retirement made —
    // the ladder's own `-1` guard already keeps it from asking (`main.ts:4753`).
    expect(
      rec.cancel.length + rec.getOrder.length,
      'venue round trips',
    ).to.equal(0)
  })

  it('§4.3 cannot raise a bot error when the venue would have timed out', async () => {
    // Before the guard this call was made, `Response timeout` matched nothing in
    // `unknownOrderMessages`, and the bot was error-stated over an order that
    // provably never existed at the venue — which also left the row NEW.
    for (const ex of BY_EXCHANGE_ID) {
      const { bot, rec } = botOn(ex, { cancelReason: 'Response timeout' })
      const o = order()
      bot.orders.set(o.clientOrderId, o)
      await bot.cancelOrderOnExchange(o)
      expect(rec.errors, `${ex} raised a bot error`).to.deep.equal([])
      expect(rec.unknown, `${ex} did not retire the order`).to.have.length(1)
    }
  })

  it('§4.6 answers with the wording the other two paths already produce', async () => {
    // `getOrder` (:4540) and `_runUnknownOrderLadder` (:4753) both emit this
    // exact message; it is matched by the existing `Order not found` entry of
    // `unknownOrderMessages`, which is what keeps the routing unchanged.
    const { bot } = botOn(ExchangeEnum.kraken)
    const logged: string[] = []
    bot.handleLog = (m: string) => logged.push(m)
    const o = order()
    bot.orders.set(o.clientOrderId, o)
    await bot.cancelOrderOnExchange(o)
    expect(logged).to.include(
      'Send cancel request GRID-RO-LSPRHVhH667Jmh1Tn6rDZqwoE8o. Order not found',
    )
  })
})

describe('cancelOrderOnExchange is otherwise untouched (spec 011 §4.4, §4.5)', () => {
  it('§4.4 keeps sending the client order id on every other venue', async () => {
    for (const ex of BY_CLIENT_ID) {
      const { bot, rec } = botOn(ex)
      const o = order()
      bot.orders.set(o.clientOrderId, o)
      await bot.cancelOrderOnExchange(o)
      expect(
        rec.cancel.map((c) => c.newClientOrderId),
        ex,
      ).to.deep.equal(['GRID-RO-LSPRHVhH667Jmh1Tn6rDZqwoE8o'])
    }
  })

  it('§4.5 still cancels a by-id order that holds a real exchange id', async () => {
    for (const ex of BY_EXCHANGE_ID) {
      const { bot, rec } = botOn(ex)
      const o = order({ orderId: 'ONK6O3-BF63X-24VAON' })
      bot.orders.set(o.clientOrderId, o)
      await bot.cancelOrderOnExchange(o)
      expect(
        rec.cancel.map((c) => c.newClientOrderId),
        ex,
      ).to.deep.equal(['ONK6O3-BF63X-24VAON'])
    }
  })
})
