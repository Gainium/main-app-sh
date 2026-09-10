process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `038` — a base order left `PARTIALLY_FILLED` must
 * not strand its deal in `start`.
 *
 * Two layers:
 *
 *  - the pure decision (`shouldSettlePartialBaseEntry`), which answers "is this
 *    the last check this deal will ever get?";
 *  - the REAL `dcaHelper.checkBaseOrder`, driven over the mixin with a minimal
 *    base class, replaying the production sequence: a LIMIT base order for 1461
 *    stopped at 109 executed, and 24.7 s later the enter-market timer fired,
 *    logged `found base order with status PARTIALLY_FILLED`, and returned —
 *    having just cleared the deal's only other timer. The deal was still in
 *    `start` with cost and average price unset hours later, across a worker
 *    restart, holding a position nothing tracked.
 *
 * The settle path itself is not re-tested here: `cancelOrderOnExchange`'s
 * promotion of a cancelled-with-fills row is covered by
 * `resizeCancelPromotion.spec.ts`. What these pin is that `checkBaseOrder`
 * REACHES it, and only when nothing else is coming.
 *
 * Fixture ids are synthetic — this file is public, and the identifiers of the
 * accounts the case came from belong in the private issue.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { shouldSettlePartialBaseEntry } from './partialBaseEntry'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d38'
const BOT_ID = '000000000000000000000b38'
const USER_ID = '000000000000000000000438'
const SYMBOL = 'JSTUSDT'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000000'

/** The base order exactly as production held it, quantities verbatim. */
const baseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: '640258727',
    clientOrderId: CLIENT_ORDER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '0.10339',
    origPrice: '0.10339',
    origQty: '1461',
    executedQty: '109',
    status: 'PARTIALLY_FILLED',
    updateTime: 1789045823652,
    transactTime: 1789045823507,
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
    exchange: ExchangeEnum.binanceUsdm,
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
  /** Rows handed to `cancelOrderOnExchange`. */
  cancelled: any[]
  /** Rows that reached `startDeal` — i.e. deals that actually opened. */
  started: any[]
  /** Re-placements, the existing behaviour for a base order that never filled. */
  replaced: string[]
  warns: string[]
}

/**
 * @param dealStatus the deal's status in the worker's map.
 * @param timers what `dealTimersMap` holds for the deal: `null` reproduces a
 *   freshly started process (the restore path), an object reproduces a process
 *   that has armed timers for this deal.
 * @param order the `dealStart` row, or `null` for a deal with no base order.
 */
const buildBot = (opts: {
  dealStatus?: DCADealStatusEnum
  timers?: { limitTimer: any; enterMarketTimer: any } | null
  order?: any
  cancelAnswer?: any
}) => {
  const {
    dealStatus = DCADealStatusEnum.start,
    timers = null,
    order = baseOrder(),
    cancelAnswer,
  } = opts
  const raised: Raised = {
    cancelled: [],
    started: [],
    replaced: [],
    warns: [],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'JST', quoteAsset: 'USDT' },
      enterMarketPrice: undefined,
      dynamicAr: undefined,
      sizes: undefined,
      orderSizeType: undefined,
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
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return order ? [order] : []
    }
    /**
     * Stubbed: the promotion of a cancelled-with-fills row to `FILLED` at its
     * executed quantity is `cancelOrderOnExchange`'s own behaviour and has its
     * own tests. Default answer is what it returns for this row.
     */
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push({ ...o })
      if (cancelAnswer !== undefined) {
        return cancelAnswer
      }
      return { ...o, status: 'FILLED' }
    }
    /** The end of the chain — reached only if the deal actually opens. */
    async startDeal(o: any) {
      raised.started.push({ ...o })
    }
    async placeBaseOrder(_botId: string, _symbol: string, dealId: string) {
      raised.replaced.push(dealId)
    }
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

/** A live timer handle, so the production `clearTimeout` path really runs. */
const armed = () => setTimeout(() => undefined, 60_000)
const pending: any[] = []
const arm = () => {
  const t = armed()
  pending.push(t)
  return t
}

describe('a partly filled base order strands the deal in start (spec 038)', () => {
  afterEach(() => {
    while (pending.length) {
      clearTimeout(pending.pop())
    }
  })

  describe('§4.1 the decision', () => {
    it('settles a partly filled base order when nothing else will check it', () => {
      expect(
        shouldSettlePartialBaseEntry({
          orderStatus: 'PARTIALLY_FILLED',
          dealStatus: DCADealStatusEnum.start,
          hasPendingCheck: false,
        }),
      ).to.equal(true)
    })

    it('§4.3 leaves it alone while a further check is still scheduled', () => {
      // The reposition timer at 10 s. The enter-market check at 35 s is still
      // coming, and an entry that is 7 % filled may well complete before it.
      expect(
        shouldSettlePartialBaseEntry({
          orderStatus: 'PARTIALLY_FILLED',
          dealStatus: DCADealStatusEnum.start,
          hasPendingCheck: true,
        }),
      ).to.equal(false)
    })

    it('never re-opens a deal that is not in start', () => {
      for (const status of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.closed,
        DCADealStatusEnum.canceled,
        DCADealStatusEnum.error,
      ]) {
        expect(
          shouldSettlePartialBaseEntry({
            orderStatus: 'PARTIALLY_FILLED',
            dealStatus: status,
            hasPendingCheck: false,
          }),
          status,
        ).to.equal(false)
      }
    })

    it('is not reached for a deal with no base order, or one that never traded', () => {
      for (const orderStatus of [
        'NEW',
        'CANCELED',
        'FILLED',
        'EXPIRED',
        undefined,
      ]) {
        expect(
          shouldSettlePartialBaseEntry({
            orderStatus,
            dealStatus: DCADealStatusEnum.start,
            hasPendingCheck: false,
          }),
          `${orderStatus}`,
        ).to.equal(false)
      }
    })
  })

  describe('the real checkBaseOrder', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('§1.2 the enter-market check opens the deal on what filled', async () => {
      // The reported case: the last check any deal gets, looking at a base
      // order that stopped at 109 of 1461. Before the fix it logged the status
      // and returned, having just cleared the deal's only other timer.
      const bot: any = buildBot({
        timers: { limitTimer: arm(), enterMarketTimer: arm() },
      })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID, true)
      const raised = bot.raised as Raised
      expect(raised.cancelled.map((o) => o.clientOrderId)).to.deep.equal([
        CLIENT_ORDER_ID,
      ])
      expect(raised.started, 'deal opened').to.have.length(1)
      // Opened on the quantity the venue executed, not the quantity requested.
      expect(raised.started[0].executedQty).to.equal('109')
      expect(raised.started[0].origQty).to.equal('1461')
      expect(raised.started[0].typeOrder).to.equal(TypeOrderEnum.dealStart)
    })

    it('§4.2 the restore path recovers a deal already stranded', async () => {
      // A bot start: the process holds no timer state for the deal, so no
      // callback exists to fire. This is what heals deals stranded before the
      // fix shipped — the restore path calls with BOTH the order id and the
      // deal id, which lands in the reposition branch.
      const bot: any = buildBot({ timers: null })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, CLIENT_ORDER_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(1)
      expect(raised.started, 'deal opened').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('109')
    })

    it('§4.3 the reposition timer leaves a partial fill to keep filling', async () => {
      // Mid-flight: the enter-market check is still armed. Nothing may touch
      // the order here, or every repositioning bot changes behaviour.
      const bot: any = buildBot({
        timers: { limitTimer: null, enterMarketTimer: arm() },
      })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, CLIENT_ORDER_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.cancelled, 'nothing cancelled').to.have.length(0)
      expect(raised.started, 'deal not opened').to.have.length(0)
      expect(raised.replaced, 'nothing re-placed').to.have.length(0)
    })

    it('§4.1 a deal that is already open is never re-opened', async () => {
      const bot: any = buildBot({
        dealStatus: DCADealStatusEnum.open,
        timers: null,
      })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, CLIENT_ORDER_ID, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(0)
      expect(raised.started).to.have.length(0)
    })

    it('§4.4 a settle the venue refuses leaves the deal for the next bot start', async () => {
      const bot: any = buildBot({
        timers: { limitTimer: arm(), enterMarketTimer: arm() },
        // What `cancelOrderOnExchange` answers when the venue refuses.
        cancelAnswer: null,
      })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID, true)
      const raised = bot.raised as Raised
      expect(raised.cancelled, 'attempted').to.have.length(1)
      expect(raised.started, 'not opened').to.have.length(0)
      expect(raised.warns.join(' '), 'says so').to.contain(DEAL_ID)
    })

    it('§5 a base order that never traded still cancels and re-places', async () => {
      // The existing behaviour of both branches, unchanged.
      const bot: any = buildBot({
        order: baseOrder({ status: 'NEW', executedQty: '0' }),
        timers: { limitTimer: arm(), enterMarketTimer: arm() },
        cancelAnswer: baseOrder({ status: 'CANCELED', executedQty: '0' }),
      })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID, true)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(1)
      expect(raised.started, 'not opened').to.have.length(0)
      expect(raised.replaced, 're-placed').to.deep.equal([DEAL_ID])
    })

    it('§4.5 a hyperliquid partial fill keeps its existing exemption', async () => {
      const bot: any = buildBot({
        timers: { limitTimer: arm(), enterMarketTimer: arm() },
      })
      bot.hyperliquid = true
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID, true)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(0)
      expect(raised.started).to.have.length(0)
    })
  })
})
