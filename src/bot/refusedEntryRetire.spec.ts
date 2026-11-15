process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `241` — a refused first entry leaves the deal open,
 * holding nothing.
 *
 * Drives the REAL `dcaHelper.placeBaseOrder` and the REAL
 * `retireStrandedStartDeal` over a minimal base class. `sendOrderToExchange` is
 * stubbed to answer with a venue refusal, which is the string it hands back to
 * `placeBaseOrder` (`returnError: true`) after it has already written the base
 * row off as `CANCELED`/`'-1'`. The deal and order collections are in-memory
 * fakes that record every write, so the tests can see the `status: start`
 * filter on the deal write and what the DB-side predicate read.
 *
 * `utils.sleep` is neutralised before `dcaHelper` is loaded, for the same reason
 * `limitOnlyEntryReport.spec.ts` gives: the retry branches sleep, and
 * `dcaHelper` destructures `sleep` at module-evaluation time.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import utils from '../utils'
import {
  isRetirableStrandedStart,
  shouldRetireRefusedEntry,
  STRANDED_START_GRACE_MS,
} from './dca/strandedStartClose'
import {
  ConditionLatch,
  STANDING_CONDITION_REARM_MS,
} from './conditionLatch'
import { DCADealStatusEnum, ExchangeEnum, OrderTypeEnum } from '../../types'

// Must run before `dcaHelper` is loaded — see the header note.
;(utils as unknown as { sleep: (ms: number) => Promise<void> }).sleep =
  async () => undefined

/** Synthetic ids — this file is public. */
const DEAL_ID = '000000000000000000000d41'
const BOT_ID = '000000000000000000000b41'
const USER_ID = '000000000000000000000441'
const SYMBOL = 'EWZUSDT'

/** Verbatim venue refusals of the shapes measured in spec §2. */
const AGREEMENT_REFUSAL =
  'You must sign the required agreement before trading this contract.'
const BALANCE_REFUSAL = 'Account has insufficient balance for requested action.'
const TIMEOUT_REFUSAL = 'timeout of 5000ms exceeded'
const READ_BACK_MISS = 'Order does not exist.'

const UNACKED_BASE_ROW = {
  orderId: '-1',
  status: 'CANCELED',
  executedQty: '0',
  origQty: '10',
  typeOrder: 'dealStart',
}

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.binanceUsdm,
    paperContext: false,
    flags: [],
    deals: { all: 1, active: 1 },
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Options = {
  /** What the venue answers the base order with. */
  answer: string
  /** The bot's type. */
  type?: 'regular' | 'terminal'
  /** Extra fields on the in-map deal (e.g. `startBlocked`). */
  deal?: Record<string, unknown>
  /** The order rows the database holds for the deal. */
  rows?: Record<string, unknown>[]
  /** The status the DATABASE holds for the deal. */
  dbStatus?: string
  /** `placeBaseOrder`'s `count` (slippage-ladder rung). */
  count?: number
}

const buildBot = (opts: Options) => {
  const seen = {
    dealWrites: [] as { filter: any; update: any }[],
    deleted: [] as string[],
    events: [] as any[],
    orderErrors: [] as string[],
    sent: [] as string[],
    stopped: 0,
    closeById: 0,
    restored: 0,
  }
  const createTime = Date.now() - 1000
  const mapDeal: any = {
    deal: {
      _id: DEAL_ID,
      status: DCADealStatusEnum.start,
      createTime,
      symbol: { symbol: SYMBOL },
      ...(opts.deal ?? {}),
    },
  }
  const deals = new Map<string, any>([[DEAL_ID, mapDeal]])
  class TestBot extends Helper {
    seen = seen
    deals = deals
    exchange = {}
    slippageRetry = 5
    dealTimersMap = new Map()
    startTimeoutTime = new Map()
    standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)

    async getAggregatedSettings() {
      return {
        startOrderType: OrderTypeEnum.market,
        useLimitPrice: false,
        baseOrderPrice: '0',
      }
    }
    getDeal(id: string) {
      return deals.get(`${id}`)
    }
    deleteDeal(id: string) {
      seen.deleted.push(id)
      deals.delete(`${id}`)
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async getBaseOrder() {
      return {
        clientOrderId: 'D-BASE-1',
        type: OrderTypeEnum.market,
        typeOrder: 'dealStart',
        origQty: '10',
        price: '30',
        side: 'BUY',
        symbol: SYMBOL,
        dealId: DEAL_ID,
      }
    }
    async sendOrderToExchange(order: any) {
      seen.sent.push(order.type)
      return opts.answer
    }
    dealsDb = {
      readData: async () => ({
        status: 'OK',
        data: {
          result: {
            _id: DEAL_ID,
            status: opts.dbStatus ?? DCADealStatusEnum.start,
            createTime,
            symbol: { symbol: SYMBOL },
          },
        },
      }),
      updateData: async (filter: any, update: any) => {
        seen.dealWrites.push({ filter, update })
        // The real write is filtered on `status: start`: it matches nothing
        // once the database has moved the deal on.
        const matches =
          (opts.dbStatus ?? DCADealStatusEnum.start) === filter.status
        return { status: 'OK', data: matches ? { _id: DEAL_ID } : null }
      },
    }
    ordersDb = {
      readData: async () => ({
        status: 'OK',
        data: { result: opts.rows ?? [UNACKED_BASE_ROW] },
      }),
      createData: async () => ({ status: 'OK' }),
    }
    botEventDb = {
      createData: async (row: any) => {
        seen.events.push(row)
        return { status: 'OK', data: { _id: 'e1' } }
      },
    }
    async updateData() {}
    emit() {}
    async handleOrderErrors(reason: string) {
      seen.orderErrors.push(reason)
    }
    async stop() {
      seen.stopped++
    }
    async closeDealById() {
      seen.closeById++
    }
    restoreFromRangeOrError() {
      seen.restored++
    }
    async clearDealTimer() {}
    async checkDealsAllowedMethods() {}
    async updateUsage() {}
    resetAssets() {}
    async processError() {}
    updateDealLastPrices() {}
    async saveDeal() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleError() {}
    async handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    resetPending() {}
    async startDeal() {}
    setOrder() {}
    checkUnfilledBaseEntryCancel() {}
    armBaseRepositionTick() {}
  }
  const bot: any = new TestBot()
  bot.data.settings.type = opts.type ?? 'regular'
  bot.data.deals = { all: 1, active: 1 }
  return bot
}

const enter = async (bot: any, count = 0) => {
  await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID, false, false, count)
  // Retries and the retire are allowed to run off the awaited path.
  await new Promise((r) => setTimeout(r, 0))
}

const cancelledNow = (bot: any) => {
  const w = bot.seen.dealWrites.find(
    (x: any) => x.update?.$set?.status === DCADealStatusEnum.canceled,
  )
  return w
}

describe('a refused first entry leaves the deal open, holding nothing (spec 241)', () => {
  describe('§4.1 the grace is a parameter, its default unchanged', () => {
    const now = Date.now()
    const base = {
      dealStatus: DCADealStatusEnum.start,
      createTime: now - 1000,
      now,
      orders: [UNACKED_BASE_ROW],
    }
    it('a one-second-old deal is not retirable under the default grace', () => {
      expect(isRetirableStrandedStart(base)).to.equal(false)
      expect(STRANDED_START_GRACE_MS).to.equal(24 * 60 * 60 * 1000)
    })
    it('it is retirable with no grace', () => {
      expect(isRetirableStrandedStart({ ...base, graceMs: 0 })).to.equal(true)
    })
    it('no grace does not relax the row test', () => {
      expect(
        isRetirableStrandedStart({
          ...base,
          graceMs: 0,
          orders: [{ ...UNACKED_BASE_ROW, orderId: '991' }],
        }),
      ).to.equal(false)
    })
  })

  describe('§4.2 which refusals retire the deal', () => {
    const base = {
      reason: AGREEMENT_REFUSAL,
      terminal: false,
      dealStatus: DCADealStatusEnum.start,
      retryScheduled: false,
      fundingHold: false,
    }
    it('a definitive refusal on a start deal does', () => {
      expect(shouldRetireRefusedEntry(base)).to.equal(true)
      expect(
        shouldRetireRefusedEntry({ ...base, reason: BALANCE_REFUSAL }),
      ).to.equal(true)
    })
    it('an ambiguous outcome does not', () => {
      for (const reason of [TIMEOUT_REFUSAL, READ_BACK_MISS, '', 'ECONNRESET']) {
        expect(shouldRetireRefusedEntry({ ...base, reason }), reason).to.equal(
          false,
        )
      }
    })
    it('a terminal bot, a scheduled retry, a funding hold or a non-start deal does not', () => {
      expect(shouldRetireRefusedEntry({ ...base, terminal: true })).to.equal(
        false,
      )
      expect(
        shouldRetireRefusedEntry({ ...base, retryScheduled: true }),
      ).to.equal(false)
      expect(shouldRetireRefusedEntry({ ...base, fundingHold: true })).to.equal(
        false,
      )
      for (const dealStatus of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.canceled,
        undefined,
      ]) {
        expect(
          shouldRetireRefusedEntry({ ...base, dealStatus } as any),
          `${dealStatus}`,
        ).to.equal(false)
      }
    })
  })

  describe('§4.3–§4.7 the engine', () => {
    before(function () {
      this.timeout(180000)
      Helper = loadModule('./dcaHelper').default(FakeBase as any)
    })

    it('§4.3 an agreement refusal cancels the deal now', async () => {
      const bot = buildBot({ answer: AGREEMENT_REFUSAL })
      await enter(bot)

      expect(bot.seen.orderErrors, 'still reported').to.deep.equal([
        AGREEMENT_REFUSAL,
      ])
      const write = cancelledNow(bot)
      expect(write, 'deal cancelled').to.not.equal(undefined)
      expect(write.filter.status, 'write filtered on start').to.equal(
        DCADealStatusEnum.start,
      )
      expect(bot.seen.deleted, 'dropped from the map').to.deep.equal([DEAL_ID])
      expect(bot.data.deals.active, 'active counter').to.equal(0)
      expect(bot.data.deals.all, 'all counter untouched').to.equal(1)
      expect(bot.seen.events.length, 'user told').to.equal(1)
    })

    it('§4.3 a balance refusal cancels the deal now', async () => {
      const bot = buildBot({ answer: BALANCE_REFUSAL })
      await enter(bot)
      expect(cancelledNow(bot)).to.not.equal(undefined)
    })

    it('§4.7 the bot status is not restored and no deal is reopened', async () => {
      const bot = buildBot({ answer: AGREEMENT_REFUSAL })
      await enter(bot)
      expect(bot.seen.restored).to.equal(0)
      expect(bot.seen.closeById).to.equal(0)
    })

    it('§4.4 a timeout keeps the deal', async () => {
      const bot = buildBot({ answer: TIMEOUT_REFUSAL })
      await enter(bot)
      expect(cancelledNow(bot)).to.equal(undefined)
      expect(bot.seen.deleted).to.deep.equal([])
      expect(bot.data.deals.active).to.equal(1)
    })

    it('§4.4 a placement read-back miss keeps the deal', async () => {
      const bot = buildBot({ answer: READ_BACK_MISS })
      await enter(bot)
      expect(cancelledNow(bot)).to.equal(undefined)
    })

    it('§4.5 a scheduled Quantitative-Rules retry keeps the deal', async () => {
      const bot = buildBot({
        answer: 'Order placement prohibited due to quantitative rules',
        deal: {
          startBlocked: { retryAfter: Date.now() + 60_000, subType: 'x' },
        },
      })
      await enter(bot)
      expect(cancelledNow(bot)).to.equal(undefined)
      expect(bot.seen.deleted).to.deep.equal([])
    })

    it('§4.6 a row the venue acknowledged keeps the deal and its counter', async () => {
      const bot = buildBot({
        answer: AGREEMENT_REFUSAL,
        rows: [UNACKED_BASE_ROW, { ...UNACKED_BASE_ROW, orderId: '991' }],
      })
      await enter(bot)
      expect(cancelledNow(bot)).to.equal(undefined)
      expect(bot.seen.deleted).to.deep.equal([])
      expect(bot.data.deals.active).to.equal(1)
    })

    it('§4.3 a deal the database moved on keeps the map and the counter', async () => {
      const bot = buildBot({
        answer: AGREEMENT_REFUSAL,
        dbStatus: DCADealStatusEnum.open,
      })
      await enter(bot)
      expect(bot.seen.deleted).to.deep.equal([])
      expect(bot.data.deals.active).to.equal(1)
    })

    it('§1.3 the slippage ladder still retries instead', async () => {
      const bot = buildBot({ answer: "Order's notional must be no smaller" })
      await enter(bot, 0)
      // The ladder re-enters placeBaseOrder (fire-and-forget) at count 1..5;
      // only the last rung reaches the refusal branch.
      expect(bot.seen.sent.length, 'retried').to.be.greaterThan(1)
    })

    it('§1.3 a terminal bot still stops instead', async () => {
      const bot = buildBot({ answer: AGREEMENT_REFUSAL, type: 'terminal' })
      await enter(bot)
      expect(bot.seen.stopped).to.equal(1)
      expect(cancelledNow(bot)).to.equal(undefined)
    })
  })
})
