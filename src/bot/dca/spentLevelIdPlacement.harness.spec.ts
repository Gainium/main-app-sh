process.env.NODE_ENV = 'testing'

/**
 * A safety-order level whose order the venue cancelled must be re-placed under
 * an id the venue has never seen, and a level that already has a live or
 * FILLED replacement must not be placed again.
 *
 * Production shape (Bybit spot short DCA): the level's order `…Jl65` came back
 * CANCELED with nothing filled. The next pass re-sent `…Jl65` itself; Bybit
 * refused the reused id, the duplicate branch re-sent it as `…Jl62`, which
 * filled. Under a second later pass the level still carried `…Jl65`, was sent
 * again, and only a colliding `…Jl62` kept the level from filling twice.
 *
 * Drives the real `placeOrdersHoldingDealLock` off the DCA helper over a fake
 * base. The fake venue refuses any client order id it has already accepted,
 * the way Bybit does. Fixture ids are synthetic.
 *
 * Enforces specs/161 §4.2, §4.3 and §1.4. Run: `npm test` (mocha).
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

const DEAL_ID = '000000000000000000000dd1'
const BOT_ID = '000000000000000000000bd1'
const SYMBOL = 'SHIBEUR'
const ORIGINAL = 'D-RO-spentlevel000000000000000Jl65'

const row = (clientOrderId: string, status: string, over: object = {}) =>
  ({
    symbol: SYMBOL,
    clientOrderId,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    type: 'LIMIT',
    side: 'SELL',
    price: '0.00000461',
    origPrice: '0.00000461',
    origQty: '1274156',
    executedQty: status === 'FILLED' ? '1274156' : '0',
    status,
    ...over,
  }) as any

/** The ladder level, as the deal carries it. */
const level = (newClientOrderId = ORIGINAL) => ({
  number: 1,
  price: 0.00000461,
  qty: 1274156,
  side: OrderSideEnum.sell,
  newClientOrderId,
  type: TypeOrderEnum.dealRegular,
  dealId: DEAL_ID,
})

class FakeBase {
  botId = BOT_ID
  botType = 'dca'
  hyperliquid = false
  data: any = {
    status: BotStatusEnum.open,
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.bybit,
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (opts: {
  rows: any[]
  venueSeen: string[]
  reissued?: [string, string][]
  fillOnPlace?: boolean
}) => {
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
  let minted = 0
  class TestBot extends Helper {
    placed: string[] = []
    refused: string[] = []
    logs: string[] = []
    venueSeen = new Set<string>(opts.venueSeen)
    exchange: any = {}
    orders = new Map<string, any>(
      [
        // The deal's filled base order keeps the map non-empty.
        row('D-BO-base000000000000000000000001', 'FILLED', {
          typeOrder: TypeOrderEnum.dealStart,
        }),
        ...opts.rows,
      ].map((o) => [o.clientOrderId, o]),
    )
    reissuedClientOrderIds = new Map<string, string>(opts.reissued ?? [])
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    ordersInBetweenUpdates = new Set<string>()
    futures = false
    hedge = false
    isLong = false
    combo = false
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId(q: {
      status?: string | string[]
      defaultStatuses?: boolean
    }) {
      const want = q.defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : Array.isArray(q.status)
          ? q.status
          : [q.status]
      return [...this.orders.values()].filter((o) => want.includes(o.status))
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    getOrderId(prefix: string) {
      minted++
      return `${prefix}-minted${String(minted).padStart(24, '0')}`
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        baseAsset: { name: 'SHIB', minAmount: 1, step: 1 },
        quoteAsset: { name: 'EUR', minAmount: 1 },
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
    /** Bybit: an id it has already accepted is refused, whatever its state. */
    async sendGridToExchange(order: any) {
      const id = order.newClientOrderId
      if (this.venueSeen.has(id)) {
        this.refused.push(id)
        return undefined
      }
      this.venueSeen.add(id)
      this.placed.push(id)
      const placed = row(id, opts.fillOnPlace ? 'FILLED' : 'NEW')
      this.orders.set(id, placed)
      return placed
    }
    processFilledOrder() {}
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async cancelOrderOnExchange() {}
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

const place = (bot: any, grids: any[]) =>
  bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, {
    new: grids,
    cancel: [],
  })

describe('a cancelled safety-order level is never re-sent under a spent id (spec 161)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.2 replays the cancel → re-place → fill → second pass: one placement, no refusal', async () => {
    const bot = buildBot({
      rows: [row(ORIGINAL, 'CANCELED')],
      venueSeen: [ORIGINAL],
      fillOnPlace: true,
    })
    const grid = level()
    await place(bot, [grid])
    expect(bot.placed, bot.logs.join('\n')).to.have.length(1)
    expect(bot.placed[0]).to.not.equal(ORIGINAL)
    expect(grid.newClientOrderId, 'the level keeps the id that is live').to.equal(
      bot.placed[0],
    )
    // A later pass whose ladder still carries the ORIGINAL id (a copy of the
    // level built before the re-placement) while the replacement has filled.
    await place(bot, [level()])
    expect(bot.placed, bot.logs.join('\n')).to.have.length(1)
    expect(bot.refused, bot.logs.join('\n')).to.deep.equal([])
  })

  it('§4.2 a live replacement also stops a second placement', async () => {
    const bot = buildBot({
      rows: [row(ORIGINAL, 'CANCELED')],
      venueSeen: [ORIGINAL],
    })
    await place(bot, [level()])
    await place(bot, [level()])
    expect(bot.placed, bot.logs.join('\n')).to.have.length(1)
    expect(bot.refused).to.deep.equal([])
  })

  it('§4.3 a replacement that was cancelled too is re-placed under another fresh id', async () => {
    const replacement = 'D-RO-spentlevel000000000000000Jl62'
    const bot = buildBot({
      rows: [row(ORIGINAL, 'CANCELED'), row(replacement, 'CANCELED')],
      venueSeen: [ORIGINAL, replacement],
      reissued: [[ORIGINAL, replacement]],
    })
    await place(bot, [level()])
    expect(bot.refused, bot.logs.join('\n')).to.deep.equal([])
    expect(bot.placed).to.have.length(1)
    expect([ORIGINAL, replacement]).to.not.include(bot.placed[0])
  })

  it('§1.4 a level never sent is sent under its own id', async () => {
    const bot = buildBot({ rows: [], venueSeen: [] })
    await place(bot, [level()])
    expect(bot.placed).to.deep.equal([ORIGINAL])
  })

  it('§1.4 a level whose order is live is skipped', async () => {
    const bot = buildBot({ rows: [row(ORIGINAL, 'NEW')], venueSeen: [ORIGINAL] })
    await place(bot, [level()])
    expect(bot.placed).to.deep.equal([])
    expect(bot.refused).to.deep.equal([])
  })
})
