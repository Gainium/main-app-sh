process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `250.unknown-order-lookup-never-moves-a-row-backwards`.
 *
 * Replays the prod sequence (spec §2): a Kraken Futures combo grid exit was
 * reported FILLED 37 by the user stream. The deal-close cancel then found it
 * "not found", and the unknown-order lookup asked the venue, whose REST read
 * still answered PARTIALLY_FILLED. The REAL `MainBot._handleUnknownOrder` runs
 * off the prototype against a fake venue.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const GR_ID = 'CMB-GR-Tk4rBDJ9-spec250'

/** The grid exit as the user stream left it: FILLED 37 at 0.9896. */
const streamRow = (): any => ({
  clientOrderId: GR_ID,
  orderId: 'b1c2d3e4-0000-4000-8000-000000000250',
  botId: 'bbbbbbbbbbbbbbbbbbbb0250',
  dealId: '6afcddaf07f36a92808018a9',
  minigridId: '6afcddb007f36a92808018af',
  symbol: 'XRP-USD',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealGrid',
  status: 'FILLED',
  price: '0.9896',
  origQty: '37',
  executedQty: '37',
  cummulativeQuoteQty: '36.6152',
  updateTime: 1794985741001,
})

const venueAnswer = (over: any = {}): any => ({
  ...streamRow(),
  status: 'PARTIALLY_FILLED',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  updateTime: 1794985700000,
  ...over,
})

const lookup = async (answer: any, row: any = {}) => {
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = { exchange: ExchangeEnum.krakenUsdm, paperContext: false }
  bot.orders = new Map([[GR_ID, { ...streamRow(), ...row }]])
  bot.partiallyFilledFilledSet = new Set()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  const db: any[] = []
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    getOrder: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: answer,
    }),
  }
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = () => undefined
  bot.emit = () => undefined
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.convertOrderQuoteQty = async (_s: string, q: any) => q
  bot.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async (_f: any, o: any) => {
      db.push({ ...o })
      return { status: StatusEnum.ok }
    },
  }
  const order = await bot._handleUnknownOrder(GR_ID, 'XRP-USD')
  return { order, db, row: bot.orders.get(GR_ID) }
}

const expectKeptFilled = ({ order, db, row }: any) => {
  expect(row, 'the row stays in the order map').to.not.equal(undefined)
  expect(row.status).to.equal('FILLED')
  expect(row.executedQty).to.equal('37')
  expect(row.cummulativeQuoteQty).to.equal('36.6152')
  expect(order?.status, 'returned as FILLED so the close books it').to.equal(
    'FILLED',
  )
  expect(order.executedQty).to.equal('37')
  for (const w of db) {
    expect(w.status, 'no downgrade written').to.equal('FILLED')
    expect(w.executedQty).to.equal('37')
  }
}

describe('an unknown-order lookup never moves a row backwards (spec 250)', () => {
  it('§4.1 a FILLED row answered PARTIALLY_FILLED with no fill size stays FILLED', async () => {
    expectKeptFilled(await lookup(venueAnswer()))
  })

  it('§4.1 a FILLED row answered PARTIALLY_FILLED with a smaller fill stays FILLED', async () => {
    expectKeptFilled(
      await lookup(
        venueAnswer({ executedQty: '12', cummulativeQuoteQty: '11.8752' }),
      ),
    )
  })

  it('§4.2 a FILLED row answered NEW stays FILLED', async () => {
    expectKeptFilled(await lookup(venueAnswer({ status: 'NEW' })))
  })

  it('§4.2 a FILLED row answered CANCELED stays FILLED', async () => {
    expectKeptFilled(await lookup(venueAnswer({ status: 'CANCELED' })))
  })

  it('§4.3 a part-filled row answered NEW with less executed keeps its fill', async () => {
    const { order, db, row } = await lookup(venueAnswer({ status: 'NEW' }), {
      status: 'PARTIALLY_FILLED',
      executedQty: '20',
      cummulativeQuoteQty: '19.792',
    })
    expect(order).to.equal(null)
    expect(row.status).to.equal('PARTIALLY_FILLED')
    expect(row.executedQty).to.equal('20')
    expect(db.length, 'nothing written').to.equal(0)
  })

  it('§4.4 a part-filled row answered FILLED still moves up (spec 207)', async () => {
    const { order, row } = await lookup(
      venueAnswer({
        status: 'FILLED',
        executedQty: '37',
        cummulativeQuoteQty: '36.6152',
      }),
      { status: 'PARTIALLY_FILLED', executedQty: '0.1' },
    )
    expect(order?.status).to.equal('FILLED')
    expect(row.status).to.equal('FILLED')
    expect(row.executedQty).to.equal('37')
  })

  it('§4.5 a part-filled row answered CANCELED still takes the venue answer (spec 235)', async () => {
    const { order, db, row } = await lookup(
      venueAnswer({
        status: 'CANCELED',
        executedQty: '12',
        cummulativeQuoteQty: '11.8752',
      }),
      { status: 'PARTIALLY_FILLED', executedQty: '20' },
    )
    expect(order).to.equal(null)
    expect(row, 'dropped from the map').to.equal(undefined)
    expect(db[0].status).to.equal('CANCELED')
    expect(db[0].executedQty).to.equal('12')
  })
})

describe('the deal-close cancel gets the stream fill back as FILLED (spec 250 §3)', () => {
  it('a cancel answered "not found" returns the FILLED row, not a downgrade', async () => {
    const bot: any = Object.create((MainBot as any).prototype)
    bot.data = {
      exchange: ExchangeEnum.krakenUsdm,
      exchangeUUID: '',
      paperContext: false,
    }
    // The stream already booked the fill into the map…
    bot.orders = new Map([[GR_ID, streamRow()]])
    bot.partiallyFilledFilledSet = new Set()
    bot.canceledMap = new Map()
    bot.unknownOrderInFlight = new Map()
    const db: any[] = []
    bot.exchange = {
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
      cancelOrder: async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found in open orders',
        data: null,
      }),
      getOrder: async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: venueAnswer(),
      }),
    }
    bot.startMethod = () => 1
    bot.endMethod = () => undefined
    bot.handleLog = () => undefined
    bot.handleDebug = () => undefined
    bot.handleWarn = () => undefined
    bot.handleErrors = () => undefined
    bot.emit = () => undefined
    bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
    bot.deleteOrder = (id: string) => bot.orders.delete(id)
    bot.updateOrderOnDb = () => undefined
    bot.getOrderFromMap = (id: string) => bot.orders.get(id)
    bot.convertOrderExecutedQty = async (o: any) => o.executedQty
    bot.convertOrderQuoteQty = async (_s: string, q: any) => q
    bot.ordersDb = {
      readData: async () => ({ data: { result: undefined } }),
      updateData: async (_f: any, o: any) => {
        db.push({ ...o })
        return { status: StatusEnum.ok }
      },
    }
    // …while the close's cancel loop still holds the snapshot it took before.
    const stale = { ...streamRow(), status: 'NEW', executedQty: '0' }
    const res = await bot.cancelOrderOnExchange(stale)
    expect(res?.status, 'cancelAllOrder books only a FILLED answer').to.equal(
      'FILLED',
    )
    expect(res.executedQty).to.equal('37')
    const row = bot.orders.get(GR_ID)
    expect(row.status, 'the deal ledger reads FILLED rows').to.equal('FILLED')
    expect(row.executedQty).to.equal('37')
    expect(db.every((w) => w.status === 'FILLED')).to.equal(true)
  })
})
