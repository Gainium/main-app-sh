process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `043.a-dust-close-is-refused-forever-and-says-nothing` (issue #755), which
 * amends spec `035` §4.3 (#731).
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over three
 * recorded production states, one per shape the `035` §4.3 guard collapses
 * into the same unconditional refusal:
 *
 *   HYPE-USDC  hyperliquid  close sized 0.12, deal holds 0.13, floor 10 USDC
 *              -> 0.13 x 81.449 = 10.59, over the floor. Closeable by QUANTITY.
 *   GRAMUSDT   binance      close sized 2.42, deal holds 2.42, floor 5 USDT
 *              -> 2.42 x 1.608 = 3.89. Closeable only at 2.0661 (1.28x market).
 *   AMPUSDT    binance      close sized 553, deal holds 553, floor 5 USDT
 *              -> 553 x 0.000884 = 0.49. Would need 10.2x the market. Dust.
 *
 * The first two came back `[]` — no close order at all — and the third came
 * back `[]` in silence, about once a minute for as long as the deal stayed
 * open. See the spec's §2.2 table.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing
 * here places or cancels anything.
 *
 * Sibling of `tpPriceRefusal.harness.spec.ts` (spec 035), whose fixtures pin
 * the guards this must NOT revert.
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
  baseOrderSize: '10',
  orderSizeType: 'quote',
  indicators: [],
}

/** hyperliquid's HYPE-USDC: whole-cent base steps against a 10 USDC floor. */
const HYPE: any = {
  pair: 'HYPE-USDC',
  baseAsset: { minAmount: 0.01, step: 0.01, name: 'HYPE' },
  quoteAsset: { minAmount: 10, step: 0.001, name: 'USDC' },
  priceAssetPrecision: 3,
}

/** binance GRAMUSDT, where the held quantity cannot reach the floor. */
const GRAM: any = {
  pair: 'GRAMUSDT',
  baseAsset: { minAmount: 0.01, step: 0.01, name: 'GRAM' },
  quoteAsset: { minAmount: 5, step: 0.001, name: 'USDT' },
  priceAssetPrecision: 3,
}

/** binance AMPUSDT — 0.49 USDT of value against a 5 USDT floor. */
const AMP: any = {
  pair: 'AMPUSDT',
  baseAsset: { minAmount: 1, step: 1, name: 'AMP' },
  quoteAsset: { minAmount: 5, step: 0.000001, name: 'USDT' },
  priceAssetPrecision: 6,
}

const DEAL_ID = '6aa487f0408f26f90486d71a'

/**
 * hyperliquid's taker rate. Load-bearing: it is what turns the 0.13 the deal
 * holds into the 0.1299 the close is sized at, which then FLOORS onto the
 * 0.01 base grid as 0.12 — a whole step below the position, and the reason
 * the notional lands under the venue's floor at all.
 */
const HL_FEE = { maker: 0.00015, taker: 0.00045 }

const dealFor = (
  symbol: string,
  baseAsset: string,
  quoteAsset: string,
  size: number,
  price: number,
): any => ({
  _id: DEAL_ID,
  symbol: { symbol, baseAsset, quoteAsset },
  status: 'open',
  size,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  lastPrice: price,
  avgPrice: price,
  initialPrice: price,
  currentBalances: { base: size, quote: 0 },
  initialBalances: { base: 0, quote: size * price },
})

const entryFor = (size: number, price: number): any => ({
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  type: 'dealStart',
  status: 'FILLED',
  side: 'buy',
  executedQty: `${size}`,
  origQty: `${size}`,
  price: `${price}`,
  cummulativeQuoteQty: `${size * price}`,
  orderId: '1',
  newClientOrderId: 'D-BO-tpDustClose',
})

/** The three production states, with the close price each was refused at. */
const HYPE_DEAL = dealFor('HYPE-USDC', 'HYPE', 'USDC', 0.13, 78.966)
const HYPE_CLOSE_PRICE = 81.449
const GRAM_DEAL = dealFor('GRAMUSDT', 'GRAM', 'USDT', 2.42, 1.608)
const GRAM_CLOSE_PRICE = 1.608
const AMP_DEAL = dealFor('AMPUSDT', 'AMP', 'USDT', 553, 0.000884)
const AMP_CLOSE_PRICE = 0.000884

type Reported = {
  message: string
  setError: boolean
  sendError: boolean
  setEvent: boolean
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
    settings,
    exchange: ExchangeEnum.hyperliquid,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  deal: any,
  orders: any[],
  info: any,
  market: number,
  isLong: boolean,
  fee: { maker: number; taker: number },
) => {
  class TestBot extends Helper {
    public reported: Reported[] = []
    public debugs: string[] = []
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
      return info
    }
    async getUserFee() {
      return fee
    }
    async baseAssetPrecision() {
      return this.math.countDecimals(info.baseAsset.step)
    }
    async getUsdRate() {
      return 1
    }
    async getLatestPrice() {
      return market
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
      return `${prefix}-tpDustClose`
    }
    handleLog() {}
    handleWarn() {}
    handleDebug(m: string) {
      this.debugs.push(m)
    }
    handleErrors(
      message: string,
      _method?: string,
      _step?: string,
      setError = true,
      sendError = true,
      setEvent = true,
    ) {
      this.reported.push({ message, setError, sendError, setEvent })
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

const buildTp = async (
  bot: any,
  deal: any,
  info: any,
  price: number,
  { sl = false, dealId = DEAL_ID }: { sl?: boolean; dealId?: string } = {},
) => {
  // With no deal there is nothing to read the prices off, and `checkBalance`
  // passes the live price for all three (`createCurrentDealOrders(symbol,
  // latestPrice, grids, latestPrice, latestPrice, '')`). Mirror that, or the
  // nominal base order divides by a zero `boPrice` and spec `023`'s NaN guard
  // refuses first — which would make the pre-open case pass vacuously.
  const tps = await bot.getTPOrder(
    info.pair,
    deal?.lastPrice ?? price,
    [],
    deal?.avgPrice ?? price,
    deal?.initialPrice ?? price,
    dealId,
    deal,
    false,
    sl,
    price,
  )
  return tps as { qty: number; price: number }[]
}

/** One bot, one call — the shape most cases want. */
const once = async (
  deal: any,
  info: any,
  price: number,
  opts: {
    sl?: boolean
    isLong?: boolean
    market?: number
    fee?: { maker: number; taker: number }
    orders?: any[]
    dealId?: string
  } = {},
) => {
  const bot: any = buildBot(
    deal,
    opts.orders ?? [entryFor(deal.size, deal.avgPrice)],
    info,
    opts.market ?? price,
    opts.isLong ?? true,
    opts.fee ?? HL_FEE,
  )
  const tps = await buildTp(bot, deal, info, price, {
    sl: opts.sl,
    dealId: opts.dealId,
  })
  return { tps, bot }
}

describe('getTPOrder dust-close refusal (spec 043, issue #755)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§2.1 the close is sized a whole base step under the position', async () => {
    // Not an assertion about the fix — a pin on the arithmetic that produced
    // the production row, so a reader can tell WHY the notional came up short.
    const math = new MathHelper()
    const netted = 0.13 * (1 - HL_FEE.taker)
    expect(math.round(netted, 2, true)).to.equal(0.12)
    expect(0.12 * HYPE_CLOSE_PRICE).to.be.lessThan(HYPE.quoteAsset.minAmount)
    expect(0.13 * HYPE_CLOSE_PRICE).to.be.greaterThan(HYPE.quoteAsset.minAmount)
  })

  it('§4.1 sizes the close to the quantity the deal holds', async () => {
    const { tps } = await once(HYPE_DEAL, HYPE, HYPE_CLOSE_PRICE)
    expect(tps).to.have.length(
      1,
      'a deal holding enough to clear the venue floor got no close order',
    )
    expect(tps[0].qty).to.equal(0.13)
    expect(tps[0].price).to.equal(HYPE_CLOSE_PRICE)
    expect(tps[0].qty * tps[0].price).to.be.greaterThan(
      HYPE.quoteAsset.minAmount,
    )
  })

  it('§4.1 never sells more than the deal holds', async () => {
    // The same deal after a partial take-profit took 0.05 of it: 0.08 left,
    // which cannot reach the floor at any size the deal owns.
    const partly = {
      ...HYPE_DEAL,
      tpHistory: [{ id: 'tp-1', qty: 0.05, price: HYPE_CLOSE_PRICE }],
    }
    const { tps } = await once(partly, HYPE, HYPE_CLOSE_PRICE)
    for (const tp of tps ?? []) {
      expect(tp.qty).to.be.at.most(
        0.08,
        `close sized ${tp.qty} against a position of 0.08`,
      )
    }
  })

  it('§4.2 rests the close at the lowest price the venue accepts', async () => {
    const { tps } = await once(GRAM_DEAL, GRAM, GRAM_CLOSE_PRICE)
    expect(tps).to.have.length(
      1,
      'a closeable position got no close order at all',
    )
    expect(tps[0].qty).to.equal(2.42)
    // ceil(5 / 2.42) at the pair's price precision.
    expect(tps[0].price).to.equal(2.067)
    expect(tps[0].qty * tps[0].price).to.be.at.least(GRAM.quoteAsset.minAmount)
    // ...and it is an ordinary resting take-profit, not an invented number.
    expect(tps[0].price / GRAM_CLOSE_PRICE).to.be.lessThan(1.5)
  })

  it('§4.2 refuses a raise past an order of magnitude from the market', async () => {
    // AMPUSDT would need 0.009042 against a 0.000884 market — 10.2x.
    const { tps, bot } = await once(AMP_DEAL, AMP, AMP_CLOSE_PRICE, {
      fee: { maker: 0, taker: 0 },
    })
    expect(tps).to.have.length(
      0,
      `dust was closed at ${tps?.[0]?.price} against a ${AMP_CLOSE_PRICE} market`,
    )
    expect(bot.reported.map((r: Reported) => r.message).join('\n')).to.match(
      /below the exchange minimum/i,
    )
  })

  it('§4.2 a stop-loss close is never raised above the market', async () => {
    // A long stop-loss resting above the market is a take-profit wearing a
    // stop-loss's name. Those keep refusing.
    const { tps } = await once(GRAM_DEAL, GRAM, GRAM_CLOSE_PRICE, { sl: true })
    for (const tp of tps ?? []) {
      expect(tp.price).to.be.at.most(
        GRAM_CLOSE_PRICE,
        `stop loss raised to ${tp.price} above a ${GRAM_CLOSE_PRICE} market`,
      )
    }
  })

  it('§4.3 reports a standing refusal to the user on the Nth try', async () => {
    const bot: any = buildBot(
      AMP_DEAL,
      [entryFor(AMP_DEAL.size, AMP_DEAL.avgPrice)],
      AMP,
      AMP_CLOSE_PRICE,
      true,
      { maker: 0, taker: 0 },
    )
    for (let i = 0; i < 8; i++) {
      await buildTp(bot, AMP_DEAL, AMP, AMP_CLOSE_PRICE)
    }
    const visible = bot.reported.filter((r: Reported) => r.sendError)
    expect(visible).to.have.length(
      1,
      `${visible.length} user-visible reports over 8 refusals`,
    )
    expect(visible[0].setEvent).to.equal(true)
    // Never an error STATE: one unclosable dust deal must not stop a bot that
    // is still trading its other pairs.
    expect(visible[0].setError).to.equal(false)
  })

  it('§4.3 a deal that closes again starts over', async () => {
    const bot: any = buildBot(
      AMP_DEAL,
      [entryFor(AMP_DEAL.size, AMP_DEAL.avgPrice)],
      AMP,
      AMP_CLOSE_PRICE,
      true,
      { maker: 0, taker: 0 },
    )
    for (let i = 0; i < 8; i++) {
      await buildTp(bot, AMP_DEAL, AMP, AMP_CLOSE_PRICE)
    }
    // One build that clears the floor — the condition ended.
    const tps = await buildTp(bot, AMP_DEAL, AMP, 0.02)
    expect(tps).to.have.length(1)
    // ...so a fresh episode reports afresh rather than staying silent forever.
    for (let i = 0; i < 8; i++) {
      await buildTp(bot, AMP_DEAL, AMP, AMP_CLOSE_PRICE)
    }
    expect(bot.reported.filter((r: Reported) => r.sendError)).to.have.length(2)
  })

  it('§4.4 the hypothetical pre-open ladder never reports', async () => {
    // `checkBalance` prices a ladder for a deal that does not exist yet
    // (`createCurrentDealOrders` with `dealId: ''`). It is ~98% of this
    // refusal's production volume and can never be a user's problem.
    //
    // The nominal base order this re-derives is `baseOrderSize / price` =
    // 10 / 81.449 = 0.1228, floored onto the 0.01 base grid as 0.12 — 9.77
    // USDC against a 10 USDC floor. That is the production shape: the ladder is
    // under the floor for the same reason the real deal was.
    const bot: any = buildBot(undefined, [], HYPE, HYPE_CLOSE_PRICE, true, {
      maker: 0,
      taker: 0,
    })
    for (let i = 0; i < 8; i++) {
      await buildTp(bot, undefined, HYPE, HYPE_CLOSE_PRICE, { dealId: '' })
    }
    expect(bot.reported.filter((r: Reported) => r.sendError)).to.have.length(0)
    expect(
      bot.reported.filter((r: Reported) =>
        /below the exchange minimum/i.test(r.message),
      ),
      'the pre-open ladder wrote a bot-message row',
    ).to.have.length(0)
  })

  it('§4.5 a close that already clears the floor is untouched', async () => {
    // 10x the position: nothing in this block may fire at all.
    const big = dealFor('HYPE-USDC', 'HYPE', 'USDC', 1.3, 78.966)
    const { tps, bot } = await once(big, HYPE, HYPE_CLOSE_PRICE)
    expect(tps).to.have.length(1)
    expect(tps[0].price).to.equal(HYPE_CLOSE_PRICE)
    expect(tps[0].qty).to.equal(1.29)
    expect(bot.reported).to.have.length(0)
  })
})
