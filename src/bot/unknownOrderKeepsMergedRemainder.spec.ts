process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `235.unknown-order-lookup-drops-a-merged-remainder`.
 *
 * Replays the sequence recorded in prod (spec §2): a KuCoin spot KAS/USDT base
 * entry for 11278.9777 filled 173.5435 on the book, `buyRemainder` bought the
 * other 11105.4342 at market and merged it into the row (FILLED 11278.9777),
 * then the settle's unknown-order lookup asked the venue, which answered the
 * book order's own end state: CANCELED 173.5435. The REAL
 * `MainBot._handleUnknownOrder` runs off the prototype against a fake venue.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const BO_ID = 'D-BO-K5IT-merged-0235'
const FULL = '11278.9777'
const BOOK = '173.5435'

/** The base-entry row after `buyRemainder` merged the market top-up. */
const mergedRow = (): any => ({
  clientOrderId: BO_ID,
  orderId: '6ae79a00000000000000235',
  botId: 'bbbbbbbbbbbbbbbbbbbb0235',
  dealId: '6ae791222a1206e0a171d9a1',
  symbol: 'KAS-USDT',
  side: 'BUY',
  type: 'LIMIT',
  typeOrder: 'dealStart',
  status: 'FILLED',
  price: '0.0451',
  origQty: FULL,
  executedQty: FULL,
  cummulativeQuoteQty: '508.6619',
  updateTime: 1793560299904,
})

/** What KuCoin answers for the book order: it ended after a part fill. */
const venueAnswer = (over: any = {}): any => ({
  ...mergedRow(),
  status: 'CANCELED',
  price: '0.0451',
  executedQty: BOOK,
  cummulativeQuoteQty: '7.82681185',
  updateTime: 1793560300927,
  ...over,
})

const lookup = async (
  answer: any,
  { merged = true, row = {} as any } = {},
) => {
  const bot: any = Object.create((MainBot as any).prototype)
  bot.data = { exchange: ExchangeEnum.kucoin, paperContext: false }
  bot.orders = new Map([[BO_ID, { ...mergedRow(), ...row }]])
  bot.partiallyFilledFilledSet = new Set(merged ? [BO_ID] : [])
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  const db: any[] = []
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    getOrder: async () => ({ status: StatusEnum.ok, reason: null, data: answer }),
  }
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = () => undefined
  bot.emit = () => undefined
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  // Spot: the conversion is the identity.
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.convertOrderQuoteQty = async (_s: string, q: any) => q
  bot.ordersDb = {
    readData: async () => ({ data: { result: undefined } }),
    updateData: async (_f: any, o: any) => {
      db.push({ ...o })
      return { status: StatusEnum.ok }
    },
  }
  const order = await bot._handleUnknownOrder(BO_ID, 'KAS-USDT')
  return { order, db, row: bot.orders.get(BO_ID) }
}

describe('an unknown-order lookup keeps a merged remainder (spec 235)', () => {
  it('§4.1 a merged row answered CANCELED-short stays FILLED at the full size', async () => {
    const { order, db, row } = await lookup(venueAnswer())
    expect(row, 'the row stays in the order map').to.not.equal(undefined)
    expect(row.status).to.equal('FILLED')
    expect(row.executedQty).to.equal(FULL)
    expect(row.price).to.equal('0.0451')
    expect(row.cummulativeQuoteQty).to.equal('508.6619')
    expect(order?.status, 'returned as FILLED').to.equal('FILLED')
    expect(order.executedQty).to.equal(FULL)
    for (const w of db) {
      expect(w.status, 'no CANCELED write').to.equal('FILLED')
      expect(w.executedQty).to.equal(FULL)
    }
  })

  it('§4.1 also when the venue states no fill size at all', async () => {
    const { order, row } = await lookup(
      venueAnswer({ executedQty: '0', cummulativeQuoteQty: '0' }),
    )
    expect(row?.status).to.equal('FILLED')
    expect(row.executedQty).to.equal(FULL)
    expect(order?.executedQty).to.equal(FULL)
  })

  it('§4.2 a row that was NOT topped up still takes the venue fill size (spec 207 stays)', async () => {
    const { order, db, row } = await lookup(venueAnswer(), {
      merged: false,
      row: { status: 'PARTIALLY_FILLED', executedQty: '100' },
    })
    expect(order, 'CANCELED is not returned').to.equal(null)
    expect(row, 'dropped from the map').to.equal(undefined)
    expect(db[0].status).to.equal('CANCELED')
    expect(db[0].executedQty).to.equal(BOOK)
  })

  it('§4.2 a merged row the venue reports LARGER than the merge takes the venue size', async () => {
    const { order } = await lookup(
      venueAnswer({ status: 'FILLED', executedQty: '11300' }),
      { row: { status: 'PARTIALLY_FILLED' } },
    )
    expect(order?.status).to.equal('FILLED')
    expect(order.executedQty).to.equal('11300')
  })
})
