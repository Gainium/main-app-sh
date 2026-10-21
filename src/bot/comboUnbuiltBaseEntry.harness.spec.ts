process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `187`: a Combo base order that cannot be BUILT must
 * not leave its deal stranded in `start` with no order at all. Combo sibling of
 * `dca/unbuiltBaseEntry.harness.spec.ts` (spec `039`); Combo overrides
 * `placeBaseOrder`, so the DCA guard never ran for it.
 *
 * Drives the REAL Combo `placeBaseOrder` and the REAL Combo `getBaseOrder`,
 * replaying the production sequence: a spot SHORT Combo bot sized at
 * `percTotal` on an account holding only quote, so `getBaseOrder` reports
 * `Asset <base> not found in user balances` and returns nothing. No stack, DB,
 * Redis or venue.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotType,
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'

const DEAL_ID = '000000000000000000000d87'
const BOT_ID = '000000000000000000000b87'
const USER_ID = '000000000000000000000487'
const SYMBOL = 'SYNUSDT'
const PRICE = 2500

let Combo: any

type Raised = {
  closed: Array<{ dealId: string; closeType: string; reopen: boolean }>
  created: string[]
  sent: any[]
  errors: string[]
}

/**
 * @param balances what the account holds: quote only reproduces production,
 *   holding base lets a spot short size its entry.
 * @param orders the order rows the engine holds for the deal.
 */
const buildBot = (
  opts: {
    balances?: Array<{ asset: string; free: number; locked: number }>
    orders?: any[]
    dealStatus?: DCADealStatusEnum
  } = {},
) => {
  const {
    balances = [{ asset: 'USDT', free: 20000, locked: 0 }],
    orders = [],
    dealStatus = DCADealStatusEnum.start,
  } = opts
  const raised: Raised = { closed: [], created: [], sent: [], errors: [] }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      userId: USER_ID,
      status: dealStatus,
      symbol: { symbol: SYMBOL, baseAsset: 'SYN', quoteAsset: 'USDT' },
      createTime: 1789045823507,
      settings: { useDca: true },
      // A spot short that already holds the coin it sells.
      action: undefined,
      sizes: undefined,
    },
    initialOrders: [],
    currentOrders: [],
    previousOrders: [],
  }
  class TestBot extends Combo {
    math = new MathHelper()
    botId = BOT_ID
    userId = USER_ID
    botType = BotType.combo
    exchange = {} as any
    log = false
    hedge = false
    feeOrder = false
    useCompountReduce = false
    data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.paperKucoin,
      paperContext: true,
      flags: [],
      settings: { name: 'combo', pair: [SYMBOL], futures: false },
    }
    db = { updateData: async () => undefined } as any
    dealsDb = { updateData: async () => undefined } as any
    ordersDb = { createData: async () => undefined } as any
    // A field on the base class, so a getter here would be shadowed.
    isLong = false
    get futures() {
      return false
    }
    get coinm() {
      return false
    }
    shouldProceed() {
      return false
    }
    async getAggregatedSettings() {
      return {
        type: 'regular',
        futures: false,
        coinm: false,
        strategy: StrategyEnum.short,
        orderSizeType: OrderSizeTypeEnum.percTotal,
        baseOrderSize: '5',
        useDca: true,
      }
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 2,
        maxOrders: 500,
        baseAsset: { name: 'SYN', minAmount: 0.0001, step: 0.0001 },
        quoteAsset: { name: 'USDT', minAmount: 0.1, step: 0.01 },
      }
    }
    async baseAssetPrecision() {
      return 4
    }
    async getUserFee() {
      return { maker: 0.001, taker: 0.001 }
    }
    async getLatestPrice() {
      return PRICE
    }
    async getBalancesFromExchange() {
      return { status: StatusEnum.ok, data: balances }
    }
    /** The real one writes the row BEFORE the entry exists — kept. */
    async createDeal() {
      raised.created.push(DEAL_ID)
      return DEAL_ID
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return orders
    }
    async closeDealById(
      _botId: string,
      dealId: string,
      closeType: string,
      reopen: boolean,
    ) {
      raised.closed.push({ dealId, closeType, reopen })
    }
    async sendOrderToExchange(order: any) {
      raised.sent.push({ ...order })
      return { ...order }
    }
    async refuseDealBelowExchangeMin() {
      return false
    }
    getOrderId(prefix: string) {
      return `${prefix}-0000000000000000000000000187`
    }
    updateDealLastPrices() {}
    saveDeal() {}
    setOrder() {}
    resetPending() {}
    async handleErrors(e: string, ..._rest: unknown[]) {
      raised.errors.push(e)
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new (TestBot as any)()
  bot.raised = raised
  return bot
}

const restingBaseOrder = (status: string) =>
  ({
    symbol: SYMBOL,
    orderId: '-1',
    clientOrderId: 'CMB-BO-0000000000000000000000000187',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    type: OrderTypeEnum.market,
    side: 'SELL',
    price: `${PRICE}`,
    origQty: '0.4',
    executedQty: '0',
    status,
  }) as any

describe('a Combo base order that cannot be built strands the deal in start (spec 187)', () => {
  before(function () {
    // One ts-node compile of the combo mixin over the base.
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  it('§1.2 a deal it just created is cancelled, not left in start', async () => {
    const bot = buildBot()
    await bot.placeBaseOrder(BOT_ID, SYMBOL)
    const raised = bot.raised as Raised
    expect(raised.created, 'deal row written').to.deep.equal([DEAL_ID])
    expect(raised.sent, 'nothing reached the venue').to.have.length(0)
    expect(raised.closed, 'deal retired').to.have.length(1)
    expect(raised.closed[0].dealId).to.equal(DEAL_ID)
    expect(raised.closed[0].closeType).to.equal(CloseDCATypeEnum.cancel)
    // Re-opening would re-enter this same call for the same symbol.
    expect(raised.closed[0].reopen, 'not reopened').to.equal(false)
  })

  it('§4.2 the restoreWork replay heals a deal already stranded', async () => {
    const bot = buildBot()
    await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
    const raised = bot.raised as Raised
    expect(raised.created, 'no second deal row').to.have.length(0)
    expect(raised.closed, 'deal retired').to.have.length(1)
    expect(raised.closed[0].dealId).to.equal(DEAL_ID)
  })

  it('§4.4 the reason is still reported, and only once', async () => {
    const bot = buildBot()
    await bot.placeBaseOrder(BOT_ID, SYMBOL)
    const raised = bot.raised as Raised
    expect(raised.errors, 'one report').to.deep.equal([
      'Asset SYN not found in user balances',
    ])
  })

  it('§4.3 a deal that already holds an order row is left alone', async () => {
    for (const status of ['CANCELED', 'FILLED']) {
      const bot = buildBot({ orders: [restingBaseOrder(status)] })
      await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
      expect((bot.raised as Raised).closed, status).to.have.length(0)
    }
  })

  it('§4.3 a deal that is not in start is left alone', async () => {
    const bot = buildBot({ dealStatus: DCADealStatusEnum.open })
    await bot.placeBaseOrder(BOT_ID, SYMBOL, DEAL_ID)
    expect((bot.raised as Raised).closed).to.have.length(0)
  })

  it('§5 an entry that CAN be built is sent, and nothing is retired', async () => {
    const bot = buildBot({
      balances: [
        { asset: 'USDT', free: 20000, locked: 0 },
        { asset: 'SYN', free: 8, locked: 0 },
      ],
    })
    await bot.placeBaseOrder(BOT_ID, SYMBOL)
    const raised = bot.raised as Raised
    expect(raised.errors).to.deep.equal([])
    expect(raised.sent, 'order sent').to.have.length(1)
    expect(raised.sent[0].typeOrder).to.equal(TypeOrderEnum.dealStart)
    expect(raised.closed, 'nothing retired').to.have.length(0)
  })
})
