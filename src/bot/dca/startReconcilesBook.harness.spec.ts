process.env.NODE_ENV = 'testing'

/**
 * A user start reconciles the open deals' resting orders instead of tearing
 * them down.
 *
 * `restoreWork` used to `cancelAllOrder()` on every user start and re-place
 * each open deal's book from `currentOrders`, which is rebuilt at the current
 * price. That re-priced every ladder and, on a bot with ~100 open deals, kept
 * the start busy for minutes of one-at-a-time venue calls. Now the start asks
 * the venue about the orders it holds (the reconnect reconcile, without its
 * fleet spread delay) and places only what is missing.
 *
 * Driven over the REAL `restoreWork`; identifiers are synthetic because this
 * file is public.
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

const DEAL_ID = '000000000000000000000d31'
const BOT_ID = '000000000000000000000b31'
const USER_ID = '000000000000000000000431'
const SYMBOL = 'ETH-USDC'

const row = (id: string, over: Record<string, unknown>) =>
  ({
    symbol: SYMBOL,
    clientOrderId: id,
    dealId: DEAL_ID,
    type: 'LIMIT',
    updateTime: 1790944309613,
    ...over,
  }) as any

const filledBase = row('D-BO-1', {
  typeOrder: 'dealStart',
  side: 'BUY',
  price: '3000',
  origQty: '1',
  executedQty: '1',
  status: 'FILLED',
})
const restingSo = row('D-RO-1', {
  typeOrder: 'dealRegular',
  side: 'BUY',
  price: '2900',
  origQty: '1',
  executedQty: '0',
  status: 'NEW',
})
const restingTp = row('D-TP-1', {
  typeOrder: 'dealTP',
  side: 'SELL',
  price: '3060',
  origQty: '1',
  executedQty: '0',
  status: 'NEW',
})

/** The book `currentOrders` rebuilds at today's price — not the resting one. */
const rebuilt = [
  { type: 'dealRegular', side: 'BUY', price: 2600, qty: 1 },
  { type: 'dealTP', side: 'SELL', price: 2750, qty: 1 },
]

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: {
  orders: any[]
  serviceRestart?: boolean
  venue?: unknown
}) => {
  const { orders, serviceRestart = false, venue } = opts
  const raised = {
    placed: [] as any[],
    cancelAll: 0,
    reconcile: [] as unknown[][],
    checkOrders: [] as unknown[][],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'USDC' },
      settings: { avgPrice: 3000 },
      avgPrice: 3000,
      initialPrice: 3000,
      lastPrice: 2700,
      profit: { total: 0 },
      levels: { all: 3, complete: 1 },
      initialBalances: { base: 0, quote: 10000 },
      currentBalances: { base: 1, quote: 7000 },
    },
    initialOrders: [{ type: 'dealRegular' }, { type: 'dealRegular' }],
    currentOrders: rebuilt,
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
    exchange: ExchangeEnum.hyperliquid,
    exchangeUUID: '',
    paperContext: false,
    status: 'open',
    settings: {},
  }
  bot.orders = new Map<string, any>(orders.map((o) => [o.clientOrderId, o]))
  bot.deals = new Map<string, any>([[DEAL_ID, deal]])
  bot.math = new MathHelper()
  bot.ordersDb = {
    // No write-ahead row for any order: the unsent-order retire may proceed.
    readData: async (_q: any, _f?: any, _o?: any, isArray?: boolean) => ({
      status: StatusEnum.ok,
      data: { result: isArray ? [] : undefined },
    }),
  }
  bot.getOrderFromMap = (id: string) => bot.orders.get(id)
  bot.getDeal = (id?: string) => (id === DEAL_ID ? deal : undefined)
  bot.getOpenDeals = () => [deal]
  bot.getOrdersByStatusAndDealId = ({
    status,
    dealId,
    defaultStatuses,
  }: {
    status?: string | string[]
    dealId?: string
    defaultStatuses?: boolean
  }) =>
    [...bot.orders.values()].filter(
      (o: any) =>
        (!dealId || o.dealId === dealId) &&
        (defaultStatuses
          ? ['NEW', 'PARTIALLY_FILLED'].includes(o.status)
          : !status ||
            (Array.isArray(status) ? status : [status]).includes(o.status)),
    )
  bot.deleteOrder = (id: string) => bot.orders.delete(id)
  bot.getOrderForReconcile = async () =>
    venue ?? { status: StatusEnum.ok, data: { status: 'NEW' } }
  bot.getAggregatedSettings = async () => ({
    type: 'regular',
    startCondition: StartConditionEnum.manual,
  })
  bot.saveDeal = async () => undefined
  bot.placeOrders = async (
    _b: string,
    _s: string,
    _d: string,
    o: { new: any[] },
  ) => {
    raised.placed.push(...o.new)
  }
  bot.cancelAllOrder = async () => {
    raised.cancelAll++
  }
  bot.checkOrdersAfterReconnect = async (...args: unknown[]) => {
    raised.reconcile.push(args)
  }
  bot.checkOrders = async (...args: unknown[]) => {
    raised.checkOrders.push(args)
  }
  // --- restoreWork's surroundings, stubbed to no-ops -----------------------
  bot.calculateBotDeals = () => undefined
  bot.getSymbolsToOpenAsapDeals = async () => [SYMBOL]
  bot.clearAllOrderQuarantine = async () => undefined
  bot.setCloseByTimer = async () => undefined
  bot.resumeTrailingCloseRetry = async () => undefined
  bot.resumeBaseEntryRemainder = () => undefined
  bot.restoreSettledBaseEntryAverage = async () => undefined
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
  bot.handleWarn = () => undefined
  bot.startMethod = () => '1'
  bot.endMethod = () => undefined
  return { bot }
}

describe('a user start reconciles the resting book instead of re-placing it', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the 25k-line helper over the real MainBot.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default()
  })

  it('cancels nothing and asks the venue, without the fleet spread delay', async () => {
    const { bot } = buildBot({ orders: [filledBase, restingSo, restingTp] })
    await bot.restoreWork()
    expect(bot.raised.cancelAll).to.equal(0)
    expect(bot.raised.reconcile).to.deep.equal([[BOT_ID, false]])
    expect(bot.raised.checkOrders).to.deep.equal([[BOT_ID, true]])
  })

  it('leaves a deal with a resting ladder and take profit untouched', async () => {
    const { bot } = buildBot({ orders: [filledBase, restingSo, restingTp] })
    await bot.restoreWork()
    expect(bot.raised.placed).to.have.length(0)
  })

  it('places the book of a deal that has nothing resting', async () => {
    const { bot } = buildBot({ orders: [filledBase] })
    await bot.restoreWork()
    expect(bot.raised.placed.map((o: any) => o.type)).to.deep.equal([
      'dealRegular',
      'dealTP',
    ])
  })

  it('places only the take profit when just the ladder is resting', async () => {
    const { bot } = buildBot({ orders: [filledBase, restingSo] })
    await bot.restoreWork()
    expect(bot.raised.placed.map((o: any) => o.type)).to.deep.equal([
      'dealTP',
    ])
  })

  it('drops a take profit that was never sent and places it', async () => {
    const unsentTp = { ...restingTp, orderId: '-1', transactTime: 1 }
    const { bot } = buildBot({
      orders: [filledBase, restingSo, unsentTp],
      venue: { status: StatusEnum.notok, reason: 'Order does not exist.' },
    })
    await bot.restoreWork()
    expect(bot.orders.has('D-TP-1')).to.equal(false)
    expect(bot.raised.placed.map((o: any) => o.type)).to.deep.equal([
      'dealTP',
    ])
  })

  it('keeps a -1 take profit the venue confirms', async () => {
    const unsentTp = { ...restingTp, orderId: '-1', transactTime: 1 }
    const { bot } = buildBot({ orders: [filledBase, restingSo, unsentTp] })
    await bot.restoreWork()
    expect(bot.orders.has('D-TP-1')).to.equal(true)
    expect(bot.raised.placed).to.have.length(0)
  })

  it('a service restart does not run the start reconcile', async () => {
    const { bot } = buildBot({
      orders: [filledBase, restingSo, restingTp],
      serviceRestart: true,
    })
    await bot.restoreWork()
    expect(bot.raised.reconcile).to.have.length(0)
    expect(bot.raised.cancelAll).to.equal(0)
  })
})
