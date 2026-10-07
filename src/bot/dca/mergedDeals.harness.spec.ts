process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `138.merged-deals-are-one-position`.
 *
 * Drives the REAL `dcaHelper.mergeDeals`, `botUpdateStats`,
 * `checkOpenedDeals` and `isMergedAway` off the mixin prototype
 * (`Object.create`, as `botStatsResetSeries.harness.spec.ts` does), the REAL
 * read-side folds (`pairStats.ts`, `botWindowStats.ts`) and the REAL
 * `Bot.mergeComboDeals`. No Mongo, Redis, venue or bot stack; the collections
 * are in-memory stubs that record what they are asked.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import createDCABotHelper from '../dcaHelper'
import MainBot from '../main'
import Bot from '../index'
import {
  buildPairCapitalPipeline,
  buildPairStatsPipeline,
  peakCapitalBySymbol,
} from '../pairStats'
import { foldBotWindowStats } from '../botWindowStats'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const BOT_ID = '000000000000000000000b38'
const USER_ID = '000000000000000000000a38'
const DEAL_A = '000000000000000000000d01'
const DEAL_B = '000000000000000000000d02'
const MERGED = '000000000000000000000d99'

const ok = <T>(result: T) => ({
  status: StatusEnum.ok,
  reason: null,
  data: { result },
})

const helper = (over: { combo?: boolean } = {}) => {
  const Helper: any = createDCABotHelper(MainBot as any)
  const bot: any = Object.create(Helper.prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = 'dca'
  for (const [k, v] of [
    ['combo', over.combo ?? false],
    ['futures', false],
    ['coinm', false],
    ['isLong', true],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }
  bot.startMethod = () => 'x'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.handleErrors = (reason: string) => ({ status: 'NOTOK', reason })
  bot.shouldProceed = () => true
  bot.updateData = () => undefined
  bot.emit = () => undefined
  return bot
}

const sourceDeal = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  botId: BOT_ID,
  userId: USER_ID,
  status: DCADealStatusEnum.open,
  strategy: 'LONG',
  symbol: { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  profit: { total: 0, totalUsd: 0 },
  child: false,
  parent: false,
  flags: ['feeByAsset'],
  tpHistory: [],
  ...over,
})

const filled = (dealId: string, clientOrderId: string, price: number) => ({
  clientOrderId,
  dealId,
  botId: BOT_ID,
  userId: USER_ID,
  status: 'FILLED',
  side: 'BUY',
  typeOrder: TypeOrderEnum.dealStart,
  price: `${price}`,
  executedQty: '1',
})

describe('spec 138 §2.1 — read-side stats: a merged-away deal is not a deal', () => {
  it('pair stats count only deals that were not merged away, money from all', () => {
    const [, group] = buildPairStatsPipeline(['a']) as any[]
    const g = group.$group
    const childCond = JSON.stringify({ $ifNull: ['$child', false] })
    for (const field of [
      'closedDeals',
      'wins',
      'losses',
      'totalDuration',
      'maxDealDuration',
      'maxDrawdownPerc',
    ]) {
      expect(JSON.stringify(g[field]), field).to.include(childCond)
    }
    for (const field of [
      'realizedProfitUsd',
      'grossProfitUsd',
      'grossLossUsd',
      'feesQuote',
    ]) {
      expect(JSON.stringify(g[field]), field).to.not.include(childCond)
    }
  })

  it('the capital rows carry the id and, for a merged-away deal, its parent', () => {
    const [, project] = buildPairCapitalPipeline(['a']) as any[]
    expect(project.$project).to.include.keys('id', 'parentId')
  })

  it('a merged-away deal holds its capital only until the merged deal starts', () => {
    // Two $50 sources from t=1/10, merged at t=100 into one $100 deal. The
    // merged deal is created at 100, the sources are cancelled at 102.
    const rows = [
      {
        symbol: 'BTCUSDT',
        start: 1,
        end: 102,
        capital: 50,
        id: DEAL_A,
        parentId: MERGED,
      },
      {
        symbol: 'BTCUSDT',
        start: 10,
        end: 102,
        capital: 50,
        id: DEAL_B,
        parentId: MERGED,
      },
      { symbol: 'BTCUSDT', start: 100, end: null, capital: 100, id: MERGED },
    ]
    expect(peakCapitalBySymbol(rows, 1000).get('BTCUSDT')).to.equal(100)
    // Without the hand-over the two seconds of overlap read as $200.
    const unlinked = rows.map(({ parentId: _p, ...r }) => r)
    expect(peakCapitalBySymbol(unlinked, 1000).get('BTCUSDT')).to.equal(200)
  })

  it('a merged-away deal whose parent is outside the rows keeps its own close', () => {
    const peaks = peakCapitalBySymbol([
      {
        symbol: 'X',
        start: 1,
        end: 50,
        capital: 10,
        id: DEAL_A,
        parentId: MERGED,
      },
      { symbol: 'X', start: 40, end: 60, capital: 10, id: DEAL_B },
    ])
    expect(peaks.get('X')).to.equal(20)
  })

  it('window stats: no count / win / duration for it; booked money still counts', () => {
    const H = 3_600_000
    const s = foldBotWindowStats(
      [
        // merged away with nothing booked (a DCA merge)
        {
          start: 0,
          end: 5 * H,
          capital: 50,
          profit: 0,
          profitUsd: 0,
          id: DEAL_A,
          parentId: MERGED,
        },
        // merged away with realized profit booked before the merge
        {
          start: 0,
          end: 5 * H,
          capital: 50,
          profit: 3,
          profitUsd: 3,
          id: DEAL_B,
          parentId: MERGED,
        },
        // the merged deal, closed in profit after one more hour
        {
          start: 5 * H,
          end: 6 * H,
          capital: 100,
          profit: 10,
          profitUsd: 10,
          id: MERGED,
        },
      ],
      null,
      7 * H,
    )
    expect(s.closedDeals).to.equal(1)
    expect(s.wins).to.equal(1)
    expect(s.losses).to.equal(0)
    expect(s.avgDealDuration).to.equal(H)
    expect(s.maxDealDuration).to.equal(H)
    expect(s.maxDealProfitUsd).to.equal(10)
    expect(s.avgDealProfitUsd).to.equal(10)
    expect(s.realizedProfitUsd).to.equal(13)
    expect(s.grossProfitUsd).to.equal(13)
    expect(s.firstCloseTime).to.equal(6 * H)
    expect(s.peakCapitalUsd).to.equal(100)
  })
})

describe('spec 138 §2.1.4 — engine stats skip a merged-away deal', () => {
  const statsBot = (child: boolean, dbChild: boolean) => {
    const bot = helper()
    let reads = 0
    let written = false
    bot.data = {
      settings: { type: 'regular' },
      ignoreStats: false,
      stats: null,
      symbolStats: [],
    }
    bot.updateData = () => {
      written = true
    }
    bot.dealsDb = {
      readData: async () => {
        reads += 1
        return ok({ child: dbChild })
      },
    }
    bot.db = {
      readData: async () => {
        // Past the merged-away gate: stop here, the rest is not under test.
        throw new Error('reached the stats body')
      },
    }
    const deal = {
      _id: DEAL_A,
      status: DCADealStatusEnum.canceled,
      child,
      profit: { total: 0, totalUsd: 0 },
    }
    return {
      run: () => bot.botUpdateStats(BOT_ID, { deal, initialOrders: [] }),
      reads: () => reads,
      written: () => written,
    }
  }

  it('flagged in memory: returns before touching stats or the database', async () => {
    const b = statsBot(true, false)
    await b.run()
    expect(b.reads()).to.equal(0)
    expect(b.written()).to.equal(false)
  })

  it('flagged only in the database (another bot merged it): still skipped', async () => {
    const b = statsBot(false, true)
    await b.run()
    expect(b.reads()).to.equal(1)
    expect(b.written()).to.equal(false)
  })

  it('an ordinary canceled deal goes on to the stats body', async () => {
    const b = statsBot(false, false)
    let reached = false
    try {
      await b.run()
    } catch (e) {
      reached = (e as Error).message === 'reached the stats body'
    }
    expect(reached).to.equal(true)
  })

  it('an open or closed deal is never looked up', async () => {
    const bot = helper()
    bot.dealsDb = {
      readData: async () => {
        throw new Error('no read expected')
      },
    }
    expect(
      await bot.isMergedAway({ _id: DEAL_A, status: DCADealStatusEnum.closed }),
    ).to.equal(false)
  })
})

describe('spec 138 §2.2.1 — "close after X opened" does not count the merged deal', () => {
  it('counts with parent excluded', async () => {
    const bot = helper()
    let query: any = null
    bot.allowedMethods = new Set(['checkOpenedDeals'])
    bot.data = { status: BotStatusEnum.open }
    bot.getAggregatedSettings = async () => ({
      useBotController: true,
      useCloseAfterXopen: true,
      closeAfterXopen: '5',
    })
    bot.dealsDb = {
      countData: async (q: unknown) => {
        query = q
        return ok(2)
      },
    }
    await bot.checkOpenedDeals()
    expect(query.parent).to.deep.equal({ $ne: true })
    expect(query.botId).to.equal(BOT_ID)
  })
})

describe('spec 138 §2.2.2 — the DCA-usage histogram leaves the merged deal out', () => {
  it('adds parent != true to the caller match', async () => {
    let pipeline: any[] = []
    const db = {
      aggregate: async (p: any[]) => {
        pipeline = p
        return ok([])
      },
    }
    await (Bot.prototype as any).dcaUsageHistogram.call(
      {},
      db,
      { botId: BOT_ID },
      false,
    )
    expect(pipeline[0].$match).to.deep.equal({
      botId: BOT_ID,
      parent: { $ne: true },
    })
  })
})

describe('spec 138 §2.3 / §2.1.4 — mergeDeals', () => {
  const originalClose = (Bot.prototype as any).closeDCADeal
  afterEach(() => {
    ;(Bot.prototype as any).closeDCADeal = originalClose
  })

  it('emits re-pointed orders flat, and marks sources before cancelling them', async function () {
    this.timeout(10_000)
    const bot = helper()
    const log: string[] = []
    const emitted: any[] = []
    const localA = { deal: sourceDeal(DEAL_A) }
    let created: any = null
    bot.data = {
      settings: {
        strategy: 'LONG',
        pair: ['BTCUSDT'],
        tpPerc: '1',
        useTp: true,
        dealCloseCondition: 'tp',
      },
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'u',
      paperContext: true,
    }
    bot.getDeal = (id: string) => (id === DEAL_A ? localA : undefined)
    bot.dealsDb = {
      readData: async () =>
        ok([sourceDeal(DEAL_A), sourceDeal(DEAL_B, { flags: [] })]),
      createData: async (d: any) => {
        created = d
        return { status: StatusEnum.ok, data: { ...d, _id: MERGED } }
      },
      updateManyData: async (_q: unknown, u: any) => {
        log.push(`mark ${JSON.stringify(u.$set)}`)
        return ok(null)
      },
    }
    bot.db = { readData: async () => ok([{ settings: { strategy: 'LONG' } }]) }
    bot.ordersDb = {
      readData: async () =>
        ok([filled(DEAL_A, 'o1', 100), filled(DEAL_B, 'o2', 200)]),
      updateData: async () => ok(null),
    }
    bot.getExchangeInfo = async () => ({
      pair: 'BTCUSDT',
      baseAsset: { name: 'BTC' },
      quoteAsset: { name: 'USDT' },
    })
    bot.getUsdRate = async () => 1
    bot.emit = (event: string, payload: any) => {
      if (event === 'bot update') {
        emitted.push(payload)
      }
    }
    bot.createInitialDealOrders = async () => []
    bot.createCurrentDealOrders = async () => []
    bot.checkDealSlMethods = async () => undefined
    bot.setDeal = () => undefined
    bot.setCloseByTimer = async () => undefined
    bot.reloadBot = () => undefined
    ;(Bot.prototype as any).closeDCADeal = async (
      _u: string,
      _b: string,
      dealId: string,
    ) => {
      log.push(`cancel ${dealId} child=${localA.deal.child}`)
    }

    await bot.mergeDeals([DEAL_A, DEAL_B])

    const mark = `mark {"child":true,"parentId":"${MERGED}"}`
    expect(log[0]).to.equal(mark)
    expect(log[1]).to.equal(`cancel ${DEAL_A} child=true`)
    expect(log).to.include(mark, 'still re-asserted after the cancels')

    expect(emitted).to.have.length(2)
    for (const o of emitted) {
      expect(o.dealId).to.equal(MERGED)
      expect(o.botId).to.equal(BOT_ID)
      expect(o.typeOrder).to.equal(TypeOrderEnum.dealStart)
      expect(o).to.not.have.property('data')
    }

    expect(created.parent).to.equal(true)
    expect(created.childIds).to.deep.equal([DEAL_A, DEAL_B])
    expect(created.avgPrice).to.equal(150)
    expect(created.funding.offset).to.equal(created.createTime)
    // DEAL_B has no flags, so the merged deal claims none.
    expect(created.flags).to.deep.equal([])
  })
})

describe('spec 138 §2.4 — combo deals are not merged', () => {
  it('the engine refuses before reading anything', async () => {
    const bot = helper({ combo: true })
    bot.dealsDb = {
      readData: async () => {
        throw new Error('no read expected')
      },
    }
    const r = await bot.mergeDeals([DEAL_A, DEAL_B])
    expect(r.reason).to.match(/not available for combo/)
  })

  it('mergeComboDeals answers NOTOK without dispatching', async () => {
    const r = await (Bot.prototype as any).mergeComboDeals.call(
      {},
      USER_ID,
      BOT_ID,
      [DEAL_A, DEAL_B],
      false,
    )
    expect(r.status).to.equal(StatusEnum.notok)
    expect(r.reason).to.match(/not available for combo/)
  })
})
