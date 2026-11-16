process.env.NODE_ENV = 'testing'

/**
 * Spec 244 — several indicator conditions per DCA level, through the REAL
 * engine: the ladder size and per-level sizes (`createInitialDealOrders`),
 * the order a fired level places (`addDCAOrderByIndicator`) and which level
 * a set of active conditions fires (`checkIndicatorStatus`). Harness shaped
 * like changeDcaLevelsIndicatorLadder.harness.spec.ts: no stack, DB, Redis
 * or exchange; orders go to recorders.
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

const rsi = (uuid: string, groupId: string, dcaLevel: string, extra = {}) => ({
  type: 'RSI',
  indicatorLength: 14,
  indicatorValue: '30',
  indicatorCondition: 'lt',
  indicatorInterval: '1m',
  groupId,
  uuid,
  dcaLevel,
  indicatorAction: 'startDca',
  section: 'dca',
  ...extra,
})
/**
 * Two levels. L1: `L1 or (mfi and cci)` sized 30 at 1 %. L2: one condition
 * sized 50 at 2 %. Before spec 244 this read as four levels.
 */
const indicators: any[] = [
  rsi('L1', 'g1', 'L1', { orderSize: '30', minPercFromLast: '1' }),
  rsi('mfi', 'g2', 'L1'),
  rsi('L2', 'g3', 'L2', { orderSize: '50', minPercFromLast: '2' }),
  rsi('cci', 'g2', 'L1'),
]
const indicatorGroups: any[] = [
  {
    id: 'g1',
    logic: 'and',
    action: 'startDca',
    section: 'dca',
    dcaLevel: 'L1',
  },
  {
    id: 'g2',
    logic: 'and',
    action: 'startDca',
    section: 'dca',
    dcaLevel: 'L1',
    join: 'or',
  },
  {
    id: 'g3',
    logic: 'and',
    action: 'startDca',
    section: 'dca',
    dcaLevel: 'L2',
  },
]

const baseSettings: any = {
  strategy: 'LONG',
  indicators,
  indicatorGroups,
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
  indicators = new Map()
  indicatorGroupsToUse: any[] = []
  indicatorActions: any = {
    dcaOrder: new Map(),
    startDeal: new Map(),
    closeDealSl: new Map(),
    closeDealTp: new Map(),
    stopBot: new Map(),
    startBot: new Map(),
  }
  data: any = {
    exchange: ExchangeEnum.binance,
    flags: [],
    paperContext: true,
  }
  constructor(..._a: any[]) {}
  /**
   * MainBot's diff, reduced to what a recorder needs: a count-only edit
   * (spec 196) hands `placeOrders` this diff instead of the full rebuild.
   */
  findDiff(newGrids: any[], oldGrids: any[]) {
    const same = (a: any, b: any) => a.price === b.price && a.side === b.side
    return {
      new: newGrids.filter((n) => !oldGrids.some((o) => same(n, o))),
      cancel: oldGrids.filter((o) => !newGrids.some((n) => same(n, o))),
    }
  }
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
  return bot.sentGrids.map((g: any) => ({
    level: g.levelNumber,
    quote: Math.round(g.qty * CURRENT_PRICE),
  }))
}

const regular = async (bot: any, findDeal: any) =>
  (
    await bot.createInitialDealOrders(
      SYMBOL,
      INITIAL_PRICE,
      DEAL_ID,
      findDeal.deal,
    )
  ).filter((o: any) => o.type === TypeOrderEnum.dealRegular)

/** `checkIndicatorStatus` is debounced (RunWithDelay 500 ms): call, then wait it out. */
const runStatus = async (bot: any) => {
  bot.checkIndicatorStatus(
    'bot',
    SYMBOL,
    { time: ++clock },
    '1m',
    'dca',
    'startDca',
  )
  await new Promise((r) => setTimeout(r, 700))
}

/** Load every condition on SYMBOL; `on` lists the ones currently met. */
const arm = (bot: any, on: string[]) => {
  bot.indicators = new Map()
  for (const i of indicators) {
    const key = `${i.uuid}@${SYMBOL}`
    bot.indicators.set(key, {
      key,
      uuid: i.uuid,
      symbol: SYMBOL,
      groupId: i.groupId,
      action: 'startDca',
      interval: '1m',
      status: on.includes(i.uuid),
    })
  }
  bot.indicatorGroupsToUse = indicatorGroups
  bot.indicatorActions.dcaOrder = new Map()
}

const firedLevels = async (bot: any, on: string[]) => {
  arm(bot, on)
  const calls: number[] = []
  bot.addDCAOrderByIndicator = async (_b: string, index: number) => {
    calls.push(index)
  }
  bot.saveIndicatorsData = () => undefined
  await runStatus(bot)
  return calls
}

describe('DCA indicator levels in the engine (spec 244)', () => {
  before(function () {
    // One ts-node compile of a large module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§1.10 the ladder has one level per dcaLevel, not per indicator', async () => {
    const { bot, findDeal } = buildBot(INDICATORS, 0)
    expect(bot.dcaLadderSize(INDICATORS)).to.equal(2)
    expect(
      (await regular(bot, findDeal)).map((o: any) => o.levelNumber),
    ).to.deep.equal([1, 2])
  })

  it('§1.1 each level is sized and spaced from its anchor', async () => {
    const { bot, findDeal } = buildBot(INDICATORS, 0)
    const orders = await regular(bot, findDeal)
    expect(orders.map((o: any) => Math.round(o.qty * o.price))).to.deep.equal([
      30, 50,
    ])
    expect(orders.map((o: any) => o.price)).to.deep.equal([99, 97.02])
  })

  it('§1.9 the deal snapshot holds one entry per level', () => {
    const { bot } = buildBot(INDICATORS, 0)
    expect(bot.dcaIndicatorLevel(INDICATORS, 1)).to.include({ orderSize: '50' })
    expect(bot.dcaIndicatorLevel(INDICATORS, 2)).to.equal(undefined)
  })

  it('§1.2 level 2 fires its own order, sized from its anchor', async () => {
    const { bot } = buildBot(INDICATORS, 1)
    expect(await fire(bot, 1)).to.deep.equal([{ level: 2, quote: 50 }])
  })

  describe('§1.4 which level fires: L1 = RSI or (MFI and CCI)', () => {
    const cases: [string[], number[]][] = [
      [['L1'], [0]],
      [['mfi'], []],
      [['mfi', 'cci'], [0]],
      [['L2'], [1]],
      [['mfi', 'L2'], [1]],
    ]
    for (const [on, expected] of cases) {
      it(`active ${JSON.stringify(on)} → levels ${JSON.stringify(expected)}`, async () => {
        const { bot } = buildBot(INDICATORS, 0)
        expect(await firedLevels(bot, on)).to.deep.equal(expected)
      })
    }
  })

  it('§1.6 an AND group with an unloaded leg cannot fire', async () => {
    const { bot } = buildBot(INDICATORS, 0)
    arm(bot, ['mfi', 'cci'])
    bot.indicators.delete(`cci@${SYMBOL}`)
    const calls: number[] = []
    bot.addDCAOrderByIndicator = async (_b: string, index: number) => {
      calls.push(index)
    }
    bot.saveIndicatorsData = () => undefined
    await runStatus(bot)
    expect(calls).to.deep.equal([])
  })

  it('§1.7 a deal subscribes every condition of the level it reached', () => {
    const { bot } = buildBot(INDICATORS, 0)
    const due = [...bot.dueDcaIndicatorKeys({ ...INDICATORS })].sort()
    expect(due).to.deep.equal(['L1', 'cci', 'mfi'].map((u) => `${u}@${SYMBOL}`))
    const { bot: next } = buildBot(INDICATORS, 1)
    expect([...next.dueDcaIndicatorKeys({ ...INDICATORS })]).to.deep.equal([
      `L2@${SYMBOL}`,
    ])
  })

  it('§1.3 a legacy bot still reads one level per indicator', async () => {
    const legacy = {
      ...INDICATORS,
      indicators: indicators.map(({ dcaLevel: _d, ...i }) => ({
        ...i,
        groupId: 'shared',
      })),
      indicatorGroups: [
        { id: 'shared', logic: 'and', action: 'startDca', section: 'dca' },
      ],
    }
    const { bot } = buildBot(legacy, 0)
    expect(bot.dcaLadderSize(legacy)).to.equal(4)
  })
})
