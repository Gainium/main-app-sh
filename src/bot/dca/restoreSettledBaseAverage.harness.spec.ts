process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `129`: a restore recomputes the average of an
 * open deal that holds a settled (CANCELED, part-filled) base entry.
 *
 * Driven over the REAL `restoreWork` and `getAvgPrice`. The deal is in the
 * state the production deal was stored in: its average was written from the
 * safety fills alone, before `getAvgPrice` counted a cancelled base row (spec
 * `128` §4.2). Quantities and prices are the production ones; identifiers are
 * synthetic because this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  DCADealStatusEnum,
  ExchangeEnum,
  StartConditionEnum,
  StatusEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d29'
const BOT_ID = '000000000000000000000b29'
const USER_ID = '000000000000000000000429'
const SYMBOL = 'KTA-USDC'
const BO_ID = 'D-BO-0000000000000000000000000129'

const baseOrder = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId: BO_ID,
    dealId: DEAL_ID,
    typeOrder: 'dealStart',
    type: 'LIMIT',
    side: 'BUY',
    price: '0.0711',
    origPrice: '0.0711',
    origQty: '1407.8',
    executedQty: '1405.4',
    status: 'CANCELED',
    updateTime: 1790944309613,
    ...over,
  }) as any

/** The six safety orders that filled on the production deal. */
const safetyFills: [string, string][] = [
  ['468.8', '0.0704'],
  ['497.1', '0.0697'],
  ['527.3', '0.069'],
  ['559.3', '0.0683'],
  ['594.2', '0.0675'],
  ['630.5', '0.0668'],
]
const safetyRows = () =>
  safetyFills.map(
    ([qty, price], i) =>
      ({
        symbol: SYMBOL,
        clientOrderId: `D-RO-00000000000000000000000000${i}`,
        dealId: DEAL_ID,
        typeOrder: 'dealRegular',
        type: 'LIMIT',
        side: 'BUY',
        price,
        origQty: qty,
        executedQty: qty,
        status: 'FILLED',
        updateTime: 1790944309613 + 1000 * (i + 1),
      }) as any,
  )

const SAFETY_BASE = safetyFills.reduce((a, [q]) => a + +q, 0)
const SAFETY_QUOTE = safetyFills.reduce((a, [q, p]) => a + +q * +p, 0)
/** What the production deal stores: 0.06849175515684121. */
const STORED_AVG = SAFETY_QUOTE / SAFETY_BASE
/** Base order 1405.4 @ 0.0711 plus the safety fills: 4682.6 held. */
const WITH_BASE_AVG = (SAFETY_QUOTE + 1405.4 * 0.0711) / (SAFETY_BASE + 1405.4)

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: {
  /** The order map as the restore finds it. */
  orders: any[]
  /** `dealStart` rows the orders collection holds for the deal. */
  dbRows?: any[]
  serviceRestart?: boolean
  storedAvg?: number
}) => {
  const {
    orders,
    dbRows = [],
    serviceRestart = true,
    storedAvg = STORED_AVG,
  } = opts
  const raised = {
    saved: [] as Record<string, unknown>[],
    usage: [] as unknown[][],
    built: [] as number[],
    placed: [] as any[],
    sent: [] as any[],
    dbReads: [] as any[],
    warns: [] as string[],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL, baseAsset: 'KTA', quoteAsset: 'USDC' },
      settings: { avgPrice: storedAvg },
      avgPrice: storedAvg,
      displayAvg: storedAvg,
      initialPrice: 0.0711,
      lastPrice: 0.0668,
      profit: { total: 0 },
      levels: { all: 31, complete: 6 },
      initialBalances: { base: 0, quote: 2292.40313 },
      currentBalances: { base: 4682.6, quote: 1968.01801 },
    },
    initialOrders: [],
    currentOrders: [{ type: 'dealTP', price: 0.0693, qty: 4682.6 }],
    previousOrders: [],
  }
  const bot: any = Object.create(Helper.prototype)
  bot.raised = raised
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = BotType.dca
  bot.isLong = true
  bot.serviceRestart = serviceRestart
  bot.secondRestart = false
  bot.keepOrders = false
  bot.pendingClose = new Set<string>()
  bot.data = {
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    paperContext: false,
    status: 'open',
    settings: {},
  }
  bot.orders = new Map<string, any>(orders.map((o) => [o.clientOrderId, o]))
  bot.deals = new Map<string, any>([[DEAL_ID, deal]])
  bot.math = new MathHelper()
  bot.ordersDb = {
    readData: async (search: any, _f?: any, _o?: any, isArray?: boolean) => {
      raised.dbReads.push(search)
      const rows = dbRows.filter(
        (r) =>
          (!search.status || r.status === search.status) &&
          (!search.typeOrder || r.typeOrder === search.typeOrder),
      )
      return isArray
        ? { status: StatusEnum.ok, data: { result: rows } }
        : { status: StatusEnum.ok, data: { result: rows[0] } }
    },
  }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.setOrder = (o: any) => bot.orders.set(o.clientOrderId, o)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOpenDeals = () => [deal]
  bot.getOrdersByStatusAndDealId = ({
    status,
    dealId,
  }: {
    status?: string | string[]
    dealId?: string
  }) =>
    [...bot.orders.values()].filter(
      (o: any) =>
        (!dealId || o.dealId === dealId) &&
        (!status ||
          (Array.isArray(status) ? status : [status]).includes(o.status)),
    )
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 4,
    baseAsset: { minAmount: 0.1, step: 0.1 },
    quoteAsset: { minAmount: 1 },
  })
  bot.getUserFee = async () => ({ maker: 0.006, taker: 0.012 })
  bot.profitBase = async () => false
  bot.getAggregatedSettings = async () => ({
    type: 'regular',
    startCondition: StartConditionEnum.manual,
  })
  bot.saveDeal = async (_d: any, update: Record<string, unknown>) => {
    raised.saved.push(update)
  }
  bot.updateUsage = async (...args: unknown[]) => {
    raised.usage.push(args)
  }
  bot.createCurrentDealOrders = async (
    _symbol: string,
    _last: number,
    _initial: unknown,
    avg: number,
  ) => {
    raised.built.push(avg)
    return [{ type: 'dealTP', price: avg * 1.0225, qty: 4682.6 }]
  }
  bot.placeOrders = async (
    _b: string,
    _s: string,
    _d: string,
    o: { new: any[] },
  ) => {
    raised.placed.push(...o.new)
  }
  bot.cancelOrderOnExchange = async (o: any) => {
    raised.sent.push(o)
  }
  bot.sendOrderToExchange = async (o: any) => {
    raised.sent.push(o)
  }
  // --- restoreWork's surroundings, stubbed to no-ops -----------------------
  bot.calculateBotDeals = () => undefined
  bot.getSymbolsToOpenAsapDeals = async () => [SYMBOL]
  bot.checkOrders = async () => undefined
  bot.cancelAllOrder = async () => undefined
  bot.clearAllOrderQuarantine = async () => undefined
  bot.setCloseByTimer = async () => undefined
  bot.resumeTrailingCloseRetry = async () => undefined
  bot.resumeBaseEntryRemainder = () => undefined
  bot.updateDealBalances = () => undefined
  bot.updateAssets = () => undefined
  bot.resendPendingFunds = () => undefined
  bot.updateDealLastPrices = () => undefined
  bot.startIndicatorInit = async () => undefined
  bot.calculateBotBalances = () => undefined
  bot.calculateUsage = () => undefined
  // -------------------------------------------------------------------------
  bot.emit = () => true
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.handleWarn = (log: string) => raised.warns.push(log)
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return { bot, deal }
}

describe('a restore recomputes a settled base entry average (spec 129)', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('§4.1 a service restart writes the average that includes the base fill', async () => {
    const { bot, deal } = buildBot({
      orders: [baseOrder(), ...safetyRows()],
    })
    await bot.restoreWork()
    const { saved, usage, built, warns } = bot.raised
    expect(warns, warns.join('\n')).to.have.length(0)
    expect(deal.deal.avgPrice).to.be.closeTo(WITH_BASE_AVG, 1e-12)
    expect(deal.deal.settings.avgPrice).to.be.closeTo(WITH_BASE_AVG, 1e-12)
    const write = saved.find((s: any) => 'avgPrice' in s) as any
    expect(write, 'average persisted').to.not.equal(undefined)
    expect(write.avgPrice).to.be.closeTo(WITH_BASE_AVG, 1e-12)
    expect(write['settings.avgPrice']).to.be.closeTo(WITH_BASE_AVG, 1e-12)
    expect('displayAvg' in write).to.equal(true)
    // size is recomputed from the new average, without the 80/100% alerts
    expect(usage).to.deep.equal([[DEAL_ID, false, false, false]])
    // and the ladder the next placement uses is priced from it
    expect(built).to.have.length(1)
    expect(built[0]).to.be.closeTo(WITH_BASE_AVG, 1e-12)
    expect(deal.currentOrders[0].price).to.be.closeTo(
      WITH_BASE_AVG * 1.0225,
      1e-12,
    )
  })

  it('§4.4 a service restart places and cancels nothing', async () => {
    const { bot } = buildBot({ orders: [baseOrder(), ...safetyRows()] })
    await bot.restoreWork()
    expect(bot.raised.placed).to.have.length(0)
    expect(bot.raised.sent).to.have.length(0)
  })

  it('§4.4 a user start places the take profit from the corrected average', async () => {
    const { bot } = buildBot({
      orders: [baseOrder(), ...safetyRows()],
      serviceRestart: false,
    })
    await bot.restoreWork()
    const tp = bot.raised.placed.filter((o: any) => o.type === 'dealTP')
    expect(tp).to.have.length(1)
    expect(tp[0].price).to.be.closeTo(WITH_BASE_AVG * 1.0225, 1e-12)
  })

  it('§4.2 reads the row when the order map holds no base row', async () => {
    const { bot, deal } = buildBot({
      orders: safetyRows(),
      dbRows: [baseOrder()],
    })
    await bot.restoreWork()
    expect(bot.raised.dbReads).to.have.length(1)
    expect(bot.orders.get(BO_ID)?.status).to.equal('CANCELED')
    expect(deal.deal.avgPrice).to.be.closeTo(WITH_BASE_AVG, 1e-12)
  })

  it('§4.3 a FILLED base row costs no read and no write', async () => {
    const { bot, deal } = buildBot({
      orders: [baseOrder({ status: 'FILLED' }), ...safetyRows()],
      storedAvg: WITH_BASE_AVG,
    })
    await bot.restoreWork()
    expect(bot.raised.dbReads).to.have.length(0)
    expect(bot.raised.saved.filter((s: any) => 'avgPrice' in s)).to.have.length(
      0,
    )
    expect(bot.raised.usage).to.have.length(0)
    expect(deal.deal.avgPrice).to.equal(WITH_BASE_AVG)
  })

  it('§4.3 a cancelled base row with no fill changes nothing', async () => {
    const { bot, deal } = buildBot({
      orders: [baseOrder({ executedQty: '0' }), ...safetyRows()],
      dbRows: [baseOrder({ executedQty: '0' })],
    })
    await bot.restoreWork()
    expect(bot.raised.saved.filter((s: any) => 'avgPrice' in s)).to.have.length(
      0,
    )
    expect(deal.deal.avgPrice).to.equal(STORED_AVG)
  })

  it('§4.3 an average already including the base row writes nothing', async () => {
    const { bot } = buildBot({
      orders: [baseOrder(), ...safetyRows()],
      storedAvg: WITH_BASE_AVG,
    })
    // The stored value is the one `getAvgPrice` returns, bit for bit.
    const { avg } = await bot.getAvgPrice(DEAL_ID)
    bot.deals.get(DEAL_ID).deal.avgPrice = avg
    bot.deals.get(DEAL_ID).deal.settings.avgPrice = avg
    await bot.restoreWork()
    expect(bot.raised.saved.filter((s: any) => 'avgPrice' in s)).to.have.length(
      0,
    )
    expect(bot.raised.usage).to.have.length(0)
  })
})
