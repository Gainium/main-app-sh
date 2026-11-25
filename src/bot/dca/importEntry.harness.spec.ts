process.env.NODE_ENV = 'testing'

/**
 * Spec `specs/262.terminal-import-with-unusable-size-books-an-empty-position`.
 *
 * Drives the REAL `dcaHelper` — `getBaseOrder` (import branch), `startDeal`
 * and `getAvgPrice` (futures fold, through `MainBot.calculateAbstractPosition`)
 * — on a minimal base class. No stack, DB, Redis or exchange is touched.
 *
 * The rows are the shapes production wrote: a linear futures import of 10 USDT
 * at 77461.4 with a 0.001 step (row qty "0"), and an inverse import priced 0
 * (row qty "NaN").
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'
import MainBot from '../main'

const DEAL_ID = 'deal-import'
const SYMBOL = 'BTCUSDT'

const linearSettings = (over: Record<string, unknown> = {}): any => ({
  type: 'terminal',
  terminalDealType: 'import',
  futures: true,
  coinm: false,
  strategy: 'LONG',
  orderSizeType: 'quote',
  baseOrderSize: '10',
  baseOrderPrice: '77461.4',
  leverage: 10,
  useDca: false,
  indicators: [],
  ...over,
})

const linearEd = {
  pair: SYMBOL,
  baseAsset: { name: 'BTC', minAmount: 0.001, step: 0.001 },
  quoteAsset: { name: 'USDT', minAmount: 5 },
  priceAssetPrecision: 1,
}
const inverseEd = {
  pair: 'XBTUSDM',
  baseAsset: { name: 'XBT', minAmount: 1, step: 1 },
  quoteAsset: { name: 'USD', minAmount: 1 },
  priceAssetPrecision: 1,
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  combo = false
  isBitget = false
  botType = 'dca'
  exchange = {}
  orders = []
  data: any
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Opts = {
  settings: any
  ed: any
  precision: number
  coinm?: boolean
  rows?: any[]
  deal?: any
}

const buildBot = (o: Opts) => {
  const rows = o.rows ?? []
  class TestBot extends Helper {
    public refusals: string[] = []
    public closed: any[] = []
    public logs: string[] = []
    public laddered = 0
    full = o.deal
      ? {
          deal: o.deal,
          initialOrders: [],
          currentOrders: [],
          previousOrders: [],
        }
      : undefined
    getDeal(id: string) {
      return id === DEAL_ID ? this.full : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const wanted = status ? [status].flat() : undefined
      return rows.filter(
        (r) =>
          (!dealId || r.dealId === dealId) &&
          (!wanted || wanted.includes(r.status)),
      )
    }
    async getAggregatedSettings() {
      return o.settings
    }
    async getUserFee() {
      return { maker: 0.0002, taker: 0.0005 }
    }
    async getExchangeInfo() {
      return o.ed
    }
    async baseAssetPrecision() {
      return o.precision
    }
    async checkAssets() {
      return new Map()
    }
    getOrderId(p: string) {
      return `${p}-x`
    }
    calculateAbstractPosition(...a: any[]) {
      return (MainBot.prototype as any).calculateAbstractPosition.apply(this, a)
    }
    async reportUserRefusal(reason: string) {
      this.refusals.push(reason)
    }
    async closeDealById(...a: any[]) {
      this.closed.push(a)
    }
    async createInitialDealOrders() {
      this.laddered++
      return []
    }
    onEntryBaseFilled() {}
    async clearDealTimer() {}
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.data = {
    settings: o.settings,
    exchange: ExchangeEnum.bybitUsdm,
    exchangeUUID: 'uuid',
    flags: [],
    paperContext: true,
  }
  for (const [k, v] of Object.entries({
    futures: true,
    coinm: !!o.coinm,
    isLong: true,
    hedge: false,
  })) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }
  return bot
}

const row = (over: Record<string, unknown>): any => ({
  clientOrderId: 'D-BO-x',
  orderId: '-1',
  dealId: DEAL_ID,
  symbol: SYMBOL,
  typeOrder: 'dealStart',
  status: 'FILLED',
  side: 'BUY',
  price: '77461.4',
  origPrice: '77461.4',
  origQty: '0',
  executedQty: '0',
  updateTime: 1,
  ...over,
})

describe('terminal import with an unusable size (spec 262)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§1.2.1/§1.3.1 linear: a size below one step builds no FILLED row and tells the user', async () => {
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
    })
    const order = await bot.getBaseOrder(SYMBOL, DEAL_ID)
    expect(order).to.equal(undefined)
    expect(bot.refusals).to.have.length(1)
    expect(bot.refusals[0]).to.contain('10 USDT')
  })

  it('§1.3.1 a sizing read with no deal (balance/minimum checks) answers nothing and says nothing', async () => {
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
    })
    expect(await bot.getBaseOrder(SYMBOL)).to.equal(undefined)
    expect(bot.refusals).to.have.length(0)
  })

  it('§1.2.2/§1.3.1 inverse: a price of 0 builds no FILLED row and tells the user', async () => {
    const bot = buildBot({
      settings: linearSettings({
        coinm: true,
        baseOrderPrice: '0',
        baseOrderSize: '1.38',
      }),
      ed: inverseEd,
      precision: 0,
      coinm: true,
    })
    const order = await bot.getBaseOrder('XBTUSDM', DEAL_ID)
    expect(order).to.equal(undefined)
    expect(bot.refusals).to.have.length(1)
  })

  it('§1.4 a usable import writes the same synthetic row as before', async () => {
    const bot = buildBot({
      settings: linearSettings({ baseOrderSize: '1000' }),
      ed: linearEd,
      precision: 3,
    })
    const order = await bot.getBaseOrder(SYMBOL, DEAL_ID)
    expect(order).to.include({
      status: 'FILLED',
      orderId: '-1',
      origQty: '0.012',
      executedQty: '0.012',
      price: '77461.4',
      typeOrder: 'dealStart',
    })
    expect(bot.refusals).to.have.length(0)
  })

  it('§1.3.1 placeBaseOrder retires the deal and never falls through to a real order', async () => {
    const deal: any = {
      _id: DEAL_ID,
      status: 'start',
      symbol: { symbol: SYMBOL },
    }
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
      deal,
    })
    const sent: any[] = []
    bot.shouldProceed = () => true
    bot.sendOrderToExchange = async (...a: any[]) => sent.push(a)
    bot.setOrder = (o: any) => sent.push(o)
    bot.ordersDb = { createData: (o: any) => sent.push(o) }
    bot.createDeal = async () => DEAL_ID
    await bot.placeBaseOrder('bot', SYMBOL)
    expect(sent).to.have.length(0)
    expect(bot.refusals).to.have.length(1)
    expect(bot.closed).to.have.length(1)
    expect(bot.closed[0].slice(1, 4)).to.deep.equal([DEAL_ID, 'cancel', false])
  })

  it('§1.3.2 startDeal on a stored 0-quantity import row retires the deal instead of opening it', async () => {
    const deal: any = {
      _id: DEAL_ID,
      status: 'start',
      symbol: { symbol: SYMBOL },
    }
    const stored = row({})
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
      rows: [stored],
      deal,
    })
    await bot.startDeal(stored)
    expect(deal.status).to.equal('start')
    expect(bot.laddered).to.equal(0)
    expect(bot.closed).to.have.length(1)
    expect(bot.closed[0][1]).to.equal(DEAL_ID)
    expect(bot.closed[0][2]).to.equal('cancel')
  })

  it('§1.3.3 futures average skips a 0 entry row and stays finite', async () => {
    const rows = [
      row({ updateTime: 1 }),
      row({
        clientOrderId: 'so1',
        typeOrder: 'dealRegular',
        orderId: '11',
        price: '66563.4',
        origQty: '0.001',
        executedQty: '0.001',
        updateTime: 2,
      }),
      row({
        clientOrderId: 'so2',
        typeOrder: 'dealRegular',
        orderId: '12',
        price: '65891.1',
        origQty: '0.001',
        executedQty: '0.001',
        updateTime: 3,
      }),
    ]
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
      rows,
    })
    const { avg, display } = await bot.getAvgPrice(DEAL_ID)
    expect(avg).to.be.closeTo(66227.25, 0.1)
    expect(display).to.equal(avg)
  })

  it('§1.3.3 a fold with nothing that moved a position is 0, never NaN', async () => {
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
      rows: [row({ origQty: 'NaN', executedQty: 'NaN' })],
    })
    expect(await bot.getAvgPrice(DEAL_ID)).to.deep.equal({ avg: 0, display: 0 })
  })

  it('§1.4 a fold whose entries all moved something is unchanged', async () => {
    const rows = [
      row({ origQty: '0.002', executedQty: '0.002', updateTime: 1 }),
      row({
        clientOrderId: 'so1',
        typeOrder: 'dealRegular',
        orderId: '11',
        price: '66563.4',
        origQty: '0.001',
        executedQty: '0.001',
        updateTime: 2,
      }),
    ]
    const bot = buildBot({
      settings: linearSettings(),
      ed: linearEd,
      precision: 3,
      rows,
    })
    const { avg } = await bot.getAvgPrice(DEAL_ID)
    expect(avg).to.be.closeTo((0.002 * 77461.4 + 0.001 * 66563.4) / 0.003, 0.1)
  })
})
