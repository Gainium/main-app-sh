process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `089.a-refilled-order-is-booked-into-the-grid-position-twice`.
 *
 * A futures grid bot folds every filled order into `data.position`
 * incrementally, and the fold is not keyed on the fill. An order delivered to
 * `processFilledOrder` twice — by the cancel/unknown-order race, the reconcile
 * sweep or `checkOrders` — is therefore added twice, and the take-profit close
 * is sized from the inflated quantity.
 *
 * The fixture is the reported bot: a paper `binanceUsdm` grid on `KOMAUSDT`,
 * standing at a signed net of -2820, receiving the six FILLED buys of 564 that
 * prod logged at `2026-09-21T06:57:48.198Z` (spec §2.1-§2.2). Booked once the
 * position is LONG 564 — the venue's own quantity, and the `executedQty` the
 * close came back with. Booked twice it is 3948, the `origQty` that was placed
 * (spec §2.3).
 *
 * `calculatePosition` is driven off the real mixin with a fake base class, and
 * borrows the real `calculateAbstractPosition` fold from `MainBot`. No Mongo,
 * Redis, venue or bot stack is needed. Harness shape copied from
 * `gridPositionValue.spec.ts` / `remainderDoubleCount.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotMarginTypeEnum,
  ExchangeEnum,
  PositionSide,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import MainBot from './main'

/** The signed net the tape stood at before the six buys (spec §2.1). */
const NET_BEFORE = -2820
/** Each of the six fills (spec §2.2). */
const FILL_QTY = 564
/** Booked once: -2820 + 6 × 564. The venue's quantity. */
const TRUE_QTY = 564
/** Booked twice: -2820 + 12 × 564. The `origQty` that was placed. */
const DOUBLE_BOOKED_QTY = 3948

/** The six prices prod logged, in delivery order (spec §2.2). */
const PRICES = [0.021885, 0.02064, 0.021047, 0.021462, 0.022316, 0.020242]
const IDS = [
  'GRID-RO-hCpb9e828FHuQ6LrH8FdEpox8lK',
  'GRID-RO-saE77F9VmPuBqFxP1DCxCH7HIs3',
  'GRID-RO-9smGjmvFdEbYUqOah7osK8nXNbI',
  'GRID-RO-uOEHweK1m4oxpFXTmlTJEkru2Ll',
  'GRID-RO-LMyHTtnHP1tz8zO73hYa6waR36D',
  'GRID-RO-fzqUfJ26W8bSfMhtbKVeoeBncvo',
]
/** The shared `updateTime` every one of the six carries. */
const FILL_TIME = 1789973868198

const fill = (i: number): any => ({
  clientOrderId: IDS[i],
  symbol: 'KOMAUSDT',
  side: 'BUY',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.regular,
  price: `${PRICES[i]}`,
  origQty: `${FILL_QTY}`,
  executedQty: `${FILL_QTY}`,
  updateTime: FILL_TIME,
})

const FILLS = IDS.map((_, i) => fill(i))

let Helper: any

const makeBot = () => {
  class TestBot extends (Helper as any) {
    public botId = '6aad003076fb82dc7f706cad'
    public math = new MathHelper()
    public data: any = {
      _id: '6aad003076fb82dc7f706cad',
      exchange: ExchangeEnum.paperBinanceUsdm,
      symbol: { symbol: 'KOMAUSDT', baseAsset: 'KOMA', quoteAsset: 'USDT' },
      settings: {
        pair: 'KOMAUSDT',
        futures: true,
        coinm: false,
        marginType: BotMarginTypeEnum.isolated,
        leverage: 1,
        profitCurrency: 'quote',
      },
      // The tape's state before the six buys: net short 2820 (spec §2.1).
      position: {
        side: PositionSide.SHORT,
        qty: Math.abs(NET_BEFORE),
        price: 0.0215,
      },
      positionHistory: [],
      profit: { total: 0, totalUsd: 0 },
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
    // Borrow the real position fold the grid depends on.
    calculateAbstractPosition = MainBot.prototype.calculateAbstractPosition
    async getExchangeInfo() {
      return {
        pair: 'KOMAUSDT',
        priceAssetPrecision: 6,
        baseAsset: { minAmount: 1, step: 1, name: 'KOMA' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDT' },
      }
    }
    async baseAssetPrecision() {
      return 0
    }
    updateData() {}
    emit() {}
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

/** Fold a list of orders through the real `calculatePosition`. */
const book = async (bot: any, orders: any[]) => {
  for (const o of orders) {
    await bot.calculatePosition(o)
  }
}

describe('a re-delivered fill booked into the grid position twice (spec 089)', () => {
  before(function () {
    // One ts-node compile of a 5k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§1.1 a fill is folded into the position once', () => {
    it('reaches the venue quantity when each fill is delivered once', async () => {
      const bot = makeBot()
      await book(bot, FILLS)
      expect(bot.data.position.side).to.equal(PositionSide.LONG)
      expect(bot.data.position.qty).to.be.closeTo(TRUE_QTY, 1e-6)
    })

    it('is unchanged when all six are re-delivered by the cancel race', async () => {
      // Spec §2.2: `cancelAllOrder(true)` walks a stale snapshot, the venue
      // answers "Order not found", and the unknown-order ladder hands every
      // one of the six straight back to `processFilledOrder`.
      const bot = makeBot()
      await book(bot, FILLS)
      await book(bot, FILLS)
      expect(bot.data.position.qty).to.not.be.closeTo(DOUBLE_BOOKED_QTY, 1e-6)
      expect(bot.data.position.side).to.equal(PositionSide.LONG)
      expect(bot.data.position.qty).to.be.closeTo(TRUE_QTY, 1e-6)
    })

    it('is unchanged when a single fill is re-delivered', async () => {
      const bot = makeBot()
      await book(bot, FILLS)
      const before = { ...bot.data.position }
      await book(bot, [fill(0)])
      expect(bot.data.position.qty).to.be.closeTo(before.qty, 1e-6)
      expect(bot.data.position.price).to.be.closeTo(before.price, 1e-12)
      expect(bot.data.position.side).to.equal(before.side)
    })

    it('still folds a genuinely new fill after a refused re-delivery', async () => {
      // The guard must not wedge the fold: a new clientOrderId still books.
      const bot = makeBot()
      await book(bot, FILLS)
      await book(bot, [fill(0)])
      await book(bot, [
        {
          ...fill(0),
          clientOrderId: 'GRID-RO-brand-new-order-id-000000000',
          side: 'SELL',
        },
      ])
      expect(bot.data.position.qty).to.be.closeTo(TRUE_QTY - FILL_QTY, 1e-6)
    })
  })

  describe('§2.3 the close is sized from the position', () => {
    it('sizes the close 564, not the 3948 that was placed', async () => {
      const bot = makeBot()
      await book(bot, FILLS)
      await book(bot, FILLS)
      // What `processSellAtStop` (`helper.ts:2848`) and the `closeBotByTp`
      // stop-and-sell path (`helper.ts:4680`) both read.
      expect(bot.data.position.qty).to.be.closeTo(564, 1e-6)
    })
  })

  describe('§2.3 the positionHistory trail', () => {
    it('writes one breakpoint per fill, not two', async () => {
      const bot = makeBot()
      await book(bot, FILLS)
      await book(bot, FILLS)
      expect(bot.data.positionHistory).to.have.length(FILLS.length)
      const last =
        bot.data.positionHistory[bot.data.positionHistory.length - 1]
      expect(last.qty).to.be.closeTo(TRUE_QTY, 1e-6)
      expect(last.time).to.equal(FILL_TIME)
    })
  })

  describe('§4.2 the rebuild seeds the guard', () => {
    it('does not re-book an order the start-time rebuild already summed', async () => {
      // `start()` runs `loadOrders()` — which rebuilds the position from the
      // order slice — and then `cancelAllOrder()`, re-delivery source (1).
      const bot = makeBot()
      bot.data.position = { side: PositionSide.SHORT, qty: 2820, price: 0.0215 }
      bot.data.position = await bot.calculatePositionForOrders(FILLS)
      bot.seedBookedPosition(FILLS)
      const rebuilt = { ...bot.data.position }
      await book(bot, FILLS)
      expect(bot.data.position.qty).to.be.closeTo(rebuilt.qty, 1e-6)
      expect(bot.data.position.side).to.equal(rebuilt.side)
    })
  })

  describe('§4.1 a spot grid folds nothing', () => {
    it('leaves the position alone and records nothing', async () => {
      const bot = makeBot()
      Object.defineProperty(bot, 'futures', {
        get: () => false,
        configurable: true,
      })
      const before = { ...bot.data.position }
      await book(bot, FILLS)
      expect(bot.data.position).to.deep.equal(before)
    })
  })
})
