process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `112.a-late-safety-order-fill-after-close-is-sold`.
 *
 * A DCA deal closed on its take profit while fills of its own safety orders
 * were still in flight. Each late fill reaches `updateDeal`, finds the deal
 * closed and asks `sellRemainder` to sell that fill back. The first sale of
 * the deal writes `sellRemainder: true` to the deal row, and once the closed
 * deal has left memory every later call read that flag and returned "already
 * sold": of four late fills only one was sold, and the rest of the coin was
 * left behind.
 *
 * Nothing here opens a connection or places anything: the REAL `updateDeal`
 * and `sellRemainder` run off the dcaHelper mixin (harness shape from
 * `zeroSizeOrderRefusal.spec.ts`), and the venue send is recorded.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

type Row = Record<string, any>

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0112'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0112'

/** BGB/USD on Kraken spot: 5 lot decimals, ordermin 2.5, costmin 0.5. */
const BGB_INFO = {
  pair: 'BGBUSD',
  priceAssetPrecision: 3,
  baseAsset: { minAmount: 2.5, maxAmount: 9e20, step: 0.00001, name: 'BGB' },
  quoteAsset: { minAmount: 0.5, precision: 5, name: 'USD' },
}

/**
 * The deal row as the database holds it after close: the close-time remainder
 * sale already set the deal-level flag.
 */
const makeClosedDeal = (): Row => ({
  _id: DEAL_ID,
  status: 'closed',
  sellRemainder: true,
  symbol: { symbol: 'BGBUSD' },
  levels: { complete: 2 },
  currentBalances: { base: 0, quote: 0 },
  initialBalances: { base: 0, quote: 0 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  commission: 0,
})

/** The three late safety-order fills that were never sold (§2.1). */
const LATE_FILLS = [
  { clientOrderId: 'D-RO-late-so-3', qty: '4.31413', price: '1.932' },
  { clientOrderId: 'D-RO-late-so-4', qty: '4.06452', price: '1.953' },
  { clientOrderId: 'D-RO-late-so-5', qty: '3.83173', price: '1.973' },
]

const makeOrder = (over: Row = {}): Row => ({
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'BGBUSD',
  side: 'BUY',
  type: 'LIMIT',
  status: 'FILLED',
  typeOrder: 'dealRegular',
  ...over,
})

let Helper: any

function makeDcaBot() {
  const sent: Row[] = []
  const debug: string[] = []
  class TestBot extends (Helper as any) {
    math = new MathHelper()
    futures = false
    coinm = false
    hedge = false
    isLong = true
    botId = BOT_ID
    userId = '000000000000000000000000'
    sent = sent
    debug = debug
    /** The closed deal has already left memory (`processDealClose`). */
    deals = new Map()
    orders = new Map()
    data = {
      exchange: ExchangeEnum.kraken,
      settings: { type: 'regular' },
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    dealsDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: makeClosedDeal() },
      }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: [] } }),
    }
    async profitBase() {
      return false
    }
    async getExchangeInfo() {
      return BGB_INFO
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async getLatestPrice() {
      return 1.879
    }
    async baseAssetPrecision() {
      return 5
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    async sendGridToExchange(grid: Row) {
      sent.push(grid)
      return null
    }
    shouldProceed() {
      return false
    }
    getDeal() {
      return undefined
    }
    setDeal() {}
    handleLog() {}
    handleDebug(m: string) {
      debug.push(m)
    }
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

describe('late safety-order fills after the deal closed (spec 112)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§1.1.1 sells every late safety-order fill, not only the first', async () => {
    const bot = makeDcaBot()

    for (const f of LATE_FILLS) {
      await bot.updateDeal(
        BOT_ID,
        makeOrder({
          clientOrderId: f.clientOrderId,
          executedQty: f.qty,
          origQty: f.qty,
          price: f.price,
        }),
      )
    }

    // Each fill net of the 0.1 % taker fee, floored onto the 5-decimal lot.
    expect(bot.sent.map((g: Row) => [g.side, g.qty])).to.deep.equal([
      ['SELL', 4.30981],
      ['SELL', 4.06045],
      ['SELL', 3.82789],
    ])
  })

  it('§3.1 still sells one late fill only once', async () => {
    const bot = makeDcaBot()
    const order = makeOrder({
      clientOrderId: LATE_FILLS[0].clientOrderId,
      executedQty: LATE_FILLS[0].qty,
      origQty: LATE_FILLS[0].qty,
      price: LATE_FILLS[0].price,
    })

    await bot.updateDeal(BOT_ID, order)
    await bot.updateDeal(BOT_ID, { ...order })

    expect(bot.sent).to.have.length(1)
  })

  it('§1.1.3 leaves a late closing-side fill on the deal-level latch', async () => {
    const bot = makeDcaBot()

    await bot.updateDeal(
      BOT_ID,
      makeOrder({
        clientOrderId: 'D-TP-reduce',
        typeOrder: 'dealTP',
        side: 'SELL',
        reduceFundsId: 'r1',
        executedQty: '4',
        origQty: '4',
        price: '2.037',
      }),
    )

    expect(bot.sent).to.deep.equal([])
    expect(bot.debug.join('\n')).to.contain('already sold')
  })

  it('§1.1.2 the deal-level remainder still runs at most once per deal', async () => {
    const bot = makeDcaBot()

    await bot.sellRemainder(DEAL_ID, 3.62339, 1.993, true)

    expect(bot.sent).to.deep.equal([])
    expect(bot.debug.join('\n')).to.contain('already sold')
  })
})
