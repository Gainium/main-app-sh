process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `226.next-deal-entry-self-trades-the-closed-deals-remainder-sweep`.
 *
 * Replays the prod sequence of spec §2 (Coinbase 00-USDC): a take-profit
 * leaves 3614.06 unsold, the close sends a market `D-SR` sweep that the venue
 * answers OPEN with nothing filled, and the sweep's real fills only arrive on
 * the user stream. Drives the REAL `sellRemainder`, `processDealCloseHoldingLock`
 * and the three order-report processors. The venue and Mongo are recorded
 * fakes, so nothing is placed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import { DealStats } from './worker/statsService'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  StartConditionEnum,
  StatusEnum,
} from '../../types'

const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0226'
const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0226'
const SYMBOL = '00-USDC'
const SR_ID = 'D-SR-aymgD8kDaECQnGUJvRTMcfrhgsOoTD'
const REMAINDER = 3614.06
const AVG = 0.009895012244638776
const TAKER = 0.006

const sweepReport = (
  status: string,
  executedQty: number,
  quote: number,
  extra: any = {},
): any => ({
  clientOrderId: SR_ID,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: SYMBOL,
  side: 'SELL',
  type: 'MARKET',
  typeOrder: 'dealTP',
  status,
  price: executedQty ? `${quote / executedQty}` : '0.00970001',
  origQty: `${REMAINDER}`,
  executedQty: `${executedQty}`,
  cummulativeQuoteQty: `${quote}`,
  updateTime: 1793932015534,
  ...extra,
})

let Helper: any

const makeBot = (opts: { waitMs?: number; ownCancel?: boolean } = {}) => {
  const t0 = Date.now()
  const at = () => Date.now() - t0
  const rec = {
    incs: [] as any[],
    sent: [] as any[],
    opened: [] as number[],
    events: [] as string[],
  }
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.closed,
    strategy: 'LONG',
    symbol: { symbol: SYMBOL, baseAsset: '00', quoteAsset: 'USDC' },
    avgPrice: AVG,
    lastPrice: 0.01001375,
    closeTime: 1793932014369,
    initialBalances: { base: 0, quote: 7008.483978771001 },
    currentBalances: { base: REMAINDER, quote: 7045.8907986363 },
    profit: { total: 2.61, totalUsd: 2.61, pureBase: REMAINDER, pureQuote: 37.4 },
    commission: 0,
    levels: { all: 51, complete: 6 },
    assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
    stats: { trackTime: 0 },
  }
  const b: any = new Helper()
  Object.assign(b, {
    math: new MathHelper(),
    botId: BOT_ID,
    botType: 'dca',
    combo: false,
    isLong: true,
    futures: false,
    coinm: false,
    hedge: false,
    loadingComplete: true,
    orders: new Map(),
    deals: new Map(),
    pendingClose: new Set(),
    closeDealTimer: new Map(),
    processedFilled: new Map(),
    feeProcessed: new Map(),
    closeAfterTpFilled: false,
    orderStatuses: ['NEW', 'PARTIALLY_FILLED'],
    data: {
      exchange: ExchangeEnum.coinbase,
      status: 'open',
      settings: { name: 'bot', pair: [SYMBOL], type: 'regular' },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
      flags: [],
    },
  })
  if (opts.waitMs !== undefined) {
    b.remainderSweepWaitMs = opts.waitMs
  }
  let n = 0
  Object.assign(b, {
    shouldProceed: () => true,
    startMethod: () => '1',
    endMethod: () => undefined,
    handleLog: (m: string) => rec.events.push(`${at()} log ${m}`),
    handleDebug: () => undefined,
    handleWarn: (m: string) => rec.events.push(`warn ${m}`),
    handleErrors: (m: string) => rec.events.push(`error ${m}`),
    emit: () => undefined,
    updateData: () => undefined,
    saveProfitToDb: () => undefined,
    profitBase: async () => false,
    getOrderId: (p: string) => `${p}-resend-${++n}`,
    getExchangeInfo: async () => ({
      pair: SYMBOL,
      priceAssetPrecision: 8,
      baseAsset: { minAmount: 0.01, step: 0.01, name: '00' },
      quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
    }),
    getUserFee: async () => ({ maker: 0.004, taker: TAKER }),
    getLatestPrice: async () => 0.0097,
    baseAssetPrecision: async () => 2,
    getUsdRate: async () => 1,
    isOwnCancel: () => !!opts.ownCancel,
    getDeal: (id: string) =>
      id === DEAL_ID ? { deal, initialOrders: [], currentOrders: [] } : undefined,
    ordersDb: {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: [], count: 0 },
      }),
    },
    dealsDb: {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: { ...deal } },
      }),
      updateData: async (_q: any, update: any) => {
        if (update.$inc) {
          rec.incs.push(update.$inc)
        }
        return { status: StatusEnum.ok, data: null }
      },
    },
    sendGridToExchange: async (grid: any, additional: any) => {
      rec.sent.push({ qty: grid.qty, side: grid.side, type: additional.type })
      rec.events.push(`${at()} send ${grid.newClientOrderId} ${grid.qty}`)
      const answer = {
        clientOrderId: grid.newClientOrderId,
        botId: BOT_ID,
        dealId: DEAL_ID,
        symbol: SYMBOL,
        side: grid.side,
        type: 'MARKET',
        typeOrder: 'dealTP',
        status: 'NEW',
        price: `${grid.price}`,
        origQty: `${grid.qty}`,
        executedQty: '0',
        cummulativeQuoteQty: '0',
        updateTime: 1793932016000,
      }
      // The re-sent sweep fills on the stream a moment later.
      setTimeout(() => {
        rec.events.push(`${at()} stream FILLED ${grid.newClientOrderId}`)
        b.processFilledOrder({
          ...answer,
          status: 'FILLED',
          executedQty: `${grid.qty}`,
          cummulativeQuoteQty: `${grid.qty * 0.0097}`,
          price: '0.0097',
        })
      }, 100)
      return answer
    },
    // processDealCloseHoldingLock's surroundings
    removeDealFromStopLossMethods: () => undefined,
    clearTrailingRetryTimer: () => undefined,
    recordDealCostFacts: () => undefined,
    deleteDeal: () => undefined,
    botUpdateStats: () => undefined,
    resetAssets: () => undefined,
    updateBotDeals: async () => undefined,
    updateUsage: () => undefined,
    checkDealsAllowedMethods: async () => undefined,
    noteCloseSweep: async () => undefined,
    finishCloseSweep: async () => undefined,
    cancelAllOrder: async () => [],
    removeOrdersByDeal: () => undefined,
    partiallyFilledFilledSet: new Set(),
    getOrdersByStatusAndDealId: () => [],
    updateDealLastTime: () => undefined,
    getAggregatedSettings: async () => ({
      startCondition: StartConditionEnum.asap,
      useMulti: false,
    }),
    saveDeal: () => undefined,
    botEventDb: { createData: () => undefined },
    dealCloseEventDescription: async () => '',
    sendDealClosedAlert: () => undefined,
    updateDealLastPrices: () => undefined,
    getOpenDeals: () => [],
    checkClosedDeals: async () => undefined,
    afterDealClose: async () => undefined,
    checkInRange: async () => true,
    filterCoinsByVolume: async (_b: string, s: string[]) => s,
    openNewDeal: () => {
      rec.opened.push(at())
      rec.events.push(`${at()} openNewDeal`)
    },
  })
  return { b, rec, deal, at }
}

/** `closeDeal`'s booking of the sweep's immediate answer: OPEN, 0 filled. */
const bookSweepAnswer = (b: any, deal: any) =>
  b.sellRemainder(
    DEAL_ID,
    REMAINDER,
    AVG,
    true,
    { deal, initialOrders: [], currentOrders: [] },
    undefined,
    true,
    false,
    { result: sweepReport('NEW', 0, 0, { price: '0.00970001' }) },
  )

/** The stream reports of spec §2, `delay` ms after the close starts. */
const streamThePartialFillThenSelfTradeCancel = (
  b: any,
  rec: any,
  at: () => number,
  delay: number,
) =>
  setTimeout(async () => {
    rec.events.push(`${at()} stream PF/CANCELED ${SR_ID}`)
    await b.processPartiallyFilledOrder(
      sweepReport('PARTIALLY_FILLED', 778.78, 7.89994432),
    )
    await b.processPartiallyFilledOrder(
      sweepReport('PARTIALLY_FILLED', 975.94, 9.89993536),
    )
    // The venue repeats a report; it must not be booked twice.
    await b.processPartiallyFilledOrder(
      sweepReport('PARTIALLY_FILLED', 975.94, 9.89993536),
    )
    await b.processCanceledOrder(
      sweepReport('CANCELED', 975.94, 9.89993536, { updateTime: 1793932015783 }),
      1793932015783,
      false,
    )
  }, delay)

const closeAndReopen = (b: any) =>
  b.processDealCloseHoldingLock(
    BOT_ID,
    DEAL_ID,
    { total: 2.61, totalUsd: 2.61 },
    true,
    true,
  )

const sum = (incs: any[], key: string) =>
  incs.reduce((acc, i) => acc + (i[key] ?? 0), 0)

describe('spec 226 — the next deal waits for the closed deal remainder sweep', () => {
  let originalRemoveStats: any
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
    originalRemoveStats = DealStats.getInstance().removeStats
    ;(DealStats.getInstance() as any).removeStats = async () => undefined
  })
  after(() => {
    ;(DealStats.getInstance() as any).removeStats = originalRemoveStats
  })

  it('§1.1.1/§1.1.2/§1.1.3 deal 6aed3ac4 replay: the stream fills are booked once, the self-traded rest is re-sent, then the next deal opens', async () => {
    const { b, rec, deal, at } = makeBot()
    await bookSweepAnswer(b, deal)
    streamThePartialFillThenSelfTradeCancel(b, rec, at, 200)
    await closeAndReopen(b)

    // §1.1.1: the next deal opens only after the sweep (and its re-send) ended.
    expect(rec.opened).to.have.length(1)
    const opened = rec.events.findIndex((e) => e.endsWith('openNewDeal'))
    const cancelSeen = rec.events.findIndex((e) => e.includes('stream PF/CANCELED'))
    const resendFilled = rec.events.findIndex((e) => e.includes('stream FILLED'))
    expect(cancelSeen).to.be.greaterThan(-1)
    expect(opened).to.be.greaterThan(cancelSeen)
    expect(resendFilled).to.be.greaterThan(-1)
    expect(opened).to.be.greaterThan(resendFilled)

    // §1.1.3: ONE market sell for exactly what the venue left unsold.
    expect(rec.sent).to.deep.equal([
      { qty: 2638.12, side: 'SELL', type: 'MARKET' },
    ])

    // §1.1.2: the closed deal books 975.94 (once) + the re-send's 2638.12.
    expect(sum(rec.incs, 'currentBalances.base')).to.be.closeTo(-REMAINDER, 1e-9)
    expect(sum(rec.incs, 'currentBalances.quote')).to.be.closeTo(
      9.89993536 + 2638.12 * 0.0097,
      1e-9,
    )
    const firstFill = 9.89993536
    const firstTotal = firstFill - 975.94 * AVG - firstFill * TAKER
    // The first sweep is booked in its two stream increments (778.78, then
    // 197.16), the repeated 975.94 report adds nothing.
    expect(rec.incs).to.have.length(3)
    const first = rec.incs.slice(0, 2)
    expect(sum(first, 'currentBalances.base')).to.be.closeTo(-975.94, 1e-9)
    expect(sum(first, 'profit.total')).to.be.closeTo(firstTotal, 1e-9)
    expect(sum(first, 'commission')).to.be.closeTo(firstFill * TAKER, 1e-12)
  })

  it('§3.1 a sweep the venue never reports on delays the next deal by the bound only', async () => {
    const { b, rec, deal } = makeBot({ waitMs: 300 })
    await bookSweepAnswer(b, deal)
    await closeAndReopen(b)
    expect(rec.opened).to.have.length(1)
    expect(rec.opened[0]).to.be.at.least(300)
    expect(rec.opened[0]).to.be.below(1500)
    expect(rec.sent).to.have.length(0)
  })

  it('§1.1.3 a sweep the bot itself cancelled is not re-sent', async () => {
    const { b, rec, deal, at } = makeBot({ ownCancel: true })
    await bookSweepAnswer(b, deal)
    streamThePartialFillThenSelfTradeCancel(b, rec, at, 150)
    await closeAndReopen(b)
    expect(rec.sent).to.have.length(0)
    const opened = rec.events.findIndex((e) => e.endsWith('openNewDeal'))
    const cancelSeen = rec.events.findIndex((e) => e.includes('stream PF/CANCELED'))
    expect(opened).to.be.greaterThan(cancelSeen)
    expect(sum(rec.incs, 'currentBalances.base')).to.be.closeTo(-975.94, 1e-9)
  })

  it('§4 a close with no sweep opens the next deal without waiting', async () => {
    const { b, rec } = makeBot()
    await closeAndReopen(b)
    expect(rec.opened).to.have.length(1)
    expect(rec.opened[0]).to.be.below(100)
    expect(rec.incs).to.have.length(0)
  })
})
