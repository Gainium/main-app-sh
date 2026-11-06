process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `225.a-flat-deal-waits-for-an-unrelated-event-to-take-its-second-reading`.
 *
 * Drives the REAL dcaHelper `reconcileDealPosition` (probe throttle, readings
 * count, two-readings rule) and the REAL Combo grid-refusal entry point over a
 * minimal base class, with sinon fake timers so the five-minute windows
 * elapse in the test. The venue position call, the closes and the bot event
 * DAO are recorded instead of run.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import sinon from 'sinon'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import RedisClient from '../db/redis'
import {
  CloseDCATypeEnum,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'

const BOT_ID = '000000000000000000000b25'
const DEAL_ID = '000000000000000000000d25'
const PAIR = 'AAAUSDT'
const MIN = 60 * 1000
const ZERO_POSITION = 'no position to close'
const HELD = [{ symbol: PAIR, positionAmt: '-1133', positionSide: 'BOTH' }]

/** Redis stand-in honouring TTLs against the (faked) clock. */
const store = new Map<string, { v: string; exp: number }>()
let previousGetInstance: unknown
const useStore = () => {
  store.clear()
  previousGetInstance = (RedisClient as any).getInstance
  ;(RedisClient as any).getInstance = async () => ({
    get: async (k: string) => {
      const e = store.get(k)
      return e && e.exp > Date.now() ? e.v : null
    },
    set: async (k: string, v: string, ttl?: number) => {
      store.set(k, { v, exp: ttl ? Date.now() + ttl * 1000 : Infinity })
    },
    del: async (k: string) => {
      store.delete(k)
    },
  })
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000425'
  loadingComplete = true
  futures = true
  coinm = false
  hedge = false
  orders = new Map()
  data: any = {
    settings: { type: 'regular', pair: [PAIR] },
    status: 'open',
    exchange: ExchangeEnum.bitgetUsdm,
    exchangeUUID: 'uuid-225',
    flags: [],
    paperContext: false,
  }
  running = true
  shouldProceed() {
    return this.running
  }
  async handleOrderErrors() {}
  constructor(..._a: any[]) {}
}

let Dca: any
let Combo: any

type Answer = 'flat' | 'held' | 'unavailable'

const buildBot = (Cls: any) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    symbol: { symbol: PAIR, baseAsset: 'AAA', quoteAsset: 'USDT' },
  }
  const full: any = {
    deal,
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
    closeBySl: false,
  }
  class TestBot extends Cls {
    answer: Answer = 'flat'
    probes = 0
    closes: any[][] = []
    dealCloses: any[][] = []
    events: any[] = []
    logs: string[] = []
    isLong = false
    exchange: any = {
      futures_getPositions: async () => {
        this.probes++
        if (this.answer === 'unavailable') {
          return { status: StatusEnum.notok, data: null, reason: 'timeout' }
        }
        return {
          status: StatusEnum.ok,
          data: this.answer === 'held' ? HELD : [],
          reason: null,
        }
      },
    }
    botEventDb: any = {
      createData: async (d: any) => {
        this.events.push(d)
        return { status: StatusEnum.ok }
      },
    }
    getDeal(id: string) {
      return id === DEAL_ID ? full : undefined
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async closeDealById(...args: any[]) {
      this.closes.push(args)
    }
    async closeDeal(...args: any[]) {
      this.dealCloses.push(args)
      full.deal.status = DCADealStatusEnum.closed
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn() {}
  }
  const bot = new (TestBot as any)(BOT_ID, ExchangeEnum.bitgetUsdm, false)
  return { bot, full }
}

const gridOrder = () =>
  ({
    clientOrderId: `CMB-GR-fixture${Math.random().toString(36).slice(2, 8)}`,
    dealId: DEAL_ID,
    symbol: PAIR,
    side: 'BUY',
    typeOrder: TypeOrderEnum.dealGrid,
    origQty: '254',
    price: '0.0269',
  }) as any

describe('a flat deal takes its own second position reading (spec 225)', () => {
  let clock: sinon.SinonFakeTimers

  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    Dca = req('./dcaHelper').default(FakeBase)
    Combo = req('./comboHelper').default(Dca)
  })
  beforeEach(() => {
    useStore()
    clock = sinon.useFakeTimers({
      now: Date.UTC(2026, 10, 5, 13, 18, 2),
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    })
  })
  afterEach(() => {
    clock.restore()
    if (previousGetInstance) {
      ;(RedisClient as any).getInstance = previousGetInstance
    }
  })

  /** One grid refusal, the combo path that produced the evidence. */
  const refuse = async (bot: any) => {
    await bot.handleOrderErrors(
      ZERO_POSITION,
      gridOrder(),
      'limitOrders()',
      'Send new order request',
    )
    await clock.tickAsync(0)
  }

  it('§1.1.1 combo: closes by the base trigger after the window with no further event', async () => {
    const { bot, full } = buildBot(Combo)
    await refuse(bot)
    expect(bot.probes).to.equal(1)
    expect(bot.closes).to.have.length(0)
    expect(bot.positionReprobes.has(DEAL_ID)).to.equal(true)
    // No refusal, no price tick, no reload — only time passes.
    await clock.tickAsync(5 * MIN + 10 * 1000)
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(1)
    expect(bot.closes[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
    expect(bot.closes[0][10]).to.equal(DCACloseTriggerEnum.base)
    expect(full.closeBySl).to.equal(true)
    expect(bot.events).to.have.length(1)
    expect(bot.positionReprobes.has(DEAL_ID)).to.equal(false)
  })

  it('§1.1.1 DCA: a take-profit-level probe, price moves away, deal closes via closeDeal', async () => {
    const { bot } = buildBot(Dca)
    const { full } = { full: bot.getDeal(DEAL_ID) }
    expect(await bot.reconcileDealPosition(full, 'not placed')).to.equal(false)
    await clock.tickAsync(5 * MIN + 10 * 1000)
    expect(bot.probes).to.equal(2)
    expect(bot.dealCloses).to.deep.equal([[BOT_ID, DEAL_ID]])
  })

  it('§1.1.2 nothing fires before the window; a re-probe that sees the position closes nothing', async () => {
    const { bot } = buildBot(Combo)
    await refuse(bot)
    await clock.tickAsync(4 * MIN)
    expect(bot.probes).to.equal(1)
    bot.answer = 'held'
    await clock.tickAsync(2 * MIN)
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(0)
    expect(bot.positionReprobes.has(DEAL_ID)).to.equal(false)
    // The count was reset: one more flat reading is one, not two.
    bot.answer = 'flat'
    await refuse(bot)
    expect(bot.probes).to.equal(3)
    expect(bot.closes).to.have.length(0)
    await clock.tickAsync(6 * MIN)
    expect(bot.probes).to.equal(4)
    expect(bot.closes).to.have.length(1)
  })

  it('§1.1.3 a burst of first readings arms one re-probe', async () => {
    const { bot } = buildBot(Dca)
    const full = bot.getDeal(DEAL_ID)
    await bot.reconcileDealPosition(full, 'not placed')
    // Inside the throttle: suppressed, no second timer.
    await bot.reconcileDealPosition(full, 'not placed')
    expect(bot.probes).to.equal(1)
    expect(bot.positionReprobes.size).to.equal(1)
    await clock.tickAsync(30 * MIN)
    expect(bot.probes).to.equal(2)
    expect(bot.dealCloses).to.have.length(1)
  })

  it('§1.1.4 a deal that closed meanwhile, or a stopped bot, is not probed', async () => {
    const a = buildBot(Combo)
    await refuse(a.bot)
    a.full.deal.status = DCADealStatusEnum.closed
    await clock.tickAsync(10 * MIN)
    expect(a.bot.probes).to.equal(1)
    expect(a.bot.positionReprobes.size).to.equal(0)

    store.clear()
    const b = buildBot(Combo)
    await refuse(b.bot)
    b.bot.running = false
    await clock.tickAsync(10 * MIN)
    expect(b.bot.probes).to.equal(1)
    expect(b.bot.closes).to.have.length(0)
  })

  it('§1.1.5 an unanswered re-probe is retried, then gives up after 3 misses', async () => {
    const { bot } = buildBot(Combo)
    await refuse(bot)
    bot.answer = 'unavailable'
    // Probe windows escalate 5 → 10 → 20 → 40 min; leave room for all of them.
    await clock.tickAsync(6 * 60 * MIN)
    // 1 first reading + 1 re-probe + 3 retried misses.
    expect(bot.probes).to.equal(5)
    expect(bot.closes).to.have.length(0)
    expect(bot.positionReprobes.size).to.equal(0)
  })

  it('§1.1.5 a miss then an answer still settles on the second answered reading', async () => {
    const { bot } = buildBot(Combo)
    await refuse(bot)
    bot.answer = 'unavailable'
    await clock.tickAsync(5 * MIN + 10 * 1000)
    expect(bot.probes).to.equal(2)
    expect(bot.closes).to.have.length(0)
    bot.answer = 'flat'
    await clock.tickAsync(11 * MIN)
    expect(bot.probes).to.equal(3)
    expect(bot.closes).to.have.length(1)
  })

  it('§1.1.2 an unanswered FIRST probe arms nothing', async () => {
    const { bot } = buildBot(Combo)
    bot.answer = 'unavailable'
    await refuse(bot)
    expect(bot.probes).to.equal(1)
    expect(bot.positionReprobes.size).to.equal(0)
    await clock.tickAsync(60 * MIN)
    expect(bot.probes).to.equal(1)
  })
})
