process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `157.limit-only-book-refuses-the-close-remainder-sweep`.
 *
 * Drives the REAL `dcaHelper.closeDeal` and `sellRemainder` off the mixin over
 * the state recorded in prod (spec §2): a Coinbase BLAST-USDC deal closed by
 * LIMIT, whose resting take-profit had filled 51,694,544 of 54,950,024 when
 * the close request cancelled it. The cancel was promoted to `FILLED`, so
 * `closeDeal` saw a take-profit that leaves 72,699,924 behind and swept them
 * with a MARKET order — which a limit-only book refuses.
 *
 * Nothing here opens a connection or places anything: the venue send is
 * recorded and answered by the test. Harness shape from
 * `evidenceFreeFilledPromotion.spec.ts` (spec 028) and
 * `lateEntryFillAfterClose.spec.ts` (spec 112).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0157'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0157'
const TP_ID = 'D-TP-limit-only-close-0157'
const LIMIT_ONLY =
  'Orderbook is in limit only mode - please use limit order type'

/** The cancelled, partly filled take-profit as `cancelOrderOnExchange` promoted it. */
const PROMOTED_TP: any = {
  clientOrderId: TP_ID,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'BLAST-USDC',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status: 'FILLED',
  price: '0.00001519',
  origQty: '54950024',
  executedQty: '51694544',
  updateTime: 1791893803683,
}

/** The deal the moment before the close (spec §2.2, unwound by the close's own legs). */
const makeDeal = () => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: 'BLAST-USDC', baseAsset: 'BLAST', quoteAsset: 'USDC' },
  size: 146045512,
  avgPrice: 0.000019758145566374753,
  lastPrice: 0.00001519,
  tpHistory: [
    // An earlier reduce order's partial fill, and this take-profit's own
    // partial fill as the user stream last reported it.
    { qty: 21651044, price: 0.00001519, id: 'D-TPR-earlier-reduce' },
    { qty: 51694544, price: 0.00001519, id: TP_ID },
  ],
  reduceFunds: [],
  funds: [],
  levels: { all: 36, complete: 36 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: 146045512, quote: 0 },
  initialBalances: { base: 0, quote: 2930.5701848400004 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1791893773683,
})

let Helper: any

/** Drive the real `closeRemainderByLimit` instead of recording the call. */
const REAL = { realReclose: true }

const makeBot = (answer: any, opts: { realReclose?: boolean } = {}) => {
  const deal = makeDeal()
  const reclose: any[][] = []
  const cancels: any[][] = []
  const restores: any[][] = []
  const sent: any[] = []
  const closes: any[] = []
  const closeByIdCalls: any[][] = []
  const profitWrites: number[] = []
  const reported: string[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public allowToPlaceOrders = new Map()
    public isLong = true
    public futures = false
    public coinm = false
    public hedge = false
    public combo = false
    public botId = BOT_ID
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.coinbase,
      settings: { name: 'bot', pair: ['BLAST-USDC'], type: 'regular' },
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
      return { maker: 0.006, taker: 0.012 }
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'BLAST-USDC',
        priceAssetPrecision: 8,
        baseAsset: { minAmount: 1, step: 1, name: 'BLAST' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
      }
    }
    async getLatestPrice() {
      return 0.00001519
    }
    async baseAssetPrecision() {
      return 0
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    convertGridToOrder(grid: any, additional: any) {
      return { ...grid, ...additional, clientOrderId: grid.newClientOrderId }
    }
    /**
     * Mirrors `sendOrderToExchange`'s contract: a refusal comes back as the
     * reason only to a `returnError` caller; for anyone else it is reported
     * here and the call returns nothing.
     */
    async sendGridToExchange(
      grid: any,
      additional: any,
      _ed: any,
      returnError = false,
    ) {
      sent.push({ ...grid, orderType: additional.type })
      const result = typeof answer === 'function' ? answer(grid) : answer
      if (typeof result === 'string' && !returnError) {
        await this.handleOrderErrors(result)
        return
      }
      return result
    }
    async handleOrderErrors(reason: string) {
      reported.push(reason)
    }
    closeDealById(...args: any[]) {
      closeByIdCalls.push(args)
    }
    closeRemainderByLimit(...args: any[]) {
      reclose.push(args)
      if (opts.realReclose) {
        return super.closeRemainderByLimit(...args)
      }
    }
    /** Resting orders of the deal, as `getOrdersByStatusAndDealId` sees them. */
    public resting: any[] = []
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = [status].flat()
      return this.resting.filter((o: any) => wanted.includes(o.status))
    }
    public cancelAnswer: any = undefined
    async cancelOrderOnExchange(...args: any[]) {
      cancels.push(args)
      return this.cancelAnswer ?? { ...args[0], status: 'CANCELED' }
    }
    handleUnknownOrder() {}
    async restoreOrReportRefusedClose(...args: any[]) {
      restores.push(args)
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async processDealClose(...args: any[]) {
      closes.push(args)
      return false
    }
    saveProfitToDb(usd: number) {
      profitWrites.push(usd)
    }
    shouldProceed() {
      return false
    }
    updateUserProfitStep() {}
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
  const bot = new (TestBot as any)()
  return {
    bot,
    deal,
    sent,
    closes,
    closeByIdCalls,
    profitWrites,
    reported,
    reclose,
    cancels,
    restores,
  }
}

describe('limit-only book refuses the close remainder sweep (spec 157)', () => {
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

  describe('§1.1–§1.3 the sweep is refused because the book is limit-only', () => {
    const drive = async () => {
      const t = makeBot(LIMIT_ONLY)
      await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...PROMOTED_TP })
      return t
    }

    it('sends the remainder sweep once, at market, for what the deal still holds', async () => {
      const { sent } = await drive()
      expect(sent.map((g) => [g.side, g.qty, g.orderType])).to.deep.equal([
        ['SELL', 72699924, 'MARKET'],
      ])
    })

    it('§1.1 leaves the deal open', async () => {
      const { deal } = await drive()
      expect(deal.status).to.equal('open')
    })

    it('§1.1 writes no close profit and does not run the deal close', async () => {
      const { bot, deal, closes, profitWrites } = await drive()
      expect(closes).to.have.length(0)
      expect(profitWrites).to.have.length(0)
      expect(deal.profit.total).to.equal(0)
      expect(bot.data.profit.total).to.equal(0)
      expect(deal.currentBalances).to.deep.equal({ base: 146045512, quote: 0 })
      expect(bot.pendingClose.has(DEAL_ID)).to.equal(false)
    })

    it('§1.2 keeps the take-profit fill as one partial take profit', async () => {
      const { deal } = await drive()
      const own = deal.tpHistory.filter((h: any) => h.id === TP_ID)
      expect(own).to.have.length(1)
      expect(own[0].qty).to.equal(51694544)
      expect(deal.tpHistory).to.have.length(2)
    })

    it('§1.3 hands what the refused sweep carried to the LIMIT re-close', async () => {
      const { reclose, closeByIdCalls } = await drive()
      expect(reclose).to.deep.equal([[BOT_ID, DEAL_ID, 72699924]])
      expect(closeByIdCalls).to.have.length(0)
    })
  })

  describe('§1.3 closeRemainderByLimit', () => {
    it('rests one LIMIT close for the remainder at the latest price', async () => {
      const { bot, sent } = makeBot({ status: 'NEW' }, REAL)
      await bot.closeRemainderByLimit(BOT_ID, DEAL_ID, 72699924)
      expect(
        sent.map((g) => [g.side, g.qty, g.price, g.type, g.orderType]),
      ).to.deep.equal([['SELL', 72699924, 0.00001519, 'dealTP', 'LIMIT']])
    })

    it('replaces a close another request rested meanwhile, netting what it filled', async () => {
      const { bot, deal, sent, cancels } = makeBot({ status: 'NEW' }, REAL)
      const other = {
        clientOrderId: 'D-TP-concurrent-close',
        dealId: DEAL_ID,
        typeOrder: 'dealTP',
        status: 'PARTIALLY_FILLED',
        price: '0.00001519',
        origQty: '3255480',
        executedQty: '1000000',
      }
      bot.resting = [other]
      bot.cancelAnswer = { ...other, status: 'CANCELED' }
      await bot.closeRemainderByLimit(BOT_ID, DEAL_ID, 72699924)
      // cancelled as a re-size: never promoted to a close
      expect(cancels).to.have.length(1)
      expect(cancels[0][3]).to.equal(false)
      expect(sent.map((g) => g.qty)).to.deep.equal([71699924])
      expect(
        deal.tpHistory.find((h: any) => h.id === other.clientOrderId)?.qty,
      ).to.equal(1000000)
    })

    it('places nothing when the other close filled under the cancel', async () => {
      const { bot, sent } = makeBot({ status: 'NEW' }, REAL)
      const other = {
        clientOrderId: 'D-TP-concurrent-close',
        dealId: DEAL_ID,
        typeOrder: 'dealTP',
        status: 'NEW',
        price: '0.00001519',
        origQty: '3255480',
        executedQty: '0',
      }
      bot.resting = [other]
      bot.cancelAnswer = { ...other, status: 'FILLED', executedQty: '3255480' }
      await bot.closeRemainderByLimit(BOT_ID, DEAL_ID, 72699924)
      expect(sent).to.have.length(0)
    })

    it('reports a refused LIMIT close and runs the refused-close recovery', async () => {
      const { bot, reported, restores } = makeBot('Insufficient balance', REAL)
      await bot.closeRemainderByLimit(BOT_ID, DEAL_ID, 72699924)
      expect(reported).to.deep.equal(['Insufficient balance'])
      expect(restores).to.deep.equal([
        [DEAL_ID, 'BLAST-USDC', 'Insufficient balance'],
      ])
    })

    it('does nothing for a deal that is no longer open', async () => {
      const { bot, deal, sent } = makeBot({ status: 'NEW' }, REAL)
      deal.status = 'closed'
      await bot.closeRemainderByLimit(BOT_ID, DEAL_ID, 72699924)
      expect(sent).to.have.length(0)
    })
  })

  it('§1.3 when that LIMIT fills, the deal closes holding nothing, its profit booked once', async () => {
    // Refused sweep, then the real re-close rests its LIMIT.
    const t = makeBot(LIMIT_ONLY, { realReclose: true })
    await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...PROMOTED_TP })
    await new Promise((r) => setTimeout(r, 50))
    expect(t.deal.status).to.equal('open')
    const limit = t.sent.find((g) => g.orderType === 'LIMIT')
    expect(limit?.qty).to.equal(72699924)
    // ...and the venue fills it.
    await t.bot.closeDeal(BOT_ID, DEAL_ID, {
      ...PROMOTED_TP,
      clientOrderId: limit.newClientOrderId,
      origQty: `${limit.qty}`,
      executedQty: `${limit.qty}`,
      price: `${limit.price}`,
    })
    expect(t.deal.status).to.equal('closed')
    expect(t.deal.currentBalances.base).to.equal(0)
    expect(t.closes).to.have.length(1)
    expect(t.profitWrites).to.have.length(1)
    // 146,045,512 sold at 0.00001519 against 2930.57 spent (commission stubbed 0)
    expect(t.deal.profit.total).to.be.closeTo(
      146045512 * 0.00001519 - 2930.5701848400004,
      1e-6,
    )
    // no market sweep the second time: nothing was left to sweep
    expect(t.sent.filter((g) => g.orderType === 'MARKET')).to.have.length(1)
  })

  it('§1.4 a sweep the venue fills closes the deal and is sent once', async () => {
    const { bot, deal, sent, closes, reclose } = makeBot(
      (grid: any) => ({
        clientOrderId: grid.newClientOrderId,
        side: 'SELL',
        status: 'FILLED',
        price: '0.0000151',
        executedQty: `${grid.qty}`,
        updateTime: 1791893804000,
      }),
    )
    await bot.closeDeal(BOT_ID, DEAL_ID, { ...PROMOTED_TP })
    expect(sent).to.have.length(1)
    expect(deal.status).to.equal('closed')
    expect(closes).to.have.length(1)
    expect(reclose).to.have.length(0)
    // the sweep was booked: the ledger no longer holds the remainder
    expect(deal.currentBalances.base).to.equal(0)
  })

  it('§1.5 a sweep refused for another reason closes the deal as before, reported, not retried', async () => {
    const { bot, deal, sent, closes, reclose, reported } = makeBot(
      'Insufficient balance',
    )
    await bot.closeDeal(BOT_ID, DEAL_ID, { ...PROMOTED_TP })
    expect(sent).to.have.length(1)
    expect(deal.status).to.equal('closed')
    expect(closes).to.have.length(1)
    expect(reclose).to.have.length(0)
    expect(reported).to.deep.equal(['Insufficient balance'])
  })
})
