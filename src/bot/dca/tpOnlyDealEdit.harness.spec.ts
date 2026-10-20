process.env.NODE_ENV = 'testing'

/**
 * A deal edit that changes only the take profit replaces the take profit and
 * leaves the safety orders resting.
 *
 * Every deal settings save used to run the full `rebuildDealOrders`: cancel
 * every order of the deal, rebuild the ladder at today's price and place it
 * all again. A take-profit change reads none of the ladder's inputs, so that
 * only re-priced the ladder and cost every level its place in the book.
 *
 * Drives the REAL `isTpOnlyDealEdit`, `rebuildDealOrders` and
 * `updateDealSettings`; the exchange boundary is recorded. Fixture ids are
 * synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { BotType, DCADealStatusEnum, TypeOrderEnum } from '../../../types'

const BOT_ID = '000000000000000000000b52'
const DEAL_ID = '000000000000000000000d52'
const SYMBOL = 'ETH-USDT'

let Helper: any

/** The whole form a client sends: every key, only some of them changed. */
const BOT_SETTINGS = {
  tpPerc: '2',
  useTp: true,
  ordersCount: 5,
  orderSize: '10',
  step: '1',
  stepScale: '1.2',
  volumeScale: '1.5',
  useDca: true,
  useSmartOrders: true,
  activeOrdersCount: 2,
  slPerc: '-10',
  useSl: false,
}

const restingTp = {
  clientOrderId: 'D-TP-52',
  dealId: DEAL_ID,
  symbol: SYMBOL,
  typeOrder: TypeOrderEnum.dealTP,
  status: 'NEW',
}
const restingSo = {
  clientOrderId: 'D-RO-52',
  dealId: DEAL_ID,
  symbol: SYMBOL,
  typeOrder: TypeOrderEnum.dealRegular,
  status: 'NEW',
}

const buildBot = (botType: BotType = BotType.dca, extra: any[] = []) => {
  const raised = {
    cancelled: [] as string[],
    cancelAll: [] as unknown[][],
    placed: [] as any[],
    resent: 0,
    rebuilt: [] as any[],
  }
  const deal = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL },
      settings: { ...BOT_SETTINGS, avgPrice: 3000 },
      avgPrice: 3000,
      initialPrice: 3000,
      lastPrice: 2900,
      levels: { complete: 2, all: 6 },
    },
    initialOrders: [{ type: TypeOrderEnum.dealRegular }],
    currentOrders: [] as any[],
  }
  const orders = [restingTp, restingSo, ...extra]
  class TestBot extends (Helper as any) {
    raised = raised
    botId = BOT_ID
    botType = botType
    data: any = { settings: { ...BOT_SETTINGS }, exchange: 'binance' }
    orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId({ dealId }: { dealId?: string }) {
      return orders.filter((o) => !dealId || o.dealId === dealId)
    }
    async cancelOrderOnExchange(o: any) {
      raised.cancelled.push(o.clientOrderId)
      return undefined
    }
    async cancelAllOrder(...args: unknown[]) {
      raised.cancelAll.push(args)
    }
    async createInitialDealOrders() {
      return deal.initialOrders
    }
    async createCurrentDealOrders() {
      return [
        { type: TypeOrderEnum.dealTP, price: 3100, qty: 1 },
        { type: TypeOrderEnum.dealRegular, price: 2800, qty: 1 },
      ]
    }
    getDealInitialOrders() {
      return deal.initialOrders
    }
    async getOrdersToRestartAfterSettingsUpdate() {
      return {
        new: [
          { type: TypeOrderEnum.dealTP, price: 3100, qty: 1 },
          { type: TypeOrderEnum.dealRegular, price: 2800, qty: 1 },
        ],
        cancel: [],
      }
    }
    async placeOrders(_b: string, _s: string, _d: string, o: any) {
      raised.placed.push(...o.new)
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

describe('a take-profit-only deal edit leaves the safety orders resting', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('../dcaHelper').default()
  })

  describe('isTpOnlyDealEdit', () => {
    it('a lone take-profit change is take-profit only', () => {
      const { bot, deal } = buildBot()
      expect(bot.isTpOnlyDealEdit(deal, { tpPerc: '3' })).to.equal(true)
    })

    it('a whole form with only the take profit changed is take-profit only', () => {
      const { bot, deal } = buildBot()
      expect(
        bot.isTpOnlyDealEdit(deal, { ...BOT_SETTINGS, tpPerc: '3' }),
      ).to.equal(true)
    })

    it('a ladder change is not', () => {
      const { bot, deal } = buildBot()
      expect(
        bot.isTpOnlyDealEdit(deal, {
          ...BOT_SETTINGS,
          tpPerc: '3',
          ordersCount: 7,
        }),
      ).to.equal(false)
    })

    it('a stop-loss change is not', () => {
      const { bot, deal } = buildBot()
      expect(bot.isTpOnlyDealEdit(deal, { slPerc: '-5' })).to.equal(false)
    })

    it('a patch that changes nothing is not', () => {
      const { bot, deal } = buildBot()
      expect(bot.isTpOnlyDealEdit(deal, { ...BOT_SETTINGS })).to.equal(false)
    })

    it('a Combo deal is never', () => {
      const { bot, deal } = buildBot(BotType.combo)
      expect(bot.isTpOnlyDealEdit(deal, { tpPerc: '3' })).to.equal(false)
    })
  })

  describe('rebuildDealOrders', () => {
    it('tpOnly cancels and places the take profit only', async () => {
      const { bot, deal, raised } = buildBot()
      await bot.rebuildDealOrders(deal, DEAL_ID, { tpOnly: true })
      expect(raised.cancelAll).to.have.length(0)
      expect(raised.cancelled).to.deep.equal(['D-TP-52'])
      expect(raised.placed.map((o: any) => o.type)).to.deep.equal([
        TypeOrderEnum.dealTP,
      ])
      expect(raised.resent).to.equal(0)
    })

    it('a full rebuild still replaces the whole book', async () => {
      const { bot, deal, raised } = buildBot()
      await bot.rebuildDealOrders(deal, DEAL_ID)
      expect(raised.cancelAll).to.have.length(1)
      expect(raised.placed.map((o: any) => o.type)).to.deep.equal([
        TypeOrderEnum.dealTP,
        TypeOrderEnum.dealRegular,
      ])
      expect(raised.resent).to.equal(1)
    })
  })

  describe('updateDealSettings', () => {
    const run = async (patch: Record<string, unknown>) => {
      const { bot, raised } = buildBot()
      bot.rebuildDealOrders = async (_d: any, _id: string, opts: any) => {
        raised.rebuilt.push(opts)
      }
      await bot.updateDealSettings(DEAL_ID, patch)
      return raised.rebuilt
    }

    it('passes tpOnly for a take-profit edit', async () => {
      expect(await run({ ...BOT_SETTINGS, tpPerc: '3' })).to.deep.equal([
        { tpOnly: true },
      ])
    })

    it('does not for a ladder edit', async () => {
      expect(await run({ ...BOT_SETTINGS, ordersCount: 7 })).to.deep.equal([
        { tpOnly: false },
      ])
    })
  })

  describe('a resting reduce-funds order is not the take profit', () => {
    /** A resting limit reduce: a dealTP row, with or without its funds id. */
    const reduce = (clientOrderId: string, withId: boolean) => ({
      clientOrderId,
      dealId: DEAL_ID,
      symbol: SYMBOL,
      typeOrder: TypeOrderEnum.dealTP,
      status: 'NEW',
      ...(withId ? { reduceFundsId: `rf-${clientOrderId}` } : {}),
    })

    it('a take-profit edit leaves the reduce resting and replaces only the take profit', async () => {
      const { bot, deal, raised } = buildBot(BotType.dca, [
        reduce('D-TPR-52a', true),
      ])
      ;(deal.deal as any).pendingReduceFunds = [{ id: 'rf-D-TPR-52a' }]
      await bot.rebuildDealOrders(deal, DEAL_ID, { tpOnly: true })
      expect(raised.cancelled).to.deep.equal(['D-TP-52'])
      expect(raised.placed.map((o: any) => o.type)).to.deep.equal([
        TypeOrderEnum.dealTP,
      ])
      // Not cancelled, so not re-sent either: the pending entry stays as is.
      expect(raised.resent).to.equal(0)
      expect((deal.deal as any).pendingReduceFunds).to.deep.equal([
        { id: 'rf-D-TPR-52a' },
      ])
    })

    it('a reduce row without its funds id is recognised by its client id', async () => {
      const { bot, deal, raised } = buildBot(BotType.dca, [
        reduce('D-TPR-52b', false),
      ])
      await bot.rebuildDealOrders(deal, DEAL_ID, { tpOnly: true })
      expect(raised.cancelled).to.deep.equal(['D-TP-52'])
    })
  })
})
