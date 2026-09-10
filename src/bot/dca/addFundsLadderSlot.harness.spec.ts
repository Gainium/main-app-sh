process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `031` — adding funds to a DCA deal must not
 * consume one of the bot's configured safety orders.
 *
 * Drives the REAL `dcaHelper.createCurrentDealOrders` and the REAL
 * `dcaHelper.executeNextDcaLevel` over the reproduction's own state, captured
 * on the paper stack 2026-09-10 (deal `6aa24882fd81bdd118c8e91f`, ETH-USDT,
 * `ordersCount: 4`, `orderSize: 20` quote, `volumeScale: 2`, `useSmartOrders:
 * false`, no SL, `tpPerc: 50`):
 *
 *   D-BO-kiYnpJZ…   dealStart    FILLED    0.0081 @ 2480.02
 *   D-RO-0lHfAjX…   dealRegular  CANCELED  0.0081 @ 2455.22   ← level 1, swept
 *   D-RO-6cMlSuB…   dealRegular  NEW       0.0165 @ 2430.42
 *   D-RO-Ic97KiP…   dealRegular  NEW       0.0333 @ 2405.62
 *   D-RO-itMx8XF…   dealRegular  NEW       0.0672 @ 2380.82
 *   D-ROA-sJLvFco…  dealRegular  FILLED    0.004  @ 2480.02   addFundsId ad1d4f0c-…
 *
 * `assets.required.quote` went 300.0875 → 280.2002 across that one addition:
 * the 20-USDT level, not the 160-USDT one, and not the 10 USDT added.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed. Nothing
 * here places or cancels anything — `sendGridToExchange` and
 * `cancelOrderOnExchange` are recorders.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum, OrderSideEnum } from '../../../types'
import { createRequire } from 'module'

const DEAL_ID = '6aa24882fd81bdd118c8e91f'
const SYMBOL = 'ETHUSDT'
const INITIAL_PRICE = 2480.02
/** Nothing has moved: the deal still sits at its entry. */
const CURRENT_PRICE = 2480.02

const settings: any = {
  dcaCondition: 'percentage',
  ordersCount: 4,
  activeOrdersCount: 4,
  useSmartOrders: false,
  useDca: true,
  step: '1',
  stepScale: '1',
  volumeScale: '2',
  orderSize: '20',
  orderSizeType: 'quote',
  baseOrderSize: '20',
  dcaByMarket: false,
  dcaCustom: [],
  indicators: [],
  useTp: true,
  tpPerc: '50',
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

const EXCHANGE_INFO: any = {
  pair: SYMBOL,
  baseAsset: { minAmount: 0.0001, step: 0.0001, asset: 'ETH' },
  quoteAsset: { minAmount: 5, step: 0.01, asset: 'USDT' },
  priceAssetPrecision: 2,
}

/** The configured ladder, at the prices `createInitialDealOrders` fixed. */
const LADDER = [
  { levelNumber: 1, price: 2455.22, qty: 0.0081 },
  { levelNumber: 2, price: 2430.42, qty: 0.0165 },
  { levelNumber: 3, price: 2405.62, qty: 0.0333 },
  { levelNumber: 4, price: 2380.82, qty: 0.0672 },
]

const initialOrders = (): any[] =>
  LADDER.map((l) => ({
    number: l.levelNumber,
    price: l.price,
    qty: l.qty,
    side: OrderSideEnum.buy,
    newClientOrderId: `D-RO-level${l.levelNumber}`,
    type: TypeOrderEnum.dealRegular,
    dealId: DEAL_ID,
    levelNumber: l.levelNumber,
    dcaLevel: l.levelNumber,
  }))

const BASE_ORDER: any = {
  clientOrderId: 'D-BO-kiYnpJZoHcA252Bm4XFUJK4hEdRVOw',
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealStart,
  status: 'FILLED',
  origQty: '0.0081',
  executedQty: '0.0081',
  price: `${INITIAL_PRICE}`,
  side: 'BUY',
}

const ADD_FUNDS_ORDER: any = {
  clientOrderId: 'D-ROA-sJLvFconrJJsAIL2kKtdOizjZtIH0',
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealRegular,
  status: 'FILLED',
  origQty: '0.004',
  executedQty: '0.004',
  price: `${INITIAL_PRICE}`,
  side: 'BUY',
  addFundsId: 'ad1d4f0c-cc15-42e9-8f30-a4603844d08e',
}

/** Level 1, had it filled on its own instead of being swept. */
const FILLED_SAFETY_ORDER: any = {
  clientOrderId: 'D-RO-level1',
  dealId: DEAL_ID,
  typeOrder: TypeOrderEnum.dealRegular,
  status: 'FILLED',
  origQty: '0.0081',
  executedQty: '0.0081',
  price: '2455.22',
  side: 'BUY',
}

/** The ladder as it rests on the venue. */
const restingRows = (levels: number[]): any[] =>
  LADDER.filter((l) => levels.includes(l.levelNumber)).map((l) => ({
    clientOrderId: `D-RO-level${l.levelNumber}`,
    dealId: DEAL_ID,
    typeOrder: TypeOrderEnum.dealRegular,
    status: 'NEW',
    origQty: `${l.qty}`,
    executedQty: '0',
    price: `${l.price}`,
    side: 'BUY',
  }))

const deal = (over: any = {}): any => ({
  _id: DEAL_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'USDT' },
  status: 'open',
  levels: { all: 5, complete: 1 },
  funds: [],
  reduceFunds: [],
  flags: [],
  initialPrice: INITIAL_PRICE,
  lastPrice: CURRENT_PRICE,
  avgPrice: INITIAL_PRICE,
  settings: { avgPrice: INITIAL_PRICE },
  tpSlTargetFilled: [],
  dynamicAr: [],
  currentBalances: { base: 0.0081, quote: 0 },
  initialBalances: { base: 0, quote: 300 },
  ...over,
})

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
    settings,
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type BuildOpts = {
  /** What the bot's in-memory order map holds for this deal. */
  orders: any[]
  /** The deal document. */
  dealDoc?: any
  /** What `sendGridToExchange` should report back. */
  sent?: any
}

const buildBot = ({ orders, dealDoc }: BuildOpts) => {
  const d = dealDoc ?? deal()
  class TestBot extends Helper {
    public logs: string[] = []
    public errors: string[] = []
    public sentGrids: any[] = []
    public cancelled: string[] = []

    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal: d, initialOrders: initialOrders(), currentOrders: [] }
        : undefined
    }
    /** The real index lookup, over the fixture's rows rather than a live map. */
    getOrdersByStatusAndDealId({
      status,
      dealId,
      defaultStatuses,
    }: {
      status?: string | string[]
      dealId?: string
      defaultStatuses?: boolean
    }) {
      const wanted = defaultStatuses
        ? ['NEW', 'PARTIALLY_FILLED']
        : status
          ? [status].flat()
          : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async baseAssetPrecision() {
      return 4
    }
    async getLatestPrice() {
      return CURRENT_PRICE
    }
    async getUsdRate() {
      return 1
    }
    /**
     * Out of scope here: this suite is about which SAFETY orders survive, and
     * the take profit is appended after that selection is made.
     */
    async getTPOrder() {
      return []
    }
    async createInitialDealOrders() {
      return initialOrders()
    }
    async cancelOrderOnExchange(o: any) {
      this.cancelled.push(o.clientOrderId)
      return { ...o, status: 'CANCELED' }
    }
    async sendGridToExchange(grid: any) {
      this.sentGrids.push(grid)
      return {
        clientOrderId: 'D-RO-executed',
        dealId: DEAL_ID,
        typeOrder: TypeOrderEnum.dealRegular,
        status: 'FILLED',
        origQty: `${grid.qty}`,
        executedQty: `${grid.qty}`,
        price: `${grid.price}`,
        side: 'BUY',
        exchange: ExchangeEnum.binance,
      }
    }
    async processFilledOrder() {}
    shouldProceed() {
      return false
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug() {}
    handleWarn() {}
    handleErrors(m: any) {
      this.errors.push(typeof m === 'string' ? m : m?.message)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

/** The safety-order prices `createCurrentDealOrders` keeps, nearest first. */
const ladderPrices = async (orders: any[], dealDoc?: any) => {
  const bot: any = buildBot({ orders, dealDoc })
  const current = await bot.createCurrentDealOrders(
    SYMBOL,
    CURRENT_PRICE,
    initialOrders(),
    INITIAL_PRICE,
    INITIAL_PRICE,
    DEAL_ID,
    false,
    dealDoc ?? deal(),
  )
  return current
    .filter((o: any) => o.type === TypeOrderEnum.dealRegular)
    .map((o: any) => o.price)
}

/** What the whole remaining ladder costs — the reproduction's measurement. */
const requiredQuote = (prices: number[]) =>
  Math.round(
    prices.reduce(
      (sum, p) => sum + p * (LADDER.find((l) => l.price === p)?.qty ?? 0),
      0,
    ) * 10000,
  ) / 10000

describe('add funds and the configured DCA ladder (spec 031)', () => {
  before(function () {
    // One ts-node compile of a 23k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('createCurrentDealOrders', () => {
    it('baseline: an untouched deal has all four configured levels', async () => {
      const prices = await ladderPrices([
        BASE_ORDER,
        ...restingRows([1, 2, 3, 4]),
      ])
      expect(prices).to.deep.equal([2455.22, 2430.42, 2405.62, 2380.82])
      expect(requiredQuote(prices)).to.equal(300.0875)
    })

    it('§4.2 one add-funds fill leaves all four levels standing', async () => {
      // The defect: `left` fell to 3 and the SHALLOWEST level — 2455.22, the
      // 20-USDT one — was dropped, taking `assets.required.quote` to 280.2002.
      const prices = await ladderPrices(
        [BASE_ORDER, ADD_FUNDS_ORDER, ...restingRows([1, 2, 3, 4])],
        deal({
          levels: { all: 6, complete: 2 },
          funds: [{ price: 2480.02, qty: 0.004 }],
        }),
      )
      expect(prices).to.deep.equal([2455.22, 2430.42, 2405.62, 2380.82])
      expect(requiredQuote(prices)).to.equal(300.0875)
    })

    it('§4.2 two additions still leave all four', async () => {
      const second = {
        ...ADD_FUNDS_ORDER,
        clientOrderId: 'D-ROA-second',
        addFundsId: 'bb2d4f0c-cc15-42e9-8f30-a4603844d08e',
      }
      const prices = await ladderPrices(
        [BASE_ORDER, ADD_FUNDS_ORDER, second, ...restingRows([1, 2, 3, 4])],
        deal({
          levels: { all: 7, complete: 3 },
          funds: [
            { price: 2480.02, qty: 0.004 },
            { price: 2480.02, qty: 0.004 },
          ],
        }),
      )
      expect(prices).to.deep.equal([2455.22, 2430.42, 2405.62, 2380.82])
    })

    it('§4.3 a filled SAFETY order still retires its level, nearest first', async () => {
      const prices = await ladderPrices(
        [BASE_ORDER, FILLED_SAFETY_ORDER, ...restingRows([2, 3, 4])],
        deal({ levels: { all: 5, complete: 2 } }),
      )
      expect(prices).to.deep.equal([2430.42, 2405.62, 2380.82])
    })

    it('§4.3 a safety fill and an addition retire exactly one level', async () => {
      const prices = await ladderPrices(
        [
          BASE_ORDER,
          FILLED_SAFETY_ORDER,
          ADD_FUNDS_ORDER,
          ...restingRows([2, 3, 4]),
        ],
        deal({
          levels: { all: 6, complete: 3 },
          funds: [{ price: 2480.02, qty: 0.004 }],
        }),
      )
      expect(prices).to.deep.equal([2430.42, 2405.62, 2380.82])
    })
  })

  describe('executeNextDcaLevel — the counter this must not break (§5)', () => {
    it('§5.1 an untouched deal executes level 1', async () => {
      const bot: any = buildBot({
        orders: [BASE_ORDER, ...restingRows([1, 2, 3, 4])],
      })
      await bot.executeNextDcaLevel('bot', DEAL_ID)
      expect(bot.sentGrids.map((g: any) => g.levelNumber)).to.deep.equal([1])
      expect(bot.cancelled).to.deep.equal(['D-RO-level1'])
    })

    it('§5.2 after an add-funds fill it still executes level 1, not level 2', async () => {
      const bot: any = buildBot({
        orders: [BASE_ORDER, ADD_FUNDS_ORDER, ...restingRows([1, 2, 3, 4])],
        dealDoc: deal({
          levels: { all: 6, complete: 2 },
          funds: [{ price: 2480.02, qty: 0.004 }],
        }),
      })
      await bot.executeNextDcaLevel('bot', DEAL_ID)
      expect(bot.sentGrids.map((g: any) => g.levelNumber)).to.deep.equal([1])
      expect(bot.cancelled).to.deep.equal(['D-RO-level1'])
    })

    it('§4.3/§5.1 a real safety fill still advances it to level 2', async () => {
      const bot: any = buildBot({
        orders: [BASE_ORDER, FILLED_SAFETY_ORDER, ...restingRows([2, 3, 4])],
        dealDoc: deal({ levels: { all: 5, complete: 2 } }),
      })
      await bot.executeNextDcaLevel('bot', DEAL_ID)
      expect(bot.sentGrids.map((g: any) => g.levelNumber)).to.deep.equal([2])
    })

    it('§5.3 expectedLevel is compared against the corrected level', async () => {
      const bot: any = buildBot({
        orders: [BASE_ORDER, ADD_FUNDS_ORDER, ...restingRows([1, 2, 3, 4])],
        dealDoc: deal({
          levels: { all: 6, complete: 2 },
          funds: [{ price: 2480.02, qty: 0.004 }],
        }),
      })
      // The dashboard showed the user level 1, which is what is next.
      await bot.executeNextDcaLevel('bot', DEAL_ID, { expectedLevel: 1 })
      expect(bot.sentGrids.map((g: any) => g.levelNumber)).to.deep.equal([1])
      expect(bot.errors).to.deep.equal([])
    })

    it('§5.2 the last level stays reachable after an addition', async () => {
      // `levels.complete` 5 with one addition is ladder level 4 of 4 — the
      // uncorrected counter reads 5 and refuses it as past the end.
      const bot: any = buildBot({
        orders: [BASE_ORDER, ADD_FUNDS_ORDER, ...restingRows([4])],
        dealDoc: deal({
          levels: { all: 8, complete: 5 },
          funds: [{ price: 2480.02, qty: 0.004 }],
        }),
      })
      await bot.executeNextDcaLevel('bot', DEAL_ID)
      expect(bot.sentGrids.map((g: any) => g.levelNumber)).to.deep.equal([4])
      expect(bot.errors).to.deep.equal([])
    })
  })
})
