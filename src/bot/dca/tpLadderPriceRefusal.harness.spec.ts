process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `037.close-price-ladders-repeat-the-zero-price-laundering` (issue #731,
 * re-fix).
 *
 * Spec `035` hardened `getTPOrder`'s SINGLE close order: it refuses a
 * non-derivable price before the one-tick nudge can launder it, meets the
 * venue's notional floor by moving quantity instead of price, and refuses a
 * close priced far enough from the market to give value away.
 *
 * `getTPOrder` builds close prices in THREE structurally identical places.
 * Spec `035` only reached the first. The take-profit ladder
 * (`settings.useMultiTp`) and the stop-loss ladder (`settings.useMultiSl`)
 * each still carry a verbatim copy of the same sequence:
 *
 *   price = avgPrice * (1 +/- target%) * displacement   -> 0 when avgPrice is 0
 *   if (price === avgPrice) price = one tick            -> 0 === 0 fires
 *   (no zero guard anywhere)
 *   if (price * qty < quoteAsset.minAmount)
 *      price = ceil(minAmount / qty)                    -> the giveaway price
 *
 * ...and spec `035`'s market-deviation guard sits ABOVE both ladder blocks,
 * so it never inspects a ladder order at all.
 *
 * Drives the REAL `dcaHelper.getTPOrder` over the same recorded production
 * state as `tpPriceRefusal.harness.spec.ts` (SWFTC-USDC, coinbase), with the
 * ladder settings switched on. `createDCABotHelper` is a mixin factory, so the
 * helper is built on a minimal base class: no stack, DB, Redis or exchange
 * connection is needed. Nothing here places or cancels anything.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'

/** SWFTC-USDC as production `pairs` describes it: whole-coin steps. */
const EXCHANGE_INFO: any = {
  pair: 'SWFTC-USDC',
  baseAsset: { minAmount: 1, step: 1, name: 'SWFTC' },
  quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
  priceAssetPrecision: 6,
}

const DEAL_ID = '6a9fca447794d53dedbab119'

/** The market SWFTC-USDC was actually trading at when the close was built. */
const MARKET = 0.002561

const baseSettings: any = {
  useTp: true,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  multiTp: [],
  multiSl: [],
  tpPerc: '1.5',
  slPerc: '3',
  baseOrderSize: '100',
  orderSizeType: 'quote',
  indicators: [],
}

/** A two-level take-profit ladder: 50% of the position at each target. */
const TP_LADDER = [
  { uuid: 'tp-1', target: '1.5', amount: '50' },
  { uuid: 'tp-2', target: '3', amount: '50' },
]

/** A two-level stop-loss ladder. */
const SL_LADDER = [
  { uuid: 'sl-1', target: '-3', amount: '50' },
  { uuid: 'sl-2', target: '-6', amount: '50' },
]

/** The position the close is sized from: one filled entry of 51029 SWFTC. */
const ENTRY_ORDER: any = {
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  type: 'dealStart',
  status: 'FILLED',
  side: 'buy',
  executedQty: '51029',
  origQty: '51029',
  price: '0.002561',
  cummulativeQuoteQty: '130.685',
  orderId: '1',
  newClientOrderId: 'D-BO-fixture',
}

const HEALTHY_DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'SWFTC-USDC', baseAsset: 'SWFTC', quoteAsset: 'USDC' },
  status: 'open',
  size: 51029,
  tpHistory: [],
  tpSlTargetFilled: [],
  reduceFunds: [],
  funds: [],
  lastPrice: MARKET,
  avgPrice: MARKET,
  initialPrice: MARKET,
  currentBalances: { base: 51029, quote: 0 },
  initialBalances: { base: 0, quote: 130.685 },
}

/**
 * The same deal during the price-lookup outage: the position is still there,
 * only the deal's own prices came back 0.
 */
const PRICELESS_DEAL: any = {
  ...HEALTHY_DEAL,
  lastPrice: 0,
  avgPrice: 0,
  initialPrice: 0,
}

class FakeBase {
  math = new MathHelper()
  // Synthetic — nothing here reads them, and this file is public.
  botId = '000000000000000000000001'
  userId = '000000000000000000000002'
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
    settings: baseSettings,
    exchange: ExchangeEnum.coinbase,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  deal: any,
  settings: any,
  latest: number,
  orders: any[],
) => {
  class TestBot extends Helper {
    public errors: string[] = []
    getDeal(id: string) {
      return deal && id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
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
      // Mirrors the real index lookup. NOTE the trap recorded in
      // `tpSizingFromPosition.harness.spec.ts`: spreading one order fixture
      // into another carries the old `dealId`, and a miss here silently
      // exercises the no-base-order branch instead of the one under test.
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
      return { maker: 0, taker: 0 }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getLatestPrice() {
      return latest
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
      return `${prefix}-fixture`
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

const buildTpWith = async (
  deal: any,
  orders: any[],
  {
    settings = baseSettings,
    latest = MARKET,
    price,
    sl = false,
  }: { settings?: any; latest?: number; price?: number; sl?: boolean } = {},
) => {
  const bot: any = buildBot(deal, settings, latest, orders)
  const tps = await bot.getTPOrder(
    'SWFTC-USDC',
    deal?.lastPrice ?? 0,
    [],
    deal?.avgPrice ?? 0,
    deal?.initialPrice ?? 0,
    DEAL_ID,
    deal,
    false,
    sl,
    price,
  )
  return { tps: tps ?? [], errors: bot.errors as string[] }
}

const buildTp = (deal: any, opts: any = {}) =>
  buildTpWith(deal, [ENTRY_ORDER], opts)

/** How far below the live market a SELL has to sit to be giving value away. */
const GIVEAWAY = MARKET / 10

describe('getTPOrder ladder zero-price refusal (spec 037, issue #731 re-fix)', () => {
  before(function () {
    // One ts-node compile of a 23k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 the SL ladder refuses a level it cannot derive a price for', async () => {
    // The production call site passes the requested close price as BOTH the
    // market reference and the explicit `price` argument, with `sl: true`
    // (dcaHelper.ts:6126). `price` satisfies spec 035's guard on the single
    // order, so the flow reaches the ladder — where the level's own price is
    // still derived from `avgPrice`, which is 0.
    const settings = {
      ...baseSettings,
      useMultiSl: true,
      multiSl: SL_LADDER,
    }
    const { tps } = await buildTp(PRICELESS_DEAL, {
      settings,
      price: MARKET,
      sl: true,
    })
    const giveaway = tps.filter((o: any) => o.price < GIVEAWAY)
    expect(giveaway).to.have.length(
      0,
      `SL ladder priced levels at ${tps
        .map((o: any) => `${o.qty}@${o.price}`)
        .join(', ')} against a ${MARKET} market`,
    )
  })

  it('§4.1 the TP ladder refuses a level it cannot derive a price for', async () => {
    // Same shape through the take-profit ladder: a fixed single TP price keeps
    // spec 035's guard satisfied while the ladder levels themselves fall back
    // to a zero `avgPrice`.
    const settings = {
      ...baseSettings,
      useMultiTp: true,
      multiTp: TP_LADDER,
    }
    const { tps } = await buildTp(PRICELESS_DEAL, {
      settings,
      price: MARKET,
    })
    const giveaway = tps.filter((o: any) => o.price < GIVEAWAY)
    expect(giveaway).to.have.length(
      0,
      `TP ladder priced levels at ${tps
        .map((o: any) => `${o.qty}@${o.price}`)
        .join(', ')} against a ${MARKET} market`,
    )
  })

  it('§4.2 a ladder level is never repriced to reach the notional floor', async () => {
    // The floor must be met by QUANTITY. `ceil(minAmount / qty)` is exactly the
    // arithmetic that produced every one of the production giveaway rows —
    // reproduced here on a fully healthy deal, so the mechanism is shown on its
    // own rather than riding on a zero price.
    //
    // The position has to clear the floor as a WHOLE while each rung does not,
    // or spec 035's single-order guard refuses the call before the ladder is
    // ever built. 600 units at ~0.0026 is ~1.56 USDC — over the venue's floor
    // of 1 — but split 50/50 each rung is ~0.78, under it. That is the ordinary
    // way a ladder reaches this branch, with no bad price anywhere in sight.
    const smallDeal: any = {
      ...HEALTHY_DEAL,
      size: 600,
      currentBalances: { base: 600, quote: 0 },
    }
    const smallEntry: any = {
      ...ENTRY_ORDER,
      executedQty: '600',
      origQty: '600',
      cummulativeQuoteQty: '1.5366',
    }
    const settings = {
      ...baseSettings,
      useMultiTp: true,
      multiTp: TP_LADDER,
    }
    const { tps } = await buildTpWith(smallDeal, [smallEntry], { settings })
    expect(tps.length).to.be.greaterThan(0, 'ladder produced nothing to check')

    // The invariant, stated on the price itself rather than on a formula:
    // whatever the floor does to size, a rung's PRICE must still be one of the
    // prices the ladder derived from `avgPrice`. Asserting `price !== ceil(
    // minAmount / qty)` is not enough and passed pre-fix — the rewrite divides
    // by the rung's size BEFORE the floor moves it, so the final qty no longer
    // reproduces it. Pre-fix this rung came back at 0.003334, the take-profit
    // price inflated 28% by `ceil(1 / 300)`.
    const DERIVED = [0.002599, 0.002638]
    tps.forEach((o: any) => {
      expect(DERIVED).to.include(
        o.price,
        `ladder rung repriced to ${o.price}; the derived ladder prices are ${DERIVED.join(', ')}`,
      )
      // ...and the venue's floor is cleared, by size.
      expect(o.qty * o.price).to.be.at.least(
        EXCHANGE_INFO.quoteAsset.minAmount,
        `rung ${o.qty}@${o.price} is under the venue floor`,
      )
      // Never more than the deal actually holds.
      expect(o.qty).to.be.at.most(
        smallDeal.size,
        `rung sells ${o.qty} of a ${smallDeal.size} position`,
      )
    })
  })

  it('§4.3 a ladder is judged against the market on the same rule as a single close', async () => {
    // Spec 035's market-deviation guard runs BEFORE either ladder is built, so
    // until this fix no ladder level had ever been compared to the market.
    //
    // The state that exposes it: a deal whose entry is real but whose market
    // has run far above it, so the close derived from `avgPrice` sits orders
    // of magnitude below where the position could actually be sold. Spec 035
    // already refuses exactly this on the single close order — the point here
    // is that the ladder must not be the cheaper way to get the same order out.
    // Crucially the SINGLE order stays healthy here, so spec 035's guard does
    // not short-circuit the call before the ladder is reached: the caller
    // supplies a close price at the current market, while every ladder level
    // is still derived from the deal's much older `avgPrice`. Without that,
    // this test would pass pre-fix for the wrong reason.
    const RUNAWAY = MARKET * 1000
    const RUNAWAY_DEAL: any = { ...HEALTHY_DEAL, lastPrice: RUNAWAY }

    const single = await buildTp(RUNAWAY_DEAL, { price: RUNAWAY })
    expect(single.tps).to.have.length(
      1,
      'the single close must survive, or the ladder is never reached',
    )

    const settings = {
      ...baseSettings,
      useMultiTp: true,
      multiTp: TP_LADDER,
    }
    const { tps } = await buildTp(RUNAWAY_DEAL, { settings, price: RUNAWAY })
    expect(tps).to.have.length(
      0,
      `ladder levels ${tps
        .map((o: any) => o.price)
        .join(', ')} rest far below a ${RUNAWAY} market`,
    )
  })

  it('§4.4 a healthy TP ladder is untouched', async () => {
    // The regression pin: the guards must not move a single unit on a deal
    // whose prices are real. Values captured from the pre-fix run.
    const settings = {
      ...baseSettings,
      useMultiTp: true,
      multiTp: TP_LADDER,
    }
    const { tps, errors } = await buildTp(HEALTHY_DEAL, { settings })
    expect(tps).to.have.length(2)
    expect(tps[0].qty).to.equal(25514)
    expect(tps[0].price).to.equal(0.002599)
    expect(tps[1].qty).to.equal(25514)
    expect(tps[1].price).to.equal(0.002638)
    expect(errors).to.have.length(0)
  })

  it('§4.4 a healthy SL ladder is untouched', async () => {
    const settings = {
      ...baseSettings,
      useMultiSl: true,
      multiSl: SL_LADDER,
    }
    const { tps, errors } = await buildTp(HEALTHY_DEAL, {
      settings,
      sl: true,
    })
    expect(tps).to.have.length(2)
    expect(tps[0].qty).to.equal(25514)
    expect(tps[0].price).to.equal(0.002484)
    expect(tps[1].qty).to.equal(25514)
    expect(tps[1].price).to.equal(0.002407)
    expect(errors).to.have.length(0)
  })
})
