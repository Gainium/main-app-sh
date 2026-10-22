process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `151.cold-restart-loses-deals-missing-from-the-redis-snapshot`.
 *
 * Drives the REAL DCA `loadOrders` (cold-restart branch) and then the REAL
 * `restoreWork` over the deals it loaded. Redis and Mongo are stubs that
 * record their reads; `startDeal` / `placeBaseOrder` are recorded, not run.
 * Harness shape from `coldRestartOrderSnapshot.spec.ts` (spec 108) and
 * `comboPartialBaseEntry.spec.ts` (spec 101).
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b51'
/** Restored from the snapshot. */
const OLD_DEAL = '000000000000000000000d51'
/** Created seconds before the process stopped: in Mongo, not in Redis. */
const NEW_DEAL = '000000000000000000000d52'
const SYMBOL = 'PLUME-USDC'
const LIVE = ['error', 'open', 'start']

const deal = (_id: string, status: string) =>
  ({
    _id,
    botId: BOT_ID,
    status,
    symbol: { symbol: SYMBOL, baseAsset: 'PLUME', quoteAsset: 'USDC' },
    settings: { avgPrice: status === 'open' ? 0.023 : 0 },
    initialPrice: status === 'open' ? 0.023 : 0,
    lastPrice: status === 'open' ? 0.023 : 0,
    avgPrice: status === 'open' ? 0.023 : 0,
    currentBalances: { base: 0, quote: 0 },
    profit: { total: 0, totalUsd: 0 },
    levels: { all: 36, complete: status === 'open' ? 1 : 0 },
  }) as any

const SNAPSHOT_DEAL = {
  deal: deal(OLD_DEAL, 'open'),
  initialOrders: [],
  currentOrders: [],
  previousOrders: [],
}

/** The new deal's base order: NEW when written, FILLED by the restart check. */
const BASE = {
  _id: 'id-D-BO-000000000051',
  symbol: SYMBOL,
  clientOrderId: 'D-BO-000000000051',
  botId: BOT_ID,
  dealId: NEW_DEAL,
  typeOrder: TypeOrderEnum.dealStart,
  side: 'BUY',
  price: '0.02333',
  origQty: '4290',
  executedQty: '4290',
  status: 'FILLED',
  updateTime: 1791780399000,
} as any

const idIn = (row: any, cond: any) => {
  if (cond === undefined) return true
  if (typeof cond === 'string') return `${row._id}` === cond
  if (cond.$nin) return !cond.$nin.map(String).includes(`${row._id}`)
  if (cond.$in) return cond.$in.map(String).includes(`${row._id}`)
  return true
}

const matchesDeal = (row: any, q: any) =>
  row.botId === q.botId &&
  (!q.status?.$in || q.status.$in.includes(row.status)) &&
  idIn(row, q._id)

let Helper: any

type Raised = {
  started: any[]
  replaced: string[]
  loadOrderKeys: string[][]
  dealQueries: any[]
  logs: string[]
}

const buildBot = (opts: {
  snapshot: any[] | null
  dbDeals: any[]
  secondRestart?: boolean
  dealDbFails?: boolean
}) => {
  const raised: Raised = {
    started: [],
    replaced: [],
    loadOrderKeys: [],
    dealQueries: [],
    logs: [],
  }
  class TestBot extends (Helper as any) {
    raised = raised
    botId = BOT_ID
    userId = '000000000000000000000a51'
    combo = false
    loadingComplete = true
    serviceRestart = true
    secondRestart = !!opts.secondRestart
    pairs = new Set([SYMBOL])
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'paperCoinbase',
      flags: [],
      paperContext: true,
    }
    orders = new Map<string, any>()
    dealsDb = {
      readData: async (q: any) => {
        raised.dealQueries.push(q)
        if (opts.dealDbFails) {
          return { status: StatusEnum.notok, reason: 'db down', data: null }
        }
        const result = opts.dbDeals
          .filter((d) => matchesDeal(d, q))
          .map((d) => ({ ...d }))
        return { status: StatusEnum.ok, data: { result } }
      },
      countData: async () => ({
        status: StatusEnum.ok,
        data: { result: opts.dbDeals.length },
      }),
    }
    ordersDb = {
      readData: async (q: any, _f?: any, _o?: any, isArray?: boolean) => {
        const rows = [BASE].filter(
          (r) =>
            (q.dealId === undefined || q.dealId === r.dealId) &&
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
      return key === 'deals' && opts.snapshot
        ? JSON.parse(JSON.stringify(opts.snapshot))
        : null
    }
    async _loadOrders(_q: any, _f: boolean, keys: string[]) {
      raised.loadOrderKeys.push([...keys].sort())
      return keys.includes(NEW_DEAL) ? [{ ...BASE }] : []
    }
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    setOrdersToRedis() {}
    setDealToRedis() {}
    scheduleDcaIndicatorSync() {}
    async baseAssetPrecision() {
      return 0
    }
    async createInitialDealOrders() {
      return []
    }
    async createCurrentDealOrders() {
      return []
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
    /** The end of the filled-base chain — builds the deal's orders. */
    async startDeal(o: any) {
      raised.started.push({ ...o })
    }
    async placeBaseOrder(_b: string, _s: string, dealId: string) {
      raised.replaced.push(dealId)
    }
    // --- restoreWork past the start deals, stubbed to no-ops ---------------
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

const openIds = (bot: any) =>
  bot
    .getOpenDeals()
    .map((d: any) => `${d.deal._id}`)
    .sort()

const DB_DEALS = [deal(OLD_DEAL, 'open'), deal(NEW_DEAL, 'start')]

describe('cold restart deal snapshot (spec 151)', () => {
  before(function () {
    // One ts-node compile of the DCA mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§1.1.1 loads a live Mongo deal the snapshot lacks', async () => {
    const bot = buildBot({ snapshot: [SNAPSHOT_DEAL], dbDeals: DB_DEALS })
    await bot.loadOrders()
    expect(openIds(bot)).to.deep.equal([OLD_DEAL, NEW_DEAL].sort())
    expect(bot.getDeal(NEW_DEAL).deal.status).to.equal('start')
  })

  it("§1.1.2 the missing deal's orders are loaded with the restored ones", async () => {
    const bot = buildBot({ snapshot: [SNAPSHOT_DEAL], dbDeals: DB_DEALS })
    await bot.loadOrders()
    expect(bot.raised.loadOrderKeys).to.deep.equal([
      [OLD_DEAL, NEW_DEAL].sort(),
    ])
    expect(bot.getOrderFromMap(BASE.clientOrderId)?.status).to.equal('FILLED')
  })

  it('§1.1.2 restore starts the missing deal on its filled base order', async () => {
    const bot = buildBot({ snapshot: [SNAPSHOT_DEAL], dbDeals: DB_DEALS })
    await bot.loadOrders()
    await bot.restoreWork()
    const raised = bot.raised as Raised
    expect(raised.replaced, 'no second base order').to.deep.equal([])
    expect(raised.started.map((o) => o.clientOrderId)).to.deep.equal([
      BASE.clientOrderId,
    ])
  })

  it('§1.1.3 reads Mongo only for deals the snapshot lacks', async () => {
    const bot = buildBot({ snapshot: [SNAPSHOT_DEAL], dbDeals: DB_DEALS })
    await bot.loadOrders()
    // Spec 190 adds a `{status: 1}` read of the restored ids for closed deals;
    // this one is the spec 151 read of the live deals.
    const q = bot.raised.dealQueries.filter(
      (d: any) => !d.status?.$in?.includes('closed'),
    )
    expect(q).to.have.length(1)
    expect(q[0].botId).to.equal(BOT_ID)
    expect(q[0].status).to.deep.equal({ $in: LIVE })
    expect(q[0]._id).to.deep.equal({ $nin: [OLD_DEAL] })
    // The restored deal keeps the snapshot's copy.
    expect(bot.getDeal(OLD_DEAL).deal.levels.complete).to.equal(1)
  })

  it('§1.1.4 falls back to the snapshot when the Mongo read fails', async () => {
    const bot = buildBot({
      snapshot: [SNAPSHOT_DEAL],
      dbDeals: DB_DEALS,
      dealDbFails: true,
    })
    await bot.loadOrders()
    expect(openIds(bot)).to.deep.equal([OLD_DEAL])
    expect(bot.raised.loadOrderKeys).to.deep.equal([[OLD_DEAL]])
    expect(bot.raised.logs.join('\n')).to.contain('db down')
  })

  it('§1.1.5 a reload still reads every live deal from Mongo', async () => {
    const bot = buildBot({
      snapshot: [SNAPSHOT_DEAL],
      dbDeals: DB_DEALS,
      secondRestart: true,
    })
    await bot.loadOrders()
    const q = bot.raised.dealQueries
    expect(q).to.have.length(1)
    expect(q[0]._id).to.equal(undefined)
    expect(openIds(bot)).to.deep.equal([OLD_DEAL, NEW_DEAL].sort())
  })

  it('§1.1.5 an empty snapshot still falls back to a full Mongo load', async () => {
    const bot = buildBot({ snapshot: null, dbDeals: DB_DEALS })
    await bot.loadOrders()
    expect(bot.raised.dealQueries[0]._id).to.equal(undefined)
    expect(openIds(bot)).to.deep.equal([OLD_DEAL, NEW_DEAL].sort())
  })
})
