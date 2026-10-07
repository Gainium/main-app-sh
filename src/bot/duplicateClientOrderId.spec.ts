process.env.NODE_ENV = 'testing'

/**
 * When the venue answers "client order ID already exists" it is saying it HAS
 * an order under that id. `sendOrderToExchange` used to write that order off
 * (CANCELED, unregistered from the stream router) and send a copy under a
 * regenerated `…2` id, which left the original live on the venue and untracked.
 * It must ask the venue first, keep the order when the venue has it, and only
 * regenerate when the venue definitively does not.
 *
 * Enforces specs/136 §4.1, §4.2 and §4.3. Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

const CLIENT_ID = '4b1c2ba2186cBCDEDROiuPKvqcThkSfS'
const REGENERATED = '4b1c2ba2186cBCDEDROiuPKvqcThkSf2'
const DUPLICATE = 'Client order ID already exists.'

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

/**
 * Drive the real `sendOrderToExchange` off the prototype — importing the module
 * opens no connections and instance properties shadow prototype methods, so no
 * Mongo, Redis, venue or bot stack is needed.
 */
const makeBot = (
  openOrder: (req: any) => Promise<any>,
  getOrder: (req: any) => Promise<any>,
) => {
  const ordersDb = makeOrdersDb()
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const lookups: any[] = []

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
    lookups,
    data: {
      exchange: ExchangeEnum.okx,
      // Empty on purpose: `AuthFailureGuard.check` is skipped.
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return openOrder(req)
      },
      getOrder: async (req: any) => {
        lookups.push(req)
        return getOrder(req)
      },
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
    isComplianceGateable: () => false,
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

const makeOrder = () => ({
  clientOrderId: CLIENT_ID,
  symbol: 'ETH-USDC',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '0.007109',
  price: '2340',
  origPrice: '2340',
  exchange: ExchangeEnum.okx,
  typeOrder: 'regular',
  dealId: 'deal1',
  reduceOnly: false,
  positionSide: undefined,
})

const refused = (reason: string) => async () => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

describe('a venue "client order ID already exists" is resolved before any write-off (spec 136)', () => {
  it('§4.1 keeps the order when the venue has it, and sends no copy', async () => {
    const bot = makeBot(refused(DUPLICATE), async (req: any) => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        clientOrderId: req.newClientOrderId,
        orderId: '3000000001',
        status: 'NEW',
        updateTime: Date.now(),
      },
    }))

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.venueCalls.map((c: any) => c.newClientOrderId)).to.deep.equal([
      CLIENT_ID,
    ])
    expect(bot.lookups[0]?.newClientOrderId).to.equal(CLIENT_ID)
    expect(bot.orders.has(CLIENT_ID), 'still tracked').to.equal(true)
    expect(bot.ordersDb.rows.get(CLIENT_ID)?.status).to.not.equal('CANCELED')
  })

  it('§4.2 regenerates the id only when the venue definitively has no such order', async () => {
    const bot = makeBot(
      async (req: any) =>
        req.newClientOrderId === CLIENT_ID
          ? refused(DUPLICATE)()
          : {
              status: StatusEnum.ok,
              reason: null,
              data: { ...makeOrder(), clientOrderId: req.newClientOrderId },
            },
      refused('Order not found'),
    )

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.venueCalls.map((c: any) => c.newClientOrderId)).to.deep.equal([
      CLIENT_ID,
      REGENERATED,
    ])
    expect(bot.ordersDb.rows.get(CLIENT_ID)?.status).to.equal('CANCELED')
  })

  it('§4.3 an invalid-id refusal is not a statement that the order exists — regenerate at once', async () => {
    const bot = makeBot(
      async (req: any) =>
        req.newClientOrderId === CLIENT_ID
          ? refused('Client order id is not valid')()
          : {
              status: StatusEnum.ok,
              reason: null,
              data: { ...makeOrder(), clientOrderId: req.newClientOrderId },
            },
      async () => {
        throw new Error('must not ask the venue')
      },
    )

    await bot.sendOrderToExchange(makeOrder())

    expect(bot.lookups).to.have.length(0)
    expect(bot.venueCalls.map((c: any) => c.newClientOrderId)).to.deep.equal([
      CLIENT_ID,
      REGENERATED,
    ])
  })
})
