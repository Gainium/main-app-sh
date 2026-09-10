process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `036.an-unreadable-fill-quantity-erases-the-take-profit`.
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over the
 * recorded production state of deal `6a9f9973f4865661cbb62960` (CHZ-USDC,
 * coinbase, bot `6a93a10c6c5d2ca41bec4c7c`):
 *
 *   deal.size 233.60000000000028   avgPrice/initialPrice 0.014119
 *   dealStart  FILLED  origQty '238.3'  executedQty '233.6'
 *   dealRegular FILLED origQty '78.7'   executedQty '0'
 *   dealTP     CANCELED origQty '230.7' price '0.014602'   ← the one that rested
 *
 * The healthy fixture reproduces that cancelled take-profit to the digit
 * (`qty 230.7 @ 0.014602`), which is what makes the poisoned variant below
 * evidence rather than a construction.
 *
 * The poisoned variant changes ONE thing — the in-memory `executedQty` of the
 * filled safety order is unreadable, as it is when a venue payload omits the
 * field (spec §2.2) — and production then logged, 19 times between
 * 2026-09-08T17:44:33Z and 2026-09-09T16:52:39Z:
 *
 *   Close order qty is not a number. Deal 6a9f9973f4865661cbb62960 qty NaN,
 *   price 0.014602, base order qty 233.6, counted fills NaN  Method getTPOrder
 *
 * Note what that line says: the base order reads fine and only the fill sum is
 * NaN. Spec `023`'s guard then refuses the order, so the funded position is
 * left with no take-profit at all.
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
  tpPerc: '1',
  slPerc: '0',
  baseOrderSize: '3.3',
  orderSizeType: 'quote',
  useFixedTPPrices: false,
  indicators: [],
}

/** CHZ-USDC as production `pairs` describes it. */
const EXCHANGE_INFO: any = {
  pair: 'CHZ-USDC',
  baseAsset: { minAmount: 0.1, step: 0.1, name: 'CHZ' },
  quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
  priceAssetPrecision: 6,
}

const DEAL_ID = '6a9f9973f4865661cbb62960'

/** The user's coinbase fee — the pair that reproduces `origQty '230.7'`. */
const FEE = { maker: 0.006, taker: 0.012 }

const DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'CHZ-USDC', baseAsset: 'CHZ', quoteAsset: 'USDC' },
  status: 'open',
  size: 233.60000000000028,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  lastPrice: 0.014119,
  avgPrice: 0.014119,
  initialPrice: 0.014119,
  currentBalances: { base: 233.6, quote: 0 },
  initialBalances: { base: 0, quote: 3.3 },
}

const order = (o: any) => ({
  dealId: DEAL_ID,
  symbol: 'CHZ-USDC',
  price: '0.014119',
  reduceFundsId: undefined,
  updateTime: 1788844442817,
  ...o,
})

/** The deal's order rows, exactly as production holds them. */
const HEALTHY_ORDERS: any[] = [
  order({
    clientOrderId: 'D-BO-JWCs49GDdCM9JACCrWM0wtKeQZCvbP',
    typeOrder: 'dealStart',
    status: 'FILLED',
    side: 'BUY',
    origQty: '238.3',
    executedQty: '233.6',
  }),
  order({
    clientOrderId: 'D-RO-K3XFSY6b0g7t8ZKpWM78aAr7I1EPSM',
    typeOrder: 'dealRegular',
    status: 'FILLED',
    side: 'BUY',
    origQty: '78.7',
    executedQty: '0',
  }),
  order({
    clientOrderId: 'D-RO-D7nKd9CVueZjkSswdWaq5D76nESLFR',
    typeOrder: 'dealRegular',
    status: 'CANCELED',
    side: 'BUY',
    origQty: '83.5',
    executedQty: '0',
  }),
]

/**
 * The same rows with ONE difference: the filled safety order's `executedQty` is
 * unreadable, as an order map holding a venue payload that omitted the field.
 */
const POISONED_ORDERS: any[] = HEALTHY_ORDERS.map((o) =>
  o.clientOrderId === 'D-RO-K3XFSY6b0g7t8ZKpWM78aAr7I1EPSM'
    ? { ...o, executedQty: undefined }
    : o,
)

/** A partially-closed deal: the close-side sum (`filledCloseOrders`) instead. */
const PARTIALLY_CLOSED_DEAL: any = {
  ...DEAL,
  tpHistory: [{ id: 'D-TP-partial', qty: 50 }],
}
const CLOSED_TP = order({
  clientOrderId: 'D-TP-partial',
  typeOrder: 'dealTP',
  status: 'FILLED',
  side: 'SELL',
  price: '0.014602',
  origQty: '50',
  executedQty: '50',
})

class FakeBase {
  math = new MathHelper()
  botId = '6a93a10c6c5d2ca41bec4c7c'
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

const buildBot = (deal: any, orders: any[]) => {
  class TestBot extends Helper {
    public errors: string[] = []

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
      return FEE
    }
    async baseAssetPrecision() {
      return 1
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
      return `${prefix}-9Tia9sxBQ8TJTjUOSfWfvvWFCjXrEU`
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

const buildTp = async (deal: any, orders: any[]) => {
  const bot: any = buildBot(deal, orders)
  const tps = await bot.getTPOrder(
    'CHZ-USDC',
    deal.lastPrice,
    [],
    deal.avgPrice,
    deal.initialPrice,
    DEAL_ID,
    deal,
  )
  return { tps, errors: bot.errors as string[] }
}

describe('getTPOrder fill sums survive an unreadable executedQty (spec 036)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.2 harness check — reproduces the take-profit production armed, to the digit', async () => {
    const { tps, errors } = await buildTp(DEAL, HEALTHY_ORDERS)
    expect(errors, errors.join('\n')).to.have.length(0)
    expect(tps).to.have.length(1)
    // D-TP-9Tia9sxBQ8TJTjUOSfWfvvWFCjXrEU as production recorded it.
    expect(tps[0].qty).to.equal(230.7)
    expect(tps[0].price).to.equal(0.014602)
  })

  it('§4.1 one unreadable entry fill must not erase the take-profit', async () => {
    // Production: `qty NaN, price 0.014602, base order qty 233.6,
    // counted fills NaN` — spec 023's guard then returns [], so the funded
    // position rests with nothing covering it.
    const { tps } = await buildTp(DEAL, POISONED_ORDERS)
    expect(tps, 'no take-profit was built at all').to.have.length(1)
    expect(Number.isFinite(tps[0].qty), `qty ${tps[0].qty}`).to.equal(true)
  })

  it('§4.2 and it is sized from the deal’s own books — the same 230.7', async () => {
    // `deal.size` still knows the position: the fill sum losing a row is picked
    // back up by `resolveBaseOrderQty`, so the quantity is unchanged.
    const { tps, errors } = await buildTp(DEAL, POISONED_ORDERS)
    expect(errors, errors.join('\n')).to.have.length(0)
    expect(tps[0].qty).to.equal(230.7)
    expect(tps[0].price).to.equal(0.014602)
  })

  it('§4.3 an unreadable executedQty on a filled close does not erase it either', async () => {
    const poisonedClose = {
      ...CLOSED_TP,
      executedQty: undefined,
    }
    const { tps } = await buildTp(PARTIALLY_CLOSED_DEAL, [
      ...HEALTHY_ORDERS,
      poisonedClose,
    ])
    expect(tps, 'no take-profit was built at all').to.have.length(1)
    expect(Number.isFinite(tps[0].qty), `qty ${tps[0].qty}`).to.equal(true)
  })

  it('§4.4 a healthy partially-closed deal is unchanged, to the unit', async () => {
    const { tps } = await buildTp(PARTIALLY_CLOSED_DEAL, [
      ...HEALTHY_ORDERS,
      CLOSED_TP,
    ])
    expect(tps).to.have.length(1)
    // 233.6 * (1 - 0.012) - 50 sold, floored to the 0.1 step.
    expect(tps[0].qty).to.equal(180.7)
  })

  it('§1.2 resolveBaseOrderQty cannot sanitise NaN — why the guard is the only thing that fires', () => {
    // Both steps that could have noticed pass NaN straight through.
    expect(Number.isNaN(Math.max(0, 233.6 - NaN))).to.equal(true)
    expect(NaN > 233.6).to.equal(false)
  })
})
