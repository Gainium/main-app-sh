process.env.NODE_ENV = 'testing'

/**
 * Main-app spec 048 §3.2 — a combo grid line whose cancel finds it FILLED is
 * not placed again at its re-sized quantity.
 *
 * Production shape (local paper E2E, futures long): three exit sells of one
 * minigrid filled on one tick. Processing the first, the ladder re-sized the
 * other two; the diff cancelled them (the venue had already filled them) and
 * placed the re-sized copies, which filled too: their base was sold twice.
 *
 * Drives the real `placeOrdersHoldingDealLock` off the DCA helper over a fake
 * base, venue stubbed. Fixture ids are synthetic.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d49'
const BOT_ID = '000000000000000000000b49'
const SYMBOL = 'ETHUSDT'
const MG = '000000000000000000000a49'

const line = (
  id: string,
  price: number,
  qty: number,
  side = OrderSideEnum.sell,
) => ({
  number: 1,
  price,
  qty,
  side,
  newClientOrderId: id,
  type: TypeOrderEnum.dealGrid,
  dealId: DEAL_ID,
  minigridId: MG,
})

/** The re-size of one resting sell, and the counter-order of the fill. */
const diff = () => ({
  cancel: [line('CMB-GR-resting00000001', 2406.5, 0.02)],
  new: [
    line('CMB-GR-resized00000001', 2406.5, 0.012),
    line('CMB-GR-counter00000001', 2403.78, 0.02, OrderSideEnum.buy),
  ],
})

class FakeBase {
  botId = BOT_ID
  botType = 'combo'
  hyperliquid = false
  data: any = {
    status: BotStatusEnum.open,
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.coinbase,
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const buildBot = (
  opts: {
    /** false: the cancel finds the line still resting. */
    filledOnCancel?: boolean
  } = {},
) => {
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL },
      settings: {},
      tpSlTargetFilled: [],
    },
    closeBySl: false,
    closeByTp: false,
  }
  class TestBot extends Helper {
    // On the subclass: the helper's own field would override the base's.
    botType = 'combo'
    sent: any[] = []
    cancelled: any[] = []
    logs: string[] = []
    filled: any[] = []
    resting: any[] = []
    released = false
    unknown: any[] = []
    exchange: any = {}
    orders = new Map()
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    ordersInBetweenUpdates = new Set<string>()
    futures = false
    hedge = false
    isLong = true
    getDeal(id?: string) {
      return id === DEAL_ID && !this.released ? deal : undefined
    }
    getOrdersByStatusAndDealId(q: { status?: string | string[] }) {
      if (q.status === 'FILLED') {
        return this.filled
      }
      return this.resting
    }
    getOrderFromMap(id: string) {
      return [...this.filled, ...this.resting].find(
        (o) => o.clientOrderId === id,
      )
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        baseAsset: { name: 'ABC', minAmount: 0.01, step: 0.01 },
        quoteAsset: { name: 'USDC', minAmount: 1 },
        priceAssetPrecision: 8,
      }
    }
    async getAggregatedSettings() {
      return {}
    }
    batchablePlacements() {
      return []
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange(order: any, options: any) {
      this.sent.push({ order, options })
      return { ...order, status: 'NEW' }
    }
    async cancelGridOnExchange(g: any) {
      this.cancelled.push(g.newClientOrderId)
      return {
        clientOrderId: g.newClientOrderId,
        typeOrder: g.type,
        side: g.side === OrderSideEnum.buy ? 'BUY' : 'SELL',
        price: `${g.price}`,
        origQty: `${g.qty}`,
        executedQty: opts.filledOnCancel === false ? '0' : `${g.qty}`,
        status: opts.filledOnCancel === false ? 'CANCELED' : 'FILLED',
      }
    }
    async handleUnknownOrder(o: any) {
      this.unknown.push(o.clientOrderId)
    }
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange(order: any) {
      this.cancelled.push(order.clientOrderId)
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug(m: string) {
      this.logs.push(m)
    }
    handleWarn(m: string) {
      this.logs.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot() as any
}

const loadModule = createRequire(__filename)
let Helper: any

const sentIds = (bot: any) => bot.sent.map((s: any) => s.order.newClientOrderId)

describe('combo grid line filled before its cancel is not re-placed (main-app spec 048 §3.2)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('books the fill and places only the counter-order', async () => {
    const bot = buildBot()
    await bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, diff())
    expect(bot.unknown).to.deep.equal(['CMB-GR-resting00000001'])
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([
      'CMB-GR-counter00000001',
    ])
  })

  it('a line that was still resting is re-placed at its new size', async () => {
    const bot = buildBot({ filledOnCancel: false })
    await bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, diff())
    expect(sentIds(bot)).to.have.members([
      'CMB-GR-resized00000001',
      'CMB-GR-counter00000001',
    ])
  })
})
