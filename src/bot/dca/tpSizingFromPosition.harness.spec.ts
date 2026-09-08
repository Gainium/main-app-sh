process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `017.tp-sized-from-base-order-when-fills-are-absent`
 * (issue #702).
 *
 * Drives the REAL `dcaHelper.getTPOrder` — not a reimplementation — over the
 * recorded production state of deal `6a301c7ca999bdafb2ad8055` (AIXBTUSDT),
 * read from prod Mongo on 2026-09-08:
 *
 *   D-BO-WjgCbz…  dealStart    FILLED  origQty 250  executedQty 250
 *   D-RO-Y36Fpo…  dealRegular  FILLED  origQty 260  executedQty 260
 *   deal.size 510, tpHistory [], reduceFunds []
 *   D-TP-P9XE23…  dealTP  origQty 510  EXPIRED   ← armed while both rows were known
 *   D-TP-3w5x48…  dealTP  origQty 250  NEW       ← re-armed at the BASE ORDER
 *
 * The re-arm is the defect: `_qty = filledQty + boQty` is a sum over the bot's
 * in-memory order map, and when the safety-order row is not in that map the sum
 * silently collapses to the base order. Nothing compares it against the position
 * the deal itself records, so the deal rests a take-profit for 250 of the 510 it
 * holds — the shape the tp-coverage detector reports as
 * `under: 260 of 510`.
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
  baseOrderSize: '6',
  orderSizeType: 'quote',
  indicators: [],
}

/** AIXBTUSDT as the venue describes it: whole-coin steps. */
const EXCHANGE_INFO: any = {
  baseAsset: { minAmount: 1, step: 1, asset: 'AIXBT' },
  quoteAsset: { minAmount: 1, step: 0.0001, asset: 'USDT' },
  priceAssetPrecision: 6,
}

const DEAL_ID = '6a301c7ca999bdafb2ad8055'

/** The deal document, exactly as production holds it. */
const DEAL: any = {
  _id: DEAL_ID,
  symbol: { symbol: 'AIXBTUSDT' },
  status: 'open',
  size: 510,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  lastPrice: 0.023445,
  avgPrice: 0.0238,
  initialPrice: 0.02417,
  settings: { avgPrice: 0.0238 },
  currentBalances: { base: 510, quote: 0 },
  initialBalances: { base: 0, quote: 12.13 },
}

const BASE_ORDER = {
  clientOrderId: 'D-BO-WjgCbz9iZqRPjWN3oNH5oIz7SzQxro',
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  status: 'FILLED',
  origQty: '250',
  executedQty: '250',
  price: '0.02417',
  side: 'BUY',
  updateTime: 1,
}

const SAFETY_ORDER = {
  clientOrderId: 'D-RO-Y36FpoOukhMuum4yLnE3aJIjnM7xuM',
  dealId: DEAL_ID,
  typeOrder: 'dealRegular',
  status: 'FILLED',
  origQty: '260',
  executedQty: '260',
  price: '0.023445',
  side: 'BUY',
  updateTime: 2,
}

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
  zeroFee = true
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  data: any = {
    settings,
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/**
 * @param orders what the bot's in-memory order map holds for this deal. The
 * whole point of the fixture: the DB has both entry rows, the map may not.
 */
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
      return { maker: 0, taker: 0 }
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

describe('getTPOrder sizing (spec 017, issue #702)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§1.1 with both entry rows in the map, covers the whole 510 position', async () => {
    // What production armed on the first pass: D-TP-P9XE23… origQty 510.
    const { qty } = await tpQty([BASE_ORDER, SAFETY_ORDER])
    expect(qty).to.equal(510)
  })

  it('§2.1 with the safety-order row absent, must still cover 510', async () => {
    // The defect: production re-armed D-TP-3w5x48… at 250 — the base order —
    // leaving 260 of the position with no take-profit covering it. The deal
    // document says 510 and is not in doubt; only the order map is short.
    const { qty } = await tpQty([BASE_ORDER])
    expect(qty).to.equal(510)
  })

  it('§4.1 says in the log that the position, not the row, supplied the size', async () => {
    const { logs } = await tpQty([BASE_ORDER])
    expect(logs.join('\n')).to.contain('holds more than its order rows account')
    expect(logs.join('\n')).to.contain(DEAL_ID)
  })

  it('§3.1 a deal whose rows are all present logs nothing about the position', async () => {
    const { logs } = await tpQty([BASE_ORDER, SAFETY_ORDER])
    expect(logs.join('\n')).to.not.contain('holds more than its order rows')
  })

  it('§2.1 the AAVEUSDT deal at ladder depth — 0.728 held, 0.027 rested', async () => {
    // Deal 693b8695e6e7cc790c7388ef, prod 2026-09-08: base order 0.027, ten
    // filled safety orders, `size: 0.728`, one NEW take-profit at origQty
    // 0.027 — 96% of the position with nothing covering it.
    const AAVE_ID = '693b8695e6e7cc790c7388ef'
    const aave = {
      ...BASE_ORDER,
      // Must carry THIS deal's id: with the wrong one `findBaseOrderByDeal`
      // finds nothing, `boFromOrder` is 0, and the case silently exercises the
      // pre-existing no-base-order branch instead of the one under test.
      dealId: AAVE_ID,
      clientOrderId: 'x-BKSVA3NTD-BO-4c1qnueJwT74GSW6a68m',
      origQty: '0.027',
      executedQty: '0.02700000',
      price: '206.12',
    }
    const bot: any = buildBot([aave])
    bot.baseAssetPrecision = async () => 3
    bot.getExchangeInfo = async () => ({
      ...EXCHANGE_INFO,
      baseAsset: { minAmount: 0.001, step: 0.001, asset: 'AAVE' },
      quoteAsset: { minAmount: 1, step: 0.01, asset: 'USDT' },
      priceAssetPrecision: 2,
    })
    const deal = {
      ...DEAL,
      _id: AAVE_ID,
      symbol: { symbol: 'AAVEUSDT' },
      size: 0.7279999999999999,
      avgPrice: 180.0,
      lastPrice: 180.0,
      initialPrice: 206.12,
    }
    bot.getDeal = (id: string) =>
      id === deal._id
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    const tps = await bot.getTPOrder(
      'AAVEUSDT',
      deal.lastPrice,
      [],
      deal.avgPrice,
      deal.initialPrice,
      deal._id,
      deal,
    )
    // 0.727, not 0.728: `deal.size` is stored `0.7279999999999999` and the
    // resolver floors to the pair's base precision, so a sub-step residue is
    // dropped rather than rounded up into a close the venue would reject. The
    // detector reads the remaining 0.001 as $0.18 against a $1 minimum notional
    // and answers `covered`.
    expect(tps?.[0]?.qty).to.equal(0.727)
  })

  it('§3.2 with BOTH entry rows absent the position still supplies 510', async () => {
    // Pre-existing behaviour (`source: 'deal'`, shipped 2026-08-26) — pinned
    // here so the new branch cannot regress it.
    const { qty } = await tpQty([])
    expect(qty).to.equal(510)
  })
})
