process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `059` — a cancel response that does not report
 * fills must not erase the fill the settle had already read.
 *
 * Driven end to end over the REAL methods: `settlePartialBaseEntry` from
 * `dcaHelper` on top of the REAL `cancelOrderOnExchange` from `main`, with the
 * venue replaced by a transport that answers exactly as the Kraken spot
 * connector does — a CommonOrder synthesised with `price: '0'`,
 * `origQty: '0'`, `executedQty: '0'`, `status: 'CANCELED'`
 * (`exchange-connector` `kraken/index.ts cancelOrderByOrderIdAndSymbol`).
 * That synthesis is the whole mechanism: `cancelOrderOnExchange` copies every
 * field of the response onto the row, so stubbing the cancel would stub out
 * the defect.
 *
 * Quantities are the production ones; the identifiers are synthetic because
 * this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { settledBaseEntryFill } from './partialBaseEntry'
import {
  BotType,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d59'
const BOT_ID = '000000000000000000000b59'
const USER_ID = '000000000000000000000459'
const SYMBOL = 'XMR-USD'
const CLIENT_ORDER_ID = 'D-BO-0000000000000000000000000059'

/** The base entry as the engine held it when the enter-market timer fired. */
const partFilledBaseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: 'AAAAAA-BBBBB-CCCCCC',
    clientOrderId: CLIENT_ORDER_ID,
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '589.8',
    origPrice: '589.8',
    origQty: '0.09093394',
    executedQty: '0.02',
    cummulativeQuoteQty: '11.796',
    status: 'PARTIALLY_FILLED',
    // Inside the bot's entry window, so the top-up decision is exercised
    // rather than skipped on age.
    updateTime: Date.now() - 1_000,
    transactTime: Date.now() - 25_000,
    ...over,
  }) as any

/** Kraken spot's cancel answer: the order is gone, and it says nothing else. */
const krakenSpotCancelResponse = (symbol: string, orderId: string) => ({
  symbol,
  orderId,
  clientOrderId: '',
  transactTime: Date.now(),
  updateTime: Date.now(),
  price: '0',
  origQty: '0',
  executedQty: '0',
  status: 'CANCELED',
  type: 'LIMIT',
  side: 'BUY',
})

const loadModule = createRequire(__filename)
let Helper: any

type Raised = {
  /** Rows that reached `processFilledOrder` — i.e. deals that actually open. */
  booked: any[]
  /** Rows written to the orders collection, with the `force` they were written with. */
  persisted: { order: any; force?: boolean }[]
  /** Top-up attempts. */
  toppedUp: any[]
  /** User-visible deal events. */
  events: any[]
  warns: string[]
}

const buildBot = (
  opts: {
    order?: any
    /** What the venue's cancel transport answers; `null` = no answer at all. */
    cancelAnswer?: 'kraken-spot' | 'echoes-the-fill' | 'none'
    dealStatus?: DCADealStatusEnum
  } = {},
) => {
  const {
    order = partFilledBaseOrder(),
    cancelAnswer = 'kraken-spot',
    dealStatus = DCADealStatusEnum.start,
  } = opts
  const raised: Raised = {
    booked: [],
    persisted: [],
    toppedUp: [],
    events: [],
    warns: [],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'XMR', quoteAsset: 'USD' },
      settings: {},
      profit: {},
      levels: { all: 9, complete: 0 },
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  const bot: any = Object.create(Helper.prototype)
  bot.raised = raised
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = BotType.dca
  bot.data = {
    exchange: ExchangeEnum.kraken,
    exchangeUUID: '',
    paperContext: false,
    settings: {},
  }
  bot.orders = new Map<string, any>([[order.clientOrderId, order]])
  bot.canceledMap = new Map()
  bot.unknownOrderInFlight = new Map()
  bot.dealTimersMap = new Map()
  bot.deals = new Map<string, any>([[DEAL_ID, deal]])
  bot.orderLimitRepositionTimeout = 10_000
  bot.enterMarketTimeout = 25_000
  bot.exchange = {
    returnBad: () => (e: Error) => ({
      status: StatusEnum.notok,
      reason: e.message,
      data: null,
    }),
    async cancelOrder({ symbol }: { symbol: string }) {
      if (cancelAnswer === 'none') {
        return {
          status: StatusEnum.notok,
          reason: 'Service unavailable',
          data: null,
        }
      }
      const data = krakenSpotCancelResponse(symbol, order.orderId)
      return {
        status: StatusEnum.ok,
        reason: '',
        data:
          cancelAnswer === 'echoes-the-fill'
            ? { ...data, executedQty: '0.02', price: '589.8' }
            : data,
      }
    },
  }
  bot.ordersDb = { readData: async () => ({ data: { result: undefined } }) }
  bot.botEventDb = {
    createData: async (d: any) => {
      raised.events.push(d)
      return { status: StatusEnum.ok }
    },
  }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOrdersByStatusAndDealId = () => [order]
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.updateOrderOnDb = (o: any, force?: boolean) =>
    raised.persisted.push({ order: { ...o }, force })
  bot.convertOrderExecutedQty = async (o: any) => o.executedQty
  /** The venue declines the remainder — the top-up leaves the row as it found it. */
  bot.fillPartiallyFilledOrder = async (o: any) => {
    raised.toppedUp.push({ ...o })
    return o
  }
  /** The end of the chain: reached only when the row is FILLED. */
  bot.processFilledOrder = async (o: any) => {
    raised.booked.push({ ...o })
  }
  bot.emit = () => true
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.handleWarn = (log: string) => raised.warns.push(log)
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return bot
}

describe('§4.1 which report states what the entry traded (spec 059)', () => {
  const dated = Date.now() - 1_000
  const observed = {
    status: 'PARTIALLY_FILLED',
    executedQty: '0.02',
    price: '589.8',
    updateTime: dated,
  }
  const krakenAnswer = {
    status: 'CANCELED',
    executedQty: '0',
    price: '0',
    updateTime: dated,
  }

  it('takes the fill the engine read when the answer states none', () => {
    expect(settledBaseEntryFill(krakenAnswer, observed)).to.deep.equal({
      executedQty: '0.02',
      price: '589.8',
      updateTime: dated,
    })
  })

  it('prefers the answer when the answer states one', () => {
    expect(
      settledBaseEntryFill(
        { ...krakenAnswer, executedQty: '0.03', price: '590.1' },
        observed,
      ),
    ).to.deep.equal({
      executedQty: '0.03',
      price: '590.1',
      updateTime: dated,
    })
  })

  it('books nothing when the cancel got no answer at all', () => {
    for (const settled of [null, undefined]) {
      expect(settledBaseEntryFill(settled, observed), `${settled}`).to.equal(
        null,
      )
    }
  })

  it('books nothing when the cancel did not end the order', () => {
    for (const status of ['NEW', 'PARTIALLY_FILLED', 'FILLED', '', null]) {
      expect(
        settledBaseEntryFill({ ...krakenAnswer, status }, observed),
        `${status}`,
      ).to.equal(null)
    }
  })

  it('books nothing when neither side traded anything', () => {
    for (const executedQty of ['0', '0.00000000', '', null, undefined]) {
      expect(
        settledBaseEntryFill(krakenAnswer, { ...observed, executedQty }),
        `${executedQty}`,
      ).to.equal(null)
    }
  })

  it('will not book a quantity it cannot date', () => {
    // Same rule spec 048 §4.1 applies: a row written from a REST response can
    // carry a bogus `executedQty` alongside `updateTime: -1`.
    for (const updateTime of [-1, 0, null, undefined]) {
      expect(
        settledBaseEntryFill(krakenAnswer, { ...observed, updateTime }),
        `${updateTime}`,
      ).to.equal(null)
    }
  })

  it('accepts an EXPIRED answer on the same terms', () => {
    expect(
      settledBaseEntryFill({ ...krakenAnswer, status: 'EXPIRED' }, observed),
    ).to.deep.equal({
      executedQty: '0.02',
      price: '589.8',
      updateTime: dated,
    })
  })
})

describe('a cancel answer that reports no fill (spec 059)', () => {
  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('§1.2 opens the deal on the fill the settle had already read', async () => {
    const bot = buildBot()
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.warns, raised.warns.join('\n')).to.have.length(0)
    expect(raised.booked, 'deal opened').to.have.length(1)
    expect(raised.booked[0].status).to.equal('FILLED')
    expect(raised.booked[0].executedQty).to.equal('0.02')
    expect(raised.booked[0].origQty).to.equal('0.09093394')
  })

  it('§4.1 keeps the price the entry actually traded at', async () => {
    // The cancel response carries `price: '0'`, and the copy loop writes it
    // over the row. A deal opened on that has no entry price at all.
    const bot = buildBot()
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    expect((bot.raised as Raised).booked[0].price).to.equal('589.8')
  })

  it('§4.2 continues into the top-up and the cut-short report', async () => {
    const bot = buildBot()
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.toppedUp, 'remainder asked for').to.have.length(1)
    expect(raised.toppedUp[0].executedQty).to.equal('0.02')
    expect(raised.events, 'told once').to.have.length(1)
    expect(raised.events[0].deal).to.equal(DEAL_ID)
    expect(raised.events[0].description).to.contain('0.02')
    expect(raised.events[0].description).to.contain('0.09093394')
  })

  it('§4.3 writes the promotion over the terminal row the venue left', async () => {
    const bot = buildBot()
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const promoted = (bot.raised as Raised).persisted.filter(
      (p) => p.order.status === 'FILLED',
    )
    expect(promoted, 'the promotion is persisted').to.have.length.greaterThan(0)
    expect(promoted[0].force, 'forced past the terminal-row filter').to.equal(
      true,
    )
    expect(promoted[0].order.executedQty).to.equal('0.02')
  })

  it('§1.1 a settle that got no answer still warns and books nothing', async () => {
    const bot = buildBot({ cancelAnswer: 'none' })
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.booked, 'nothing opened').to.have.length(0)
    expect(raised.warns.join('\n')).to.contain('no answer from exchange')
  })

  it('f84418a is untouched — a cancel that reports the fill still promotes', async () => {
    const bot = buildBot({ cancelAnswer: 'echoes-the-fill' })
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.warns, raised.warns.join('\n')).to.have.length(0)
    expect(raised.booked, 'deal opened').to.have.length(1)
    expect(raised.booked[0].executedQty).to.equal('0.02')
    expect(raised.booked[0].price).to.equal('589.8')
  })

  it('85f266a is untouched — an already-terminal row costs no venue call', async () => {
    const bot = buildBot({
      order: partFilledBaseOrder({ status: 'CANCELED' }),
    })
    let asked = 0
    const cancelOrder = bot.exchange.cancelOrder
    bot.exchange.cancelOrder = async (...a: any[]) => {
      asked += 1
      return cancelOrder.apply(bot.exchange, a)
    }
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(asked, 'nothing sent to the venue').to.equal(0)
    expect(raised.booked, 'deal opened').to.have.length(1)
    expect(raised.booked[0].executedQty).to.equal('0.02')
  })

  it('an entry that never traded is still just a cancel', async () => {
    const bot = buildBot({
      order: partFilledBaseOrder({
        executedQty: '0',
        cummulativeQuoteQty: '0',
      }),
    })
    await bot.settlePartialBaseEntry(bot.orders.get(CLIENT_ORDER_ID), DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.booked, 'nothing opened').to.have.length(0)
    expect(raised.events, 'and nothing said to the user').to.have.length(0)
    expect(raised.warns.join('\n')).to.contain('CANCELED')
  })
})
