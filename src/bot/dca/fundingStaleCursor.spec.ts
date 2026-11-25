process.env.NODE_ENV = 'testing'

/**
 * A bot's funding total is the sum of its deals' funding.
 *
 * `processDealFunding` commits a deal's settlements with a compare-and-swap on
 * the deal's `funding.offset`, then `$inc`s the bot's `funding.total`. The bot
 * write used to run whether or not the deal write matched. A deal restored
 * from the Redis snapshot after a worker restart carries the cursor of the
 * last time that snapshot was written, and `setDeal(live, false)` never wrote
 * it after a settlement — so the restart replayed every settlement since: the
 * deal's CAS missed (Mongo already had them) and the bot was charged again,
 * once per restart.
 *
 * Drives the REAL `processDealFunding` over a minimal base class and a fake
 * collection with Mongo's CAS semantics. No stack, DB, Redis or exchange.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { DCADealStatusEnum, ExchangeEnum } from '../../../types'

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b71'
const DEAL_ID = '000000000000000000000d71'
const SYMBOL = 'XAGUSDT'
const H4 = 4 * 3600 * 1000
const T0 = 1_790_000_000_000

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u71'
  isLong = true
  futures = true
  coinm = false
  combo = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    status: 'open',
    exchange: ExchangeEnum.bitgetUsdm,
    flags: [],
    paperContext: false,
    funding: { total: 0, totalUsd: 0, offset: 0, lastTime: 0 },
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const get = (doc: any, path: string) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc)
const set = (doc: any, path: string, v: unknown) => {
  const keys = path.split('.')
  let o = doc
  for (const k of keys.slice(0, -1)) {
    o[k] = o[k] ?? {}
    o = o[k]
  }
  o[keys[keys.length - 1]] = v
}

/** One-collection stand-in for `MongoCrud` with updateOne/findOneAndUpdate semantics. */
const fakeCollection = (docs: any[]) => ({
  docs,
  writes: 0,
  matches(doc: any, filter: any) {
    return Object.entries(filter).every(([k, want]: [string, any]) => {
      const have = get(doc, k)
      if (want && typeof want === 'object' && '$exists' in want) {
        return (have !== undefined) === want.$exists
      }
      return `${have}` === `${want}`
    })
  },
  async updateData(filter: any, update: any, returnDoc = false) {
    this.writes++
    const doc = this.docs.find((d) => this.matches(d, filter))
    if (doc) {
      for (const [k, v] of Object.entries(update.$inc ?? {})) {
        set(doc, k, (get(doc, k) ?? 0) + (v as number))
      }
      for (const [k, v] of Object.entries(update.$set ?? {})) {
        set(doc, k, v)
      }
      for (const [k, v] of Object.entries(update.$max ?? {})) {
        set(doc, k, Math.max(get(doc, k) ?? -Infinity, v as number))
      }
      for (const [k, v] of Object.entries(update.$push ?? {})) {
        set(doc, k, [...(get(doc, k) ?? []), ...((v as any).$each ?? [])])
      }
    }
    if (returnDoc && doc) {
      return { status: 'OK', reason: null, data: structuredClone(doc) }
    }
    return {
      status: 'OK',
      reason: `Data updated. Matched: ${doc ? 1 : 0}`,
      data: null,
    }
  },
  async readData(filter: any) {
    const doc = this.docs.find((d) => this.matches(d, filter))
    return { status: 'OK', reason: null, data: { result: structuredClone(doc) } }
  },
})

const makeBot = (memDeal: any, dbDeal: any, dbBot: any) => {
  class TestBot extends Helper {
    saves: boolean[] = []
    full: any = {
      deal: memDeal,
      initialOrders: [],
      currentOrders: [],
      previousOrders: [],
      closeBySl: false,
      notCheckSl: false,
    }
    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    setDeal(d: any, save = true) {
      this.full = d
      this.saves.push(save)
    }
    async toFundingSymbol(p: string) {
      return p
    }
    getSignedFillsFromMemory() {
      return [{ time: T0, signedQty: 10 }]
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    emit() {}
  }
  const bot = new TestBot() as any
  bot.dealsDb = fakeCollection([dbDeal])
  bot.db = fakeCollection([dbBot])
  return bot
}

/** Settlements the funding store holds after `offset`, −1 each. */
const storeAfter = (settlements: number[]) => async (
  _s: string,
  _p: string,
  offset: number,
) => {
  const due = settlements.filter((t) => t > offset)
  if (!due.length) {
    return {
      applied: 0,
      deltaQuote: 0,
      deltaUsd: 0,
      maxTime: offset,
      lastTime: offset,
      entries: [],
    }
  }
  return {
    applied: due.length,
    deltaQuote: -due.length,
    deltaUsd: -due.length,
    maxTime: Math.max(...due),
    lastTime: Math.max(...due),
    entries: due.map((time) => ({ time, feeQuote: -1, feeUsd: -1 })),
  }
}

const deal = (total: number, offset: number) => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'XAG', quoteAsset: 'USDT' },
  status: DCADealStatusEnum.open,
  createTime: T0,
  funding: { total, totalUsd: total, offset, lastTime: offset, history: [] },
})

describe('processDealFunding — bot total follows the deals', () => {
  before(function () {
    this.timeout(180000)
    Helper = Helper ?? loadModule('../dcaHelper').default(FakeBase as any)
  })

  const SETTLED = [T0 + H4, T0 + 2 * H4, T0 + 3 * H4, T0 + 4 * H4]

  it('a deal reloaded from a stale snapshot does not charge the bot again', async () => {
    // Mongo has all four settlements on the deal and on the bot; the Redis
    // snapshot the worker restored from was written after the first one.
    const dbDeal = deal(-4, SETTLED[3])
    const dbBot = { _id: BOT_ID, funding: { total: -4, totalUsd: -4 } }
    const bot = makeBot(deal(-1, SETTLED[0]), dbDeal, dbBot)
    bot.data.funding = { total: -4, totalUsd: -4, offset: 0, lastTime: 0 }
    bot.computeFundingFor = storeAfter(SETTLED)

    await bot.processDealFunding(DEAL_ID)

    expect(dbDeal.funding.total, 'deal in Mongo').to.equal(-4)
    expect(dbBot.funding.total, 'bot in Mongo').to.equal(-4)
    expect(bot.data.funding.total, 'bot in memory').to.equal(-4)
    // The live deal adopts what Mongo holds, cursor included, so the next
    // settlement commits instead of missing again.
    expect(bot.full.deal.funding.offset).to.equal(SETTLED[3])
    expect(bot.full.deal.funding.total).to.equal(-4)
  })

  it('after the stale reload, the next settlement lands once on deal and bot', async () => {
    const dbDeal = deal(-4, SETTLED[3])
    const dbBot = { _id: BOT_ID, funding: { total: -4, totalUsd: -4 } }
    const bot = makeBot(deal(-1, SETTLED[0]), dbDeal, dbBot)
    bot.data.funding = { total: -4, totalUsd: -4, offset: 0, lastTime: 0 }
    bot.computeFundingFor = storeAfter(SETTLED)
    await bot.processDealFunding(DEAL_ID)

    bot.computeFundingFor = storeAfter([...SETTLED, T0 + 5 * H4])
    await bot.processDealFunding(DEAL_ID)

    expect(dbDeal.funding.total).to.equal(-5)
    expect(dbBot.funding.total).to.equal(-5)
    expect(bot.data.funding.total).to.equal(-5)
    expect(bot.full.deal.funding.total).to.equal(-5)
  })

  it('a committed settlement is written to the Redis deal snapshot', async () => {
    const dbDeal = deal(-1, SETTLED[0])
    const dbBot = { _id: BOT_ID, funding: { total: -1, totalUsd: -1 } }
    const bot = makeBot(deal(-1, SETTLED[0]), dbDeal, dbBot)
    bot.computeFundingFor = storeAfter(SETTLED.slice(0, 2))

    await bot.processDealFunding(DEAL_ID)

    expect(dbDeal.funding.total).to.equal(-2)
    expect(dbBot.funding.total).to.equal(-2)
    expect(bot.full.deal.funding.offset).to.equal(SETTLED[1])
    // `setDeal(…, false)` skips `setDealToRedis`; the snapshot kept the old
    // cursor and the next restart replayed this settlement.
    expect(bot.saves).to.not.include(false)
  })

  it('a failed deal write moves nothing', async () => {
    const dbDeal = deal(-1, SETTLED[0])
    const dbBot = { _id: BOT_ID, funding: { total: -1, totalUsd: -1 } }
    const bot = makeBot(deal(-1, SETTLED[0]), dbDeal, dbBot)
    bot.computeFundingFor = storeAfter(SETTLED.slice(0, 2))
    bot.dealsDb.updateData = async () => ({
      status: 'NOTOK',
      reason: 'timeout',
      data: null,
    })

    await bot.processDealFunding(DEAL_ID)

    expect(dbBot.funding.total).to.equal(-1)
    expect(bot.full.deal.funding.offset).to.equal(SETTLED[0])
  })
})
