process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `108.a-cold-restart-re-places-orders-missing-from-the-redis-snapshot`.
 *
 * Drives the REAL `_loadOrders` (cold-restart branch) and, through a DCA bot
 * built on the real mixin, the REAL restart branch of `checkOrders`. Redis and
 * Mongo are stubs that record their reads; `placeOrders` is recorded, not run.
 * Harness shape from `dcaReloadLadderDuplicate.spec.ts` (spec 106).
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { OrderSideEnum, StatusEnum, TypeOrderEnum } from '../../types'

const DEAL_ID = '000000000000000000000d08'
const BOT_ID = '000000000000000000000b08'
const SYMBOL = 'ELA-USDC'

const order = (
  clientOrderId: string,
  typeOrder: TypeOrderEnum,
  side: 'BUY' | 'SELL',
  price: string,
  qty: string,
  status = 'NEW',
) =>
  ({
    _id: `id-${clientOrderId}`,
    symbol: SYMBOL,
    clientOrderId,
    orderId: clientOrderId,
    botId: BOT_ID,
    dealId: DEAL_ID,
    typeOrder,
    side,
    price,
    origPrice: price,
    origQty: qty,
    executedQty: status === 'FILLED' ? qty : '0',
    status,
    updateTime: 1790306351728,
  }) as any

const BASE = order(
  'D-BO-000000000001',
  TypeOrderEnum.dealStart,
  'BUY',
  '0.339',
  '102.35',
  'FILLED',
)
const SO_OLD = order(
  'D-RO-000000000002',
  TypeOrderEnum.dealRegular,
  'BUY',
  '0.315',
  '120.1',
)
/** Placed seconds before the process stopped: in Mongo, not in Redis. */
const SO_NEW = order(
  'D-RO-000000000003',
  TypeOrderEnum.dealRegular,
  'BUY',
  '0.323',
  '92.53',
)
const TP_NEW = order(
  'D-TP-000000000004',
  TypeOrderEnum.dealTP,
  'SELL',
  '0.367',
  '488.81',
)

/** The snapshot as the last delayed write left it. */
const SNAPSHOT = [BASE, SO_OLD]
/** Mongo's open rows for the deal. */
const DB_OPEN = [SO_OLD, SO_NEW, TP_NEW]

const OPEN = ['NEW', 'PARTIALLY_FILLED']

/** Minimal Mongo `find` over a row set: botId, dealId $in, status $in. */
const matches = (row: any, q: any): boolean => {
  if (q.$and) return q.$and.every((s: any) => matches(row, s))
  if (q.$or) return q.$or.some((s: any) => matches(row, s))
  if (q.botId && row.botId !== q.botId) return false
  if (q.dealId?.$in && !q.dealId.$in.includes(row.dealId)) return false
  if (q.status?.$in && !q.status.$in.includes(row.status)) return false
  if (q.status?.$nin && q.status.$nin.includes(row.status)) return false
  if (q.typeOrder?.$nin && q.typeOrder.$nin.includes(row.typeOrder))
    return false
  return true
}

const stubSources = (
  bot: any,
  snapshot: any[] | null,
  dbRows: any[],
  dbFails = false,
) => {
  bot.redisReads = [] as string[]
  bot.dbQueries = [] as any[]
  bot.logs = [] as string[]
  bot.getFromRedis = async (key: string) => {
    bot.redisReads.push(key)
    return key === 'orders' && snapshot
      ? JSON.parse(JSON.stringify(snapshot))
      : null
  }
  bot.ordersDb = {
    readData: async (q: any) => {
      bot.dbQueries.push(q)
      if (dbFails) {
        return { status: StatusEnum.notok, reason: 'db down', data: null }
      }
      const result = dbRows.filter((r) => matches(r, q)).map((r) => ({ ...r }))
      return { status: StatusEnum.ok, data: { result, count: result.length } }
    },
  }
}

const makeMainBot = (opts: {
  secondRestart?: boolean
  snapshot: any[] | null
  dbRows: any[]
  dbFails?: boolean
}) => {
  const bot: any = Object.create(MainBot.prototype)
  bot.botId = BOT_ID
  bot.serviceRestart = true
  bot.secondRestart = !!opts.secondRestart
  bot.errors = [] as string[]
  bot.startMethod = () => 'm'
  bot.endMethod = () => undefined
  bot.handleErrors = (e: string) => {
    bot.errors.push(String(e))
  }
  stubSources(bot, opts.snapshot, opts.dbRows, opts.dbFails)
  bot.handleLog = (m: string) => bot.logs.push(m)
  bot.handleWarn = (m: string) => bot.logs.push(m)
  return bot
}

const ids = (rows: any[]) => rows.map((r) => r.clientOrderId).sort()

describe('cold restart order snapshot (spec 108)', () => {
  describe('_loadOrders', () => {
    it('§1.1.1 merges an open Mongo order the snapshot lacks', async () => {
      const bot = makeMainBot({ snapshot: SNAPSHOT, dbRows: DB_OPEN })
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      expect(ids(loaded)).to.deep.equal(ids([BASE, SO_OLD, SO_NEW, TP_NEW]))
      expect(bot.redisReads).to.deep.equal(['orders'])
    })

    it('§1.1.4 reads only open rows of the restored deals, by dealId', async () => {
      const bot = makeMainBot({ snapshot: SNAPSHOT, dbRows: DB_OPEN })
      await bot._loadOrders(undefined, false, [DEAL_ID])
      expect(bot.dbQueries).to.have.length(1)
      const q = bot.dbQueries[0]
      expect(q.botId).to.equal(BOT_ID)
      expect(q.dealId).to.deep.equal({ $in: [DEAL_ID] })
      expect(q.status).to.deep.equal({ $in: OPEN })
    })

    it('§1.1.4 takes deal ids from the snapshot when the caller passes none', async () => {
      const bot = makeMainBot({ snapshot: SNAPSHOT, dbRows: DB_OPEN })
      const loaded = await bot._loadOrders()
      expect(bot.dbQueries[0].dealId).to.deep.equal({ $in: [DEAL_ID] })
      expect(ids(loaded)).to.include(SO_NEW.clientOrderId)
    })

    it('§1.1.3 a Mongo PARTIALLY_FILLED row replaces a snapshot NEW row', async () => {
      const pf = { ...SO_OLD, status: 'PARTIALLY_FILLED', executedQty: '10' }
      const bot = makeMainBot({ snapshot: SNAPSHOT, dbRows: [pf] })
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      const row = loaded.find((o: any) => o.clientOrderId === pf.clientOrderId)
      expect(row.status).to.equal('PARTIALLY_FILLED')
      expect(row.executedQty).to.equal('10')
      expect(loaded).to.have.length(SNAPSHOT.length)
    })

    it('§1.1.3 a Mongo open row never moves a terminal snapshot row back', async () => {
      const filled = { ...SO_OLD, status: 'FILLED', executedQty: '120.1' }
      const bot = makeMainBot({
        snapshot: [BASE, filled],
        dbRows: [SO_OLD],
      })
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      const row = loaded.find(
        (o: any) => o.clientOrderId === SO_OLD.clientOrderId,
      )
      expect(row.status).to.equal('FILLED')
    })

    it('§1.1.5 falls back to the snapshot when the Mongo read fails', async () => {
      const bot = makeMainBot({
        snapshot: SNAPSHOT,
        dbRows: DB_OPEN,
        dbFails: true,
      })
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      expect(ids(loaded)).to.deep.equal(ids(SNAPSHOT))
      expect(bot.logs.join('\n')).to.contain('db down')
    })

    it('§1.1.6 a reload reads Mongo only and never the snapshot', async () => {
      const bot = makeMainBot({
        secondRestart: true,
        snapshot: SNAPSHOT,
        dbRows: DB_OPEN,
      })
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      expect(bot.redisReads).to.deep.equal([])
      expect(bot.dbQueries).to.have.length(1)
      expect(ids(loaded)).to.deep.equal(ids(DB_OPEN))
    })
  })

  describe('checkOrders after a cold restart', () => {
    let Helper: any

    before(function () {
      // One ts-node compile of the DCA mixin and everything under it.
      this.timeout(240000)
      Helper = createRequire(__filename)('./dcaHelper').default()
    })

    const grid = (
      o: any,
      type: TypeOrderEnum,
      side: OrderSideEnum,
      n: number,
    ) =>
      ({
        number: n,
        price: +o.price,
        qty: +o.origQty,
        side,
        newClientOrderId: `new-${o.clientOrderId}`,
        type,
        dealId: DEAL_ID,
      }) as any

    /** The deal's rebuilt orders: two safety levels and the take-profit. */
    const LADDER = [
      grid(SO_NEW, TypeOrderEnum.dealRegular, OrderSideEnum.buy, 0),
      grid(SO_OLD, TypeOrderEnum.dealRegular, OrderSideEnum.buy, 1),
      grid(TP_NEW, TypeOrderEnum.dealTP, OrderSideEnum.sell, 2),
    ]

    const buildBot = () => {
      const placed: any[] = []
      const deal = {
        deal: {
          _id: DEAL_ID,
          botId: BOT_ID,
          status: 'open',
          symbol: { symbol: SYMBOL, baseAsset: 'ELA', quoteAsset: 'USDC' },
          settings: {},
          lastPrice: 0.331,
          levels: { all: 4, complete: 1 },
        },
        initialOrders: LADDER,
        currentOrders: LADDER,
        previousOrders: [],
      }
      class TestBot extends (Helper as any) {
        placed = placed
        botId = BOT_ID
        loadingComplete = true
        serviceRestart = true
        secondRestart = false
        blockCheck = false
        data: any = {
          settings: { name: 'bot', pair: [SYMBOL] },
          status: 'open',
          exchange: 'coinbase',
          flags: [],
          paperContext: false,
        }
        orders = new Map<string, any>()
        shouldProceed() {
          return true
        }
        getDeal(id?: string) {
          return id === DEAL_ID ? deal : undefined
        }
        get allOrders() {
          return [...this.orders.values()]
        }
        async getAggregatedSettings() {
          return {}
        }
        async isDealForTPLevelCheck() {
          return false
        }
        isOrderQuarantined() {
          return false
        }
        clearOrderStrikes() {}
        async getOrderForReconcile(o: any) {
          return { status: StatusEnum.ok, data: { ...o } }
        }
        async mergeCommonOrderWithOrder(_d: any, o: any) {
          return o
        }
        async placeOrders(_b: string, _s: string, _d: string, orders: any) {
          placed.push(...orders.new)
        }
        async cancelOrderOnExchange() {}
        handleDebug() {}
        handleErrors() {}
        startMethod() {
          return '1'
        }
        endMethod() {}
      }
      const bot: any = new (TestBot as any)()
      stubSources(bot, SNAPSHOT, DB_OPEN)
      bot.handleLog = () => undefined
      bot.handleWarn = () => undefined
      return bot
    }

    it('§1.1.2 places neither the safety order nor the take-profit Mongo already holds', async () => {
      const bot = buildBot()
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      for (const o of loaded) bot.orders.set(o.clientOrderId, o)
      await bot.checkOrders(BOT_ID)
      expect(
        bot.placed.map((g: any) => `${g.type}@${g.price}`),
        'nothing placed on top of an order Mongo holds',
      ).to.deep.equal([])
    })

    it('§1.1.7 a level with no order anywhere is still placed', async () => {
      const bot = buildBot()
      // The safety order at 0.323 never reached Mongo either: it is missing.
      bot.ordersDb = {
        readData: async (q: any) => {
          const result = [SO_OLD, TP_NEW].filter((r) => matches(r, q))
          return {
            status: StatusEnum.ok,
            data: { result, count: result.length },
          }
        },
      }
      const loaded = await bot._loadOrders(undefined, false, [DEAL_ID])
      for (const o of loaded) bot.orders.set(o.clientOrderId, o)
      await bot.checkOrders(BOT_ID)
      expect(bot.placed.map((g: any) => `${g.type}@${g.price}`)).to.deep.equal([
        `${TypeOrderEnum.dealRegular}@0.323`,
      ])
    })
  })
})
