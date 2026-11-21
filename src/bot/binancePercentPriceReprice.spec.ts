process.env.NODE_ENV = 'testing'

/**
 * Binance refuses a limit buy priced far above the market with
 * `Filter failure: PERCENT_PRICE_BY_SIDE`. That wording classifies as
 * `Order params` (the generic `Filter failure` match), not `Order price`, so
 * the price-band re-send that Bybit, OKX and Bitget get never fired for
 * Binance: a DCA level the price already ran through was re-sent at its stale
 * level on every reload, refused every time, and nothing told the user.
 *
 * Enforces specs/251 §2.1-§2.4. Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { unplaceableGridOrderSubType } from './utils'

const PERCENT = 'Filter failure: PERCENT_PRICE_BY_SIDE'
const MARKET = 0.054

/**
 * What prod classifies these as: the `filter failure` boterrorrule (and the
 * static `Filter failure` entry) say `Order params` for every Binance filter.
 */
const prodSubType = (reason: string) =>
  /filter failure/i.test(reason)
    ? 'Order params'
    : /cannot be higher than/i.test(reason)
      ? 'Order price'
      : 'Uncategorized'

const makeBot = (openOrder: (req: any) => Promise<any>) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const reports: any[] = []
  Object.assign(bot, {
    botId: 'b1',
    userId: 'u1',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    reports,
    data: {
      exchange: ExchangeEnum.binance,
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push({ ...req })
        return openOrder(req)
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
    ordersDb: {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: null },
      }),
      createData: async (d: any) => ({
        status: StatusEnum.ok,
        data: { result: d },
      }),
      updateData: async () => ({ status: StatusEnum.ok, data: null }),
      deleteManyData: async () => ({ status: StatusEnum.ok, data: null }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
    processError: async (...args: any[]) => {
      reports.push({ subType: args[1], message: args[5] })
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
    getErrorSubType: prodSubType,
    getLatestPrice: async () => MARKET,
    getNotEnoughOrdersIdByOrder: () => 'DOGEUSDT-BUY',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 5,
      baseAsset: { maxMarketAmount: 1e12, precision: 0, step: 1 },
      quoteAsset: { minAmount: 1, precision: 8 },
    }),
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

/** The refused safety order from the report: DOGEUSDT BUY at 0.06726. */
const safetyOrder = () => ({
  clientOrderId: 'RO-percentPriceLvl1',
  symbol: 'DOGEUSDT',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '150',
  price: '0.06726',
  origPrice: '0.06726',
  exchange: ExchangeEnum.binance,
  typeOrder: 'dealRegular',
  dealId: 'deal1',
  reduceOnly: false,
  positionSide: undefined,
})

const refused = (reason: string) => async () => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

const accepted = async (req: any) => ({
  status: StatusEnum.ok,
  reason: null,
  data: {
    ...safetyOrder(),
    clientOrderId: req.newClientOrderId,
    price: `${req.price}`,
    orderId: '900001',
    status: 'NEW',
    executedQty: '0',
    updateTime: Date.now(),
  },
})

describe('a Binance PERCENT_PRICE refusal of a passed level is re-sent at the market (spec 251)', () => {
  it('§2.1 a safety order the price ran through is re-sent once at the market, level kept', async () => {
    const bot = makeBot(async (req: any) =>
      +req.price === 0.06726 ? refused(PERCENT)() : accepted(req),
    )
    const order = safetyOrder()
    await bot.sendOrderToExchange(order)
    expect(bot.venueCalls.map((c: any) => +c.price)).to.deep.equal([
      0.06726, MARKET,
    ])
    expect(order.origPrice, 'DCA level kept').to.equal('0.06726')
    expect(bot.reports).to.have.length(0)
  })

  it('§2.2 refused again after the re-price -> a visible error, not silence', async () => {
    const bot = makeBot(refused(PERCENT))
    await bot.sendOrderToExchange(safetyOrder())
    expect(bot.venueCalls).to.have.length(2)
    expect(bot.reports.map((r: any) => r.subType)).to.deep.equal([
      unplaceableGridOrderSubType,
    ])
    expect(bot.reports[0].message).to.contain('PERCENT_PRICE_BY_SIDE')
  })

  it('§2.3 a combo grid level refused the same way is re-sent at the market too', async () => {
    const bot = makeBot(async (req: any) =>
      +req.price === 0.06726 ? refused(PERCENT)() : accepted(req),
    )
    await bot.sendOrderToExchange({ ...safetyOrder(), typeOrder: 'dealGrid' })
    expect(bot.venueCalls.map((c: any) => +c.price)).to.deep.equal([
      0.06726, MARKET,
    ])
  })

  it('control: a Bybit band refusal (classified Order price) re-sends as before', async () => {
    const bot = makeBot(async (req: any) =>
      +req.price === 0.06726
        ? refused('Buy order price cannot be higher than 0.05500USDT.')()
        : accepted(req),
    )
    await bot.sendOrderToExchange(safetyOrder())
    expect(bot.venueCalls.map((c: any) => +c.price)).to.deep.equal([
      0.06726, MARKET,
    ])
  })

  for (const other of [
    'Filter failure: LOT_SIZE',
    'Filter failure: NOTIONAL',
    'Filter failure: MIN_NOTIONAL',
  ]) {
    it(`§2.4 ${other} is never re-priced`, async () => {
      const bot = makeBot(refused(other))
      await bot.sendOrderToExchange(safetyOrder())
      expect(bot.venueCalls).to.have.length(1)
      expect(bot.reports).to.have.length(0)
    })
  }
})
