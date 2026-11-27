process.env.NODE_ENV = 'testing'

/**
 * Spec 250: an order the venue refused for sitting too far ahead of the price
 * is placed once a price tick brings it within the venue's band.
 *
 * Fixture: a Combo deal's base grid on a tokenized-stock pair. Its five sells
 * sit 164.31–177.20 while the market is near 128; the venue refuses each with
 * `the trade price of rxyz/usdt cannot exceed the current price, 20%.`. The
 * price later spikes through 164 and 167, where nothing rested. Synthetic ids.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import RedisClient from '../db/redis'
import { MathHelper } from '../utils/math'
import { orderWaitingForPrice, positionLeftOpen } from './utils'
import {
  VenuePriceBand,
  bandForUnnamedRefusal,
  bandFractionFromReason,
  isAheadOfMarket,
  isWithinBand,
} from './outOfBandRetry'

const BAND_20 =
  'the trade price of rxyz/usdt cannot exceed the current price, 20%.'
const BAND_10 = 'rxyz/usdt trading price cannot exceed 10%'

const sell = (price: number, over: Record<string, unknown> = {}): any => ({
  clientOrderId: `CMB-GR-${price}`,
  symbol: 'RXYZUSDT',
  dealId: 'deal-a',
  minigridId: 'grid-base',
  typeOrder: TypeOrderEnum.dealGrid,
  side: 'SELL',
  type: 'LIMIT',
  price: `${price}`,
  origPrice: `${price}`,
  origQty: '0.1231',
  ...over,
})

describe('orders held out of the price band (spec 250)', () => {
  describe('helpers', () => {
    it('reads the band from either venue wording', () => {
      expect(bandFractionFromReason(BAND_20)).to.equal(0.2)
      expect(bandFractionFromReason(BAND_10)).to.equal(0.1)
      expect(
        bandFractionFromReason('buy-in price cannot be higher than 0.1516'),
      ).to.equal(null)
      expect(bandFractionFromReason('')).to.equal(null)
    })
    it('a sell above or a buy below the market is ahead of it', () => {
      expect(isAheadOfMarket('SELL', 164.31, 128)).to.equal(true)
      expect(isAheadOfMarket('BUY', 100, 128)).to.equal(true)
      expect(isAheadOfMarket('SELL', 120, 128)).to.equal(false)
      expect(isAheadOfMarket('BUY', 152.88, 128)).to.equal(false)
    })
    it('within the band, with a margin off its edge', () => {
      expect(isWithinBand(164.31, 128, 0.2)).to.equal(false)
      expect(isWithinBand(164.31, 150, 0.2)).to.equal(true)
      // 19% away: inside 20% but outside the 18% margin
      expect(isWithinBand(119, 100, 0.2)).to.equal(false)
    })
  })

  describe('MainBot hold and release', () => {
    const build = (opts: { replaces?: boolean; status?: string } = {}) => {
      const handed: any[] = []
      let market = 128
      const bot: any = {
        botId: 'bot',
        data: { status: opts.status ?? BotStatusEnum.open },
        outOfBandFlushing: false,
        logs: [] as string[],
        handleLog(m: string) {
          this.logs.push(m)
        },
        handleWarn() {},
        shouldProceed: () => true,
        replacesVenueCancel: () => opts.replaces ?? true,
        getLatestPrice: async () => market,
        async replaceVenueCanceled(o: any) {
          handed.push(o)
          return true
        },
        scheduleHeldOutOfBandPublish() {},
        noticeHeldOutOfBand: async () => undefined,
      }
      const proto = MainBot.prototype as any
      for (const m of [
        'holdsOutOfBand',
        'holdsTakeProfitOutOfBand',
        'noteOutOfBandRefusal',
        'holdOutOfBand',
        'markHeldOutOfBandDirty',
        'checkOutOfBandOrders',
        'flushOutOfBand',
        'replaceVenueCanceledBatch',
      ]) {
        bot[m] = proto[m].bind(bot)
      }
      return {
        bot,
        handed,
        setMarket: (p: number) => {
          market = p
        },
      }
    }
    const settle = () => new Promise((r) => setTimeout(r, 0))

    it('holds the refused sells and places those a tick brings into range', async () => {
      const { bot, handed } = build()
      for (const p of [164.31, 167.54, 170.76, 173.97, 177.2]) {
        await bot.noteOutOfBandRefusal(sell(p), BAND_20)
      }
      expect(bot.outOfBandOrders.size).to.equal(5)
      bot.checkOutOfBandOrders('RXYZUSDT', 130)
      await settle()
      expect(handed).to.have.length(0)
      // the spike: 143 puts 164.31 and 167.54 inside 18%, not 170.76 up
      bot.checkOutOfBandOrders('RXYZUSDT', 143)
      await settle()
      expect(handed.map((o) => +o.price)).to.deep.equal([164.31, 167.54])
      expect(bot.outOfBandOrders.size).to.equal(3)
      bot.checkOutOfBandOrders('RXYZUSDT', 166)
      await settle()
      expect(handed).to.have.length(5)
      expect(bot.outOfBandOrders.size).to.equal(0)
    })

    it('a tick for another pair places nothing', async () => {
      const { bot, handed } = build()
      await bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      bot.checkOutOfBandOrders('ROTHERUSDT', 166)
      await settle()
      expect(handed).to.have.length(0)
    })

    it('not an order the price already passed (the re-price handles those)', async () => {
      const { bot } = build()
      await bot.noteOutOfBandRefusal(sell(120), BAND_20)
      expect(bot.outOfBandOrders?.size ?? 0).to.equal(0)
    })

    it('not without a band in the refusal, nor for an order type left alone', async () => {
      const a = build()
      await a.bot.noteOutOfBandRefusal(
        sell(164.31),
        'buy-in price cannot be higher than 0.1516',
      )
      expect(a.bot.outOfBandOrders?.size ?? 0).to.equal(0)
      const b = build({ replaces: false })
      await b.bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      expect(b.bot.outOfBandOrders?.size ?? 0).to.equal(0)
    })

    it('a repeated refusal of the same level is held once', async () => {
      const { bot } = build()
      await bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      await bot.noteOutOfBandRefusal(
        sell(164.31, { clientOrderId: 'CMB-GR-retry' }),
        BAND_20,
      )
      expect(bot.outOfBandOrders.size).to.equal(1)
    })

    it('places nothing for a bot that is not open', async () => {
      const { bot, handed } = build({ status: BotStatusEnum.closed })
      await bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      bot.checkOutOfBandOrders('RXYZUSDT', 166)
      await settle()
      expect(handed).to.have.length(0)
    })
  })
})

/**
 * Spec 283: Binance refuses an order outside its PERCENT_PRICE_BY_SIDE band
 * with `Filter failure: PERCENT_PRICE_BY_SIDE`, which names no limit and
 * classifies as `Order params`. Such a safety order or take profit was written
 * off silently and re-sent on every reload (and five more times per reload for
 * a take profit), never when the price came near.
 *
 * Fixtures (synthetic ids) from two Binance spot deals:
 * (a) a LONG BEBUSDT deal's safety order BUY 108.53 with the price near 151;
 * (b) the same deal's take profit SELL 232.93 (Binance's BEBUSDT filter:
 *     askMultiplierUp 1.2, bidMultiplierDown 0.8);
 * (c) a SHORT METUSDT deal's take profit BUY 0.0858 with the price near 0.227
 *     (bidMultiplierDown 0.5).
 * Drives the REAL `sendOrderToExchange` and, for the take profits, the real
 * DCA engine's re-plan, over a Map-backed fake Redis. Spot connector exchange
 * info carries no price band, so the default band applies.
 */
const PERCENT = 'Filter failure: PERCENT_PRICE_BY_SIDE'
const store = new Map<string, string>()
const fakeRedis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v)
  },
  del: async (k: string) => {
    store.delete(k)
  },
}
const settleAll = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

type Row = Record<string, any>
let seq = 0
const binanceOrder = (o: {
  symbol: string
  side: 'BUY' | 'SELL'
  price: number
  typeOrder: TypeOrderEnum
  dealId: string
  qty?: string
}): Row => ({
  clientOrderId: `x-${o.typeOrder}-${seq++}`,
  symbol: o.symbol,
  side: o.side,
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: o.qty ?? '0.342',
  price: `${o.price}`,
  origPrice: `${o.price}`,
  exchange: ExchangeEnum.binance,
  typeOrder: o.typeOrder,
  dealId: o.dealId,
})

type Venue = (req: any) => Promise<any>
const refusePercent: Venue = async () => ({
  status: StatusEnum.notok,
  reason: PERCENT,
  data: null,
})
const acceptAll: Venue = async (req: any) => ({
  status: StatusEnum.ok,
  reason: null,
  data: {
    clientOrderId: req.newClientOrderId,
    symbol: req.symbol,
    side: req.side,
    type: 'LIMIT',
    price: `${req.price}`,
    origQty: `${req.quantity}`,
    orderId: `${Math.random()}`,
    status: 'NEW',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    fills: [],
  },
})

/** The sendOrderToExchange harness fields, on any MainBot-derived prototype. */
const wire = (bot: any, market: { price: number }, venue: { fn: Venue }) => {
  const venueCalls: any[] = []
  const notices: { subType: string; setError: boolean; message: string }[] = []
  const warns: string[] = []
  const rows = new Map<string, Row>()
  Object.assign(bot, {
    botId: 'bot-binance-1',
    userId: 'user-1',
    botType: 'dca',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    notices,
    warns,
    ordersDb: {
      rows,
      readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
      createData: async (d: Row) => {
        rows.set(d.clientOrderId, { ...d })
        return { status: StatusEnum.ok, reason: null, data: { result: d } }
      },
      updateData: async (f: Row, u: Row) => {
        const { $unset: _u, ...set } = u
        const r = rows.get(f.clientOrderId)
        if (r) rows.set(f.clientOrderId, { ...r, ...set })
        return { status: StatusEnum.ok, reason: null, data: { result: null } }
      },
      deleteManyData: async (f: Row) => {
        rows.delete(f.clientOrderId)
        return { status: StatusEnum.ok, reason: 'Deleted', data: null }
      },
    },
    data: {
      exchange: ExchangeEnum.binance,
      exchangeUUID: '',
      status: BotStatusEnum.open,
      paperContext: false,
      settings: { futures: false },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return venue.fn(req)
      },
      getOrder: async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found',
        data: null,
      }),
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: (m: string) => {
      warns.push(m)
    },
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
    processError: async (...a: any[]) => {
      notices.push({ subType: a[1], setError: a[3], message: a[5] })
    },
    // a held take profit's notice, one per deal
    postUserNotice: async (
      message: string,
      _symbol?: string,
      _type?: string,
      _event?: string,
      subType?: string,
    ) => {
      notices.push({ subType: `${subType}`, setError: false, message })
    },
    updateData: () => undefined,
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    // prod: the `filter failure` rule classifies every Binance filter so
    getErrorSubType: (r: string) =>
      /filter failure/i.test(r) ? 'Order params' : null,
    getNotEnoughOrdersIdByOrder: () => 'k',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 4,
      baseAsset: { maxMarketAmount: 1e12, precision: 3, step: 0.001 },
      quoteAsset: { minAmount: 1, precision: 8 },
    }),
    getLatestPrice: async () => market.price,
    shouldProceed: () => true,
    scheduleHeldOutOfBandPublish() {
      bot.flushHeldOutOfBandPublish()
    },
    publishHeldOutOfBand: () => undefined,
  })
  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: false,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 1,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

describe('Binance percent-price refusals are held and placed in range (spec 283)', () => {
  beforeEach(() => {
    store.clear()
    VenuePriceBand.resetCache()
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })

  it('band: the pair filter when there is one, else the default, never past the refused distance', () => {
    // BEBUSDT sell 232.93 at 151: 54% refused, no filter -> 20%
    expect(
      bandForUnnamedRefusal({ side: 'SELL', price: 232.93, market: 151 }),
    ).to.deep.equal({ band: 0.2, fromFilter: false })
    // a filter (connector priceMultiplier) wins: a sell is capped by `up`
    const f = bandForUnnamedRefusal({
      side: 'SELL',
      price: 232.93,
      market: 151,
      priceMultiplier: { up: 1.05, down: 0.95 },
    })
    expect(f?.fromFilter).to.equal(true)
    expect(f?.band).to.be.closeTo(0.05, 1e-9)
    // refused at 12% away: the band is below 12% whatever the default says
    expect(
      bandForUnnamedRefusal({ side: 'BUY', price: 88, market: 100 })?.band,
    ).to.be.closeTo(0.12, 1e-9)
    // an order the price already passed is the re-price's, not held
    expect(
      bandForUnnamedRefusal({ side: 'SELL', price: 140, market: 151 }),
    ).to.equal(null)
  })

  describe('(a) a safety order', () => {
    const build = (market: { price: number }, venue: { fn: Venue }) => {
      const bot: any = wire(Object.create(MainBot.prototype), market, venue)
      bot.replacesVenueCancel = (o: any) =>
        o.typeOrder === TypeOrderEnum.dealRegular
      bot.replaceVenueCanceled = async (o: any) => {
        const r: unknown = await bot.sendOrderToExchange(
          { ...o, clientOrderId: `${o.clientOrderId}-again` },
          true,
        )
        return typeof r !== 'string'
      }
      return bot
    }
    const so = () =>
      binanceOrder({
        symbol: 'BEBUSDT',
        side: 'BUY',
        price: 108.53,
        typeOrder: TypeOrderEnum.dealRegular,
        dealId: 'deal-long',
        qty: '0.052',
      })

    it('one notice, nothing sent while out of range, one send in range, no burst after a restart', async () => {
      const market = { price: 151 }
      const venue = { fn: refusePercent }
      const bot = build(market, venue)
      expect(await bot.sendOrderToExchange(so(), true)).to.equal(PERCENT)
      await settleAll()
      expect(bot.venueCalls).to.have.length(1)
      expect(bot.outOfBandOrders?.size).to.equal(1)
      expect(store.get('outOfBandBand:binance:BEBUSDT:BUY')).to.equal('0.2')
      expect(bot.warns.some((w: string) => /no price band filter/.test(w))).to
        .be.true
      expect(bot.notices).to.have.length(1)
      expect(bot.notices[0].subType).to.equal(orderWaitingForPrice)
      expect(bot.notices[0].setError).to.equal(false)
      expect(bot.notices[0].message).to.match(/108\.53.*waiting for the price/)

      // the same level again (a rebuild): held here, no venue call, no notice
      expect(await bot.sendOrderToExchange(so(), true)).to.match(/^Held: /)
      await settleAll()
      expect(bot.venueCalls).to.have.length(1)
      expect(bot.notices).to.have.length(1)

      // ticks out of range place nothing
      bot.checkOutOfBandOrders('BEBUSDT', 140)
      await settleAll()
      expect(bot.venueCalls).to.have.length(1)

      // a restart: fresh memory, same Redis -> held, no venue call, no notice
      VenuePriceBand.resetCache()
      const reloaded = build(market, venue)
      for (let i = 0; i < 3; i++) {
        expect(await reloaded.sendOrderToExchange(so(), true)).to.match(
          /^Held: /,
        )
      }
      await settleAll()
      expect(reloaded.venueCalls).to.have.length(0)
      expect(reloaded.notices).to.have.length(0)

      // the price comes near: placed once
      venue.fn = acceptAll
      market.price = 130
      reloaded.checkOutOfBandOrders('BEBUSDT', 130)
      await settleAll()
      expect(reloaded.venueCalls).to.have.length(1)
      expect(+reloaded.venueCalls[0].price).to.equal(108.53)
      expect(reloaded.outOfBandOrders.size).to.equal(0)
      reloaded.checkOutOfBandOrders('BEBUSDT', 129)
      await settleAll()
      expect(reloaded.venueCalls).to.have.length(1)
    })

    it('an order other Binance filters refuse is not held (LOT_SIZE)', async () => {
      const bot = build(
        { price: 151 },
        {
          fn: async () => ({
            status: StatusEnum.notok,
            reason: 'Filter failure: LOT_SIZE',
            data: null,
          }),
        },
      )
      await bot.sendOrderToExchange(so(), true)
      await settleAll()
      expect(bot.outOfBandOrders?.size ?? 0).to.equal(0)
      expect(bot.notices).to.have.length(0)
    })

    it('no notice for a bot that is not open', async () => {
      const bot = build({ price: 151 }, { fn: refusePercent })
      bot.data.status = BotStatusEnum.closed
      await bot.sendOrderToExchange(so(), true)
      await settleAll()
      expect(bot.notices).to.have.length(0)
    })
  })

  describe('take profits, through the DCA engine', () => {
    let DCA: any
    before(function () {
      this.timeout(180000)
      DCA = createRequire(__filename)('./dcaHelper').default(MainBot)
    })

    const build = (
      market: { price: number },
      venue: { fn: Venue },
      deal: Row,
      tp: () => Row,
      ledger: Map<string, string>,
    ) => {
      const bot: any = wire(Object.create(DCA.prototype), market, venue)
      bot.missingTpRearm = new Map()
      bot.isDealForTPLevelCheck = async () => false
      bot.getDeal = (id: string) =>
        id === deal._id ? { deal, initialOrders: [] } : undefined
      bot.dealBookRebuildInFlight = () => false
      bot.getOrdersByStatusAndDealId = ({
        dealId,
        status,
      }: {
        dealId: string
        status: string[]
      }) =>
        [...bot.orders.values()].filter(
          (o: Row) => o.dealId === dealId && [status].flat().includes(o.status),
        )
      bot.getTPOrder = async () => [tp()]
      bot.placements = 0
      // the placement pass: send each order, then the coverage check
      bot.placeOrders = async (
        _b: string,
        _s: string,
        dealId: string,
        o: any,
      ) => {
        bot.placements++
        for (const n of o.new) {
          await bot.sendOrderToExchange({ ...n }, true)
        }
        await settleAll()
        await bot.noteTpCoverageAfterPlacement(dealId)
      }
      const key = (p: string[]) => p.join(':')
      bot.missingTpGiveUpLedger = () => ({
        record: async (p: string[], reason: string) => {
          ledger.set(key(p), reason)
          return { until: 0, reason, interval: 0, attempt: 1 }
        },
        peek: async (p: string[]) =>
          ledger.has(key(p))
            ? { until: 0, reason: '', interval: 0, attempt: 1 }
            : null,
        clear: async (p: string[]) => {
          ledger.delete(key(p))
        },
      })
      return bot
    }

    const scenario = async (o: {
      symbol: string
      side: 'BUY' | 'SELL'
      tpPrice: number
      market: number
      stillOut: number
      inRange: number
      strategy: string
    }) => {
      const market = { price: o.market }
      const venue = { fn: refusePercent }
      const deal = {
        _id: `deal-${o.symbol}`,
        status: DCADealStatusEnum.open,
        strategy: o.strategy,
        symbol: { symbol: o.symbol },
        lastPrice: o.market,
        avgPrice: o.tpPrice,
        initialPrice: o.tpPrice,
      }
      const tp = () =>
        binanceOrder({
          symbol: o.symbol,
          side: o.side,
          price: o.tpPrice,
          typeOrder: TypeOrderEnum.dealTP,
          dealId: deal._id,
        })
      const ledger = new Map<string, string>()
      const bot = build(market, venue, deal, tp, ledger)

      // the placement pass sends the take profit: refused once, then held
      await bot.placeOrders(bot.botId, o.symbol, deal._id, { new: [tp()] })
      await settleAll()
      expect(bot.venueCalls).to.have.length(1)
      expect(bot.outOfBandOrders?.size).to.equal(1)
      // no re-send ladder: the price tick owns a held take profit
      expect(bot.missingTpRearm.get(deal._id)?.timer).to.equal(undefined)
      expect(bot.notices).to.have.length(1)
      expect(bot.notices[0].subType).to.equal(positionLeftOpen)
      expect(bot.notices[0].setError).to.equal(false)
      expect(bot.notices[0].message).to.match(/no take profit on the exchange/)
      expect(bot.notices[0].message).to.contain(`${o.tpPrice}`)

      // out of range: nothing sent
      bot.checkOutOfBandOrders(o.symbol, o.stillOut)
      await settleAll()
      expect(bot.venueCalls).to.have.length(1)

      // a restart: the reload's placement pass holds it without the venue,
      // says nothing new, starts no re-send ladder
      VenuePriceBand.resetCache()
      const reloaded = build(market, venue, deal, tp, ledger)
      await reloaded.placeOrders(reloaded.botId, o.symbol, deal._id, {
        new: [tp()],
      })
      await settleAll()
      expect(reloaded.venueCalls).to.have.length(0)
      expect(reloaded.notices).to.have.length(0)
      expect(reloaded.missingTpRearm.get(deal._id)?.timer).to.equal(undefined)

      // the price comes near: the take profit is planned again and placed once
      venue.fn = acceptAll
      market.price = o.inRange
      reloaded.checkOutOfBandOrders(o.symbol, o.inRange)
      await settleAll()
      expect(reloaded.venueCalls).to.have.length(1)
      expect(+reloaded.venueCalls[0].price).to.equal(o.tpPrice)
      expect(reloaded.venueCalls[0].side).to.equal(o.side)
      expect(reloaded.outOfBandOrders.size).to.equal(0)
      reloaded.checkOutOfBandOrders(o.symbol, o.inRange)
      await settleAll()
      expect(reloaded.venueCalls).to.have.length(1)
      for (const b of [bot, reloaded]) {
        for (const e of b.missingTpRearm.values()) {
          if (e.timer) clearTimeout(e.timer)
        }
      }
    }

    it('(b) a take profit far above the price: LONG BEBUSDT SELL 232.93 at ~151', async () => {
      await scenario({
        symbol: 'BEBUSDT',
        side: 'SELL',
        tpPrice: 232.93,
        market: 151,
        stillOut: 190,
        inRange: 200,
        strategy: 'LONG',
      })
    })

    it('(c) a SHORT take profit far below the price: METUSDT BUY 0.0858 at 0.227', async () => {
      await scenario({
        symbol: 'METUSDT',
        side: 'BUY',
        tpPrice: 0.0858,
        market: 0.227,
        stillOut: 0.11,
        inRange: 0.104,
        strategy: 'SHORT',
      })
    })

    it('a missing take profit that used up its re-sends stays given up after a restart', async () => {
      const ledger = new Map<string, string>()
      const deal = {
        _id: 'deal-gaveup',
        status: DCADealStatusEnum.open,
        symbol: { symbol: 'BEBUSDT' },
        lastPrice: 151,
        avgPrice: 150,
        initialPrice: 150,
      }
      const tp = () =>
        binanceOrder({
          symbol: 'BEBUSDT',
          side: 'SELL',
          price: 153,
          typeOrder: TypeOrderEnum.dealTP,
          dealId: deal._id,
        })
      const bot = build({ price: 151 }, { fn: refusePercent }, deal, tp, ledger)
      for (let i = 0; i < 8; i++) {
        await bot.noteTpCoverageAfterPlacement(deal._id)
        const e = bot.missingTpRearm.get(deal._id)
        if (e?.timer) {
          clearTimeout(e.timer)
          e.timer = undefined
        }
      }
      expect(bot.missingTpRearm.get(deal._id).attempt).to.equal(5)
      expect(ledger.size).to.equal(1)

      const reloaded = build(
        { price: 151 },
        { fn: refusePercent },
        deal,
        tp,
        ledger,
      )
      await reloaded.noteTpCoverageAfterPlacement(deal._id)
      const e = reloaded.missingTpRearm.get(deal._id)
      expect(e.timer).to.equal(undefined)
      expect(e.attempt).to.equal(5)

      // a take profit that rests clears it for good
      reloaded.orders.set('tp-rest', { ...tp(), clientOrderId: 'tp-rest' })
      await reloaded.noteTpCoverageAfterPlacement(deal._id)
      await settleAll()
      expect(reloaded.missingTpRearm.has(deal._id)).to.equal(false)
      expect(ledger.size).to.equal(0)
    })
  })
})
