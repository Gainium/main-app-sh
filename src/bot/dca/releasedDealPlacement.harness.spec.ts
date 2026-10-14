process.env.NODE_ENV = 'testing'

/**
 * Spec `160`: a placement queued before a close must not place into the deal
 * once it is released, nor keep sending after the deal closes mid-burst.
 *
 * Production shape (spot, Coinbase): a safety-order fill queued a re-size
 * (one more safety order + a full-size take-profit) on the deal lock. The
 * deal's TP filled, `processDealClose` dropped the deal from memory and spent
 * minutes cancelling its ladder, then removed its order rows. The queued
 * re-size got the lock with nothing left to read, passed the closed-deal
 * pre-check, and its take-profit sold the next deal's coins.
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
  DCATypeEnum,
  ExchangeEnum,
  OrderSideEnum,
  TerminalDealTypeEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000dd1'
const BOT_ID = '000000000000000000000bd1'
const SYMBOL = 'ABC-USDC'

/** The take-profit that closed the deal, sold in full. */
const filledTp = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId: 'D-TP-filled000000001',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealTP,
    type: 'LIMIT',
    side: 'SELL',
    price: '0.0108',
    origPrice: '0.0108',
    origQty: '9000',
    executedQty: '9000',
    status: 'FILLED',
    ...over,
  }) as any

/** The re-size the safety-order fill queued: next level, then the TP. */
const queuedLadder = () => ({
  new: [
    {
      number: 5,
      price: 0.01,
      qty: 4000,
      side: OrderSideEnum.buy,
      newClientOrderId: 'D-RO-queued000000001',
      type: TypeOrderEnum.dealRegular,
      dealId: DEAL_ID,
    },
    {
      number: 0,
      price: 0.0107,
      qty: 12000,
      side: OrderSideEnum.sell,
      newClientOrderId: 'D-TP-queued000000001',
      type: TypeOrderEnum.dealTP,
      dealId: DEAL_ID,
    },
  ],
  cancel: [],
})

class FakeBase {
  botId = BOT_ID
  botType = 'dca'
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

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  opts: {
    released?: boolean
    /** Runs after the first send returns — the close landing mid-burst. */
    afterFirstSend?: (bot: any) => void
    terminalSimple?: boolean
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
    sent: any[] = []
    cancelled: any[] = []
    logs: string[] = []
    filled: any[] = []
    resting: any[] = []
    released = !!opts.released
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
      if (this.sent.length === 1) {
        opts.afterFirstSend?.(this)
      }
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
  const bot = new TestBot() as any
  if (opts.terminalSimple) {
    bot.data.settings.type = DCATypeEnum.terminal
    bot.data.settings.terminalDealType = TerminalDealTypeEnum.simple
  }
  return bot
}

const place = (bot: any, opts?: { afterTerminalCloseRefusal?: boolean }) =>
  bot.placeOrdersHoldingDealLock(
    BOT_ID,
    SYMBOL,
    DEAL_ID,
    queuedLadder(),
    opts,
  )

const sentIds = (bot: any) =>
  bot.sent.map((s: any) => s.order.newClientOrderId)

describe('spec 160 — a placement queued before a close', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§1.1 places nothing into a deal already released by its close', async () => {
    const bot = buildBot({ released: true })
    await place(bot)
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([])
  })

  it('§1.2 stops sending once the deal is released mid-burst', async () => {
    const bot = buildBot({
      afterFirstSend: (b) => {
        b.released = true
      },
    })
    await place(bot)
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([
      'D-RO-queued000000001',
    ])
    expect(bot.logs.join('\n')).to.include('D-TP-queued000000001')
  })

  it('§1.2 stops sending once the take-profit fills in full mid-burst', async () => {
    const bot = buildBot({
      afterFirstSend: (b) => {
        b.filled.push(filledTp())
      },
    })
    await place(bot)
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([
      'D-RO-queued000000001',
    ])
  })

  it('§1.3 still sends the rest after an underfilled take-profit (spec 027)', async () => {
    const bot = buildBot({
      afterFirstSend: (b) => {
        b.filled.push(filledTp({ executedQty: '100' }))
      },
    })
    await place(bot)
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([
      'D-RO-queued000000001',
      'D-TP-queued000000001',
    ])
  })

  it('§1.3 still sends the rest for the refused-close restore (spec 083)', async () => {
    const bot = buildBot({
      afterFirstSend: (b) => {
        b.filled.push(filledTp())
      },
    })
    await place(bot, { afterTerminalCloseRefusal: true })
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([
      'D-RO-queued000000001',
      'D-TP-queued000000001',
    ])
  })

  it('§1.3 a simple terminal deal is not affected', async () => {
    const bot = buildBot({ released: true, terminalSimple: true })
    await place(bot)
    expect(sentIds(bot), bot.logs.join('\n')).to.have.length(2)
  })

  it('places the whole ladder into an open deal', async () => {
    const bot = buildBot()
    await place(bot)
    expect(sentIds(bot), bot.logs.join('\n')).to.deep.equal([
      'D-RO-queued000000001',
      'D-TP-queued000000001',
    ])
  })
})
