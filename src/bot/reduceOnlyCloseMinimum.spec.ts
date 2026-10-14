process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `162.a-reduce-only-close-is-held-to-the-opening-order-minimum`.
 *
 * A long futures deal on a pair whose venue minimum order value is 5 is closed
 * by a take-profit that leaves 0.8 behind at 2.5 — a remainder worth 2.0. The
 * venues in spec §1.1 close that remainder with a reduce-only order (prod
 * fills, spec §2.2); the engine refused to send it because it held the close to
 * the opening-order minimum.
 *
 * Drives the REAL `closeDeal`, `sellRemainder` and `closeRemainderByLimit` off
 * the dcaHelper mixin. Nothing here opens a connection or places anything: the
 * venue send is recorded and answered by the test. Harness shape from
 * `limitOnlyCloseRemainder.spec.ts` (spec 157).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0162'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0162'
const TP_ID = 'D-TP-reduce-only-close-0162'

const PRICE = 2.5
/** What the take-profits leave of the 10-unit position: worth 2.0 at 2.5. */
const REMAINDER = 0.8

/** The take-profit that closed 7.2 of the 10, after an earlier partial of 2. */
const FILLED_TP: any = {
  clientOrderId: TP_ID,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'XRPUSDT',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status: 'FILLED',
  price: `${PRICE}`,
  origQty: '8',
  executedQty: '7.2',
  updateTime: 1791893803683,
}

const makeDeal = () => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT' },
  size: 10,
  avgPrice: PRICE,
  lastPrice: PRICE,
  tpHistory: [
    { qty: 2, price: PRICE, id: 'D-TP-earlier-partial' },
    { qty: 7.2, price: PRICE, id: TP_ID },
  ],
  reduceFunds: [],
  funds: [],
  levels: { all: 1, complete: 1 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: 10, quote: 0 },
  initialBalances: { base: 0, quote: 25 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1791893773683,
})

type Venue = {
  exchange: ExchangeEnum
  futures: boolean
  hedge: boolean
  coinm?: boolean
  /** The venue's minimum order value as `pairs` stores it. */
  quoteMin: number
  /** The venue's minimum order quantity. */
  baseMin?: number
}

let Helper: any

const makeBot = (venue: Venue) => {
  const deal = makeDeal()
  const sent: any[] = []
  const logs: string[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public allowToPlaceOrders = new Map()
    public isLong = true
    public futures = venue.futures
    public coinm = !!venue.coinm
    public hedge = venue.hedge
    public combo = false
    public botId = BOT_ID
    public botType = 'dca'
    public data: any = {
      exchange: venue.exchange,
      settings: { name: 'bot', pair: ['XRPUSDT'], type: 'regular' },
      flags: [],
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    dealsDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: deal },
      }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: [] } }),
    }
    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    setDeal() {}
    saveDeal() {
      return Promise.resolve()
    }
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.00055 }
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'XRPUSDT',
        priceAssetPrecision: 4,
        baseAsset: { minAmount: venue.baseMin ?? 0.1, step: 0.1, name: 'XRP' },
        quoteAsset: { minAmount: venue.quoteMin, name: 'USDT' },
      }
    }
    async getLatestPrice() {
      return PRICE
    }
    async baseAssetPrecision() {
      return 1
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    convertGridToOrder(grid: any, additional: any) {
      return { ...grid, ...additional, clientOrderId: grid.newClientOrderId }
    }
    /** The venue fills whatever it is sent. */
    async sendGridToExchange(grid: any, additional: any) {
      sent.push({
        side: grid.side,
        qty: grid.qty,
        type: additional.type,
        reduceOnly: additional.reduceOnly,
      })
      return {
        ...grid,
        clientOrderId: grid.newClientOrderId,
        status: 'FILLED',
        executedQty: `${grid.qty}`,
        origQty: `${grid.qty}`,
        price: `${grid.price}`,
      }
    }
    async handleOrderErrors() {}
    closeDealById() {}
    public resting: any[] = []
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = [status].flat()
      return this.resting.filter((o: any) => wanted.includes(o.status))
    }
    async cancelOrderOnExchange(o: any) {
      return { ...o, status: 'CANCELED' }
    }
    handleUnknownOrder() {}
    async restoreOrReportRefusedClose() {}
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async processDealClose() {
      return false
    }
    saveProfitToDb() {}
    shouldProceed() {
      return false
    }
    updateUserProfitStep() {}
    updateData() {}
    emit() {}
    handleLog(m: string) {
      logs.push(m)
    }
    handleDebug(m: string) {
      logs.push(m)
    }
    handleWarn(m: string) {
      logs.push(m)
    }
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return { bot: new (TestBot as any)(), deal, sent, logs }
}

/** The three ways the engine closes a remainder, each driven for real. */
const closeBySweep = async (venue: Venue) => {
  const t = makeBot(venue)
  await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...FILLED_TP })
  return t
}
const closeBySellRemainder = async (venue: Venue) => {
  const t = makeBot(venue)
  t.deal.status = 'closed'
  await t.bot.sellRemainder(DEAL_ID, REMAINDER, PRICE, false, undefined, true)
  return t
}
const closeByLimit = async (venue: Venue) => {
  const t = makeBot(venue)
  await t.bot.closeRemainderByLimit(BOT_ID, DEAL_ID, REMAINDER)
  return t
}

/**
 * `closeDeal` with a lost ledger (spec `024`): the pre-close sweep is skipped,
 * the ledger is rebuilt from the deal's filled base order, and the remainder is
 * measured by the second check, after the close is booked.
 */
const closeByLostLedgerSweep = async (venue: Venue) => {
  const t = makeBot(venue)
  t.deal.currentBalances = { base: 0, quote: 0 }
  t.bot.resting = [
    {
      clientOrderId: 'D-BO-reduce-only-close-0162',
      orderId: '1',
      dealId: DEAL_ID,
      typeOrder: 'dealStart',
      side: 'BUY',
      status: 'FILLED',
      price: `${PRICE}`,
      origQty: '10',
      executedQty: '10',
    },
  ]
  await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...FILLED_TP })
  return t
}

const BYBIT_ONE_WAY: Venue = {
  exchange: ExchangeEnum.bybitUsdm,
  futures: true,
  hedge: false,
  quoteMin: 5,
}

/** Venues and modes the venue was seen to accept a sub-minimum close on (spec §1.1). */
const accepted: [string, Venue][] = [
  [
    'bybitLinear hedge',
    {
      exchange: ExchangeEnum.bybitUsdm,
      futures: true,
      hedge: true,
      quoteMin: 5,
    },
  ],
  [
    'binanceUsdm one-way',
    {
      exchange: ExchangeEnum.binanceUsdm,
      futures: true,
      hedge: false,
      quoteMin: 5,
    },
  ],
  [
    'binanceUsdm hedge',
    {
      exchange: ExchangeEnum.binanceUsdm,
      futures: true,
      hedge: true,
      quoteMin: 5,
    },
  ],
  [
    'bitgetUsdm hedge',
    {
      exchange: ExchangeEnum.bitgetUsdm,
      futures: true,
      hedge: true,
      quoteMin: 5,
    },
  ],
  [
    'paperBybitLinear one-way',
    {
      exchange: ExchangeEnum.paperBybitUsdm,
      futures: true,
      hedge: false,
      quoteMin: 5,
    },
  ],
]

/** Venues that keep the minimum (spec §1.3). */
const refused: [string, Venue][] = [
  // Refuses a reduce-only close under $10 (spec §2.3).
  [
    'hyperliquidLinear',
    {
      exchange: ExchangeEnum.hyperliquidLinear,
      futures: true,
      hedge: false,
      quoteMin: 10,
    },
  ],
  // Not established (spec §4).
  [
    'bitgetUsdm one-way',
    {
      exchange: ExchangeEnum.bitgetUsdm,
      futures: true,
      hedge: false,
      quoteMin: 5,
    },
  ],
  // A spot sell is an ordinary order.
  [
    'bybit spot',
    {
      exchange: ExchangeEnum.bybit,
      futures: false,
      hedge: false,
      quoteMin: 5,
    },
  ],
  [
    'binance spot',
    {
      exchange: ExchangeEnum.binance,
      futures: false,
      hedge: false,
      quoteMin: 5,
    },
  ],
]

describe('a reduce-only close is held to the opening-order minimum (spec 162)', () => {
  before(function () {
    // One ts-node compile of a 27k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  // Not a spec section: proves the harness reaches the venue send on every
  // venue and path, so a case that sends nothing is stopped by the minimum
  // order value and by nothing else.
  describe('harness control — with no minimum order value every path sends', () => {
    for (const [name, venue] of [
      ...accepted,
      ...refused,
      ['bybitLinear one-way', BYBIT_ONE_WAY] as [string, Venue],
    ]) {
      const free = { ...venue, quoteMin: 0 }
      it(`${name}: closeDeal, sellRemainder and closeRemainderByLimit each send once`, async () => {
        const sweep = await closeBySweep(free)
        const sell = await closeBySellRemainder(free)
        const limit = await closeByLimit(free)
        const lost = await closeByLostLedgerSweep(free)
        // A spot sell nets the taker fee and floors to the step (0.7), so
        // count the sends rather than compare sizes.
        expect(
          [sweep.sent, sell.sent, limit.sent, lost.sent].map((s) => s.length),
        ).to.deep.equal([1, 1, 1, 1])
      })
    }
  })

  describe('§1.1/§1.2 on bybitLinear (one-way), a remainder worth 2.0 against a minimum of 5', () => {
    it('closeDeal sweeps it at market, reduce-only', async () => {
      const { sent } = await closeBySweep(BYBIT_ONE_WAY)
      expect(sent).to.deep.equal([
        { side: 'SELL', qty: REMAINDER, type: 'MARKET', reduceOnly: true },
      ])
    })

    it('sellRemainder sells it at market, reduce-only', async () => {
      const { sent } = await closeBySellRemainder(BYBIT_ONE_WAY)
      expect(sent).to.deep.equal([
        { side: 'SELL', qty: REMAINDER, type: 'MARKET', reduceOnly: true },
      ])
    })

    it('closeDeal with a lost ledger sweeps it after booking the close', async () => {
      const { sent } = await closeByLostLedgerSweep(BYBIT_ONE_WAY)
      expect(sent).to.deep.equal([
        { side: 'SELL', qty: REMAINDER, type: 'MARKET', reduceOnly: true },
      ])
    })

    it('closeRemainderByLimit rests it as a reduce-only limit', async () => {
      const { sent } = await closeByLimit(BYBIT_ONE_WAY)
      expect(sent).to.deep.equal([
        { side: 'SELL', qty: REMAINDER, type: 'LIMIT', reduceOnly: true },
      ])
    })
  })

  describe('§1.1 every venue and mode the venue was seen to accept', () => {
    for (const [name, venue] of accepted) {
      it(`${name}: sellRemainder sends the remainder`, async () => {
        const { sent } = await closeBySellRemainder(venue)
        expect(sent.map((s) => s.qty)).to.deep.equal([REMAINDER])
      })
    }
  })

  describe('§1.3 venues that keep the minimum', () => {
    for (const [name, venue] of refused) {
      it(`${name}: sellRemainder sends nothing`, async () => {
        const { sent, logs } = await closeBySellRemainder(venue)
        expect(sent).to.deep.equal([])
        expect(logs.join('\n')).to.contain('less than minimals qty')
      })
      it(`${name}: closeRemainderByLimit places nothing`, async () => {
        const { sent } = await closeByLimit(venue)
        expect(sent).to.deep.equal([])
      })
      it(`${name}: closeDeal does not sweep`, async () => {
        const { sent } = await closeBySweep(venue)
        expect(sent).to.deep.equal([])
      })
      it(`${name}: closeDeal with a lost ledger does not sweep`, async () => {
        const { sent } = await closeByLostLedgerSweep(venue)
        expect(sent).to.deep.equal([])
      })
    }
  })

  describe('§1.3 the minimum quantity still applies to an exempt close', () => {
    const tooFew: Venue = { ...BYBIT_ONE_WAY, baseMin: 1 }

    it('sellRemainder sends nothing below the minimum quantity', async () => {
      const { sent } = await closeBySellRemainder(tooFew)
      expect(sent).to.deep.equal([])
    })

    it('closeRemainderByLimit places nothing below the minimum quantity', async () => {
      const { sent } = await closeByLimit(tooFew)
      expect(sent).to.deep.equal([])
    })

    it('closeDeal does not sweep below the minimum quantity', async () => {
      const { sent } = await closeBySweep(tooFew)
      expect(sent).to.deep.equal([])
    })

    it('closeDeal with a lost ledger does not sweep below the minimum quantity', async () => {
      const { sent } = await closeByLostLedgerSweep(tooFew)
      expect(sent).to.deep.equal([])
    })
  })
})
