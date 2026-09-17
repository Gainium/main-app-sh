process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `052` — a market base order the venue replaced with
 * a limit one is never reported (issue #789).
 *
 * Drives the REAL `dcaHelper.placeBaseOrder` over a minimal base class, with
 * `sendOrderToExchange` stubbed to answer the way a Coinbase book in limit-only
 * mode answers — the verbatim production string. The fallback that re-places
 * the base order as a LIMIT (#505, spec §4.4) must stay exactly as it is; what
 * these tests pin is that the substitution is also REPORTED.
 *
 * Both entry shapes reach the branch and both are covered (spec §2.3):
 *
 *  - `startOrderType: LIMIT`, where the forced market entry comes from the
 *    `enterMarketTimeout` path in `checkBaseOrder` (`forceMarket: true`) — the
 *    shape both production occurrences have;
 *  - `startOrderType: MARKET`, where the deal's very first base order is itself
 *    a market order (`forceMarket: false`) — 893 of the 1,034 Coinbase bots.
 *
 * `utils.sleep` is neutralised before `dcaHelper` is loaded: the branch sleeps
 * 250 ms before re-placing, and `dcaHelper` destructures `sleep` off the utils
 * default export at module-evaluation time, so the patch has to happen first.
 * That is why the helper is loaded by `createRequire` inside `before()` rather
 * than by a static import, which would be hoisted above the patch.
 *
 * The `botmessages` ROW this report has to produce is proven separately,
 * against a real database, by `limitOnlyEntryReport.harness.ts` — these tests
 * stub `processError` and can only show that it is called correctly.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import utils from '../utils'
import { limitOnlyEntryReplacedMessage } from './limitOnlyEntry'
import { limitOnlyEntryReplaced } from './utils'
import { isPerSymbolSubType } from './errorRulesCache'
import {
  ConditionLatch,
  limitOnlyEntryFallback,
  standingConditionKey,
  STANDING_CONDITION_REARM_MS,
} from './conditionLatch'
import { ExchangeEnum, OrderTypeEnum } from '../../types'

// Must run before `dcaHelper` is loaded — see the header note.
;(utils as unknown as { sleep: (ms: number) => Promise<void> }).sleep =
  async () => undefined

/**
 * Fixture ids. Synthetic on purpose — this file is public, and the identifiers
 * of the account the case came from belong in the private issue, not here.
 */
const DEAL_ID = '000000000000000000000d01'
const BOT_ID = '000000000000000000000b01'
const USER_ID = '000000000000000000000401'
const SYMBOL = 'SYND-USDC'

/** Coinbase Advanced Trade, verbatim. */
const LIMIT_ONLY_REFUSAL =
  'Orderbook is in limit only mode - please use limit order type'

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  data: any = {
    settings: { type: 'regular', pair: [SYMBOL], futures: true },
    exchange: ExchangeEnum.coinbase,
    paperContext: false,
    flags: [],
  }
  /** `MainBot`'s "this instance still owns the bot" gate — always true there. */
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  /** One entry per `processError` call — its full argument list. */
  errors: any[]
  events: any[]
  logs: string[]
  /** One entry per order handed to the venue — what type it actually was. */
  sent: string[]
}

/**
 * A bot whose venue refuses every MARKET order for limit-only mode and accepts
 * every LIMIT one, which is what a book in limit-only mode does.
 *
 * `startOrderType` decides which entry shape is under test: the base order is
 * derived as a MARKET one unless the caller asked for a LIMIT (`forceLimit`),
 * exactly as `getBaseOrder` does.
 */
const buildBot = (startOrderType: OrderTypeEnum) => {
  const raised: Raised = { errors: [], events: [], logs: [], sent: [] }
  class TestBot extends Helper {
    raised = raised
    exchange = {}
    slippageRetry = 5
    dealTimersMap = new Map()
    startTimeoutTime = new Map()
    standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)

    async getAggregatedSettings() {
      return { startOrderType, useLimitPrice: false, baseOrderPrice: '0' }
    }
    getDeal() {
      return { deal: { _id: DEAL_ID, status: 'start', createTime: 1 } }
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async getBaseOrder(
      _symbol: string,
      _dealId: string,
      forceMarket: boolean,
      _p: any,
      _count: number,
      _fixSize: number,
      _sizes: any,
      _orderSizeType: any,
      forceLimit: boolean,
    ) {
      // `getBaseOrder`'s real rule, reduced to what this branch depends on: a
      // LIMIT only when the caller forced one, otherwise the bot's configured
      // type (and MARKET whenever the enter-market path forced one).
      const type = forceLimit
        ? OrderTypeEnum.limit
        : forceMarket
          ? OrderTypeEnum.market
          : startOrderType
      return {
        clientOrderId: `D-BASE-${type}`,
        type,
        typeOrder: 'dealStart',
        origQty: '100',
        price: '0.0066',
        side: 'BUY',
        symbol: SYMBOL,
        dealId: DEAL_ID,
      }
    }
    async sendOrderToExchange(order: any) {
      raised.sent.push(order.type)
      if (order.type === OrderTypeEnum.market) {
        return LIMIT_ONLY_REFUSAL
      }
      return { ...order, status: 'NEW' }
    }
    botEventDb = {
      createData: async (row: any) => {
        raised.events.push(row)
        return { status: 'OK', data: { _id: 'e1' } }
      },
    }
    async processError(...args: any[]) {
      raised.errors.push(args)
    }
    updateDealLastPrices() {}
    async saveDeal() {}
    handleLog(log: string) {
      raised.logs.push(log)
    }
    handleDebug() {}
    handleWarn() {}
    handleError() {}
    async handleErrors() {}
    async handleOrderErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    resetPending() {}
    async closeDealById() {}
    async startDeal() {}
    setOrder() {}
    ordersDb = { createData: async () => ({ status: 'OK' }) }
  }
  return new TestBot()
}

/**
 * One pass through the branch. `forceMarket` distinguishes the two entry
 * shapes: the `enterMarketTimeout` path forces one, a MARKET-entry bot's first
 * base order does not need to.
 */
const enter = async (bot: any, forceMarket: boolean) => {
  await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID, forceMarket)
  // The re-place is deliberately not awaited by the branch (awaiting would
  // deadlock on its own mutex), so let the microtask queue drain.
  await new Promise((r) => setTimeout(r, 0))
}

describe('a substituted limit entry is never reported (spec 052)', () => {
  describe('§4.1 the message', () => {
    it('names the pair, the substitution and the settings to change', () => {
      const message = limitOnlyEntryReplacedMessage(SYMBOL, DEAL_ID)
      expect(message).to.contain(SYMBOL)
      expect(message).to.contain(DEAL_ID)
      // The three things spec §1.1 requires it to say.
      expect(message.toLowerCase()).to.contain('limit-only')
      expect(message).to.contain('LIMIT')
      expect(message.toLowerCase()).to.contain('entry settings')
    })

    it('is not claimable by errorDict, which matches on message text', () => {
      // The subType is raised by calling `processError` directly, so the text
      // must not collide with a dict key that would relabel it if it ever went
      // through `handleErrors` — the `trailingCloseFailedMessage` precaution.
      const message = limitOnlyEntryReplacedMessage(SYMBOL, DEAL_ID)
      expect(message).to.not.contain('was left open on the exchange')
    })

    // Spec §4.3. `errorRulesCache` cannot import `bot/utils` — `bot/utils`
    // imports IT — so the subType is spelled out there by hand. This is the
    // guard on that duplication: rename the constant without editing the set
    // and the per-contract coalescing silently stops applying.
    it('is coalesced per contract, not per bot', () => {
      expect(isPerSymbolSubType(limitOnlyEntryReplaced)).to.equal(true)
    })
  })

  describe('§4.2 the engine', () => {
    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('./dcaHelper').default(FakeBase as any)
    })

    // Spec §2.3: the shape both production occurrences have.
    it('a LIMIT-entry bot forced to market reports the substitution', async () => {
      const bot: any = buildBot(OrderTypeEnum.limit)
      await enter(bot, true)

      expect(bot.raised.errors, 'notification').to.have.length(1)
      const [, subType, , setError, sendError, , , , force, symbol] =
        bot.raised.errors[0]
      expect(subType).to.equal(limitOnlyEntryReplaced)
      // The entry succeeded as a LIMIT — this must not error-state the bot.
      expect(setError, 'setError').to.equal(false)
      expect(sendError, 'sendError').to.equal(true)
      // The per-deal latch is the rate limit; the per-(bot, subType) re-raise
      // backoff on top of it would swallow the next deal's FIRST report.
      expect(force, 'force').to.equal(true)
      expect(symbol, 'symbol').to.equal(SYMBOL)
    })

    // Spec §2.3: 893 of the 1,034 Coinbase bots.
    it('a MARKET-entry bot reports the substitution', async () => {
      const bot: any = buildBot(OrderTypeEnum.market)
      await enter(bot, false)

      expect(bot.raised.errors, 'notification').to.have.length(1)
      expect(bot.raised.errors[0][1]).to.equal(limitOnlyEntryReplaced)
    })

    it('the report reaches the bot event feed too, as a warning', async () => {
      const bot: any = buildBot(OrderTypeEnum.market)
      await enter(bot, false)

      expect(bot.raised.events, 'bot event').to.have.length(1)
      expect(bot.raised.events[0].deal).to.equal(DEAL_ID)
      expect(bot.raised.events[0].symbol).to.equal(SYMBOL)
      expect(bot.raised.events[0].type).to.equal('warning')
    })

    // Spec §4.4 — #505 must keep working.
    it('still re-places the base order as a LIMIT', async () => {
      const bot: any = buildBot(OrderTypeEnum.market)
      await enter(bot, false)

      expect(bot.raised.sent, 'orders sent').to.deep.equal([
        OrderTypeEnum.market,
        OrderTypeEnum.limit,
      ])
      expect(bot.raised.logs.join(' ')).to.contain('limit only mode')
    })

    // Spec §2.4 / §4.2 — the reposition timer re-enters this branch once per
    // tick for as long as the book stays in limit-only mode.
    it('reports once per deal, not once per reposition tick', async () => {
      const bot: any = buildBot(OrderTypeEnum.market)
      for (let tick = 0; tick < 10; tick++) {
        await enter(bot, false)
      }

      expect(
        bot.raised.sent.filter((t: string) => t === OrderTypeEnum.market),
      ).to.have.length(10)
      expect(bot.raised.errors, 'notifications over 10 ticks').to.have.length(1)
      expect(bot.raised.events, 'bot events over 10 ticks').to.have.length(1)
    })

    it('a second deal on the same bot reports in its own right', async () => {
      const bot: any = buildBot(OrderTypeEnum.market)
      await enter(bot, false)
      // A different deal is a different occurrence: the user has to act on it
      // separately, so the first deal's latch must not swallow it.
      bot.standingConditionLatch.clear(
        standingConditionKey(limitOnlyEntryFallback, DEAL_ID),
      )
      await enter(bot, false)

      expect(bot.raised.errors).to.have.length(2)
    })
  })
})
