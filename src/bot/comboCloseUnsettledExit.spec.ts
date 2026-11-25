process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `268.combo-close-sells-the-base-an-unsettled-exit-sold`.
 *
 * Drives the REAL `dcaHelper.closeDealById`, `cancelAllOrder` and
 * `prepareComboCloseAfterSweep` off the mixin over the sequence recorded in
 * prod (spec §2): a Kraken Futures LONG combo deal holding 19 base after its
 * last grid SELL of 20 filled. The close sweep's cancel of that SELL was
 * answered "not found", the venue read-back said PARTIALLY_FILLED, and the
 * stream's FILLED arrived ~0.6 s later — after the close had been sized at 39.
 *
 * `prepareTpOrder` stands in for the ledger-sized combo close: base held =
 * entries − every closing row that is FILLED or CANCELED, which is the rule
 * `updateDealBalances` applies. Nothing opens a connection; the venue send is
 * recorded. Harness shape from `closeAfterSweptTpFill.spec.ts` (spec 188).
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { CloseDCATypeEnum, ExchangeEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'
import {
  closeQtyNetOfUnsettled,
  unsettledClosingRows,
} from './combo/closeSettle'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0268'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0268'
const GRID_ID = 'CMB-GR-unsettled-exit-0268'
/** Entries: base BUY 19 + DCA BUY 20 + DCA BUY 20, an earlier grid SELL 20. */
const ENTERED = 59
const EARLIER_EXIT = 20

const gridSell = (extra: any = {}): any => ({
  clientOrderId: GRID_ID,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'TKN-USD',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealGrid',
  status: 'NEW',
  price: '0.3095',
  origQty: '20',
  executedQty: '0',
  orderId: 'venue-0268',
  updateTime: 1794956070269,
  ...extra,
})

let Helper: any

/**
 * @param venue what the cancel's venue read-back answers for the grid SELL:
 *   `cancelled` (an ordinary close), `partial` (PARTIALLY_FILLED, as prod)
 * @param streamAfterMs when the stream's FILLED report lands after the
 *   read-back; `null` = it never lands inside the wait
 * @param partialExecuted the executedQty the PARTIALLY_FILLED read-back carries
 */
const makeBot = (
  opts: {
    venue: 'cancelled' | 'partial'
    streamAfterMs?: number | null
    partialExecuted?: string
    isLong?: boolean
    combo?: boolean
  } = { venue: 'cancelled' },
) => {
  const deal: any = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    symbol: { symbol: 'TKN-USD', baseAsset: 'TKN', quoteAsset: 'USD' },
    lastPrice: 0.3094,
    tpHistory: [],
    levels: { all: 3, complete: 3 },
    profit: { total: 0, totalUsd: 0 },
  }
  const sent: any[] = []
  const logs: string[] = []
  const book: any[] = [
    gridSell({
      clientOrderId: 'CMB-GR-earlier-0268',
      status: 'FILLED',
      executedQty: `${EARLIER_EXIT}`,
    }),
    gridSell(),
  ]
  let slept = 0
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public exchange = {}
    public allowToPlaceOrders = new Map()
    public closeDealTimer = new Map()
    public dealTimersMap = new Map()
    public startTimeoutTime = new Map()
    public loadingComplete = true
    public isLong = opts.isLong ?? true
    public futures = true
    public coinm = false
    public hedge = false
    public combo = opts.combo ?? true
    public slippageRetry = 3
    public botId = BOT_ID
    public botType = 'combo'
    public orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    public shortCloseBelowMinimum = new Set()
    public shortCloseCarryInOrder = new Set()
    public data: any = {
      exchange: ExchangeEnum.krakenUsdm,
      settings: { name: 'bot', pair: ['TKN-USD'], type: 'regular' },
      flags: [],
    }
    getOrdersByStatusAndDealId({ status, dealId }: any) {
      const wanted = [status].flat()
      return book.filter(
        (o: any) =>
          wanted.includes(o.status) && (dealId ? o.dealId === dealId : true),
      )
    }
    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    async getAggregatedSettings() {
      return {}
    }
    async maybeStartSplitClose() {
      return false
    }
    async clearDealTimer() {}
    saveDeal() {
      return Promise.resolve()
    }
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange(o: any) {
      if (o.typeOrder !== 'dealGrid' || o.status !== 'NEW') {
        return null
      }
      if (opts.venue === 'cancelled') {
        o.status = 'CANCELED'
        return o
      }
      // `_runUnknownOrderLadder`: "Real order … status: PARTIALLY_FILLED" —
      // the row is saved resting and the ladder returns null.
      o.status = 'PARTIALLY_FILLED'
      o.executedQty = opts.partialExecuted ?? '0'
      const after = opts.streamAfterMs
      if (after !== null && after !== undefined) {
        // The user stream's own FILLED report, processed by the fill path.
        setTimeout(() => {
          o.status = 'FILLED'
          o.executedQty = o.origQty
        }, after)
      }
      return null
    }
    handleUnknownOrder() {}
    async sleepForClosingFill(ms: number) {
      slept += ms
      await new Promise((r) => setTimeout(r, ms))
    }
    /** The ledger-sized combo close (`updateDealBalances` rule). */
    async prepareTpOrder() {
      const sold = book
        .filter(
          (o) =>
            o.side === 'SELL' &&
            (o.status === 'FILLED' || o.status === 'CANCELED'),
        )
        .reduce((acc, o) => acc + +o.executedQty, 0)
      return {
        side: 'SELL',
        qty: ENTERED - sold,
        price: 0.3095,
        type: 'dealTP',
        newClientOrderId: 'D-TP-close-0268',
      }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getExchangeInfo() {
      return {
        pair: 'TKN-USD',
        priceAssetPrecision: 4,
        baseAsset: { minAmount: 1, step: 1, name: 'TKN' },
        quoteAsset: { minAmount: 1, step: 0.0001, name: 'USD' },
      }
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async closeSupersededByFill() {
      return false
    }
    async sendGridToExchange(grid: any, additional: any) {
      sent.push({ ...grid, orderType: additional.type })
      return { ...grid, clientOrderId: grid.newClientOrderId, status: 'NEW' }
    }
    async announceLeftOpenPosition() {}
    emit() {}
    handleLog(m: string) {
      logs.push(m)
    }
    handleDebug() {}
    handleWarn(m: string) {
      logs.push(m)
    }
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot = new (TestBot as any)()
  bot.closingFillSettleMs = 1500
  bot.closingFillPollMs = 50
  return { bot, sent, logs, slept: () => slept }
}

const close = (bot: any) =>
  bot.closeDealById(
    BOT_ID,
    DEAL_ID,
    CloseDCATypeEnum.closeByLimit,
    true,
    false,
    false,
    false,
    '',
    undefined,
    false,
  )

describe('closeSettle (spec 268, pure)', () => {
  it('§4.1 picks only the deal’s own resting closing-side rows', () => {
    const rows = [
      { dealId: 'd', side: 'SELL', status: 'PARTIALLY_FILLED' },
      { dealId: 'd', side: 'SELL', status: 'FILLED' },
      { dealId: 'd', side: 'BUY', status: 'NEW' },
      { dealId: 'x', side: 'SELL', status: 'NEW' },
    ]
    expect(unsettledClosingRows(rows, 'd', 'SELL')).to.deep.equal([rows[0]])
  })
  it('§4.3 nets executed base, never below 0, ignores non-numeric', () => {
    expect(
      closeQtyNetOfUnsettled(39, [{ executedQty: '20' }, { executedQty: 'x' }]),
    ).to.equal(19)
    expect(closeQtyNetOfUnsettled(5, [{ executedQty: '20' }])).to.equal(0)
  })
})

describe('a combo close whose sweep leaves its grid exit unsettled (spec 268)', () => {
  before(function () {
    // One ts-node compile of a 37k-line module.
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§1/§4.2 the stream’s FILLED lands after the read-back: the close is sized 19, not 39 (prod replay)', async () => {
    const { bot, sent } = makeBot({ venue: 'partial', streamAfterMs: 600 })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
      ['SELL', 19, 'LIMIT'],
    ])
  })

  it('§4.3 still unsettled after the wait, venue reported 20 executed: the close is capped at 19', async () => {
    const { bot, sent, logs } = makeBot({
      venue: 'partial',
      streamAfterMs: null,
      partialExecuted: '20',
    })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty])).to.deep.equal([['SELL', 19]])
    expect(logs.some((l) => l.includes('closing 19'))).to.equal(true)
  })

  it('§4.3 still unsettled with nothing reported executed: the close is not shrunk', async () => {
    const { bot, sent } = makeBot({
      venue: 'partial',
      streamAfterMs: null,
      partialExecuted: '0',
    })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty])).to.deep.equal([['SELL', 39]])
  })

  it('§4.4 unchanged: an ordinary close (the exit cancels normally) is sent without waiting', async () => {
    const { bot, sent, slept } = makeBot({ venue: 'cancelled' })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
      ['SELL', 39, 'LIMIT'],
    ])
    expect(slept()).to.equal(0)
  })

  it('§4.4 unchanged: a DCA (non-combo) close neither waits nor caps', async () => {
    const { bot, sent, slept } = makeBot({
      venue: 'partial',
      streamAfterMs: null,
      partialExecuted: '20',
      combo: false,
    })
    await close(bot)
    expect(sent.map((g) => [g.side, g.qty])).to.deep.equal([['SELL', 39]])
    expect(slept()).to.equal(0)
  })
})
