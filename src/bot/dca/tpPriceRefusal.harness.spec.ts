process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `035.deal-close-price-is-laundered-from-zero-into-a-giveaway` (issue #731).
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over the
 * recorded production state behind `D-TP-m2hygo2sAbY4CBFiarHyCGPBgZ1aVx`
 * (SWFTC-USDC, coinbase, 2026-09-08T13:59:36.725Z):
 *
 *   SELL 51029 @ 0.00002 LIMIT   while the market was 0.002561
 *   origPrice '0.00002'   price '0.002561'
 *
 * Sibling of `tpNanRefusal.harness.spec.ts` (spec 023) and
 * `nanLadderRefusal.harness.spec.ts` (spec 025), and deliberately the inverse
 * of both: nothing here is NaN. The deal held a real, fully-filled position,
 * so the quantity leg is finite and correct and every finiteness guard those
 * specs added is satisfied. Only the PRICE was unusable, and it was repaired
 * into a well-formed, tradeable, 128×-wrong number:
 *
 *   avgPrice 0 -> tpPrice 0                        (:14498, every factor × 0)
 *              -> 0.000001   one-tick nudge        (:14505, fires on 0 === 0)
 *              -> passes `tpPrice <= 0`            (:14618, 106 lines too late)
 *              -> 0.00002    ceil(minAmount / qty) (:14795, 1/51029 = 1.9597e-5)
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

/** The market SWFTC-USDC was actually trading at when the close was built. */
const MARKET = 0.002561

/**
 * The position the close was sized from: one filled entry of 51029 SWFTC.
 * This is what makes #731 distinct from #714 — the QUANTITY leg is healthy.
 */
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
  newClientOrderId: 'D-BO-m2hygo2sAbY4CBFiarHyCGPBgZ1aVx',
}

/** A deal holding a real position, priced normally. The control. */
const HEALTHY_DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'SWFTC-USDC', baseAsset: 'SWFTC', quoteAsset: 'USDC' },
  status: 'open',
  size: 51029,
  tpHistory: [],
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
 * only the prices came back 0. This is the state that produced the row.
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

const buildBot = (deal: any, orders: any[], isLong: boolean, latest: number) => {
  class TestBot extends Helper {
    public errors: string[] = []
    public isLong = isLong

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
      return { maker: 0, taker: 0 }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    /**
     * The live market. Deliberately answers even when the DEAL's prices are 0:
     * that is the whole point of §4.4 — the reference price a sanity bound
     * needs is available at the moment the giveaway order is built.
     */
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
      return `${prefix}-m2hygo2sAbY4CBFiarHyCGPBgZ1aVx`
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

const buildTp = async (
  deal: any,
  {
    orders = [ENTRY_ORDER],
    isLong = true,
    latest = MARKET,
    price,
  }: {
    orders?: any[]
    isLong?: boolean
    latest?: number
    price?: number
  } = {},
) => {
  const bot: any = buildBot(deal, orders, isLong, latest)
  const tps = await bot.getTPOrder(
    'SWFTC-USDC',
    deal?.lastPrice ?? 0,
    [],
    deal?.avgPrice ?? 0,
    deal?.initialPrice ?? 0,
    DEAL_ID,
    deal,
    false,
    false,
    price,
  )
  return { tps, errors: bot.errors as string[] }
}

describe('getTPOrder zero-price refusal (spec 035, issue #731)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 refuses to build a close when the price it derives from is 0', async () => {
    // Production built one anyway: SELL 51029 @ 0.00002 against a 0.002561
    // market, which the venue ACCEPTED and filled at 0.002561.
    const { tps } = await buildTp(PRICELESS_DEAL)
    expect(tps).to.be.an('array')
    expect(tps).to.have.length(
      0,
      `getTPOrder priced a close at ${tps?.[0]?.price} for qty ${tps?.[0]?.qty} with no usable price`,
    )
  })

  it('§4.1 says so with a named error rather than silently', async () => {
    const { errors } = await buildTp(PRICELESS_DEAL)
    expect(errors.join('\n')).to.match(/not a number|price/i)
  })

  it('§4.1 the refusal covers a short deal too (already immune — regression guard)', async () => {
    // Honest note: this one passed BEFORE the fix as well, and that is worth
    // recording rather than reading as evidence. Shorts escaped by accident of
    // sign — the nudge SUBTRACTS a tick for a short, so 0 became -0.000001,
    // which spec 023's `tpPrice <= 0` guard did catch. Only longs were
    // exposed. This pins that shorts stay refused for a stated reason now.
    const { tps } = await buildTp(PRICELESS_DEAL, { isLong: false })
    expect(tps).to.have.length(
      0,
      `short getTPOrder priced a close at ${tps?.[0]?.price}`,
    )
  })

  it('§2.2 the giveaway price is exactly ceil(minAmount / qty)', () => {
    // Not an assertion about the fix — a pin on the arithmetic that produced
    // the production row, so a future reader can tell which clamp to look at.
    const math = new MathHelper()
    expect(
      math.round(
        EXCHANGE_INFO.quoteAsset.minAmount / 51029,
        EXCHANGE_INFO.priceAssetPrecision,
        false,
        true,
      ),
    ).to.equal(0.00002)
    // ...and it is 128× below the market it was sold into.
    expect(Math.round(MARKET / 0.00002)).to.equal(128)
  })

  it('§4.3 the notional floor is met by quantity where quantity can reach it', async () => {
    // AMENDED by spec `043` §4.2 (issue #755). This case originally asserted
    // that the floor is met by quantity and NEVER by rewriting price. The
    // quantity half stands and is what `043` §4.1 restores; the "never by
    // price" half did not survive production. Refusing outright left 48 live
    // bots with no close order at all, retrying about once a minute for days,
    // because for a long `ceil(minAmount / price) > tpOrder.qty` holds by
    // construction the moment this block is entered — the branch could only
    // ever refuse. `043` reinstates the raise as the SECOND resort, bounded by
    // `MAX_CLOSE_PRICE_DEVIATION` and take-profit only.
    //
    // What #731 was actually about is untouched and still asserted by §4.1 and
    // §4.4 above: a close price that is zero or non-finite never reaches here,
    // and a close priced into the giveaway direction is refused after. Raising
    // a long close moves it away from that direction, so it cannot reach §4.4.
    //
    // 100 units at 0.002561 is 0.256 USDC against a floor of 1. The position
    // cannot reach the floor at any size it owns, so the close rests at
    // ceil(1 / 100) = 0.01 — the lowest price coinbase will accept it at,
    // 3.9x the market and inside the bound.
    const smallDeal: any = {
      ...HEALTHY_DEAL,
      size: 100,
      currentBalances: { base: 100, quote: 0 },
    }
    const smallEntry: any = {
      ...ENTRY_ORDER,
      executedQty: '100',
      origQty: '100',
      cummulativeQuoteQty: '0.2561',
    }
    const { tps, errors } = await buildTp(smallDeal, { orders: [smallEntry] })
    expect(tps).to.have.length(1, errors.join('\n'))
    expect(tps[0].qty).to.equal(100)
    expect(tps[0].price).to.equal(0.01)
    // The invariant that outlives the amendment: whatever it does, the close
    // must clear the venue floor and must stay inside the §4.4 bound.
    expect(tps[0].qty * tps[0].price).to.be.at.least(
      EXCHANGE_INFO.quoteAsset.minAmount,
    )
    expect(tps[0].price).to.be.at.most(MARKET * 10)
  })

  it('§4.4 refuses a close priced orders of magnitude from the live market', async () => {
    // The direct statement of the defect: whatever produced it, a sell two
    // decades below the market must not be submitted. Driven here through the
    // real path via a fixed TP price, which bypasses the §4.1 refusal.
    const { tps } = await buildTp(HEALTHY_DEAL, { price: 0.00002 })
    expect(tps).to.have.length(
      0,
      `getTPOrder returned a close at ${tps?.[0]?.price} against a ${MARKET} market`,
    )
  })

  it('§4.2 a legitimate one-tick nudge still fires', async () => {
    // The nudge exists to break a tie when the computed close lands exactly on
    // avgPrice. Force that: a fixed TP price equal to avgPrice. It must come
    // back one tick above, NOT be refused.
    const { tps } = await buildTp(HEALTHY_DEAL, { price: MARKET })
    expect(tps).to.have.length(1)
    expect(tps[0].price).to.equal(MARKET + 0.000001)
  })

  it('§4.5 a deal with real prices is untouched', async () => {
    // Pinned from the pre-fix run of this same fixture: the guards must not
    // move a single unit on a healthy deal.
    const { tps, errors } = await buildTp(HEALTHY_DEAL)
    expect(tps).to.have.length(1)
    expect(tps[0].qty).to.equal(51029)
    expect(tps[0].price).to.equal(0.002599)
    expect(errors).to.have.length(0)
  })
})
