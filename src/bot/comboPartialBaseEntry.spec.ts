process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `101.a-combo-base-entry-the-venue-cancels-part-filled-is-never-booked`.
 *
 * Drives the REAL `comboHelper.processCanceledOrder` and the REAL
 * `comboHelper.restoreWork` off the mixin, and through them the REAL
 * `settlePartialBaseEntry` → `handleUnknownOrder` → Combo `processFilledOrder`
 * chain. `startDeal` — the end of that chain, which builds the deal's orders
 * and minigrids — is recorded rather than run. The quantities are the
 * production ones: a Kraken spot MARKET entry for 2740.85313 that the venue
 * cancelled at a cumulative 2728.29486.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { OrderTypeEnum, StatusEnum, TypeOrderEnum } from '../../types'

const DEAL_ID = '000000000000000000000d01'
const BOT_ID = '000000000000000000000b01'
const SYMBOL = 'GNOT-USD'
const CLIENT_ORDER_ID = 'CMB-BO-000000000101'

const canceledBase = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId: CLIENT_ORDER_ID,
    orderId: 'OAAAAA-BBBBB-CCCCCC',
    botId: BOT_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.market,
    side: 'BUY',
    price: '0.11424',
    origPrice: '0.1083',
    origQty: '2740.85313',
    executedQty: '2728.29486',
    cummulativeQuoteQty: '311.67611',
    status: 'CANCELED',
    // Hours old, so the settle's top-up window is closed and no remainder is
    // bought: the test is about opening the deal, not topping it up.
    updateTime: 1790202264632,
    ...over,
  }) as any

let Helper: any

type Raised = {
  started: any[]
  replaced: string[]
  persisted: any[]
  events: any[]
  venueCancels: any[]
  armedNoFill: boolean
}

const buildBot = (opts: {
  dealStatus?: string
  /** What the live order map holds. */
  mapRows?: any[]
  /** Every `dealStart` row of the deal in Mongo. */
  dbRows?: any[]
  serviceRestart?: boolean
}) => {
  const {
    dealStatus = 'start',
    mapRows = [canceledBase()],
    dbRows = [],
    serviceRestart = true,
  } = opts
  const raised: Raised = {
    started: [],
    replaced: [],
    persisted: [],
    events: [],
    venueCancels: [],
    armedNoFill: false,
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'GNOT', quoteAsset: 'USD' },
      settings: {},
      profit: {},
      levels: { all: 1, complete: 0 },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  const dbQueries: any[] = []
  class TestBot extends (Helper as any) {
    raised = raised
    dbQueries = dbQueries
    botId = BOT_ID
    userId = '000000000000000000000a01'
    botType = 'combo'
    combo = true
    loadingComplete = true
    hyperliquid = false
    serviceRestart = serviceRestart
    secondRestart = false
    data: any = {
      settings: { name: 'bot', pair: [SYMBOL] },
      status: 'open',
      flags: [],
      paperContext: false,
    }
    orders = new Map<string, any>(mapRows.map((r) => [r.clientOrderId, r]))
    dealTimersMap = new Map<string, any>()
    processedFilled = new Map<string, Set<string>>()
    lastFilledOrderMap = new Map<string, any>()
    ordersDb = {
      readData: async (search: any, _f?: any, _o?: any, isArray?: boolean) => {
        dbQueries.push(search)
        if (isArray) {
          return { status: StatusEnum.ok, data: { result: dbRows } }
        }
        return {
          status: StatusEnum.ok,
          data: {
            // Honour the query the code actually sends, including a status
            // filter — that filter is what hid the row before spec 101.
            result: dbRows.find(
              (r) =>
                (search.clientOrderId === undefined ||
                  r.clientOrderId === search.clientOrderId) &&
                (search.status?.$ne === undefined ||
                  r.status !== search.status.$ne),
            ),
          },
        }
      },
    }
    botEventDb = {
      createData: async (d: any) => {
        raised.events.push(d)
        return { status: StatusEnum.ok }
      },
    }
    shouldProceed() {
      return true
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOpenDeals() {
      return [deal]
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    isOwnCancel() {
      return false
    }
    armCanceledBaseEntryDealCancel() {
      raised.armedNoFill = true
    }
    /** The end of the chain — builds the deal's orders and minigrids. */
    async startDeal(o: any) {
      raised.started.push({ ...o })
    }
    async cancelOrderOnExchange(o: any) {
      raised.venueCancels.push({ ...o })
      return { ...o, status: 'FILLED' }
    }
    async fillPartiallyFilledOrder(o: any) {
      return o
    }
    async placeBaseOrder(_b: string, _s: string, dealId: string) {
      raised.replaced.push(dealId)
    }
    updateOrderOnDb(o: any) {
      raised.persisted.push({ ...o })
    }
    emit() {
      return true
    }
    // --- restoreWork's surroundings, stubbed to no-ops ---------------------
    calculateBotDeals() {}
    async getAggregatedSettings() {
      return { type: 'regular' }
    }
    async getSymbolsToOpenAsapDeals() {
      return []
    }
    getActiveMinigrids() {
      return []
    }
    async checkOrders() {}
    async cancelAllOrder() {}
    async clearAllOrderQuarantine() {}
    updateDealLastPrices() {}
    async checkInRange() {
      return false
    }
    async openNewDeal() {}
    setRangeOrError() {}
    startTimeBasedTrigger() {}
    async startIndicatorInit() {}
    calculateBotBalances() {}
    async calculateUsage() {}
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

/** Runs the real `restoreWork`; everything past the start deals is stubbed. */
const restoreStartDeals = async (bot: any) => {
  await bot.restoreWork()
}

describe('a Combo base entry the venue cancels part filled (spec 101)', () => {
  before(function () {
    // One ts-node compile of the combo mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  describe('§4.1 the cancel callback', () => {
    it('§1.1 opens the deal on what the venue executed', async () => {
      const bot = buildBot({})
      await bot.processCanceledOrder(canceledBase(), 1790202264632, false)
      const raised = bot.raised as Raised
      expect(raised.started, 'deal opened').to.have.length(1)
      expect(raised.started[0].status).to.equal('FILLED')
      expect(raised.started[0].executedQty).to.equal('2728.29486')
      expect(raised.started[0].typeOrder).to.equal(TypeOrderEnum.dealStart)
      expect(raised.venueCancels, 'no venue round trip').to.have.length(0)
      expect(raised.persisted.map((o) => o.status)).to.deep.equal(['FILLED'])
      expect(raised.events, 'told once').to.have.length(1)
      expect(raised.armedNoFill).to.equal(false)
    })

    it('never re-opens a deal that is already open', async () => {
      const bot = buildBot({ dealStatus: 'open' })
      await bot.processCanceledOrder(canceledBase(), 1790202264632, false)
      expect((bot.raised as Raised).started).to.have.length(0)
    })

    it('§1.3 a cancel with nothing filled still takes the f4416a9 check', async () => {
      const unfilled = canceledBase({ executedQty: '0' })
      const bot = buildBot({ mapRows: [] })
      await bot.processCanceledOrder(unfilled, 1790202264632, false)
      const raised = bot.raised as Raised
      expect(raised.armedNoFill, 'deal-cancel check armed').to.equal(true)
      expect(raised.started).to.have.length(0)
      expect(raised.persisted).to.have.length(0)
    })
  })

  describe('§4.2 the restore path', () => {
    it('settles the stranded deal instead of buying again (row in the map)', async () => {
      const bot = buildBot({ dbRows: [canceledBase()] })
      await restoreStartDeals(bot)
      const raised = bot.raised as Raised
      expect(raised.replaced, 'no second base order').to.have.length(0)
      expect(raised.started, 'deal opened').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('2728.29486')
    })

    it('settles it after a cold load that left the row out of the map', async () => {
      const bot = buildBot({
        mapRows: [],
        dbRows: [canceledBase()],
        serviceRestart: false,
      })
      await restoreStartDeals(bot)
      const raised = bot.raised as Raised
      expect(raised.replaced, 'no second base order').to.have.length(0)
      expect(raised.started, 'deal opened').to.have.length(1)
    })

    it('§1.3 still re-places an entry that never traded', async () => {
      const bot = buildBot({
        mapRows: [],
        dbRows: [canceledBase({ executedQty: '0' })],
      })
      await restoreStartDeals(bot)
      const raised = bot.raised as Raised
      expect(raised.replaced).to.deep.equal([DEAL_ID])
      expect(raised.started).to.have.length(0)
    })
  })
})
