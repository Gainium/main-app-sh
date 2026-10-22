process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `183.a-restart-restores-a-stale-deal-counter`.
 *
 * Drives the REAL DCA `loadOrders` (cold-restart branch) and the REAL
 * `updateBotDeals` over a bot whose `deals` counter was restored from a stale
 * Redis `botData` snapshot. Harness shape from `coldRestartDealSnapshot.spec.ts`
 * (spec 151). Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../types'

const BOT_ID = '000000000000000000000b83'
/** Closed seconds before the stop; still `open` in the Redis deal snapshot. */
const OLD_DEAL = '000000000000000000000d83'
/** Opened right after the close: in Mongo, not in the snapshot. */
const NEW_DEAL = '000000000000000000000d84'
const SYMBOL = 'CL-USDT'

const deal = (_id: string, status: string) =>
  ({
    _id,
    botId: BOT_ID,
    status,
    symbol: { symbol: SYMBOL, baseAsset: 'CL', quoteAsset: 'USDT' },
    settings: { avgPrice: 0 },
    initialPrice: 0,
    lastPrice: 0,
    avgPrice: 0,
    currentBalances: { base: 0, quote: 0 },
    profit: { total: 0, totalUsd: 0 },
    levels: { all: 1, complete: 0 },
  }) as any

/** 55 older closed deals + the one that just closed + the one just opened. */
const DB_DEALS = [
  ...Array.from({ length: 55 }, (_, i) =>
    deal(`0000000000000000000c${String(i).padStart(4, '0')}`, 'closed'),
  ),
  deal(OLD_DEAL, 'closed'),
  deal(NEW_DEAL, 'start'),
]

let Helper: any

const buildBot = (opts: {
  deals: { all: number; active: number }
  snapshot: any[]
  countFails?: boolean
}) => {
  const writes: any[] = []
  const logs: string[] = []
  class TestBot extends (Helper as any) {
    writes = writes
    logs = logs
    botId = BOT_ID
    userId = '000000000000000000000a83'
    combo = false
    loadingComplete = true
    serviceRestart = true
    secondRestart = false
    pairs = new Set([SYMBOL])
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'bybitLinear',
      flags: [],
      deals: { ...opts.deals },
    }
    dealsDb = {
      readData: async (q: any) => {
        const nin = (q._id?.$nin ?? []).map(String)
        const ids = q._id?.$in?.map(String)
        const result = DB_DEALS.filter(
          (d) =>
            (!q.status?.$in || q.status.$in.includes(d.status)) &&
            !nin.includes(`${d._id}`) &&
            (!ids || ids.includes(`${d._id}`)),
        ).map((d) => ({ ...d }))
        return { status: StatusEnum.ok, data: { result } }
      },
      countData: async () =>
        opts.countFails
          ? { status: StatusEnum.notok, reason: 'db down', data: null }
          : { status: StatusEnum.ok, data: { result: DB_DEALS.length } },
    }
    async getFromRedis(key: string) {
      return key === 'deals' ? JSON.parse(JSON.stringify(opts.snapshot)) : null
    }
    async setToRedis() {}
    async _loadOrders() {
      return []
    }
    setOrder() {}
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
    async updateData(d: any) {
      writes.push(JSON.parse(JSON.stringify(d)))
    }
    emit() {
      return true
    }
    handleLog(m: string) {
      logs.push(m)
    }
    handleWarn(m: string) {
      logs.push(m)
    }
    handleDebug() {}
    handleErrors(m: string) {
      logs.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

const SNAPSHOT = [
  {
    deal: deal(OLD_DEAL, 'open'),
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  },
]

describe('restart deal counter (spec 183)', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§1.1.1/§1.1.2 restart between TP-close and reopen ends at {57,1}', async () => {
    const bot = buildBot({ deals: { all: 56, active: 0 }, snapshot: SNAPSHOT })
    await bot.loadOrders()
    // Only the recovered new deal is in memory: the old one is closed in Mongo,
    // so spec 190 no longer restores it from the stale-open snapshot (before,
    // it was loaded — `active: 2` — and closed a second time).
    expect([...bot.deals.keys()]).to.deep.equal([NEW_DEAL])
    expect(bot.data.deals).to.deep.equal({ all: 57, active: 1 })
    expect(bot.writes[bot.writes.length - 1]).to.deep.equal({
      deals: { all: 57, active: 1 },
    })
  })

  it('§1.1.3 no write when the counter already agrees', async () => {
    const bot = buildBot({ deals: { all: 57, active: 1 }, snapshot: SNAPSHOT })
    await bot.loadOrders()
    expect(bot.data.deals).to.deep.equal({ all: 57, active: 1 })
    expect(bot.writes.filter((w: any) => w.deals)).to.deep.equal([])
  })

  it('§1.1.4 a failed count keeps the stored all and still fixes active', async () => {
    const bot = buildBot({
      deals: { all: 56, active: 0 },
      snapshot: SNAPSHOT,
      countFails: true,
    })
    await bot.loadOrders()
    expect(bot.data.deals).to.deep.equal({ all: 56, active: 1 })
  })
})
