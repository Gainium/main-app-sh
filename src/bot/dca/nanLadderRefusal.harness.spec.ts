process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `025.a-nan-quantity-reaches-the-venue-and-poisons-the-deal` (issue #715),
 * ladder half.
 *
 * Drives the REAL `dcaHelper.createInitialDealOrders` — not a
 * reimplementation — over the recorded production configuration of bot
 * `6a8b89e98e06bef801add796` (coinbase, SWFTC-USDC, `orderSizeType: 'quote'`,
 * `orderSize: '33'`, `dcaCondition: 'percentage'`, 30 levels, `volumeScale`
 * 1.05), which on 2026-09-08T13:18:25.588Z logged
 *
 *   Big number error [big.js] Invalid number Method createInitialDealOrders Step dca
 *
 * 24 ms before the take-profit failure spec `023` was written from, and then
 * could not save `usage.maxUsd` / `assets.required.base` for 41 minutes.
 *
 * The ladder's quantity is `orderSize / (_price ?? price)`. `??` passes a `0`
 * straight through, `33 / 0` is Infinity, and `MathHelper.round` turns that
 * into NaN (spec 023 §2.3) — after which every clamp is a no-op, the
 * `new Big(qty)` throw is swallowed by the `Step dca` catch, and the level is
 * pushed onto the ladder regardless.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing
 * here places or cancels anything.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'

/** Bot `6a8b89e98e06bef801add796` as production `bots` describes it. */
const settings: any = {
  useDca: true,
  useTp: true,
  useSl: false,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dcaCondition: 'percentage',
  dcaVolumeBaseOn: 'scale',
  dcaByMarket: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  strategy: 'long',
  ordersCount: 30,
  orderSize: '33',
  orderSizeType: 'quote',
  orderSizePercQty: 0,
  baseOrderSize: '100',
  tpPerc: '1',
  slPerc: '0',
  step: '1',
  stepScale: '1',
  volumeScale: '1.05',
  minimumDeviation: '1',
  dcaVolumeMaxValue: '-1',
  multiTp: [],
  multiSl: [],
  dcaCustom: [],
  indicators: [],
  futures: false,
  coinm: false,
  leverage: 1,
}

/** SWFTC-USDC as production `pairs` describes it: whole-coin steps. */
const EXCHANGE_INFO: any = {
  pair: 'SWFTC-USDC',
  baseAsset: { minAmount: 1, maxAmount: 0, step: 1, name: 'SWFTC' },
  quoteAsset: { minAmount: 1, step: 0.000001, precision: 6, name: 'USDC' },
  priceAssetPrecision: 6,
}

const DEAL_ID = '6a9fca447794d53dedbab119'
const INITIAL_PRICE = 0.002611739121360743

const DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'SWFTC-USDC', baseAsset: 'SWFTC', quoteAsset: 'USDC' },
  status: 'open',
  initialPrice: INITIAL_PRICE,
  lastPrice: 0.0026,
  avgPrice: 0.002605506233730648,
  // Verified read-only on prod: empty, so it contributes 0 to every level.
  sizes: { dca: [], origDca: [] },
  gridBreakpoints: [],
  blockOrders: [],
  dynamicAr: [],
}

class FakeBase {
  math = new MathHelper()
  botId = '6a8b89e98e06bef801add796'
  userId = '6a8b1db88e06bef801d752bd'
  // Real `MainBot` getters. FakeBase owns them as plain fields so the mixin
  // reads the values this suite pins rather than deriving them from a config
  // it has no stack to load.
  isLong = true
  futures = false
  coinm = false
  combo = false
  kucoinSpot = false
  zeroFee = false
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  data: any = {
    settings,
    exchange: ExchangeEnum.coinbase,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (baseOrder?: any) => {
  class TestBot extends Helper {
    public errors: string[] = []

    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal: DEAL, initialOrders: [], currentOrders: [] }
        : undefined
    }
    getOrdersByStatusAndDealId() {
      return baseOrder ? [baseOrder] : []
    }
    findBaseOrderByDeal() {
      return baseOrder
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getUserFee() {
      return { maker: 0.006, taker: 0.012 }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getLatestPrice() {
      return DEAL.lastPrice
    }
    async profitBase() {
      return false
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    getOrderId(prefix: string) {
      return `${prefix}-wNa2CKPAwo3IEmZ9So23q2zVHTNTH2`
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors(m: string) {
      this.errors.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

/** `_price` is the FIFTH argument — the price the ladder sizes against. */
const buildLadder = async (sizingPrice?: number, baseOrder?: any) => {
  const bot: any = buildBot(baseOrder)
  const orders = await bot.createInitialDealOrders(
    'SWFTC-USDC',
    INITIAL_PRICE,
    DEAL_ID,
    DEAL,
    sizingPrice,
  )
  return { orders: orders as any[], errors: bot.errors as string[] }
}

describe('DCA ladder NaN refusal (spec 025, issue #715)', () => {
  before(function () {
    // One ts-node compile of a 22k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.2 builds no ladder level with a non-finite quantity', async () => {
    // Production built 30 of them: `33 / 0` -> Infinity -> round() -> NaN,
    // reported only as the swallowed `[big.js] Invalid number`.
    const { orders } = await buildLadder(0)
    const bad = orders.filter((o) => !Number.isFinite(o.qty))
    expect(
      bad.length,
      `${bad.length} of ${orders.length} level(s) came back with a non-finite qty`,
    ).to.equal(0)
  })

  it('§4.2 refuses the whole ladder rather than returning a partial one', async () => {
    const { orders } = await buildLadder(0)
    expect(orders).to.be.an('array')
    expect(orders).to.have.length(0)
  })

  it('§4.3 says so loudly instead of only swallowing the big.js throw', async () => {
    const { errors } = await buildLadder(0)
    expect(errors.join('\n')).to.not.contain('Big number error')
    expect(errors.join('\n')).to.contain('Latest price is 0')
  })

  it('§4.2 a non-finite sizing price is refused the same way', async () => {
    const { orders } = await buildLadder(NaN)
    expect(orders).to.have.length(0)
  })

  it('§4.2 an unreadable persisted base-order quantity is refused too', async () => {
    // `bo.origQty` is a STRING on the order row. `parseFloat('NaN')` is falsy
    // and harmlessly falls through to the nominal size — but `'Infinity'` is
    // truthy, and `math.round` turns it into NaN, which every take-profit
    // clamp below then compares against and ignores.
    const { orders, errors } = await buildLadder(undefined, {
      dealId: DEAL_ID,
      typeOrder: 'dealStart',
      status: 'FILLED',
      executedQty: '1',
      origQty: 'Infinity',
      price: `${INITIAL_PRICE}`,
    })
    expect(orders).to.have.length(0)
    expect(errors.join('\n')).to.contain('Order qty is not a number')
  })

  it('§4.5 a readable persisted base-order quantity still sizes the ladder', async () => {
    const { orders, errors } = await buildLadder(undefined, {
      dealId: DEAL_ID,
      typeOrder: 'dealStart',
      status: 'FILLED',
      executedQty: '38288',
      origQty: '38288',
      price: `${INITIAL_PRICE}`,
    })
    expect(errors).to.have.length(0)
    expect(orders.filter((o) => o.type === 'dealRegular')).to.have.length(30)
  })

  it('§4.5 a ladder with no sizing-price override is untouched', async () => {
    // Pinned from the pre-fix run of this same fixture: the guard must not
    // move a single unit on a healthy ladder.
    const { orders, errors } = await buildLadder(undefined)
    expect(errors).to.have.length(0)
    expect(orders).to.have.length(31)
    const regular = orders.filter((o) => o.type === 'dealRegular')
    expect(regular).to.have.length(30)
    expect(regular.every((o) => Number.isFinite(o.qty) && o.qty > 0)).to.equal(
      true,
    )
    expect(regular[0].qty).to.equal(12761)
    expect(regular[0].price).to.equal(0.002586)
    expect(regular[29].qty).to.equal(74144)
    expect(regular[29].price).to.equal(0.001832)
  })

  it('§4.5 a healthy sizing-price override is untouched', async () => {
    const { orders, errors } = await buildLadder(DEAL.lastPrice)
    expect(errors).to.have.length(0)
    const regular = orders.filter((o) => o.type === 'dealRegular')
    expect(regular).to.have.length(30)
    expect(regular[0].qty).to.equal(12692)
  })
})
