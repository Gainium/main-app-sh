process.env.NODE_ENV = 'testing'

/**
 * Spec 247: a safety order the venue cancels after it rested is placed back.
 *
 * The fixture is a Combo long deal on a tokenized-stock pair whose venue
 * clears every resting order once a day. Three levels had filled; the
 * level-4 safety order (BUY 0.1076 @ 466.72) rested from 01:04 until the daily
 * cancel at 01:00 the next day. Nothing placed it back, and the price later
 * traded through 466.72 with no order resting. Ids and the pair are synthetic.
 *
 * Covers the decision shared by every engine (`isVenueCancelToReplace`), the
 * level match (`venueCanceledSafetyLevel`), the `MainBot` queue (borrowed off
 * its prototype) and the REAL `dcaHelper` hook built on a stub base.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'
import {
  BotStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../../types'
import MainBot from '../main'
import {
  isVenueCancelToReplace,
  venueCanceledSafetyLevel,
} from '../venueCancelReplace'

const DEAL_ID = 'deal-stock-combo'
const SYMBOL = 'RXYZUSDT'
const PLACED_AT = 1795050288267
const CANCELED_AT = 1795136401309

/** The cancel report as `processOrderQueue` hands it over. */
const canceled = (over: Record<string, unknown> = {}): any => ({
  clientOrderId: 'CMB-RO-live-level-4',
  orderId: '7001',
  symbol: SYMBOL,
  dealId: DEAL_ID,
  botId: 'bot',
  typeOrder: TypeOrderEnum.dealRegular,
  dcaLevel: 4,
  status: 'CANCELED',
  type: 'LIMIT',
  side: 'BUY',
  origQty: '0.1076',
  executedQty: '0',
  price: '466.72',
  origPrice: '466.72',
  transactTime: PLACED_AT,
  updateTime: CANCELED_AT,
  ...over,
})

/** The deal's ladder: smart orders, one active level after the last fill. */
const level4 = {
  number: 3,
  price: 466.72,
  qty: 0.1076,
  side: OrderSideEnum.buy,
  type: TypeOrderEnum.dealRegular,
  dcaLevel: 4,
  dealId: DEAL_ID,
  newClientOrderId: 'CMB-RO-ladder-4',
}

describe('venue-cancelled safety order is placed back (spec 247)', () => {
  describe('which cancel reports qualify', () => {
    it('a resting order cancelled with nothing executed', () => {
      expect(isVenueCancelToReplace(canceled(), false)).to.equal(true)
    })
    it("not the bot's own cancel", () => {
      expect(isVenueCancelToReplace(canceled(), true)).to.equal(false)
    })
    it('not an order refused as it was placed', () => {
      const refused = canceled({ updateTime: PLACED_AT + 300 })
      expect(isVenueCancelToReplace(refused, false)).to.equal(false)
    })
    it('not a cancel that executed part of the order', () => {
      expect(
        isVenueCancelToReplace(canceled({ executedQty: '0.01' }), false),
      ).to.equal(false)
    })
    it('not an EXPIRED order', () => {
      expect(
        isVenueCancelToReplace(canceled({ status: 'EXPIRED' }), false),
      ).to.equal(false)
    })
    it('not without timestamps (no evidence it rested)', () => {
      expect(
        isVenueCancelToReplace(canceled({ transactTime: undefined }), false),
      ).to.equal(false)
    })
  })

  describe('level match', () => {
    const match = (currentOrders: any[], resting: any[] = []) =>
      venueCanceledSafetyLevel({
        order: canceled(),
        currentOrders,
        resting,
        dealRegular: TypeOrderEnum.dealRegular,
      })
    it('finds the level the deal still wants', () => {
      expect(match([level4])).to.equal(level4)
    })
    it('nothing when the ladder moved on', () => {
      expect(match([{ ...level4, price: 440.1, dcaLevel: 5 }])).to.equal(
        undefined,
      )
    })
    it('nothing for a hidden (active-minigrid) level', () => {
      expect(match([{ ...level4, hide: true }])).to.equal(undefined)
    })
    it('nothing when an order already rests at that level', () => {
      const resting = {
        typeOrder: TypeOrderEnum.dealRegular,
        side: 'BUY',
        origPrice: '466.72',
        dcaLevel: 4,
        status: 'NEW',
      }
      expect(match([level4], [resting])).to.equal(undefined)
    })
    it('a grid level at the same price is not the safety order', () => {
      expect(match([{ ...level4, type: TypeOrderEnum.dealGrid }])).to.equal(
        undefined,
      )
    })
  })

  describe('MainBot queue', () => {
    const queueBot = (opts: { replaces?: boolean; status?: string } = {}) => {
      const handed: any[] = []
      const bot: any = {
        botId: 'bot',
        data: { status: opts.status ?? BotStatusEnum.open },
        ownCancels: new Map(),
        logs: [] as string[],
        handleLog(m: string) {
          this.logs.push(m)
        },
        handleWarn() {},
        shouldProceed: () => true,
        replacesVenueCancel: () => opts.replaces ?? true,
        async replaceVenueCanceled(o: any) {
          handed.push(o)
          return true
        },
        scheduleVenueCanceled() {},
      }
      const proto = MainBot.prototype as any
      for (const m of [
        'isOwnCancel',
        'noteOwnCancel',
        'noteVenueCancel',
        'flushVenueCanceled',
        'replaceVenueCanceledBatch',
      ]) {
        bot[m] = proto[m].bind(bot)
      }
      return { bot, handed }
    }

    it('queues a venue cancel and hands it to the engine once', async () => {
      const { bot, handed } = queueBot()
      bot.noteVenueCancel(canceled())
      bot.noteVenueCancel(canceled()) // the same report twice
      await bot.flushVenueCanceled()
      expect(handed).to.have.length(1)
      await bot.flushVenueCanceled()
      expect(handed).to.have.length(1)
    })
    it('skips an order type the engine does not opt into', async () => {
      const { bot, handed } = queueBot({ replaces: false })
      bot.noteVenueCancel(canceled())
      await bot.flushVenueCanceled()
      expect(handed).to.have.length(0)
    })
    it("skips the bot's own cancel", async () => {
      const { bot, handed } = queueBot()
      const o = canceled()
      bot.noteOwnCancel(o.clientOrderId)
      bot.noteVenueCancel(o)
      await bot.flushVenueCanceled()
      expect(handed).to.have.length(0)
    })
    it('places nothing for a bot that is not open', async () => {
      const { bot, handed } = queueBot({ status: BotStatusEnum.closed })
      bot.noteVenueCancel(canceled())
      await bot.flushVenueCanceled()
      expect(handed).to.have.length(0)
    })
  })

  describe('dcaHelper hook', () => {
    let Helper: any
    before(function () {
      this.timeout(180000)
      class FakeBase {
        math = new MathHelper()
        botId = 'bot'
        combo = true
        data: any = { exchange: ExchangeEnum.bitget, settings: {} }
        constructor(..._a: any[]) {}
      }
      Helper = createRequire(__filename)('../dcaHelper').default(
        FakeBase as any,
      )
    })

    const buildBot = (
      opts: {
        dealStatus?: string
        currentOrders?: any[]
        resting?: any[]
        closeBySl?: boolean
        combo?: boolean
      } = {},
    ) => {
      class TestBot extends Helper {
        placed: any[] = []
        combo = opts.combo ?? true
        full = {
          deal: {
            _id: DEAL_ID,
            status: opts.dealStatus ?? 'open',
            symbol: { symbol: SYMBOL, baseAsset: 'RXYZ', quoteAsset: 'USDT' },
          },
          initialOrders: [],
          currentOrders: opts.currentOrders ?? [level4],
          previousOrders: [],
          closeBySl: opts.closeBySl ?? false,
          closeByTp: false,
          notCheckSl: false,
        }
        getDeal(id: string) {
          return id === DEAL_ID ? this.full : undefined
        }
        getOrdersByStatusAndDealId() {
          return opts.resting ?? []
        }
        dealBookRebuildInFlight() {
          return false
        }
        getOrderId(prefix: string) {
          return `${prefix}-fresh`
        }
        async placeOrders(...a: any[]) {
          this.placed.push(a)
        }
        handleLog() {}
        handleDebug() {}
        handleWarn() {}
      }
      return new TestBot() as any
    }

    it('opts into safety orders only', () => {
      const bot = buildBot()
      expect(bot.replacesVenueCancel(canceled())).to.equal(true)
      expect(
        bot.replacesVenueCancel(canceled({ addFundsId: 'add-1' })),
      ).to.equal(false)
      expect(
        bot.replacesVenueCancel(
          canceled({ typeOrder: TypeOrderEnum.dealGrid }),
        ),
      ).to.equal(false)
      expect(
        bot.replacesVenueCancel(canceled({ typeOrder: TypeOrderEnum.dealTP })),
      ).to.equal(false)
    })

    it('places the level back with a fresh id (combo)', async () => {
      const bot = buildBot()
      expect(await bot.replaceVenueCanceled(canceled())).to.equal(true)
      expect(bot.placed).to.have.length(1)
      const [, symbol, dealId, orders] = bot.placed[0]
      expect(symbol).to.equal(SYMBOL)
      expect(dealId).to.equal(DEAL_ID)
      expect(orders.cancel).to.deep.equal([])
      expect(orders.new).to.have.length(1)
      expect(orders.new[0]).to.include({
        price: 466.72,
        qty: 0.1076,
        side: OrderSideEnum.buy,
        type: TypeOrderEnum.dealRegular,
        dcaLevel: 4,
        newClientOrderId: 'CMB-RO-fresh',
      })
    })

    it('uses the DCA prefix on a DCA bot', async () => {
      const bot = buildBot({ combo: false })
      await bot.replaceVenueCanceled(canceled())
      expect(bot.placed[0][3].new[0].newClientOrderId).to.equal('D-RO-fresh')
    })

    it('not on a deal that is not open', async () => {
      const bot = buildBot({ dealStatus: 'closed' })
      expect(await bot.replaceVenueCanceled(canceled())).to.equal(false)
      expect(bot.placed).to.have.length(0)
    })

    it('not on a deal that is closing', async () => {
      const bot = buildBot({ closeBySl: true })
      expect(await bot.replaceVenueCanceled(canceled())).to.equal(false)
      expect(bot.placed).to.have.length(0)
    })

    it('not when the ladder no longer has the level', async () => {
      const bot = buildBot({ currentOrders: [] })
      expect(await bot.replaceVenueCanceled(canceled())).to.equal(false)
      expect(bot.placed).to.have.length(0)
    })
  })
})
