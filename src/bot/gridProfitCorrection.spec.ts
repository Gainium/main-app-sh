process.env.NODE_ENV = 'testing'

/**
 * Core spec 284 — an out-of-band correction to a running GRID bot's profit,
 * and what the grid worker does with a fill row repaired in the database.
 *
 * Drives the REAL grid mixin (`helper.ts`) over a fake base class:
 *  §2 `applyProfitCorrection` moves profit, the booking counters and the
 *     futures position once per id, persists them, and places nothing;
 *  §3 the real `loadOrders` (the start/restart path) given a row that is
 *     FILLED in the database but was never processed by the worker: it does
 *     not hand the row to `processFilledOrder`, does not move `lastFilled`
 *     when a newer fill exists, folds it into the rebuilt position once, and
 *     — when the row has its transaction — never seeds it into the order map.
 *
 * Every placement / cancel / fill entry point throws, so any path that would
 * place a counter order fails the test instead of passing silently.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotFlags,
  BotType,
  ExchangeEnum,
  PositionSide,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import MainBot from './main'
import {
  addGridProfitCorrection,
  invalidGridProfitCorrection,
} from './profitCorrection'
import schema from '../db/schema'

const BOT_ID = '000000000000000000000284'
const PAIR = 'ETH-USD'
const REPAIRED = 'GRID-RO-repairedSellRepairedSell0001'
const NEWER = 'GRID-RO-newerBuyNewerBuyNewerBuy00002'

/** A LONG futures grid sell booked against the position price (§1). */
const POS_PRICE = 2393.4
const FILL = {
  clientOrderId: REPAIRED,
  side: 'SELL' as const,
  qty: 0.005,
  price: 2226.8,
  updateTime: 1793331577559,
  fee: { base: 0.000001, quote: 0.0022268 },
}
/** 0.005 × (2226.8 − 2393.4) − 0.005 × 2226.8 × 0.0002, worked by hand. */
const DELTA_TOTAL = -0.8352268
const DELTA = {
  total: DELTA_TOTAL,
  totalUsd: DELTA_TOTAL,
  pureBase: 0,
  pureQuote: 0,
}

let Helper: any

const forbidden = (name: string) =>
  function () {
    throw new Error(`${name} must not run`)
  }

type Calls = {
  updates: any[]
  redis: [string, any][]
  profitRows: [number, number, any][]
  emits: [string, any][]
}

const makeBot = (over: Record<string, unknown> = {}) => {
  const calls: Calls = { updates: [], redis: [], profitRows: [], emits: [] }
  const orders = new Map<string, any>()
  class TestBot extends (Helper as any) {
    public botId = BOT_ID
    public botType = BotType.grid
    public math = new MathHelper()
    public loadingComplete = true
    public restart = true
    public serviceRestart = false
    public secondRestart = false
    public calls = calls
    public ordersMap = orders
    public data: any = {
      _id: BOT_ID,
      status: 'range',
      exchange: ExchangeEnum.krakenUsdm,
      symbol: { symbol: PAIR, baseAsset: 'ETH', quoteAsset: 'USD' },
      settings: {
        pair: PAIR,
        futures: true,
        coinm: false,
        profitCurrency: 'quote',
        newProfit: true,
      },
      flags: [BotFlags.feeByAsset],
      feePaid: { base: 0.01, quote: 1 },
      position: { side: PositionSide.LONG, qty: 0.226, price: POS_PRICE },
      positionHistory: [],
      transactionsCount: { buy: 136, sell: 120 },
      profit: {
        total: -21.6,
        totalUsd: -21.9,
        freeTotal: -17.8,
        freeTotalUsd: -18.1,
        pureBase: 0,
        pureQuote: 0,
      },
      ...over,
    }
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    get profitBase() {
      return false
    }
    calculateAbstractPosition = MainBot.prototype.calculateAbstractPosition
    async getExchangeInfo() {
      return {
        pair: PAIR,
        priceAssetPrecision: 1,
        baseAsset: { minAmount: 0.001, step: 0.001, name: 'ETH' },
        quoteAsset: { minAmount: 0.1, step: 0.1, name: 'USD' },
      }
    }
    async baseAssetPrecision() {
      return 3
    }
    async updateData(d: any) {
      calls.updates.push(d)
    }
    async setToRedis(key: string, v: any) {
      calls.redis.push([key, JSON.parse(JSON.stringify(v))])
    }
    saveProfitToDb(usd: number, time: number, fiat?: any) {
      calls.profitRows.push([usd, time, fiat])
    }
    emit(e: string, d: any) {
      calls.emits.push([e, d])
    }
    setOrder(o: any) {
      orders.set(o.clientOrderId, o)
    }
    setOrdersToRedis() {}
    async startFunding() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    // Every way an order reaches the venue, or a fill reaches the books.
    processFilledOrder = forbidden('processFilledOrder')
    createTransaction = forbidden('createTransaction')
    limitOrders = forbidden('limitOrders')
    placeRegularOrder = forbidden('placeRegularOrder')
    sendOrderToExchange = forbidden('sendOrderToExchange')
    cancelAllOrder = forbidden('cancelAllOrder')
    cancelOrderOnExchange = forbidden('cancelOrderOnExchange')
  }
  return new (TestBot as any)()
}

describe('core spec 284 — grid profit correction', function () {
  before(function () {
    // One ts-node compile of a 6k-line module over a 13k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1 pure helpers', () => {
    it('moves total and free totals by the same delta', () => {
      const p = addGridProfitCorrection(
        { total: 1, totalUsd: 2, freeTotal: 3, freeTotalUsd: 4 },
        DELTA,
      )
      expect(p.total).to.be.closeTo(1 + DELTA_TOTAL, 1e-12)
      expect(p.totalUsd).to.be.closeTo(2 + DELTA_TOTAL, 1e-12)
      expect(p.freeTotal).to.be.closeTo(3 + DELTA_TOTAL, 1e-12)
      expect(p.freeTotalUsd).to.be.closeTo(4 + DELTA_TOTAL, 1e-12)
    })
    it('falls back from a 0 free total to total, as createTransaction does', () => {
      const p = addGridProfitCorrection(
        { total: 5, totalUsd: 6, freeTotal: 0, freeTotalUsd: 0 },
        DELTA,
      )
      expect(p.freeTotal).to.be.closeTo(5 + DELTA_TOTAL, 1e-12)
      expect(p.freeTotalUsd).to.be.closeTo(6 + DELTA_TOTAL, 1e-12)
    })
    it('refuses pureBase/pureQuote, which a grid booking zeroes', () => {
      expect(
        invalidGridProfitCorrection({ ...DELTA, pureBase: 1 }, 'c'),
      ).to.match(/pureBase/)
    })
    it('the grid bot schema declares profitCorrections (strict $set keeps the id)', () => {
      expect(schema.bot.path('profitCorrections'), 'bots field').to.exist
    })
    it('refuses a malformed fill', () => {
      expect(
        invalidGridProfitCorrection(DELTA, 'c', { ...FILL, qty: 0 }),
      ).to.match(/fill.qty/)
      expect(
        invalidGridProfitCorrection(DELTA, 'c', { ...FILL, side: 'X' }),
      ).to.match(/fill.side/)
      expect(
        invalidGridProfitCorrection(DELTA, 'c', { ...FILL, fee: undefined }),
      ).to.match(/fill.fee/)
      expect(invalidGridProfitCorrection(DELTA, 'c', FILL)).to.equal(null)
    })
  })

  describe('§2 applyProfitCorrection on a running grid bot', () => {
    it('adds the delta in memory, persists it and records the id', async () => {
      const bot = makeBot()
      expect(await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)).to.equal(
        'applied',
      )
      expect(bot.data.profit.total).to.be.closeTo(-21.6 + DELTA_TOTAL, 1e-12)
      expect(bot.data.profit.totalUsd).to.be.closeTo(-21.9 + DELTA_TOTAL, 1e-12)
      expect(bot.data.profit.freeTotal).to.be.closeTo(-17.8 + DELTA_TOTAL, 1e-12)
      expect(bot.data.profit.freeTotalUsd).to.be.closeTo(
        -18.1 + DELTA_TOTAL,
        1e-12,
      )
      expect(bot.data.profitCorrections).to.deep.equal(['c1'])
      const persisted = bot.calls.updates.find((u: any) => u.profitCorrections)
      expect(persisted.profit.total).to.equal(bot.data.profit.total)
      expect(persisted.profitCorrections).to.deep.equal(['c1'])
      const [key, snap] = bot.calls.redis[0]
      expect(key).to.equal('botData')
      expect(snap.profit.total).to.equal(bot.data.profit.total)
      expect(snap.profitCorrections).to.deep.equal(['c1'])
    })

    it('books the fill counters: count, position, feePaid, hourly profit', async () => {
      const bot = makeBot()
      await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)
      expect(bot.data.transactionsCount).to.deep.equal({ buy: 136, sell: 121 })
      // A reduction keeps the LONG average and lowers the size.
      expect(bot.data.position.side).to.equal(PositionSide.LONG)
      expect(bot.data.position.qty).to.be.closeTo(0.221, 1e-9)
      expect(bot.data.position.price).to.equal(POS_PRICE)
      expect(bot.data.feePaid.base).to.be.closeTo(0.010001, 1e-12)
      expect(bot.data.feePaid.quote).to.be.closeTo(1.0022268, 1e-12)
      expect(bot.calls.profitRows).to.deep.equal([
        [DELTA_TOTAL, FILL.updateTime, { asset: 'USD', amount: DELTA_TOTAL }],
      ])
      // Snapshot carries the position the restart would otherwise rebuild.
      expect(bot.calls.redis[0][1].position.qty).to.be.closeTo(0.221, 1e-9)
    })

    it('leaves feePaid alone on a bot that does not book fees by asset', async () => {
      const bot = makeBot({ flags: [] })
      await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)
      expect(bot.data.feePaid).to.deep.equal({ base: 0.01, quote: 1 })
    })

    it('is a no-op on a repeat of the same id', async () => {
      const bot = makeBot()
      await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)
      const total = bot.data.profit.total
      const qty = bot.data.position.qty
      const rows = bot.calls.profitRows.length
      expect(await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)).to.equal(
        'duplicate',
      )
      expect(bot.data.profit.total).to.equal(total)
      expect(bot.data.position.qty).to.equal(qty)
      expect(bot.data.transactionsCount.sell).to.equal(121)
      expect(bot.calls.profitRows.length).to.equal(rows)
    })

    it('does not fold a fill the position already holds (restart first)', async () => {
      const bot = makeBot()
      bot.seedBookedPosition([{ clientOrderId: REPAIRED }])
      expect(await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)).to.equal(
        'applied',
      )
      expect(bot.data.position.qty).to.equal(0.226)
      expect(bot.data.profit.total).to.be.closeTo(-21.6 + DELTA_TOTAL, 1e-12)
    })

    it('refuses before loading completes and on a non-grid bot', async () => {
      const loading = makeBot()
      loading.loadingComplete = false
      expect(
        await loading.applyProfitCorrection(DELTA, 'test', 'c1', FILL),
      ).to.match(/^refused: bot data not loaded/)
      expect(loading.data.profit.total).to.equal(-21.6)
      const dca = makeBot()
      dca.botType = BotType.dca
      expect(await dca.applyProfitCorrection(DELTA, 'test', 'c1')).to.match(
        /^refused: only a grid bot/,
      )
      const bad = makeBot()
      expect(
        await bad.applyProfitCorrection({ ...DELTA, pureQuote: 1 }, 'test', 'c1'),
      ).to.match(/^refused: .*pureBase/)
      expect(bad.data.profitCorrections).to.equal(undefined)
    })
  })

  describe('§3 loadOrders with a row repaired to FILLED in the database', () => {
    const order = (o: Record<string, unknown>): Record<string, any> => ({
      symbol: PAIR,
      typeOrder: TypeOrderEnum.regular,
      status: 'FILLED',
      ...o,
    })
    /** Builds the position the rebuild starts from: one 0.231 buy. */
    const ROWS = [
      order({
        clientOrderId: 'GRID-RO-entryBuy',
        side: 'BUY',
        price: `${POS_PRICE}`,
        origPrice: `${POS_PRICE}`,
        origQty: '0.231',
        executedQty: '0.231',
        updateTime: 1793000000000,
      }),
      order({
        clientOrderId: REPAIRED,
        side: 'SELL',
        price: '2226.8',
        origPrice: '2226.8',
        origQty: '0.005',
        executedQty: '0.005',
        updateTime: FILL.updateTime,
      }),
      order({
        clientOrderId: NEWER,
        side: 'BUY',
        price: '2203.6',
        origPrice: '2203.6',
        origQty: '0.005',
        executedQty: '0.005',
        updateTime: 1794174663825,
      }),
      order({
        clientOrderId: 'GRID-RO-resting',
        side: 'SELL',
        status: 'NEW',
        price: '2249.4',
        origPrice: '2249.4',
        origQty: '0.005',
        executedQty: '0',
        updateTime: 1794174664000,
      }),
    ]
    const withDbs = (bot: any, transactions: any[]) => {
      bot._loadOrders = async () => ROWS.map((r) => ({ ...r }))
      bot.ordersDb = {
        // `lastFilled`: the newest FILLED regular/swap row.
        readData: async () => ({
          status: StatusEnum.ok,
          data: {
            result: ROWS.filter((r) => r.status === 'FILLED').sort(
              (a, b) => (b.updateTime as number) - (a.updateTime as number),
            )[0],
          },
        }),
      }
      bot.transactionDb = {
        readData: async () => ({
          status: StatusEnum.ok,
          data: { result: transactions },
        }),
      }
      return bot
    }
    const booked = [
      { idBuy: 'GRID-RO-entryBuy', idSell: 'position price' },
      { idBuy: NEWER, idSell: 'position price' },
    ]

    it('rebuilds the position with the repaired sell and places nothing', async () => {
      const bot = withDbs(makeBot(), [
        ...booked,
        { idBuy: 'position price', idSell: REPAIRED },
      ])
      await bot.loadOrders()
      // 0.231 − 0.005 + 0.005: the repaired sell is in, once.
      expect(bot.data.position.qty).to.be.closeTo(0.231, 1e-9)
      expect(bot.positionBooked.has(REPAIRED)).to.equal(true)
      // `lastFilled` is the newer fill: the grid is anchored where it was.
      expect(bot.lastFilled.clientOrderId).to.equal(NEWER)
      // Only the resting order is tracked; the booked fill is not seeded.
      expect([...bot.ordersMap.keys()]).to.deep.equal(['GRID-RO-resting'])
    })

    it('control: without its transaction the row is seeded as an unpaired FILLED fill', async () => {
      const bot = withDbs(makeBot(), booked)
      await bot.loadOrders()
      expect(bot.ordersMap.get(REPAIRED)?.status).to.equal('FILLED')
    })

    it('a correction after that restart books profit but not the position again', async () => {
      const bot = withDbs(makeBot(), [
        ...booked,
        { idBuy: 'position price', idSell: REPAIRED },
      ])
      await bot.loadOrders()
      const qty = bot.data.position.qty
      expect(await bot.applyProfitCorrection(DELTA, 'test', 'c1', FILL)).to.equal(
        'applied',
      )
      expect(bot.data.position.qty).to.equal(qty)
      expect(bot.data.profit.total).to.be.closeTo(-21.6 + DELTA_TOTAL, 1e-12)
    })
  })
})
