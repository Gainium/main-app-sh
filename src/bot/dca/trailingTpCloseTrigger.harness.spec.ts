process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `042.a-trailing-take-profit-exit-is-recorded-as-a-stop-loss`.
 *
 * Drives the REAL `dcaHelper.checkDealsStopLoss` — the single place the close
 * trigger is decided — and the REAL `triggerStopLoss` it calls, capturing the
 * `DCACloseTriggerEnum` that reaches `closeDealById` (which is where the value
 * is persisted onto the deal).
 *
 * The defect: the trailing arm of the decision tested `!multiTp`, and `multiTp`
 * is `MultiTP[]` — the multi-take-profit *targets*, materialised as `[]` by
 * mongoose on every bot that never configured one. `![]` is `false`, so the
 * trailing-take-profit arm could never be true and every trailing take-profit
 * exit was recorded as a stop loss — on bots whose owners had stop loss
 * switched off (spec §1.2, §2.1).
 *
 * Fixtures mirror the production cohort of spec §2.1 (`useSl: false`,
 * `trailingTp: true`, `trailingMode: 'ttp'`, an armed `trailingLevel`) and the
 * §2.4 cohort that must NOT move (`useSl: true`, `trailingSl: false`,
 * `trailingTp: true`, trailing never armed — a genuine stop loss).
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection. Nothing here places,
 * cancels or saves anything.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  CloseConditionEnum,
  ExchangeEnum,
} from '../../../types'

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b01'
const DEAL_ID = '000000000000000000000d01'
const SYMBOL = 'LAB-USDT'

type Case = {
  /** Aggregated settings the engine reads for this deal. */
  settings: Record<string, unknown>
  /** The trailing state stamped on the deal. */
  trailingMode?: string
  trailingLevel?: number
  /** The level registered in `dealsForStopLoss`, and the tick that hits it. */
  priceToClose: number
  price: number
}

/**
 * A trailing-take-profit-only bot: stop loss switched OFF, so neither of the
 * two stop-loss branches below the trailing arm can be reached either.
 * `multiTp: []` is exactly what mongoose hands the engine (spec §2.1).
 */
const TTP_ONLY: Case = {
  settings: {
    useSl: false,
    trailingSl: false,
    useTp: true,
    trailingTp: true,
    trailingTpPerc: '0.2',
    tpPerc: '2',
    dealCloseCondition: CloseConditionEnum.tp,
    useMultiTp: false,
    multiTp: [],
    useMultiSl: false,
    multiSl: [],
  },
  trailingMode: 'ttp',
  trailingLevel: 0.071676,
  priceToClose: 0.071676,
  price: 0.0716,
}

/** The same bot with multi-take-profit genuinely in use (spec §4.4). */
const TTP_WITH_MULTI_TP: Case = {
  ...TTP_ONLY,
  settings: {
    ...TTP_ONLY.settings,
    useMultiTp: true,
    multiTp: [{ uuid: 'a', target: '2' }],
  },
}

/** A trailing stop loss, armed — must stay `trailing` (spec §4.2). */
const TSL: Case = {
  settings: {
    useSl: true,
    trailingSl: true,
    slPerc: '3',
    dealCloseConditionSL: CloseConditionEnum.tp,
    useTp: true,
    trailingTp: false,
    dealCloseCondition: CloseConditionEnum.tp,
    useMultiSl: false,
    multiSl: [],
    useMultiTp: false,
    multiTp: [],
    moveSL: false,
  },
  trailingMode: 'tsl',
  trailingLevel: 0.071676,
  priceToClose: 0.071676,
  price: 0.0716,
}

/**
 * A REAL stop loss on a bot that also offers trailing take profit, with
 * trailing never armed: `getDealStopLossPrice` registered the stop-loss level,
 * not a trailing one, so this close is a stop loss (spec §2.4, §4.3).
 */
const REAL_SL_ON_TTP_BOT: Case = {
  settings: {
    useSl: true,
    trailingSl: false,
    slPerc: '5',
    dealCloseConditionSL: CloseConditionEnum.tp,
    useTp: true,
    trailingTp: true,
    trailingTpPerc: '0.2',
    tpPerc: '2',
    dealCloseCondition: CloseConditionEnum.tp,
    useMultiSl: false,
    multiSl: [],
    useMultiTp: false,
    multiTp: [],
    moveSL: false,
  },
  trailingMode: undefined,
  trailingLevel: undefined,
  priceToClose: 0.0655,
  price: 0.0654,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000u01'
  isLong = true
  futures = false
  coinm = false
  combo = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    settings: {},
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/**
 * Runs the real `checkDealsStopLoss` over one deal whose registered level the
 * incoming tick has just crossed, and returns the trigger that reached
 * `closeDealById`.
 */
const triggerFor = async (c: Case) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    symbol: { symbol: SYMBOL, baseAsset: 'LAB', quoteAsset: 'USDT' },
    status: DCADealStatusEnum.open,
    trailingMode: c.trailingMode,
    trailingLevel: c.trailingLevel,
    avgPrice: 0.0695,
    initialPrice: 0.0695,
    lastPrice: c.price,
    settings: {},
    tpSlTargetFilled: [],
  }

  class TestBot extends Helper {
    public captured: (DCACloseTriggerEnum | undefined)[] = []
    public logs: string[] = []
    allowedMethods = new Set(['checkDealsStopLoss'])
    dealsForStopLoss = new Map([[DEAL_ID, c.priceToClose]])

    getDeal(id: string) {
      return id === DEAL_ID ? { deal, closeBySl: false } : undefined
    }
    getLastStreamData() {
      return { price: c.price }
    }
    async getAggregatedSettings() {
      return c.settings
    }
    /** The real `triggerStopLoss` runs; this is where the value lands. */
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
    async saveDeal() {}
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
    logs: (bot.logs as string[]).join('\n'),
  }
}

describe('checkDealsStopLoss close trigger (spec 042)', () => {
  before(function () {
    // One ts-node compile of a 23k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 a trailing take-profit exit is recorded as `trailing`, not `sl`', async () => {
    const { trigger, calls } = await triggerFor(TTP_ONLY)
    expect(calls).to.equal(1)
    expect(trigger).to.equal(DCACloseTriggerEnum.trailing)
  })

  it('§4.1 `multiTp: []` (mongoose default) does not suppress the trailing arm', async () => {
    // The whole defect: `![]` is false, so the arm was dead for every bot.
    const withTargetsKeyAbsent = await triggerFor({
      ...TTP_ONLY,
      settings: { ...TTP_ONLY.settings, multiTp: undefined },
    })
    const withEmptyTargets = await triggerFor(TTP_ONLY)
    expect(withEmptyTargets.trigger).to.equal(withTargetsKeyAbsent.trigger)
    expect(withEmptyTargets.trigger).to.equal(DCACloseTriggerEnum.trailing)
  })

  it('§4.1 the close is announced, so the decision is traceable in the log', async () => {
    const { logs } = await triggerFor(TTP_ONLY)
    expect(logs).to.contain('Trailing trigger mode')
    expect(logs).to.contain('TTP')
  })

  it('§4.2 an armed trailing stop loss is still recorded as `trailing`', async () => {
    const { trigger } = await triggerFor(TSL)
    expect(trigger).to.equal(DCACloseTriggerEnum.trailing)
  })

  it('§4.3 a real stop loss on a trailing-take-profit bot stays `sl`', async () => {
    // Trailing was never armed, so the level hit was the stop-loss level.
    // Labelling this `trailing` is the defect commit 9092ca79 fixed.
    const { trigger, logs } = await triggerFor(REAL_SL_ON_TTP_BOT)
    expect(trigger).to.equal(DCACloseTriggerEnum.sl)
    expect(logs).to.contain('closing by stop loss')
  })

  it('§4.4 a bot genuinely using multi take profit is not labelled `trailing`', async () => {
    const { trigger } = await triggerFor(TTP_WITH_MULTI_TP)
    expect(trigger).to.equal(DCACloseTriggerEnum.sl)
  })

  it('§4.5 a tick that has not reached the level closes nothing', async () => {
    const { calls } = await triggerFor({ ...TTP_ONLY, price: 0.072 })
    expect(calls).to.equal(0)
  })
})
