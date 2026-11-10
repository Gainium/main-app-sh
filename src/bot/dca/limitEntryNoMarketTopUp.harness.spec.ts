process.env.NODE_ENV = 'testing'

/**
 * Tests for spec `235`. A part-filled LIMIT base entry on a bot that may not
 * enter at market has exactly one owner for its unfilled rest: spec `111`
 * rests it as a LIMIT. `buyRemainder` must not also buy it at MARKET.
 *
 * Production case (KuCoin spot, LIMIT entry, "Enter Market Timeout" off): the
 * entry for 11278.9777 traded 173.5435. The settle started cancelling it, the
 * venue's own report arrived as `FILLED` at 173.5435, `buyRemainder` bought the
 * other 11105.4342 at market, a venue re-read put the row back to 173.5435,
 * and `startDeal` then rested those same 11105.4342 as a LIMIT — which filled.
 *
 * The real `dcaHelper` mixin over the real `MainBot`, built off the prototype
 * with no constructor, no network: the venue is a recording stub.
 *
 * Fixture ids are synthetic: this file is public. Quantities are the
 * production ones.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'
import {
  DCADealStatusEnum,
  ExchangeEnum,
  OrderTypeEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d35'
const BOT_ID = '000000000000000000000b35'
const USER_ID = '000000000000000000000435'
const SYMBOL = 'KAS-USDT'
const BASE_ID = 'D-BO-0000000000000000000000000235'

/** The venue's report: the entry ended at 173.5435 of 11278.9777. */
const shortEntry = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'base-235',
    clientOrderId: BASE_ID,
    botId: BOT_ID,
    userId: USER_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.limit,
    side: 'BUY',
    price: '0.03287',
    origPrice: '0.03287',
    origQty: '11278.9777',
    executedQty: '173.5435',
    cummulativeQuoteQty: '5.704374845',
    exchange: ExchangeEnum.kucoin,
    status: 'FILLED',
    updateTime: Date.now() - 1_000,
    transactTime: Date.now() - 40_000,
    ...over,
  }) as any

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: {
  startOrderType?: OrderTypeEnum
  /** `0` = the "Enter Market Timeout" switch is off (spec `100`). */
  enterMarketTimeout?: number
  combo?: boolean
  dealStatus?: DCADealStatusEnum
}) => {
  const {
    startOrderType = OrderTypeEnum.limit,
    enterMarketTimeout = 0,
    combo = false,
    dealStatus = DCADealStatusEnum.open,
  } = opts
  const sent: any[] = []
  const rested: any[] = []
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'KAS', quoteAsset: 'USDT' },
      settings: {},
    },
  }
  const b: any = Object.create(Helper.prototype)
  Object.assign(b, {
    botId: BOT_ID,
    userId: USER_ID,
    botType: combo ? 'combo' : 'dca',
    combo,
    enterMarketTimeout,
    data: {
      exchange: ExchangeEnum.kucoin,
      settings: {
        startOrderType,
        remainderFullAmount: false,
        futures: false,
        coinm: false,
      },
      paperContext: false,
    },
    orders: new Map(),
    partiallyFilledFilledSet: new Set<string>(),
    settledBaseEntries: new Set<string>(),
    allowToPlaceOrders: new Map(),
    deals: new Map([[DEAL_ID, deal]]),
    math: new MathHelper(),
    sent,
    rested,
  })
  b.handleLog = () => undefined
  b.handleDebug = () => undefined
  b.handleWarn = () => undefined
  b.getOrderFromMap = (id: string) => b.orders.get(id)
  b.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  b.getAggregatedSettings = async () => ({ startOrderType })
  b.getOrderId = (p: string) => `${p}-${sent.length + 1}`
  b.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 5,
    baseAsset: { minAmount: 0.0001, step: 0.0001, precision: 4 },
    quoteAsset: { minAmount: 0.1, step: 0.01, precision: 2 },
  })
  b.getLatestPrice = async () => 0.03292
  b.baseAssetPrecision = async () => 4
  b.updateOrderOnDb = async () => undefined
  b.sendGridToExchange = async (grid: any, params: any) => {
    sent.push({ ...grid, ...params })
    return {
      clientOrderId: grid.newClientOrderId,
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      exchange: ExchangeEnum.kucoin,
      price: '0.03292',
      origQty: `${grid.qty}`,
      executedQty: `${grid.qty}`,
      status: 'FILLED',
      transactTime: Date.now(),
    }
  }
  b.placeBaseEntryRemainder = async (
    dealId: string,
    symbol: string,
    qty: number,
    total: string,
  ) => {
    rested.push({ dealId, symbol, qty, total })
  }
  return b
}

describe('a part-filled base entry buys its remainder once (spec 235)', () => {
  before(function () {
    // One ts-node compile of the engine.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(MainBot as any)
  })

  describe('§2.1 a bot that may not enter at market', () => {
    it('§2.1 the venue FILLED-short report sends no MARKET top-up', async () => {
      const b = buildBot({})
      const out = await b.fillPartiallyFilledOrder(shortEntry())
      expect(b.sent, 'no remainder order').to.have.length(0)
      expect(out.executedQty).to.equal('173.5435')
      expect(b.partiallyFilledFilledSet.has(BASE_ID)).to.equal(false)
    })

    it('§2.1 the placement answer FILLED short sends none either', async () => {
      const b = buildBot({})
      const out = await b.completeFilledBaseEntry(shortEntry())
      expect(b.sent).to.have.length(0)
      expect(out.executedQty).to.equal('173.5435')
    })

    it('§2.2 the production sequence buys the 11105.4342 exactly once, as the resting LIMIT', async () => {
      const b = buildBot({})
      // The settle is cancelling; the venue's own report lands first.
      const streamed = await b.fillPartiallyFilledOrder(shortEntry())
      // The venue re-read: CANCELED at what the book traded.
      const reread = { ...streamed, status: 'CANCELED' }
      b.orders.set(BASE_ID, reread)
      // `startDeal` opens on it and offers the rest.
      await b.restBaseEntryRemainder({ ...reread, status: 'FILLED' })
      expect(b.sent, 'market').to.have.length(0)
      expect(b.rested, 'limit').to.have.length(1)
      expect(b.rested[0].qty).to.be.closeTo(11105.4342, 1e-9)
      expect(b.rested[0].total).to.equal('11278.9777')
    })

    it('§2.3 a safety order is still topped up as before', async () => {
      const b = buildBot({})
      await b.fillPartiallyFilledOrder(
        shortEntry({
          clientOrderId: 'D-RO-0000000000000000000000000235',
          typeOrder: TypeOrderEnum.dealRegular,
          // A LIMIT one cut short is cancelled, not under-filled (spec 156).
          type: OrderTypeEnum.market,
        }),
      )
      expect(b.sent).to.have.length(1)
    })

    it('§2.3 a combo base entry is still topped up as before', async () => {
      const b = buildBot({ combo: true })
      await b.fillPartiallyFilledOrder(shortEntry())
      expect(b.sent).to.have.length(1)
    })
  })

  describe('§2.4 a bot that may enter at market (unchanged)', () => {
    for (const [name, opts] of [
      ['LIMIT entry with the Enter Market Timeout on', { enterMarketTimeout: 35_000 }],
      ['MARKET entry', { startOrderType: OrderTypeEnum.market }],
    ] as const) {
      it(`§2.4 ${name}: topped up at market, nothing rested`, async () => {
        const b = buildBot(opts)
        const out = await b.fillPartiallyFilledOrder(shortEntry())
        expect(b.sent).to.have.length(1)
        expect(b.sent[0].type).to.equal('MARKET')
        expect(+b.sent[0].qty).to.be.closeTo(11105.4342, 1e-9)
        expect(+out.executedQty).to.be.closeTo(11278.9777, 1e-9)
        // A re-read handed the pre-merge row back to `startDeal`.
        await b.restBaseEntryRemainder(shortEntry())
        expect(b.rested).to.have.length(0)
      })
    }
  })

  describe('§2.5 one owner per remainder', () => {
    it('§2.5 an entry whose remainder was already sent at market is never rested', async () => {
      // The Enter Market Timeout switched off between the top-up and the
      // deal opening: the setting no longer says what was already bought.
      const b = buildBot({})
      b.partiallyFilledFilledSet.add(BASE_ID)
      await b.restBaseEntryRemainder(shortEntry())
      expect(b.rested).to.have.length(0)
    })
  })
})
