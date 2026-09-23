process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `048` — a base order the VENUE ends while it is
 * part filled must be booked into the deal, reported once, and never replayed.
 *
 * Spec `038` settled the sibling shape (a row left `PARTIALLY_FILLED`) inside
 * `checkBaseOrder`, and `checkBaseOrder` is only ever scheduled for a LIMIT
 * entry. These drive the two paths a MARKET entry actually has:
 *
 *  - `processCanceledOrder`, the order queue's cancel callback — the engine's
 *    ONLY report of the order, replaying the production sequence: a market base
 *    order for 0.20016002 that traded 0.0360993 then 0.0029 and was then
 *    cancelled by the venue at cum 0.0389993 / avg 2215.01;
 *  - `restoreWork`, which had the row filtered out of its read and therefore
 *    re-placed the entry on the next two worker starts, on top of a position
 *    the account was already holding.
 *
 * Fixture ids are synthetic — this file is public, and the identifiers of the
 * account the case came from belong in the private issue.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  isUnattributedUnfilledBaseEntryCancel,
  pickRestoreBaseEntry,
  shouldSettlePartialBaseEntry,
} from './partialBaseEntry'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  StartConditionEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d48'
const BOT_ID = '000000000000000000000b48'
const USER_ID = '000000000000000000000448'
const SYMBOL = 'ETH-EUR'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000048'

/** The cancel report exactly as production held it, quantities verbatim. */
const canceledBaseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'AAAAAA-BBBBB-CCCCCC',
    clientOrderId: CLIENT_ORDER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.market,
    side: 'BUY',
    price: '2215.01',
    origPrice: '2215.01',
    origQty: '0.20016002',
    executedQty: '0.0389993',
    cummulativeQuoteQty: '86.38391',
    status: 'CANCELED',
    updateTime: 1789416749994,
    transactTime: 1789416749862,
    ...over,
  }) as any

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL] },
    status: 'open',
    exchange: ExchangeEnum.kraken,
    paperContext: false,
    flags: [],
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  /** Rows that reached `startDeal` — i.e. deals that actually opened. */
  started: any[]
  /** Rows handed to `cancelOrderOnExchange` — a venue round trip. */
  cancelled: any[]
  /** Re-placements: buying a second time on top of the position. */
  replaced: string[]
  /** Rows written back to the orders collection. */
  persisted: any[]
  /** User-visible deal events. */
  events: any[]
  /** Take-profit partial fills recorded — the pre-existing behaviour. */
  tpRecorded: any[]
  warns: string[]
}

const buildBot = (opts: {
  dealStatus?: DCADealStatusEnum
  timers?: { limitTimer: any; enterMarketTimer: any } | null
  order?: any
  /** Every `dealStart` row the deal has, as `restoreWork` reads them. */
  dbRows?: any[]
  /** Client order ids this bot cancelled itself. */
  ownCancels?: string[]
  /** Rows `getOrdersByStatusAndDealId` returns; defaults to `[order]`. */
  liveRows?: any[]
}) => {
  const {
    dealStatus = DCADealStatusEnum.start,
    timers = null,
    order = canceledBaseOrder(),
    dbRows,
    ownCancels = [],
    liveRows,
  } = opts
  const raised: Raised = {
    started: [],
    cancelled: [],
    replaced: [],
    persisted: [],
    events: [],
    tpRecorded: [],
    warns: [],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'EUR' },
      createTime: 1789416749862,
      settings: {},
      profit: {},
      levels: { all: 12, complete: 0 },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  class TestBot extends Helper {
    raised = raised
    orders = new Map<string, any>(order ? [[order.clientOrderId, order]] : [])
    processedFilled = new Map<string, Set<string>>()
    dealTimersMap = new Map<string, any>(timers ? [[DEAL_ID, timers]] : [])
    deals = new Map<string, any>([[DEAL_ID, deal]])
    keepOrders = false
    serviceRestart = false
    secondRestart = false
    pendingClose = new Set<string>()
    botEventDb = {
      createData: async (d: any) => {
        raised.events.push(d)
        return { status: StatusEnum.ok }
      },
    }
    ordersDb = {
      readData: async (search: any, _f?: any, _o?: any, isArray?: boolean) => {
        if (isArray) {
          return { status: StatusEnum.ok, data: { result: dbRows ?? [] } }
        }
        return {
          status: StatusEnum.ok,
          data: {
            result: (dbRows ?? []).find(
              (r) => r.clientOrderId === search.clientOrderId,
            ),
          },
        }
      },
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return liveRows ?? (order ? [order] : [])
    }
    isOwnCancel(id: string) {
      return ownCancels.includes(id)
    }
    getOpenDeals() {
      return [deal]
    }
    /** The end of the chain — reached only if the deal actually opens. */
    async startDeal(o: any) {
      raised.started.push({ ...o })
    }
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push({ ...o })
      return { ...o, status: 'FILLED' }
    }
    async placeBaseOrder(_botId: string, _symbol: string, dealId: string) {
      raised.replaced.push(dealId)
    }
    async updatePartiallyFilledTP(o: any) {
      raised.tpRecorded.push({ ...o })
    }
    updateOrderOnDb(o: any) {
      raised.persisted.push({ ...o })
    }
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    emit() {
      return true
    }
    // --- restoreWork's surroundings, all stubbed to no-ops -----------------
    calculateBotDeals() {}
    async getAggregatedSettings() {
      return { type: 'regular', startCondition: StartConditionEnum.asap }
    }
    async getSymbolsToOpenAsapDeals() {
      return [SYMBOL]
    }
    async checkOrders() {}
    async cancelAllOrder() {}
    async clearAllOrderQuarantine() {}
    async closeDealById(_b: string, dealId: string) {
      raised.replaced.push(`cancelled:${dealId}`)
    }
    updateDealLastPrices() {}
    async checkInRange() {
      return false
    }
    async openNewDeal() {}
    startTimeBasedTrigger() {}
    async startIndicatorInit() {}
    calculateBotBalances() {}
    calculateUsage() {}
    setRangeOrError() {}
    // ----------------------------------------------------------------------
    handleLog() {}
    handleDebug() {}
    handleWarn(log: string) {
      raised.warns.push(log)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

describe('a venue-cancelled base entry is never booked (spec 048)', () => {
  describe('§4.1 the decision', () => {
    const terminal = {
      dealStatus: DCADealStatusEnum.start,
      executedQty: '0.0389993',
      updateTime: 1789416749994,
      hasPendingCheck: false,
    }

    it('settles a terminal base order that carries a fill', () => {
      for (const orderStatus of ['CANCELED', 'EXPIRED']) {
        expect(
          shouldSettlePartialBaseEntry({ ...terminal, orderStatus }),
          orderStatus,
        ).to.equal(true)
      }
    })

    it('ignores a terminal base order that never traded', () => {
      for (const executedQty of ['0', '0.00000000', '', null, undefined]) {
        expect(
          shouldSettlePartialBaseEntry({
            ...terminal,
            orderStatus: 'CANCELED',
            executedQty,
          }),
          `${executedQty}`,
        ).to.equal(false)
      }
    })

    it('will not book a quantity it cannot date', () => {
      // A cancel row written from a REST response can carry a bogus
      // `executedQty` alongside `updateTime: -1`; production holds such rows.
      for (const updateTime of [-1, 0, null, undefined]) {
        expect(
          shouldSettlePartialBaseEntry({
            ...terminal,
            orderStatus: 'CANCELED',
            updateTime,
          }),
          `${updateTime}`,
        ).to.equal(false)
      }
    })

    it('§4.2 leaves the order to the timer machinery that owns it', () => {
      // A reposition cancels the resting base order and re-places it. While
      // this process holds timer state for the deal, that is whose cancel this
      // is, and `checkBaseOrder` settles it.
      expect(
        shouldSettlePartialBaseEntry({
          ...terminal,
          orderStatus: 'CANCELED',
          hasPendingCheck: true,
        }),
      ).to.equal(false)
    })

    it('never re-opens a deal that is not in start', () => {
      for (const dealStatus of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.closed,
        DCADealStatusEnum.canceled,
        DCADealStatusEnum.error,
      ]) {
        expect(
          shouldSettlePartialBaseEntry({
            ...terminal,
            orderStatus: 'CANCELED',
            dealStatus,
          }),
          dealStatus,
        ).to.equal(false)
      }
    })

    it('spec 038 §4.3 is unchanged — a partial fill still waits for its check', () => {
      expect(
        shouldSettlePartialBaseEntry({
          orderStatus: 'PARTIALLY_FILLED',
          dealStatus: DCADealStatusEnum.start,
          hasPendingCheck: true,
        }),
      ).to.equal(false)
      expect(
        shouldSettlePartialBaseEntry({
          orderStatus: 'PARTIALLY_FILLED',
          dealStatus: DCADealStatusEnum.start,
          hasPendingCheck: false,
        }),
      ).to.equal(true)
    })
  })

  describe('§4.2 which row the restore path acts on', () => {
    const canceledWithFill = {
      clientOrderId: CLIENT_ORDER_ID,
      status: 'CANCELED',
      executedQty: '0.0389993',
      updateTime: 1789416749994,
    }
    const replayRow = (id: string) => ({
      clientOrderId: id,
      status: 'CANCELED',
      executedQty: '0',
      updateTime: 1789447828710,
    })

    it('finds the cancelled entry among the replays it caused', () => {
      // Exactly the production shape: the real order, plus the two base orders
      // the old read caused to be re-placed on the next two worker starts.
      expect(
        pickRestoreBaseEntry([
          canceledWithFill,
          replayRow('D-BO-replay-1'),
          replayRow('D-BO-replay-2'),
        ]),
      ).to.equal(canceledWithFill)
    })

    it('keeps the old choice wherever the old query made one', () => {
      for (const status of ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'EXPIRED']) {
        const live = { clientOrderId: 'D-BO-live', status, executedQty: '0' }
        expect(pickRestoreBaseEntry([canceledWithFill, live]), status).to.equal(
          live,
        )
      }
    })

    it('still lets an entry cancelled outright be re-placed', () => {
      expect(pickRestoreBaseEntry([replayRow('D-BO-replay-1')])).to.equal(
        undefined,
      )
      expect(pickRestoreBaseEntry([])).to.equal(undefined)
      expect(pickRestoreBaseEntry(undefined)).to.equal(undefined)
    })
  })

  describe('the real dcaHelper', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('§1.2 the cancel report opens the deal on what the venue executed', async () => {
      const bot: any = buildBot({ timers: null })
      await bot.processCanceledOrder(canceledBaseOrder(), 1789416749994, false)
      const raised = bot.raised as Raised
      expect(raised.started, 'deal opened').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('0.0389993')
      expect(raised.started[0].origQty).to.equal('0.20016002')
      expect(raised.started[0].status).to.equal('FILLED')
      expect(raised.started[0].typeOrder).to.equal(TypeOrderEnum.dealStart)
    })

    it('§4.3 settling a terminal order costs no venue round trip', async () => {
      const bot: any = buildBot({ timers: null })
      await bot.processCanceledOrder(canceledBaseOrder(), 1789416749994, false)
      const raised = bot.raised as Raised
      expect(raised.cancelled, 'nothing sent to the venue').to.have.length(0)
      // …and the row is recorded as what it is, so every later reader of the
      // deal's filled base finds it.
      expect(raised.persisted.map((o) => o.status)).to.deep.equal(['FILLED'])
      expect(raised.persisted[0].executedQty).to.equal('0.0389993')
    })

    it('§4.4 says so exactly once, and names both quantities', async () => {
      const bot: any = buildBot({ timers: null })
      await bot.processCanceledOrder(canceledBaseOrder(), 1789416749994, false)
      const raised = bot.raised as Raised
      expect(raised.events, 'one user-visible event').to.have.length(1)
      expect(raised.events[0].deal).to.equal(DEAL_ID)
      expect(raised.events[0].description).to.contain('0.0389993')
      expect(raised.events[0].description).to.contain('0.20016002')
    })

    it('§4.2 a cancel the engine itself issued is left to its timers', async () => {
      const bot: any = buildBot({
        timers: { limitTimer: null, enterMarketTimer: 1 },
      })
      await bot.processCanceledOrder(canceledBaseOrder(), 1789416749994, false)
      const raised = bot.raised as Raised
      expect(raised.started, 'not opened here').to.have.length(0)
      expect(raised.events, 'and nothing said').to.have.length(0)
    })

    it('§4.1 a deal that is already open is never re-opened', async () => {
      const bot: any = buildBot({
        dealStatus: DCADealStatusEnum.open,
        timers: null,
      })
      await bot.processCanceledOrder(canceledBaseOrder(), 1789416749994, false)
      expect((bot.raised as Raised).started).to.have.length(0)
    })

    it('an entry the venue cancelled outright is still just a cancel', async () => {
      const bot: any = buildBot({
        order: canceledBaseOrder({ executedQty: '0' }),
        timers: null,
      })
      await bot.processCanceledOrder(
        canceledBaseOrder({ executedQty: '0' }),
        1789416749994,
        false,
      )
      const raised = bot.raised as Raised
      expect(raised.started).to.have.length(0)
      expect(raised.persisted).to.have.length(0)
      expect(raised.events).to.have.length(0)
    })

    it('a cancelled take-profit keeps its own handling', async () => {
      // The behaviour this callback was written for must be untouched.
      const bot: any = buildBot({ timers: null })
      await bot.processCanceledOrder(
        canceledBaseOrder({
          clientOrderId: 'D-TP-0000000000000000000000000048',
          typeOrder: TypeOrderEnum.dealTP,
          origQty: '0.2',
          executedQty: '0.05',
        }),
        1789416749994,
        false,
      )
      const raised = bot.raised as Raised
      expect(raised.tpRecorded, 'partial TP recorded').to.have.length(1)
      expect(raised.started, 'no deal opened').to.have.length(0)
    })

    it('§1.2 restore settles the stranded deal instead of buying again', async () => {
      // The production sequence at 04:50 and 08:51: the row was filtered out of
      // the read, so the deal looked like it had never started and the entry
      // was re-placed on top of the position.
      const bot: any = buildBot({
        timers: null,
        dbRows: [
          {
            symbol: SYMBOL,
            clientOrderId: CLIENT_ORDER_ID,
            status: 'CANCELED',
            executedQty: '0.0389993',
            updateTime: 1789416749994,
          },
        ],
      })
      await bot.restoreWork()
      const raised = bot.raised as Raised
      expect(raised.replaced, 'no second base order').to.have.length(0)
      expect(raised.started, 'deal opened on what filled').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('0.0389993')
      expect(raised.events, 'told once').to.have.length(1)
    })

    it('restore still re-places an entry that never traded', async () => {
      const bot: any = buildBot({
        order: null,
        timers: null,
        dbRows: [
          {
            symbol: SYMBOL,
            clientOrderId: CLIENT_ORDER_ID,
            status: 'CANCELED',
            executedQty: '0',
            updateTime: 1789416749994,
          },
        ],
      })
      await bot.restoreWork()
      const raised = bot.raised as Raised
      expect(raised.replaced, 're-placed').to.deep.equal([DEAL_ID])
      expect(raised.started).to.have.length(0)
    })

    describe('a base order cancelled off the venue before it traded', () => {
      const unfilled = () =>
        canceledBaseOrder({
          type: OrderTypeEnum.limit,
          executedQty: '0',
          cummulativeQuoteQty: '0',
        })
      const armed = (bot: any) => {
        const timers = bot.canceledBaseEntryTimers as Map<string, any>
        const has = timers?.has(DEAL_ID) ?? false
        for (const t of timers?.values() ?? []) clearTimeout(t)
        return has
      }

      it('the decision', () => {
        const base = {
          orderStatus: 'CANCELED',
          executedQty: '0',
          dealStatus: DCADealStatusEnum.start,
          hasPendingCheck: false,
          ownCancel: false,
        }
        expect(isUnattributedUnfilledBaseEntryCancel(base)).to.equal(true)
        expect(
          isUnattributedUnfilledBaseEntryCancel({ ...base, executedQty: null }),
        ).to.equal(true)
        for (const [over, why] of [
          [{ orderStatus: 'EXPIRED' }, 'venue expiry'],
          [{ executedQty: '0.01' }, 'part filled — spec 048 settles it'],
          [{ dealStatus: DCADealStatusEnum.open }, 'deal already open'],
          [{ dealStatus: DCADealStatusEnum.canceled }, 'deal already closing'],
          [{ hasPendingCheck: true }, 'reposition timers own it'],
          [{ ownCancel: true }, 'the bot cancelled it'],
          [{ liveEntries: 1 }, 'a newer entry is resting'],
        ] as const) {
          expect(
            isUnattributedUnfilledBaseEntryCancel({ ...base, ...over }),
            why,
          ).to.equal(false)
        }
      })

      it('arms a check of the deal', async () => {
        const bot: any = buildBot({ order: unfilled(), timers: null })
        await bot.processCanceledOrder(unfilled(), 1789416749994, false)
        expect(armed(bot)).to.equal(true)
        expect((bot.raised as Raised).started).to.have.length(0)
      })

      it('does not arm when the bot cancelled it', async () => {
        const bot: any = buildBot({
          order: unfilled(),
          timers: null,
          ownCancels: [CLIENT_ORDER_ID],
        })
        await bot.processCanceledOrder(unfilled(), 1789416749994, false)
        expect(armed(bot)).to.equal(false)
      })

      it('cancels the deal instead of leaving it to be replayed', async () => {
        const bot: any = buildBot({
          order: unfilled(),
          timers: null,
          liveRows: [],
        })
        await bot.cancelDealOfCanceledBaseEntry(DEAL_ID, CLIENT_ORDER_ID)
        expect((bot.raised as Raised).replaced).to.deep.equal([
          `cancelled:${DEAL_ID}`,
        ])
      })

      it('leaves the deal alone once a new entry is resting', async () => {
        const bot: any = buildBot({
          order: unfilled(),
          timers: null,
          liveRows: [
            {
              clientOrderId: 'D-BO-newer',
              typeOrder: TypeOrderEnum.dealStart,
              status: 'NEW',
            },
          ],
        })
        await bot.cancelDealOfCanceledBaseEntry(DEAL_ID, CLIENT_ORDER_ID)
        expect((bot.raised as Raised).replaced).to.have.length(0)
      })
    })
  })
})
