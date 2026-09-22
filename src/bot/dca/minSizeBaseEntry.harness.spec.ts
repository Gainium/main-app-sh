process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `085.a-minimum-size-base-order-cannot-fund-its-own-take-profit`.
 *
 * When the configured base order is worth less than the venue's minimum order
 * quantity, `getBaseOrder` raises the entry so the deal can still rest a close
 * that clears the same minimum. The raise grossed up by `(1 + fee)` while the
 * close it is compensating for is shaved by `(1 - fee)`, and those are not
 * inverses: the round trip loses `fee²`, so the entry landed one part in 10⁶
 * under the floor it was raised to clear. `getTPOrder` then clamped the close
 * back up to `minAmount` — more base than the deal was credited — and the
 * venue refused it for funds on every attempt, for days.
 *
 * Drives the REAL `dcaHelper.getBaseOrder` over the mixin with a minimal base
 * class — no stack, DB, Redis or venue — against the production fixture: a
 * spot DCA long whose `minAmount` is 60 base units and whose configured base
 * order buys 59.04 of them.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  ExchangeEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StrategyEnum,
} from '../../../types'

const BOT_ID = '000000000000000000000b85'
const USER_ID = '000000000000000000000485'
const PAIR = 'SYN-USD'

/** The account's own rate on both sides. */
const FEE = { maker: 0.001, taker: 0.001 }

/**
 * The venue's record for the pair, verbatim from `pairs`. `minAmount: 60` is
 * the whole case: the configured base order cannot reach it.
 */
const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'SYN', minAmount: 60, maxAmount: 0, step: 1e-8 },
  quoteAsset: { name: 'USD', minAmount: 0.5, precision: 4 },
  maxOrders: 200,
}

/** The price the entry went out at. */
const PRICE = 0.1831

/** Quote per base order — 10.8 / 0.1831 = 59.04 base, under the 60 floor. */
const BASE_ORDER_SIZE = '10.8'

/** `baseAssetPrecision` for a `1e-8` step. */
const PRECISION = 8

class FakeBase {
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  hyperliquid = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  kucoinSpot = false
  zeroFee = false
  useCompountReduce = false
  math = new MathHelper()
  data: any = {
    settings: { type: 'regular', pair: [PAIR], futures: false },
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '00000000-0000-0000-0000-000000000085',
    paperContext: true,
    flags: [],
  }
  get isLong() {
    return true
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const DEAL_ID = '000000000000000000000d85'

/**
 * @param fee the account rate. `0` reproduces the exempt paths of §4.2, where
 *   the gross-up is a no-op either way.
 * @param deal set to drive `getTPOrder` against a filled entry as well.
 * @param orders the order rows the engine holds for that deal.
 */
const buildBot = (
  opts: {
    fee?: { maker: number; taker: number }
    deal?: any
    orders?: any[]
  } = {},
) => {
  const fee = opts.fee ?? FEE
  const deal = opts.deal
  const orders = opts.orders ?? []
  class TestBot extends Helper {
    exchange = {} as any
    tpAr = false
    slAr = false
    async profitBase() {
      return false
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    currentDealFeeIsThirdAssetOnly() {
      // What production answered: the venue reported no fee on the entry
      // (`fills: []`, `feeBreakdown: []`), so nothing is known to be
      // third-asset and the quantity keeps its `1 - maxFee` shave.
      return false
    }
    updateDealBalances() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    async getUserFee() {
      return fee
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async baseAssetPrecision() {
      return PRECISION
    }
    async getLatestPrice() {
      return PRICE
    }
    async getAggregatedSettings() {
      return {
        baseOrderSize: BASE_ORDER_SIZE,
        baseOrderPrice: '0',
        orderSizeType: OrderSizeTypeEnum.quote,
        startOrderType: OrderTypeEnum.limit,
        useLimitPrice: false,
        strategy: StrategyEnum.long,
        futures: false,
        coinm: false,
        useDca: true,
        useTp: true,
        tpPerc: '1',
        dealCloseCondition: 'tp',
        useRiskReward: false,
      }
    }
    getOrderId(prefix: string) {
      return `${prefix}-0000000000000000000000000085`
    }
    getDeal(id?: string) {
      return deal && id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    /** The real index lookup, over the fixture's rows rather than a live map. */
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: { status?: string | string[]; dealId?: string } = {}) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    handleLog() {
      return undefined
    }
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  return new TestBot() as any
}

describe('a minimum-size base order must fund its own take-profit (spec 085)', () => {
  before(function () {
    // One ts-node compile of a 22k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§2.1 reproduces the production entry when the raise is the old one', async () => {
    // Not an assertion about the fix — an assertion that this harness is the
    // reported case. The entry recorded in production was 60.06000001, which
    // is exactly `minAmount * (1 + 0.001) + 1e-8` rounded up onto the step.
    const math = new MathHelper()
    expect(
      math.round(
        EXCHANGE_INFO.baseAsset.minAmount * (1 + FEE.taker) +
          EXCHANGE_INFO.baseAsset.step,
        PRECISION,
        false,
        true,
      ),
    ).to.equal(60.06000001)
  })

  it('§1.1.a the close the entry can pay for clears the base minimum', async () => {
    const bot = buildBot()
    const order = await bot.getBaseOrder(PAIR)
    expect(order, 'an entry was built').to.not.equal(undefined)
    const qty = +order.origQty
    // `getTPOrder` sizes a spot long close at `_qty * (1 - maxFee)` and floors
    // it onto the base step. On a venue that charges the BUY fee in base this
    // same number is what the wallet was credited. Either reading has to clear
    // the floor, or the deal can never rest a tradeable close.
    const closeQty = bot.math.round(qty * (1 - FEE.taker), PRECISION, true)
    expect(
      closeQty,
      `entry ${qty} leaves ${closeQty}, under the ${EXCHANGE_INFO.baseAsset.minAmount} floor`,
    ).to.be.at.least(EXCHANGE_INFO.baseAsset.minAmount)
  })

  it('§1.1.a the close the entry can pay for clears the quote minimum', async () => {
    const bot = buildBot()
    const order = await bot.getBaseOrder(PAIR)
    const qty = +order.origQty
    const closeQty = bot.math.round(qty * (1 - FEE.taker), PRECISION, true)
    const tpPrice = +order.price * 1.01
    expect(closeQty * tpPrice).to.be.at.least(
      EXCHANGE_INFO.quoteAsset.minAmount,
    )
  })

  it('§4.1 the entry is still the smallest one that does so', async () => {
    // The raise may not become a licence to buy more than the floor needs: one
    // step of slack over the exact inverse, and no more.
    const bot = buildBot()
    const order = await bot.getBaseOrder(PAIR)
    const exact =
      EXCHANGE_INFO.baseAsset.minAmount / (1 - FEE.taker) +
      EXCHANGE_INFO.baseAsset.step
    expect(+order.origQty).to.be.at.most(
      exact + EXCHANGE_INFO.baseAsset.step * 2,
    )
  })

  it('§4.2 a zero-fee account is sized at the floor itself, unchanged', async () => {
    const bot = buildBot({ fee: { maker: 0, taker: 0 } })
    const order = await bot.getBaseOrder(PAIR)
    // `feeFactor` is 1, so `2 - feeFactor` is 1 and neither form moves the
    // quantity: the floor plus the one step of slack the block always added.
    expect(+order.origQty).to.equal(
      EXCHANGE_INFO.baseAsset.minAmount + EXCHANGE_INFO.baseAsset.step,
    )
  })

  // -------------------------------------------------------------------------
  // The reported symptom itself: the close `getTPOrder` builds for that entry.
  // -------------------------------------------------------------------------

  it('§1.2 the close the engine builds is one the wallet can fund', async () => {
    const bot = buildBot()
    const entry = await bot.getBaseOrder(PAIR)
    const qty = +entry.origQty

    // What a venue that charges the spot BUY fee in base credits for that
    // entry — Binance-shaped, and what the paper simulator books for every
    // venue it emulates (`baseAssetAmount - amount * feePerc`).
    const credited = qty * (1 - FEE.taker)

    const deal = {
      _id: DEAL_ID,
      status: 'open',
      // The engine's ledger records the GROSS entry, not what was credited —
      // which is why capping the close at "what the deal holds" cannot help.
      size: qty,
      avgPrice: PRICE,
      initialPrice: PRICE,
      lastPrice: PRICE,
      symbol: { symbol: PAIR, baseAsset: 'SYN', quoteAsset: 'USD' },
      flags: ['newMultiTp', 'feeByAsset'],
      tpHistory: [],
      reduceFunds: [],
      settings: {},
    }
    const filledEntry = {
      dealId: DEAL_ID,
      typeOrder: 'dealStart',
      status: 'FILLED',
      side: 'BUY',
      price: `${PRICE}`,
      origQty: `${qty}`,
      executedQty: `${qty}`,
    }

    const tpBot = buildBot({ deal, orders: [filledEntry] })
    const tps = await tpBot.getTPOrder(
      PAIR,
      PRICE,
      [],
      PRICE,
      PRICE,
      DEAL_ID,
      deal,
    )
    expect(tps, 'a close was built').to.have.length(1)
    const close = tps[0]

    // Before spec 085 this read `60` — `baseAsset.minAmount`, clamped back up
    // from the `59.99994` the fee-netting produced — against a wallet holding
    // 59.99994006521026, and the venue answered `Not enough balance … required
    // - 60 SYN` on every attempt for days.
    expect(
      close.qty,
      `close ${close.qty} against ${credited} credited`,
    ).to.be.at.most(credited)
    expect(close.qty, 'and still a tradeable size').to.be.at.least(
      EXCHANGE_INFO.baseAsset.minAmount,
    )
  })
})
