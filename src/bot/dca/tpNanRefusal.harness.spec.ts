process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `023.nan-take-profit-quantity-is-write-ahead-persisted`
 * (issue #714).
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over the
 * recorded production state behind
 * `D-TP-wNa2CKPAwo3IEmZ9So23q2zVHTNTH2` (SWFTC-USDC, coinbase, deal
 * `6a9fca447794d53dedbab119`, 2026-09-08T13:18:28Z):
 *
 *   price '0.000001'  origQty 'NaN'  cummulativeQuoteQty 'NaN'
 *   executedQty '0'   orderId '-1'   status 'CANCELED'   type 'LIMIT'
 *
 * The deal's price inputs were 0 and its order map held nothing, so
 * `resolveBaseOrderQty` fell through to the nominal re-derivation, which
 * divides `baseOrderSize` by that price: Infinity, which `MathHelper.round`
 * silently turns into NaN (spec §2.3). Every downstream clamp is a no-op on
 * NaN, `new Big(NaN)` throws and is swallowed, and the order is built anyway —
 * write-ahead persisted as the strings above, which then fail the Number cast
 * on every later deal aggregate.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing
 * here places or cancels anything.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'

const settings: any = {
  useTp: true,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  multiTp: [],
  tpPerc: '1.5',
  slPerc: '3',
  baseOrderSize: '100',
  orderSizeType: 'quote',
  indicators: [],
}

/** SWFTC-USDC as production `pairs` describes it: whole-coin steps. */
const EXCHANGE_INFO: any = {
  pair: 'SWFTC-USDC',
  baseAsset: { minAmount: 1, step: 1, name: 'SWFTC' },
  quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
  priceAssetPrecision: 6,
}

const DEAL_ID = '6a9fca447794d53dedbab119'

/**
 * The deal as `getTPOrder` saw it: nothing priced, nothing in the order map.
 * The persisted document has real numbers — this is the transient state the
 * take-profit was sized from.
 */
const PRICELESS_DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'SWFTC-USDC', baseAsset: 'SWFTC', quoteAsset: 'USDC' },
  status: 'open',
  size: 0,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  lastPrice: 0,
  avgPrice: 0,
  initialPrice: 0,
  currentBalances: { base: 0, quote: 0 },
  initialBalances: { base: 0, quote: 0 },
}

/** The same deal once the venue answered: must be completely unaffected. */
const HEALTHY_DEAL: any = {
  ...PRICELESS_DEAL,
  lastPrice: 0.0026,
  avgPrice: 0.002605506233730648,
  initialPrice: 0.002611739121360743,
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

const buildBot = (deal: any, orders: any[], combo = false) => {
  class TestBot extends Helper {
    public errors: string[] = []
    public combo = combo
    public botType = combo ? 'combo' : 'dca'

    getDeal(id: string) {
      return deal && id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    /** The real index lookup, over the fixture's map rather than a live one. */
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    findBaseOrderByDeal(id: string) {
      return orders.find(
        (o) =>
          o.dealId === id && o.typeOrder === 'dealStart' && +o.executedQty > 0,
      )
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
      return deal?.lastPrice ?? 0
    }
    async profitBase() {
      return false
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    updateDealBalances() {}
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

const buildTp = async (deal: any, orders: any[] = [], combo = false) => {
  const bot: any = buildBot(deal, orders, combo)
  const tps = await bot.getTPOrder(
    'SWFTC-USDC',
    deal?.lastPrice ?? 0,
    [],
    deal?.avgPrice ?? 0,
    deal?.initialPrice ?? 0,
    DEAL_ID,
    deal,
  )
  return { tps, errors: bot.errors as string[] }
}

describe('getTPOrder NaN refusal (spec 023, issue #714)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 refuses to build a take-profit when the sizing is not a number', async () => {
    // Production built one anyway: qty NaN at price 0.000001, which
    // `sendOrderToExchange` write-ahead persisted as origQty "NaN" /
    // cummulativeQuoteQty "NaN" before the venue rejected it.
    const { tps } = await buildTp(PRICELESS_DEAL)
    const qty = tps?.[0]?.qty
    expect(qty === undefined || Number.isFinite(qty)).to.equal(
      true,
      `getTPOrder returned qty ${qty} at price ${tps?.[0]?.price}`,
    )
  })

  it('§4.2 returns [] — not undefined — so callers’ ?.length guards fire', async () => {
    const { tps } = await buildTp(PRICELESS_DEAL)
    expect(tps).to.be.an('array')
    expect(tps).to.have.length(0)
  })

  it('§4.1 says so loudly instead of only swallowing the big.js throw', async () => {
    const { errors } = await buildTp(PRICELESS_DEAL)
    // Today the ONLY thing reported is the caught
    // `Big number error [big.js] Invalid number`, after which the order is
    // built and sent regardless.
    expect(errors.join('\n')).to.contain('not a number')
  })

  it('§4.3 the same refusal covers a combo deal', async () => {
    const { tps } = await buildTp(
      { ...PRICELESS_DEAL, feeBalance: 0 },
      [],
      true,
    )
    const qty = tps?.[0]?.qty
    expect(qty === undefined || Number.isFinite(qty)).to.equal(
      true,
      `combo getTPOrder returned qty ${qty}`,
    )
  })

  it('§4.4 a deal with real prices is untouched', async () => {
    // Pinned from the pre-fix run of this same fixture: the guard must not
    // move a single unit on a healthy deal.
    const { tps, errors } = await buildTp(HEALTHY_DEAL)
    expect(tps).to.have.length(1)
    expect(tps[0].qty).to.equal(37828)
    expect(tps[0].price).to.equal(0.002708)
    expect(errors).to.have.length(0)
  })

  it('§2.3 MathHelper.round turns Infinity into NaN — the invisible step', async () => {
    const math = new MathHelper()
    expect(Number.isNaN(math.round(Infinity, 6))).to.equal(true)
    expect(Number.isNaN(math.round(Infinity, 6, true))).to.equal(true)
  })

  it('§3.6 the minAmount clamps cannot catch NaN', () => {
    // Why the two existing sanity clamps in getTPOrder are no-ops here: every
    // comparison with NaN is false, so neither branch is ever taken.
    expect(NaN < EXCHANGE_INFO.baseAsset.minAmount).to.equal(false)
    expect(
      0.000001 * NaN < EXCHANGE_INFO.quoteAsset.minAmount,
    ).to.equal(false)
  })
})
