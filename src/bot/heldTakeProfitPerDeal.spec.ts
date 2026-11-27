process.env.NODE_ENV = 'testing'

/**
 * A take profit held out of the venue's price band (specs 264/283) is a
 * notice, never a bot error.
 *
 * (a) Every held deal gets its own notice. `processError` coalesces by bot and
 *     subType, so seven deals held in one pass became one row that named only
 *     the first deal and pair and carried a count.
 * (b) The DCA engine's take-profit branches send with `returnError` and report
 *     a returned string through `handleOrderErrors`. The hold's own string came
 *     back that way and put the bot in error under an unknown subType on every
 *     placement pass, a worker start included.
 *
 * Drives the REAL `sendOrderToExchange` gate, `noticeHeldOutOfBand`,
 * `postUserNotice`, `handleOrderErrors` and `handleErrors` over a Map-backed
 * fake Redis. Synthetic ids.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotStatusEnum,
  ExchangeEnum,
  MessageTypeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import RedisClient from '../db/redis'
import { MathHelper } from '../utils/math'
import { positionLeftOpen } from './utils'
import {
  VenuePriceBand,
  heldOutOfBandReason,
  isHeldOutOfBandReason,
} from './outOfBandRetry'

const store = new Map<string, string>()
const fakeRedis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v)
  },
  del: async (k: string) => {
    store.delete(k)
  },
}
const settleAll = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

type Row = Record<string, any>
let seq = 0
const tp = (symbol: string, dealId: string, price: number): Row => ({
  clientOrderId: `x-TP-${seq++}`,
  symbol,
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '10',
  price: `${price}`,
  origPrice: `${price}`,
  exchange: ExchangeEnum.binance,
  typeOrder: TypeOrderEnum.dealTP,
  dealId,
})

/** A Binance band already learned for each pair, as after the first refusal. */
const learnBand = (symbol: string) =>
  store.set(`outOfBandBand:binance:${symbol}:SELL`, '0.2')

const build = (DCA: any, market: { price: number }) => {
  const bot: any = Object.create(DCA.prototype)
  const venueCalls: any[] = []
  const rows: Row[] = []
  const processErrors: any[][] = []
  const statusWrites: any[] = []
  Object.assign(bot, {
    botId: 'bot-held-1',
    userId: 'user-1',
    botType: 'dca',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    rows,
    processErrors,
    statusWrites,
    lastLogs: [],
    ordersDb: {
      readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
      createData: async (d: Row) => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: d },
      }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
      deleteManyData: async () => ({ status: StatusEnum.ok, data: null }),
    },
    messagesDb: {
      createData: async (d: Row) => {
        rows.push(d)
        return { status: StatusEnum.ok, data: { ...d, _id: `m${rows.length}` } }
      },
    },
    data: {
      exchange: ExchangeEnum.binance,
      exchangeUUID: '',
      status: BotStatusEnum.open,
      paperContext: false,
      settings: { futures: false, name: 'held' },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return { status: StatusEnum.notok, reason: 'unexpected', data: null }
      },
      getOrder: async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found',
        data: null,
      }),
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    pushLogs: () => undefined,
    // the bot-error path: recorded, so an error would show here
    processError: async (...a: any[]) => {
      processErrors.push(a)
    },
    setRangeOrError: (...a: any[]) => {
      statusWrites.push(a)
    },
    updateData: (u: any) => {
      statusWrites.push(u)
    },
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => 'k',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 4,
      baseAsset: { maxMarketAmount: 1e12, precision: 3, step: 0.001 },
      quoteAsset: { minAmount: 1, precision: 8 },
    }),
    getLatestPrice: async () => market.price,
    replacesVenueCancel: () => false,
    shouldProceed: () => true,
    scheduleHeldOutOfBandPublish: () => undefined,
    publishHeldOutOfBand: () => undefined,
  })
  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: false,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 1,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

/** What placeOrders' zeroed-fee and adaptive-close TP branches do with a send. */
const placeTp = async (bot: any, order: Row) => {
  const result = await bot.sendOrderToExchange({ ...order }, true)
  if (typeof result === 'string') {
    await bot.handleOrderErrors(
      result,
      order,
      'placeOrders()',
      `Send new order request ${order.clientOrderId}`,
    )
  }
  return result
}

describe('held take profits are per-deal notices, never bot errors', () => {
  let DCA: any
  before(function () {
    this.timeout(180000)
    DCA = createRequire(__filename)('./dcaHelper').default(MainBot)
  })
  beforeEach(() => {
    store.clear()
    VenuePriceBand.resetCache()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  it('the hold marker is made only by the hold, not by text that looks like it', () => {
    const r = heldOutOfBandReason('SELL', 0.966, 0.1809, 0.2, 'binance')
    expect(isHeldOutOfBandReason(r)).to.equal(true)
    expect(
      isHeldOutOfBandReason(
        'Held: SELL 1 is more than 20% from the price 2, which venue refuses',
      ),
    ).to.equal(false)
    expect(isHeldOutOfBandReason(undefined)).to.equal(false)
  })

  it('(a) 7 deals on 7 pairs held in one pass: 7 notices, each naming its own deal and pair', async () => {
    const pairs = ['RSRUSDT', 'ACEUSDT', 'BEBUSDT', 'METUSDT', 'OGNUSDT', 'XAIUSDT', 'DYMUSDT']
    pairs.forEach(learnBand)
    const bot = build(DCA, { price: 1 })
    for (const [i, p] of pairs.entries()) {
      await placeTp(bot, tp(p, `deal-${i}`, 5))
    }
    await settleAll()
    expect(bot.venueCalls).to.have.length(0)
    expect(bot.rows).to.have.length(7)
    for (const [i, p] of pairs.entries()) {
      const row = bot.rows.find((r: Row) => r.message.includes(`Deal deal-${i} `))
      expect(row, `deal-${i}`).to.not.equal(undefined)
      expect(row.symbol).to.equal(p)
      expect(row.message).to.contain(p)
      expect(row.subType).to.equal(positionLeftOpen)
      expect(row.type).to.equal(MessageTypeEnum.warning)
      expect(row.showUser).to.equal(true)
      expect(row.bucket).to.equal(undefined)
    }
    expect(bot.processErrors).to.have.length(0)
    expect(bot.statusWrites).to.have.length(0)
  })

  it('(a) 2 deals on the same pair: both named', async () => {
    learnBand('RSRUSDT')
    const bot = build(DCA, { price: 1 })
    await placeTp(bot, tp('RSRUSDT', 'deal-x', 5))
    await placeTp(bot, tp('RSRUSDT', 'deal-y', 6))
    await settleAll()
    expect(bot.rows.map((r: Row) => r.message.match(/^Deal (\S+)/)?.[1])).to
      .have.members(['deal-x', 'deal-y'])
    expect(bot.processErrors).to.have.length(0)
  })

  it('(b) a held take profit on worker start: status unchanged, no error rows, one notice per deal', async () => {
    learnBand('RSRUSDT')
    learnBand('ACEUSDT')
    const orders = [tp('RSRUSDT', 'deal-1', 5), tp('ACEUSDT', 'deal-2', 5)]
    const first = build(DCA, { price: 1 })
    for (const o of orders) {
      const r = await placeTp(first, o)
      expect(isHeldOutOfBandReason(r)).to.equal(true)
    }
    await settleAll()
    // a worker start: fresh memory, same Redis, the placement pass runs again
    VenuePriceBand.resetCache()
    const reloaded = build(DCA, { price: 1 })
    for (let i = 0; i < 3; i++) {
      for (const o of orders) await placeTp(reloaded, o)
    }
    await settleAll()
    for (const b of [first, reloaded]) {
      expect(b.data.status).to.equal(BotStatusEnum.open)
      expect(b.statusWrites).to.have.length(0)
      expect(b.processErrors).to.have.length(0)
      expect(
        b.rows.filter(
          (r: Row) =>
            r.type === MessageTypeEnum.error || r.subType === 'Uncategorized',
        ),
      ).to.have.length(0)
      expect(b.venueCalls).to.have.length(0)
    }
    expect(first.rows).to.have.length(2)
    expect(reloaded.rows).to.have.length(0)
  })

  it('control: a real refusal through the same branch is still reported as an error', async () => {
    const bot = build(DCA, { price: 1 })
    await bot.handleOrderErrors(
      'Filter failure: LOT_SIZE',
      tp('RSRUSDT', 'deal-z', 5),
      'placeOrders()',
      'Send new order request',
    )
    await settleAll()
    expect(bot.processErrors).to.have.length(1)
  })
})
