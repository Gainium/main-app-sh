process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `103`. A LIMIT base entry is repositioned to the
 * price it already rests at, and a part-filled one is never looked at again.
 *
 * Production case: a paper Kraken bot with a LIMIT entry, the "Enter Market
 * Timeout" switch off, and repositioning on. On an illiquid pair one deal's
 * base order was cancelled and re-placed 1286 times at the same price over
 * 3.5 h. Another deal's base order stopped at 3000 of 3657.86 and was left
 * in `start` for 65 minutes, until a worker restart's restore path settled it.
 *
 * Two layers: the pure decisions, and the REAL `dcaHelper.checkBaseOrder`
 * driven over the mixin with a minimal base class. The fixture shape follows
 * `partialBaseEntry.harness.spec.ts`.
 *
 * Fixture ids are synthetic: this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  repositionKeepsRestingBaseEntry,
  repositionTickDue,
} from './baseEntryReposition'
import { shouldTopUpSettledBaseEntry } from './partialBaseEntry'
import { MathHelper } from '../../utils/math'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  StartConditionEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d03'
const BOT_ID = '000000000000000000000b03'
const USER_ID = '000000000000000000000403'
const SYMBOL = 'BERT-USD'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000103'
const RESTING_PRICE = '0.015426'

const restingOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'OAAAAA-BBBBB-CCCCCC',
    clientOrderId: CLIENT_ORDER_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: RESTING_PRICE,
    origPrice: RESTING_PRICE,
    origQty: '1401.6336',
    executedQty: '0',
    status: 'NEW',
    updateTime: Date.now() - 10_000,
    transactTime: Date.now() - 10_000,
    ...over,
  }) as any

/** The second production deal: 3000 of 3657.86, seconds ago. */
const partialOrder = (over: Record<string, unknown> = {}) =>
  restingOrder({
    price: '0.005911',
    origPrice: '0.005911',
    origQty: '3657.85823041',
    executedQty: '3000',
    status: 'PARTIALLY_FILLED',
    updateTime: Date.now() - 2_000,
    ...over,
  })

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  data: any = {
    settings: {
      type: 'regular',
      pair: [SYMBOL],
      notUseLimitReposition: false,
    },
    exchange: ExchangeEnum.paperKraken,
    paperContext: true,
    flags: [],
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const pending: any[] = []
const arm = () => {
  const t = setTimeout(() => undefined, 60_000)
  pending.push(t)
  return t
}

type Raised = {
  cancelled: any[]
  replaced: string[]
  started: any[]
  toppedUp: any[]
}

const buildBot = (opts: {
  order?: any
  /** `null` = a freshly started process (the restore path). */
  timers?: { limitTimer: any; enterMarketTimer: any } | null
  latestPrice?: number
  startOrderType?: OrderTypeEnum
  /** `0` = the "Enter Market Timeout" switch is off (spec `100`). */
  enterMarketTimeout?: number
}) => {
  const {
    order = restingOrder(),
    timers = { limitTimer: null, enterMarketTimer: null },
    latestPrice = 0.0154261,
    startOrderType = OrderTypeEnum.limit,
    enterMarketTimeout = 0,
  } = opts
  const raised: Raised = {
    cancelled: [],
    replaced: [],
    started: [],
    toppedUp: [],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.start,
      symbol: { symbol: SYMBOL, baseAsset: 'BERT', quoteAsset: 'USD' },
      createTime: Date.now() - 60_000,
      settings: {},
      profit: {},
      levels: { all: 5, complete: 0 },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  class TestBot extends Helper {
    raised = raised
    math = new MathHelper()
    orderLimitRepositionTimeout = 10_000
    enterMarketTimeout = enterMarketTimeout
    limitFallbackTimeout = enterMarketTimeout || 35_000
    startTimeoutTime = new Map<string, number>()
    orders = new Map<string, any>([[order.clientOrderId, order]])
    processedFilled = new Map<string, Set<string>>()
    dealTimersMap = new Map<string, any>(timers ? [[DEAL_ID, timers]] : [])
    botEventDb = { createData: async () => ({ status: 'OK' }) }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return [order]
    }
    async getLatestPrice() {
      return latestPrice
    }
    async getExchangeInfo() {
      return {
        priceAssetPrecision: 6,
        baseAsset: { name: 'BERT' },
        quoteAsset: { name: 'USD' },
      }
    }
    async getAggregatedSettings() {
      return {
        type: 'regular',
        startOrderType,
        startCondition: StartConditionEnum.asap,
      }
    }
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push({ ...o })
      return +o.executedQty > 0
        ? { ...o, status: 'FILLED' }
        : { ...o, status: 'CANCELED' }
    }
    async placeBaseOrder(_botId: string, _symbol: string, dealId: string) {
      raised.replaced.push(dealId)
    }
    async startDeal(o: any) {
      raised.started.push({ ...o })
    }
    async fillPartiallyFilledOrder(o: any) {
      raised.toppedUp.push({ ...o })
      return { ...o, executedQty: o.origQty }
    }
    async updateOrderOnDb() {}
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    emit() {
      return true
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

describe('a LIMIT base entry is repositioned to the price it already rests at (spec 103)', () => {
  afterEach(() => {
    while (pending.length) {
      clearTimeout(pending.pop())
    }
  })

  describe('§4.1/§4.2 the decision', () => {
    const same = {
      orderStatus: 'NEW',
      orderType: OrderTypeEnum.limit,
      restingPrice: RESTING_PRICE,
      startOrderType: OrderTypeEnum.limit,
      repositionPrice: 0.015426,
    }
    it('§4.1 keeps a LIMIT entry whose price would not change', () => {
      expect(repositionKeepsRestingBaseEntry(same)).to.equal(true)
    })
    it('§4.2 re-places once the price has moved', () => {
      expect(
        repositionKeepsRestingBaseEntry({ ...same, repositionPrice: 0.015427 }),
      ).to.equal(false)
    })
    it('§4.2 a market-entry bot’s substituted LIMIT is never a no-op', () => {
      expect(
        repositionKeepsRestingBaseEntry({
          ...same,
          startOrderType: OrderTypeEnum.market,
        }),
      ).to.equal(false)
    })
    it('§4.2 an unreadable price is not evidence that nothing moved', () => {
      for (const repositionPrice of [0, NaN, undefined, null]) {
        expect(
          repositionKeepsRestingBaseEntry({ ...same, repositionPrice }),
          `${repositionPrice}`,
        ).to.equal(false)
      }
    })
    it('§4.2 only a row still resting untouched', () => {
      for (const orderStatus of ['PARTIALLY_FILLED', 'CANCELED', 'FILLED']) {
        expect(
          repositionKeepsRestingBaseEntry({ ...same, orderStatus }),
          orderStatus,
        ).to.equal(false)
      }
    })
    it('the reposition window: indefinite with the switch off', () => {
      expect(
        repositionTickDue({
          enterMarketTimeout: 0,
          repositionTimeout: 10_000,
          startedAt: 0,
          now: 10 * 3600_000,
        }),
      ).to.equal(true)
    })
    it('the reposition window: closes before the enter-market timer', () => {
      const base = {
        enterMarketTimeout: 35_000,
        repositionTimeout: 10_000,
        startedAt: 0,
      }
      expect(repositionTickDue({ ...base, now: 20_000 })).to.equal(true)
      expect(repositionTickDue({ ...base, now: 25_000 })).to.equal(false)
    })
    it('§4.4 no top-up at market for a bot that may not enter at market', () => {
      const live = {
        executedQty: '3000',
        origQty: '3657.85823041',
        updateTime: 1_000_000,
        now: 1_002_000,
        entryWindowMs: 45_000,
      }
      expect(shouldTopUpSettledBaseEntry(live)).to.equal(true)
      expect(
        shouldTopUpSettledBaseEntry({ ...live, marketEntryAllowed: false }),
      ).to.equal(false)
    })
  })

  describe('the real checkBaseOrder', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    const tick = (bot: any) =>
      bot.checkBaseOrder(BOT_ID, SYMBOL, CLIENT_ORDER_ID, DEAL_ID)

    it('§1.2.1/§4.1 an unchanged price keeps the order and re-arms the tick', async () => {
      const bot: any = buildBot({})
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.cancelled, 'not cancelled').to.have.length(0)
      expect(raised.replaced, 'not re-placed').to.have.length(0)
      const timer = bot.dealTimersMap.get(DEAL_ID).limitTimer
      expect(timer, 'reposition tick re-armed').to.not.equal(null)
      pending.push(timer)
    })

    it('§4.2 a moved price still cancels and re-places', async () => {
      const bot: any = buildBot({ latestPrice: 0.0154271 })
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(1)
      expect(raised.replaced).to.deep.equal([DEAL_ID])
    })

    it('§4.2 the restore path is unchanged', async () => {
      const bot: any = buildBot({ timers: null })
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(1)
      expect(raised.replaced).to.deep.equal([DEAL_ID])
    })

    it('§4.2 a market-entry bot’s substituted LIMIT still re-places', async () => {
      const bot: any = buildBot({ startOrderType: OrderTypeEnum.market })
      await tick(bot)
      expect((bot.raised as Raised).replaced).to.deep.equal([DEAL_ID])
    })

    it('§4.1 past the enter-market window the order is kept and not re-armed', async () => {
      // Switch on, 35 s: the enter-market timer owns the order from here.
      const bot: any = buildBot({
        enterMarketTimeout: 35_000,
        timers: { limitTimer: null, enterMarketTimer: arm() },
      })
      bot.startTimeoutTime.set(DEAL_ID, Date.now() - 30_000)
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(0)
      expect(bot.dealTimersMap.get(DEAL_ID).limitTimer).to.equal(null)
    })

    it('§1.2.2/§4.3 switch off: a part-filled entry is settled by the tick', async () => {
      const bot: any = buildBot({ order: partialOrder() })
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.cancelled, 'remainder cancelled').to.have.length(1)
      expect(raised.started, 'deal opened').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('3000')
      // §4.4 / #866: nothing is bought at market for this bot.
      expect(raised.toppedUp, 'no market top-up').to.have.length(0)
    })

    it('§4.3 switch on: a part-filled entry keeps filling until enter-market', async () => {
      const bot: any = buildBot({
        order: partialOrder(),
        enterMarketTimeout: 35_000,
        timers: { limitTimer: null, enterMarketTimer: arm() },
      })
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.cancelled).to.have.length(0)
      expect(raised.started).to.have.length(0)
    })

    it('§4.4 switch on: the enter-market settle still tops up (spec 057)', async () => {
      const bot: any = buildBot({
        order: partialOrder(),
        enterMarketTimeout: 35_000,
        timers: { limitTimer: arm(), enterMarketTimer: arm() },
      })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID, true)
      expect((bot.raised as Raised).toppedUp).to.have.length(1)
    })

    it('§4.4 switch off: a fresh settle on the restore path is not topped up', async () => {
      const bot: any = buildBot({ order: partialOrder(), timers: null })
      await tick(bot)
      const raised = bot.raised as Raised
      expect(raised.started).to.have.length(1)
      expect(raised.toppedUp).to.have.length(0)
    })

    it('§4.4 a market-entry bot is still topped up', async () => {
      const bot: any = buildBot({
        order: partialOrder(),
        timers: null,
        startOrderType: OrderTypeEnum.market,
      })
      await tick(bot)
      expect((bot.raised as Raised).toppedUp).to.have.length(1)
    })
  })
})
