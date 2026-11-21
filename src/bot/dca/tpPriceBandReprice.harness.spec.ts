process.env.NODE_ENV = 'testing'

/**
 * A deal's take profit the market already ran through, refused by a venue
 * limit-price band.
 *
 * The fixture is a spot SHORT DCA deal on Bybit: its take-profit BUY at
 * 0.05855 sits above a market that fell to 0.0548, and Bybit refuses a limit
 * buy above its band (`Buy order price cannot be higher than 0.05509USDT.`).
 * Before this change the take profit was re-sent at 0.05855 on every try and
 * refused every time. Ids are synthetic.
 *
 * Drives the REAL `sendOrderToExchange` on a `MainBot` built off its
 * prototype (harness from `gridReduceOnlyRefusal.spec.ts`). Nothing opens a
 * connection.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  StatusEnum,
  ExchangeEnum,
  BotMarginTypeEnum,
  TypeOrderEnum,
} from '../../../types'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'
import { repricesOnPriceBand } from '../priceBandReprice'

const BUY_BAND = 'Buy order price cannot be higher than 0.05509USDT.'
const SELL_BAND = 'Sell order price cannot be lower than 0.0545USDT.'
const MARKET = 0.0548

type Row = Record<string, any>

let seq = 0
const tp = (over: Row = {}): any => ({
  clientOrderId: `D-TP-test${seq++}`,
  symbol: 'MANAUSDT',
  dealId: 'deal-short',
  botId: 'bot',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '103.1',
  executedQty: '0',
  price: '0.05855',
  origPrice: '0.05855',
  exchange: ExchangeEnum.bybit,
  typeOrder: TypeOrderEnum.dealTP,
  ...over,
})

type Venue = (req: any) => Promise<any>
const refuse = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})
/** A buy band: refuses a buy above `edge`, fills anything at or under it. */
const buyBand =
  (edge: number): Venue =>
  async (req: any) =>
    +req.price > edge
      ? refuse(`Buy order price cannot be higher than ${edge}USDT.`)
      : fill(req)
const fill = (req: any) => ({
  status: StatusEnum.ok,
  reason: null,
  data: {
    clientOrderId: req.newClientOrderId,
    orderId: `${Math.random()}`,
    symbol: 'MANAUSDT',
    side: req.side,
    type: 'LIMIT',
    status: 'FILLED',
    origQty: `${req.quantity}`,
    executedQty: `${req.quantity}`,
    price: `${req.price}`,
    cummulativeQuoteQty: `${+req.quantity * +req.price}`,
    fills: [],
  },
})

const makeBot = (venue: Venue) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const errors: { subType: string; message: string; setError: boolean }[] =
    []
  const events: Row[] = []
  const rows = new Map<string, Row>()
  Object.assign(bot, {
    botId: '6aa2c22b0000000000000002',
    userId: '6662f6170000000000ec8f01',
    botType: 'dca',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    errors,
    events,
    rows,
    ordersDb: {
      createData: async (doc: Row) => {
        rows.set(doc.clientOrderId, { ...doc })
        return { status: StatusEnum.ok, reason: null, data: { result: doc } }
      },
      updateData: async (filter: Row, update: Row) => {
        const { $unset: _unset, ...set } = update
        const row = rows.get(filter.clientOrderId)
        if (row) rows.set(filter.clientOrderId, { ...row, ...set })
        return { status: StatusEnum.ok, reason: null, data: { result: null } }
      },
      deleteManyData: async () => ({
        status: StatusEnum.ok,
        reason: 'Deleted',
        data: null,
      }),
    },
    data: {
      exchange: ExchangeEnum.bybit,
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.inherit },
      flags: [],
      notEnoughBalance: undefined,
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return venue(req)
      },
      getOrder: async () => refuse('Order not found'),
      returnBad: () => (e: Error) => refuse(e.message),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: {
      createData: async (e: Row) => {
        events.push(e)
        return { status: StatusEnum.notok }
      },
    },
    processError: async (
      _botId: string,
      subType: string,
      _terminal: boolean,
      setError: boolean,
      _send: boolean,
      message: string,
    ) => {
      errors.push({ subType, message, setError })
    },
    getLatestPrice: async () => MARKET,
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
    emit: () => undefined,
    updateData: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    isErrorNotEnoughBalance: () => false,
    getNotEnoughOrdersIdByOrder: () => 'MANAUSDT-BUY',
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 5,
      baseAsset: { maxMarketAmount: 1e12, precision: 2, minAmount: 0.01 },
      quoteAsset: { minAmount: 1, precision: 2 },
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

describe('spec 254: a passed take profit refused on a price band', () => {
  it('§4.1 a deal take profit is re-priced; reduce / add funds are not', () => {
    expect(repricesOnPriceBand(tp())).to.equal(true)
    expect(repricesOnPriceBand(tp({ reduceFundsId: 'r' }))).to.equal(false)
    expect(repricesOnPriceBand(tp({ addFundsId: 'a' }))).to.equal(false)
    expect(repricesOnPriceBand(tp({ type: 'MARKET' }))).to.equal(false)
    expect(repricesOnPriceBand(tp({ dealId: undefined }))).to.equal(false)
  })

  it('§4.1 re-sends the refused take profit once at the market, and it closes', async () => {
    const bot = makeBot(buyBand(0.05509))
    const order = tp()
    const res = await bot.sendOrderToExchange(order, true)
    expect(bot.venueCalls.map((r: any) => +r.price)).to.deep.equal([
      0.05855, 0.0548,
    ])
    expect(res?.status, 'the re-priced take profit filled').to.equal('FILLED')
    expect(bot.errors).to.deep.equal([])
  })

  it('§4.2 keeps the take-profit level on origPrice and books the fill price', async () => {
    const bot = makeBot(buyBand(0.05509))
    const order = tp()
    await bot.sendOrderToExchange(order, true)
    const row = bot.rows.get(order.clientOrderId)
    expect(row?.origPrice).to.equal('0.05855')
    expect(+row?.price).to.equal(0.0548)
  })

  it('§4.3 a second price refusal raises a visible error named for a take profit', async () => {
    const bot = makeBot(async () => refuse(BUY_BAND))
    await bot.sendOrderToExchange(tp(), true)
    expect(bot.venueCalls).to.have.length(2)
    expect(bot.errors).to.have.length(1)
    expect(bot.errors[0].setError).to.equal(true)
    expect(bot.errors[0].message).to.match(/^Take profit /)
    expect(bot.errors[0].message).to.contain('0.05855')
    expect(bot.events[0]?.event).to.equal('Order error')
  })

  it('§4.1 a long deal take-profit SELL only moves up, to the market', async () => {
    const bot = makeBot(async (req: any) =>
      +req.price < 0.0548 ? refuse(SELL_BAND) : fill(req),
    )
    await bot.sendOrderToExchange(
      tp({ side: 'SELL', price: '0.05012', origPrice: '0.05012' }),
      true,
    )
    expect(bot.venueCalls.map((r: any) => +r.price)).to.deep.equal([
      0.05012, 0.0548,
    ])
  })

  it('§4.4 a take profit the market has not passed is left alone', async () => {
    const bot = makeBot(async () => refuse(BUY_BAND))
    await bot.sendOrderToExchange(
      tp({ price: '0.05312', origPrice: '0.05312' }),
      true,
    )
    expect(bot.venueCalls).to.have.length(1)
    expect(bot.errors).to.deep.equal([])
  })

  it('§4.4 a reduce funds order is not re-priced', async () => {
    const bot = makeBot(async () => refuse(BUY_BAND))
    await bot.sendOrderToExchange(tp({ reduceFundsId: 'r1' }), true)
    expect(bot.venueCalls).to.have.length(1)
  })
})
