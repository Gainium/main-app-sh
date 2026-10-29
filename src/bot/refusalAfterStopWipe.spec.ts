process.env.NODE_ENV = 'testing'

/**
 * Spec 206 — a refused order must not be left at `NEW`/`'-1'` when the bot
 * stops while the order is being placed.
 *
 * `stop()` -> `clearClassProperties` replaces `this.orders` with an empty map.
 * The refusal branch of `sendOrderToExchange` gated its whole write-off on that
 * map being non-empty, so a refusal answered after the stop retired nothing and
 * the write-ahead row stayed open.
 *
 * Harness copied from `strandedLocalRefusal.spec.ts` (spec 013).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import ComplianceGuard from './complianceGuard'
import { MathHelper } from '../utils/math'

const CLIENT_ID = '0xb444a369a2f41c40b9af205462d1f21b'
const COMPLIANCE_REASON =
  'EAccount:Invalid permissions:USDT trading restricted for DE.'

type Row = Record<string, any>

/**
 * A stand-in for the `orders` DAO backed by a Map, so the REAL
 * `saveOrderToDb` / `updateOrderOnDb` / `deleteOrderFromDb` run against it and
 * the assertions are about persisted STATE, not about which method was called.
 */
const makeOrdersDb = () => {
  const rows = new Map<string, Row>()
  const matches = (row: Row, filter: Row): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === '$and') {
        if (!(v as Row[]).every((sub) => matches(row, sub))) return false
        continue
      }
      if (v && typeof v === 'object' && '$ne' in v) {
        if (row[k] === (v as Row).$ne) return false
        continue
      }
      if (row[k] !== v) return false
    }
    return true
  }
  return {
    rows,
    createData: async (doc: Row) => {
      rows.set(doc.clientOrderId, { ...doc })
      return { status: StatusEnum.ok, reason: null, data: { result: doc } }
    },
    updateData: async (filter: Row, update: Row) => {
      const { $unset, ...set } = update
      for (const [key, row] of rows) {
        if (!matches(row, filter)) continue
        const next = { ...row, ...set }
        for (const k of Object.keys($unset ?? {})) delete next[k]
        rows.set(key, next)
      }
      return { status: StatusEnum.ok, reason: null, data: { result: null } }
    },
    deleteManyData: async (filter: Row) => {
      let deleted = 0
      for (const [key, row] of [...rows]) {
        if (!matches(row, filter)) continue
        rows.delete(key)
        deleted++
      }
      return {
        status: StatusEnum.ok,
        reason: `Deleted: ${deleted} records`,
        data: null,
      }
    },
  }
}

const makeOrder = () => ({
  clientOrderId: CLIENT_ID,
  symbol: 'BTC-USDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '416.70833334',
  price: '1.2',
  origPrice: '1.2',
  exchange: ExchangeEnum.kraken,
  typeOrder: 'stop',
  dealId: undefined,
  reduceOnly: false,
  positionSide: undefined,
})

/**
 * Drive the real `sendOrderToExchange` off the prototype — importing the module
 * opens no connections and instance properties shadow prototype methods, so no
 * Mongo, Redis, venue or bot stack is needed.
 */
const makeBot = (openOrder: () => Promise<any>) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []

  Object.assign(bot, {
    botId: '6a212785ce236bfdf885bada',
    userId: '69cf3bb41004d803c3d84ae7',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    ordersDb,
    venueCalls,
    data: {
      exchange: ExchangeEnum.kraken,
      // Empty on purpose: `AuthFailureGuard.check` is skipped, so the auth
      // short-circuit cannot fire and the compliance one is isolated.
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
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
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    // --- collaborators stubbed to no-ops; none of them is under test ---
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => true,
    isErrorNotEnoughBalance: () => false,
    getErrorSubType: () => null,
    getNotEnoughOrdersIdByOrder: () => 'BTC-USDT-BUY',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 2,
      baseAsset: { maxMarketAmount: 1e12, precision: 8 },
      quoteAsset: { minAmount: 1, precision: 2 },
    }),
  })

  // Prototype getters cannot be shadowed by plain assignment.
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

const notRestricted = async () => ({
  restricted: false,
  reason: null,
  until: null,
})

/** What `stop()` does to the map while the placement is in flight. */
const stopWipes = (bot: any) => {
  bot.orders = new Map()
}

const originalCheck = ComplianceGuard.check

describe('spec 206 — a refusal answered after stop() still retires the row', () => {
  afterEach(() => {
    ComplianceGuard.check = originalCheck
  })

  it('§4.1 retires a definitive venue refusal as CANCELED', async () => {
    ComplianceGuard.check = notRestricted as any
    let bot: any
    bot = makeBot(async () => {
      stopWipes(bot)
      return {
        status: StatusEnum.notok,
        reason: 'Insufficient spot balance asset=SOL',
        data: null,
      }
    })

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.venueCalls).to.have.length(1)
    const row = bot.ordersDb.rows.get(CLIENT_ID)
    expect(row, 'a venue-refused order keeps its row').to.not.equal(undefined)
    expect(row.status, 'and it is no longer open').to.equal('CANCELED')
  })

  it('§4.2 deletes the row of a local-guard refusal', async () => {
    let bot: any
    ComplianceGuard.check = (async () => {
      stopWipes(bot)
      return {
        restricted: true,
        reason: COMPLIANCE_REASON,
        until: Date.now() + 60_000,
      }
    }) as any
    bot = makeBot(async () => {
      throw new Error('the venue must not be called on a short-circuit')
    })

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.venueCalls).to.have.length(0)
    expect(bot.ordersDb.rows.get(CLIENT_ID)).to.equal(undefined)
  })

  it('§4.3 leaves an ambiguous failure for the reconcile, as before', async () => {
    ComplianceGuard.check = notRestricted as any
    let bot: any
    bot = makeBot(async () => {
      stopWipes(bot)
      return { status: StatusEnum.notok, reason: 'socket hang up', data: null }
    })

    await bot.sendOrderToExchange(makeOrder())

    const row = bot.ordersDb.rows.get(CLIENT_ID)
    expect(row, 'the venue may hold it, so it is not written off').to.not.equal(
      undefined,
    )
    expect(row.status).to.equal('NEW')
  })
})
