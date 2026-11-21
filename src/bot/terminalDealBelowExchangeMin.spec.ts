process.env.NODE_ENV = 'testing'

/**
 * Spec 246: a terminal deal the exchange minimum refuses stops its bot, as the
 * balance and base-order refusals of a terminal deal already do. Before, the
 * refusal returned and left the terminal bot `open` with no deal, holding its
 * bot credits and listed nowhere.
 *
 * Drives the REAL `dcaHelper.openNewDeal` over a minimal base class with
 * `refuseDealBelowExchangeMin` answering "refused".
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import { ExchangeEnum, StartConditionEnum } from '../../types'

const BOT_ID = '000000000000000000000246'
const USER_ID = '000000000000000000001246'
const PAIR = 'ALT-USDT'

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'ALT', minAmount: 0.01, step: 0.01 },
  quoteAsset: { name: 'USDT', minAmount: 20 },
  maxOrders: 200,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  isLong = true
  isShort = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  useCompountReduce = false
  scaleAr = false
  tpAr = false
  slAr = false
  closeAfterTpFilled = false
  exchange: any = {}
  orders = new Map()
  standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any

const buildBot = (type: string, belowMin: boolean) => {
  const seen = { stops: 0, placedBase: 0 }
  class TestBot extends DcaHelper {
    seen = seen
    data: any = {
      settings: {
        type,
        pair: [PAIR],
        startCondition: StartConditionEnum.asap,
        useDca: false,
      },
      status: 'open',
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'uuid-246',
      profit: { total: 0 },
      flags: [],
      paperContext: false,
    }
    pairs = new Set([PAIR])
    openNewDealTimer = new Map()
    botEventDb = { createData: async (d: any) => ({ status: 'OK', data: d }) }
    async checkBalance() {
      return { status: true, required: 5, available: 300, price: 2000 }
    }
    async approveNewDeal() {
      return true
    }
    async checkNewDealApproval() {
      return true
    }
    async applyNewDealSize(_s: string, _a: unknown, sizes: unknown) {
      return { sizes }
    }
    requestSignalBaseOrderSize() {}
    async getAggregatedSettings() {
      return { ...this.data.settings }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async checkMaxDeals() {
      return true
    }
    async checkInRange() {
      return true
    }
    async getActiveOrders() {
      return 0
    }
    async refuseDealBelowExchangeMin() {
      return belowMin
    }
    async refuseDealBelowMinimumBudget() {
      return false
    }
    async getLatestPrice() {
      return 2000
    }
    async checkCooldownStart() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async checkCooldownStop() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    resetPending() {}
    updateDealLastTime() {}
    releaseReduceToAvailableClaim() {}
    async placeBaseOrder() {
      seen.placedBase++
    }
    getOpenDeals() {
      return []
    }
    async onNewDealSize() {}
    async handleErrors() {}
    async reportUserRefusal() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    handleLog(m: string) {
      return m
    }
    handleWarn(m: string) {
      return m
    }
    handleDebug(m: string) {
      return m
    }
    async stop() {
      seen.stops++
    }
  }
  return new TestBot()
}

const open = (bot: any) =>
  bot.openNewDeal(BOT_ID, PAIR, false, false, 0, undefined, undefined)

describe('Terminal deal refused below the exchange minimum (spec 246)', () => {
  before(function () {
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
  })

  it('§2.1 a refused terminal deal stops its bot', async () => {
    const bot = buildBot('terminal', true)
    await open(bot)
    expect(bot.seen.placedBase).to.equal(0)
    expect(bot.seen.stops, 'the terminal bot is stopped').to.equal(1)
  })

  it('§2.2 a refused regular DCA deal keeps the bot running', async () => {
    const bot = buildBot('regular', true)
    await open(bot)
    expect(bot.seen.placedBase).to.equal(0)
    expect(bot.seen.stops).to.equal(0)
  })

  it('§2.3 a terminal deal that is not refused opens and does not stop', async () => {
    const bot = buildBot('terminal', false)
    await open(bot)
    expect(bot.seen.placedBase).to.equal(1)
    expect(bot.seen.stops).to.equal(0)
  })
})
