process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `049.a-trailing-take-profit-closes-below-break-even`.
 *
 * Drives the REAL `dcaHelper.checkDealsStopLoss` — the single place a close is
 * decided from the armed level and the live tick — and the REAL
 * `triggerStopLoss` it calls, so a close that must not happen shows up as a
 * missing `closeDealById` call rather than as a stubbed assertion.
 *
 * The defect: `trailingMode: 'ttp'` is the armed state of a trailing TAKE
 * PROFIT, but the arm closed purely on `last` crossing `trailingLevel`, with
 * no reference to the deal's average entry. On a bot with stop loss switched
 * off that turned the take-profit trail into an unbounded stop loss: once
 * anything left a level armed while price fell away — a venue-rejected close,
 * a worker restart re-registering the level, a safety-order fill recomputing
 * it downwards (spec §2.3, §2.4) — the next tick closed the deal at whatever
 * the price was by then (spec §1.2).
 *
 * Fixtures are the production deal of spec §2.1: SOL-EUR, `useSl: false`,
 * `trailingTp: true`, `tpPerc: '0.800'`, `trailingTpPerc: '0.200'`, average
 * 86.8438, armed level 89.63038, executed at 85.44 for −60.29 EUR.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection. Nothing here places,
 * cancels or saves anything.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MathHelper } from '../../utils/math'
import {
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  CloseConditionEnum,
  ExchangeEnum,
} from '../../../types'

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b02'
const DEAL_ID = '000000000000000000000d02'
const SYMBOL = 'LAB-EUR'

/** The reporter's average entry and the level the trail armed at (spec §2.1). */
const AVG = 86.84381886931739
const ARMED_LEVEL = 89.63038
/** Kraken spot taker; the floor charges it twice (entry + exit). */
const TAKER = 0.0026
/** avg * (1 + 2 * taker) = 87.2954 — the long break-even price. */
const BREAK_EVEN = AVG * (1 + TAKER * 2)

type Case = {
  settings: Record<string, unknown>
  trailingMode?: string
  trailingLevel?: number
  priceToClose: number
  price: number
  avgPrice?: number
  isLong?: boolean
  taker?: number
}

/**
 * The reporter's bot: trailing take profit only, stop loss switched OFF, so
 * the trailing arm is the only thing that can close the deal (spec §2.1).
 */
const TTP: Case = {
  settings: {
    useSl: false,
    trailingSl: false,
    slPerc: '-10',
    useTp: true,
    trailingTp: true,
    trailingTpPerc: '0.200',
    tpPerc: '0.800',
    dealCloseCondition: CloseConditionEnum.tp,
    dealCloseConditionSL: CloseConditionEnum.tp,
    useMultiTp: false,
    multiTp: [],
    useMultiSl: false,
    multiSl: [],
    useMinTP: false,
    moveSL: false,
  },
  trailingMode: 'ttp',
  trailingLevel: ARMED_LEVEL,
  priceToClose: ARMED_LEVEL,
  price: 85.44,
}

/**
 * A trailing STOP LOSS, armed, on the same numbers. A stop loss is a
 * loss-taking instrument by definition and must keep closing below break even
 * (spec §5.3).
 */
const TSL: Case = {
  settings: {
    ...TTP.settings,
    useSl: true,
    trailingSl: true,
    slPerc: '3',
    trailingTp: false,
  },
  trailingMode: 'tsl',
  trailingLevel: ARMED_LEVEL,
  priceToClose: ARMED_LEVEL,
  price: 85.44,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u02'
  isLong = true
  futures = false
  coinm = false
  combo = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    exchange: ExchangeEnum.kraken,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/**
 * Runs the real `checkDealsStopLoss` over one deal whose registered level the
 * incoming tick has crossed, and reports whether a close was triggered and
 * what the deal's trailing state looks like afterwards.
 */
const runCheck = async (c: Case) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    symbol: { symbol: SYMBOL, baseAsset: 'LAB', quoteAsset: 'EUR' },
    status: DCADealStatusEnum.open,
    trailingMode: c.trailingMode,
    trailingLevel: c.trailingLevel,
    bestPrice: 89.81,
    avgPrice: c.avgPrice ?? AVG,
    initialPrice: c.avgPrice ?? AVG,
    lastPrice: c.price,
    settings: {},
    tpSlTargetFilled: [],
  }

  class TestBot extends Helper {
    public captured: (DCACloseTriggerEnum | undefined)[] = []
    public saved: Record<string, unknown>[] = []
    public logs: string[] = []
    allowedMethods = new Set(['checkDealsStopLoss'])
    dealsForStopLoss = new Map([[DEAL_ID, c.priceToClose]])
    isLong = c.isLong ?? true

    getDeal(id: string) {
      return id === DEAL_ID ? { deal, closeBySl: false } : undefined
    }
    getLastStreamData() {
      return { price: c.price }
    }
    async getAggregatedSettings() {
      return c.settings
    }
    /** Defined on the real bot base class, not on `FakeBase`. */
    async getUserFee() {
      return { maker: c.taker ?? TAKER, taker: c.taker ?? TAKER }
    }
    async closeDealById(
      _botId: string,
      _dealId: string,
      _closeType: unknown,
      _reopen: unknown,
      _forceMarket: unknown,
      _closeByMulti: unknown,
      _checkProfit: unknown,
      _price: unknown,
      _liquidationPrice: unknown,
      _sl: unknown,
      closeTrigger?: DCACloseTriggerEnum,
    ) {
      this.captured.push(closeTrigger)
    }
    async saveDeal(_d: unknown, fields?: Record<string, unknown>) {
      if (fields) {
        this.saved.push(fields)
      }
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn() {}
    handleErrors(m: string) {
      this.logs.push(`ERROR ${m}`)
    }
  }

  const bot: any = new TestBot()
  await bot.checkDealsStopLoss(BOT_ID, SYMBOL)
  return {
    trigger: bot.captured[0] as DCACloseTriggerEnum | undefined,
    calls: bot.captured.length as number,
    deal,
    saved: bot.saved as Record<string, unknown>[],
    logs: (bot.logs as string[]).join('\n'),
  }
}

describe('trailing take profit break-even floor (spec 049)', () => {
  before(function () {
    // One ts-node compile of a 23k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§5.1 an armed trailing take profit does not close below break even', async () => {
    // The reported close: level 89.63 armed, price already down at 85.44,
    // average 86.84. This booked −60.29 EUR.
    const { calls, trigger } = await runCheck(TTP)
    expect(calls, 'no close may be triggered below break even').to.equal(0)
    expect(trigger).to.equal(undefined)
  })

  it('§5.1 the stale trail is disarmed, so a restart cannot re-register it', async () => {
    const { deal, saved } = await runCheck(TTP)
    expect(deal.trailingLevel).to.equal(0)
    expect(deal.trailingMode).to.equal(undefined)
    expect(deal.bestPrice).to.equal(0)
    // Persisted: `setDealForStopLoss` rebuilds the level from the deal on the
    // next worker start, so an in-memory-only reset would not survive.
    const persisted = saved.find((f) => 'trailingLevel' in f)
    expect(persisted, 'the disarm must be written to the deal').to.not.equal(
      undefined,
    )
    expect(persisted).to.deep.include({
      trailingLevel: 0,
      trailingMode: undefined,
      bestPrice: 0,
    })
  })

  it('§5.2 an armed trailing take profit still closes above break even', async () => {
    // The ordinary exit: price retraces onto the armed level, still in profit.
    const { calls, trigger } = await runCheck({ ...TTP, price: ARMED_LEVEL })
    expect(calls).to.equal(1)
    expect(trigger).to.equal(DCACloseTriggerEnum.trailing)
  })

  it('§5.2 a close just above break even is still allowed', async () => {
    const { calls } = await runCheck({ ...TTP, price: BREAK_EVEN * 1.0001 })
    expect(calls).to.equal(1)
  })

  it('§5.4 the round-trip fee is part of the floor', async () => {
    // 87.00 is above the raw average (86.8438) but below break even
    // (87.2954): profitable only if the taker fee is ignored on both legs.
    const { calls } = await runCheck({ ...TTP, price: 87.0 })
    expect(calls, 'a fee-negative close is still a loss').to.equal(0)
  })

  it('§5.4 a zero-fee venue floors at the bare average', async () => {
    const withFee = await runCheck({ ...TTP, price: 87.0, taker: 0 })
    expect(withFee.calls).to.equal(1)
  })

  it('§5.3 an armed trailing stop loss still closes below break even', async () => {
    // Same numbers, `tsl` instead of `ttp`. A stop loss exists to take losses.
    const { calls, trigger } = await runCheck(TSL)
    expect(calls).to.equal(1)
    expect(trigger).to.equal(DCACloseTriggerEnum.trailing)
  })

  it('§5.4 the floor follows deal direction on a short', async () => {
    // Short: break even is BELOW the average, and 102 against an average of
    // 100 is a loss. `last >= priceToClose` is the short level test.
    const short: Case = {
      ...TTP,
      isLong: false,
      avgPrice: 100,
      trailingLevel: 98,
      priceToClose: 98,
      price: 102,
    }
    expect((await runCheck(short)).calls).to.equal(0)
    // ...and a genuine short profit still closes.
    expect((await runCheck({ ...short, price: 98 })).calls).to.equal(1)
  })

  it('§5.5 disarming clears all three fields and persists them', async () => {
    // The real `disarmTrailing`, driven off the prototype.
    const deal: any = {
      _id: DEAL_ID,
      trailingMode: 'ttp',
      trailingLevel: ARMED_LEVEL,
      bestPrice: 89.81,
    }
    const saved: Record<string, unknown>[] = []
    const bot: any = Object.create(Helper.prototype)
    bot.saveDeal = async (_d: unknown, fields: Record<string, unknown>) => {
      saved.push(fields)
    }
    await bot.disarmTrailing({ deal })

    expect(deal.trailingLevel).to.equal(0)
    expect(deal.trailingMode).to.equal(undefined)
    // `bestPrice` matters as much as the level: `checkTrailing` only
    // recomputes once price beats the stored extreme, so a trail left with the
    // old high would not re-arm against a high it may never revisit.
    expect(deal.bestPrice).to.equal(0)
    expect(saved).to.have.length(1)
    expect(saved[0]).to.deep.equal({
      trailingLevel: 0,
      trailingMode: undefined,
      bestPrice: 0,
    })
  })

  it('§5.5 a terminally rejected close disarms the trail', () => {
    // Wiring pin, not a behavioural drive: reaching the rejection branch of
    // `closeDealById` needs a built close order and a live venue call. What
    // must hold is that the branch writing the CANCELED MARKET row through
    // `handleOrderErrors` — the one the venue lockout took — disarms before it
    // returns, rather than leaving the level armed for the next worker start.
    const src = readFileSync(join(__dirname, '..', 'dcaHelper.ts'), 'utf8')
    const marker = src.indexOf('Send new order request ${tpOrder.')
    expect(marker, 'the close-rejection branch still exists').to.be.greaterThan(
      -1,
    )
    // Wide enough to span the branch's own body, narrow enough that a
    // `disarmTrailing` somewhere else in the file cannot satisfy it. Widened
    // for spec 050, which put the retry decision ahead of the disarm in this
    // same branch — the disarm is still what happens when the refusal is not
    // one worth retrying.
    const branch = src.slice(marker, marker + 2500)
    expect(branch).to.contain('disarmTrailing')
  })

  it('§5.1 a safety-order fill that moved the average is picked up', async () => {
    // The average is read through `dealRefPrice`, so the floor is measured
    // against the CURRENT average, not the one the level was armed against.
    // Average lowered to 84.00 by a safety order: 85.44 is now a real profit.
    const { calls } = await runCheck({ ...TTP, avgPrice: 84.0 })
    expect(calls).to.equal(1)
  })
})
