process.env.NODE_ENV = 'testing'

/**
 * Spec `095` — a take-profit cancelled off the venue with nothing filled, by
 * someone other than this bot, is put back without waiting for a restart.
 *
 * Drives the real `processCanceledOrder` / `restoreCanceledTp` off the DCA
 * helper over a fake base, and the real `cancelOrderOnExchange` off `MainBot`'s
 * prototype for the write-ahead record of our own cancels.
 *
 * Fixture ids are synthetic.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  decideCanceledTpRestore,
  isUnattributedUnfilledTpCancel,
  CanceledTpRestoreInputs,
} from './canceledTpRestore'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d95'
const BOT_ID = '000000000000000000000b95'
const SYMBOL = 'CC-USDC'
const TP_ID = 'D-TP-00000000000000000000000000095'

const canceledTp = (over: Record<string, unknown> = {}) =>
  ({
    symbol: SYMBOL,
    orderId: '95',
    clientOrderId: TP_ID,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealTP,
    type: 'LIMIT',
    side: 'SELL',
    price: '0.2',
    origPrice: '0.2',
    origQty: '16042',
    executedQty: '0',
    status: 'CANCELED',
    updateTime: 1789622847772,
    ...over,
  }) as any

const plannedTp = () => ({
  number: 0,
  price: 0.2,
  qty: 16042,
  side: OrderSideEnum.sell,
  newClientOrderId: TP_ID,
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
    exchange: ExchangeEnum.hyperliquidLinear,
    paperContext: false,
  }
  proceed = true
  shouldProceed() {
    return this.proceed
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any
const bots: any[] = []

const buildBot = (
  opts: {
    ownCancels?: string[]
    resting?: any[]
    dealStatus?: DCADealStatusEnum
    currentOrders?: any[]
    realPlace?: boolean
  } = {},
) => {
  const placed: any[] = []
  const tpRecorded: any[] = []
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
    currentOrders: opts.currentOrders ?? [plannedTp()],
  }
  let n = 0
  class TestBot extends Helper {
    placed = placed
    tpRecorded = tpRecorded
    resting: any[] = opts.resting ?? []
    marketClose = false
    blockCheck = false
    serviceRestart = false
    own = new Set(opts.ownCancels ?? [])
    isOwnCancel(id: string) {
      return this.own.has(id)
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return this.resting
    }
    async isDealForTPLevelCheck() {
      return this.marketClose
    }
    getOrderId(prefix: string) {
      n += 1
      return `${prefix}-fresh${n}`
    }
    async placeOrdersHoldingDealLock(
      _b: string,
      symbol: string,
      dealId: string,
      orders: { new: any[]; cancel: any[] },
    ) {
      if (opts.realPlace) {
        return super.placeOrdersHoldingDealLock(_b, symbol, dealId, orders)
      }
      placed.push({ symbol, dealId, ...orders })
    }
    // --- only reached with `realPlace`: the real placement, venue stubbed ---
    sent: any[] = []
    exchange: any = {}
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    futures = false
    hedge = false
    isLong = true
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        baseAsset: { name: 'CC', minAmount: 1, step: 1 },
        quoteAsset: { name: 'USDC', minAmount: 1 },
        priceAssetPrecision: 4,
      }
    }
    async getAggregatedSettings() {
      return { useMultiTp: false }
    }
    getOrderFromMap(id: string) {
      return this.resting.find((o) => o.clientOrderId === id)
    }
    ordersInBetweenUpdates = new Set<string>()
    // MainBot's bulk-placement filter; a take-profit is never batched.
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
    async updatePartiallyFilledTP(o: any) {
      tpRecorded.push(o)
    }
    logs: string[] = []
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
  const bot: any = new TestBot()
  bot.deal = deal
  bots.push(bot)
  return bot
}

describe('an unfilled take-profit cancelled off the venue is put back (spec 095)', () => {
  describe('§4.1 §4.2 which cancels open a restore', () => {
    it('an unfilled cancel we did not issue does', () => {
      for (const executedQty of ['0', 0, '0.00000000']) {
        expect(
          isUnattributedUnfilledTpCancel({
            executedQty,
            ownCancel: false,
            dealId: DEAL_ID,
          }),
          `${executedQty}`,
        ).to.equal(true)
      }
    })
    it('our own cancel, a filled cancel or an unreadable quantity does not', () => {
      expect(
        isUnattributedUnfilledTpCancel({
          executedQty: '0',
          ownCancel: true,
          dealId: DEAL_ID,
        }),
      ).to.equal(false)
      for (const executedQty of ['1.5', 'abc', undefined, null]) {
        expect(
          isUnattributedUnfilledTpCancel({
            executedQty,
            ownCancel: false,
            dealId: DEAL_ID,
          }),
          `${executedQty}`,
        ).to.equal(executedQty === null)
      }
      expect(
        isUnattributedUnfilledTpCancel({
          executedQty: '0',
          ownCancel: false,
          dealId: '',
        }),
      ).to.equal(false)
    })
  })

  describe('§4.4 §4.5 the decision under the deal lock', () => {
    const ok: CanceledTpRestoreInputs = {
      proceed: true,
      botStatus: BotStatusEnum.open,
      dealStatus: DCADealStatusEnum.open,
      closing: false,
      marketClose: false,
      reconcileRunning: false,
      restingTp: 0,
      plannedTp: 1,
    }
    it('places when the open deal has nothing resting and a TP planned', () => {
      expect(decideCanceledTpRestore(ok).action).to.equal('place')
      expect(
        decideCanceledTpRestore({ ...ok, botStatus: BotStatusEnum.range })
          .action,
      ).to.equal('place')
    })
    it('skips every case where the deal does not provably need it', () => {
      const skips: Partial<CanceledTpRestoreInputs>[] = [
        { proceed: false },
        { botStatus: BotStatusEnum.closed },
        { botStatus: BotStatusEnum.archive },
        { dealStatus: undefined },
        { dealStatus: DCADealStatusEnum.closed },
        { dealStatus: DCADealStatusEnum.canceled },
        { dealStatus: DCADealStatusEnum.start },
        { closing: true },
        { marketClose: true },
        { restingTp: 1 },
        { plannedTp: 0 },
      ]
      for (const s of skips) {
        expect(
          decideCanceledTpRestore({ ...ok, ...s }).action,
          JSON.stringify(s),
        ).to.equal('skip')
      }
    })
    it('defers while a reconcile owns the book', () => {
      expect(
        decideCanceledTpRestore({ ...ok, reconcileRunning: true }).action,
      ).to.equal('defer')
    })
  })

  describe('the engine', () => {
    before(function () {
      // One ts-node compile of a 25k-line module.
      this.timeout(180000)
      Helper = loadModule('../dcaHelper').default(FakeBase as any)
    })
    afterEach(() => {
      for (const b of bots.splice(0)) {
        for (const t of b.canceledTpRestoreTimers?.values() ?? []) {
          clearTimeout(t)
        }
      }
    })

    it('§1.1 an external unfilled TP cancel re-places the planned TP, fresh id', async () => {
      const bot = buildBot()
      await bot.processCanceledOrder(canceledTp(), 1789622847772, false)
      expect(
        bot.canceledTpRestoreTimers?.has(DEAL_ID),
        'a restore is scheduled',
      ).to.equal(true)
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(bot.placed).to.have.length(1)
      const [p] = bot.placed
      expect(p.dealId).to.equal(DEAL_ID)
      expect(p.symbol).to.equal(SYMBOL)
      expect(p.cancel).to.deep.equal([])
      expect(p.new).to.have.length(1)
      expect(p.new[0].qty).to.equal(16042)
      expect(p.new[0].price).to.equal(0.2)
      expect(p.new[0].type).to.equal(TypeOrderEnum.dealTP)
      expect(p.new[0].newClientOrderId).to.not.equal(TP_ID)
      expect(p.new[0].newClientOrderId.startsWith('D-TP-')).to.equal(true)
      // The plan itself is not rewritten.
      expect(bot.deal.currentOrders[0].newClientOrderId).to.equal(TP_ID)
    })

    it('§1.1 end to end: the real placeOrders sends the TP to the venue', async () => {
      const bot = buildBot({ realPlace: true })
      await bot.processCanceledOrder(canceledTp(), 1789622847772, false)
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(bot.sent, bot.logs.join('\n')).to.have.length(1)
      const [{ order, options }] = bot.sent
      expect(order.type).to.equal(TypeOrderEnum.dealTP)
      expect(order.side).to.equal(OrderSideEnum.sell)
      expect(order.qty).to.equal(16042)
      expect(order.price).to.equal(0.2)
      expect(order.newClientOrderId).to.not.equal(TP_ID)
      expect(options.dealId).to.equal(DEAL_ID)
      expect(options.type).to.equal('LIMIT')
    })

    it('§4.1 a cancel this bot issued schedules nothing', async () => {
      const bot = buildBot({ ownCancels: [TP_ID] })
      await bot.processCanceledOrder(canceledTp(), 1789622847772, false)
      expect(bot.canceledTpRestoreTimers?.has(DEAL_ID) ?? false).to.equal(false)
      expect(bot.placed).to.have.length(0)
    })

    it('§4.2 a cancel carrying fills keeps the partial-TP path only', async () => {
      const bot = buildBot()
      await bot.processCanceledOrder(
        canceledTp({ executedQty: '100' }),
        1789622847772,
        false,
      )
      expect(bot.tpRecorded).to.have.length(1)
      expect(bot.canceledTpRestoreTimers?.has(DEAL_ID) ?? false).to.equal(false)
    })

    it('§4.4 places nothing while any TP is resting for the deal', async () => {
      const bot = buildBot({
        resting: [canceledTp({ clientOrderId: 'D-TP-other', status: 'NEW' })],
      })
      await bot.processCanceledOrder(canceledTp(), 1789622847772, false)
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(bot.placed).to.have.length(0)
    })

    it('§4.4 places nothing once the deal is closing or closes by market', async () => {
      const closing = buildBot()
      closing.deal.closeByTp = true
      await closing.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(closing.placed).to.have.length(0)
      const market = buildBot()
      market.marketClose = true
      await market.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(market.placed).to.have.length(0)
    })

    it('§4.6 skips targets the deal has already filled', async () => {
      const bot = buildBot({
        currentOrders: [
          { ...plannedTp(), tpSlTarget: 'a' },
          { ...plannedTp(), tpSlTarget: 'b', qty: 5 },
        ],
      })
      bot.deal.deal.tpSlTargetFilled = ['a']
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(bot.placed).to.have.length(1)
      expect(bot.placed[0].new.map((g: any) => g.tpSlTarget)).to.deep.equal([
        'b',
      ])
      expect(
        bot.placed[0].new[0].newClientOrderId.startsWith('D-MTP-'),
      ).to.equal(true)
    })

    it('§4.5 defers while an orders check holds the book, then places', async () => {
      const bot = buildBot()
      bot.blockCheck = true
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 0)
      expect(bot.placed).to.have.length(0)
      expect(bot.canceledTpRestoreTimers.has(DEAL_ID), 're-armed').to.equal(
        true,
      )
      bot.blockCheck = false
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 1)
      expect(bot.placed).to.have.length(1)
    })

    it('§4.5 gives up after the deferral budget', async () => {
      const bot = buildBot()
      bot.serviceRestart = true
      await bot.restoreCanceledTp(BOT_ID, DEAL_ID, 1000)
      expect(bot.placed).to.have.length(0)
      expect(bot.canceledTpRestoreTimers.has(DEAL_ID)).to.equal(false)
    })
  })

  describe('§4.1 MainBot records its own cancel before the venue call', () => {
    let MainBot: any
    before(function () {
      this.timeout(180000)
      MainBot = loadModule('../main').default
    })

    it('the id is recorded when the venue is asked, and survives the answer', async () => {
      const bot: any = Object.create(MainBot.prototype)
      bot.ownCancels = new Map()
      bot.startMethod = () => '1'
      bot.endMethod = () => undefined
      bot.emit = () => true
      bot.setOrder = () => undefined
      bot.deleteOrder = () => undefined
      bot.updateOrderOnDb = () => undefined
      bot.data = { exchange: ExchangeEnum.hyperliquidLinear }
      bot.orders = new Map()
      let recordedAtCall: boolean | undefined
      bot.exchange = {
        cancelOrder: async () => {
          recordedAtCall = bot.isOwnCancel(TP_ID)
          return {
            status: StatusEnum.ok,
            data: { ...canceledTp(), updateTime: 1 },
          }
        },
      }
      expect(bot.isOwnCancel(TP_ID)).to.equal(false)
      await bot.cancelOrderOnExchange(canceledTp({ status: 'NEW' }))
      expect(recordedAtCall, 'recorded before the venue answered').to.equal(
        true,
      )
      expect(bot.isOwnCancel(TP_ID)).to.equal(true)
      expect(bot.isOwnCancel('D-TP-someone-else')).to.equal(false)
    })
  })
})
