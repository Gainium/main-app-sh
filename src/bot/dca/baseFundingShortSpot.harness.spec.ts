process.env.NODE_ENV = 'testing'

/**
 * Engine checks for main-app spec 044 phase 2 — a short spot DCA deal the bot
 * funds itself.
 *
 * Drives the REAL `fundShortSpotEntry`, `checkBalance` and
 * `fundAddedSafetyOrders` over the REAL `createInitialDealOrders` ladder and
 * the REAL planner. No stack, DB, Redis or exchange: balances, the reserved
 * quote, order sends and the lot write are recorders.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import { FundingLock, MemoryFundingLockStore } from '../fundingLock'
import {
  BaseFundingEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = 'deal-1'
const SYMBOL = 'SOLUSDT'
const PRICE = 100

/** Short, 1 SOL base order, two 1 SOL safety orders 1% apart. */
const SHORT: any = {
  strategy: 'SHORT',
  baseFunding: BaseFundingEnum.auto,
  startOrderType: 'MARKET',
  orderSizeType: 'base',
  baseOrderSize: '1',
  orderSize: '1',
  ordersCount: 2,
  activeOrdersCount: 2,
  useSmartOrders: false,
  useDca: true,
  dcaCondition: 'percentage',
  step: '1',
  stepScale: '1',
  volumeScale: '1',
  indicators: [],
  dcaCustom: [],
  useTp: true,
  tpPerc: '2',
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  useSl: false,
  multiTp: [],
  multiSl: [],
}

const EXCHANGE_INFO: any = {
  pair: SYMBOL,
  baseAsset: { minAmount: 0.001, step: 0.001, name: 'SOL' },
  quoteAsset: { minAmount: 5, step: 0.01, name: 'USDT' },
  priceAssetPrecision: 2,
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  kucoinSpot = false
  zeroFee = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  orders = new Map()
  ordersDb = { createData: () => undefined }
  data: any = {
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'uuid-1',
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any
const lots: any[] = []

type Setup = {
  settings?: any
  freeBase?: number
  freeQuote?: number
  reserved?: number
  reservedBase?: number
  status?: string
  resting?: any[]
  filled?: any[]
}

const buildBot = (o: Setup = {}) => {
  const settings = { ...SHORT, ...(o.settings ?? {}) }
  const findDeal: any = {
    deal: {
      _id: DEAL_ID,
      symbol: { symbol: SYMBOL, baseAsset: 'SOL', quoteAsset: 'USDT' },
      status: o.status ?? 'start',
      initialPrice: PRICE,
      lastPrice: PRICE,
      avgPrice: PRICE,
      levels: { all: 3, complete: 1 },
      funds: [],
      pendingAddFunds: [],
      reduceFunds: [],
      flags: [],
      settings: { ...settings },
    },
    initialOrders: [],
    currentOrders: [],
  }
  const rows = [...(o.resting ?? []), ...(o.filled ?? [])]
  class TestBot extends Helper {
    sent: any[] = []
    saved: any[] = []
    closed: any[] = []
    errors: string[] = []
    getDeal(id: string) {
      return id === DEAL_ID ? findDeal : undefined
    }
    getOrdersByStatusAndDealId({
      status,
      defaultStatuses,
    }: {
      status?: string | string[]
      defaultStatuses?: boolean
    }) {
      const wanted = defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : status
          ? [status].flat()
          : undefined
      return rows.filter((r) => !wanted || wanted.includes(r.status))
    }
    async getAggregatedSettings(deal?: any) {
      return { ...settings, ...(deal?.settings ?? {}) }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async baseAssetPrecision() {
      return 3
    }
    async getLatestPrice() {
      return PRICE
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async checkAssets() {
      return new Map([
        ['SOL', { free: o.freeBase ?? 0, locked: 0 }],
        ['USDT', { free: o.freeQuote ?? 0, locked: 0 }],
      ])
    }
    async reservedFundingQuote() {
      return o.reserved ?? 0
    }
    async reservedFundingBase() {
      return o.reservedBase ?? 0
    }
    async profitBase() {
      return false
    }
    async getTPOrder() {
      return []
    }
    getOrderId(prefix: string) {
      return `${prefix}-x`
    }
    async sendOrderToExchange(order: any) {
      this.sent.push(order)
      return {
        ...order,
        status: 'FILLED',
        orderId: '42',
        executedQty: order.origQty,
        cummulativeQuoteQty: `${+order.origQty * PRICE}`,
      }
    }
    async closeDealById(...args: any[]) {
      this.closed.push(args)
    }
    async saveDeal(_d: any, patch: any) {
      this.saved.push(patch)
    }
    setOrder() {}
    async getBaseOrder() {
      return marketBase()
    }
    async createCurrentDealOrders() {
      return []
    }
    async getLeverageMultipler() {
      return 1
    }
    async pooledMarginOrKeep(_a: string, available: number) {
      return available
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors(msg: string) {
      this.errors.push(msg)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.data.settings = settings
  // The helper's own field (set from `strategy` at load) shadows FakeBase's.
  bot.isLong = false
  return { bot, findDeal }
}

const marketBase = (): any => ({
  clientOrderId: 'D-BO-x',
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealStart,
  status: 'NEW',
  type: 'MARKET',
  side: OrderSideEnum.sell,
  price: `${PRICE}`,
  origPrice: `${PRICE}`,
  origQty: '1',
  executedQty: '0',
  symbol: SYMBOL,
})

describe('Short spot deal funded by the bot (main-app spec 044 phase 2)', () => {
  before(function () {
    this.timeout(180000)
    // The lot write is the one DB call left on the path under test.
    const dbInit = loadModule('../../db/dbInit')
    // Fix round 2 plumbing: the lot writer first looks a lot up by its
    // client id (restart after the lot was written) — read the same `lots`.
    dbInit.fundingLotDb.readData = async (filter: any) => {
      const i = lots.findIndex((l) => l.clientOrderId === filter.clientOrderId)
      return {
        status: StatusEnum.ok,
        data: {
          result: i < 0 ? undefined : { ...lots[i], _id: `lot${i + 1}` },
        },
      }
    }
    dbInit.fundingLotDb.createData = async (lot: any) => {
      lots.push(lot)
      return {
        status: StatusEnum.ok,
        data: { ...lot, _id: `lot${lots.length}` },
      }
    }
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
    // Phase 3: funding runs under the per-account lock; no Redis here.
    FundingLock.getInstance().setStore(new MemoryFundingLockStore())
  })

  describe('deal open — fundShortSpotEntry', () => {
    it('no base: base order filled virtually, safety orders bought upfront', async () => {
      const { bot, findDeal } = buildBot({ freeBase: 0, freeQuote: 1000 })
      const base = marketBase()
      expect(await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, base)).to.equal(
        'virtual',
      )
      expect(bot.sent).to.have.length(1)
      const [buy] = bot.sent
      expect(buy.typeOrder).to.equal(TypeOrderEnum.funding)
      expect(buy.side).to.equal(OrderSideEnum.buy)
      expect(buy.type).to.equal('MARKET')
      expect(buy.dealId).to.equal(undefined)
      expect(+buy.origQty).to.equal(2)
      expect(base.status).to.equal('FILLED')
      expect(base.executedQty).to.equal('1')
      expect(base.fundingSource).to.equal('virtual')
      expect(findDeal.deal.botFunding).to.deep.include({
        mode: BaseFundingEnum.auto,
        sourcedByBot: true,
      })
      expect(findDeal.deal.botFunding.virtualEntry).to.deep.equal({
        qty: 1,
        price: PRICE,
        quoteReserved: 100,
      })
      expect(findDeal.deal.botFunding.lotIds).to.have.length(1)
      expect(lots.at(-1)).to.deep.include({
        dealId: DEAL_ID,
        asset: 'SOL',
        qty: 2,
        price: PRICE,
        remaining: 2,
      })
    })

    it('enough base for the whole deal: sent as before', async () => {
      const { bot } = buildBot({ freeBase: 3, freeQuote: 0 })
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('held')
      expect(bot.sent).to.have.length(0)
    })

    it('partial base: only the difference is bought, not bot-sourced', async () => {
      const { bot, findDeal } = buildBot({ freeBase: 1.5, freeQuote: 1000 })
      await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase())
      expect(+bot.sent[0].origQty).to.equal(0.5)
      expect(findDeal.deal.botFunding.sourcedByBot).to.equal(false)
    })

    it('botOnly buys every safety order even with base held', async () => {
      const { bot, findDeal } = buildBot({
        settings: { baseFunding: BaseFundingEnum.botOnly },
        freeBase: 50,
        freeQuote: 1000,
      })
      await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase())
      expect(+bot.sent[0].origQty).to.equal(2)
      expect(findDeal.deal.botFunding.sourcedByBot).to.equal(true)
    })

    it('not enough quote: refused, deal retired, nothing traded', async () => {
      const { bot } = buildBot({ freeBase: 0, freeQuote: 299 })
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('refused')
      expect(bot.sent).to.have.length(0)
      expect(bot.closed).to.have.length(1)
      expect(bot.errors[0]).to.match(/Not enough USDT to fund this deal/)
    })

    it('quote reserved by other funded deals is not spendable', async () => {
      const { bot } = buildBot({ freeBase: 0, freeQuote: 1000, reserved: 800 })
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('refused')
    })

    for (const [name, setup, base] of [
      ['require', { settings: { baseFunding: BaseFundingEnum.require } }],
      ['missing setting', { settings: { baseFunding: undefined } }],
      ['limit base order', {}, { type: 'LIMIT' }],
      [
        'percentage-of-balance size',
        { settings: { orderSizeType: 'percFree' } },
      ],
    ] as [string, Setup, any?][]) {
      it(`${name}: sent as before`, async () => {
        const { bot } = buildBot({ freeBase: 0, freeQuote: 1000, ...setup })
        expect(
          await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, {
            ...marketBase(),
            ...(base ?? {}),
          }),
        ).to.equal('held')
        expect(bot.sent).to.have.length(0)
      })
    }

    it('a regular bot saved with terminalDealType smart is still funded', async () => {
      // The dashboard stores terminalDealType 'smart' on every regular bot.
      const { bot } = buildBot({
        settings: { type: 'regular', terminalDealType: 'smart' },
        freeBase: 0,
        freeQuote: 1000,
      })
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('virtual')
    })

    it('combo is funded even when it carries a limit startOrderType', async () => {
      // Combo always enters at market; its settings may still say LIMIT.
      const { bot } = buildBot({
        settings: { startOrderType: 'LIMIT' },
        freeBase: 0,
        freeQuote: 1000,
      })
      bot.combo = true
      expect(
        bot.shortSpotFundingMode(await bot.getAggregatedSettings()),
      ).to.equal(BaseFundingEnum.auto)
      bot.combo = false
      expect(
        bot.shortSpotFundingMode(await bot.getAggregatedSettings()),
      ).to.equal(null)
    })

    it('a terminal deal is not funded', async () => {
      const { bot } = buildBot({
        settings: { type: 'terminal' },
        freeBase: 0,
        freeQuote: 1000,
      })
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('held')
    })

    it('a hedge leg funds through its start action instead', async () => {
      const { bot } = buildBot({ freeBase: 0, freeQuote: 1000 })
      bot.data.parentBotId = 'hedge'
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('held')
    })

    it('a long bot is not funded', async () => {
      const { bot } = buildBot({ freeBase: 0, freeQuote: 1000 })
      bot.isLong = true
      expect(
        await bot.fundShortSpotEntry(SYMBOL, DEAL_ID, marketBase()),
      ).to.equal('held')
    })
  })

  describe('deal-open gate — checkBalance', () => {
    it('a deal the bot can fund passes with no base held', async () => {
      const { bot } = buildBot({ freeBase: 0, freeQuote: 1000 })
      expect((await bot.checkBalance(SYMBOL)).status).to.equal(true)
    })

    it('a deal it cannot fund is refused in quote', async () => {
      const { bot } = buildBot({ freeBase: 0, freeQuote: 120 })
      expect(await bot.checkBalance(SYMBOL)).to.deep.equal({
        status: false,
        required: 300,
        available: 120,
        price: PRICE,
        asset: 'USDT',
      })
    })

    it('without a funding mode a short still needs its base', async () => {
      const { bot } = buildBot({
        settings: { baseFunding: undefined },
        freeBase: 0,
        freeQuote: 1000,
      })
      expect((await bot.checkBalance(SYMBOL)).status).to.equal(false)
    })

    it('a long spot bot cannot spend quote a funded short reserves', async () => {
      const { bot } = buildBot({
        settings: { strategy: 'LONG', baseFunding: undefined },
        freeQuote: 150,
        reserved: 100,
      })
      bot.isLong = true
      const r = await bot.checkBalance(SYMBOL)
      expect(r.status).to.equal(false)
      expect(r.available).to.equal(50)
    })
  })

  describe('add DCA levels — fundAddedSafetyOrders', () => {
    // Two 1 SOL safety orders resting; the edit raises the ladder to 4.
    const resting = [1, 2].map((i) => ({
      clientOrderId: `D-RO-${i}`,
      dealId: DEAL_ID,
      typeOrder: TypeOrderEnum.dealRegular,
      side: OrderSideEnum.sell,
      status: 'NEW',
      origQty: '1',
      executedQty: '0',
    }))

    it('buys only what the new levels need beyond the resting sells', async () => {
      const { bot } = buildBot({
        status: 'open',
        freeBase: 0,
        freeQuote: 1000,
        resting,
      })
      expect(
        await bot.fundAddedSafetyOrders(bot.getDeal(DEAL_ID), DEAL_ID, {
          ordersCount: 4,
        }),
      ).to.equal(true)
      expect(bot.sent).to.have.length(1)
      expect(+bot.sent[0].origQty).to.equal(2)
      expect(bot.sent[0].typeOrder).to.equal(TypeOrderEnum.funding)
    })

    it('free base counts in auto', async () => {
      const { bot } = buildBot({
        status: 'open',
        freeBase: 1.25,
        freeQuote: 1000,
        resting,
      })
      await bot.fundAddedSafetyOrders(bot.getDeal(DEAL_ID), DEAL_ID, {
        ordersCount: 4,
      })
      expect(+bot.sent[0].origQty).to.equal(0.75)
    })

    it('not enough quote: refused, nothing bought, edit not applied', async () => {
      const { bot } = buildBot({
        status: 'open',
        freeBase: 0,
        freeQuote: 150,
        resting,
      })
      expect(
        await bot.fundAddedSafetyOrders(bot.getDeal(DEAL_ID), DEAL_ID, {
          ordersCount: 4,
        }),
      ).to.equal(false)
      expect(bot.sent).to.have.length(0)
      expect(bot.errors[0]).to.match(/The deal was not changed/)
    })

    it('records the lot on the deal object the map holds after the trade', async () => {
      // The trade waits for its fill; the deal map can hold a new object by
      // then, and writing to the old one lost the record.
      const { bot, findDeal } = buildBot({
        status: 'open',
        freeBase: 0,
        freeQuote: 1000,
        resting,
      })
      const fresh = { ...findDeal, deal: { ...findDeal.deal } }
      const send = bot.sendOrderToExchange.bind(bot)
      bot.sendOrderToExchange = async (o: any) => {
        const r = await send(o)
        bot.getDeal = (id: string) => (id === DEAL_ID ? fresh : undefined)
        return r
      }
      await bot.fundAddedSafetyOrders(findDeal, DEAL_ID, { ordersCount: 4 })
      expect(fresh.deal.botFunding?.lotIds).to.have.length(1)
      expect(findDeal.deal.botFunding).to.equal(undefined)
    })

    it('a patch that does not touch the ladder never buys', async () => {
      const { bot } = buildBot({
        status: 'open',
        freeBase: 0,
        freeQuote: 1000,
      })
      expect(
        await bot.fundAddedSafetyOrders(bot.getDeal(DEAL_ID), DEAL_ID, {
          tpPerc: '3',
        }),
      ).to.equal(true)
      expect(bot.sent).to.have.length(0)
    })

    it('a covered ladder buys nothing', async () => {
      const { bot } = buildBot({
        status: 'open',
        freeBase: 0,
        freeQuote: 1000,
        resting,
      })
      await bot.fundAddedSafetyOrders(bot.getDeal(DEAL_ID), DEAL_ID, {
        ordersCount: 2,
      })
      expect(bot.sent).to.have.length(0)
    })
  })
})
