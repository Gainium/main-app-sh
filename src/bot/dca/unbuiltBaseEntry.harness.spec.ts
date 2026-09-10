process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `039` — a base order that cannot be BUILT must not
 * leave its deal stranded in `start` with no order at all.
 *
 * Sibling of `partialBaseEntry.harness.spec.ts` (spec `038`): same stranded
 * shape, reached from the other side. There an order exists and stopped
 * part-filled; here `getBaseOrder` never produced one, so the deal holds
 * nothing and `placeBaseOrder` returns without rolling its own write back.
 *
 * Two layers:
 *
 *  - the pure decision (`shouldDiscardUnbuiltBaseEntry`), which answers "is this
 *    deal holding anything worth keeping?";
 *  - the REAL `dcaHelper.placeBaseOrder`, driven over the mixin with a minimal
 *    base class, replaying the production sequence: a spot DCA bot on
 *    `orderSizeType: percFree` whose balance read the venue refused, so
 *    `getBaseOrder` reported `Error getting balance: …` and returned nothing,
 *    once at deal creation and then once per worker start for 22 hours.
 *
 * Fixture ids are synthetic — this file is public, and the identifiers of the
 * account the case came from belong in the private issue.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { shouldDiscardUnbuiltBaseEntry } from './unbuiltBaseEntry'
import {
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d39'
const BOT_ID = '000000000000000000000b39'
const USER_ID = '000000000000000000000439'
const SYMBOL = 'AAVEUSDC'

/** The venue's own words, verbatim from the production log. */
const AUTH_REASON = 'Invalid API-key, IP, or permissions for action.'

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL], futures: false },
    exchange: ExchangeEnum.binance,
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
  /** `(dealId, closeType, reopen)` for every deal retired. */
  closed: Array<{ dealId: string; closeType: string; reopen: boolean }>
  /** Deals `createDeal` wrote — i.e. rows that now exist in the DB. */
  created: string[]
  /** Orders that reached the venue call. */
  sent: any[]
  /** Errors reported to the user. */
  errors: string[]
  logs: string[]
}

/**
 * @param baseOrder what `getBaseOrder` answers: `undefined` reproduces the
 *   production refusal, an order reproduces the ordinary path.
 * @param oldDealId set to reproduce the once-per-bot-start replay from
 *   `restoreWork`; left unset to reproduce a deal being opened for the first
 *   time, which is where all the stranded rows were born.
 * @param orders the order rows the engine holds for the deal.
 */
const buildBot = (opts: {
  baseOrder?: any
  oldDealId?: string
  orders?: any[]
  dealStatus?: DCADealStatusEnum
}) => {
  const {
    baseOrder,
    oldDealId,
    orders = [],
    dealStatus = DCADealStatusEnum.start,
  } = opts
  const raised: Raised = {
    closed: [],
    created: [],
    sent: [],
    errors: [],
    logs: [],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      userId: USER_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'AAVE', quoteAsset: 'USDC' },
      createTime: 1789045823507,
      settings: { useDca: true },
      action: undefined,
      sizes: undefined,
      orderSizeType: 'percFree',
      fixSize: 0,
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  class TestBot extends Helper {
    raised = raised
    exchange = {} as any
    db = { updateData: async () => undefined } as any
    ordersDb = { createData: async () => undefined } as any
    dealTimersMap = new Map<string, any>()

    async getAggregatedSettings() {
      return {
        startOrderType: 'LIMIT',
        baseOrderPrice: '0',
        useLimitPrice: false,
        futures: false,
        useDca: true,
      }
    }
    /**
     * The real one writes the deal row BEFORE the entry order exists — that
     * ordering is the whole defect, so the harness keeps it.
     */
    async createDeal() {
      raised.created.push(DEAL_ID)
      return DEAL_ID
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return orders
    }
    /**
     * Production answered `undefined` here: `getBaseOrder`'s percentage-of-
     * balance branch reports `Error getting balance: <venue reason>` through
     * `handleErrors`, which returns `Promise<void>`.
     */
    async getBaseOrder() {
      if (!baseOrder) {
        await this.handleErrors(
          `Error getting balance: ${AUTH_REASON}`,
          'placeBaseOrder',
        )
        return undefined
      }
      return baseOrder
    }
    async closeDealById(
      _botId: string,
      dealId: string,
      closeType: string,
      reopen: boolean,
    ) {
      raised.closed.push({ dealId, closeType, reopen })
    }
    async sendOrderToExchange(order: any) {
      raised.sent.push({ ...order })
      return { ...order }
    }
    updateDealLastPrices() {}
    async saveDeal() {}
    setOrder() {}
    resetPending() {}
    async handleErrors(e: string, ..._rest: unknown[]) {
      raised.errors.push(e)
    }
    handleLog(log: string) {
      raised.logs.push(log)
      return undefined
    }
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.oldDealId = oldDealId
  return bot
}

const restingBaseOrder = () =>
  ({
    symbol: SYMBOL,
    orderId: '-1',
    clientOrderId: 'D-BO-0000000000000000000000000039',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '250.1',
    origPrice: '250.1',
    origQty: '0.05',
    executedQty: '0',
    status: 'NEW',
  }) as any

describe('a base order that cannot be built strands the deal in start (spec 039)', () => {
  describe('§4 the decision', () => {
    it('§4.1 discards a start deal holding no order when the entry could not be built', () => {
      expect(
        shouldDiscardUnbuiltBaseEntry({
          baseOrderBuilt: false,
          dealStatus: DCADealStatusEnum.start,
          orderCount: 0,
        }),
      ).to.equal(true)
    })

    it('§5 never touches a deal whose entry WAS built', () => {
      expect(
        shouldDiscardUnbuiltBaseEntry({
          baseOrderBuilt: true,
          dealStatus: DCADealStatusEnum.start,
          orderCount: 0,
        }),
      ).to.equal(false)
    })

    it('§4.3 never touches a deal that holds any order row', () => {
      for (const orderCount of [1, 2, 7]) {
        expect(
          shouldDiscardUnbuiltBaseEntry({
            baseOrderBuilt: false,
            dealStatus: DCADealStatusEnum.start,
            orderCount,
          }),
          `${orderCount} rows`,
        ).to.equal(false)
      }
    })

    it('§4.3 never touches a deal that is not in start', () => {
      for (const status of [
        DCADealStatusEnum.open,
        DCADealStatusEnum.closed,
        DCADealStatusEnum.canceled,
        DCADealStatusEnum.error,
        undefined,
      ]) {
        expect(
          shouldDiscardUnbuiltBaseEntry({
            baseOrderBuilt: false,
            dealStatus: status,
            orderCount: 0,
          }),
          `${status}`,
        ).to.equal(false)
      }
    })
  })

  describe('the real placeBaseOrder', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('§1.2 a deal it just created is retired, not left in start', async () => {
      // The reported case, first occurrence: `openNewDeal` -> `placeBaseOrder`
      // with no `oldDealId`. Before the fix the deal row was written, the entry
      // refused, and the function returned — leaving a row that counts against
      // the bot's active-deal limit and cannot be closed from the dashboard.
      const bot = buildBot({})
      await bot.placeBaseOrder(BOT_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.created, 'deal row written').to.deep.equal([DEAL_ID])
      expect(raised.sent, 'nothing reached the venue').to.have.length(0)
      expect(raised.closed, 'deal retired').to.have.length(1)
      expect(raised.closed[0].dealId).to.equal(DEAL_ID)
      expect(raised.closed[0].closeType).to.equal(CloseDCATypeEnum.cancel)
      // Re-opening here would re-enter this same call for the same symbol.
      expect(raised.closed[0].reopen, 'not reopened').to.equal(false)
    })

    it('§4.2 the bot-start replay heals a deal already stranded', async () => {
      // `restoreWork` re-enters with `oldDealId` once per worker start and
      // logged `… not started yet. Place base order again` for 22 hours without
      // ever resolving the deal. This is what clears the rows stranded before
      // the fix ships — no migration needed.
      const bot = buildBot({ oldDealId: DEAL_ID })
      await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
      const raised = bot.raised as Raised
      expect(raised.created, 'no second deal row').to.have.length(0)
      expect(raised.closed, 'deal retired').to.have.length(1)
      expect(raised.closed[0].dealId).to.equal(DEAL_ID)
    })

    it('§4.4 the venue reason is still reported, and only once', async () => {
      const bot = buildBot({})
      await bot.placeBaseOrder(BOT_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.errors, 'one report').to.have.length(1)
      expect(raised.errors[0]).to.contain(AUTH_REASON)
    })

    it('§4.3 a deal that already holds an order row is left alone', async () => {
      // A base order that exists — resting, cancelled or part-filled — is a
      // history this change has no business destroying.
      const bot = buildBot({
        oldDealId: DEAL_ID,
        orders: [{ ...restingBaseOrder(), status: 'CANCELED' }],
      })
      await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
      expect((bot.raised as Raised).closed, 'nothing retired').to.have.length(0)
    })

    it('§5 an entry that CAN be built is sent, and nothing is retired', async () => {
      const bot = buildBot({ baseOrder: restingBaseOrder() })
      await bot.placeBaseOrder(BOT_ID, SYMBOL)
      const raised = bot.raised as Raised
      expect(raised.sent, 'order sent').to.have.length(1)
      expect(raised.sent[0].typeOrder).to.equal(TypeOrderEnum.dealStart)
      expect(raised.closed, 'nothing retired').to.have.length(0)
    })
  })
})
