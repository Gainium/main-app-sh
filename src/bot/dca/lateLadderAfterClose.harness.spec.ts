process.env.NODE_ENV = 'testing'

/**
 * A ladder rebuilt while the deal was closing must not reach the venue.
 *
 * Production shape (a webhook-closed spot short): the close cancels the deal's
 * orders, and one safety order comes back CANCELED carrying a part-fill.
 * `updateDeal` books that fill under its OWN lock, rebuilds the ladder — a new
 * full-size take-profit included — and queues `placeOrders` behind the close.
 * By the time it gets the deal lock the closing market order has filled, but
 * the deal is still `open` until `closeDeal` finishes, and a signal close arms
 * neither `closeBySl` nor `closeByTp`. The fresh limit TP crossed the book and
 * bought the position back a second time.
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

const DEAL_ID = '000000000000000000000dc1'
const BOT_ID = '000000000000000000000bc1'
const SYMBOL = 'COMP-USD'

/** The market close that already filled — sized for the whole position. */
const filledClose = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId: 'D-TP-close0000000001',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealTP,
    type: 'MARKET',
    side: 'BUY',
    price: '24.37',
    origPrice: '24.37',
    origQty: '35.30747126',
    executedQty: '35.30747126',
    status: 'FILLED',
    sl: true,
    ...over,
  }) as any

/** A safety order still resting further up the ladder. */
const restingSo = () =>
  ({
    symbol: SYMBOL,
    clientOrderId: 'D-RO-resting00000001',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    type: 'LIMIT',
    side: 'SELL',
    price: '28.5',
    origPrice: '28.5',
    origQty: '40',
    executedQty: '0',
    status: 'NEW',
  }) as any

/** The take-profit the rebuilt ladder carries. */
const rebuiltTp = () => ({
  number: 0,
  price: 24.73,
  qty: 34.91694948,
  side: OrderSideEnum.buy,
  newClientOrderId: 'D-TP-rebuilt00000001',
  type: TypeOrderEnum.dealTP,
  dealId: DEAL_ID,
})

class FakeBase {
  botId = BOT_ID
  botType = 'dca'
  hyperliquid = false
  data: any = {
    status: BotStatusEnum.open,
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.kraken,
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  opts: {
    filled?: any[]
    resting?: any[]
    dealStatus?: DCADealStatusEnum
    useMultiTp?: boolean
  } = {},
) => {
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: opts.dealStatus ?? DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL },
      settings: {},
      tpSlTargetFilled: [],
    },
    closeBySl: false,
    closeByTp: false,
  }
  class TestBot extends Helper {
    sent: any[] = []
    cancelled: any[] = []
    logs: string[] = []
    filled: any[] = opts.filled ?? []
    resting: any[] = opts.resting ?? []
    exchange: any = {}
    orders = new Map()
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    ordersInBetweenUpdates = new Set<string>()
    futures = false
    hedge = false
    isLong = false
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
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
        baseAsset: { name: 'COMP', minAmount: 0.01, step: 0.00000001 },
        quoteAsset: { name: 'USD', minAmount: 1 },
        priceAssetPrecision: 2,
      }
    }
    async getAggregatedSettings() {
      return { useMultiTp: !!opts.useMultiTp }
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

const place = (bot: any, opts?: { afterTerminalCloseRefusal?: boolean }) =>
  bot.placeOrdersHoldingDealLock(
    BOT_ID,
    SYMBOL,
    DEAL_ID,
    { new: [rebuiltTp()], cancel: [] },
    opts,
  )

describe('a ladder rebuilt during a close is not placed', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('places nothing once the closing take-profit has filled, and pulls the resting ladder', async () => {
    const bot = buildBot({ filled: [filledClose()], resting: [restingSo()] })
    await place(bot)
    expect(bot.sent, bot.logs.join('\n')).to.have.length(0)
    expect(bot.cancelled).to.deep.equal(['D-RO-resting00000001'])
  })

  it('places nothing into a deal already marked closed', async () => {
    const bot = buildBot({ dealStatus: DCADealStatusEnum.closed })
    await place(bot)
    expect(bot.sent, bot.logs.join('\n')).to.have.length(0)
  })

  it('still places when no take-profit has filled', async () => {
    const bot = buildBot()
    await place(bot)
    expect(bot.sent, bot.logs.join('\n')).to.have.length(1)
    expect(bot.sent[0].order.type).to.equal(TypeOrderEnum.dealTP)
  })

  it('still places when the filled take-profit sold only part of its size', async () => {
    const bot = buildBot({
      filled: [filledClose({ executedQty: '10' })],
    })
    await place(bot)
    expect(bot.sent, bot.logs.join('\n')).to.have.length(1)
  })

  it('still places on a multi-TP deal, where one filled target is not a close', async () => {
    const bot = buildBot({ filled: [filledClose()], useMultiTp: true })
    await place(bot)
    expect(bot.sent, bot.logs.join('\n')).to.have.length(1)
  })

  it('does not block the refused-close restore (spec 083)', async () => {
    const bot = buildBot({ filled: [filledClose()] })
    await place(bot, { afterTerminalCloseRefusal: true })
    expect(bot.sent, bot.logs.join('\n')).to.have.length(1)
  })
})
