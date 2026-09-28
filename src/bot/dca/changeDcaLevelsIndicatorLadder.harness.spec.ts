process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `118` — the deal's "Change DCA levels" action must
 * change how many safety orders an indicator / custom-list deal can place.
 *
 * Shape of the reproduction (prod, 2026-09-28): `dcaCondition: indicators`, a
 * bot with three `startDca` indicators and an unrelated stored
 * `ordersCount: 8`, two safety orders filled (`levels.complete: 3`). The user
 * set DCA levels to 2; the deal stored `ordersCount: 2` and kept
 * `levels.all: 4`, with level 3 still armed.
 *
 * Drives the REAL `updateDealSettings` → `createInitialDealOrders` →
 * `levels.all`, and the REAL `addDCAOrderByIndicator` over the ladder that
 * `createInitialDealOrders` builds. `getAggregatedSettings` is the real merge
 * (bot settings, then the deal's own). No stack, DB, Redis or exchange
 * connection; `sendGridToExchange` / `placeOrders` are recorders.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum } from '../../../types'
import { createRequire } from 'module'

const DEAL_ID = '6aab57b13426b696a865fbd2'
const SYMBOL = 'SOLUSDT'
const INITIAL_PRICE = 100
/** Far enough below every level's `minPercFromLast` for a long to fire. */
const CURRENT_PRICE = 90

const indicators: any[] = [0, 1, 2].map((i) => ({
  type: 'RSI',
  indicatorLength: 14,
  indicatorValue: '30',
  indicatorCondition: 'lt',
  indicatorInterval: '1m',
  groupId: `grp-${i}`,
  uuid: `uuid-${i}`,
  indicatorAction: 'startDca',
  section: 'dca',
  minPercFromLast: '1',
}))

const baseSettings: any = {
  strategy: 'LONG',
  indicators,
  ordersCount: 8,
  activeOrdersCount: 8,
  useSmartOrders: false,
  useDca: true,
  step: '1',
  stepScale: '1',
  volumeScale: '1',
  orderSize: '20',
  orderSizeType: 'quote',
  baseOrderSize: '20',
  dcaByMarket: false,
  useTp: true,
  tpPerc: '5',
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  trailingTp: false,
  trailingSl: false,
  useMultiTp: false,
  multiTp: [],
  useSl: false,
  useMultiSl: false,
  multiSl: [],
  slPerc: '-10',
  moveSL: false,
  closeOrderType: 'LIMIT',
}

const INDICATORS = {
  ...baseSettings,
  dcaCondition: 'indicators',
  dcaCustom: [],
}
const CUSTOM = {
  ...baseSettings,
  dcaCondition: 'custom',
  indicators: [],
  dcaCustom: [0, 1, 2].map((i) => ({ uuid: `c${i}`, step: '2', size: '20' })),
}
const PERCENTAGE = {
  ...baseSettings,
  dcaCondition: 'percentage',
  indicators: [],
  dcaCustom: [],
  ordersCount: 3,
}

const EXCHANGE_INFO: any = {
  pair: SYMBOL,
  baseAsset: { minAmount: 0.001, step: 0.001, asset: 'SOL' },
  quoteAsset: { minAmount: 5, step: 0.01, asset: 'USDT' },
  priceAssetPrecision: 2,
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = true
  futures = false
  coinm = false
  combo = false
  hedge = false
  kucoinSpot = false
  zeroFee = false
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  orders = new Map()
  data: any = {
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/** Base order + `filled` safety orders, FILLED. */
const filledRows = (filled: number): any[] => [
  {
    clientOrderId: 'D-BO-base',
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealStart,
    status: 'FILLED',
    price: `${INITIAL_PRICE}`,
    side: 'BUY',
  },
  ...Array.from({ length: filled }, (_, i) => ({
    clientOrderId: `D-RO-filled${i + 1}`,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    status: 'FILLED',
    price: `${INITIAL_PRICE - i - 1}`,
    side: 'BUY',
  })),
]

const buildBot = (botSettings: any, filled: number, dealSettings: any = {}) => {
  const rows = filledRows(filled)
  const findDeal: any = {
    deal: {
      _id: DEAL_ID,
      symbol: { symbol: SYMBOL, baseAsset: 'SOL', quoteAsset: 'USDT' },
      status: 'open',
      levels: { all: 4, complete: 1 + filled },
      funds: [],
      pendingAddFunds: [],
      reduceFunds: [],
      flags: [],
      initialPrice: INITIAL_PRICE,
      lastPrice: INITIAL_PRICE,
      avgPrice: INITIAL_PRICE,
      settings: {
        ...botSettings,
        avgPrice: INITIAL_PRICE,
        ...dealSettings,
      },
      tpSlTargetFilled: [],
      dynamicAr: [],
    },
    initialOrders: [],
    currentOrders: [],
  }
  class TestBot extends Helper {
    public sentGrids: any[] = []
    public placed: any[] = []
    getDeal(id: string) {
      return id === DEAL_ID ? findDeal : undefined
    }
    getDealsByStatusAndSymbol() {
      return [findDeal]
    }
    getOrdersByStatusAndDealId({ status }: { status?: string | string[] }) {
      const wanted = status ? [status].flat() : undefined
      return rows.filter((o) => !wanted || wanted.includes(o.status))
    }
    findBaseOrderByDeal() {
      return undefined
    }
    /** Same merge as the real one: bot settings, then the deal's own. */
    async getAggregatedSettings(deal?: any) {
      return { ...botSettings, ...(deal?.settings ?? {}) }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async baseAssetPrecision() {
      return 3
    }
    async getLatestPrice() {
      return CURRENT_PRICE
    }
    async profitBase() {
      return false
    }
    /** The TP is appended after the safety-order selection this suite pins. */
    async getTPOrder() {
      return []
    }
    getOrderId(prefix: string) {
      return `${prefix}-x`
    }
    /** Indicator / custom safety orders never rest on the book here. */
    async createCurrentDealOrders() {
      return []
    }
    async cancelAllOrder() {}
    async getCommDeal() {
      return 0
    }
    updateDealBalances() {}
    saveDeal() {
      return new Promise(() => undefined)
    }
    async getOrdersToRestartAfterSettingsUpdate() {
      return { new: [], cancel: [] }
    }
    async placeOrders(_b: string, _s: string, _d: string, diff: any) {
      this.placed.push(diff)
    }
    resendPendingFunds() {}
    async afterDealUpdate() {}
    async sendGridToExchange(grid: any) {
      this.sentGrids.push(grid)
      return undefined
    }
    async processFilledOrder() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.data.settings = botSettings
  return { bot, findDeal }
}

let clock = 1_700_000_000_000
const fire = async (bot: any, index: number) => {
  bot.sentGrids = []
  await bot.addDCAOrderByIndicator('bot', index, SYMBOL, ++clock)
  return bot.sentGrids.map((g: any) => g.levelNumber)
}

const regularLevels = async (bot: any, findDeal: any) =>
  (
    await bot.createInitialDealOrders(
      SYMBOL,
      INITIAL_PRICE,
      DEAL_ID,
      findDeal.deal,
    )
  )
    .filter((o: any) => o.type === TypeOrderEnum.dealRegular)
    .map((o: any) => o.levelNumber)

describe('Change DCA levels on indicator / custom ladders (spec 118)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('indicators: 3 startDca, 2 filled — the reproduction', () => {
    it('§1.1 lowering to 2 sets levels.all to 3', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      expect(findDeal.deal.levels).to.deep.equal({ complete: 3, all: 3 })
    })

    it('§1.1 and signal 3 then fires nothing', async () => {
      const { bot } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      expect(await fire(bot, 2)).to.deep.equal([])
    })

    it('§1.1 V1 shape ({ordersCount} alone) caps the same way', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { ordersCount: 2 })
      expect(findDeal.deal.levels.all).to.equal(3)
    })

    it('§1.1 raising back to 3 restores level 3', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 3 })
      expect(findDeal.deal.levels.all).to.equal(4)
      expect(await fire(bot, 2)).to.deep.equal([3])
    })

    it('§1.1 raising past the indicator count stays at the indicator count', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 9 })
      expect(findDeal.deal.levels.all).to.equal(4)
    })

    it('§1.1 0 (useDca:false) leaves no level and fires nothing', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: false })
      expect(findDeal.deal.levels.all).to.equal(3)
      expect(await fire(bot, 2)).to.deep.equal([])
    })

    it('§1.1 DCA off, then the action back to 3, restores level 3 as the bot defines it', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: false })
      expect(findDeal.deal.levels.all).to.equal(3)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 3 })
      expect(findDeal.deal.levels.all).to.equal(4)
      expect(await regularLevels(bot, findDeal)).to.deep.equal([1, 2, 3])
      expect(await fire(bot, 2)).to.deep.equal([3])
    })

    it('§1.1 resetting the deal to the bot settings drops the cap', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      bot.getInitalDealSettings = () => ({ ...INDICATORS })
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      expect(findDeal.deal.levels.all).to.equal(3)
      await bot.resetDealSettings(DEAL_ID)
      expect(findDeal.deal.settings.dcaLevelsCap).to.equal(undefined)
      expect(findDeal.deal.levels.all).to.equal(4)
    })

    it('§1.1 the spent-ladder size agrees with the cap', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      expect(
        bot.dcaLadderSize(await bot.getAggregatedSettings(findDeal.deal)),
      ).to.equal(2)
    })
  })

  describe('custom list: 3 rows', () => {
    it('§1.1 lowering to 1 leaves one level', async () => {
      const { bot, findDeal } = buildBot(CUSTOM, 0)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 1 })
      expect(await regularLevels(bot, findDeal)).to.deep.equal([1])
      expect(findDeal.deal.levels.all).to.equal(2)
    })

    it('§1.1 a capped ladder that is spent rests no safety order', async () => {
      const { bot, findDeal } = buildBot(CUSTOM, 2)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      const initial = await bot.createInitialDealOrders(
        SYMBOL,
        INITIAL_PRICE,
        DEAL_ID,
        findDeal.deal,
      )
      // Level 2 filled one tick above where the ladder rebuilds it — the
      // drift spec `115` names — so the rebuilt level sits beyond `lastPrice`.
      const last =
        initial.filter((o: any) => o.type === TypeOrderEnum.dealRegular)[1]
          .price + 0.01
      // The real selection, not the suite's `createCurrentDealOrders` stub.
      const current = await Helper.prototype.createCurrentDealOrders.call(
        bot,
        SYMBOL,
        last,
        initial,
        INITIAL_PRICE,
        INITIAL_PRICE,
        DEAL_ID,
        false,
        findDeal.deal,
      )
      expect(
        current.filter((o: any) => o.type === TypeOrderEnum.dealRegular),
      ).to.deep.equal([])
    })
  })

  describe('nobody used the action — §4.2', () => {
    it('indicators: one level per startDca, whatever ordersCount holds', async () => {
      // Deal carries the bot's unrelated `ordersCount: 8`, and a lower one.
      for (const oc of [8, 2]) {
        const { bot, findDeal } = buildBot(INDICATORS, 0, { ordersCount: oc })
        expect(await regularLevels(bot, findDeal)).to.deep.equal([1, 2, 3])
        expect(await fire(bot, 0)).to.deep.equal([1])
      }
    })

    it('an Edit Deal patch carrying ordersCount with other keys sets no cap — §4.4', async () => {
      const { bot, findDeal } = buildBot(INDICATORS, 2)
      await bot.updateDealSettings(DEAL_ID, { ordersCount: 2, tpPerc: '6' })
      expect(findDeal.deal.levels.all).to.equal(4)
      expect(findDeal.deal.settings.dcaLevelsCap).to.equal(undefined)
    })
  })

  describe('percentage ladders are unchanged — §4.3', () => {
    it('ordersCount still sizes the ladder and no cap is written', async () => {
      const { bot, findDeal } = buildBot(PERCENTAGE, 0)
      await bot.updateDealSettings(DEAL_ID, { useDca: true, ordersCount: 2 })
      expect(await regularLevels(bot, findDeal)).to.deep.equal([1, 2])
      expect(findDeal.deal.settings.dcaLevelsCap).to.equal(undefined)
    })
  })
})
