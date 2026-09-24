process.env.NODE_ENV = 'testing'

/**
 * `reduceToAvailableBalance` through the REAL `dcaHelper.openNewDeal`: a
 * balance shortfall opens a reduced deal instead of skipping it, a floor keeps
 * it skipped, and with the setting off nothing changes.
 *
 * The sizing itself (`reduceToAvailableRatio`, `scaleDealSizes`) is covered in
 * `reduceToAvailableBalance.harness.spec.ts`; here `scaleDealSizes` only
 * records the ratio it was asked for and hands back a marker, so this file pins
 * the wiring: the ratio reaches it, and its result reaches `placeBaseOrder`.
 *
 * Mixin over a minimal base class — no stack, DB, Redis or venue. Fixture ids
 * are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from '../conditionLatch'
import { ExchangeEnum } from '../../../types'

const BOT_ID = '000000000000000000000b77'
const USER_ID = '000000000000000000000477'
const PAIR = 'SYN-USDT'
const PRICE = 2
/** Base order 100 USDT → 50 SYN at 2; no safety orders in this fixture. */
const REQUIRED = 100
const AVAILABLE = 60

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'SYN', minAmount: 0.1, step: 0.1 },
  quoteAsset: { name: 'USDT', minAmount: 1 },
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
  data: any = {
    settings: { type: 'regular', pair: [PAIR] },
    status: 'open',
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'uuid-77',
    profit: { total: 0 },
    flags: [],
    paperContext: true,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const SIZES_MARKER = { base: -1, dca: [], origBase: 50, origDca: [] }

const buildBot = (settings: Record<string, unknown>) => {
  const raised = {
    errors: [] as any[][],
    placedBase: [] as any[][],
    events: [] as any[],
    ratios: [] as number[],
  }
  class TestBot extends Helper {
    raised = raised
    data: any = new FakeBase().data
    standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
    pairs = new Set([PAIR])
    botEventDb = {
      createData: (e: any) => {
        raised.events.push(e)
      },
    }
    async checkAssets() {
      return new Map([['USDT', { asset: 'USDT', free: AVAILABLE, locked: 0 }]])
    }
    async getAggregatedSettings() {
      return {
        type: 'regular',
        pair: [PAIR],
        skipBalanceCheck: false,
        startCondition: 'ASAP',
        orderSizeType: 'quote',
        baseOrderSize: '100',
        allowRaiseToExchangeMin: true,
        ...settings,
      }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getLeverageMultipler() {
      return 1
    }
    async getLatestPrice() {
      return PRICE
    }
    async getBaseOrder() {
      return { origQty: `${REQUIRED / PRICE}`, price: `${PRICE}` }
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
    async scaleDealSizes(_symbol: string, ratio: number) {
      raised.ratios.push(ratio)
      return SIZES_MARKER
    }
    async checkMaxDeals() {
      return true
    }
    async checkInRange() {
      return true
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
      return m
    }
    stop() {}
  }
  return new TestBot() as any
}

const openDeal = async (bot: any) => {
  let notOpened = false
  await bot.openNewDeal(BOT_ID, PAIR, false, false, 0, () => {
    notOpened = true
  })
  return notOpened
}

describe('reduceToAvailableBalance — openNewDeal wiring', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('opens a reduced deal on a shortfall and says so', async function () {
    // openNewDeal re-checks a shortfall after its own 5 s sleep.
    this.timeout(30000)
    const bot = buildBot({ reduceToAvailableBalance: true })
    const notOpened = await openDeal(bot)
    expect(notOpened).to.equal(false)
    expect(bot.raised.errors, 'a reduced deal is not an error').to.deep.equal(
      [],
    )
    expect(bot.raised.ratios).to.have.length(1)
    expect(bot.raised.ratios[0]).to.be.closeTo(
      (AVAILABLE / REQUIRED) * 0.99,
      1e-9,
    )
    expect(bot.raised.placedBase).to.have.length(1)
    // placeBaseOrder(botId, symbol, _, _, _, _, fixSl, fixTp, fixSize, dynamicAr, sizes)
    expect(bot.raised.placedBase[0][10]).to.equal(SIZES_MARKER)
    expect(bot.raised.events).to.have.length(1)
    expect(bot.raised.events[0].description).to.contain('Opening it at 59.4%')
  })

  it('skips and reports the shortfall when the setting is off', async function () {
    this.timeout(30000)
    const bot = buildBot({ reduceToAvailableBalance: false })
    expect(await openDeal(bot)).to.equal(true)
    expect(bot.raised.placedBase).to.have.length(0)
    expect(bot.raised.ratios).to.have.length(0)
    expect(`${bot.raised.errors[0][0]}`).to.contain(
      'Not enough balance to start new deal',
    )
    expect(`${bot.raised.errors[0][0]}`).to.not.contain('reduced')
  })

  it('skips when the reduced base order is under the floor, naming it', async function () {
    this.timeout(30000)
    // 100 × 0.594 = 59.4 < 60
    const bot = buildBot({
      reduceToAvailableBalance: true,
      reduceToAvailableMinSize: '60',
    })
    expect(await openDeal(bot)).to.equal(true)
    expect(bot.raised.placedBase).to.have.length(0)
    const msg = `${bot.raised.errors[0][0]}`
    expect(msg).to.contain('Not enough balance to start new deal')
    expect(msg).to.contain('minimum reduced base order of 60')
  })

  it('opens a full-size deal, untouched, when funds suffice', async () => {
    const bot = buildBot({
      reduceToAvailableBalance: true,
      baseOrderSize: '50',
    })
    bot.getBaseOrder = async () => ({ origQty: '25', price: `${PRICE}` })
    await openDeal(bot)
    expect(bot.raised.ratios).to.have.length(0)
    expect(bot.raised.placedBase).to.have.length(1)
    expect(bot.raised.placedBase[0][10]).to.equal(undefined)
    expect(bot.raised.events).to.have.length(0)
  })
})
