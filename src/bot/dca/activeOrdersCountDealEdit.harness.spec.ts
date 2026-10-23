process.env.NODE_ENV = 'testing'

/**
 * A deal edit that changes only the number of active smart orders cancels
 * the levels it drops and places the levels it adds; the levels that stay on
 * the book and the take profit are not touched (spec 195).
 *
 * The save used to run the full `rebuildDealOrders`: cancel every order of
 * the deal and place the new ladder again — the kept levels at the very same
 * prices, after losing their place in the book.
 *
 * Drives the REAL `isActiveOrdersCountOnlyDealEdit`, `rebuildDealOrders`,
 * `updateDealSettings` and `findDiff`; the ladder generator and the exchange
 * boundary are stubbed. Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotType,
  DCADealStatusEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../../types'

const BOT_ID = '000000000000000000000b95'
const DEAL_ID = '000000000000000000000d95'
const SYMBOL = 'ETH-USDT'

let Helper: any

/** The whole form a client can send: every key, only some of them changed. */
const BOT_SETTINGS = {
  tpPerc: '2',
  useTp: true,
  ordersCount: 8,
  orderSize: '10',
  step: '1',
  stepScale: '1',
  volumeScale: '1',
  useDca: true,
  useSmartOrders: true,
  activeOrdersCount: 5,
  slPerc: '-10',
  useSl: false,
}

/** The deal's unfilled ladder, nearest level first (a long deal). */
const LADDER = [2900, 2800, 2700, 2600, 2500, 2400, 2300, 2200]
const QTY = 0.01

const restingRegular = (price: number, status = 'NEW') => ({
  clientOrderId: `D-RO-${price}`,
  dealId: DEAL_ID,
  symbol: SYMBOL,
  typeOrder: TypeOrderEnum.dealRegular,
  side: 'BUY',
  price: `${price}`,
  origQty: `${QTY}`,
  status,
})
const restingTp = {
  clientOrderId: 'D-TP-95',
  dealId: DEAL_ID,
  symbol: SYMBOL,
  typeOrder: TypeOrderEnum.dealTP,
  side: 'SELL',
  price: '3100',
  origQty: '0.02',
  status: 'NEW',
}

const buildBot = (
  resting: number,
  opts: { botType?: BotType; partial?: number } = {},
) => {
  const raised = {
    cancelled: [] as string[],
    cancelAll: [] as unknown[][],
    placedNew: [] as any[],
    placedCancel: [] as any[],
    resent: 0,
    rebuilt: [] as any[],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL },
      settings: { ...BOT_SETTINGS, activeOrdersCount: resting, avgPrice: 3000 },
      avgPrice: 3000,
      initialPrice: 3000,
      lastPrice: 2950,
      levels: { complete: 1, all: 9 },
    },
    initialOrders: [] as any[],
    currentOrders: [] as any[],
  }
  const orders: any[] = [
    restingTp,
    ...LADDER.slice(0, resting).map((p) =>
      restingRegular(p, p === opts.partial ? 'PARTIALLY_FILLED' : 'NEW'),
    ),
  ]
  const grid = (price: number) => ({
    price,
    qty: QTY,
    side: OrderSideEnum.buy,
    type: TypeOrderEnum.dealRegular,
    dealId: DEAL_ID,
    newClientOrderId: `new-${price}`,
  })
  class TestBot extends (Helper as any) {
    raised = raised
    botId = BOT_ID
    botType = opts.botType ?? BotType.dca
    data: any = { settings: { ...BOT_SETTINGS }, exchange: 'binance' }
    orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId({
      dealId,
      status,
    }: {
      dealId?: string
      status?: string | string[]
    }) {
      const statuses = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!statuses || statuses.includes(o.status)),
      )
    }
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push(o.clientOrderId)
      return undefined
    }
    async cancelAllOrder(...args: unknown[]) {
      raised.cancelAll.push(args)
    }
    async createInitialDealOrders() {
      return LADDER.map(grid)
    }
    /** The real slicing in short: the nearest `activeOrdersCount` levels. */
    async createCurrentDealOrders() {
      return [
        ...LADDER.slice(0, +deal.deal.settings.activeOrdersCount).map(grid),
        {
          type: TypeOrderEnum.dealTP,
          side: OrderSideEnum.sell,
          price: 3100,
          qty: 0.02,
          dealId: DEAL_ID,
        },
      ]
    }
    getDealInitialOrders() {
      return deal.initialOrders
    }
    async placeOrders(_b: string, _s: string, _d: string, o: any) {
      raised.placedNew.push(...o.new)
      raised.placedCancel.push(...o.cancel)
    }
    resendPendingFunds() {
      raised.resent++
    }
    async getCommDeal() {
      return 0
    }
    updateDealBalances() {}
    saveDeal() {
      return Promise.resolve()
    }
    async placeBaseOrder() {}
    async fundAddedSafetyOrders() {
      return true
    }
    async afterDealUpdate() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  const bot = new (TestBot as any)()
  return { bot, deal, raised }
}

const prices = (grids: any[]) => grids.map((g) => g.price)

describe('an active-smart-orders-only deal edit (spec 195)', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('../dcaHelper').default()
  })

  describe('isActiveOrdersCountOnlyDealEdit (§1.1.3)', () => {
    it('a lone active-orders change is', () => {
      const { bot, deal } = buildBot(5)
      expect(
        bot.isActiveOrdersCountOnlyDealEdit(deal, { activeOrdersCount: 3 }),
      ).to.equal(true)
    })

    it('a whole form with only the active-orders count changed is', () => {
      const { bot, deal } = buildBot(5)
      expect(
        bot.isActiveOrdersCountOnlyDealEdit(deal, {
          ...BOT_SETTINGS,
          activeOrdersCount: 3,
        }),
      ).to.equal(true)
    })

    it('alongside a step / size / count / scale change is not', () => {
      const { bot, deal } = buildBot(5)
      for (const k of [
        { step: '2' },
        { orderSize: '20' },
        { ordersCount: 9 },
        { volumeScale: '1.5' },
      ]) {
        expect(
          bot.isActiveOrdersCountOnlyDealEdit(deal, {
            activeOrdersCount: 3,
            ...k,
          }),
        ).to.equal(false)
      }
    })

    it('a patch that does not change the count is not', () => {
      const { bot, deal } = buildBot(5)
      expect(
        bot.isActiveOrdersCountOnlyDealEdit(deal, { activeOrdersCount: 5 }),
      ).to.equal(false)
    })

    it('a Combo deal is never', () => {
      const { bot, deal } = buildBot(5, { botType: BotType.combo })
      expect(
        bot.isActiveOrdersCountOnlyDealEdit(deal, { activeOrdersCount: 3 }),
      ).to.equal(false)
    })
  })

  describe('updateDealSettings (§1.1.1, §1.1.2)', () => {
    it('5 → 3 cancels the two furthest levels only; the kept levels and the take profit stay', async () => {
      const { bot, raised } = buildBot(5)
      await bot.updateDealSettings(DEAL_ID, { activeOrdersCount: 3 })
      expect(raised.cancelAll).to.have.length(0)
      expect(raised.cancelled).to.deep.equal([])
      expect(prices(raised.placedCancel)).to.deep.equal([2600, 2500])
      // The re-size cancel (`cancelGridOnExchange`) finds each level's order
      // by `findOrderForGrid`: they must resolve to the resting rows.
      expect(
        raised.placedCancel.map(
          (g: any) => bot.findOrderForGrid(g)?.clientOrderId,
        ),
      ).to.deep.equal(['D-RO-2600', 'D-RO-2500'])
      expect(raised.placedNew).to.deep.equal([])
      expect(raised.resent).to.equal(0)
    })

    it('3 → 5 places the two missing levels only', async () => {
      const { bot, raised } = buildBot(3)
      await bot.updateDealSettings(DEAL_ID, { activeOrdersCount: 5 })
      expect(raised.cancelAll).to.have.length(0)
      expect(raised.placedCancel).to.deep.equal([])
      expect(prices(raised.placedNew)).to.deep.equal([2600, 2500])
      expect(
        raised.placedNew.every(
          (g: any) => g.type === TypeOrderEnum.dealRegular,
        ),
      ).to.equal(true)
    })

    it('a resting level that is partly filled falls back to the full rebuild (§1.1.4)', async () => {
      const { bot, raised } = buildBot(5, { partial: 2500 })
      await bot.updateDealSettings(DEAL_ID, { activeOrdersCount: 3 })
      expect(raised.cancelAll).to.have.length(1)
      expect(raised.resent).to.equal(1)
    })
  })

  describe('NOT CHANGING: every other ladder edit still rebuilds the whole ladder (§1.1.5)', () => {
    for (const patch of [
      { step: '2' },
      { orderSize: '20' },
      { ordersCount: 9 },
      { volumeScale: '1.5' },
      { activeOrdersCount: 3, step: '2' },
    ]) {
      it(`${JSON.stringify(patch)}`, async () => {
        const { bot, raised } = buildBot(5)
        await bot.updateDealSettings(DEAL_ID, patch)
        expect(raised.cancelAll).to.have.length(1)
        expect(raised.resent).to.equal(1)
      })
    }
  })
})
