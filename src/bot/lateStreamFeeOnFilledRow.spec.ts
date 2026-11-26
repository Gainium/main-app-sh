process.env.NODE_ENV = 'testing'

/**
 * Spec 286 — the fee of an order its placement answer already filled.
 *
 * Kraken Futures answers a MARKET order that filled on arrival with no fee,
 * and the user stream states the fee a few hundred milliseconds later on a
 * FILLED `ORDER_TRADE_UPDATE`. The answer books the fill. The stream report
 * must leave its fee on the stored order:
 *
 * - when the order is gone from the bot (a take-profit whose fill closed the
 *   deal): through SharedStream's retired route → `accountCallback` (§4.1, §4.2);
 * - when the bot still holds it FILLED: through `processOrderQueue` (§4.3).
 *
 * Either way the write is fee-only and never overwrites a fee (§4.4).
 *
 * Run: `npm test` (mocha). No network or DB. The real SharedStream routing,
 * `setOrder`/`deleteOrder`, `accountCallback` and `processOrderQueue` run off
 * their prototypes against an in-memory `orders` collection that applies the
 * filter fields this path uses.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import SharedStream from './sharedStream'
import { ExchangeEnum, StatusEnum } from '../../types'

const AT = 1795719601707
const FEE = '0.02524125'

type Row = Record<string, any>

/**
 * `orders` in memory. `updateData` applies only when every filter field
 * matches. It knows exactly the operators this path and `updateOrderOnDb`
 * use: equality, `$ne`, `$in`, `$exists`, `$and`.
 */
function ordersCollection(rows: Row[]) {
  const writes: { filter: Row; update: Row }[] = []
  const get = (r: Row, k: string) =>
    k.split('.').reduce((v: any, p) => (v == null ? undefined : v[p]), r)
  const ok = (r: Row, f: Row): boolean =>
    Object.entries(f).every(([k, cond]) => {
      if (k === '$and') return (cond as Row[]).every((c) => ok(r, c))
      const v = get(r, k)
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$ne' in cond) return v !== cond.$ne
        if ('$in' in cond)
          return (cond.$in as unknown[]).some((x) =>
            x === null ? v == null : v === x,
          )
        if ('$exists' in cond) return cond.$exists ? v !== undefined : v === undefined
      }
      return v === cond
    })
  return {
    rows,
    writes,
    readData: async (filter: Row) => ({
      status: StatusEnum.ok,
      data: { result: rows.find((r) => ok(r, filter)) ?? null },
    }),
    updateData: async (filter: Row, update: Row) => {
      writes.push({ filter, update })
      const row = rows.find((r) => ok(r, filter))
      if (row) {
        const { $set, $unset, ...plain } = update
        Object.assign(row, plain, $set ?? {})
        for (const k of Object.keys($unset ?? {})) delete row[k]
      }
      return { status: StatusEnum.ok, data: row ?? null }
    },
  }
}

/** The order as the placement answer saved it: FILLED, no fee. */
function answered(clientOrderId: string, over: Row = {}): Row {
  return {
    _id: 'row1',
    symbol: 'PF_XRPUSD',
    orderId: 'kraken-1',
    clientOrderId,
    botId: 'bot',
    userId: 'user',
    price: '0.9525',
    origPrice: '0.9525',
    origQty: '53',
    executedQty: '53',
    cummulativeQuoteQty: '50.4825',
    status: 'FILLED',
    side: 'SELL',
    type: 'MARKET',
    typeOrder: 'dealTP',
    dealId: '6b07bcd14a4985ef6d5cb70c',
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: 'acc',
    updateTime: AT,
    transactTime: AT,
    ...over,
  }
}

/** The late user-stream report, as websocket-connector-sh publishes it. */
function lateReport(clientOrderId: string, over: Row = {}): any {
  return {
    eventType: 'ORDER_TRADE_UPDATE',
    eventTime: AT + 416,
    transactionTime: AT + 416,
    orderTime: AT + 416,
    symbol: 'PF_XRPUSD',
    clientOrderId,
    side: 'SELL',
    orderType: 'MARKET',
    quantity: '53',
    price: '0.9525',
    averagePrice: '0.9525',
    orderStatus: 'FILLED',
    orderId: 'kraken-1',
    totalTradeQuantity: '53',
    feePaid: FEE,
    feeAsset: 'USD',
    ...over,
  }
}

function bot(rows: Row[], botType = 'dca') {
  const rec = { logs: [] as string[], filled: [] as Row[], queued: 0 }
  const db = ordersCollection(rows)
  const b: any = Object.create((MainBot as any).prototype)
  b.botId = 'bot'
  b.userId = 'user'
  b.botType = botType
  b.data = {
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: 'acc',
    paperContext: false,
    settings: { leverage: 1, pair: ['PF_XRPUSD'] },
    flags: [],
  }
  b.orders = new Map()
  b.ordersKeys = new Set()
  b.orderQueue = []
  b.processedOrders = new Map()
  b.lockProcessQueueMethod = false
  b.partiallyFilledFilledSet = new Set()
  b.math = { round: (v: number, p = 8) => +(+v).toFixed(p), remainder: () => 0 }
  b.handleLog = (m: string) => rec.logs.push(m)
  b.handleDebug = () => undefined
  b.handleWarn = (m: string) => rec.logs.push(m)
  b.handleErrors = (m: string) => rec.logs.push(m)
  b.emit = () => undefined
  b.setOrdersToRedis = () => undefined
  b.setOrderByDeal = () => undefined
  b.setOrderByStatus = () => undefined
  b.removeOrderByDeal = () => undefined
  b.removeOrderByStatus = () => undefined
  b.needToSendOrder = () => true
  b.fillPartiallyFilledOrder = async (o: Row) => o
  b.convertOrderQuoteQty = async (_s: string, q: string) => q
  b.getExchangeInfo = async () => ({
    pair: 'PF_XRPUSD',
    priceAssetPrecision: 4,
    baseAsset: { minAmount: 1, step: 1, name: 'XRP' },
    quoteAsset: { minAmount: 1, name: 'USD', precision: 8 },
  })
  b.ordersDb = db
  b.botEventDb = { createData: () => undefined }
  b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  const onFilled = async (o: Row) => {
    rec.filled.push({ ...o })
  }
  b.cbFunctions = {
    sort: () => 0,
    onFilled,
    onPartiallyFilled: async () => undefined,
    onCanceled: async () => undefined,
    onNew: async () => undefined,
    onLiquidation: async () => undefined,
  }
  const queue = b.processOrderQueue
  b.processOrderQueue = function (...args: unknown[]) {
    rec.queued++
    return queue.apply(this, args)
  }
  return { bot: b, db, rec }
}

/** A SharedStream with no Redis behind it: only its routing maps. */
function stream() {
  const s: any = Object.create((SharedStream as any).prototype)
  s.redis = null
  s.listeners = new Map()
  s.subscribers = new Map()
  s.ordersToBotMap = new Map()
  s.botToOrdersMap = new Map()
  s.retiredRoutes = new Map()
  return s
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

async function settle(b: any) {
  for (let i = 0; i < 200 && (b.orderQueue.length || b.lockProcessQueueMethod); i++) {
    await tick(1)
  }
  await tick(5)
}

const feeFields = (r: Row) => ({
  feePaid: r.feePaid,
  feeAsset: r.feeAsset,
})

const realNow = Date.now
afterEach(() => {
  Date.now = realNow
})

describe('spec 286: a late stream fee for an order the placement answer filled', () => {
  for (const [botType, id] of [
    ['dca', 'D-TP-lateFeeDca000000000000000000001'],
    ['combo', 'D-TP-cmbLateFee0000000000000000001'],
    ['grid', 'GRID-TP-lateFee000000000000000000001'],
  ] as const) {
    it(`§4.1/§4.2 ${botType}: the order left the bot, the report still lands its fee`, async () => {
      const row = answered(id)
      const { bot: b, db, rec } = bot([row], botType)
      const s = stream()
      b.sharedStream = s
      s.listeners.set(b.botId, (m: any) => b.accountCallback(m))
      // The order as the engine holds it while placing (NEW, routed), then the
      // answer's FILLED, then the deal closes and drops it.
      b.setOrder({ ...row, status: 'NEW', executedQty: '0' })
      await tick()
      b.setOrder({ ...row })
      b.deleteOrder(id)
      await tick()
      expect(s.ordersToBotMap.has(id), 'live route gone').to.equal(false)

      s.redisCb(JSON.stringify(lateReport(id)), 'acc')
      await settle(b)

      expect(feeFields(row)).to.deep.equal({ feePaid: FEE, feeAsset: 'USD' })
      expect(row.status).to.equal('FILLED')
      expect(row.executedQty).to.equal('53')
      expect(row.updateTime).to.equal(AT)
      expect(rec.queued, 'no fill handling').to.equal(0)
      expect(rec.filled).to.have.length(0)
      expect(rec.logs.join('\n')).to.not.include('STREAM-DESYNC')
      const w = db.writes.at(-1)!
      expect(Object.keys(w.update)).to.deep.equal(['$set'])
      expect(Object.keys(w.update.$set).sort()).to.deep.equal(['feeAsset', 'feePaid'])
    })
  }

  it('§4.1 a retired route carries only a fee-bearing FILLED, and only for a while', async () => {
    const s = stream()
    const got: any[] = []
    s.listeners.set('bot', (m: any) => got.push(m))
    const id = 'D-TP-retiredRouteOnly000000000000001'
    await s.addOrder('bot', id)
    await s.removeOrder('bot', id)

    s.redisCb(JSON.stringify(lateReport(id, { feePaid: undefined, feeAsset: undefined })), 'acc')
    s.redisCb(JSON.stringify(lateReport(id, { orderStatus: 'PARTIALLY_FILLED' })), 'acc')
    s.redisCb(JSON.stringify(lateReport(id, { orderStatus: 'CANCELED' })), 'acc')
    expect(got, 'no fee / not FILLED: dropped as before').to.have.length(0)

    s.redisCb(JSON.stringify(lateReport(id)), 'acc')
    expect(got).to.have.length(1)

    const start = realNow()
    Date.now = () => start + (SharedStream as any).RETIRED_ROUTE_TTL_MS + 1
    s.redisCb(JSON.stringify(lateReport(id)), 'acc')
    expect(got, 'expired').to.have.length(1)
  })

  it('§4.1 removeListener forgets the bot\'s retired routes', async () => {
    const s = stream()
    const got: any[] = []
    s.listeners.set('bot', (m: any) => got.push(m))
    s.subscribers.set('acc', new Set(['bot', 'other']))
    const id = 'D-TP-retiredRouteListener0000000001'
    await s.addOrder('bot', id)
    await s.removeOrder('bot', id)
    await s.removeListener('acc', 'bot')
    s.listeners.set('bot', (m: any) => got.push(m))
    s.redisCb(JSON.stringify(lateReport(id)), 'acc')
    expect(got).to.have.length(0)
  })

  it('§4.4 never overwrites a fee the row already holds', async () => {
    const id = 'D-TP-hasFeeAlready00000000000000001'
    const row = answered(id, { feePaid: '0.01', feeAsset: 'USD' })
    const { bot: b } = bot([row])
    await b.accountCallback(lateReport(id))
    await settle(b)
    expect(feeFields(row)).to.deep.equal({ feePaid: '0.01', feeAsset: 'USD' })
  })

  it('§4.2 a stored row that is not FILLED is today\'s desync, untouched', async () => {
    const id = 'D-TP-storedNotFilled000000000000001'
    const row = answered(id, { status: 'NEW', executedQty: '0' })
    const { bot: b, db, rec } = bot([row])
    await b.accountCallback(lateReport(id, { eventType: 'executionReport', newClientOrderId: id, totalQuoteTradeQuantity: '50.4825' }))
    await settle(b)
    expect(row.feePaid).to.equal(undefined)
    expect(row.status).to.equal('NEW')
    expect(db.writes).to.have.length(0)
    expect(rec.logs.join('\n')).to.include('STREAM-DESYNC')
  })

  it('§4.2 a report with no fee for an untracked order reads nothing', async () => {
    const id = 'D-TP-noFeeUntracked0000000000000001'
    const row = answered(id)
    const { bot: b, db } = bot([row])
    let reads = 0
    const read = db.readData
    db.readData = async (f: Row) => {
      reads++
      return read(f)
    }
    await b.accountCallback(lateReport(id, { feePaid: undefined, feeAsset: undefined }))
    expect(reads).to.equal(0)
    expect(db.writes).to.have.length(0)
  })

  for (const typeOrder of ['dealStart', 'dealRegular', 'dealTP']) {
    it(`§4.3/§4.5 ${typeOrder} still held FILLED: the stored row takes the fee`, async () => {
      const id = `D-${typeOrder === 'dealStart' ? 'BO' : typeOrder === 'dealRegular' ? 'RO' : 'TP'}-heldFilled${typeOrder}`
      const row = answered(id, { typeOrder })
      const { bot: b, rec } = bot([row])
      b.setOrder({ ...row })
      await b.accountCallback(lateReport(id))
      await settle(b)
      expect(rec.queued, 'processed as today').to.be.greaterThan(0)
      expect(feeFields(row)).to.deep.equal({ feePaid: FEE, feeAsset: 'USD' })
      expect(row.status).to.equal('FILLED')
      expect(row.executedQty).to.equal('53')
      expect(b.orders.get(id).feePaid, 'held copy has it too').to.equal(FEE)
    })
  }
})
