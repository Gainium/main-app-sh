process.env.NODE_ENV = 'testing'

/**
 * Spec 271: a safety order refused for insufficient balance is retried on a
 * timer, as a limit at its level's own price, and recorded as skipped after
 * 24 h of refusals.
 *
 * The fixture is a DCA long deal on a USDT-M silver perpetual. Its level-20
 * buy at 47.61 was refused "Not enough balance" and nothing placed it again;
 * the price then fell through level 20 and level 21 (45.36) to 42.73. Ids are
 * synthetic.
 *
 * Covers the classification, the `MainBot` queue shared with the closed-market
 * retry (borrowed off its prototype): back-off, the retry pass while the bot
 * is in its soft `error` status, the 24 h give-up, one notice per pair per
 * spell, and which orders qualify. The REAL `dcaHelper` hooks are built on a
 * stub base: the level is placed back as a limit at its own price, two passed
 * levels are both sent in one pass, and a given-up level goes onto
 * `deal.missedLevels`.
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
import MainBot, { matchesNotEnoughBalance } from '../main'
import {
  BALANCE_REFUSAL_GIVE_UP_MS,
  MARKET_CLOSED_RETRY_MAX_MS,
  MARKET_CLOSED_RETRY_MIN_MS,
  balanceRefusalExpired,
} from '../marketClosedRetry'

const DEAL_ID = 'deal-silver-long'
const SYMBOL = 'XAGUSDT'

/** The refused safety order as `sendOrderToExchange` holds it. */
const refused = (over: Record<string, unknown> = {}): any => ({
  clientOrderId: 'D-RO-level-20',
  orderId: '-1',
  symbol: SYMBOL,
  dealId: DEAL_ID,
  botId: 'bot',
  typeOrder: TypeOrderEnum.dealRegular,
  ladderLevel: 20,
  status: 'NEW',
  type: 'LIMIT',
  side: 'BUY',
  origQty: '21.86',
  executedQty: '0',
  price: '47.61',
  origPrice: '47.61',
  ...over,
})

const level = (n: number, price: number, qty: number) => ({
  number: n - 1,
  levelNumber: n,
  price,
  qty,
  side: OrderSideEnum.buy,
  type: TypeOrderEnum.dealRegular,
  dealId: DEAL_ID,
  newClientOrderId: `D-RO-ladder-${n}`,
})
const level20 = level(20, 47.61, 21.86)
const level21 = level(21, 45.36, 24.94)

describe('safety order refused for balance is retried (spec 271)', () => {
  describe('§2 classification', () => {
    it('venue and local balance refusals are recognised', () => {
      for (const r of [
        'Not enough balance',
        'Insufficient balance',
        'Margin is insufficient.',
        'The order amount exceeds the balance',
        'EOrder:Insufficient funds',
      ]) {
        expect(matchesNotEnoughBalance(r), r).to.equal(true)
      }
      expect(matchesNotEnoughBalance('market is closed')).to.equal(false)
    })
    it('gives up after 24 h, not before', () => {
      expect(balanceRefusalExpired(0, BALANCE_REFUSAL_GIVE_UP_MS - 1)).to.equal(
        false,
      )
      expect(balanceRefusalExpired(0, BALANCE_REFUSAL_GIVE_UP_MS)).to.equal(
        true,
      )
    })
  })

  describe('MainBot queue', () => {
    const queueBot = (opts: { replaces?: boolean; status?: string } = {}) => {
      const handed: any[] = []
      const notices: string[] = []
      const delays: number[] = []
      const gaveUp: any[] = []
      const bot: any = {
        botId: 'bot',
        data: { status: opts.status ?? BotStatusEnum.open },
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
        async postUserNotice(m: string) {
          notices.push(m)
        },
        scheduleMarketClosedRetry(_b: string, delay: number) {
          delays.push(delay)
        },
        async giveUpBalanceRefusedLevel(o: any) {
          gaveUp.push(o)
        },
      }
      const proto = MainBot.prototype as any
      for (const m of [
        'holdRefusedForRetry',
        'noticeOncePerSpell',
        'noteBalanceRefusal',
        'noteMarketClosedRefusal',
        'flushMarketClosed',
        'replaceVenueCanceledBatch',
      ]) {
        bot[m] = proto[m].bind(bot)
      }
      return { bot, handed, notices, delays, gaveUp }
    }

    it('§3.1 keeps the level and places it again on the retry pass', async () => {
      const { bot, handed, delays } = queueBot()
      bot.noteBalanceRefusal(refused())
      expect(delays).to.deep.equal([MARKET_CLOSED_RETRY_MIN_MS])
      await bot.flushMarketClosed()
      expect(handed).to.have.length(1)
      expect(handed[0].origPrice).to.equal('47.61')
      await bot.flushMarketClosed()
      expect(handed).to.have.length(1)
    })

    it('§3.2 retries while the bot sits in its soft error status', async () => {
      const { bot, handed } = queueBot({ status: BotStatusEnum.error })
      bot.noteBalanceRefusal(refused())
      await bot.flushMarketClosed()
      expect(handed).to.have.length(1)
    })

    it('§3.2 places nothing for a bot that is stopped', async () => {
      const { bot, handed } = queueBot({ status: BotStatusEnum.closed })
      bot.noteBalanceRefusal(refused())
      await bot.flushMarketClosed()
      expect(handed).to.have.length(0)
    })

    it('§3.3 backs off 5 min doubling to 60 min', () => {
      const { bot, delays } = queueBot()
      for (let i = 0; i < 6; i++) {
        bot.noteBalanceRefusal(refused({ clientOrderId: `D-RO-try-${i}` }))
      }
      expect(delays).to.deep.equal([
        MARKET_CLOSED_RETRY_MIN_MS,
        2 * MARKET_CLOSED_RETRY_MIN_MS,
        4 * MARKET_CLOSED_RETRY_MIN_MS,
        8 * MARKET_CLOSED_RETRY_MIN_MS,
        MARKET_CLOSED_RETRY_MAX_MS,
        MARKET_CLOSED_RETRY_MAX_MS,
      ])
    })

    it('§3.4 gives up after 24 h of refusals and holds nothing', async () => {
      const { bot, handed, delays, gaveUp } = queueBot()
      bot.noteBalanceRefusal(refused())
      await bot.flushMarketClosed()
      for (const v of bot.marketClosedAttempts.values()) {
        v.firstAt = Date.now() - BALANCE_REFUSAL_GIVE_UP_MS
      }
      bot.noteBalanceRefusal(refused({ clientOrderId: 'D-RO-last' }))
      expect(gaveUp).to.have.length(1)
      expect(gaveUp[0].clientOrderId).to.equal('D-RO-last')
      expect(delays).to.have.length(1)
      await bot.flushMarketClosed()
      expect(handed).to.have.length(1)
      expect(bot.marketClosedAttempts.size).to.equal(0)
    })

    it('§3.5 tells the user once per pair per spell', () => {
      const { bot, notices } = queueBot()
      bot.noteBalanceRefusal(refused())
      bot.noteBalanceRefusal(refused({ clientOrderId: 'D-RO-again' }))
      bot.noteBalanceRefusal(
        refused({ ladderLevel: 21, origPrice: '45.36', price: '45.36' }),
      )
      expect(notices).to.have.length(1)
      expect(notices[0]).to.contain(SYMBOL)
      expect(notices[0]).to.contain('insufficient balance')
    })

    it('§3.6 only automatic limit safety orders', () => {
      const { bot, delays } = queueBot()
      bot.noteBalanceRefusal(refused({ type: 'MARKET' }))
      bot.noteBalanceRefusal(refused({ typeOrder: TypeOrderEnum.dealGrid }))
      bot.noteBalanceRefusal(refused({ typeOrder: TypeOrderEnum.dealStart }))
      expect(delays).to.have.length(0)
      const other = queueBot({ replaces: false })
      other.bot.noteBalanceRefusal(refused())
      expect(other.delays).to.have.length(0)
    })

    it('the closed-market retry keeps its own notice', () => {
      const { bot, notices, delays } = queueBot()
      bot.noteMarketClosedRefusal(refused())
      expect(delays).to.deep.equal([MARKET_CLOSED_RETRY_MIN_MS])
      expect(notices[0]).to.contain('market for XAGUSDT is closed')
    })
  })

  describe('dcaHelper hooks', () => {
    let Helper: any
    before(function () {
      this.timeout(180000)
      class FakeBase {
        math = new MathHelper()
        botId = 'bot'
        combo = false
        data: any = { exchange: ExchangeEnum.bitgetUsdm, settings: {} }
        constructor(..._a: any[]) {}
      }
      Helper = createRequire(__filename)('../dcaHelper').default(
        FakeBase as any,
      )
    })

    const buildBot = (
      opts: { currentOrders?: any[]; combo?: boolean; missed?: any[] } = {},
    ) => {
      class TestBot extends Helper {
        placed: any[] = []
        saved: any[] = []
        notices: string[] = []
        combo = opts.combo ?? false
        full = {
          deal: {
            _id: DEAL_ID,
            status: 'open',
            symbol: { symbol: SYMBOL, baseAsset: 'XAG', quoteAsset: 'USDT' },
            missedLevels: opts.missed ?? [{ level: 17, price: 53.19, qty: 9.92 }],
          },
          initialOrders: [],
          currentOrders: opts.currentOrders ?? [level20, level21],
          previousOrders: [],
          closeBySl: false,
          closeByTp: false,
          notCheckSl: false,
        }
        getDeal(id: string) {
          return id === DEAL_ID ? this.full : undefined
        }
        getOrdersByStatusAndDealId() {
          return []
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
        saveDeal(_d: any, update: any) {
          this.saved.push(update)
        }
        async postUserNotice(m: string) {
          this.notices.push(m)
        }
        handleLog() {}
        handleDebug() {}
        handleWarn() {}
      }
      return new TestBot() as any
    }

    it('§3.1 places the level back as a limit at its own price', async () => {
      const bot = buildBot()
      expect(await bot.replaceVenueCanceled(refused())).to.equal(true)
      const order = bot.placed[0][3].new[0]
      expect(order).to.include({
        price: 47.61,
        qty: 21.86,
        type: TypeOrderEnum.dealRegular,
        newClientOrderId: 'D-RO-fresh',
      })
    })

    it('§4 two passed levels are both sent in one pass, each at its own price', async () => {
      const bot = buildBot()
      const proto = MainBot.prototype as any
      bot.replaceVenueCanceledBatch = proto.replaceVenueCanceledBatch.bind(bot)
      const placed = await bot.replaceVenueCanceledBatch('bot', [
        refused(),
        refused({
          clientOrderId: 'D-RO-level-21',
          ladderLevel: 21,
          price: '45.36',
          origPrice: '45.36',
          origQty: '24.94',
        }),
      ])
      expect(placed).to.equal(2)
      expect(bot.placed.map((p: any) => p[3].new[0].price)).to.deep.equal([
        47.61, 45.36,
      ])
    })

    it('§3.4 a given-up DCA level is recorded as skipped', async () => {
      const bot = buildBot()
      await bot.giveUpBalanceRefusedLevel(refused())
      expect(bot.saved).to.deep.equal([
        {
          missedLevels: [
            { level: 17, price: 53.19, qty: 9.92 },
            { level: 20, price: 47.61, qty: 21.86 },
          ],
        },
      ])
      expect(bot.full.deal.missedLevels).to.have.length(2)
      expect(bot.notices[0]).to.contain('skipped DCA levels')
    })

    it('§3.4 a Combo deal is told, not recorded', async () => {
      const bot = buildBot({ combo: true })
      await bot.giveUpBalanceRefusedLevel(refused())
      expect(bot.saved).to.have.length(0)
      expect(bot.notices[0]).to.contain('next time')
    })

    it('§3.4 nothing when the ladder no longer wants the level', async () => {
      const bot = buildBot({ currentOrders: [level21] })
      await bot.giveUpBalanceRefusedLevel(refused())
      expect(bot.saved).to.have.length(0)
      expect(bot.notices).to.have.length(0)
    })
  })
})
