process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `287.neutral-grid-without-value-changed-tpsl-values-the-position-on-its-unpaired-fills`.
 *
 * A NEUTRAL futures grid books realized profit per matched grid pair, so the
 * coins it still holds are worth what its unpaired fills cost. Spec 124
 * published that entry (`closeEntry`) only for grids with a value-changed
 * TP/SL; every other neutral grid was valued on `position.price`. The ledger
 * here has the reported shape (a grid bought into a fall, the bounces paired
 * the lowest buys): fills are folded through the REAL `calculatePosition`,
 * the refreshes are the REAL `processFilledOrder` / `updateLiveStats`, the
 * close is the REAL `profitAfterPositionClosed`. No Mongo, Redis, venue or bot
 * stack. Harness shape copied from `gridTpSlCloseBasis.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after } from 'mocha'
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
import { botMonitor } from './botMonitor'
import { gridPositionEntry } from './gridCloseEntry'

/** [clientOrderId, side, price, updateTime] */
type Fill = [string, 'BUY' | 'SELL', number, number]

const QTY = 10
const FILLS: Fill[] = [
  ['GRID-B-100', 'BUY', 1.0, 1790000001000],
  ['GRID-B-098', 'BUY', 0.98, 1790000002000],
  ['GRID-B-096a', 'BUY', 0.96, 1790000003000],
  ['GRID-S-098a', 'SELL', 0.98, 1790000004000],
  ['GRID-B-096b', 'BUY', 0.96, 1790000005000],
  ['GRID-S-098b', 'SELL', 0.98, 1790000006000],
]
/** [idBuy, idSell]: each bounce paired the buy one level below it. */
const PAIRS: [string, string][] = [
  ['GRID-B-096a', 'GRID-S-098a'],
  ['GRID-B-096b', 'GRID-S-098b'],
]
const REALIZED = PAIRS.length * QTY * (0.98 - 0.96)
/** The unpaired fills: BUY 10 @ 1.00 and BUY 10 @ 0.98. */
const UNPAIRED_ENTRY = 0.99
const MARK = 0.95

/** What the fills did, gross: cash in/out plus the position at the mark. */
const fillsValueAt = (mark: number) => {
  let cash = 0
  let qty = 0
  for (const [, side, price] of FILLS) {
    cash += side === 'SELL' ? price * QTY : -price * QTY
    qty += side === 'BUY' ? QTY : -QTY
  }
  return cash + qty * mark
}

let Helper: any
let liveStats: any[] = []
const realLiveStats = botMonitor.calculateGridLiveStats

const makeBot = (
  opts: {
    futuresStrategy?: FuturesStrategyEnum
    valueChangedTpSl?: boolean
    coinm?: boolean
  } = {},
) => {
  const order = ([clientOrderId, side, price, updateTime]: Fill) => ({
    clientOrderId,
    symbol: 'XUSDT',
    side,
    status: 'FILLED',
    typeOrder: TypeOrderEnum.regular,
    price: `${price}`,
    origPrice: `${price}`,
    origQty: `${QTY}`,
    executedQty: `${QTY}`,
    updateTime,
  })
  const tpSl = !!opts.valueChangedTpSl
  class TestBot extends (Helper as any) {
    public botId = 'bot'
    public userId = 'user'
    public math = new MathHelper()
    public ordersRead = 0
    public persisted: Fill[] = []
    public paired: [string, string][] = []
    public updates: any[] = []
    public emits: [string, any][] = []
    public order = order
    public data: any = {
      _id: 'bot',
      userId: 'user',
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      symbol: { symbol: 'XUSDT', baseAsset: 'X', quoteAsset: 'USDT' },
      settings: {
        pair: 'XUSDT',
        futures: true,
        coinm: !!opts.coinm,
        futuresStrategy: opts.futuresStrategy ?? FuturesStrategyEnum.neutral,
        marginType: BotMarginTypeEnum.cross,
        leverage: 1,
        profitCurrency: 'quote',
        tpSl,
        tpSlCondition: 'valueChanged',
        tpPerc: 0.5,
        sl: tpSl,
        slCondition: 'valueChanged',
        slPerc: -0.5,
      },
      initialBalances: { base: 0, quote: 100 },
      initialPrice: 1,
      position: { side: PositionSide.LONG, qty: 0, price: 0 },
      positionHistory: [],
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    public ordersDb: any = {
      readData: () => {
        this.ordersRead += 1
        return Promise.resolve({
          status: StatusEnum.ok,
          data: { result: this.persisted.map(order) },
        })
      },
    }
    public transactionDb: any = {
      readData: () =>
        Promise.resolve({
          status: StatusEnum.ok,
          data: {
            result: this.paired.map(([idBuy, idSell]) => ({ idBuy, idSell })),
          },
        }),
    }
    get futures() {
      return true
    }
    get coinm() {
      return !!opts.coinm
    }
    get isBitget() {
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
        pair: 'XUSDT',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 1, name: 'X' },
        quoteAsset: { minAmount: 5, step: 0.00001, name: 'USDT' },
      }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    shouldProceed() {
      return true
    }
    setStatsTimer() {}
    saveProfitToDb() {}
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
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

/** Every fill folded and persisted, its round trips booked; no refresh yet. */
const loaded = async (opts: Parameters<typeof makeBot>[0] = {}) => {
  const bot = makeBot(opts)
  for (const fill of FILLS) {
    await bot.calculatePosition(bot.order(fill))
  }
  bot.persisted = [...FILLS]
  bot.paired = [...PAIRS]
  bot.data.profit.total = REALIZED
  return bot
}

/** The last fill arrives through the real `processFilledOrder`. */
const lastFillArrives = async (opts: Parameters<typeof makeBot>[0] = {}) => {
  const bot = makeBot(opts)
  const last = FILLS[FILLS.length - 1]
  for (const fill of FILLS.slice(0, -1)) {
    await bot.calculatePosition(bot.order(fill))
  }
  bot.persisted = FILLS.slice(0, -1)
  bot.paired = PAIRS.slice(0, -1)
  bot.data.profit.total = REALIZED
  Object.assign(bot, {
    loadingComplete: true,
    ordersInProgress: new Set(),
    isLastOrder: () => false,
    createTransaction: async () => {
      await new Promise((r) => setTimeout(r, 5))
      bot.paired = [...PAIRS]
    },
  })
  bot.persisted = [...FILLS]
  await bot.processFilledOrder(bot.order(last), last[3], true)
  await settle()
  return bot
}

const settle = () => new Promise((r) => setTimeout(r, 20))

let statsTime = 1
const sampleLiveStats = async (bot: any) => {
  statsTime += 60000
  await bot.updateLiveStats(bot.botId, statsTime)
}

const closeAt = async (bot: any, price: number) => {
  const qty = bot.data.position.qty
  await bot.profitAfterPositionClosed({
    clientOrderId: 'GRID-TP-close',
    symbol: 'XUSDT',
    side: 'SELL',
    status: 'FILLED',
    typeOrder: TypeOrderEnum.stop,
    price: `${price}`,
    origQty: `${qty}`,
    executedQty: `${qty}`,
    updateTime: FILLS[FILLS.length - 1][3] + 1,
  })
  return bot.data.profit.total
}

describe('a neutral grid without a value-changed TP/SL values its position on its unpaired fills (spec 287)', () => {
  before(function () {
    this.timeout(180000)
    const mod = createRequire(__filename)('./helper')
    Helper = mod.default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
    ;(botMonitor as any).calculateGridLiveStats = async (p: any) => {
      liveStats.push(p)
    }
  })
  after(() => {
    ;(botMonitor as any).calculateGridLiveStats = realLiveStats
  })

  describe('§2 the fixture has the reported shape', () => {
    it('position.price is the all-fills average, the close entry the unpaired fills', async () => {
      const bot = await loaded()
      expect(bot.data.position.side).to.equal(PositionSide.LONG)
      expect(bot.data.position.qty).to.equal(20)
      expect(bot.data.position.price).to.be.closeTo(0.97333, 1e-9)
      expect(await bot.closeEntryPrice('')).to.be.closeTo(UNPAIRED_ENTRY, 1e-9)
    })
  })

  describe('§4.1 a fill publishes closeEntry with TP and SL off', () => {
    it('persists and emits the unpaired entry for the current position', async () => {
      const bot = await lastFillArrives()
      const { position } = bot.data
      expect(bot.data.closeEntry, 'closeEntry published').to.not.equal(
        undefined,
      )
      expect(bot.data.closeEntry).to.include({
        side: position.side,
        qty: position.qty,
        price: position.price,
      })
      expect(bot.data.closeEntry.entry).to.be.closeTo(UNPAIRED_ENTRY, 1e-9)
      expect(
        bot.updates.find((u: any) => u.closeEntry)?.closeEntry,
      ).to.deep.equal(bot.data.closeEntry)
      expect(
        bot.emits.find(
          ([e, p]: any) => e === 'bot settings update' && p.closeEntry,
        )?.[1].closeEntry,
      ).to.deep.equal(bot.data.closeEntry)
    })
  })

  describe('§4.2 a position no fill refreshed is published by the live-stats sample', () => {
    it('the first sample after a restart carries the unpaired entry', async () => {
      const bot = await loaded()
      liveStats = []
      await sampleLiveStats(bot)
      expect(bot.ordersRead).to.equal(1)
      expect(liveStats).to.have.length(1)
      const sent = liveStats[0].bot
      expect(gridPositionEntry(sent.position, sent.closeEntry)).to.be.closeTo(
        UNPAIRED_ENTRY,
        1e-9,
      )
    })

    it('later samples reuse it and read nothing', async () => {
      const bot = await loaded()
      await sampleLiveStats(bot)
      await sampleLiveStats(bot)
      await sampleLiveStats(bot)
      expect(bot.ordersRead).to.equal(1)
    })

    it('a fill-refreshed position is not read again by the sample', async () => {
      const bot = await lastFillArrives()
      const reads = bot.ordersRead
      await sampleLiveStats(bot)
      expect(bot.ordersRead).to.equal(reads)
    })
  })

  describe('§4.3 realized + unrealized equals what the fills did', () => {
    it(`at mark ${MARK}`, async () => {
      const bot = await lastFillArrives()
      const { position, closeEntry, profit } = bot.data
      const entry = gridPositionEntry(position, closeEntry)
      const unrealized = position.qty * (MARK - entry)
      expect(profit.total + unrealized).to.be.closeTo(fillsValueAt(MARK), 1e-9)
      // The average basis this replaces does not add up.
      const onAverage = profit.total + position.qty * (MARK - position.price)
      expect(Math.abs(onAverage - fillsValueAt(MARK))).to.be.greaterThan(0.3)
    })
  })

  describe('§4.4 the close booking is unchanged', () => {
    it('books the same profit with TP/SL off as with value-changed TP/SL, on the unpaired entry', async () => {
      const off = await lastFillArrives()
      const on = await lastFillArrives({ valueChangedTpSl: true })
      const bookedOff = await closeAt(off, MARK)
      const bookedOn = await closeAt(on, MARK)
      expect(bookedOff).to.equal(bookedOn)
      expect(bookedOff).to.be.closeTo(
        REALIZED + 20 * (MARK - UNPAIRED_ENTRY),
        1e-9,
      )
      expect(bookedOff).to.be.closeTo(fillsValueAt(MARK), 1e-9)
    })
  })

  describe('§4.5 LONG/SHORT-strategy and COIN-M grids are unchanged', () => {
    for (const [name, opts] of [
      ['LONG strategy', { futuresStrategy: FuturesStrategyEnum.long }],
      ['SHORT strategy', { futuresStrategy: FuturesStrategyEnum.short }],
      ['COIN-M', { coinm: true }],
    ] as const) {
      it(`${name}: publishes nothing and reads nothing`, async () => {
        const bot = await lastFillArrives(opts)
        await sampleLiveStats(bot)
        expect(bot.data.closeEntry).to.equal(undefined)
        expect(bot.updates.find((u: any) => u.closeEntry)).to.equal(undefined)
        expect(bot.ordersRead).to.equal(0)
      })
    }
  })
})
