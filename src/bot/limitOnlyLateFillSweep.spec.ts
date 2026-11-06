process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `225.limit-only-book-refuses-the-late-fill-sweep`.
 *
 * A DCA deal on a Coinbase book in limit-only mode closed on its take profit
 * while one of its safety orders was part filled. That late fill reached
 * `updateDeal` with the deal already closed, and `sellRemainder` swept it with
 * a MARKET order, which the book refused. Nothing else ever sold those coins.
 *
 * Nothing here opens a connection or places anything: the REAL `updateDeal`,
 * `sellRemainder` and `processFilledOrder` run off the dcaHelper mixin
 * (harness shape from `lateEntryFillAfterClose.spec.ts`), and the venue send
 * is recorded and answered by the test.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

type Row = Record<string, any>

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0225'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0225'
const LIMIT_ONLY =
  'Orderbook is in limit only mode - please use limit order type'
const LATEST = 1.879

/** FORTH-USDC on Coinbase: 3 lot decimals, 3 price decimals. */
const FORTH_INFO = {
  pair: 'FORTH-USDC',
  priceAssetPrecision: 3,
  baseAsset: { minAmount: 0.001, maxAmount: 9e20, step: 0.001, name: 'FORTH' },
  quoteAsset: { minAmount: 1, precision: 8, name: 'USDC' },
}

const makeClosedDeal = (): Row => ({
  _id: DEAL_ID,
  status: 'closed',
  sellRemainder: true,
  symbol: { symbol: 'FORTH-USDC' },
  levels: { complete: 2 },
  currentBalances: { base: 0, quote: 100 },
  initialBalances: { base: 0, quote: 100 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  profit: { total: 1, totalUsd: 1, pureBase: 0, pureQuote: 1 },
  commission: 0,
})

/** The partial safety-order fill that arrived after the take profit. */
const LATE_FILL: Row = {
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'FORTH-USDC',
  side: 'BUY',
  type: 'LIMIT',
  status: 'FILLED',
  typeOrder: 'dealRegular',
  clientOrderId: 'D-RO-late-so',
  executedQty: '104.445',
  origQty: '200',
  price: '1.9',
}

let Helper: any
let ComboHelper: any

/**
 * `answer(grid, additional, returnError)` is what the venue answers a send.
 */
function makeDcaBot(
  answer: (g: Row, a: Row, returnError: boolean) => any,
  Base: any = Helper,
) {
  const sent: Row[] = []
  const dealWrites: Row[] = []
  class TestBot extends (Base as any) {
    math = new MathHelper()
    futures = false
    coinm = false
    hedge = false
    isLong = true
    botId = BOT_ID
    userId = '000000000000000000000000'
    sent = sent
    dealWrites = dealWrites
    loadingComplete = true
    deals = new Map()
    orders = new Map()
    data = {
      exchange: ExchangeEnum.coinbase,
      settings: { type: 'regular' },
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    dealsDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: makeClosedDeal() },
      }),
      updateData: async (_f: Row, u: Row) => {
        dealWrites.push(u)
        return { status: StatusEnum.ok, data: null }
      },
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: [] } }),
    }
    async profitBase() {
      return false
    }
    async getExchangeInfo() {
      return FORTH_INFO
    }
    async getUserFee() {
      return { maker: 0.004, taker: 0.006 }
    }
    async getLatestPrice() {
      return LATEST
    }
    async getUsdRate() {
      return 1
    }
    async baseAssetPrecision() {
      return 3
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    convertGridToOrder(g: Row, a: Row) {
      return {
        clientOrderId: g.newClientOrderId,
        origQty: `${g.qty}`,
        price: `${g.price}`,
        side: g.side,
        type: a.type,
      }
    }
    async handleOrderErrors() {}
    async sendGridToExchange(grid: Row, additional: Row, _ed: Row, re = false) {
      sent.push({
        ...grid,
        type: additional.type,
        reduceOnly: additional.reduceOnly,
      })
      return answer(grid, additional, re)
    }
    shouldProceed() {
      return true
    }
    getDeal() {
      return undefined
    }
    setDeal() {}
    saveProfitToDb() {}
    updateData() {}
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

/** Refuse every MARKET send as limit-only; rest every LIMIT one (`NEW`). */
const limitOnlyBook = (g: Row, a: Row, re: boolean) =>
  a.type === 'MARKET'
    ? re
      ? LIMIT_ONLY
      : undefined
    : {
        clientOrderId: g.newClientOrderId,
        dealId: DEAL_ID,
        botId: BOT_ID,
        symbol: 'FORTH-USDC',
        side: g.side,
        type: 'LIMIT',
        typeOrder: 'dealTP',
        status: 'NEW',
        price: `${g.price}`,
        origQty: `${g.qty}`,
        executedQty: '0',
        updateTime: 1,
      }

describe('limit-only book refuses the late-fill sweep (spec 225)', () => {
  before(function () {
    this.timeout(180000)
    const req = createRequire(__filename)
    Helper = req('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
    ComboHelper = req('./comboHelper').default(Helper)
  })

  it('§3.1 re-places the refused sweep as a reduce-only LIMIT at the latest price', async () => {
    const bot = makeDcaBot(limitOnlyBook)

    await bot.updateDeal(BOT_ID, { ...LATE_FILL })

    // 104.445 net of the 0.6 % taker fee, floored onto the 3-decimal lot.
    expect(
      bot.sent.map((g: Row) => [g.type, g.side, g.qty, g.price, g.reduceOnly]),
    ).to.deep.equal([
      ['MARKET', 'SELL', 103.818, 1.879, true],
      ['LIMIT', 'SELL', 103.818, 1.879, true],
    ])
    // Nothing is booked for an order that has not filled yet.
    expect(bot.dealWrites.some((w: Row) => w.$set?.profit)).to.equal(false)
  })

  it('§3.2 books the limit sweep to the closed deal when it fills', async () => {
    const bot = makeDcaBot(limitOnlyBook)
    await bot.updateDeal(BOT_ID, { ...LATE_FILL })
    const limit = bot.sent[1]

    await bot.processFilledOrder({
      clientOrderId: limit.newClientOrderId,
      dealId: DEAL_ID,
      botId: BOT_ID,
      symbol: 'FORTH-USDC',
      side: 'SELL',
      type: 'LIMIT',
      typeOrder: 'dealTP',
      status: 'FILLED',
      price: '1.879',
      origQty: '103.818',
      executedQty: '103.818',
      updateTime: 2,
    })

    const booked = bot.dealWrites.find((w: Row) => w.$set?.profit)
    expect(booked, 'the fill was booked to the deal').to.not.equal(undefined)

    // Booked exactly as an accepted MARKET sweep of the same fill would be.
    const market = makeDcaBot((g) => ({
      clientOrderId: g.newClientOrderId,
      side: 'SELL',
      status: 'FILLED',
      price: '1.879',
      executedQty: `${g.qty}`,
      updateTime: 2,
    }))
    await market.updateDeal(BOT_ID, { ...LATE_FILL })
    const reference = market.dealWrites.find((w: Row) => w.$set?.profit)
    const pick = (w: Row) => ({
      currentBalances: w.$set.currentBalances,
      profit: w.$set.profit,
      commission: w.$set.commission,
      assets: w.$set.assets,
      'levels.complete': w.$set['levels.complete'],
    })
    expect(pick(booked)).to.deep.equal(pick(reference))

    // A second FILLED event for the same order books nothing more.
    const writes = bot.dealWrites.length
    await bot.processFilledOrder({
      clientOrderId: limit.newClientOrderId,
      dealId: DEAL_ID,
      botId: BOT_ID,
      symbol: 'FORTH-USDC',
      typeOrder: 'dealTP',
      status: 'FILLED',
      price: '1.879',
      executedQty: '103.818',
    })
    expect(bot.dealWrites.length).to.equal(writes)
  })

  it('§3.1 the late base-order fill caller falls back the same way', async () => {
    const bot = makeDcaBot(limitOnlyBook)

    // `processFilledBaseOrder`'s call: a deal the close has not marked sold.
    await bot.sellRemainder(DEAL_ID, 104.445, 1.9, false, {
      deal: { ...makeClosedDeal(), sellRemainder: false },
    })

    expect(bot.sent.map((g: Row) => [g.type, g.qty])).to.deep.equal([
      ['MARKET', 103.818],
      ['LIMIT', 103.818],
    ])
  })

  it('§3.2 a combo bot books the limit sweep through its own processFilledOrder', async () => {
    const bot = makeDcaBot(limitOnlyBook, ComboHelper)
    // A combo deal's remainder sweep runs the same `sellRemainder`.
    await bot.sellRemainder(DEAL_ID, 104.445, 1.9, false, {
      deal: { ...makeClosedDeal(), sellRemainder: false },
    })
    const limit = bot.sent[1]
    expect(limit?.type).to.equal('LIMIT')

    const fill = {
      clientOrderId: limit.newClientOrderId,
      dealId: DEAL_ID,
      botId: BOT_ID,
      symbol: 'FORTH-USDC',
      side: 'SELL',
      type: 'LIMIT',
      typeOrder: 'dealTP',
      status: 'FILLED',
      price: '1.879',
      origQty: '103.818',
      executedQty: '103.818',
      updateTime: 2,
    }
    await bot.processFilledOrder(fill)
    await bot.processFilledOrder({ ...fill })

    expect(
      bot.dealWrites.filter((w: Row) => w.$set?.profit),
      'booked exactly once',
    ).to.have.length(1)
  })

  it('§3.3 an accepted market sweep is the only send (no limit fallback)', async () => {
    const bot = makeDcaBot((g) => ({
      clientOrderId: g.newClientOrderId,
      side: 'SELL',
      status: 'FILLED',
      price: '1.879',
      executedQty: `${g.qty}`,
      updateTime: 1,
    }))

    await bot.updateDeal(BOT_ID, { ...LATE_FILL })

    expect(bot.sent.map((g: Row) => g.type)).to.deep.equal(['MARKET'])
    expect(bot.dealWrites.some((w: Row) => w.$set?.profit)).to.equal(true)
  })

  it('§3.4 a refusal for any other reason is not re-sent as LIMIT', async () => {
    const bot = makeDcaBot((_g, _a, re) =>
      re ? 'Insufficient balance in source account' : undefined,
    )

    await bot.updateDeal(BOT_ID, { ...LATE_FILL })

    expect(bot.sent.map((g: Row) => g.type)).to.deep.equal(['MARKET'])
  })
})
