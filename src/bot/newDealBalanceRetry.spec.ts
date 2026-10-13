process.env.NODE_ENV = 'testing'

/**
 * Spec 152: an ASAP bot that is refused for balance right after a deal closed
 * re-checks on a bounded back-off, reading the exchange, instead of idling
 * until the user restarts it.
 *
 * Drives the REAL `dcaHelper.openNewDeal` / `comboHelper.openNewDeal` and the
 * REAL `checkBalanceGate` over a minimal base class. Only `checkBalance` is
 * stubbed, so each read's source (stored vs live) and outcome can be chosen.
 * That reproduces the production shape: the stored row still lacks the funds
 * the close just freed, while the exchange already holds them. Timers are faked,
 * so the in-call 5 s re-check and the back-off cost no wall time.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import sinon from 'sinon'
import { MathHelper } from '../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import { ExchangeEnum, StartConditionEnum } from '../../types'

const BOT_ID = '000000000000000000000152'
const USER_ID = '000000000000000000001152'
const PAIR = 'ALT-USDT'

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'ALT', minAmount: 0.01, step: 0.01 },
  quoteAsset: { name: 'USDT', minAmount: 1 },
  maxOrders: 200,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  isLong = false
  isShort = true
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
let ComboHelper: any
let RETRY_MS: number[]

type Seen = {
  reads: string[]
  placedBase: number
  warnings: number
}

const buildBot = (
  Helper: any,
  o: {
    stored: boolean
    live: boolean
    startCondition?: StartConditionEnum
    type?: string
  },
) => {
  const seen: Seen = { reads: [], placedBase: 0, warnings: 0 }
  class TestBot extends Helper {
    seen = seen
    balance = { stored: o.stored, live: o.live }
    data: any = {
      settings: {
        type: o.type ?? 'regular',
        pair: [PAIR],
        startCondition: o.startCondition ?? StartConditionEnum.asap,
        gridLevel: '1',
        ordersCount: 5,
      },
      status: 'open',
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'uuid-152',
      profit: { total: 0 },
      flags: [],
      paperContext: false,
    }
    pairs = new Set([PAIR])
    openNewDealTimer = new Map()
    botEventDb = { createData: async (d: any) => ({ status: 'OK', data: d }) }
    async checkBalance(
      _s: string,
      _m = 1,
      _scope = 'whole',
      source: 'live' | 'stored' = 'live',
    ) {
      seen.reads.push(source)
      const ok = source === 'stored' ? this.balance.stored : this.balance.live
      return {
        status: ok,
        required: 257.78,
        available: ok ? 300 : 85.69,
        price: 0.35,
      }
    }
    async approveNewDeal() {
      return true
    }
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
      return false
    }
    async refuseDealBelowMinimumBudget() {
      return false
    }
    async getLatestPrice() {
      return 0.35
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
    async handleErrors() {
      seen.warnings++
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
      return m
    }
    stop() {}
  }
  return new TestBot()
}

/** Runs one open attempt to completion, the 5 s in-call re-check included. */
const open = async (
  clock: sinon.SinonFakeTimers,
  bot: any,
  trigger?: string,
) => {
  const p = bot.openNewDeal(BOT_ID, PAIR, false, false, 0, undefined, trigger)
  await clock.tickAsync(5_000)
  await p
}

describe('ASAP new deal re-checks after a balance refusal (spec 152)', () => {
  let clock: sinon.SinonFakeTimers | undefined

  before(function () {
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
    ComboHelper = loadModule('./comboHelper').default(
      loadModule('./dcaHelper').default(FakeBase as any),
    )
    RETRY_MS = loadModule('./dcaHelper').NEW_DEAL_BALANCE_RETRY_MS
  })

  afterEach(() => {
    clock?.restore()
    clock = undefined
  })

  const fake = () => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    return clock
  }

  for (const [name, get] of [
    ['DCA', () => DcaHelper],
    ['Combo', () => ComboHelper],
  ] as const) {
    describe(name, () => {
      it('§1.1.1/§1.1.2 opens once the exchange shows the funds the stored row still lacks', async () => {
        const c = fake()
        const bot = buildBot(get(), { stored: false, live: true })
        await open(c, bot)
        expect(bot.seen.placedBase, 'refused on the stale stored row').to.equal(
          0,
        )
        expect(bot.seen.reads).to.deep.equal(['stored', 'stored'])
        expect(bot.seen.warnings).to.equal(1)
        expect(
          bot.openNewDealTimer.has(PAIR),
          'a re-check is scheduled for the pair',
        ).to.equal(true)

        bot.seen.reads = []
        await c.tickAsync(RETRY_MS[0])
        expect(bot.seen.reads, 'the re-check reads the exchange').to.deep.equal(
          ['live'],
        )
        expect(bot.seen.placedBase).to.equal(1)
        expect(bot.seen.warnings, 'no second warning').to.equal(1)

        // §4.3: the sequence ended — the next check is stored-first again.
        bot.seen.reads = []
        await open(c, bot)
        expect(bot.seen.reads[0]).to.equal('stored')
      })

      it('§1.1.3/§1.1.4 a genuine shortfall stays refused, warns once and stops re-checking', async () => {
        const c = fake()
        const bot = buildBot(get(), { stored: false, live: false })
        await open(c, bot)
        for (const ms of RETRY_MS) {
          await c.tickAsync(ms + 5_000)
        }
        expect(bot.seen.placedBase).to.equal(0)
        expect(bot.seen.warnings).to.equal(1)
        expect(
          bot.seen.reads.filter((r: string) => r === 'live').length,
          'one live read per re-check plus its 5 s confirmation',
        ).to.equal(RETRY_MS.length * 2)
        expect(bot.openNewDealTimer.size, 'nothing left armed').to.equal(0)
        // Bounded: nothing else runs, however long it waits.
        const before = bot.seen.reads.length
        await c.tickAsync(24 * 3600 * 1000)
        expect(bot.seen.reads.length).to.equal(before)
      })

      it('§1.1.5 a non-ASAP bot arms no re-check — its own trigger re-runs the gate', async () => {
        const c = fake()
        const bot = buildBot(get(), {
          stored: false,
          live: true,
          startCondition: StartConditionEnum.ti,
        })
        await open(c, bot, 'indicator')
        expect(bot.openNewDealTimer.size).to.equal(0)
      })

      it('§1.1.5 a manual open arms no re-check', async () => {
        const c = fake()
        const bot = buildBot(get(), { stored: false, live: true })
        const p = bot.openNewDeal(
          BOT_ID,
          PAIR,
          true,
          false,
          0,
          undefined,
          'manual',
        )
        await c.tickAsync(5_000)
        await p
        expect(bot.openNewDealTimer.size).to.equal(0)
      })
    })
  }

  it('§1.1.5 a terminal DCA deal arms no re-check', async () => {
    const c = fake()
    const bot = buildBot(DcaHelper, {
      stored: false,
      live: true,
      type: 'terminal',
    })
    await open(c, bot)
    expect(bot.openNewDealTimer.size).to.equal(0)
  })
})
