process.env.NODE_ENV = 'testing'

/**
 * A user start of a combo bot reconciles the open deals' resting orders —
 * ladder levels AND minigrid grid orders — instead of tearing them down.
 *
 * Combo's `restoreWork` override used to `cancelAllOrder()` on every user
 * start and re-place each open deal's ladder plus every active minigrid's
 * grid. It now runs the reconnect reconcile (without its fleet spread delay),
 * retires never-sent placeholder orders, cancels only the orders of closed
 * minigrids, and places what each deal is missing through the same diff a
 * service restart's `checkOrders` uses. The explicit Restart
 * (`reloadBot(replaceOrders=true)`) still sweeps the whole book first.
 *
 * Driven over the REAL `restoreWork`, `getDiffForCheckOrders`,
 * `findDiffCombo`, `findDiff`, `hasLiveCloseOrder`, `retireUnsentOrder` and
 * `reloadBot`; identifiers are synthetic because this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotType,
  ComboMinigridStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StartConditionEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d41'
const BOT_ID = '000000000000000000000b41'
const USER_ID = '000000000000000000000441'
const LIVE_GRID = '000000000000000000000a41'
const CLOSED_GRID = '000000000000000000000a42'
const SYMBOL = 'ETH-USDC'

const row = (id: string, over: Record<string, unknown>) =>
  ({
    symbol: SYMBOL,
    clientOrderId: id,
    orderId: `${id}-x`,
    dealId: DEAL_ID,
    type: 'LIMIT',
    executedQty: '0',
    status: 'NEW',
    updateTime: 1790944309613,
    ...over,
  }) as any

const filledBase = row('CMB-BO-1', {
  typeOrder: TypeOrderEnum.dealStart,
  side: 'BUY',
  price: '3000',
  origPrice: '3000',
  origQty: '1',
  executedQty: '1',
  status: 'FILLED',
})
const restingLevel = row('CMB-RO-1', {
  typeOrder: TypeOrderEnum.dealRegular,
  side: 'BUY',
  price: '2900',
  origPrice: '2900',
  origQty: '1',
  dcaLevel: 2,
})
const restingGridBuy = row('CMB-GR-1', {
  typeOrder: TypeOrderEnum.dealGrid,
  side: 'BUY',
  price: '2950',
  origPrice: '2950',
  origQty: '0.1',
  minigridId: LIVE_GRID,
})
const restingGridSell = row('CMB-GR-2', {
  typeOrder: TypeOrderEnum.dealGrid,
  side: 'SELL',
  price: '3050',
  origPrice: '3050',
  origQty: '0.1',
  minigridId: LIVE_GRID,
})
/** A grid order of a minigrid that has closed — nothing will ever pull it. */
const orphanGrid = row('CMB-GR-9', {
  typeOrder: TypeOrderEnum.dealGrid,
  side: 'SELL',
  price: '3200',
  origPrice: '3200',
  origQty: '0.1',
  minigridId: CLOSED_GRID,
})
const restingClose = row('D-TP-1', {
  typeOrder: TypeOrderEnum.dealTP,
  side: 'SELL',
  price: '3100',
  origPrice: '3100',
  origQty: '1',
})

const fullBook = () => [filledBase, restingLevel, restingGridBuy, restingGridSell]

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: {
  orders: any[]
  serviceRestart?: boolean
  venue?: unknown
  /** What the reconcile books: clientOrderId → venue status. */
  reconcileBooks?: Record<string, string>
}) => {
  const { orders, serviceRestart = false, venue, reconcileBooks = {} } = opts
  const raised = {
    placed: [] as any[],
    cancelAll: 0,
    venueCancels: [] as string[],
    reconcile: [] as unknown[][],
    checkOrders: [] as unknown[][],
    timers: [] as string[],
  }
  const deal: any = {
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
      levels: { all: 2, complete: 1 },
      initialBalances: { base: 0, quote: 10000 },
      currentBalances: { base: 1, quote: 7000 },
    },
    initialOrders: [{ type: TypeOrderEnum.dealRegular }],
    // The ladder level still to fill: fixed price, from the deal's start.
    currentOrders: [
      {
        number: 1,
        price: 2900,
        side: OrderSideEnum.buy,
        qty: 1,
        type: TypeOrderEnum.dealRegular,
        dcaLevel: 2,
        dealId: DEAL_ID,
        newClientOrderId: 'CMB-RO-new',
      },
    ],
    previousOrders: [],
  }
  const minigrid = (id: string, status: ComboMinigridStatusEnum, book: any[]) => ({
    schema: { _id: id, dealId: DEAL_ID, status },
    initialGrids: [],
    currentOrders: book,
  })
  const liveGrid = minigrid(LIVE_GRID, ComboMinigridStatusEnum.active, [
    {
      number: 1,
      price: 2950,
      side: OrderSideEnum.buy,
      qty: 0.1,
      type: TypeOrderEnum.dealGrid,
      dealId: DEAL_ID,
      minigridId: LIVE_GRID,
      newClientOrderId: 'CMB-GR-new-1',
    },
    {
      number: 2,
      price: 3050,
      side: OrderSideEnum.sell,
      qty: 0.1,
      type: TypeOrderEnum.dealGrid,
      dealId: DEAL_ID,
      minigridId: LIVE_GRID,
      newClientOrderId: 'CMB-GR-new-2',
    },
  ])
  const closedGrid = minigrid(CLOSED_GRID, ComboMinigridStatusEnum.closed, [])

  const bot: any = Object.create(Helper.prototype)
  bot.raised = raised
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.botType = BotType.combo
  bot.isLong = true
  bot.serviceRestart = serviceRestart
  bot.secondRestart = false
  bot.keepOrders = false
  bot.data = {
    exchange: ExchangeEnum.kucoin,
    exchangeUUID: '',
    paperContext: false,
    status: 'open',
    settings: {},
    flags: [],
  }
  bot.math = new MathHelper()
  bot.orders = new Map<string, any>(
    orders.map((o) => [o.clientOrderId, { ...o }]),
  )
  bot.deals = new Map<string, any>([[DEAL_ID, deal]])
  bot.minigrids = new Map<string, any>([
    [LIVE_GRID, liveGrid],
    [CLOSED_GRID, closedGrid],
  ])
  bot.minigridDealMap = new Map<string, Set<string>>([
    [DEAL_ID, new Set([LIVE_GRID, CLOSED_GRID])],
  ])
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
    dealId?: string | string[]
    defaultStatuses?: boolean
  }) =>
    [...bot.orders.values()].filter(
      (o: any) =>
        (!dealId || [dealId].flat().includes(o.dealId)) &&
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
  bot.placeOrders = async (
    _b: string,
    _s: string,
    _d: string,
    o: { new: any[]; cancel: any[] },
  ) => {
    raised.placed.push(...o.new)
  }
  bot.cancelOrderOnExchange = async (o: any) => {
    raised.venueCancels.push(o.clientOrderId)
    bot.orders.delete(o.clientOrderId)
  }
  // The sweep the explicit Restart runs: every resting order is pulled.
  bot.cancelAllOrder = async () => {
    raised.cancelAll++
    for (const o of [...bot.orders.values()]) {
      if (['NEW', 'PARTIALLY_FILLED'].includes(o.status)) {
        bot.orders.delete(o.clientOrderId)
      }
    }
  }
  bot.checkOrdersAfterReconnect = async (...args: unknown[]) => {
    raised.reconcile.push(args)
    for (const [id, status] of Object.entries(reconcileBooks)) {
      const o = bot.orders.get(id)
      if (o) o.status = status
    }
  }
  bot.checkOrders = async (...args: unknown[]) => {
    raised.checkOrders.push(args)
  }
  // --- restoreWork's surroundings, stubbed to no-ops -----------------------
  bot.calculateBotDeals = () => undefined
  bot.getSymbolsToOpenAsapDeals = async () => [SYMBOL]
  bot.clearAllOrderQuarantine = async () => undefined
  bot.updateDealBalances = () => undefined
  bot.avgPrice = async () => ({ real: 3000, display: 3000 })
  bot.saveDeal = () => undefined
  bot.updateAssets = () => undefined
  bot.updateDealLastPrices = () => undefined
  bot.startIndicatorInit = async () => undefined
  bot.calculateBotBalances = () => undefined
  bot.calculateUsage = async () => undefined
  // Spec 204: the close-by-timer re-arm, recorded.
  bot.setCloseByTimer = async (d: any) => {
    raised.timers.push(`${d._id}`)
  }
  // --- reloadBot's surroundings --------------------------------------------
  bot.openNewDealTimer = new Map()
  bot.allowToPlaceOrders = new Map()
  bot.indicators = new Map()
  bot.clearDealTimer = async () => undefined
  bot.start = async () => {
    // What `start()` does with the flags `reloadBot` leaves: run the restore.
    await bot.restoreWork()
  }
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

const placed = (bot: any) =>
  bot.raised.placed.map((g: any) => `${g.type} ${g.side} ${g.price}`).sort()

describe('a combo user start reconciles the resting book instead of re-placing it', function () {
  this.timeout(30_000)

  before(function () {
    // One ts-node compile of the combo mixin over the real DCA helper.
    this.timeout(240000)
    Helper = loadModule('../comboHelper').default()
  })

  it('cancels nothing and asks the venue, without the fleet spread delay', async () => {
    const { bot } = buildBot({ orders: fullBook() })
    await bot.restoreWork()
    expect(bot.raised.cancelAll).to.equal(0)
    expect(bot.raised.venueCancels).to.deep.equal([])
    expect(bot.raised.reconcile).to.deep.equal([[BOT_ID, false]])
    expect(bot.raised.checkOrders).to.deep.equal([[BOT_ID, true]])
  })

  it('leaves a deal with its ladder and minigrid orders resting untouched', async () => {
    const { bot } = buildBot({ orders: fullBook() })
    await bot.restoreWork()
    expect(bot.raised.placed).to.have.length(0)
  })

  it('places the whole book, minigrid orders included, of a deal with nothing resting', async () => {
    const { bot } = buildBot({ orders: [filledBase] })
    await bot.restoreWork()
    expect(placed(bot)).to.deep.equal([
      'dealGrid BUY 2950',
      'dealGrid SELL 3050',
      'dealRegular BUY 2900',
    ])
  })

  it('places only the minigrid order that is missing', async () => {
    const { bot } = buildBot({
      orders: [filledBase, restingLevel, restingGridBuy],
    })
    await bot.restoreWork()
    expect(placed(bot)).to.deep.equal(['dealGrid SELL 3050'])
  })

  it('cancels the resting orders of a closed minigrid, and only those', async () => {
    const { bot } = buildBot({ orders: [...fullBook(), orphanGrid] })
    await bot.restoreWork()
    expect(bot.raised.venueCancels).to.deep.equal(['CMB-GR-9'])
    expect(bot.raised.placed).to.have.length(0)
  })

  it('does not re-send a grid level the reconcile found filled', async () => {
    // The fill handler (unawaited) rebuilds the minigrid from this fill; the
    // stale book still lists the level, which must not go out a second time.
    const { bot } = buildBot({
      orders: fullBook(),
      reconcileBooks: { 'CMB-GR-1': 'FILLED' },
    })
    await bot.restoreWork()
    expect(bot.raised.placed).to.have.length(0)
  })

  it('places nothing beside a resting close order (spec 120)', async () => {
    const { bot } = buildBot({ orders: [filledBase, restingClose] })
    await bot.restoreWork()
    expect(bot.raised.venueCancels).to.deep.equal([])
    expect(bot.raised.placed).to.have.length(0)
  })

  it('drops a grid order that was never sent and places it', async () => {
    const unsent = { ...restingGridSell, orderId: '-1', transactTime: 1 }
    const { bot } = buildBot({
      orders: [filledBase, restingLevel, restingGridBuy, unsent],
      venue: { status: StatusEnum.notok, reason: 'Order does not exist.' },
    })
    await bot.restoreWork()
    expect(bot.orders.has('CMB-GR-2')).to.equal(false)
    expect(placed(bot)).to.deep.equal(['dealGrid SELL 3050'])
  })

  it('keeps a -1 grid order the venue confirms', async () => {
    const unsent = { ...restingGridSell, orderId: '-1', transactTime: 1 }
    const { bot } = buildBot({
      orders: [filledBase, restingLevel, restingGridBuy, unsent],
    })
    await bot.restoreWork()
    expect(bot.orders.has('CMB-GR-2')).to.equal(true)
    expect(bot.raised.placed).to.have.length(0)
  })

  it('a service restart is unchanged: no start reconcile, no placement, closed minigrid swept', async () => {
    const { bot } = buildBot({
      orders: [filledBase, orphanGrid],
      serviceRestart: true,
    })
    await bot.restoreWork()
    expect(bot.raised.reconcile).to.have.length(0)
    expect(bot.raised.cancelAll).to.equal(0)
    expect(bot.raised.checkOrders).to.deep.equal([[BOT_ID]])
    expect(bot.raised.venueCancels).to.deep.equal(['CMB-GR-9'])
    expect(bot.raised.placed).to.have.length(0)
  })

  it('spec 204 §1.5: re-arms the close-by-timer of every open deal, user start and service restart', async () => {
    for (const serviceRestart of [false, true]) {
      const { bot } = buildBot({ orders: fullBook(), serviceRestart })
      await bot.restoreWork()
      expect(bot.raised.timers).to.deep.equal([DEAL_ID])
    }
  })

  it('the explicit Restart still sweeps the book and re-places all of it', async () => {
    const { bot } = buildBot({ orders: fullBook() })
    await bot.reloadBot(BOT_ID)
    expect(bot.raised.cancelAll).to.equal(1)
    expect(placed(bot)).to.deep.equal([
      'dealGrid BUY 2950',
      'dealGrid SELL 3050',
      'dealRegular BUY 2900',
    ])
  })
})
