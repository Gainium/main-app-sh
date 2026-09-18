process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `054.a-failed-balance-read-is-reported-as-a-zero-balance`.
 *
 * A balance READ that failed is not a balance of zero, but `checkAssets()`
 * returns the same empty `Map` for both, and `checkBalance()` scores a missing
 * entry as `?? 0`. Production, 2026-09-18: two `checkAssets() / getBalance`
 * failures 5.281 s apart — the gap is `openNewDeal`'s own `sleep(5000)` retry —
 * and 2 ms after the second one a warning telling a fully funded account it had
 * `available: 0`.
 *
 * Three layers, each driving the REAL engine code:
 *
 *  - `MainBot.checkAssets` over `Object.create(MainBot.prototype)`, so the
 *    failure/success distinction is measured where it is produced (§4.1);
 *  - `dcaHelper.checkBalance` and `dcaHelper.openNewDeal` over the mixin with a
 *    minimal base class — no stack, DB, Redis or venue (§4.2–§4.5);
 *  - `comboHelper.checkBalance`, which is a separate override of the same
 *    defect (§4.2).
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'
import {
  ConditionLatch,
  STANDING_CONDITION_REARM_MS,
  standingConditionKey,
  notEnoughBalanceNewDeal,
} from '../conditionLatch'
import { ExchangeEnum, StatusEnum } from '../../../types'

const BOT_ID = '000000000000000000000b54'
const USER_ID = '000000000000000000000454'
const PAIR = 'SUI-USDC'

/** The venue's own words, verbatim from the production log. */
const READ_FAILURE = "Could not find user's accounts information"

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'SUI', minAmount: 0.1, step: 0.1 },
  quoteAsset: { name: 'USDC', minAmount: 1 },
  maxOrders: 200,
}

/** What the reporter's account actually held while it was told it held none. */
const FUNDED = 13399.15

// ---------------------------------------------------------------------------
// §4.1 — checkAssets signals a failed read
// ---------------------------------------------------------------------------

type AssetsOpts = {
  /** What the venue answers. `undefined` = no exchange client at all. */
  getBalance?: () => Promise<any>
  /** Rows the balances DB serves on the `direct = false` path. */
  dbRows?: { asset: string; free: number; locked: number }[] | 'notok'
}

const buildAssetsBot = (o: AssetsOpts = {}) => {
  const bot: any = Object.create(MainBot.prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.errors = []
  // Empty on purpose: a falsy `exchangeUUID` skips the `AuthFailureGuard`
  // short-circuit, which is Redis-backed and is not what this layer measures.
  bot.data = { exchange: ExchangeEnum.binance, exchangeUUID: '' }
  bot.pairs = new Set([PAIR])
  bot.exchange =
    'getBalance' in o
      ? o.getBalance
        ? { getBalance: o.getBalance }
        : undefined
      : {
          getBalance: async () => ({
            status: StatusEnum.notok,
            reason: READ_FAILURE,
          }),
        }
  bot.balancesDb = {
    readData: async () =>
      o.dbRows === 'notok'
        ? { status: StatusEnum.notok, reason: 'db down' }
        : { status: StatusEnum.ok, data: { result: o.dbRows ?? [] } },
  }
  bot.isBNFCR = async () => false
  bot.getUser = async () => ({ exchanges: [] })
  bot.getExchangeInfo = async () => EXCHANGE_INFO
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = (...a: any[]) => {
    bot.errors.push(a)
  }
  return bot
}

// ---------------------------------------------------------------------------
// §4.2–§4.5 — checkBalance and openNewDeal
// ---------------------------------------------------------------------------

/** How the fixture's `checkAssets` answers. */
type Read = 'failed' | 'emptyButOk' | 'funded'

const assetsFor = (read: Read) => {
  if (read === 'failed') {
    // What §4.1 makes `checkAssets` return for a read that never landed.
    return undefined
  }
  if (read === 'emptyButOk') {
    // A SUCCESSFUL read of an account that holds none of this pair's assets.
    return new Map()
  }
  return new Map([['USDC', { asset: 'USDC', free: FUNDED, locked: 0 }]])
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
  data: any = {
    settings: { type: 'regular', pair: [PAIR] },
    status: 'open',
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: 'uuid-54',
    profit: { total: 0 },
    flags: [],
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any
let ComboHelper: any

/** Everything the two `openNewDeal` paths raise, so a test can assert on it. */
type Raised = {
  errors: any[][]
  debug: string[]
  placedBase: any[][]
  reopened: number
}

const buildBot = (Helper: any, read: Read) => {
  const raised: Raised = {
    errors: [],
    debug: [],
    placedBase: [],
    reopened: 0,
  }
  class TestBot extends Helper {
    raised = raised
    data: any = new FakeBase().data
    standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
    pairs = new Set([PAIR])

    async checkAssets() {
      return assetsFor(read)
    }
    async getAggregatedSettings() {
      return {
        type: 'regular',
        pair: [PAIR],
        skipBalanceCheck: false,
        startCondition: 'ASAP',
        orderSizeType: 'quote',
        baseOrderSize: '100',
        gridLevel: '1',
        ordersCount: 5,
      }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getLeverageMultipler() {
      return 1
    }
    async getLatestPrice() {
      return 0.471
    }
    async getBaseOrder() {
      return { origQty: '212.3', price: '0.471' }
    }
    async createInitialDealOrders() {
      return []
    }
    async createCurrentDealOrders() {
      return []
    }
    async pooledMarginOrKeep(_a: string, available: number) {
      return available
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
    async checkCooldownStart() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async checkCooldownStop() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    updateDealLastTime() {}
    async placeBaseOrder(...args: any[]) {
      raised.placedBase.push(args)
    }
    async handleErrors(...args: any[]) {
      raised.errors.push(args)
    }
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
      raised.debug.push(m)
      return m
    }
    stop() {}
  }
  return new TestBot()
}

const latchKey = standingConditionKey(notEnoughBalanceNewDeal, PAIR)

/** Drive the real `openNewDeal` and report whether it re-armed the pair. */
const openDeal = async (bot: any) => {
  let notOpened = false
  await bot.openNewDeal(BOT_ID, PAIR, false, false, 0, () => {
    notOpened = true
  })
  return notOpened
}

describe('a failed balance read is not a zero balance (spec 054)', () => {
  before(function () {
    // Loading the helpers pulls the whole engine graph in through ts-node.
    this.timeout(180000)
    DcaHelper = loadModule('../dcaHelper').default(FakeBase as any)
    ComboHelper = loadModule('../comboHelper').default(
      loadModule('../dcaHelper').default(FakeBase as any),
    )
  })

  describe('§4.1 checkAssets tells the two outcomes apart', () => {
    it('a refused read does not answer with an empty balance map', async () => {
      const bot = buildAssetsBot()
      const res = await bot.checkAssets(true, true)
      // The defect: today this is an empty Map, indistinguishable from a
      // successful read of an account holding none of the pair's assets.
      expect(res, 'a failed read answered with a map').to.equal(undefined)
      expect(bot.errors.length, 'the failure is still reported').to.equal(1)
    })

    it('a successful read of an empty account still answers with a map', async () => {
      const bot = buildAssetsBot({
        getBalance: async () => ({ status: StatusEnum.ok, data: [] }),
      })
      const res = await bot.checkAssets(true, true)
      expect(
        res,
        'a successful read must stay distinguishable',
      ).to.be.instanceOf(Map)
      expect(res.size).to.equal(0)
      expect(bot.errors.length, 'nothing failed, nothing reported').to.equal(0)
    })

    it('a successful read answers with what the account holds', async () => {
      const bot = buildAssetsBot({
        getBalance: async () => ({
          status: StatusEnum.ok,
          data: [{ asset: 'USDC', free: FUNDED, locked: 0 }],
        }),
      })
      const res = await bot.checkAssets(true, true)
      expect(res.get('USDC').free).to.equal(FUNDED)
    })

    it('no exchange client is a failed read, not an empty account', async () => {
      const bot = buildAssetsBot({ getBalance: undefined })
      expect(await bot.checkAssets(true, true)).to.equal(undefined)
    })

    it('keeps serving partial DB figures when the venue call then fails', async () => {
      // §4.1: partial data is data. `direct = false`, the DB resolved one of the
      // pair's two assets so `finish` stays false, and the venue call fails.
      const bot = buildAssetsBot({
        dbRows: [{ asset: 'USDC', free: FUNDED, locked: 0 }],
      })
      const res = await bot.checkAssets(true, false)
      expect(res, 'partial DB data was discarded').to.be.instanceOf(Map)
      expect(res.get('USDC').free).to.equal(FUNDED)
    })
  })

  describe('§4.2 checkBalance carries "unknown" out', () => {
    it('does not score an unreadable balance as zero', async () => {
      const bot: any = buildBot(DcaHelper, 'failed')
      const res = await bot.checkBalance(PAIR)
      expect(res.unknown, 'the failed read was not flagged').to.equal(true)
      expect(res.status, 'an unknown balance must not pass the check').to.equal(
        false,
      )
      // It must not invent figures from a map it does not have.
      expect(res.available ?? 0).to.equal(0)
      expect(res.required ?? 0).to.equal(0)
    })

    it('§4.4 a genuine shortfall is unchanged', async () => {
      const bot: any = buildBot(DcaHelper, 'emptyButOk')
      const res = await bot.checkBalance(PAIR)
      expect(res.status).to.equal(false)
      expect(
        !!res.unknown,
        'a real shortfall must not be flagged unknown',
      ).to.equal(false)
      expect(res.available).to.equal(0)
      expect(res.required).to.be.greaterThan(0)
    })

    it('a funded account passes', async () => {
      const bot: any = buildBot(DcaHelper, 'funded')
      const res = await bot.checkBalance(PAIR)
      expect(res.status).to.equal(true)
      expect(!!res.unknown).to.equal(false)
    })

    it('comboHelper behaves identically', async () => {
      const failed: any = buildBot(ComboHelper, 'failed')
      expect((await failed.checkBalance(PAIR)).unknown).to.equal(true)
      const short: any = buildBot(ComboHelper, 'emptyButOk')
      const res = await short.checkBalance(PAIR)
      expect(res.status).to.equal(false)
      expect(!!res.unknown).to.equal(false)
    })
  })

  describe('§4.3 openNewDeal neither opens nor accuses', () => {
    it('never tells a user they are out of funds off a read that failed', async function () {
      // Two `checkBalance` calls with `openNewDeal`'s own 5 s retry between.
      this.timeout(30000)
      const bot: any = buildBot(DcaHelper, 'failed')
      const reArmed = await openDeal(bot)
      expect(
        bot.raised.errors,
        'the user was accused on an unread balance',
      ).to.deep.equal([])
      expect(bot.raised.placedBase.length, 'a deal was opened blind').to.equal(
        0,
      )
      expect(reArmed, 'the pair was not re-armed').to.equal(true)
    })

    it('leaves the standing-condition latch exactly as it found it', async function () {
      this.timeout(30000)
      const bot: any = buildBot(DcaHelper, 'failed')
      // A shortfall the user was already told about, still standing.
      bot.standingConditionLatch.shouldReport(latchKey, Date.now())
      const before = bot.standingConditionLatch.size
      await openDeal(bot)
      expect(
        bot.standingConditionLatch.size,
        'the latch was disturbed',
      ).to.equal(before)
      // Not cleared: a read that failed is not evidence the shortfall ended.
      expect(
        bot.standingConditionLatch.shouldReport(latchKey, Date.now()),
      ).to.equal(false)
    })

    it('§4.4 a genuine shortfall is still reported, once', async function () {
      this.timeout(30000)
      const bot: any = buildBot(DcaHelper, 'emptyButOk')
      await openDeal(bot)
      expect(
        bot.raised.errors.length,
        'a real shortfall went unreported',
      ).to.equal(1)
      expect(`${bot.raised.errors[0][0]}`).to.contain(
        'Not enough balance to start new deal',
      )
      // The latch was consumed, so the next cycle stays quiet (spec 008).
      const again: any = bot
      again.raised.errors.length = 0
      await openDeal(again)
      expect(again.raised.errors.length, 'spec 008 latch regressed').to.equal(0)
    })

    it('§4.5 the shortfall alert names the pair that failed', async function () {
      this.timeout(30000)
      const bot: any = buildBot(DcaHelper, 'emptyButOk')
      await openDeal(bot)
      // `handleErrors(e, method, step, setError, sendError, setEvent, force, symbol)`
      expect(bot.raised.errors[0][7], 'the alert names no pair').to.equal(PAIR)
    })

    it('a funded account still opens its deal', async () => {
      const bot: any = buildBot(DcaHelper, 'funded')
      await openDeal(bot)
      expect(bot.raised.placedBase.length).to.equal(1)
      expect(bot.raised.errors).to.deep.equal([])
    })

    it('comboHelper.openNewDeal is silent on an unreadable balance too', async function () {
      this.timeout(30000)
      const bot: any = buildBot(ComboHelper, 'failed')
      await openDeal(bot)
      expect(
        bot.raised.errors,
        'the user was accused on an unread balance',
      ).to.deep.equal([])
    })
  })
})
