process.env.NODE_ENV = 'testing'

/**
 * Spec 255: a DCA deal restored from the Redis snapshot whose safety orders
 * hold their PRICE as their quantity.
 *
 * Before spec 252, `dcaHelper.afterUpdateExchangeInfo` re-rounded each level's
 * price into `qty` whenever a venue lowered a pair's base precision, and saved
 * the result to the `deals` snapshot. A cold restart rebuilds a restored
 * deal's ladder from that snapshot as stored, so every restart sent the level
 * again ("qty 2940 @ 2940").
 *
 * Drives the REAL DCA `loadOrders` (cold-restart branch:
 * `serviceRestart && !secondRestart`), the REAL `repairRestoredLadder` and the
 * REAL `createInitialDealOrders`. Redis and Mongo are stubs; the ladder the
 * restore hands to `createCurrentDealOrders` is recorded. Harness shape from
 * `coldRestartDealSnapshot.spec.ts` (spec 151). Ids are synthetic.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  OrderSizeTypeEnum,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../../types'
import { MathHelper } from '../../utils/math'

const BOT_ID = '000000000000000000000b53'
const DEAL_ID = '000000000000000000000d53'
const SYMBOL = 'ETHUSDT'
const settings: any = {
  useDca: true,
  futures: false,
  coinm: false,
  orderSizeType: OrderSizeTypeEnum.quote,
  orderSize: '100',
  baseOrderSize: '100',
  ordersCount: 5,
  step: '2',
  stepScale: '1',
  volumeScale: '1.5',
  tpPerc: '1',
  useTp: true,
  strategy: StrategyEnum.long,
  profitCurrency: 'quote',
}

let Helper: any

const dealDoc = () =>
  ({
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    symbol: { symbol: SYMBOL, baseAsset: 'ETH', quoteAsset: 'USDT' },
    settings: { ...settings, avgPrice: 3000 },
    initialPrice: 3000,
    lastPrice: 2990,
    avgPrice: 3000,
    currentBalances: { base: 0, quote: 0 },
    profit: { total: 0, totalUsd: 0 },
    levels: { all: 5, complete: 0 },
  }) as any

const buildBot = (snapshotLadder?: any[]) => {
  const notices: string[] = []
  const warns: string[] = []
  const restored: any[][] = []
  let snapshot: any[] = []
  class TestBot extends (Helper as any) {
    math = new MathHelper()
    botId = BOT_ID
    userId = '000000000000000000000a53'
    combo = false
    loadingComplete = true
    serviceRestart = true
    secondRestart = false
    pairs = new Set([SYMBOL])
    data: any = {
      settings: { ...settings, name: 'bot', pair: [SYMBOL] },
      status: 'open',
      exchange: 'binance',
      flags: [],
    }
    orders = new Map<string, any>()
    dealsDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        data: { result: [] },
      }),
      countData: async () => ({ status: StatusEnum.ok, data: { result: 1 } }),
    }
    ordersDb = {
      readData: async () => ({ status: StatusEnum.ok, data: { result: [] } }),
    }
    async getFromRedis(key: string) {
      return key === 'deals' ? JSON.parse(JSON.stringify(snapshot)) : null
    }
    async _loadOrders() {
      return []
    }
    setOrder(o: any) {
      this.orders.set(o.clientOrderId, o)
    }
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    setOrdersToRedis() {}
    setDealToRedis() {}
    saveDeal() {}
    scheduleDcaIndicatorSync() {}
    async baseAssetPrecision() {
      return 4
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        priceAssetPrecision: 2,
        maxOrders: 500,
        baseAsset: { minAmount: 0.0001, step: 0.0001, name: 'ETH' },
        quoteAsset: { minAmount: 5, step: 0.01, name: 'USDT' },
      }
    }
    async getAggregatedSettings() {
      return settings
    }
    get isLong() {
      return true
    }
    get futures() {
      return false
    }
    get coinm() {
      return false
    }
    findBaseOrderByDeal() {
      return undefined
    }
    async profitBase() {
      return false
    }
    async createCurrentDealOrders(_s: string, _p: number, initial: any[]) {
      restored.push(initial.map((g) => ({ ...g })))
      return initial
    }
    async getCommDeal() {
      return 0
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    shouldProceed() {
      return true
    }
    getOrderId(prefix: string) {
      return prefix
    }
    async postUserNotice(m: string) {
      notices.push(m)
    }
    emit() {
      return true
    }
    handleLog() {}
    handleWarn(m: string) {
      warns.push(m)
    }
    handleDebug() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new (TestBot as any)()
  return {
    bot,
    notices,
    warns,
    restored,
    setSnapshot: (ladder: any[]) => {
      snapshot = [
        {
          deal: dealDoc(),
          initialOrders: ladder,
          currentOrders: ladder,
          previousOrders: [],
        },
      ]
    },
    snapshotLadder,
  }
}

/** The ladder the deal opened with: the real builder, as at deal start. */
const openedLadder = async () => {
  const { bot } = buildBot()
  return (await bot.createInitialDealOrders(
    SYMBOL,
    3000,
    DEAL_ID,
    dealDoc(),
  )) as any[]
}

const regular = (l: any[]) =>
  l.filter((g) => g.type === TypeOrderEnum.dealRegular)

describe('DCA restored ladder with qty = price (spec 255)', () => {
  before(function () {
    this.timeout(300000)
    Helper = createRequire(__filename)('../dcaHelper').default()
  })

  it('§3.1 a cold restart re-sizes every level whose qty is its price and tells the user once', async () => {
    const opened = await openedLadder()
    expect(regular(opened)).to.have.length(5)
    const corrupted = opened.map((g) =>
      g.type === TypeOrderEnum.dealRegular ? { ...g, qty: g.price } : g,
    )
    const { bot, notices, restored, setSnapshot } = buildBot()
    setSnapshot(corrupted)
    await bot.loadOrders()
    expect(restored).to.have.length(1)
    const out = regular(restored[0])
    // Stored prices are kept; quantities are the deal's own sizing again.
    expect(out.map((g) => g.price)).to.deep.equal(
      regular(opened).map((g) => g.price),
    )
    expect(out.map((g) => g.qty)).to.deep.equal(
      regular(opened).map((g) => g.qty),
    )
    expect(notices).to.have.length(1)
    expect(notices[0]).to.match(/5 safety order\(s\)/)
    // What the next snapshot stores is the repaired ladder.
    expect(regular(bot.getDeal(DEAL_ID).initialOrders)).to.deep.equal(out)
  })

  it('§3.2 only the corrupted levels change', async () => {
    const opened = await openedLadder()
    const corrupted = opened.map((g, i) =>
      g.type === TypeOrderEnum.dealRegular && i === 2
        ? { ...g, qty: g.price }
        : g,
    )
    const { bot, notices, restored, setSnapshot } = buildBot()
    setSnapshot(corrupted)
    await bot.loadOrders()
    expect(restored[0]).to.deep.equal(opened)
    expect(notices).to.have.length(1)
    expect(notices[0]).to.match(/1 safety order\(s\)/)
  })

  it('§3.3 a healthy restored ladder passes through unchanged, with no message', async () => {
    const opened = await openedLadder()
    // A ladder a user re-sized by hand is healthy too, even 50x off.
    const healthy = opened.map((g, i) =>
      i === 0 ? { ...g, qty: +(g.qty * 50).toFixed(4) } : g,
    )
    const { bot, notices, warns, restored, setSnapshot } = buildBot()
    setSnapshot(healthy)
    await bot.loadOrders()
    expect(restored[0]).to.deep.equal(healthy)
    expect(notices).to.deep.equal([])
    expect(warns.filter((w) => /safety order/.test(w))).to.deep.equal([])
  })

  it('§3.4 a level whose size cannot be re-derived is never guessed: no fresh ladder, stored ladder kept', async () => {
    const opened = await openedLadder()
    const corrupted = opened.map((g) =>
      g.type === TypeOrderEnum.dealRegular ? { ...g, qty: g.price } : g,
    )
    const { bot, notices, restored, setSnapshot } = buildBot()
    bot.createInitialDealOrders = async () => []
    setSnapshot(corrupted)
    await bot.loadOrders()
    expect(restored[0]).to.deep.equal(corrupted)
    expect(notices).to.deep.equal([])
  })
})
