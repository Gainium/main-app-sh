process.env.NODE_ENV = 'testing'

const ARMED_BOT = '000000000000000000000a11'
const OTHER_BOT = '000000000000000000000b22'

/**
 * Bulk cancel: priming a loop's cancels, and consuming them.
 *
 * Spec: `specs/082.kraken-spot-bulk-cancel-and-bulk-place.md` §3, §4.
 * Run: `npm test` (mocha).
 *
 * The property under test is not "it is faster". It is that a primed cancel
 * and an unprimed one leave the engine in the SAME state — same status, same
 * emit, same DB write, same local map — because everything downstream of the
 * venue answer is what makes a cancelled order cancelled as far as the rest of
 * the engine is concerned. Plus the three ways a prefetch goes wrong: it is
 * consumed twice, it outlives its loop, or it is asked for on a venue that was
 * never meant to be asked.
 *
 * No network / DB: the real methods are driven off the prototype against a
 * recording exchange.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

/** The Kraken txid shape. This is what `orderId` holds on Kraken spot. */
const txid = (n: number) => `ONK6O3-BF63X-24VAO${n}`

function order(n: number, over: Record<string, unknown> = {}) {
  return {
    symbol: 'ETH-EUR',
    orderId: txid(n),
    clientOrderId: `D-RO-SYNTHETIC${n}`,
    price: `${1000 + n}`,
    origPrice: `${1000 + n}`,
    origQty: '0.5',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    updateTime: -1,
    transactTime: -1,
    ...over,
  } as any
}

/** What the venue answers about a cancelled order, per call and in bulk. */
const canceled = (n: number) => ({
  symbol: 'ETH-EUR',
  orderId: txid(n),
  price: `${1000 + n}`,
  origQty: '0.5',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  status: 'CANCELED',
  side: 'BUY',
  updateTime: 1700000000000,
  transactTime: 1700000000000,
})

type Recorded = {
  batch: { symbol: string; newClientOrderIds: string[] }[]
  cancel: { newClientOrderId?: string }[]
  emitted: unknown[]
  dbWrites: string[]
  deleted: string[]
}

function botOn(
  exchange: ExchangeEnum,
  botId: string,
  opts: { batch?: () => unknown } = {},
) {
  const rec: Recorded = {
    batch: [],
    cancel: [],
    emitted: [],
    dbWrites: [],
    deleted: [],
  }
  const bot: any = Object.create((MainBot as any).prototype)
  bot.botId = botId
  bot.data = { exchange, exchangeUUID: '', paperContext: false }
  bot.orders = new Map()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.exchange = {
    returnGood: () => (r: unknown) => ({
      status: StatusEnum.ok,
      data: r,
      reason: null,
    }),
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async cancelOrdersBatch(req: {
      symbol: string
      newClientOrderIds: string[]
    }) {
      rec.batch.push(req)
      return opts.batch
        ? opts.batch()
        : {
            status: StatusEnum.ok,
            data: req.newClientOrderIds.map((id) =>
              canceled(+`${id}`.slice(-1)),
            ),
            reason: null,
          }
    },
    async cancelOrder(req: { newClientOrderId?: string }) {
      rec.cancel.push(req)
      const n = +`${req.newClientOrderId}`.slice(-1)
      return { status: StatusEnum.ok, data: canceled(n), reason: null }
    },
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = () => undefined
  bot.emit = (_e: string, o: unknown) => rec.emitted.push(o)
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => {
    rec.deleted.push(id)
    bot.orders.delete(id)
  }
  bot.updateOrderOnDb = (o: any) => rec.dbWrites.push(o.clientOrderId)
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot._handleUnknownOrder = async () => null
  // The flag, and only the flag. `BOT_BATCH_CANCEL` is parsed once at module
  // load, so a spec that armed it through the environment would depend on
  // which spec file mocha happened to load first; the flag itself is tested in
  // `batchFlags.spec.ts`. The VENUE half of the gate is deliberately not
  // stubbed — it is what the non-Kraken test below proves.
  if (botId === ARMED_BOT) {
    bot.isBatchCancelArmed = () => true
  }
  return { bot, rec }
}

/** Walks a list the way every primed loop does: prime, cancel each, clear. */
async function bulkCancel(bot: any, orders: any[]) {
  await bot.primeCancelBatch(orders)
  try {
    for (const o of orders) {
      await bot.cancelOrderOnExchange(o)
    }
  } finally {
    bot.clearCancelBatch()
  }
}

describe('primeCancelBatch (spec 082 §3)', () => {
  it('asks once for the whole loop and the loop then asks the venue nothing', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const orders = [order(1), order(2), order(3)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    expect(rec.batch).to.have.length(1)
    expect(rec.batch[0].newClientOrderIds).to.deep.equal([
      txid(1),
      txid(2),
      txid(3),
    ])
    expect(rec.cancel, 'per-order cancels were still sent').to.deep.equal([])
  })

  it('leaves the order in exactly the state the per-order path leaves it', async () => {
    const primed = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const perOrder = botOn(ExchangeEnum.kraken, OTHER_BOT)
    const a = [order(1), order(2)]
    const b = [order(1), order(2)]
    a.forEach((o) => primed.bot.orders.set(o.clientOrderId, o))
    b.forEach((o) => perOrder.bot.orders.set(o.clientOrderId, o))
    await bulkCancel(primed.bot, a)
    await bulkCancel(perOrder.bot, b)
    expect(primed.rec.batch, 'the armed bot batched').to.have.length(1)
    expect(perOrder.rec.cancel, 'the unarmed bot did not').to.have.length(2)
    expect(a).to.deep.equal(b)
    expect(a[0].status).to.equal('CANCELED')
    expect(primed.rec.dbWrites).to.deep.equal(perOrder.rec.dbWrites)
    expect(primed.rec.deleted).to.deep.equal(perOrder.rec.deleted)
    expect(primed.rec.emitted).to.deep.equal(perOrder.rec.emitted)
  })

  it('consumes a primed answer once, so a second cancel asks the venue', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const orders = [order(1), order(2)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bot.primeCancelBatch(orders)
    await bot.cancelOrderOnExchange(orders[0])
    await bot.cancelOrderOnExchange(order(1))
    bot.clearCancelBatch()
    expect(rec.cancel.map((c) => c.newClientOrderId)).to.deep.equal([txid(1)])
  })

  it('cannot answer a cancel issued after the loop that primed it', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const orders = [order(1), order(2)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    // Only the first is walked; the loop ends anyway (an early return).
    await bot.primeCancelBatch(orders)
    await bot.cancelOrderOnExchange(orders[0])
    bot.clearCancelBatch()
    // Some later, unrelated cancel of the same order id.
    await bot.cancelOrderOnExchange(order(2))
    expect(rec.cancel.map((c) => c.newClientOrderId)).to.deep.equal([txid(2)])
  })

  it('never asks for an order that never reached the venue', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const orders = [order(1), order(2), order(3, { orderId: '-1' })]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bot.primeCancelBatch(orders)
    bot.clearCancelBatch()
    expect(rec.batch[0].newClientOrderIds).to.deep.equal([txid(1), txid(2)])
  })

  it('does not batch a single order — that is one call either way', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const orders = [order(1)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    expect(rec.batch).to.deep.equal([])
    expect(rec.cancel.map((c) => c.newClientOrderId)).to.deep.equal([txid(1)])
  })

  it('groups by symbol, one call each', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT)
    const orders = [
      order(1),
      order(2),
      order(3, { symbol: 'XBT-EUR' }),
      order(4, { symbol: 'XBT-EUR' }),
    ]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    expect(rec.batch.map((b) => b.symbol)).to.deep.equal(['ETH-EUR', 'XBT-EUR'])
  })

  it('cancels one at a time for an order the batch did not vouch for', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT, {
      // The venue observed only the first of the two.
      batch: () => ({
        status: StatusEnum.ok,
        data: [canceled(1)],
        reason: null,
      }),
    })
    const orders = [order(1), order(2)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    expect(rec.cancel.map((c) => c.newClientOrderId)).to.deep.equal([txid(2)])
    expect(
      orders[1].status,
      'the unvouched order still ended cancelled',
    ).to.equal('CANCELED')
  })
})

describe('primeCancelBatch asks nobody it was not armed for (spec 082 §5)', () => {
  // Runs the REAL gate, whose parsed scope is `off` unless an operator has
  // set `BOT_BATCH_CANCEL` in this shell — which is the production default and
  // the state the fleet runs in.
  it('does nothing for a bot the flag does not name', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, OTHER_BOT)
    const orders = [order(1), order(2)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    expect(rec.batch).to.deep.equal([])
    expect(rec.cancel).to.have.length(2)
  })

  it('does nothing on any venue but Kraken spot', async () => {
    for (const exchange of [
      ExchangeEnum.binance,
      ExchangeEnum.coinbase,
      ExchangeEnum.krakenUsdm,
      ExchangeEnum.paperKraken,
    ]) {
      const { bot, rec } = botOn(exchange, ARMED_BOT)
      const orders = [order(1), order(2)]
      orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
      await bulkCancel(bot, orders)
      expect(rec.batch, `${exchange} was asked`).to.deep.equal([])
      expect(rec.cancel, `${exchange} did not cancel`).to.have.length(2)
    }
  })

  it('keeps asking after a transient failure', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT, {
      batch: () => ({
        status: StatusEnum.notok,
        reason: 'Request Timeout',
        data: null,
      }),
    })
    const orders = [order(1), order(2)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    await bulkCancel(bot, orders)
    expect(rec.batch, 'a bad minute must not latch').to.have.length(2)
    expect(rec.cancel, 'and every order was still cancelled').to.have.length(4)
  })

  /**
   * LAST IN THE FILE ON PURPOSE. The unsupported latch is module-level and
   * keyed by exchange — that is what makes it cost one round trip per process
   * rather than per loop — so a test that sets it for `kraken` must not be
   * followed by one that expects `kraken` to be asked again.
   */
  it('asks a connector that has no such route once, then stops', async () => {
    const { bot, rec } = botOn(ExchangeEnum.kraken, ARMED_BOT, {
      batch: () => ({
        status: StatusEnum.notok,
        reason: 'Exchange connector | Not Found',
        data: null,
      }),
    })
    const orders = [order(1), order(2)]
    orders.forEach((o) => bot.orders.set(o.clientOrderId, o))
    await bulkCancel(bot, orders)
    await bulkCancel(bot, orders)
    expect(rec.batch).to.have.length(1)
    expect(rec.cancel, 'every order was cancelled both times').to.have.length(4)
  })
})
