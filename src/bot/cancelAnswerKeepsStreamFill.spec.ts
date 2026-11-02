process.env.NODE_ENV = 'testing'

/**
 * A cancel answer must not erase a fill the user stream already reported.
 *
 * Spec: `specs/220.cancel-answer-erases-the-fill-the-stream-already-reported.md`.
 *
 * The shape is a production combo close on Hyperliquid spot. The close sweep
 * cancels a grid SELL of 204. While that cancel is in flight the user stream
 * reports the order `CANCELED` with 41 executed, and `processOrderQueue` puts
 * that report into the order map as a NEW object. The cancel answer, a
 * `getOrder` read-back, then says `CANCELED` with nothing executed. Before the
 * fix, the answer was copied onto the pre-cancel snapshot, the snapshot went
 * back into the map over the stream's row, and the delete-on-zero removed it.
 * The deal's ledger, built from the map, then sized the close 41 short.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * No network / DB: the real method runs off the prototype against a recording
 * transport, the same shape as `resizeCancelPromotion.spec.ts`.
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'
import { executedFillQty } from './dca/executedFill'

const CLIENT_ID = '0x00000000000000000000000000000220'

/** The grid SELL as the sweep read it before the cancel. */
function gridSell(over: Record<string, unknown> = {}) {
  return {
    symbol: 'TKN-USDC',
    orderId: '220000000001',
    clientOrderId: CLIENT_ID,
    dealId: '000000000000000000000d20',
    minigridId: '000000000000000000000f20',
    typeOrder: 'dealGrid',
    price: '0.050553',
    origPrice: '0.050553',
    origQty: '204',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'SELL',
    updateTime: 1793505507675,
    transactTime: 1793505507675,
    ...over,
  } as any
}

/** The venue's own end-of-order report, as the user stream delivered it. */
const streamReport = () =>
  gridSell({
    status: 'CANCELED',
    executedQty: '41',
    cummulativeQuoteQty: '2.072673',
    updateTime: 1793515688452,
  })

/**
 * @param answer what the cancel call returns.
 * @param duringCancel runs while the cancel is in flight: where the stream's
 *   report lands in the order map.
 */
function bot(
  answer: Record<string, unknown>,
  duringCancel: (orders: Map<string, any>) => void = () => undefined,
) {
  const saved: any[] = []
  const b: any = Object.create((MainBot as any).prototype)
  b.data = { exchange: ExchangeEnum.hyperliquid, exchangeUUID: '', paperContext: false }
  b.orders = new Map()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async cancelOrder() {
      duringCancel(b.orders)
      return { status: StatusEnum.ok, reason: '', data: { ...answer } }
    },
  }
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = () => undefined
  b.handleDebug = () => undefined
  b.handleWarn = () => undefined
  b.handleErrors = () => undefined
  b.emit = () => undefined
  // The real map semantics, without Redis.
  b.setOrder = (o: any) => b.orders.set(o.clientOrderId, o)
  b.deleteOrder = (id: string) => b.orders.delete(id)
  b.updateOrderOnDb = (o: any) => saved.push({ ...o })
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b.setFilledInsteadOfCanceled = async () => true
  b.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  return { b, saved }
}

/** What the venue's read-back answered for the production order. */
const ANSWER_NO_FILL = {
  status: 'CANCELED',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  price: '0.050553',
  updateTime: 1793515689001,
}

describe('cancelOrderOnExchange keeps a fill already reported (spec 220)', () => {
  it('§4.1/§4.2 the stream report that landed mid-cancel survives an answer of 0', async () => {
    const snapshot = gridSell()
    const { b } = bot(ANSWER_NO_FILL, (orders) =>
      // processOrderQueue: deleteOrder + setOrder with the report's own object.
      orders.set(CLIENT_ID, streamReport()),
    )
    b.orders.set(CLIENT_ID, snapshot)
    const result = await b.cancelOrderOnExchange(snapshot, true, true)

    const held = b.orders.get(CLIENT_ID)
    expect(held, 'row is still in the order map').to.not.equal(undefined)
    expect(+held.executedQty, 'executed quantity in the map').to.equal(41)
    expect(+held.cummulativeQuoteQty).to.equal(2.072673)
    expect(held.status, '§4.3 status is the answer’s').to.equal('CANCELED')
    expect(+result.executedQty, 'returned row').to.equal(41)
    // What the deal ledger (`updateDealBalances`, which sizes a combo close)
    // books for this row.
    expect(executedFillQty(held), 'ledger counts it').to.equal(41)
  })

  it('§4.1 a fill on the pre-cancel row survives an answer of 0', async () => {
    // The `059` shape: the row already said PARTIALLY_FILLED before the cancel.
    const snapshot = gridSell({
      status: 'PARTIALLY_FILLED',
      executedQty: '41',
      cummulativeQuoteQty: '2.072673',
    })
    const { b } = bot(ANSWER_NO_FILL)
    b.orders.set(CLIENT_ID, snapshot)
    await b.cancelOrderOnExchange(snapshot, true, true, false)
    const held = b.orders.get(CLIENT_ID)
    expect(held).to.not.equal(undefined)
    expect(+held.executedQty).to.equal(41)
    expect(held.status).to.equal('CANCELED')
  })

  it('§4.3 an answer that states more than the report wins, and promotes as before', async () => {
    const snapshot = gridSell()
    const { b, saved } = bot(
      { ...ANSWER_NO_FILL, executedQty: '60', cummulativeQuoteQty: '3.03318' },
      (orders) => orders.set(CLIENT_ID, streamReport()),
    )
    b.orders.set(CLIENT_ID, snapshot)
    const result = await b.cancelOrderOnExchange(snapshot, true, true)
    expect(+result.executedQty).to.equal(60)
    // Default path: a cancelled order carrying fills is promoted (spec 026 §5).
    expect(result.status).to.equal('FILLED')
    expect(saved.map((o) => o.status)).to.deep.equal(['FILLED'])
  })

  it('§4.4 an untouched order still cancels and leaves the map', async () => {
    const snapshot = gridSell()
    const { b, saved } = bot(ANSWER_NO_FILL)
    b.orders.set(CLIENT_ID, snapshot)
    const result = await b.cancelOrderOnExchange(snapshot, true, true)
    expect(result.status).to.equal('CANCELED')
    expect(+result.executedQty).to.equal(0)
    expect(b.orders.has(CLIENT_ID), 'deleted as before').to.equal(false)
    expect(saved.map((o) => o.status)).to.deep.equal(['CANCELED'])
  })
})
