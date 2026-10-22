process.env.NODE_ENV = 'testing'

/**
 * A deal closes while one of its Coinbase orders is still being placed. The
 * close cancels that order while its row still carries the `'-1'` placeholder,
 * and the cancel used to read that as "never reached the venue" and write the
 * order off on the spot. The venue then accepted it a few hundred ms later, and
 * it filled as coins that belonged to no deal.
 *
 * Spec: `specs/155.cancel-writes-off-an-order-still-being-placed.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB — the real `sendOrderToExchange`, `cancelOrderOnExchange`
 * and unknown-order ladder run off the prototype against a fake venue whose
 * `openOrder` answer the test releases by hand.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'
import RedisClient from '../db/redis'

const CLIENT_ID = 'D-ROA-gw7TVxJUwkORPTIZ06HySkCcxGsA2'
const VENUE_ID = '5b1f0c2e-77aa-4d55-9d0e-1d1c1a2b3c4d'
const DEAL_ID = '6acab04e95e307180e5b9993'

function roa(over: Record<string, unknown> = {}) {
  return {
    symbol: 'HIGH-USDC',
    orderId: '-1',
    clientOrderId: CLIENT_ID,
    price: '0.03416',
    origPrice: '0.03416',
    origQty: '229.15',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    side: 'BUY',
    type: 'LIMIT',
    typeOrder: 'regular',
    dealId: DEAL_ID,
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    updateTime: 1791668325303,
    transactTime: 1791668325303,
    ...over,
  } as any
}

type Rec = {
  open: string[]
  cancel: string[]
  getOrder: string[]
  openOrders: string[]
  db: any[]
  logs: string[]
  errorLogs: string[]
}

/**
 * @param venueStatus what the venue says about the order once it answers the
 * placement (and what its cancel endpoint finds)
 */
function coinbaseBot(
  venueStatus: 'NEW' | 'FILLED' | 'PARTIALLY_FILLED' = 'NEW',
  placement: 'accept' | 'refuse' | 'refuse-then-accept' = 'accept',
) {
  const rec: Rec = {
    open: [],
    cancel: [],
    getOrder: [],
    openOrders: [],
    db: [],
    logs: [],
    errorLogs: [],
  }
  let release: () => void = () => undefined
  const placed = new Promise<void>((r) => (release = r))
  const executed =
    venueStatus === 'FILLED'
      ? '229.15'
      : venueStatus === 'PARTIALLY_FILLED'
        ? '100'
        : '0'
  const venueOrder = (status: string) => ({
    ...roa(),
    orderId: VENUE_ID,
    status,
    executedQty: executed,
    cummulativeQuoteQty: `${+executed * 0.03416}`,
  })
  const bot: any = Object.create((MainBot as any).prototype)
  bot.botId = 'bot'
  bot.userId = 'user'
  bot.botType = 'dca'
  bot.data = {
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    paperContext: false,
    settings: { leverage: 1 },
    flags: [],
  }
  bot.orders = new Map()
  bot.ordersKeys = new Set()
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.math = {
    round: (v: number, p = 8) => +(+v).toFixed(p),
    remainder: () => 0,
  }
  const bad = (reason: string) => ({
    status: StatusEnum.notok,
    reason,
    data: null,
  })
  const good = (data: unknown) => ({
    status: StatusEnum.ok,
    reason: null,
    data,
  })
  bot.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => good,
    async openOrder(req: { newClientOrderId: string }) {
      rec.open.push(req.newClientOrderId)
      await placed
      if (placement === 'refuse') {
        return bad('Invalid limit price')
      }
      if (placement === 'refuse-then-accept' && rec.open.length === 1) {
        // Coinbase balance refusals are retried by sendOrderToExchange.
        return bad('Insufficient balance in source account')
      }
      return good(venueOrder(venueStatus))
    },
    async getAllOpenOrders(symbol: string) {
      rec.openOrders.push(symbol)
      // At the moment of the cancel the venue does not list it yet (§3.2).
      return good([])
    },
    async cancelOrder(req: { newClientOrderId: string }) {
      rec.cancel.push(req.newClientOrderId)
      if (req.newClientOrderId === VENUE_ID && venueStatus !== 'FILLED') {
        return good(venueOrder('CANCELED'))
      }
      return bad('Order not found')
    },
    async getOrder(req: { newClientOrderId: string }) {
      rec.getOrder.push(req.newClientOrderId)
      if (req.newClientOrderId === VENUE_ID) {
        return good(venueOrder(venueStatus))
      }
      return bad('Order not found')
    },
  }
  bot.startMethod = () => 1
  bot.endMethod = () => undefined
  bot.handleLog = (m: string) => rec.logs.push(m)
  bot.handleDebug = () => undefined
  bot.handleWarn = (m: string) => rec.logs.push(m)
  bot.handleError = (m: string) => rec.errorLogs.push(m)
  bot.handleErrors = (reason: string) => rec.errorLogs.push(reason)
  bot.handleOrderErrors = async () => undefined
  bot.emit = () => undefined
  bot.noteOwnCancel = () => undefined
  bot.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
  bot.setOrdersToRedis = () => undefined
  bot.setOrderByDeal = () => undefined
  bot.setOrderByStatus = () => undefined
  bot.removeOrderByDeal = () => undefined
  bot.removeOrderByStatus = () => undefined
  bot.getExchangeInfo = async () => ({
    pair: 'HIGH-USDC',
    priceAssetPrecision: 5,
    baseAsset: { minAmount: 0.01, step: 0.01, name: 'HIGH' },
    quoteAsset: { minAmount: 1, name: 'USDC', precision: 6 },
  })
  bot.getUserFee = async () => ({ maker: 0.001, taker: 0.001 })
  bot.saveOrderToDb = async () => undefined
  bot.deleteOrderFromDb = async () => undefined
  bot.updateOrderOnDb = async (o: any) => rec.db.push({ ...o })
  bot.getNotEnoughOrdersIdByOrder = () => 'nb'
  bot.isComplianceGateable = () => false
  bot.needToSendOrder = () => true
  bot.markDealStartBlocked = async () => undefined
  bot.isErrorNotEnoughBalance = () => false
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  bot.convertOrderQuoteQty = async (_s: string, q: string) => q
  bot.ordersDb = {
    // The latest row written for the order, as the real collection would hold.
    readData: async (q: { clientOrderId: string }) => ({
      data: {
        result: [...rec.db]
          .reverse()
          .find((d) => d.clientOrderId === q.clientOrderId),
      },
    }),
    updateData: async () => ({ status: StatusEnum.ok }),
  }
  bot.botEventDb = { createData: () => undefined }
  return { bot, rec, release }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

/** Start a placement and stop while the venue still owes its answer. */
async function placeAndHold(bot: any) {
  const order = roa()
  const sending = bot.sendOrderToExchange(order)
  await tick()
  return { order, sending }
}

describe('cancel during an in-flight placement (spec 155)', () => {
  it('§4.2 the cancel waits for the placement and cancels on the venue by the real id', async () => {
    const { bot, rec, release } = coinbaseBot('NEW')
    const { order, sending } = await placeAndHold(bot)
    expect(rec.open).to.deep.equal([CLIENT_ID])
    expect(bot.orders.get(CLIENT_ID)?.orderId).to.equal('-1')

    const cancelling = bot.cancelOrderOnExchange(order)
    await tick()
    release()
    const [, cancelled] = await Promise.all([sending, cancelling])

    expect(
      rec.cancel,
      'the cancel must reach the venue under the id it returned',
    ).to.deep.equal([VENUE_ID])
    expect(cancelled?.status).to.equal('CANCELED')
    expect(cancelled?.orderId).to.equal(VENUE_ID)
    const last = rec.db[rec.db.length - 1]
    expect(last.status, 'final row').to.equal('CANCELED')
    expect(last.orderId).to.equal(VENUE_ID)
    expect(rec.errorLogs).to.deep.equal([])
  })

  it('§4.2 a refused placement is still retired without a venue cancel', async () => {
    const { bot, rec, release } = coinbaseBot('NEW', 'refuse')
    const { order, sending } = await placeAndHold(bot)
    const cancelling = bot.cancelOrderOnExchange(order)
    await tick()
    release()
    await Promise.all([sending, cancelling])
    expect(rec.cancel, 'no cancel addressed to -1').to.deep.equal([])
  })

  it('§4.4 a balance retry accepted after the cancel retired the order is cancelled on the venue', async () => {
    const { bot, rec, release } = coinbaseBot('NEW', 'refuse-then-accept')
    const { order, sending } = await placeAndHold(bot)
    const cancelling = bot.cancelOrderOnExchange(order)
    await tick()
    release()
    await Promise.all([sending, cancelling])
    expect(rec.open.length, 'placement retried').to.equal(2)
    expect(rec.cancel).to.deep.equal([VENUE_ID])
    const last = rec.db[rec.db.length - 1]
    expect(last.status).to.equal('CANCELED')
    expect(last.orderId).to.equal(VENUE_ID)
  })

  it('§4.3 the ladder waits for the placement before its no-exchange-id fast path', async () => {
    const { bot, rec, release } = coinbaseBot('NEW')
    const { sending } = await placeAndHold(bot)
    const asking = bot._handleUnknownOrder(CLIENT_ID, 'HIGH-USDC')
    await tick()
    release()
    await Promise.all([sending, asking])
    expect(rec.getOrder, 'asks the venue by the real id').to.deep.equal([
      VENUE_ID,
    ])
    expect(
      rec.db.filter((d) => d.status === 'CANCELED' && d.orderId === '-1'),
      'not written off',
    ).to.deep.equal([])
  })

  it('§4.4 a late reply for an order written off while open is cancelled on the venue', async () => {
    const { bot, rec, release } = coinbaseBot('NEW')
    const { order, sending } = await placeAndHold(bot)
    // Retired by a path that does not wait (the pre-155 cancel did exactly this).
    order.status = 'CANCELED'
    bot.orders.delete(CLIENT_ID)
    release()
    await sending
    expect(rec.cancel).to.deep.equal([VENUE_ID])
    const last = rec.db[rec.db.length - 1]
    expect(last.status).to.equal('CANCELED')
    expect(last.orderId).to.equal(VENUE_ID)
  })

  it('§4.4 a late reply that already FILLED is logged as an error, not cancelled', async () => {
    const { bot, rec, release } = coinbaseBot('FILLED')
    const { order, sending } = await placeAndHold(bot)
    order.status = 'CANCELED'
    bot.orders.delete(CLIENT_ID)
    release()
    await sending
    expect(rec.cancel).to.deep.equal([])
    expect(rec.errorLogs.length).to.equal(1)
    expect(rec.errorLogs[0]).to.contain(CLIENT_ID)
    expect(rec.errorLogs[0]).to.contain(DEAL_ID)
    expect(rec.errorLogs[0]).to.contain('229.15')
  })

  it('§4.6 a placement with no cancel racing it is untouched', async () => {
    const { bot, rec, release } = coinbaseBot('NEW')
    const { sending } = await placeAndHold(bot)
    release()
    const res = await sending
    expect(res?.status).to.equal('NEW')
    expect(res?.orderId).to.equal(VENUE_ID)
    expect(rec.cancel).to.deep.equal([])
    expect(rec.errorLogs).to.deep.equal([])
    expect(bot.placementsInFlight?.size ?? 0).to.equal(0)
  })

  it('§4.5 the write-off line states the lookups made, not a wait it never made', async () => {
    const { bot, rec } = coinbaseBot('NEW')
    bot.orders.set(CLIENT_ID, roa())
    await bot._handleUnknownOrder(CLIENT_ID, 'HIGH-USDC')
    const line = rec.logs.find((l) => l.includes('status set to CANCELED'))
    expect(line).to.not.equal(undefined)
    expect(line).to.not.contain('2000 ms')
    expect(line).to.not.contain('5 attempts')
    expect(line).to.contain('1 lookup')
  })
})

/**
 * Spec 192. The `'-1'` row is written ahead BEFORE the pre-send guards run, and
 * the spec 155 handle used to start only at the venue call. A Hyperliquid grid
 * close cancelled its own take-profit while the not-enough-balance guard was
 * still fetching balances, wrote it off as CANCELED, and the venue filled it a
 * second later.
 */
const HL_CLIENT_ID = '0xdfcd0e23cfa2944ff1dfbcc8937b9497'
const HL_VENUE_ID = '581443545717'

const hlFakeRedis = (() => {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v)
    },
    del: async (k: string) => {
      store.delete(k)
    },
  }
})()

function hyperliquidBot(guard: 'hold' | 'throw' = 'hold') {
  const { bot, rec } = coinbaseBot('FILLED')
  let placedOnVenue = false
  let releaseGuard: () => void = () => undefined
  const guardOpen = new Promise<void>((r) => (releaseGuard = r))
  const order = roa({
    symbol: 'BTC-USDC',
    clientOrderId: HL_CLIENT_ID,
    side: 'SELL',
    type: 'MARKET',
    typeOrder: 'stop',
    origQty: '0.02797',
    price: '108000',
    origPrice: '108000',
    baseAsset: 'BTC',
    quoteAsset: 'USDC',
    exchange: ExchangeEnum.hyperliquid,
    dealId: undefined,
  })
  const venueOrder = () => ({
    ...order,
    orderId: HL_VENUE_ID,
    status: 'FILLED',
    executedQty: '0.02797',
    cummulativeQuoteQty: `${0.02797 * 108000}`,
  })
  const bad = (reason: string) => ({
    status: StatusEnum.notok,
    reason,
    data: null,
  })
  const good = (data: unknown) => ({
    status: StatusEnum.ok,
    reason: null,
    data,
  })
  bot.data.exchange = ExchangeEnum.hyperliquid
  // The latch that sends every order through the balance check first.
  bot.data.notEnoughBalance = {
    thresholdPassed: true,
    orders: { nb: 10 },
  }
  bot.getAssetBalanceAndRequiredByOrder = async () => {
    await guardOpen
    if (guard === 'throw') {
      throw new Error('balance fetch failed')
    }
    return { asset: 'BTC', balance: { free: 1 }, required: 0.02797 }
  }
  bot.spendableForNotEnoughBalance = async (_a: string, free: number) => free
  bot.clearsRefusedConstraint = () => true
  bot.updateNotEnoughBalanceErrors = () => undefined
  bot.requiredForOrder = () => 0.02797
  bot.notEnoughBalanceThreshold = 10
  bot.getExchangeInfo = async () => ({
    pair: 'BTC-USDC',
    priceAssetPrecision: 1,
    baseAsset: { minAmount: 0.00001, step: 0.00001, name: 'BTC' },
    quoteAsset: { minAmount: 10, name: 'USDC', precision: 6 },
  })
  bot.exchange.openOrder = async (req: { newClientOrderId: string }) => {
    rec.open.push(req.newClientOrderId)
    placedOnVenue = true
    return good(venueOrder())
  }
  // Hyperliquid addresses a cancel by client order id. Before the placement it
  // does not know the order; after it, the market order has already filled.
  bot.exchange.cancelOrder = async (req: { newClientOrderId: string }) => {
    rec.cancel.push(req.newClientOrderId)
    return bad('Order was never placed, already canceled, or filled. asset=3')
  }
  bot.exchange.getOrder = async (req: { newClientOrderId: string }) => {
    rec.getOrder.push(req.newClientOrderId)
    return placedOnVenue ? good(venueOrder()) : bad('unknownOid')
  }
  return { bot, rec, order, releaseGuard }
}

describe('cancel during the pre-send guards (spec 192)', () => {
  // Captured when the block runs, not at load: other spec files install their
  // own stub at module load, and restoring the original would undo theirs.
  let previousGetInstance: typeof RedisClient.getInstance
  before(() => {
    previousGetInstance = RedisClient.getInstance
    ;(RedisClient as any).getInstance = async () => hlFakeRedis
  })
  after(() => {
    ;(RedisClient as any).getInstance = previousGetInstance
  })
  beforeEach(() => hlFakeRedis.store.clear())

  it('§5.1 a cancel while a guard is awaited waits, and the fill is booked, not written off', async () => {
    const { bot, rec, order, releaseGuard } = hyperliquidBot()
    const sending = bot.sendOrderToExchange(order)
    await tick()
    expect(rec.open, 'still in the guard').to.deep.equal([])
    expect(bot.orders.get(HL_CLIENT_ID)?.orderId).to.equal('-1')

    const cancelling = bot.cancelOrderOnExchange(order)
    await tick()
    releaseGuard()
    await Promise.all([sending, cancelling])

    expect(rec.open).to.deep.equal([HL_CLIENT_ID])
    expect(
      rec.logs.some((l) => l.includes('is still being placed, waiting')),
      'the cancel waited for the placement',
    ).to.equal(true)
    expect(
      rec.db.filter((d) => d.status === 'CANCELED'),
      'never written off as CANCELED',
    ).to.deep.equal([])
    const last = rec.db[rec.db.length - 1]
    expect(last.status, 'final row').to.equal('FILLED')
    expect(last.orderId).to.equal(HL_VENUE_ID)
    expect(
      rec.errorLogs.filter((e) => e.includes('written off as CANCELED')),
    ).to.deep.equal([])
    expect(bot.placementsInFlight?.size ?? 0).to.equal(0)
  })

  it('§5.2 a guard that short-circuits the send still releases a waiting cancel', async () => {
    const { bot, rec, order, releaseGuard } = hyperliquidBot()
    hlFakeRedis.store.set(
      'nb:cd:bot:nb',
      JSON.stringify({
        until: Date.now() + 60_000,
        reason: 'Not enough balance',
        interval: 300_000,
        attempt: 1,
      }),
    )
    // The venue never saw it, and says so for good (skips the ladder's waits).
    bot.exchange.getOrder = async () => ({
      status: StatusEnum.notok,
      reason: 'Order does not exist',
      data: null,
    })
    const sending = bot.sendOrderToExchange(order)
    await tick()
    const cancelling = bot.cancelOrderOnExchange(order)
    await tick()
    releaseGuard()
    await Promise.all([sending, cancelling])
    expect(rec.open, 'never sent').to.deep.equal([])
    expect(
      rec.logs.some((l) => l.includes('is still being placed, waiting')),
    ).to.equal(true)
    expect(bot.placementsInFlight?.size ?? 0).to.equal(0)
  })

  it('§5.3 a guard that throws leaves no placement in flight', async () => {
    const { bot, order, releaseGuard } = hyperliquidBot('throw')
    const sending = bot.sendOrderToExchange(order)
    await tick()
    releaseGuard()
    let thrown: unknown = null
    await sending.catch((e: unknown) => (thrown = e))
    expect((thrown as Error)?.message).to.equal('balance fetch failed')
    expect(bot.placementsInFlight?.size ?? 0).to.equal(0)
  })
})
