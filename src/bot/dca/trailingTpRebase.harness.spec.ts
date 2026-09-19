process.env.NODE_ENV = 'testing'

/**
 * A trailing take profit follows the extreme reached since it ARMED.
 *
 * `checkTrailing` only moves the armed level when `last` beats
 * `deal.bestPrice`. A deal that opened high and then averaged down can reach
 * arming with `bestPrice` still holding its opening price; the level then armed
 * once, a fraction below the arming tick, and never moved while price rallied
 * below that old extreme. The deal closed (or was closed by hand) far under
 * the rally's peak.
 *
 * Fixtures mirror a spot XRP-EUR deal: opened near 1.284, averaged down to
 * 1.153563, armed at 1.16756 with a 0.5% trail, rallied to 1.22366.
 *
 * Drives the REAL `checkTrailing` over a minimal base class (the helper is a
 * mixin factory): no stack, DB, Redis or exchange.
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

/** Synthetic ids — this file is public. */
const BOT_ID = '000000000000000000000b61'
const DEAL_ID = '000000000000000000000d61'
const SYMBOL = 'XRP-EUR'

const OPENING_EXTREME = 1.28424
const AVG = 1.153563
const ARMING_LINE = 1.1674
const ARM_TICK = 1.16756
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
  userId = '000000000000000000000u61'
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

const makeDeal = (bestPrice: number): any => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'XRP', quoteAsset: 'EUR' },
  status: DCADealStatusEnum.open,
  trailingMode: undefined,
  trailingLevel: 0,
  bestPrice,
  avgPrice: AVG,
  initialPrice: OPENING_EXTREME,
  lastPrice: AVG,
  size: 34743,
  settings: {},
  tpSlTargetFilled: [],
})

const makeBot = (deal: any) => {
  let price = 0
  class TestBot extends Helper {
    allowedMethods = new Set(['checkTrailing'])
    dealsForTrailing = new Map([
      [
        DEAL_ID,
        {
          trailingTp: true,
          skipTp: false,
          trailingSl: false,
          skipSl: true,
          trailingTpPrice: ARMING_LINE,
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
    /** Copy-on-write, like the real `saveDeal`. */
    async saveDeal(d: any, fields?: Record<string, unknown>) {
      if (fields) {
        this.full = { ...d, deal: { ...this.full.deal, ...fields } }
      }
    }
    async triggerTrailing() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
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

describe('trailing take profit re-bases on arming', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('follows a rally that stays below the deal opening price', async () => {
    const bot = makeBot(makeDeal(OPENING_EXTREME))

    const armed = await bot.tick(ARM_TICK)
    expect(armed.trailingMode).to.equal(TrailingModeEnum.ttp)
    expect(armed.bestPrice).to.equal(ARM_TICK)
    expect(armed.trailingLevel).to.be.closeTo(
      ARM_TICK * (1 - TRAIL / 100),
      1e-9,
    )

    // Before the fix the level stayed at ~1.16172 here.
    const peaked = await bot.tick(PEAK)
    expect(peaked.bestPrice).to.equal(PEAK)
    expect(peaked.trailingLevel).to.be.closeTo(PEAK * (1 - TRAIL / 100), 1e-9)

    const retraced = await bot.tick(1.2)
    expect(retraced.trailingLevel).to.be.closeTo(PEAK * (1 - TRAIL / 100), 1e-9)
  })

  it('still arms from an unset best price', async () => {
    const bot = makeBot(makeDeal(0))
    const armed = await bot.tick(ARM_TICK)
    expect(armed.trailingMode).to.equal(TrailingModeEnum.ttp)
    expect(armed.trailingLevel).to.be.closeTo(
      ARM_TICK * (1 - TRAIL / 100),
      1e-9,
    )
    const peaked = await bot.tick(PEAK)
    expect(peaked.trailingLevel).to.be.closeTo(PEAK * (1 - TRAIL / 100), 1e-9)
  })
})

/**
 * `saveDeal` replaces the map entry with a copy, so a caller that saved (or
 * awaited while something else saved) and then keeps writing to the object it
 * fetched earlier writes onto a stale copy. Two such writes are pinned here:
 * the per-fill `bestPrice` reset in `updateDeal` (lost behind the fee-ledger
 * save) and the funding mirror in `processDealFunding` (which wrote the stale
 * copy back, undoing saves made meanwhile).
 */
const makeLedgerBot = (deal: any) => {
  class LedgerBot extends Helper {
    allowedMethods = new Set(['updateDeal'])
    ordersInBetweenUpdates = new Set<string>()
    dealUpdateOrders = new Map<string, Set<string>>()
    orders = new Map()
    full: any = {
      deal,
      initialOrders: [],
      currentOrders: [],
      previousOrders: [],
      closeBySl: false,
      notCheckSl: false,
    }
    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    /** Copy-on-write, like the real `saveDeal`. */
    saveDeal(d: any, fields?: Record<string, unknown>) {
      if (fields) {
        this.full = { ...d, deal: { ...this.full.deal, ...fields } }
      }
      return Promise.resolve()
    }
    setDeal(d: any) {
      this.full = d
    }
    startMethod() {
      return 'm'
    }
    endMethod() {}
    async computeObservedFeeLedger() {
      return { feeByAsset: [], feePaid: { base: 0, quote: 0 } }
    }
    async getAvgPrice() {
      return { avg: 1.1, display: 1.1 }
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async createCurrentDealOrders() {
      return []
    }
    async checkDealSlMethods() {}
    checkDealsPriceExtremum() {}
    async placeOrders() {}
    findDiff() {
      return []
    }
    updateUsage() {}
    updateDealLastPrices() {}
    updateAssets() {}
    sendSafetyOrderFilledAlert() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    emit() {}
  }
  return new LedgerBot() as any
}

const ledgerDeal = () => ({
  ...makeDeal(OPENING_EXTREME),
  currentBalances: { base: 1000, quote: 0 },
  initialBalances: { base: 0, quote: 1284 },
  levels: { complete: 1, all: 5 },
  funds: [],
  createTime: 1,
})

describe('writes that must survive a saveDeal copy', () => {
  before(function () {
    this.timeout(180000)
    Helper = Helper ?? loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('a safety-order fill resets bestPrice on the live deal', async () => {
    const bot = makeLedgerBot(ledgerDeal())
    await bot.updateDeal(BOT_ID, {
      dealId: DEAL_ID,
      clientOrderId: 'D-RO-test1',
      botId: BOT_ID,
      symbol: SYMBOL,
      side: 'BUY',
      price: '1.1',
      origPrice: '1.1',
      executedQty: '100',
      typeOrder: 'dealRegular',
      status: 'FILLED',
      updateTime: 2,
    })
    // Before the fix this stayed at the opening extreme.
    expect(bot.full.deal.bestPrice).to.equal(0)
    expect(bot.full.deal.avgPrice).to.equal(1.1)
  })

  it('funding settlement does not undo a save made while it was computing', async () => {
    const bot = makeLedgerBot(ledgerDeal())
    bot.toFundingSymbol = async () => 'XRP'
    bot.getSignedFillsFromMemory = () => []
    bot.dealsDb = { updateData: async () => ({ status: 'OK' }) }
    bot.db = { updateData: async () => ({ status: 'OK' }) }
    bot.computeFundingFor = async () => {
      // A fill lands while funding is being computed.
      await bot.saveDeal(bot.full, { avgPrice: 1.05 })
      return {
        applied: 1,
        deltaQuote: -0.5,
        deltaUsd: -0.5,
        maxTime: 10,
        lastTime: 10,
        entries: [],
      }
    }
    await bot.processDealFunding(DEAL_ID)
    expect(bot.full.deal.avgPrice).to.equal(1.05)
    expect(bot.full.deal.funding.total).to.equal(-0.5)
  })
})

describe('more writes that must survive a saveDeal copy', () => {
  before(function () {
    this.timeout(180000)
    Helper = Helper ?? loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('adding funds does not write an addition that filled meanwhile back as pending', async () => {
    const bot = makeLedgerBot({
      ...ledgerDeal(),
      pendingAddFunds: [{ id: 'earlier', qty: '5', limitPrice: 1.0 }],
    })
    const balancesFrom: any[] = []
    bot.getLatestPrice = async () => 1.1
    bot.baseAssetPrecision = async () => 2
    bot.getExchangeInfo = async () => ({
      priceAssetPrecision: 4,
      baseAsset: { minAmount: 0 },
      quoteAsset: { minAmount: 0 },
    })
    bot.getOrderId = (p: string) => `${p}-test`
    bot.updateDealBalances = (d: any) => balancesFrom.push(d)
    bot.sendOrderToExchange = async () => {
      // The earlier pending addition fills while this order is in flight.
      await bot.saveDeal(bot.full, {
        pendingAddFunds: [],
        funds: [{ price: 1.0, qty: 5 }],
      })
      return { status: 'NEW' }
    }
    await bot.addDealFunds(BOT_ID, DEAL_ID, {
      qty: '10',
      asset: 'base',
      useLimitPrice: true,
      limitPrice: '1.1',
      type: 'fixed',
    })
    await new Promise((r) => setImmediate(r))
    const pending = bot.full.deal.pendingAddFunds.map((p: any) => p.id)
    expect(pending).to.have.length(1)
    expect(pending).to.not.include('earlier')
    expect(bot.full.deal.funds).to.have.length(1)
    expect(balancesFrom[0]?.deal.funds).to.have.length(1)
  })

  it('a safety-order fill does not un-arm a stop loss armed meanwhile', async () => {
    const bot = makeLedgerBot(ledgerDeal())
    bot.getAvgPrice = async () => {
      // triggerStopLoss arms a close on the live entry during the fill.
      bot.full.closeBySl = true
      bot.full.notCheckSl = true
      return { avg: 1.1, display: 1.1 }
    }
    await bot.updateDeal(BOT_ID, {
      dealId: DEAL_ID,
      clientOrderId: 'D-RO-test2',
      botId: BOT_ID,
      symbol: SYMBOL,
      side: 'BUY',
      price: '1.1',
      origPrice: '1.1',
      executedQty: '100',
      typeOrder: 'dealRegular',
      status: 'FILLED',
      updateTime: 3,
    })
    expect(bot.full.closeBySl).to.equal(true)
    expect(bot.full.notCheckSl).to.equal(true)
  })

  it('a trailing tick lands on the live deal when it was replaced mid-check', async () => {
    const bot = makeBot(makeDeal(0))
    bot.getAggregatedSettings = async () => {
      // Something saves the deal while the settings are read.
      await bot.saveDeal(bot.full, { lastPrice: 1.16 })
      return SETTINGS
    }
    const armed = await bot.tick(ARM_TICK)
    expect(armed.trailingMode).to.equal(TrailingModeEnum.ttp)
    expect(armed.trailingLevel).to.be.closeTo(
      ARM_TICK * (1 - TRAIL / 100),
      1e-9,
    )
    expect(armed.lastPrice).to.equal(1.16)
  })
})
