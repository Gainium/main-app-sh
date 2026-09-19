process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `057` — a base entry the engine settles part
 * filled must be topped back up to the size its owner configured.
 *
 * Production, Coinbase spot, a bot whose `baseOrderSize` is 100 USDC: the
 * LIMIT entry for 539.65 units traded 14.62 and rested; 13 s later the
 * enter-market timer fired, `settlePartialBaseEntry` cancelled the remainder
 * and opened the deal on 2.71 USDC — 2.7 % of what was asked for — and nothing
 * ever bought the other 97 %.
 *
 * Three levels, because the defect spans two classes:
 *
 *  - the pure decisions (`shouldTopUpSettledBaseEntry`, and the venue shape
 *    `buyRemainder`'s success gate has to recognise);
 *  - `MainBot` itself: the remainder machinery has to be REACHABLE on Coinbase
 *    and has to record what a `market_market_ioc` actually does;
 *  - the real `dcaHelper`: the settle has to offer the row to that machinery
 *    and open the deal on what comes back.
 *
 * Fixture ids are synthetic — this file is public, and the identifiers of the
 * account the case came from belong in the private issue. Quantities are the
 * production ones verbatim.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from '../main'
import {
  shouldSettlePartialBaseEntry,
  shouldTopUpSettledBaseEntry,
} from './partialBaseEntry'
import { isVenueCanceledRemainderFill } from '../remainderFill'
import { MathHelper } from '../../utils/math'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  StartConditionEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d57'
const BOT_ID = '000000000000000000000b57'
const USER_ID = '000000000000000000000457'
const SYMBOL = 'IP-USDC'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000057'

/** The production entry: 14.62 of 539.65 at 0.18546, still resting. */
const partialBaseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'AAAAAA-BBBBB-CCCCCC',
    clientOrderId: CLIENT_ORDER_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '0.18546',
    origPrice: '0.18549',
    origQty: '539.65',
    executedQty: '14.62',
    cummulativeQuoteQty: '2.7114252',
    exchange: ExchangeEnum.coinbase,
    status: 'PARTIALLY_FILLED',
    updateTime: Date.now() - 13000,
    transactTime: Date.now() - 13000,
    ...over,
  }) as any

// ---------------------------------------------------------------------------
// §4.1/§4.2 the decision
// ---------------------------------------------------------------------------

describe('a base entry cut short is never topped back up (spec 057)', () => {
  describe('§4.1 the decision', () => {
    const live = {
      executedQty: '14.62',
      origQty: '539.65',
      updateTime: 1_000_000,
      now: 1_000_000 + 13_000,
      entryWindowMs: 10_000 + 35_000,
    }

    it('tops up an entry the engine has just settled short', () => {
      expect(shouldTopUpSettledBaseEntry(live)).to.equal(true)
    })

    it('does nothing for an entry that reached its full size', () => {
      expect(
        shouldTopUpSettledBaseEntry({ ...live, executedQty: '539.65' }),
      ).to.equal(false)
      expect(
        shouldTopUpSettledBaseEntry({ ...live, executedQty: '600' }),
      ).to.equal(false)
    })

    it('does nothing for a quantity it cannot read', () => {
      for (const executedQty of ['', null, undefined, 'NaN']) {
        expect(
          shouldTopUpSettledBaseEntry({ ...live, executedQty }),
          `executed ${executedQty}`,
        ).to.equal(false)
      }
      for (const origQty of ['', null, undefined, '0', 'NaN']) {
        expect(
          shouldTopUpSettledBaseEntry({ ...live, origQty }),
          `orig ${origQty}`,
        ).to.equal(false)
      }
    })

    it('§4.2 never buys into an entry the restore path dug up hours later', () => {
      // Spec 038 measured the stranded rows this path recovers at 2 h 41 m and
      // 9.9 h old. The price has moved; the user asked to enter at market
      // THEN, not now.
      for (const ageMs of [2 * 3600_000 + 41 * 60_000, 9.9 * 3600_000]) {
        expect(
          shouldTopUpSettledBaseEntry({ ...live, now: live.updateTime + ageMs }),
          `${ageMs}ms old`,
        ).to.equal(false)
      }
    })

    it('§4.2 allows the bot its own entry window plus a minute of slack', () => {
      const window = live.entryWindowMs + 60_000
      expect(
        shouldTopUpSettledBaseEntry({ ...live, now: live.updateTime + window }),
      ).to.equal(true)
      expect(
        shouldTopUpSettledBaseEntry({
          ...live,
          now: live.updateTime + window + 1,
        }),
      ).to.equal(false)
    })

    it('§4.2 refuses a row it cannot date', () => {
      for (const updateTime of [-1, 0, null, undefined]) {
        expect(
          shouldTopUpSettledBaseEntry({ ...live, updateTime }),
          `${updateTime}`,
        ).to.equal(false)
      }
    })

    it('spec 038/048 are untouched — the settle decision is the same', () => {
      expect(
        shouldSettlePartialBaseEntry({
          orderStatus: 'PARTIALLY_FILLED',
          dealStatus: DCADealStatusEnum.start,
          hasPendingCheck: false,
        }),
      ).to.equal(true)
    })
  })

  // -------------------------------------------------------------------------
  // §4.5 the venue shape the success gate has to recognise
  // -------------------------------------------------------------------------

  describe('§4.5 what a remainder order coming back CANCELED means', () => {
    const filled = { status: 'CANCELED', executedQty: '300' }

    it('Coinbase market orders are IOC: a partial fill ends CANCELED', () => {
      expect(
        isVenueCanceledRemainderFill(ExchangeEnum.coinbase, 'LIMIT', filled),
      ).to.equal(true)
      expect(
        isVenueCanceledRemainderFill(ExchangeEnum.coinbase, 'MARKET', filled),
      ).to.equal(true)
    })

    it("bybit's existing scope is preserved exactly", () => {
      expect(
        isVenueCanceledRemainderFill(ExchangeEnum.bybit, 'MARKET', filled),
      ).to.equal(true)
      // …and not widened: a LIMIT original was never in the gate.
      expect(
        isVenueCanceledRemainderFill(ExchangeEnum.bybit, 'LIMIT', filled),
      ).to.equal(false)
    })

    it('a cancel with nothing on it is not a fill', () => {
      for (const executedQty of ['0', '', null, undefined, 'NaN', '-1']) {
        expect(
          isVenueCanceledRemainderFill(ExchangeEnum.coinbase, 'MARKET', {
            status: 'CANCELED',
            executedQty,
          }),
          `${executedQty}`,
        ).to.equal(false)
      }
    })

    it('no other venue is affected', () => {
      for (const exchange of [
        ExchangeEnum.binance,
        ExchangeEnum.kraken,
        ExchangeEnum.kucoin,
        ExchangeEnum.okx,
        undefined,
      ]) {
        expect(
          isVenueCanceledRemainderFill(exchange as any, 'MARKET', filled),
          `${exchange}`,
        ).to.equal(false)
      }
    })
  })

  // -------------------------------------------------------------------------
  // §4.3/§4.4 the remainder machinery, driven for real off MainBot
  // -------------------------------------------------------------------------

  describe('§4.4 the remainder machinery on Coinbase', () => {
    /**
     * The real `fillPartiallyFilledOrder` / `buyRemainder`, no network: the
     * venue is a recording stub that answers the way Coinbase does.
     */
    const bot = (opts: {
      /** What each `market_market_ioc` fills, in BASE units, in order. */
      fills: string[]
      /** The status the venue reports with those fills. */
      status?: string
      minBase?: number
      minQuote?: number
    }) => {
      const sent: any[] = []
      const b: any = Object.create((MainBot as any).prototype)
      b.data = {
        exchange: ExchangeEnum.coinbase,
        settings: { futures: false, coinm: false, remainderFullAmount: false },
        paperContext: false,
      }
      b.botType = 'dca'
      b.orders = new Map()
      b.partiallyFilledFilledSet = new Set()
      b.math = new MathHelper()
      b.handleLog = () => undefined
      b.handleDebug = () => undefined
      b.handleWarn = () => undefined
      b.getOrderFromMap = (id: string) => b.orders.get(id)
      b.getOrderId = (p: string) => `${p}-${sent.length + 1}`
      b.getExchangeInfo = async () => ({
        pair: SYMBOL,
        priceAssetPrecision: 5,
        baseAsset: { minAmount: opts.minBase ?? 1, step: 0.01, precision: 2 },
        quoteAsset: { minAmount: opts.minQuote ?? 1, step: 0.01, precision: 2 },
      })
      b.getLatestPrice = async () => 0.18546
      b.sendGridToExchange = async (grid: any, params: any) => {
        sent.push({ ...grid, ...params })
        const executedQty = opts.fills[sent.length - 1]
        if (executedQty === undefined) {
          return undefined
        }
        return {
          clientOrderId: grid.newClientOrderId,
          symbol: SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          exchange: ExchangeEnum.coinbase,
          price: '0.18546',
          origQty: `${grid.qty}`,
          executedQty,
          status: opts.status ?? 'FILLED',
          transactTime: Date.now(),
        }
      }
      return { b, sent }
    }

    it('§4.4 is reachable on Coinbase when the settle asks for it', async () => {
      const { b, sent } = bot({ fills: ['525.03'] })
      const settled = partialBaseOrder({ status: 'FILLED' })
      const out = await b.fillPartiallyFilledOrder(settled, true)
      expect(sent, 'one market remainder order').to.have.length(1)
      expect(sent[0].type).to.equal('MARKET')
      // 539.65 - 14.62, in BASE units. `sendOrderToExchange` is what converts
      // this to Coinbase's quote_size.
      expect(+sent[0].qty).to.be.closeTo(525.03, 0.01)
      expect(+out.executedQty).to.be.closeTo(539.65, 0.01)
      expect(out.status).to.equal('FILLED')
    })

    it('§4.4 the guard still holds for every other caller', async () => {
      const { b, sent } = bot({ fills: ['525.03'] })
      const out = await b.fillPartiallyFilledOrder(
        partialBaseOrder({ status: 'FILLED' }),
      )
      expect(sent, 'nothing sent').to.have.length(0)
      expect(+out.executedQty).to.equal(14.62)
    })

    it('§4.5 a partly filled IOC top-up is recorded, not lost', async () => {
      // Coinbase answers CANCELED for a market order it could not fill in
      // full. Recognising it is what keeps the deal's size equal to the
      // position the account is actually holding.
      const { b, sent } = bot({ fills: ['200', '325.03'], status: 'CANCELED' })
      const out = await b.fillPartiallyFilledOrder(
        partialBaseOrder({ status: 'FILLED' }),
        true,
      )
      expect(sent.length, 'kept going until whole').to.be.greaterThan(1)
      expect(+out.executedQty).to.be.closeTo(539.65, 0.01)
    })

    it('§4.3 a remainder below the venue minimum is left alone', async () => {
      const { b, sent } = bot({ fills: ['525.03'], minBase: 10_000 })
      const out = await b.fillPartiallyFilledOrder(
        partialBaseOrder({ status: 'FILLED' }),
        true,
      )
      expect(sent, 'nothing sent').to.have.length(0)
      expect(+out.executedQty).to.equal(14.62)
    })

    it('§4.3 a venue refusal leaves the row exactly as it was', async () => {
      const { b } = bot({ fills: [] })
      const out = await b.fillPartiallyFilledOrder(
        partialBaseOrder({ status: 'FILLED' }),
        true,
      )
      expect(+out.executedQty).to.equal(14.62)
      expect(out.status).to.equal('FILLED')
    })
  })

  // -------------------------------------------------------------------------
  // §4.3/§4.6 the real dcaHelper: the settle has to ask
  // -------------------------------------------------------------------------

  describe('the real dcaHelper', () => {
    class FakeBase {
      botId = BOT_ID
      userId = USER_ID
      botType = 'dca'
      loadingComplete = true
      hyperliquid = false
      data: any = {
        settings: { type: 'regular', pair: [SYMBOL] },
        exchange: ExchangeEnum.coinbase,
        paperContext: false,
        flags: [],
      }
      shouldProceed() {
        return true
      }
      constructor(..._a: any[]) {}
    }

    const loadModule = createRequire(__filename)
    let Helper: any

    const buildBot = (opts: {
      order?: any
      /** What the remainder machinery reports back, if it is asked at all. */
      toppedUpTo?: string
      timers?: any
    }) => {
      const { order = partialBaseOrder(), toppedUpTo, timers = {} } = opts
      const raised = {
        started: [] as any[],
        events: [] as any[],
        toppedUp: [] as any[],
        persisted: [] as any[],
        warns: [] as string[],
      }
      const deal = {
        deal: {
          _id: DEAL_ID,
          botId: BOT_ID,
          status: DCADealStatusEnum.start,
          symbol: { symbol: SYMBOL, baseAsset: 'IP', quoteAsset: 'USDC' },
          createTime: Date.now() - 36000,
          settings: {},
          profit: {},
          levels: { all: 12, complete: 0 },
        },
        initialOrders: [],
        currentOrders: [],
        previousOrders: [],
      }
      class TestBot extends Helper {
        raised = raised
        orders = new Map<string, any>([[order.clientOrderId, order]])
        dealTimersMap = new Map<string, any>([[DEAL_ID, timers]])
        deals = new Map<string, any>([[DEAL_ID, deal]])
        botEventDb = {
          createData: async (d: any) => {
            raised.events.push(d)
            return { status: StatusEnum.ok }
          },
        }
        getOrderFromMap(id: string) {
          return this.orders.get(id)
        }
        getDeal(id?: string) {
          return id === DEAL_ID ? deal : undefined
        }
        getOrdersByStatusAndDealId() {
          return [order]
        }
        async startDeal(o: any) {
          raised.started.push({ ...o })
        }
        async cancelOrderOnExchange(o: any) {
          return { ...o, status: 'FILLED' }
        }
        async fillPartiallyFilledOrder(o: any, settledBaseEntry?: boolean) {
          raised.toppedUp.push({ ...o, settledBaseEntry })
          return toppedUpTo ? { ...o, executedQty: toppedUpTo } : o
        }
        async placeBaseOrder() {}
        // `force` is recorded: spec 058 §4.2 turns it on, and without it the
        // write is silently refused by `updateOrderOnDb`'s terminal-status
        // filter — the row is already FILLED or CANCELED by this point.
        async updateOrderOnDb(o: any, force?: boolean) {
          raised.persisted.push({ ...o, force })
        }
        setOrder(o: any) {
          this.orders.set(o.clientOrderId, o)
        }
        emit() {
          return true
        }
        handleLog() {}
        handleDebug() {}
        handleWarn(l: string) {
          raised.warns.push(l)
        }
        startMethod() {
          return '1'
        }
        endMethod() {}
        async getAggregatedSettings() {
          return { type: 'regular', startCondition: StartConditionEnum.asap }
        }
      }
      return new TestBot()
    }

    before(function () {
      // One ts-node compile of a 22k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })

    it('§1.2 the enter-market settle asks for the missing quantity', async () => {
      const bot: any = buildBot({ toppedUpTo: '539.65' })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      const raised = bot.raised
      expect(raised.toppedUp, 'remainder machinery asked').to.have.length(1)
      expect(raised.toppedUp[0].clientOrderId).to.equal(CLIENT_ORDER_ID)
      expect(raised.toppedUp[0].status).to.equal('FILLED')
      expect(
        raised.toppedUp[0].settledBaseEntry,
        '§4.4 opted out of the coinbase guard',
      ).to.equal(true)
    })

    it('§4.3 the deal opens on the topped-up quantity, once', async () => {
      const bot: any = buildBot({ toppedUpTo: '539.65' })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      const raised = bot.raised
      expect(raised.started, 'one open').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('539.65')
    })

    it('§4.6 nothing is reported as cut short once it is whole', async () => {
      const bot: any = buildBot({ toppedUpTo: '539.65' })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      expect(bot.raised.events).to.have.length(0)
    })

    it('§4.6 an entry still short after the top-up is still reported', async () => {
      const bot: any = buildBot({ toppedUpTo: '300' })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      const raised = bot.raised
      expect(raised.events, 'told once').to.have.length(1)
      expect(raised.events[0].description).to.contain('300')
      expect(raised.started[0].executedQty).to.equal('300')
    })

    // -----------------------------------------------------------------------
    // spec 058 — the merged row has to reach the order record, or every ledger
    // the deal keeps reverts to the fraction that filled on the book the first
    // time orders are reloaded from Mongo.
    // -----------------------------------------------------------------------

    it('058 §4.1 the topped-up row is written back to the order record', async () => {
      const bot: any = buildBot({ toppedUpTo: '539.65' })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      const merged = bot.raised.persisted.filter(
        (p: any) => p.clientOrderId === CLIENT_ORDER_ID && +p.executedQty === 539.65,
      )
      expect(merged, 'merged row persisted').to.have.length(1)
      expect(
        merged[0].force,
        '§4.2 forced past the terminal-status filter',
      ).to.equal(true)
    })

    it('058 §4.2 the row is persisted before the deal is opened from it', async () => {
      const seen: string[] = []
      const bot: any = buildBot({ toppedUpTo: '539.65' })
      const persist = bot.updateOrderOnDb.bind(bot)
      bot.updateOrderOnDb = async (o: any, force?: boolean) => {
        seen.push('persist')
        return persist(o, force)
      }
      const start = bot.startDeal.bind(bot)
      bot.startDeal = async (o: any) => {
        seen.push('open')
        return start(o)
      }
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      expect(seen).to.deep.equal(['persist', 'open'])
    })

    it('058 §4.3 a top-up that recovered nothing writes nothing', async () => {
      const bot: any = buildBot({})
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      expect(bot.raised.persisted, 'no forced rewrite').to.have.length(0)
      expect(bot.raised.started[0].executedQty, 'still opened').to.equal(
        '14.62',
      )
    })

    it('§4.2 a stale entry is settled but never bought into', async () => {
      const stale = partialBaseOrder({
        updateTime: Date.now() - 9.9 * 3600_000,
      })
      const bot: any = buildBot({ order: stale, toppedUpTo: '539.65' })
      await bot.checkBaseOrder(BOT_ID, SYMBOL, undefined, DEAL_ID)
      const raised = bot.raised
      expect(raised.toppedUp, 'nothing bought').to.have.length(0)
      // …and spec 038 still holds: the deal is opened on what filled.
      expect(raised.started, 'still opened').to.have.length(1)
      expect(raised.started[0].executedQty).to.equal('14.62')
      expect(raised.events, 'and still reported').to.have.length(1)
    })
  })
})
