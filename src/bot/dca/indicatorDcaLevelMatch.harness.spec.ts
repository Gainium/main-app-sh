process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec `032` — an add-funds fill must not move a deal past
 * the indicator signal it is waiting for.
 *
 * Drives the REAL `dcaHelper.addDCAOrderByIndicator` over the reproduction's
 * state, captured on the paper stack 2026-09-10 (deal
 * `6aa25708bddc789145b3e76e`, SOL/USDT, `dcaCondition: indicators`, three
 * `startDca` indicators = three ladder levels):
 *
 *   D-BO-fDllGjO…   dealStart    FILLED  0.198 @ 101.58
 *   D-ROA-8V0Wnw…   dealRegular  FILLED  0.098 @ 101.53   addFundsId ac5fd9fc-…
 *
 *   levels 1/4 -> 2/4 across that one addition, with NO safety order consumed.
 *
 * Signal 1 arrives as `index` 0 and tests `levels.complete === 1`; signal 2 as
 * `index` 1 and tests `=== 2`. So the addition alone hands the deal to the
 * wrong signal.
 *
 * `createDCABotHelper` is a mixin factory, so the helper is built on a minimal
 * base class: no stack, DB, Redis or exchange connection is needed.
 * `sendGridToExchange` is a recorder — nothing here places anything.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, TypeOrderEnum, OrderSideEnum } from '../../../types'
import { createRequire } from 'module'

const DEAL_ID = '6aa25708bddc789145b3e76e'
const SYMBOL = 'SOLUSDT'
const INITIAL_PRICE = 101.58
/** Below `deal.lastPrice`, so the indicator's `minPercFromLast` gate opens. */
const CURRENT_PRICE = 100.5

/** Three `startDca` indicators — the ladder, one level each. */
const indicators: any[] = [0, 1, 2].map((i) => ({
  type: 'RSI',
  indicatorLength: 14,
  indicatorValue: `${100 - i}`,
  indicatorCondition: 'lt',
  indicatorInterval: '1m',
  groupId: `grp-${i}`,
  uuid: `${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}-1111-4111-8111-111111111111`,
  indicatorAction: 'startDca',
  section: 'dca',
  minPercFromLast: '0.01',
}))

const settings: any = {
  dcaCondition: 'indicators',
  indicators,
  ordersCount: 3,
  activeOrdersCount: 3,
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
  baseAsset: { minAmount: 0.001, step: 0.001, asset: 'SOL' },
  quoteAsset: { minAmount: 5, step: 0.01, asset: 'USDT' },
  priceAssetPrecision: 2,
}

/** The three ladder levels, as `createInitialDealOrders` numbers them. */
const LADDER = [
  { levelNumber: 1, price: 100.56, qty: 0.198 },
  { levelNumber: 2, price: 99.55, qty: 0.402 },
  { levelNumber: 3, price: 98.54, qty: 0.812 },
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

// The deal's order rows are quoted in the header for evidence, not used here:
// `addDCAOrderByIndicator` decides entirely from the deal document — its
// `levels` counter and its `funds` ledger — and never reads the order map.

const deal = (over: any = {}): any => ({
  _id: DEAL_ID,
  symbol: { symbol: SYMBOL, baseAsset: 'SOL', quoteAsset: 'USDT' },
  status: 'open',
  levels: { all: 4, complete: 1 },
  funds: [],
  reduceFunds: [],
  flags: [],
  initialPrice: INITIAL_PRICE,
  // Above `CURRENT_PRICE`, so `minPercFromLast` is satisfied for a long.
  lastPrice: INITIAL_PRICE,
  avgPrice: INITIAL_PRICE,
  settings: { avgPrice: INITIAL_PRICE },
  tpSlTargetFilled: [],
  dynamicAr: [],
  currentBalances: { base: 0.198, quote: 0 },
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

const buildBot = (dealDoc: any) => {
  class TestBot extends Helper {
    public sentGrids: any[] = []

    /** The real symbol/status index, over this one fixture deal. */
    getDealsByStatusAndSymbol({
      status,
      symbol,
    }: {
      status?: string | string[]
      symbol?: string
    }) {
      const wantStatus = status ? [status].flat() : undefined
      const match =
        (!symbol || symbol === SYMBOL) &&
        (!wantStatus || wantStatus.includes(dealDoc.status))
      return match
        ? [{ deal: dealDoc, initialOrders: initialOrders(), currentOrders: [] }]
        : []
    }
    async getAggregatedSettings() {
      return settings
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
    async createInitialDealOrders() {
      return initialOrders()
    }
    async sendGridToExchange(grid: any) {
      this.sentGrids.push(grid)
      return {
        clientOrderId: `D-RO-fired-${grid.levelNumber}`,
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
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}

/**
 * Fire `startDca` signal `index` and report the ladder level it bought, if any.
 * `time` is unique per call so the method's own replay guard never suppresses
 * a case.
 */
let clock = 1_700_000_000_000
const fireSignal = async (dealDoc: any, index: number) => {
  const bot: any = buildBot(dealDoc)
  await bot.addDCAOrderByIndicator('bot', index, SYMBOL, ++clock)
  return bot.sentGrids.map((g: any) => g.levelNumber)
}

describe('indicator DCA level match after add funds (spec 032)', () => {
  before(function () {
    // One ts-node compile of a 23k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('a deal that has taken no add funds — §4.3', () => {
    it('answers signal 1 by buying level 1', async () => {
      expect(await fireSignal(deal(), 0)).to.deep.equal([1])
    })

    it('and ignores signal 2', async () => {
      expect(await fireSignal(deal(), 1)).to.deep.equal([])
    })

    it('after one safety fill it answers signal 2 with level 2', async () => {
      const d = deal({ levels: { all: 4, complete: 2 } })
      expect(await fireSignal(d, 1)).to.deep.equal([2])
      expect(
        await fireSignal(deal({ levels: { all: 4, complete: 2 } }), 0),
      ).to.deep.equal([])
    })
  })

  describe('after one add-funds fill — §4.1', () => {
    /** The reproduction's exact state: complete 2, one addition, no level spent. */
    const afterAdd = () =>
      deal({
        levels: { all: 4, complete: 2 },
        funds: [{ price: 101.53, qty: 0.098 }],
      })

    it('§4.1 still answers signal 1', async () => {
      expect(await fireSignal(afterAdd(), 0)).to.deep.equal([1])
    })

    it('§4.2 and the level it buys is level 1', async () => {
      const bot: any = buildBot(afterAdd())
      await bot.addDCAOrderByIndicator('bot', 0, SYMBOL, ++clock)
      expect(bot.sentGrids).to.have.length(1)
      expect(bot.sentGrids[0].levelNumber).to.equal(1)
      expect(bot.sentGrids[0].qty).to.equal(0.198)
    })

    it('§4.1 and does NOT answer signal 2 — that would skip level 1', async () => {
      expect(await fireSignal(afterAdd(), 1)).to.deep.equal([])
    })

    it('two additions still leave it on signal 1', async () => {
      const d = deal({
        levels: { all: 4, complete: 3 },
        funds: [
          { price: 101.53, qty: 0.098 },
          { price: 101.4, qty: 0.098 },
        ],
      })
      expect(await fireSignal(d, 0)).to.deep.equal([1])
      expect(await fireSignal(d, 2)).to.deep.equal([])
    })

    it('an addition on top of a real safety fill lands on signal 2', async () => {
      const d = deal({
        levels: { all: 4, complete: 3 },
        funds: [{ price: 101.53, qty: 0.098 }],
      })
      expect(await fireSignal(d, 1)).to.deep.equal([2])
    })
  })

  describe('an addition flagged as consuming a level — §4.4', () => {
    it('does advance the deal to the next signal, on purpose', async () => {
      const d = deal({
        levels: { all: 4, complete: 2 },
        funds: [{ price: 101.53, qty: 0.098, consumesLadderLevel: true }],
      })
      expect(await fireSignal(d, 1)).to.deep.equal([2])
      expect(await fireSignal(d, 0)).to.deep.equal([])
    })
  })
})
