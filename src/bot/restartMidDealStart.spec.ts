process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `172.a-restart-mid-deal-start-leaves-the-position-without-a-take-profit`.
 *
 * The process stopped after `startDeal` had marked the deal `open` and put its
 * take-profit in the order map (both reached the Redis snapshots), but before
 * the deal's Mongo update and the take-profit's write-ahead row landed. So
 * Mongo says `start` with a FILLED base order, and the venue never saw the
 * take-profit.
 *
 * Part 1 drives the REAL DCA `loadOrders` (cold-restart branch) and the REAL
 * `restoreWork`; harness shape from `coldRestartDealSnapshot.spec.ts` (spec
 * 151). Part 2 drives the REAL restart branch of `checkOrders`; harness shape
 * from `dcaReloadLadderDuplicate.spec.ts` (spec 106). Exchange calls,
 * `startDeal` and `placeOrders` are recorded, not run.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderSideEnum, StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b72'
const DEAL_ID = '000000000000000000000d72'
const SYMBOL = 'BLURUSDT'
const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000

/** The short deal's MARKET entry, FILLED in Mongo and in the snapshot. */
const BASE = {
  _id: 'id-x-BO-000000000072',
  symbol: SYMBOL,
  clientOrderId: 'x-BO-000000000072',
  orderId: '1330000072',
  botId: BOT_ID,
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealStart,
  side: 'SELL',
  price: '0.00974',
  origQty: '1359.9',
  executedQty: '1359.90000000',
  status: 'FILLED',
  updateTime: TEN_MIN_AGO,
} as any

/** The take-profit `startDeal` put in the order map and never sent. */
const phantomTp = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId: 'x-TP-000000000072',
    orderId: '-1',
    botId: BOT_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealTP,
    side: 'BUY',
    price: '0.00955',
    origPrice: '0.00955',
    origQty: '1359.9',
    executedQty: '0',
    status: 'NEW',
    transactTime: TEN_MIN_AGO,
    updateTime: TEN_MIN_AGO,
    ...over,
  }) as any

/** The same take-profit as the deal's grid rebuilds it. */
const TP_GRID = {
  number: 0,
  price: 0.00955,
  qty: 1359.9,
  side: OrderSideEnum.buy,
  newClientOrderId: 'x-TP-rebuilt-72',
  type: TypeOrderEnum.dealTP,
  dealId: DEAL_ID,
} as any

const dealDoc = (status: string) =>
  ({
    _id: DEAL_ID,
    botId: BOT_ID,
    status,
    symbol: { symbol: SYMBOL, baseAsset: 'BLUR', quoteAsset: 'USDT' },
    settings: { avgPrice: status === 'open' ? 0.00974 : 0 },
    initialPrice: status === 'open' ? 0.00974 : 0,
    lastPrice: status === 'open' ? 0.00974 : 0,
    avgPrice: status === 'open' ? 0.00974 : 0,
    currentBalances: { base: 0, quote: 0 },
    profit: { total: 0, totalUsd: 0 },
    levels: { all: 5, complete: status === 'open' ? 1 : 0 },
  }) as any

const SNAPSHOT_DEAL = {
  deal: dealDoc('open'),
  initialOrders: [TP_GRID],
  currentOrders: [TP_GRID],
  previousOrders: [],
}

const idIn = (row: any, cond: any) => {
  if (cond === undefined) return true
  if (typeof cond === 'string') return `${row._id}` === cond
  if (cond.$nin) return !cond.$nin.map(String).includes(`${row._id}`)
  if (cond.$in) return cond.$in.map(String).includes(`${row._id}`)
  return true
}

const statusIn = (row: any, cond: any) =>
  cond === undefined ||
  (typeof cond === 'string' ? row.status === cond : cond.$in.includes(row.status))

let Helper: any

describe('a restart in the middle of opening a deal (spec 172)', () => {
  before(function () {
    // One ts-node compile of the DCA mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  describe('part 1 — loadOrders + restoreWork', () => {
    const buildBot = (opts: {
      dbStatus: string
      snapshotOrders: any[]
    }) => {
      const raised = {
        started: [] as any[],
        replaced: [] as string[],
        dealQueries: [] as any[],
        logs: [] as string[],
      }
      const dbDeals = [dealDoc(opts.dbStatus)]
      class TestBot extends (Helper as any) {
        raised = raised
        botId = BOT_ID
        userId = '000000000000000000000a72'
        combo = false
        loadingComplete = true
        serviceRestart = true
        secondRestart = false
        pairs = new Set([SYMBOL])
        data: any = {
          settings: { name: 'bot', pair: [SYMBOL] },
          status: 'open',
          exchange: 'binance',
          flags: [],
          paperContext: false,
        }
        orders = new Map<string, any>()
        dealsDb = {
          readData: async (q: any) => {
            raised.dealQueries.push(q)
            const result = dbDeals
              .filter(
                (d) =>
                  d.botId === q.botId &&
                  statusIn(d, q.status) &&
                  idIn(d, q._id),
              )
              .map((d) => ({ ...d }))
            return { status: StatusEnum.ok, data: { result } }
          },
          countData: async () => ({
            status: StatusEnum.ok,
            data: { result: 1 },
          }),
        }
        ordersDb = {
          readData: async (q: any, _f?: any, _o?: any, isArray?: boolean) => {
            const rows = [BASE].filter(
              (r) =>
                (q.dealId === undefined || q.dealId === r.dealId) &&
                (q.typeOrder === undefined || q.typeOrder === r.typeOrder) &&
                (q.clientOrderId === undefined ||
                  q.clientOrderId === r.clientOrderId),
            )
            return {
              status: StatusEnum.ok,
              data: { result: isArray ? rows : rows[0] },
            }
          },
        }
        async getFromRedis(key: string) {
          return key === 'deals'
            ? JSON.parse(JSON.stringify([SNAPSHOT_DEAL]))
            : null
        }
        async _loadOrders() {
          return opts.snapshotOrders.map((o) => ({ ...o }))
        }
        setOrder(o: any) {
          this.orders.set(o.clientOrderId, o)
        }
        getOrderFromMap(id: string) {
          return this.orders.get(id)
        }
        get allOrders() {
          return [...this.orders.values()]
        }
        setOrdersToRedis() {}
        setDealToRedis() {}
        scheduleDcaIndicatorSync() {}
        async baseAssetPrecision() {
          return 1
        }
        getOrderId(p: string) {
          return `${p}-regenerated`
        }
        async createInitialDealOrders() {
          return [TP_GRID]
        }
        async createCurrentDealOrders() {
          return [TP_GRID]
        }
        async getCommDeal() {
          return 0
        }
        async getExchangeInfo() {
          return { priceAssetPrecision: 5 }
        }
        async getUserFee() {
          return { maker: 0, taker: 0 }
        }
        get futures() {
          return false
        }
        shouldProceed() {
          return true
        }
        async startDeal(o: any) {
          raised.started.push({ ...o })
        }
        async placeBaseOrder(_b: string, _s: string, dealId: string) {
          raised.replaced.push(dealId)
        }
        // --- restoreWork past the start deals, stubbed to no-ops -------------
        calculateBotDeals() {}
        async getAggregatedSettings() {
          return { type: 'regular', startCondition: 'ASAP' }
        }
        async getSymbolsToOpenAsapDeals() {
          return []
        }
        async checkOrders() {}
        async cancelAllOrder() {}
        async clearAllOrderQuarantine() {}
        getOrdersByStatusAndDealId() {
          return []
        }
        async setCloseByTimer() {}
        async resumeTrailingCloseRetry() {}
        resumeBaseEntryRemainder() {}
        async restoreSettledBaseEntryAverage() {}
        updateDealBalances() {}
        async checkPlaceOrders() {}
        updateDealLastPrices() {}
        async openNewDeal() {}
        startTimeBasedTrigger() {}
        async startIndicatorInit() {}
        calculateBotBalances() {}
        async calculateUsage() {}
        emit() {
          return true
        }
        handleLog(m: string) {
          raised.logs.push(m)
        }
        handleWarn(m: string) {
          raised.logs.push(m)
        }
        handleDebug() {}
        handleErrors(m: string) {
          raised.logs.push(m)
        }
        startMethod() {
          return '1'
        }
        endMethod() {}
      }
      return new (TestBot as any)()
    }

    it('§1.1.1 a snapshot-open deal Mongo still holds as start is loaded as start', async () => {
      const bot = buildBot({
        dbStatus: 'start',
        snapshotOrders: [BASE, phantomTp()],
      })
      await bot.loadOrders()
      const d = bot.getDeal(DEAL_ID)
      expect(d.deal.status).to.equal('start')
      expect(d.deal.levels.complete).to.equal(0)
      expect(d.initialOrders, 'no generated orders: startDeal needs none').to.deep.equal([])
    })

    it('§1.1.1 restore then starts it on its filled base order', async () => {
      const bot = buildBot({
        dbStatus: 'start',
        snapshotOrders: [BASE, phantomTp()],
      })
      await bot.loadOrders()
      await bot.restoreWork()
      expect(bot.raised.replaced, 'no second entry').to.deep.equal([])
      expect(
        bot.raised.started.map((o: any) => o.clientOrderId),
      ).to.deep.equal([BASE.clientOrderId])
    })

    it('§1.1.2 Mongo agrees the deal is open: the snapshot copy is kept', async () => {
      const bot = buildBot({
        dbStatus: 'open',
        snapshotOrders: [BASE, phantomTp()],
      })
      await bot.loadOrders()
      await bot.restoreWork()
      expect(bot.getDeal(DEAL_ID).deal.status).to.equal('open')
      expect(bot.getDeal(DEAL_ID).deal.levels.complete).to.equal(1)
      expect(bot.raised.started).to.deep.equal([])
    })

    it('§1.1.2 a take-profit the venue accepted keeps the snapshot copy', async () => {
      const bot = buildBot({
        dbStatus: 'start',
        snapshotOrders: [BASE, phantomTp({ orderId: '987654' })],
      })
      await bot.loadOrders()
      await bot.restoreWork()
      expect(bot.getDeal(DEAL_ID).deal.status).to.equal('open')
      expect(bot.raised.started).to.deep.equal([])
    })

    it('§1.1.2 no filled entry in the order map: no extra Mongo read', async () => {
      const bot = buildBot({ dbStatus: 'start', snapshotOrders: [] })
      await bot.loadOrders()
      // Only spec 151's read of the deals the snapshot lacks (beside spec
      // 190's status check of the restored ones).
      expect(
        bot.raised.dealQueries.filter(
          (q: any) => !q.status?.$in?.includes('closed'),
        ),
      ).to.have.length(1)
      expect(bot.getDeal(DEAL_ID).deal.status).to.equal('open')
    })
  })

  describe('part 2 — the restart take-profit check', () => {
    const buildBot = (opts: {
      tp: any
      dbRow: boolean
      dealStatus?: string
      currentOrders?: any[]
    }) => {
      const placed: any[] = []
      const struck: string[] = []
      const deal = {
        deal: {
          ...dealDoc(opts.dealStatus ?? 'open'),
        },
        initialOrders: opts.currentOrders ?? [TP_GRID],
        currentOrders: opts.currentOrders ?? [TP_GRID],
        previousOrders: [],
      }
      class TestBot extends (Helper as any) {
        placed = placed
        struck = struck
        botId = BOT_ID
        loadingComplete = true
        serviceRestart = true
        secondRestart = false
        blockCheck = false
        data: any = {
          settings: { name: 'bot', pair: [SYMBOL] },
          status: 'open',
          exchange: 'binance',
          flags: [],
          paperContext: false,
        }
        orders = new Map<string, any>([[opts.tp.clientOrderId, opts.tp]])
        ordersDb = {
          readData: async (q: any) => ({
            status: StatusEnum.ok,
            data: {
              result:
                opts.dbRow && q.clientOrderId === opts.tp.clientOrderId
                  ? { _id: 'row' }
                  : undefined,
            },
          }),
        }
        shouldProceed() {
          return true
        }
        getDeal(id?: string) {
          return id === DEAL_ID ? deal : undefined
        }
        deleteOrder(id: string) {
          this.orders.delete(id)
        }
        getOrdersByStatusAndDealId() {
          return []
        }
        async getAggregatedSettings() {
          return { dcaByMarket: true }
        }
        async isDealForTPLevelCheck() {
          return false
        }
        isOrderQuarantined() {
          return false
        }
        clearOrderStrikes() {}
        noteOrderNotFound(o: any) {
          struck.push(o.clientOrderId)
        }
        async getOrderForReconcile() {
          return {
            status: StatusEnum.notok,
            reason: 'Order does not exist.',
            data: null,
          }
        }
        async placeOrders(_b: string, _s: string, _d: string, orders: any) {
          placed.push(...orders.new)
        }
        async cancelOrderOnExchange() {}
        handleLog() {}
        handleDebug() {}
        handleWarn() {}
        handleErrors() {}
        startMethod() {
          return '1'
        }
        endMethod() {}
      }
      return new (TestBot as any)()
    }

    it('§1.1.3 a never-sent take-profit is dropped and placed again', async () => {
      const bot = buildBot({ tp: phantomTp(), dbRow: false })
      await bot.checkOrders(BOT_ID)
      expect(bot.orders.has('x-TP-000000000072'), 'phantom dropped').to.equal(
        false,
      )
      expect(bot.placed.map((g: any) => [g.side, g.price, g.qty])).to.deep.equal(
        [[TP_GRID.side, TP_GRID.price, TP_GRID.qty]],
      )
      expect(bot.struck, 'no quarantine strike').to.deep.equal([])
    })

    it('§1.1.3 on a start deal it is dropped, and startDeal places the take-profit', async () => {
      const bot = buildBot({
        tp: phantomTp(),
        dbRow: false,
        dealStatus: 'start',
        currentOrders: [],
      })
      await bot.checkOrders(BOT_ID)
      expect(bot.orders.has('x-TP-000000000072')).to.equal(false)
      expect(bot.placed).to.deep.equal([])
    })

    it('§1.1.4 a take-profit with a Mongo row keeps the existing handling', async () => {
      const bot = buildBot({ tp: phantomTp(), dbRow: true })
      await bot.checkOrders(BOT_ID)
      expect(bot.orders.has('x-TP-000000000072')).to.equal(true)
      expect(bot.placed).to.deep.equal([])
      expect(bot.struck).to.deep.equal(['x-TP-000000000072'])
    })

    it('§1.1.4 a take-profit with a real exchange id keeps the existing handling', async () => {
      const bot = buildBot({ tp: phantomTp({ orderId: '987654' }), dbRow: false })
      await bot.checkOrders(BOT_ID)
      expect(bot.orders.has('x-TP-000000000072')).to.equal(true)
      expect(bot.placed).to.deep.equal([])
      expect(bot.struck).to.deep.equal(['x-TP-000000000072'])
    })

    it('§1.1.3 a take-profit created moments ago is not judged', async () => {
      const now = Date.now()
      const bot = buildBot({
        tp: phantomTp({ transactTime: now, updateTime: now }),
        dbRow: false,
      })
      await bot.checkOrders(BOT_ID)
      expect(bot.orders.has('x-TP-000000000072')).to.equal(true)
      expect(bot.placed).to.deep.equal([])
    })
  })
})
