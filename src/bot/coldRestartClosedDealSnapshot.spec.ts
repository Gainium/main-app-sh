process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `190.a-restart-revives-a-closed-deal-from-the-redis-snapshot`.
 *
 * Drives the REAL DCA `loadOrders` (cold-restart branch), then the REAL
 * `restoreWork` with the REAL spec `182` sweep resume. Redis, Mongo and the
 * venue are recorded stubs. Harness shape from `coldRestartDealSnapshot.spec.ts`
 * (spec 151).
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b90'
/** Closed in Mongo, still `open` in the snapshot. */
const GHOST = '000000000000000000000d90'
/** Open in both. */
const LIVE_DEAL = '000000000000000000000d91'
const SYMBOL = 'BR-USDT'

const deal = (_id: string, status: string) =>
  ({
    _id,
    botId: BOT_ID,
    status,
    symbol: { symbol: SYMBOL, baseAsset: 'BR', quoteAsset: 'USDT' },
    settings: { avgPrice: 0.05 },
    initialPrice: 0.05,
    lastPrice: 0.05,
    avgPrice: 0.05,
    currentBalances: { base: 0, quote: 0 },
    profit: { total: 0, totalUsd: 0 },
    levels: { all: 10, complete: 1 },
  }) as any

const snap = (_id: string) => ({
  deal: deal(_id, 'open'),
  initialOrders: [],
  currentOrders: [],
  previousOrders: [],
})

/** A resting grid order the revived deal placed after its close. */
const GHOST_ORDER = {
  _id: 'row-ghost-1',
  symbol: SYMBOL,
  clientOrderId: 'CMB-GR-ghost-1',
  orderId: '9901',
  botId: BOT_ID,
  dealId: GHOST,
  typeOrder: TypeOrderEnum.dealGrid,
  side: 'BUY',
  price: '0.049',
  origQty: '100',
  executedQty: '0',
  status: 'NEW',
  updateTime: 1792472900000,
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

const buildBot = (opts: {
  snapshot: any[]
  dbDeals: any[]
  closedReadFails?: boolean
}) => {
  const raised = {
    dealQueries: [] as { q: any; fields: any }[],
    redisWrites: [] as { key: string; data: any }[],
    cancelled: [] as string[],
    logs: [] as string[],
  }
  class TestBot extends (Helper as any) {
    raised = raised
    botId = BOT_ID
    userId = '000000000000000000000a90'
    combo = false
    loadingComplete = true
    serviceRestart = true
    secondRestart = false
    pairs = new Set([SYMBOL])
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'paperBybit',
      flags: [],
      paperContext: true,
    }
    orders = new Map<string, any>()
    dealsDb = {
      readData: async (q: any, fields?: any) => {
        raised.dealQueries.push({ q, fields })
        const closedRead =
          q.status?.$in?.includes('closed') || q.status?.$in?.includes('canceled')
        if (closedRead && opts.closedReadFails) {
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
        const rows = [GHOST_ORDER]
          .filter(
            (r) =>
              (q.dealId === undefined || q.dealId === r.dealId) &&
              (!q.status?.$in || q.status.$in.includes(r.status)),
          )
          .map((r) => ({ ...r }))
        return {
          status: StatusEnum.ok,
          data: { result: isArray ? rows : rows[0] },
        }
      },
    }
    async getFromRedis(key: string) {
      return key === 'deals' ? JSON.parse(JSON.stringify(opts.snapshot)) : null
    }
    async setToRedis(key: string, data: any) {
      raised.redisWrites.push({ key, data: JSON.parse(JSON.stringify(data)) })
    }
    // The real query loads every open order of the bot (its third `$or`
    // branch), so the ghost deal's resting grid order is in the map.
    async _loadOrders() {
      return [{ ...GHOST_ORDER }]
    }
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getOrdersByStatusAndDealId({ dealId }: { dealId?: string }) {
      return [...this.orders.values()].filter(
        (o) =>
          (!dealId || `${o.dealId}` === `${dealId}`) &&
          ['NEW', 'PARTIALLY_FILLED'].includes(o.status),
      )
    }
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push(o.clientOrderId)
      const done = { ...o, status: 'CANCELED' }
      this.orders.set(o.clientOrderId, done)
      return done
    }
    handleUnknownOrder() {}
    setOrdersToRedis() {}
    setDealToRedis() {}
    scheduleDcaIndicatorSync() {}
    async baseAssetPrecision() {
      return 0
    }
    async createCurrentDealOrders() {
      return []
    }
    shouldProceed() {
      return true
    }
    // --- restoreWork past the sweep resume, stubbed to no-ops --------------
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

const heldIds = (bot: any) => [...bot.deals.keys()].sort()

describe('spec 190 — a restart does not revive a closed deal from the snapshot', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§1.1.1 a snapshot deal Mongo holds closed is not loaded', async () => {
    const bot = buildBot({
      snapshot: [snap(GHOST)],
      dbDeals: [deal(GHOST, 'closed')],
    })
    await bot.loadOrders()
    expect(heldIds(bot)).to.deep.equal([])
    expect(bot.getOpenDeals()).to.have.length(0)
  })

  it('§1.1.1 the same for a deal Mongo holds canceled', async () => {
    const bot = buildBot({
      snapshot: [snap(GHOST)],
      dbDeals: [deal(GHOST, 'canceled')],
    })
    await bot.loadOrders()
    expect(heldIds(bot)).to.deep.equal([])
  })

  it('§1.1.3 a deal open in both still restores from the snapshot, beside a dropped one', async () => {
    const live = snap(LIVE_DEAL)
    live.deal.levels.complete = 7 // the snapshot's copy, not Mongo's
    const bot = buildBot({
      snapshot: [snap(GHOST), live],
      dbDeals: [deal(GHOST, 'closed'), deal(LIVE_DEAL, 'open')],
    })
    await bot.loadOrders()
    expect(heldIds(bot)).to.deep.equal([LIVE_DEAL])
    expect(bot.getDeal(LIVE_DEAL).deal.levels.complete).to.equal(7)
  })

  it('§4.1 the check reads only status, for the restored ids', async () => {
    const bot = buildBot({
      snapshot: [snap(GHOST), snap(LIVE_DEAL)],
      dbDeals: [deal(GHOST, 'closed'), deal(LIVE_DEAL, 'open')],
    })
    await bot.loadOrders()
    const closedRead = bot.raised.dealQueries.find(
      ({ q }: any) => q.status?.$in?.includes('closed'),
    )
    expect(closedRead, 'a read of the restored ids').to.not.equal(undefined)
    expect(closedRead.q.botId).to.equal(BOT_ID)
    expect(closedRead.q._id.$in.map(String).sort()).to.deep.equal(
      [GHOST, LIVE_DEAL].sort(),
    )
    expect(closedRead.q.status.$in.sort()).to.deep.equal(['canceled', 'closed'])
    expect(closedRead.fields).to.deep.equal({ status: 1 })
  })

  it('§1.1.2 the restart cancels the dropped deal’s resting orders (spec 182 resume)', async () => {
    const bot = buildBot({
      snapshot: [snap(GHOST)],
      dbDeals: [deal(GHOST, 'closed')],
    })
    await bot.loadOrders()
    const recorded = bot.raised.redisWrites.filter(
      (w: any) => w.key === 'closeSweeps',
    )
    expect(
      recorded.some((w: any) => w.data.some((e: any) => e.dealId === GHOST)),
      'a sweep is recorded for the dropped deal',
    ).to.equal(true)
    await bot.restoreWork()
    expect(bot.raised.cancelled).to.deep.equal([GHOST_ORDER.clientOrderId])
    // Nothing of the deal is left open, so the record is cleared.
    expect(bot.closeSweeps.has(GHOST)).to.equal(false)
  })

  it('§4.2 a failed check keeps the snapshot as today', async () => {
    const bot = buildBot({
      snapshot: [snap(GHOST)],
      dbDeals: [deal(GHOST, 'closed')],
      closedReadFails: true,
    })
    await bot.loadOrders()
    expect(heldIds(bot)).to.deep.equal([GHOST])
    expect(bot.raised.logs.join('\n')).to.contain('db down')
  })
})
