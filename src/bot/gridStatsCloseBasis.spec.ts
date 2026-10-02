process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `124.neutral-grid-stats-value-the-position-against-the-close-entry`.
 *
 * Since spec `117` a NEUTRAL futures grid's value-changed TP/SL values the open
 * position against the unpaired-fills close entry, but the run-up / drawdown
 * (`GridMonitor`) and `liveStats` (`BotMonitor`) still valued it against
 * `position.price`. The monitor constants are the reported bot (spec §2.1);
 * the worker half drives the REAL `calculatePosition`, `tpSl()` refresh and
 * snapshot builders with a small ledger of the same shape. No Mongo, Redis,
 * venue or bot stack. Harness shape copied from `gridTpSlCloseBasis.spec.ts`
 * and `gridPositionValue.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotMarginTypeEnum,
  ExchangeEnum,
  FuturesStrategyEnum,
  PositionSide,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import MainBot from './main'
import { GridMonitor } from './gridMonitor'
import { botDb } from '../db/dbInit'
import { botMonitor } from './botMonitor'

/** Spec §2.1. */
const INITIAL_BALANCES = { base: 3630, quote: 164.837695 }
const INITIAL_PRICE = 0.03385086
const INITIAL_VALUE =
  INITIAL_BALANCES.base * INITIAL_PRICE + INITIAL_BALANCES.quote
const REALIZED = 6.738344617213632
const POSITION = { side: PositionSide.LONG, qty: 1210, price: 0.031526 }
const CLOSE_ENTRY = (0.033334 + 0.032525) / 2
/** Spec §2.2 — the 1m high after the last fill. */
const HIGH = 0.033343

const perc = (entry: number, price: number) =>
  (REALIZED + POSITION.qty * (price - entry)) / INITIAL_VALUE

const gridInput = (over: any = {}) => ({
  _id: 'grid-124',
  exchange: ExchangeEnum.paperBinanceUsdm,
  initialBalances: INITIAL_BALANCES,
  initialPrice: INITIAL_PRICE,
  currentBalances: { base: 4840, quote: 124.993 },
  realInitialBalances: INITIAL_BALANCES,
  settings: {
    marginType: BotMarginTypeEnum.isolated,
    leverage: 1,
    profitCurrency: 'quote',
  },
  position: { ...POSITION },
  closeEntry: { ...POSITION, entry: CLOSE_ENTRY },
  profit: { total: REALIZED },
  stats: {
    drawdownPercent: 0,
    runUpPercent: 0,
    timeInLoss: 0,
    timeInProfit: 0,
    trackTime: 0,
    timeCountStart: 0,
    currentCount: null,
  },
  ...over,
})

describe('a neutral grid stats value the position against the close entry (spec 124)', () => {
  describe('§2 the fixture is the reported bot', () => {
    it('average basis 3.11%, close basis 2.52% at the high', () => {
      expect(INITIAL_VALUE).to.be.closeTo(287.7163, 1e-3)
      expect(perc(POSITION.price, HIGH) * 100).to.be.closeTo(3.11, 0.005)
      expect(perc(CLOSE_ENTRY, HIGH) * 100).to.be.closeTo(2.52, 0.005)
    })
  })

  describe('§4.3 GridMonitor', () => {
    const monitor = GridMonitor.getInstance() as any
    const writes: any[] = []
    let original: any
    before(() => {
      original = (botDb as any).updateData
      ;(botDb as any).updateData = (_f: any, update: any) => {
        writes.push(update)
        return Promise.resolve({ status: StatusEnum.ok })
      }
    })
    after(() => {
      ;(botDb as any).updateData = original
    })
    beforeEach(() => {
      writes.length = 0
      monitor.stats.delete('grid-124')
    })

    const sampleThenFlush = async (bot: any, price: number) => {
      await monitor.addBotStats({ price: HIGH, time: 1_000 }, bot)
      await monitor.addBotStats({ price, time: 2_000 }, bot)
      await monitor.removeBotStats({ price, time: 3_000 }, bot)
      return writes[writes.length - 1].$max
    }

    it('records the close-basis run-up, not the average-basis one', async () => {
      const max = await sampleThenFlush(gridInput(), HIGH)
      expect(max['stats.runUpPercent'] * 100).to.be.closeTo(
        perc(CLOSE_ENTRY, HIGH) * 100,
        1e-6,
      )
      expect(max['stats.runUpPercent']).to.be.lessThan(0.03)
    })

    it('a price above position.price but below the close breakeven is a drawdown', async () => {
      // ≈0.02653: still up on the average basis, $1 down on the close basis.
      const price = CLOSE_ENTRY - (REALIZED + 1) / POSITION.qty
      expect(perc(POSITION.price, price)).to.be.greaterThan(0)
      const max = await sampleThenFlush(gridInput(), price)
      expect(max['stats.drawdownPercent']).to.be.closeTo(
        -perc(CLOSE_ENTRY, price),
        1e-9,
      )
    })

    it('§4.2 a closeEntry computed for another position is ignored', async () => {
      const stale = gridInput({
        closeEntry: { ...POSITION, qty: 605, entry: CLOSE_ENTRY },
      })
      const max = await sampleThenFlush(stale, HIGH)
      expect(max['stats.runUpPercent']).to.be.closeTo(
        perc(POSITION.price, HIGH),
        1e-9,
      )
    })

    it('§4.2 no closeEntry keeps position.price', async () => {
      const max = await sampleThenFlush(
        gridInput({ closeEntry: undefined }),
        HIGH,
      )
      expect(max['stats.runUpPercent']).to.be.closeTo(
        perc(POSITION.price, HIGH),
        1e-9,
      )
    })
  })

  describe('§4.4 BotMonitor.calculateGridLiveStats', () => {
    let written: any
    let originalUpdate: any
    let originalPrices: any
    before(() => {
      originalUpdate = (botDb as any).updateData
      ;(botDb as any).updateData = (_f: any, update: any) => {
        written = update
        return Promise.resolve({ status: StatusEnum.ok })
      }
      originalPrices = (botMonitor as any).getLatestPrices
      ;(botMonitor as any).getLatestPrices = async () => [
        { pair: 'AKEUSDT', price: HIGH },
      ]
    })
    after(() => {
      ;(botDb as any).updateData = originalUpdate
      ;(botMonitor as any).getLatestPrices = originalPrices
    })

    const liveBot = (over: any = {}) => ({
      _id: 'grid-124-live',
      stats: {},
      symbol: { symbol: 'AKEUSDT', baseAsset: 'AKE', quoteAsset: 'USDT' },
      initialBalances: INITIAL_BALANCES,
      initialPrice: INITIAL_PRICE,
      usdRate: 1,
      exchange: ExchangeEnum.paperBinanceUsdm,
      profit: {
        total: REALIZED,
        totalUsd: REALIZED,
        freeTotal: REALIZED,
        freeTotalUsd: REALIZED,
      },
      status: 'open',
      position: { ...POSITION },
      closeEntry: { ...POSITION, entry: CLOSE_ENTRY },
      currentBalances: { base: 4840, quote: 124.993 },
      workingShift: [{ start: Date.now() - 86_400_000 }],
      settings: {
        profitCurrency: 'quote',
        marginType: BotMarginTypeEnum.isolated,
        leverage: 1,
        budget: 300,
        pair: 'AKEUSDT',
        futures: true,
      },
      ...over,
    })

    it('values the position against the close entry', async () => {
      await botMonitor.calculateGridLiveStats({ bot: liveBot() as any })
      expect(written.liveStats.valueChangePerc).to.be.closeTo(
        perc(CLOSE_ENTRY, HIGH) * 100,
        0.006,
      )
    })

    it('keeps position.price without a matching closeEntry', async () => {
      await botMonitor.calculateGridLiveStats({
        bot: liveBot({ closeEntry: undefined }) as any,
      })
      expect(written.liveStats.valueChangePerc).to.be.closeTo(
        perc(POSITION.price, HIGH) * 100,
        0.006,
      )
    })
  })

  describe('§4.1 the worker publishes the entry tpSl() uses', () => {
    /** [clientOrderId, side, price, updateTime] — two unpaired BUYs + one pair. */
    type Fill = [string, 'BUY' | 'SELL', number, number]
    const FILLS: Fill[] = [
      ['GRID-RO-a', 'BUY', 0.030964, 1],
      ['GRID-RO-u1', 'BUY', 0.033334, 2],
      ['GRID-RO-u2', 'BUY', 0.032525, 3],
      ['GRID-RO-b', 'SELL', 0.031748, 4],
    ]
    const PAIRS: [string, string][] = [['GRID-RO-a', 'GRID-RO-b']]
    let Helper: any

    before(function () {
      this.timeout(180000)
      Helper = createRequire(__filename)('./helper').default(
        class {
          constructor(..._a: any[]) {}
        } as any,
      )
    })

    const makeBot = (opts: { futuresStrategy?: FuturesStrategyEnum } = {}) => {
      const order = ([clientOrderId, side, price, updateTime]: Fill) => ({
        clientOrderId,
        symbol: 'AKEUSDT',
        side,
        status: 'FILLED',
        typeOrder: TypeOrderEnum.regular,
        price: `${price}`,
        origQty: '605',
        executedQty: '605',
        updateTime,
      })
      class TestBot extends (Helper as any) {
        public botId = 'grid-124'
        public userId = 'user'
        public math = new MathHelper()
        public order = order
        public updates: any[] = []
        public emits: any[] = []
        public data: any = {
          _id: 'grid-124',
          userId: 'user',
          exchange: ExchangeEnum.paperBinanceUsdm,
          symbol: { symbol: 'AKEUSDT', baseAsset: 'AKE', quoteAsset: 'USDT' },
          settings: {
            pair: 'AKEUSDT',
            futures: true,
            coinm: false,
            futuresStrategy:
              opts.futuresStrategy ?? FuturesStrategyEnum.neutral,
            marginType: BotMarginTypeEnum.isolated,
            leverage: 1,
            profitCurrency: 'quote',
            budget: 300,
            tpSl: true,
            tpSlCondition: 'valueChanged',
            tpPerc: 0.03,
            sl: true,
            slCondition: 'valueChanged',
            slPerc: -0.04,
          },
          initialBalances: INITIAL_BALANCES,
          initialPrice: INITIAL_PRICE,
          currentBalances: { base: 4840, quote: 124.993 },
          position: { side: PositionSide.LONG, qty: 0, price: 0 },
          positionHistory: [],
          profit: {
            total: REALIZED,
            totalUsd: REALIZED,
            freeTotal: REALIZED,
            freeTotalUsd: REALIZED,
          },
        }
        public ordersDb: any = {
          readData: () =>
            Promise.resolve({
              status: StatusEnum.ok,
              data: { result: FILLS.map(order) },
            }),
        }
        public transactionDb: any = {
          readData: () =>
            Promise.resolve({
              status: StatusEnum.ok,
              data: {
                result: PAIRS.map(([idBuy, idSell]) => ({ idBuy, idSell })),
              },
            }),
        }
        get futures() {
          return true
        }
        get coinm() {
          return false
        }
        get currentLeverage() {
          return 1
        }
        get isShort() {
          return false
        }
        calculateAbstractPosition = MainBot.prototype.calculateAbstractPosition
        async getExchangeInfo() {
          return {
            pair: 'AKEUSDT',
            priceAssetPrecision: 6,
            baseAsset: { minAmount: 1, step: 1, name: 'AKE' },
            quoteAsset: { minAmount: 5, step: 0.000001, name: 'USDT' },
          }
        }
        async baseAssetPrecision() {
          return 0
        }
        updateData(update: any) {
          this.updates.push(update)
        }
        emit(event: string, payload: any) {
          this.emits.push([event, payload])
        }
        handleLog() {}
        handleDebug() {}
        handleWarn() {}
        handleErrors() {}
      }
      return new (TestBot as any)()
    }

    const settle = () => new Promise((r) => setTimeout(r, 20))

    const loaded = async (opts?: { futuresStrategy?: FuturesStrategyEnum }) => {
      const bot = makeBot(opts)
      for (const fill of FILLS) {
        await bot.calculatePosition(bot.order(fill))
      }
      bot.tpSl(HIGH)
      await settle()
      return bot
    }

    it('persists, emits and snapshots the close entry', async () => {
      const bot = await loaded()
      const { position } = bot.data
      expect(position.price).to.not.be.closeTo(CLOSE_ENTRY, 1e-6)
      const expected = { ...position, entry: CLOSE_ENTRY }
      expect(bot.data.closeEntry.entry).to.be.closeTo(CLOSE_ENTRY, 1e-12)
      const persisted = bot.updates.find((u: any) => u.closeEntry)
      expect(persisted.closeEntry).to.deep.equal(bot.data.closeEntry)
      expect(
        bot.emits.find(
          ([e, p]: any) => e === 'bot settings update' && p.closeEntry,
        )[1].closeEntry,
      ).to.deep.equal(bot.data.closeEntry)
      expect(bot.gridStatsSnapshot().closeEntry).to.deep.equal(
        bot.data.closeEntry,
      )
      expect(bot.data.closeEntry.side).to.equal(expected.side)
      expect(bot.data.closeEntry.qty).to.equal(expected.qty)
      expect(bot.data.closeEntry.price).to.equal(expected.price)
    })

    it('§4.6 a LONG-strategy grid publishes nothing', async () => {
      const bot = await loaded({ futuresStrategy: FuturesStrategyEnum.long })
      expect(bot.data.closeEntry).to.equal(undefined)
      expect(bot.updates.find((u: any) => u.closeEntry)).to.equal(undefined)
    })
  })
})
