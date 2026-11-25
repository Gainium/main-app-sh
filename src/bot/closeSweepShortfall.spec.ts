process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `267.close-sweep-refused-for-coins-other-orders-hold`.
 *
 * Drives the REAL `dcaHelper.closeDeal` over the state recorded in prod
 * (spec §2): a Kraken XRP-USD spot LONG deal that bought 431.31 XRP. A spot
 * SHORT bot on the same pair and account had sold some of those coins and
 * locked the rest under its resting sells, so the take profit was re-sent
 * sized to the free balance (285.76) and the MARKET sweep of the remainder was
 * refused `EOrder:Insufficient funds`. After that fill the account held
 * 114.68 XRP, all of it locked.
 *
 * Harness shape from `limitOnlyCloseRemainder.spec.ts` (spec 157). Nothing
 * opens a connection; the venue send and the balance read are answered here.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum, StatusEnum } from '../../types'
import { MathHelper } from '../utils/math'
import { matchesNotEnoughBalance } from './main'
import { createRequire } from 'module'
import { classifyCloseSweepShortfall } from './dca/closeSweepShortfall'

const DEAL_ID = 'aaaaaaaaaaaaaaaaaaaa0267'
const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0267'
const TP_ID = 'D-TP-close-shortfall-0267'
const KRAKEN_REFUSAL = 'EOrder:Insufficient funds'
const BOUGHT = 431.31
const TP_SOLD = 285.76
const REMAINDER = 145.55

/** The take profit, re-sent sized to the free balance, FILLED. */
const TP: any = {
  clientOrderId: TP_ID,
  botId: BOT_ID,
  dealId: DEAL_ID,
  symbol: 'XRP-USD',
  baseAsset: 'XRP',
  quoteAsset: 'USD',
  side: 'SELL',
  type: 'LIMIT',
  typeOrder: 'dealTP',
  status: 'FILLED',
  price: '0.9686',
  origQty: `${TP_SOLD}`,
  executedQty: `${TP_SOLD}`,
  updateTime: 1795460404000,
}

const makeDeal = () => ({
  _id: DEAL_ID,
  botId: BOT_ID,
  status: 'open',
  symbol: { symbol: 'XRP-USD', baseAsset: 'XRP', quoteAsset: 'USD' },
  size: BOUGHT,
  avgPrice: 0.9486,
  lastPrice: 0.9686,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  levels: { all: 4, complete: 4 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: BOUGHT, quote: 0 },
  initialBalances: { base: 0, quote: BOUGHT * 0.9486 },
  assets: { used: { base: 0, quote: 0 }, required: { base: 0, quote: 0 } },
  updateTime: 1795460300000,
})

let Helper: any

type Venue = { free: number; locked: number } | 'throw' | undefined

const makeBot = (
  answer: any,
  venue: Venue,
  opts: { isLong?: boolean; futures?: boolean } = {},
) => {
  const deal: any = makeDeal()
  const reclose: any[][] = []
  const sent: any[] = []
  const closes: any[] = []
  const profitWrites: number[] = []
  const events: any[] = []
  const userErrors: any[][] = []
  const balanceReads: any[][] = []
  const saves: any[] = []
  class TestBot extends Helper {
    public math = new MathHelper()
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public allowToPlaceOrders = new Map()
    public isLong = opts.isLong ?? true
    public futures = opts.futures ?? false
    public coinm = false
    public hedge = false
    public combo = false
    public botId = BOT_ID
    public userId = 'user-0267'
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.kraken,
      settings: { name: 'bot', pair: ['XRP-USD'], type: 'regular' },
      flags: [],
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    botEventDb = {
      createData: (e: any) => {
        events.push(e)
        return Promise.resolve()
      },
    }
    async processError(...args: any[]) {
      userErrors.push(args)
    }
    async checkAssets(...args: any[]) {
      balanceReads.push(args)
      if (venue === 'throw') throw new Error('venue down')
      if (!venue) return undefined
      return new Map([['XRP', { asset: 'XRP', ...venue }]])
    }
    dealsDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: deal } }),
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
    saveDeal(_d: any, fields: any) {
      saves.push(fields)
      return Promise.resolve()
    }
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'XRP-USD',
        priceAssetPrecision: 4,
        baseAsset: { minAmount: 0.1, step: 0.00000001, name: 'XRP' },
        quoteAsset: { minAmount: 0.5, step: 0.00001, name: 'USD' },
      }
    }
    async getLatestPrice() {
      return 0.9686
    }
    async baseAssetPrecision() {
      return 8
    }
    getOrderId(prefix: string) {
      return `${prefix}-${sent.length}`
    }
    convertGridToOrder(grid: any, additional: any) {
      return { ...grid, ...additional, clientOrderId: grid.newClientOrderId }
    }
    async sendGridToExchange(
      grid: any,
      additional: any,
      _ed: any,
      returnError = false,
    ) {
      sent.push({ ...grid, orderType: additional.type })
      const result = typeof answer === 'function' ? answer(grid) : answer
      if (typeof result === 'string' && !returnError) {
        return
      }
      return result
    }
    async handleOrderErrors() {}
    isErrorNotEnoughBalance(reason: string) {
      return matchesNotEnoughBalance(reason)
    }
    closeDealById() {}
    closeRemainderByLimit(...args: any[]) {
      reclose.push(args)
    }
    public resting: any[] = []
    getOrdersByStatusAndDealId({ status }: any) {
      const wanted = [status].flat()
      return this.resting.filter((o: any) => wanted.includes(o.status))
    }
    async cancelOrderOnExchange(...args: any[]) {
      return { ...args[0], status: 'CANCELED' }
    }
    handleUnknownOrder() {}
    async restoreOrReportRefusedClose() {}
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
    profitWrites,
    reclose,
    events,
    userErrors,
    balanceReads,
    saves,
  }
}

const filled = (grid: any) => ({
  clientOrderId: grid.newClientOrderId,
  side: 'SELL',
  status: 'FILLED',
  price: '0.9686',
  executedQty: `${grid.qty}`,
  updateTime: 1795460405000,
})

describe('close sweep refused for coins other orders hold (spec 267)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§3.1 the coins are gone (prod: 114.68 XRP held, all locked)', () => {
    const drive = async (venue: Venue = { free: 0, locked: 114.68 }) => {
      const t = makeBot(KRAKEN_REFUSAL, venue)
      await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...TP })
      return t
    }

    it('sends the sweep once and reads the venue balance directly', async () => {
      const { sent, balanceReads } = await drive()
      expect(
        sent.map((g) => [g.side, +g.qty.toFixed(8), g.orderType]),
      ).to.deep.equal([['SELL', REMAINDER, 'MARKET']])
      expect(balanceReads).to.deep.equal([[true, true]])
    })

    it('§3.1 closes the deal as spec 157 §1.5 does, profit unchanged', async () => {
      const { deal, closes, reclose, profitWrites } = await drive()
      expect(deal.status).to.equal('closed')
      expect(closes).to.have.length(1)
      expect(reclose).to.have.length(0)
      expect(profitWrites).to.have.length(1)
    })

    it('§3.2 stamps the unsold base on the deal and saves it', async () => {
      const { deal, saves } = await drive()
      expect(+deal.unsoldBase.toFixed(8)).to.equal(REMAINDER)
      const close = saves.find((s) => s.status === 'closed')
      expect(+close.unsoldBase.toFixed(8)).to.equal(REMAINDER)
    })

    it('§3.3 tells the user what the take profit sold and what is unsold', async () => {
      const { events, userErrors } = await drive()
      expect(events).to.have.length(1)
      expect(events[0].type).to.equal('warning')
      expect(events[0].description).to.contain(
        `sold ${TP_SOLD} of ${BOUGHT} XRP, ${REMAINDER} XRP unsold`,
      )
      expect(userErrors).to.have.length(1)
      expect(userErrors[0][1]).to.equal('Close left coins unsold')
      // a warning: never sets the bot into error
      expect(userErrors[0][3]).to.equal(false)
    })

    it('§3.4 an unreadable balance closes the same way', async () => {
      for (const venue of ['throw', undefined] as Venue[]) {
        const { deal, closes, events } = await drive(venue)
        expect(deal.status).to.equal('closed')
        expect(closes).to.have.length(1)
        expect(+deal.unsoldBase.toFixed(8)).to.equal(REMAINDER)
        expect(events).to.have.length(1)
      }
    })
  })

  describe('§4 the coins are held but locked by other orders', () => {
    const drive = async () => {
      const t = makeBot(KRAKEN_REFUSAL, { free: 0, locked: 260.23 })
      await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...TP })
      return t
    }

    it('§4.1 keeps the deal open and writes no close', async () => {
      const { deal, closes, profitWrites, saves } = await drive()
      expect(deal.status).to.equal('open')
      expect(closes).to.have.length(0)
      expect(profitWrites).to.have.length(0)
      expect(deal.unsoldBase).to.equal(undefined)
      expect(saves.every((s) => s.status !== 'closed')).to.equal(true)
    })

    it('§4.2 keeps the fill as a partial take profit and closes the rest by limit', async () => {
      const { deal, reclose } = await drive()
      expect(deal.tpHistory).to.deep.equal([
        { qty: TP_SOLD, price: 0.9686, id: TP_ID },
      ])
      expect(reclose.map((r) => [r[0], r[1], +r[2].toFixed(8)])).to.deep.equal([
        [BOT_ID, DEAL_ID, REMAINDER],
      ])
    })

    it('§4.3 names the locked quantity to the user', async () => {
      const { events, userErrors } = await drive()
      expect(events).to.have.length(1)
      expect(events[0].description).to.contain(
        '260.23 XRP of this account is held by other open orders',
      )
      expect(userErrors[0][1]).to.equal('Close left coins unsold')
    })
  })

  describe('§5 unchanged', () => {
    it('§5.1 a sweep the venue fills closes the deal with no read, no stamp, no message', async () => {
      const t = makeBot(filled, { free: 0, locked: 0 })
      await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...TP })
      expect(t.deal.status).to.equal('closed')
      expect(t.balanceReads).to.have.length(0)
      expect(t.deal.unsoldBase).to.equal(undefined)
      expect(t.saves.some((s) => 'unsoldBase' in s)).to.equal(false)
      expect(t.events).to.have.length(0)
      expect(t.deal.currentBalances.base).to.equal(0)
    })

    it('§5.2 a refusal that is not about balance reads nothing and closes as before', async () => {
      const t = makeBot('EGeneral:Invalid arguments', { free: 0, locked: 999 })
      await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...TP })
      expect(t.deal.status).to.equal('closed')
      expect(t.balanceReads).to.have.length(0)
      expect(t.deal.unsoldBase).to.equal(undefined)
      expect(t.events).to.have.length(0)
    })

    it("§5.3 the deal's own resting take profit is still spec 211, no read", async () => {
      const t = makeBot(KRAKEN_REFUSAL, { free: 0, locked: 999 })
      t.bot.resting = [
        {
          clientOrderId: 'D-TP-own-resting',
          dealId: DEAL_ID,
          typeOrder: 'dealTP',
          status: 'NEW',
        },
      ]
      await t.bot.closeDeal(BOT_ID, DEAL_ID, { ...TP })
      expect(t.deal.status).to.equal('open')
      expect(t.balanceReads).to.have.length(0)
      expect(t.events).to.have.length(0)
      expect(t.reclose).to.have.length(1)
    })
  })

  describe('§2 classifyCloseSweepShortfall', () => {
    it('held >= remainder is locked, held < remainder or unreadable is unsold', () => {
      expect(
        classifyCloseSweepShortfall(142.1, { free: 0, locked: 114.68 }).kind,
      ).to.equal('unsold')
      expect(
        classifyCloseSweepShortfall(142.1, { free: 10, locked: 140 }).kind,
      ).to.equal('locked')
      expect(classifyCloseSweepShortfall(142.1, undefined).kind).to.equal(
        'unsold',
      )
      expect(
        classifyCloseSweepShortfall(142.1, { free: NaN, locked: 1 } as any)
          .kind,
      ).to.equal('unsold')
    })
  })
})
