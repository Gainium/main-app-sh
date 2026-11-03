process.env.NODE_ENV = 'testing'

/**
 * A safety order the venue refused is written off as CANCELED and dropped
 * from the bot's map. When its level is placed again it must go out under a
 * fresh client order id: re-sent under the written-off id, the venue (which
 * never accepted it) takes it, but its row stays CANCELED, so the order is
 * lost on the next reload and its level is placed a second time.
 *
 * Production shape (Coinbase spot long DCA): three safety orders refused for
 * balance and written off; a deal restart re-sent all three under the same
 * ids; they rested on the venue while their rows read CANCELED.
 *
 * Part 1 drives the REAL `sendOrderToExchange` off the MainBot prototype
 * (harness shape from `restartDealBalanceCooldown.spec.ts`). Part 2 drives the
 * REAL `placeOrdersHoldingDealLock` off the DCA helper over a fake base
 * (harness shape from `spentLevelIdPlacement.harness.spec.ts`), reading the
 * write-off through the real MainBot methods. Fixture ids are synthetic.
 *
 * Enforces specs/221 §4.1–§4.3. Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotMarginTypeEnum,
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'
import MainBot from '../main'
import RedisClient from '../../db/redis'
import { MathHelper } from '../../utils/math'

const BOT_ID = '000000000000000000000b21'
const DEAL_ID = '000000000000000000000d21'
const SYMBOL = 'SQD-USDC'
const KEY = `${SYMBOL}@BUY`
const COOLDOWN_KEY = `nb:cd:${BOT_ID}:${KEY}`
const REFUSED_ID = 'D-RO-writtenoff0000000000000000QOA'

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

const makeOrder = (clientOrderId: string) => ({
  clientOrderId,
  symbol: SYMBOL,
  baseAsset: 'SQD',
  quoteAsset: 'USDC',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '4510.4',
  price: '0.017608',
  origPrice: '0.017608',
  exchange: ExchangeEnum.binance,
  typeOrder: TypeOrderEnum.dealRegular,
  dealId: DEAL_ID,
  botId: BOT_ID,
  reduceOnly: false,
})

const refused = async () => ({
  status: StatusEnum.notok,
  reason: 'Insufficient balance in source account',
  data: null,
})

/** A real MainBot off the prototype; the venue answers with `openOrder`. */
const makeMainBot = (
  openOrder: () => Promise<any>,
  opts: { guardArmed?: boolean; free?: number } = {},
) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const dbUpdates: any[] = []
  Object.assign(bot, {
    botId: BOT_ID,
    userId: '000000000000000000000a21',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    dbUpdates,
    notEnoughBalanceThreshold: 10,
    notEnoughBalanceLogPrefix: 'NOB |',
    data: {
      exchange: ExchangeEnum.binance,
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: opts.guardArmed
        ? {
            keyVersion: 2,
            thresholdPassed: true,
            thresholdPassedTime: Date.now() - 60_000,
            orders: { [KEY]: 11 },
            refusedRequired: { [KEY]: 70 },
            refusedRequiredMax: { [KEY]: 79 },
          }
        : { orders: {} },
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return openOrder()
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
    ordersDb: {
      createData: async () => ({ status: StatusEnum.ok }),
      updateData: async (filter: any, update: any) => {
        dbUpdates.push({ filter, update })
        return { status: StatusEnum.ok }
      },
      deleteManyData: async () => ({ status: StatusEnum.ok }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
    updateData: () => undefined,
    updateNotEnoughBalanceErrors: async () => undefined,
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    getErrorSubType: () => null,
    getAssetBalanceAndRequiredByOrder: async () => ({
      asset: 'USDC',
      balance: { free: opts.free ?? 24.86, locked: 0 },
      required: 79.42,
    }),
    spendableForNotEnoughBalance: async (_a: string, free: number) => free,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 6,
      baseAsset: { maxMarketAmount: 1e12, precision: 1 },
      quoteAsset: { minAmount: 1, precision: 2 },
    }),
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

// ---------------------------------------------------------------- part 2 ---

const level = (newClientOrderId = REFUSED_ID) => ({
  number: 1,
  price: 0.017608,
  qty: 4510.4,
  side: OrderSideEnum.buy,
  newClientOrderId,
  type: TypeOrderEnum.dealRegular,
  dealId: DEAL_ID,
})

const row = (clientOrderId: string, status: string, over: object = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    type: 'LIMIT',
    side: 'BUY',
    price: '0.017608',
    origPrice: '0.017608',
    origQty: '4510.4',
    executedQty: status === 'FILLED' ? '4510.4' : '0',
    status,
    ...over,
  }) as any

class FakeBase {
  botId = BOT_ID
  botType = 'dca'
  hyperliquid = false
  data: any = {
    status: BotStatusEnum.open,
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.coinbase,
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/** The DCA placement loop, holding no row for `REFUSED_ID`. */
const buildDcaBot = (writtenOff: string[]) => {
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL },
      settings: {},
      tpSlTargetFilled: [],
    },
    closeBySl: false,
    closeByTp: false,
  }
  let minted = 0
  class TestBot extends Helper {
    placed: string[] = []
    logs: string[] = []
    exchange: any = {}
    orders = new Map<string, any>(
      [
        row('D-BO-base000000000000000000000021', 'FILLED', {
          typeOrder: TypeOrderEnum.dealStart,
        }),
      ].map((o) => [o.clientOrderId, o]),
    )
    reissuedClientOrderIds = new Map<string, string>()
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    ordersInBetweenUpdates = new Set<string>()
    futures = false
    hedge = false
    isLong = true
    combo = false
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId(q: {
      status?: string | string[]
      defaultStatuses?: boolean
    }) {
      const want = q.defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : Array.isArray(q.status)
          ? q.status
          : [q.status]
      return [...this.orders.values()].filter((o) => want.includes(o.status))
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getOrderId(prefix: string) {
      minted++
      return `${prefix}-minted${String(minted).padStart(24, '0')}`
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        baseAsset: { name: 'SQD', minAmount: 0.1, step: 0.1 },
        quoteAsset: { name: 'USDC', minAmount: 1 },
        priceAssetPrecision: 6,
      }
    }
    async getAggregatedSettings() {
      return {}
    }
    batchablePlacements() {
      return []
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    /** Coinbase: an id it never accepted is accepted now. */
    async sendGridToExchange(order: any) {
      this.placed.push(order.newClientOrderId)
      const placed = row(order.newClientOrderId, 'NEW')
      this.orders.set(order.newClientOrderId, placed)
      return placed
    }
    processFilledOrder() {}
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange() {}
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug(m: string) {
      this.logs.push(m)
    }
    handleWarn(m: string) {
      this.logs.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  // The write-off record is MainBot's; read it through MainBot's own code.
  const proto: any = MainBot.prototype
  bot.noteWrittenOffClientOrderId = proto.noteWrittenOffClientOrderId
  bot.isWrittenOffClientOrderId = proto.isWrittenOffClientOrderId
  for (const id of writtenOff) {
    bot.noteWrittenOffClientOrderId?.(id)
  }
  return bot
}

const originalGetInstance = RedisClient.getInstance

describe('a safety order refused by the venue is re-sent under a fresh id (spec 221)', () => {
  before(function () {
    this.timeout(180000)
    ;(RedisClient as any).getInstance = async () => fakeRedis
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })
  after(() => {
    ;(RedisClient as any).getInstance = originalGetInstance
  })

  it('§4.1 the venue-refusal write-off records the client order id as written off', async () => {
    store.clear()
    const bot = makeMainBot(refused)
    await bot.sendOrderToExchange(makeOrder(REFUSED_ID))
    expect(bot.venueCalls, 'the venue was asked').to.have.length(1)
    expect(
      bot.dbUpdates.some(
        (u: any) =>
          u.filter.clientOrderId === REFUSED_ID &&
          u.update.status === 'CANCELED',
      ),
      'the row is written off CANCELED',
    ).to.equal(true)
    expect(bot.getOrderFromMap(REFUSED_ID), 'dropped from the map').to.equal(
      undefined,
    )
    expect(bot.isWrittenOffClientOrderId?.(REFUSED_ID)).to.equal(true)
  })

  it('§4.3 an order refused by the local cooldown is not recorded as written off', async () => {
    store.clear()
    store.set(
      COOLDOWN_KEY,
      JSON.stringify({
        until: Date.now() + 60 * 60 * 1000,
        reason: 'Insufficient balance in source account',
        interval: 60 * 60 * 1000,
        attempt: 4,
      }),
    )
    const bot = makeMainBot(refused, { guardArmed: true })
    const id = 'D-RO-writtenoff0000000000000000LOC'
    await bot.sendOrderToExchange(makeOrder(id))
    expect(bot.venueCalls, 'served by the cooldown').to.have.length(0)
    expect(!!bot.isWrittenOffClientOrderId?.(id)).to.equal(false)
  })

  it('§4.2 a level carrying a written-off id is placed once, under a fresh id the level keeps', async () => {
    const bot = buildDcaBot([REFUSED_ID])
    const grid = level()
    await bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, {
      new: [grid],
      cancel: [],
    })
    expect(bot.placed, bot.logs.join('\n')).to.have.length(1)
    expect(bot.placed[0], 'not the written-off id').to.not.equal(REFUSED_ID)
    expect(grid.newClientOrderId).to.equal(bot.placed[0])
    // A second pass with the level as it is now places nothing more.
    await bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, {
      new: [grid],
      cancel: [],
    })
    expect(bot.placed, bot.logs.join('\n')).to.have.length(1)
  })

  it('§1.2 a level never sent keeps its own id', async () => {
    const bot = buildDcaBot([])
    await bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, {
      new: [level()],
      cancel: [],
    })
    expect(bot.placed).to.deep.equal([REFUSED_ID])
  })
})
