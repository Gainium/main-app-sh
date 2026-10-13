process.env.NODE_ENV = 'testing'

/**
 * A Coinbase order whose row still carries the `'-1'` placeholder is not proof
 * that the venue does not have it. A worker restart between "Coinbase accepted
 * the take-profit" and "we processed the answer" leaves exactly that row while
 * the order rests on the venue. The cancel / unknown-order path then wrote it
 * off without asking, the live order kept the base asset locked, and every
 * replacement take-profit was refused for balance — the deal could not close.
 *
 * Spec: `specs/154.never-placed-placeholder-hides-a-live-coinbase-order.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB — the real methods run off the prototype against a
 * recording fake exchange.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const CLIENT_ID = 'D-TP-xKf45OYSGitUMCaL9CRwoKNblT5Wp6'
const VENUE_ID = 'c7de48e3-e98d-4110-a2f1-0d383000f030'

function tp(over: Record<string, unknown> = {}) {
  return {
    symbol: 'PEPE-USDC',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    price: '0.00000435',
    origQty: '2878885',
    executedQty: '0',
    status: 'NEW',
    side: 'SELL',
    typeOrder: 'dealTP',
    dealId: '6acc68e52fb12580ab4e4771',
    updateTime: 1791798429000,
    transactTime: 1791798429000,
    ...over,
  } as any
}

type Rec = {
  cancel: string[]
  getOrder: string[]
  openOrders: (string | undefined)[]
  db: any[]
  errors: string[]
}

/**
 * @param open what the venue lists as open for the symbol, or a failure reason
 */
function coinbaseBot(
  open: { clientOrderId: string; orderId: string }[] | string,
) {
  const rec: Rec = {
    cancel: [],
    getOrder: [],
    openOrders: [],
    db: [],
    errors: [],
  }
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = {
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    paperContext: false,
  }
  bot.orders = new Map()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  const bad = (reason: string) => ({
    status: StatusEnum.notok,
    reason,
    data: null,
  })
  bot.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => (data: unknown) => ({
      status: StatusEnum.ok,
      reason: null,
      data,
    }),
    async getAllOpenOrders(symbol: string, returnOrders: boolean) {
      rec.openOrders.push(symbol)
      expect(returnOrders, 'must ask for the orders, not the count').to.equal(
        true,
      )
      if (typeof open === 'string') return bad(open)
      return {
        status: StatusEnum.ok,
        reason: null,
        data: open.map((o) => ({ ...o, symbol, status: 'NEW' })),
      }
    },
    async cancelOrder(req: { newClientOrderId: string }) {
      rec.cancel.push(req.newClientOrderId)
      if (req.newClientOrderId === VENUE_ID) {
        return {
          status: StatusEnum.ok,
          reason: null,
          data: { ...tp(), orderId: VENUE_ID, status: 'CANCELED' },
        }
      }
      return bad('Order not found')
    },
    async getOrder(req: { newClientOrderId: string }) {
      rec.getOrder.push(req.newClientOrderId)
      if (req.newClientOrderId === VENUE_ID) {
        return {
          status: StatusEnum.ok,
          reason: null,
          data: { ...tp(), orderId: VENUE_ID, status: 'NEW' },
        }
      }
      return bad('Order not found')
    },
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = (reason: string) => rec.errors.push(reason)
  bot.emit = () => undefined
  bot.noteOwnCancel = () => undefined
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async () => ({ status: StatusEnum.ok }),
  }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  return { bot, rec }
}

describe('never-placed placeholder on Coinbase (spec 154)', () => {
  it('§4.1 adoptExchangeOrderId records the venue id on a -1 row, memory + DB', async () => {
    const { bot, rec } = coinbaseBot([])
    const o = tp()
    bot.orders.set(CLIENT_ID, o)
    const adopted = await bot.adoptExchangeOrderId(o, VENUE_ID)
    expect(adopted).to.equal(true)
    expect(bot.orders.get(CLIENT_ID).orderId).to.equal(VENUE_ID)
    expect(rec.db.map((d) => d.orderId)).to.deep.equal([VENUE_ID])
  })

  it('§4.1 never overwrites a real id, and ignores a placeholder answer', async () => {
    const { bot, rec } = coinbaseBot([])
    const real = tp({ orderId: 'already-real' })
    expect(await bot.adoptExchangeOrderId(real, VENUE_ID)).to.equal(false)
    expect(real.orderId).to.equal('already-real')
    const ph = tp()
    expect(await bot.adoptExchangeOrderId(ph, '-1')).to.equal(false)
    expect(await bot.adoptExchangeOrderId(ph, undefined)).to.equal(false)
    expect(ph.orderId).to.equal('-1')
    expect(rec.db).to.deep.equal([])
  })

  it('§4.2 cancel resolves the live order by client id and cancels it for real', async () => {
    const { bot, rec } = coinbaseBot([
      { clientOrderId: 'D-TP-other', orderId: 'x-other' },
      { clientOrderId: CLIENT_ID, orderId: VENUE_ID },
    ])
    const o = tp()
    bot.orders.set(CLIENT_ID, o)
    const res = await bot.cancelOrderOnExchange(o, true, true, false)
    expect(rec.openOrders).to.deep.equal(['PEPE-USDC'])
    expect(
      rec.cancel,
      'cancel must reach the venue by its real id',
    ).to.deep.equal([VENUE_ID])
    expect(res?.status).to.equal('CANCELED')
    expect(res?.orderId).to.equal(VENUE_ID)
    expect(rec.errors).to.deep.equal([])
  })

  it('§4.3 a failed lookup does not write the live order off', async () => {
    const { bot, rec } = coinbaseBot('Response timeout')
    const o = tp()
    bot.orders.set(CLIENT_ID, o)
    const res = await bot.cancelOrderOnExchange(o, true, true, false)
    expect(res?.status).to.not.equal('CANCELED')
    expect(
      bot.orders.get(CLIENT_ID)?.status,
      'order must stay tracked',
    ).to.equal('NEW')
    expect(rec.db.filter((d) => d.status === 'CANCELED')).to.deep.equal([])
    expect(rec.cancel, 'no cancel addressed to -1').to.deep.equal([])
    expect(rec.errors.length, 'the failure is reported').to.equal(1)
  })

  it('§4.4 not open on the venue: still retired, still no cancel to -1', async () => {
    const { bot, rec } = coinbaseBot([
      { clientOrderId: 'D-TP-other', orderId: 'x-other' },
    ])
    const o = tp()
    bot.orders.set(CLIENT_ID, o)
    const res = await bot.cancelOrderOnExchange(o, true, true, false)
    expect(rec.cancel).to.deep.equal([])
    expect(res?.status).to.equal('CANCELED')
    expect(rec.errors).to.deep.equal([])
  })

  it('§4.5 the unknown-order ladder adopts a live order instead of writing it off', async () => {
    const { bot, rec } = coinbaseBot([
      { clientOrderId: CLIENT_ID, orderId: VENUE_ID },
    ])
    const o = tp()
    bot.orders.set(CLIENT_ID, o)
    const res = await bot._handleUnknownOrder(CLIENT_ID, 'PEPE-USDC')
    expect(res?.status).to.not.equal('CANCELED')
    expect(bot.orders.get(CLIENT_ID)?.status).to.equal('NEW')
    expect(bot.orders.get(CLIENT_ID)?.orderId).to.equal(VENUE_ID)
    expect(rec.getOrder).to.deep.equal([VENUE_ID])
    expect(rec.db.filter((d) => d.status === 'CANCELED')).to.deep.equal([])
  })
})
