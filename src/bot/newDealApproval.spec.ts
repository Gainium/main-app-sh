process.env.NODE_ENV = 'testing'

/**
 * The last-step new-deal approval hook (main-app spec 021 §5.1).
 *
 * `openNewDeal` asks `approveNewDeal(ctx)` after every built-in gate has passed
 * and right before the deal is created. A refusal must leave the bot exactly as
 * every other refusal does — pending counters reset, the caller's
 * `cbIfNotOpened` fired, the method closed — plus one `Deal` event naming the
 * reason. A manual open never asks.
 *
 * Drives the REAL `dcaHelper.openNewDeal` and `comboHelper.openNewDeal` over a
 * minimal base class: no stack, DB, Redis or venue. Fixture ids are synthetic —
 * this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import {
  resolveNewDealTrigger,
  buildNewDealSignal,
  newDealSkippedDescription,
  type NewDealApprovalContext,
} from './newDealApproval'
import { ExchangeEnum, IndicatorAction, StartConditionEnum } from '../../types'

const BOT_ID = '0000000000000000000a0021'
const USER_ID = '0000000000000000000b0021'
const PAIR = 'ETH-USDC'

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 2,
  baseAsset: { name: 'ETH', minAmount: 0.001, step: 0.001 },
  quoteAsset: { name: 'USDC', minAmount: 1 },
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
  data: any = {
    settings: {
      type: 'regular',
      pair: [PAIR],
      startCondition: StartConditionEnum.asap,
      gridLevel: '1',
      ordersCount: 5,
    },
    status: 'open',
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'uuid-21',
    profit: { total: 0 },
    flags: [],
    paperContext: true,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

type Seen = {
  asked: NewDealApprovalContext[]
  placedBase: number
  resetPending: string[]
  cbNotOpened: number
  started: number
  ended: number
  events: any[]
}

const loadModule = createRequire(__filename)
let DcaHelper: any
let ComboHelper: any

const buildBot = (
  Helper: any,
  answer: boolean | 'throw',
  refusalReason?: string,
) => {
  const seen: Seen = {
    asked: [],
    placedBase: 0,
    resetPending: [],
    cbNotOpened: 0,
    started: 0,
    ended: 0,
    events: [],
  }
  class TestBot extends Helper {
    seen = seen
    data: any = new FakeBase().data
    pairs = new Set([PAIR])
    openNewDealTimer = new Map()
    botEventDb = {
      createData: async (d: any) => {
        seen.events.push(d)
        return { status: 'OK', data: d }
      },
    }
    async approveNewDeal(ctx: NewDealApprovalContext) {
      seen.asked.push({ ...ctx })
      if (answer === 'throw') {
        throw new Error('hook failure')
      }
      if (!answer) {
        ctx.refusalReason = refusalReason
      }
      return answer
    }
    async getAggregatedSettings() {
      return { ...this.data.settings }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async checkBalance() {
      return { status: true }
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
      return 2500
    }
    async checkCooldownStart() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async checkCooldownStop() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    resetPending(_botId: string, symbol: string) {
      seen.resetPending.push(symbol)
    }
    updateDealLastTime() {}
    releaseReduceToAvailableClaim() {}
    async placeBaseOrder() {
      seen.placedBase++
    }
    async handleErrors() {}
    startMethod() {
      seen.started++
      return '1'
    }
    endMethod() {
      seen.ended++
    }
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

const open = async (
  bot: any,
  opts: { skip?: boolean; dynamic?: boolean; trigger?: string } = {},
) => {
  await bot.openNewDeal(
    BOT_ID,
    PAIR,
    opts.skip ?? false,
    opts.dynamic ?? false,
    0,
    () => {
      bot.seen.cbNotOpened++
    },
    opts.trigger,
  )
}

describe('new-deal approval hook (spec 021 §5.1)', () => {
  before(function () {
    // Loading the helpers pulls the whole engine graph in through ts-node.
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
    ComboHelper = loadModule('./comboHelper').default(
      loadModule('./dcaHelper').default(FakeBase as any),
    )
  })

  describe('§5.1 trigger classification', () => {
    it('skip without dynamic is manual, whatever the call site says', () => {
      expect(resolveNewDealTrigger(true, false, 'ASAP')).to.equal('manual')
      expect(resolveNewDealTrigger(true, false, 'ASAP', 'webhook')).to.equal(
        'manual',
      )
    })
    it('the dynamic price filter path is dynamic', () => {
      expect(resolveNewDealTrigger(true, true, 'ASAP')).to.equal('dynamic')
    })
    it('an explicit label wins over the start condition', () => {
      expect(resolveNewDealTrigger(false, false, 'ASAP', 'webhook')).to.equal(
        'webhook',
      )
    })
    it('unlabelled calls follow the start condition', () => {
      expect(
        resolveNewDealTrigger(false, false, StartConditionEnum.asap),
      ).to.equal('asap')
      expect(
        resolveNewDealTrigger(false, false, StartConditionEnum.timer),
      ).to.equal('timer')
      expect(
        resolveNewDealTrigger(
          false,
          false,
          StartConditionEnum.tradingviewSignals,
        ),
      ).to.equal('webhook')
      expect(
        resolveNewDealTrigger(false, false, StartConditionEnum.ti),
      ).to.equal('indicator')
    })
    it('the signal names start conditions and the shortest timeframe', () => {
      const s = buildNewDealSignal([
        {
          type: 'RSI',
          indicatorLength: 14,
          indicatorCondition: 'lt',
          indicatorValue: '30',
          indicatorInterval: '1h',
          indicatorAction: IndicatorAction.startDeal,
        } as any,
        {
          type: 'MA',
          indicatorLength: 50,
          indicatorCondition: 'cu',
          indicatorValue: '',
          indicatorInterval: '15m',
          indicatorAction: IndicatorAction.startDeal,
        } as any,
        {
          type: 'RSI',
          indicatorLength: 14,
          indicatorCondition: 'gt',
          indicatorValue: '70',
          indicatorInterval: '1m',
          indicatorAction: IndicatorAction.closeDeal,
        } as any,
      ])
      expect(s?.timeframe).to.equal('15m')
      expect(s?.conditions).to.have.length(2)
      expect(buildNewDealSignal([])).to.equal(undefined)
    })
  })

  for (const [name, get] of [
    ['DCA', () => DcaHelper],
    ['Combo', () => ComboHelper],
  ] as const) {
    describe(`§5.1 ${name} openNewDeal`, () => {
      it('asks the hook after the gates and opens on approval', async () => {
        const bot = buildBot(get(), true)
        await open(bot)
        expect(bot.seen.asked).to.have.length(1)
        expect(bot.seen.asked[0]).to.include({
          botId: BOT_ID,
          symbol: PAIR,
          trigger: 'asap',
        })
        expect(bot.seen.asked[0].price).to.equal(2500)
        expect(bot.seen.placedBase).to.equal(1)
        expect(bot.seen.cbNotOpened).to.equal(0)
      })

      it('a refusal resets pending, calls cbIfNotOpened, ends the method and records the reason', async () => {
        const bot = buildBot(get(), false, 'trend is down')
        await open(bot, { trigger: 'indicator' })
        expect(bot.seen.asked).to.have.length(1)
        expect(bot.seen.asked[0].trigger).to.equal('indicator')
        expect(bot.seen.placedBase, 'no deal was created').to.equal(0)
        expect(bot.seen.resetPending).to.deep.equal([PAIR])
        expect(bot.seen.cbNotOpened).to.equal(1)
        expect(bot.seen.ended, 'endMethod balanced startMethod').to.equal(
          bot.seen.started,
        )
        const ev = bot.seen.events.find((e: any) => e.event === 'Deal')
        expect(ev, 'a Deal event was written').to.not.equal(undefined)
        expect(ev.description).to.equal(
          newDealSkippedDescription('trend is down'),
        )
        expect(ev).to.include({
          botId: BOT_ID,
          symbol: PAIR,
          paperContext: true,
        })
      })

      it('a manual open never asks the hook', async () => {
        const bot = buildBot(get(), false, 'must not be asked')
        await open(bot, { skip: true })
        expect(bot.seen.asked).to.have.length(0)
        expect(bot.seen.placedBase).to.equal(1)
      })

      it('the dynamic price-filter path does ask', async () => {
        const bot = buildBot(get(), true)
        await open(bot, { skip: true, dynamic: true })
        expect(bot.seen.asked.map((a) => a.trigger)).to.deep.equal(['dynamic'])
      })

      it('a hook that throws does not block the deal', async () => {
        const bot = buildBot(get(), 'throw')
        await open(bot)
        expect(bot.seen.placedBase).to.equal(1)
      })
    })
  }
})
