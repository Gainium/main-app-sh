process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec
 * `026.resize-cancel-promoted-and-gross-entry-double-counts-closes` §1.2 / §4.2
 * (issue #717).
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over the
 * recorded production state of deal `6a90e161a76e7fe63ea3118f` (B3-USDC), read
 * from prod Mongo on 2026-09-08:
 *
 *   D-BO-d24z5Q1…  dealStart    FILLED  origQty 205976  executedQty 204177
 *   9 × dealRegular FILLED                              executedQty 785282 (sum)
 *   D-TP-TNTUXFh6…  dealTP  origQty 878966  executedQty 54103
 *   deal.size 989458.9999999998   tpHistory [{ qty: 54103, id: D-TP-TNTUXFh6… }]
 *
 *   204177 + 785282 = 989459 = |deal.size|, to the unit: `deal.size` is the
 *   GROSS entry volume and the 54103 already sold is NOT deducted from it.
 *
 * The engine sized this deal's take-profit at **934119** twice — 2026-09-02
 * 10:32 (`D-TP-p6hXjrd`) and 2026-09-08 13:18 (`D-TP-mt9JUrC`). After the #702
 * deploy (ledger #207, 13:39:57 -> 13:51:49 UTC) the next three were **988153**
 * (13:59, 15:16, 17:44) — 54034 more base than the deal owns — and every one of
 * them was cancelled, leaving a live ~935356 position with no take-profit at
 * all. So the deal's own order history holds both the correct answer and the
 * regression, and this suite pins the first.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing here
 * places or cancels anything.
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
  tpPerc: '3',
  slPerc: '3',
  baseOrderSize: '100',
  orderSizeType: 'quote',
  indicators: [],
}

/** B3-USDC as the venue describes it: whole-coin steps. */
const EXCHANGE_INFO: any = {
  baseAsset: { minAmount: 1, step: 1, asset: 'B3' },
  quoteAsset: { minAmount: 1, step: 0.0000001, asset: 'USDC' },
  priceAssetPrecision: 7,
}

/** The account fee that reproduces both production quantities exactly. */
const FEE = { maker: 0.00125, taker: 0.00125 }

const DEAL_ID = '6a90e161a76e7fe63ea3118f'
const TP_ID = 'D-TP-TNTUXFh6ohYEWhi6dK8cYPufQgEYqj'

/** Gross base the deal took on, and what it has already sold. */
const BASE_ORDER_FILL = 204177
const SAFETY_FILLS = [
  68055, 72188, 76579, 81245, 86206, 91480, 97087, 103050, 109392,
]
const CLOSED = 54103
/** The position the deal actually holds: 989459 - 54103. */
const HELD = 935356

/** The deal document, exactly as production holds it. */
const DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'B3-USDC', baseAsset: 'B3', quoteAsset: 'USDC' },
  status: 'open',
  size: 989458.9999999998,
  tpHistory: [{ qty: CLOSED, price: 0.0004776, id: TP_ID }],
  reduceFunds: [],
  funds: [],
  flags: [],
  lastPrice: 0.0004609,
  avgPrice: 0.0004688244815601252,
  initialPrice: 0.0004898,
  settings: { avgPrice: 0.0004688244815601252 },
  currentBalances: { base: 989459, quote: 1828.6054413999998 },
  initialBalances: { base: 0, quote: 2292.4880440999996 },
}

const BASE_ORDER = {
  clientOrderId: 'D-BO-d24z5Q1qkS9lJ0mVX3rTgBhPnWzYcE',
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  status: 'FILLED',
  origQty: '205976',
  executedQty: `${BASE_ORDER_FILL}`,
  price: '0.0004898',
  side: 'BUY',
  updateTime: 1,
}

const SAFETY_ORDERS = SAFETY_FILLS.map((qty, i) => ({
  clientOrderId: `D-RO-fixture${i}`,
  dealId: DEAL_ID,
  typeOrder: 'dealRegular',
  status: 'FILLED',
  origQty: `${qty}`,
  executedQty: `${qty}`,
  price: '0.00047',
  side: 'BUY',
  updateTime: 10 + i,
}))

/**
 * The stale take-profit. `status` is the parameter: production carried it
 * PARTIALLY_FILLED until 13:18:26, when §1.1's defect wrote it FILLED. Either
 * way the same 54103 is closed — `tpHistory` and a filled close order are two
 * records of one event — so the take-profit must come out the same.
 */
const staleTp = (status: string) => ({
  clientOrderId: TP_ID,
  dealId: DEAL_ID,
  typeOrder: 'dealTP',
  status,
  origQty: '878966',
  executedQty: `${CLOSED}`,
  price: '0.0004776',
  side: 'SELL',
  updateTime: 30,
})

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
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

/** @param orders what the bot's in-memory order map holds for this deal. */
const buildBot = (orders: any[]) => {
  class TestBot extends Helper {
    public logs: string[] = []
    public debug: string[] = []

    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal: DEAL, initialOrders: [], currentOrders: [] }
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
      return `${prefix}-test`
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug(m: string) {
      this.debug.push(m)
    }
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

const tpQty = async (orders: any[]) => {
  const bot: any = buildBot(orders)
  const tps = await bot.getTPOrder(
    DEAL.symbol.symbol,
    DEAL.lastPrice,
    [],
    DEAL.avgPrice,
    DEAL.initialPrice,
    DEAL_ID,
    DEAL,
  )
  return { qty: tps?.[0]?.qty, logs: bot.logs as string[] }
}

const ENTRY_ROWS = [BASE_ORDER, ...SAFETY_ORDERS]

describe('getTPOrder after a partial take-profit (spec 026, issue #717)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§2.4 sizes the close at 934119 — what it placed twice before #702', async () => {
    // Not 988153. That is 989459 gross treated as if 1043562 had been bought,
    // and it over-states the 935356 the deal holds by 54034.
    const { qty } = await tpQty([...ENTRY_ROWS, staleTp('FILLED')])
    expect(qty).to.equal(934119)
  })

  it('§2.4 the same answer while the stale TP is still PARTIALLY_FILLED', async () => {
    // The 13:18 state, before §1.1 promoted the row. `tpHistory` and a filled
    // close order are two records of one event and must be counted once.
    const { qty } = await tpQty([...ENTRY_ROWS, staleTp('PARTIALLY_FILLED')])
    expect(qty).to.equal(934119)
  })

  it('§1.2 never rests more base than the deal holds', async () => {
    const { qty } = await tpQty([...ENTRY_ROWS, staleTp('FILLED')])
    expect(qty, `${qty} against ${HELD} held`).to.be.at.most(HELD)
  })

  it('§1.2 the complete order map is not read as a missing safety order', async () => {
    // The `position` branch (#702) exists for a SHORT order map. Every entry row
    // is present here, so it must stay inert — it fired on this deal only
    // because `grossEntry` was over by the closed quantity, which it is by
    // construction on any deal that has taken a partial take-profit.
    const { logs } = await tpQty([...ENTRY_ROWS, staleTp('FILLED')])
    expect(logs.join('\n')).to.not.contain('holds more than its order rows')
  })

  it('§017 regression: a genuinely short order map still covers the position', async () => {
    // Spec 017 (#702) must keep working. With the safety rows absent the deal
    // document is the only record of the entry volume: 989459 gross, 54103
    // closed. 934118 rather than 934119 — one whole B3 — because `deal.size` is
    // stored `989458.9999999998` and the resolver floors that residue to the
    // pair's precision instead of rounding it up into a unit the deal may not
    // own. Same one-way, under-state-never-over-state rule the AAVEUSDT case in
    // `baseOrderQty.spec.ts` pins; an over-stated close is the venue rejection
    // that leaves the deal with no take-profit at all.
    const { qty, logs } = await tpQty([BASE_ORDER, staleTp('FILLED')])
    expect(qty).to.equal(934118)
    expect(logs.join('\n')).to.contain('holds more than its order rows account')
  })

  it('§2.3 an executed reduce-funds IS taken out of deal.size and is added back', async () => {
    // `deal.size` is net of executed `reduceFunds` (DOGEUSDT 4141 = 9073 - 4932
    // on prod), so that quantity has to come back to reach the gross entry.
    const bot: any = buildBot(ENTRY_ROWS)
    const withRf = {
      ...DEAL,
      tpHistory: [],
      size: 989458.9999999998 - 100000,
      reduceFunds: [{ qty: 100000, price: 0.00047 }],
    }
    bot.getDeal = (id: string) =>
      id === DEAL_ID
        ? { deal: withRf, initialOrders: [], currentOrders: [] }
        : undefined
    const tps = await bot.getTPOrder(
      DEAL.symbol.symbol,
      DEAL.lastPrice,
      [],
      DEAL.avgPrice,
      DEAL.initialPrice,
      DEAL_ID,
      withRf,
    )
    // Gross entry is still 989459; 100000 of it has been withdrawn, so the
    // close is 989459 * (1 - 0.00125) - 100000.
    expect(tps?.[0]?.qty).to.equal(888222)
    expect((bot.logs as string[]).join('\n')).to.not.contain(
      'holds more than its order rows',
    )
  })
})
