process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `174.a-restart-never-re-sends-an-entry-that-was-never-sent`.
 *
 * The order map, restored from the Redis snapshot, holds the deal's entry
 * order at `'-1'`. Mongo has no row for it and the deal is `start`. Drives the
 * REAL `restoreWork`, the REAL `placeBaseOrder` and the REAL order map
 * (`setOrder` / `getOrdersByStatusAndDealId` / `deleteOrder`). A new entry is
 * recorded where `placeBaseOrder` builds it (`getBaseOrder`). The venue lookup
 * and Mongo are fakes.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum, TypeOrderEnum } from '../../types'

const BOT_ID = '000000000000000000000b74'
const DEAL_ID = '000000000000000000000d74'
const SYMBOL = 'GUNUSDT'
const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000

/** The entry order the snapshot holds. */
const entry = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId: 'x-BO-000000000074',
    orderId: '-1',
    botId: BOT_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    side: 'BUY',
    price: '0.0123',
    origQty: '1000',
    executedQty: '0',
    status: 'NEW',
    transactTime: TEN_MIN_AGO,
    updateTime: TEN_MIN_AGO,
    ...over,
  }) as any

const NOT_FOUND = { status: StatusEnum.notok, reason: 'Order does not exist.' }
const TIMEOUT = { status: StatusEnum.notok, reason: 'timeout of 30000ms exceeded' }
const ON_VENUE = { status: StatusEnum.ok, data: { status: 'NEW' } }

let Helper: any

const buildBot = (opts: {
  order: any
  venue: any
  /** Rows Mongo holds, matched by clientOrderId only. */
  rows?: any[]
  serviceRestart?: boolean
}) => {
  const raised = {
    built: [] as string[],
    lookups: [] as string[],
    logs: [] as string[],
  }
  const rows = opts.rows ?? []
  class TestBot extends (Helper as any) {
    raised = raised
    botId = BOT_ID
    userId = '000000000000000000000a74'
    combo = false
    loadingComplete = true
    serviceRestart = opts.serviceRestart ?? true
    secondRestart = false
    exchange = {}
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'binance',
      flags: [],
      paperContext: false,
    }
    sharedStream = { addOrder() {}, removeOrder() {} }
    // The entry has no dealStart row (§1.2.1); a row exists only when a test
    // puts one in `rows`, and is found only by its clientOrderId.
    ordersDb = {
      readData: async (q: any, _f?: any, _o?: any, isArray?: boolean) => {
        const hit = q.clientOrderId
          ? rows.filter((r) => r.clientOrderId === q.clientOrderId)
          : []
        return {
          status: StatusEnum.ok,
          data: { result: isArray ? hit : hit[0] },
        }
      },
    }
    async getOrderForReconcile(o: any) {
      raised.lookups.push(o.clientOrderId)
      return opts.venue
    }
    // `placeBaseOrder` reaching this is it building a NEW entry.
    async getBaseOrder(_s: string, dealId: string) {
      raised.built.push(dealId)
      return undefined
    }
    async closeDealById() {}
    setOrdersToRedis() {}
    shouldProceed() {
      return true
    }
    isBaseFundingDeal() {
      return false
    }
    // --- restoreWork around the start deal, stubbed to no-ops -------------
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
    getOpenDeals() {
      return [
        {
          deal: {
            _id: DEAL_ID,
            botId: BOT_ID,
            status: 'start',
            symbol: { symbol: SYMBOL },
          },
        },
      ]
    }
    getDeal() {
      return this.getOpenDeals()[0]
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
  const bot = new (TestBot as any)()
  bot.setOrder(opts.order, false)
  return bot
}

describe('a restart never re-sends an entry that was never sent (spec 174)', () => {
  before(function () {
    // One ts-node compile of the DCA mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§1.1.1 an unsent entry the venue does not know is dropped and placed exactly once', async () => {
    const bot = buildBot({ order: entry(), venue: NOT_FOUND })
    await bot.restoreWork()
    expect(bot.raised.lookups).to.deep.equal(['x-BO-000000000074'])
    expect(bot.getOrderFromMap('x-BO-000000000074')).to.equal(undefined)
    expect(bot.raised.built).to.deep.equal([DEAL_ID])
    expect(bot.raised.logs.join('\n')).to.not.contain(
      'already have and active base order',
    )
  })

  it('§1.1.2 an entry the venue confirms is never touched', async () => {
    const bot = buildBot({ order: entry(), venue: ON_VENUE })
    await bot.restoreWork()
    expect(bot.getOrderFromMap('x-BO-000000000074')).to.not.equal(undefined)
    expect(bot.raised.built, 'no second entry').to.deep.equal([])
  })

  it('§1.1.2 an ambiguous lookup leaves the entry alone', async () => {
    const bot = buildBot({ order: entry(), venue: TIMEOUT })
    await bot.restoreWork()
    expect(bot.getOrderFromMap('x-BO-000000000074')).to.not.equal(undefined)
    expect(bot.raised.built, 'no second entry').to.deep.equal([])
  })

  it('§1.1.3 an entry with a Mongo row at -1 is not retired', async () => {
    const bot = buildBot({
      order: entry(),
      venue: NOT_FOUND,
      rows: [{ _id: 'row-74', clientOrderId: 'x-BO-000000000074' }],
    })
    await bot.restoreWork()
    expect(bot.getOrderFromMap('x-BO-000000000074')).to.not.equal(undefined)
    expect(bot.raised.built, 'no second entry').to.deep.equal([])
  })

  it('§1.1.4 an entry with a real exchange id is not looked up', async () => {
    const bot = buildBot({
      order: entry({ orderId: '4400000074' }),
      venue: NOT_FOUND,
    })
    await bot.restoreWork()
    expect(bot.raised.lookups).to.deep.equal([])
    expect(bot.raised.built).to.deep.equal([])
  })

  it('§1.1.5 a user start does not reach the check', async () => {
    const bot = buildBot({
      order: entry(),
      venue: NOT_FOUND,
      serviceRestart: false,
    })
    await bot.restoreWork()
    expect(bot.raised.lookups).to.deep.equal([])
  })
})
