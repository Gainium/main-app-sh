process.env.NODE_ENV = 'testing'

/**
 * Trailing guard: an armed trail is never further from the price than one
 * trail width. Pure helpers first, then the REAL `checkTrailing` in each mode.
 *
 * The frozen fixture is the state a lost `bestPrice` reset left behind on a
 * spot XRP-EUR deal: armed at 1.16756 with a 0.5% trail (level 1.16172), best
 * price still the deal's opening 1.28424, price since rallied to 1.22366.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  CloseConditionEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  TrailingModeEnum,
} from '../../../types'
import {
  levelAt,
  parseTrailingGuardMode,
  trailingLag,
  TRAILING_LAG_TOLERANCE,
} from './trailingGuard'

describe('trailing guard — pure helpers', () => {
  it('parses the mode, defaulting to shadow', () => {
    expect(parseTrailingGuardMode(undefined)).to.equal('shadow')
    expect(parseTrailingGuardMode('')).to.equal('shadow')
    expect(parseTrailingGuardMode('garbage')).to.equal('shadow')
    expect(parseTrailingGuardMode(' ENFORCE ')).to.equal('enforce')
    expect(parseTrailingGuardMode('off')).to.equal('off')
  })

  it('computes the engine level at the current price', () => {
    const long = {
      mode: TrailingModeEnum.ttp,
      long: true,
      last: 100,
      trailingTpPerc: '0.5',
    }
    expect(levelAt(long)).to.be.closeTo(99.5, 1e-9)
    expect(levelAt({ ...long, long: false })).to.be.closeTo(100.5, 1e-9)
    // TSL uses the stop-loss percentage, negative by convention.
    expect(
      levelAt({
        mode: TrailingModeEnum.tsl,
        long: true,
        last: 100,
        slPerc: '-5',
      }),
    ).to.be.closeTo(95, 1e-9)
    expect(
      levelAt({
        mode: TrailingModeEnum.tsl,
        long: false,
        last: 100,
        slPerc: '-5',
      }),
    ).to.be.closeTo(105, 1e-9)
    expect(levelAt({ ...long, trailingTpPerc: '0' })).to.equal(null)
    expect(levelAt({ ...long, mode: undefined })).to.equal(null)
  })

  it('reports lag only when the level has fallen behind', () => {
    expect(trailingLag(99, 99.5, true)).to.be.closeTo(0.5 / 99.5, 1e-12)
    expect(trailingLag(99.6, 99.5, true)).to.equal(0) // ahead: a best above last
    expect(trailingLag(101, 100.5, false)).to.be.closeTo(0.5 / 100.5, 1e-12)
    expect(trailingLag(100.4, 100.5, false)).to.equal(0)
    expect(
      trailingLag(99.5 * (1 - TRAILING_LAG_TOLERANCE / 2), 99.5, true),
    ).to.be.below(TRAILING_LAG_TOLERANCE)
  })
})

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b71'
const DEAL_ID = '000000000000000000000d71'
const SYMBOL = 'XRP-EUR'
const FROZEN_LEVEL = 1.1617222
const STALE_BEST = 1.28424
const PEAK = 1.22366
const TRAIL = 0.5

const SETTINGS = {
  useTp: true,
  useSl: false,
  trailingTp: true,
  trailingTpPerc: String(TRAIL),
  tpPerc: '1',
  dealCloseCondition: CloseConditionEnum.tp,
  dealCloseConditionSL: CloseConditionEnum.tp,
  useMultiTp: false,
  multiTp: [],
  useMultiSl: false,
  multiSl: [],
  useMinTP: false,
  moveSL: false,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u71'
  isLong = true
  futures = false
  coinm = false
  combo = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    status: 'open',
    exchange: ExchangeEnum.kraken,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const makeDeal = (o: Record<string, unknown> = {}): any => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'XRP', quoteAsset: 'EUR' },
  status: DCADealStatusEnum.open,
  trailingMode: TrailingModeEnum.ttp,
  trailingLevel: FROZEN_LEVEL,
  bestPrice: STALE_BEST,
  avgPrice: 1.153563,
  lastPrice: 1.2,
  settings: {},
  tpSlTargetFilled: [],
  ...o,
})

const makeBot = (deal: any, mode: string | null, isLong = true) => {
  let price = 0
  class TestBot extends Helper {
    isLong = isLong
    allowedMethods = new Set(['checkTrailing'])
    warns: string[] = []
    triggered = 0
    redisDb = { get: async () => mode }
    dealsForTrailing = new Map([
      [
        DEAL_ID,
        {
          trailingTp: true,
          skipTp: false,
          trailingSl: false,
          skipSl: true,
          trailingTpPrice: 1.1674,
        },
      ],
    ])
    full: any = { deal, closeBySl: false, notCheckSl: false }
    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    getLastStreamData() {
      return { price }
    }
    async getAggregatedSettings() {
      return SETTINGS
    }
    async saveDeal(d: any, fields?: Record<string, unknown>) {
      if (fields) {
        this.full = { ...d, deal: { ...this.full.deal, ...fields } }
      }
    }
    async triggerTrailing() {
      this.triggered++
    }
    handleLog() {}
    handleDebug() {}
    handleWarn(m: string) {
      this.warns.push(m)
    }
    handleErrors() {}
  }
  const bot = new TestBot() as any
  bot.tick = async (p: number) => {
    price = p
    await bot.checkTrailing(BOT_ID, SYMBOL)
    return bot.full.deal
  }
  return bot
}

describe('trailing guard — in checkTrailing', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('shadow (the default): reports a frozen level and changes nothing', async () => {
    const bot = makeBot(makeDeal(), null)
    const deal = await bot.tick(PEAK)
    expect(deal.trailingLevel).to.equal(FROZEN_LEVEL)
    expect(deal.bestPrice).to.equal(STALE_BEST)
    expect(bot.triggered).to.equal(0)
    expect(bot.warns).to.have.length(1)
    expect(bot.warns[0]).to.match(/^trailing-guard shadow: deal \S+ ttp LONG/)
    expect(bot.warns[0]).to.contain('would raise')
  })

  it('shadow reports the same deal at most once per interval', async () => {
    const bot = makeBot(makeDeal(), 'shadow')
    await bot.tick(PEAK)
    await bot.tick(PEAK * 1.001)
    await bot.tick(PEAK * 1.002)
    expect(bot.warns).to.have.length(1)
  })

  it('enforce: raises the level to one trail width below the price', async () => {
    const bot = makeBot(makeDeal(), 'enforce')
    const deal = await bot.tick(PEAK)
    expect(deal.trailingLevel).to.be.closeTo(PEAK * (1 - TRAIL / 100), 1e-9)
    expect(deal.bestPrice).to.equal(PEAK)
    expect(bot.triggered).to.equal(1) // persisted through the normal path
    expect(bot.warns[0]).to.contain('RAISED')
  })

  it('off: silent and unchanged', async () => {
    const bot = makeBot(makeDeal(), 'off')
    const deal = await bot.tick(PEAK)
    expect(deal.trailingLevel).to.equal(FROZEN_LEVEL)
    expect(bot.warns).to.have.length(0)
  })

  it('a healthy trail is never reported, rising or retracing', async () => {
    const healthyLevel = PEAK * (1 - TRAIL / 100)
    const bot = makeBot(
      makeDeal({ trailingLevel: healthyLevel, bestPrice: PEAK }),
      'enforce',
    )
    let deal = await bot.tick(1.21) // retrace, still above the level
    expect(deal.trailingLevel).to.equal(healthyLevel)
    deal = await bot.tick(1.23) // new high: the normal path moves it
    expect(deal.trailingLevel).to.be.closeTo(1.23 * (1 - TRAIL / 100), 1e-9)
    expect(bot.warns).to.have.length(0)
  })

  it('skips a deal whose close retry is in flight (spec 050) entirely', async () => {
    const now = Date.now()
    const bot = makeBot(
      makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 2,
          since: now - 60_000,
          lastAttempt: now - 30_000,
          nextAttempt: now + 60_000,
        },
      }),
      'enforce',
    )
    const deal = await bot.tick(PEAK)
    expect(deal.trailingLevel).to.equal(FROZEN_LEVEL)
    expect(bot.warns).to.have.length(0)
  })

  it('reports but never moves a level still carrying a retry record', async () => {
    const long = Date.now() - 24 * 3600_000
    const bot = makeBot(
      makeDeal({
        trailingClose: {
          status: 'retrying',
          attempts: 5,
          since: long,
          lastAttempt: long,
          nextAttempt: long, // stale: no longer in flight
        },
      }),
      'enforce',
    )
    const deal = await bot.tick(PEAK)
    expect(deal.trailingLevel).to.equal(FROZEN_LEVEL)
    expect(bot.warns).to.have.length(1)
    expect(bot.warns[0]).to.contain('held true')
    expect(bot.warns[0]).to.contain('would raise')
  })

  it('mirrors for a short', async () => {
    const shortLevel = 1.3 * (1 + TRAIL / 100) // armed near 1.30
    const bot = makeBot(
      makeDeal({
        strategy: 'SHORT',
        trailingLevel: shortLevel,
        bestPrice: 1.1,
      }),
      'enforce',
      false,
    )
    const deal = await bot.tick(1.2) // price fell; stale best 1.1 blocks the normal path
    expect(deal.trailingLevel).to.be.closeTo(1.2 * (1 + TRAIL / 100), 1e-9)
  })
})
