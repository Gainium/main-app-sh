process.env.NODE_ENV = 'testing'

/**
 * Spec 248: a safety order refused on a price band or on a closed market.
 *
 * The fixture is a Combo long deal on a tokenized-stock pair. Its level-2 buy
 * at 152.88 is 18% above the market (129.57), and the venue refuses a limit
 * buy more than 10% through the market. A second pair's level-2 buy is
 * refused because the venue's market for the pair is closed (a weekend). Ids
 * and pairs are synthetic.
 *
 * Covers the refusal classification, which orders are re-priced, the re-price
 * target for a passed safety order, and the `MainBot` closed-market queue
 * (borrowed off its prototype): retried by level with a back-off, one notice
 * per pair per closed spell, only for order types the engine places back.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { BotStatusEnum, TypeOrderEnum } from '../../../types'
import MainBot from '../main'
import { getErrorSubType, marketClosed, orderPrice } from '../utils'
import {
  priceBandRepriceTarget,
  repricesOnPriceBand,
} from '../priceBandReprice'
import {
  MARKET_CLOSED_RETRY_MAX_MS,
  MARKET_CLOSED_RETRY_MIN_MS,
  MARKET_CLOSED_SPELL_GAP_MS,
  marketClosedLevelKey,
  marketClosedRetryDelay,
} from '../marketClosedRetry'

const BAND = 'rxyz/usdt trading price cannot exceed 10%'
const CLOSED =
  'Bitget is not accepting orders on RXYZUSDT right now: the market is closed for this stock token. Bitget trades stock tokens only during their supported hours, and many not on weekends or US holidays. Orders can be placed again once trading reopens.'

const safety = (over: Record<string, unknown> = {}): any => ({
  clientOrderId: 'CMB-RO-level-2',
  symbol: 'RXYZUSDT',
  dealId: 'deal-a',
  botId: 'bot',
  typeOrder: TypeOrderEnum.dealRegular,
  dcaLevel: 2,
  status: 'NEW',
  type: 'LIMIT',
  side: 'BUY',
  origQty: '0.3277',
  executedQty: '0',
  price: '152.88',
  origPrice: '152.88',
  ...over,
})

describe('refused safety order: band and closed market (spec 248)', () => {
  describe('classification', () => {
    it("the venue's percentage band is an Order price refusal", () => {
      expect(getErrorSubType(BAND)).to.equal(orderPrice)
      expect(
        getErrorSubType(
          'the trade price of rxyz/usdt cannot exceed the current price, 20%.',
        ),
      ).to.equal(orderPrice)
    })
    it('a closed market is a Market closed refusal', () => {
      expect(getErrorSubType(CLOSED)).to.equal(marketClosed)
    })
  })

  describe('which orders are re-priced', () => {
    it('a safety order', () => {
      expect(repricesOnPriceBand(safety())).to.equal(true)
    })
    it('a combo grid level, as before', () => {
      expect(
        repricesOnPriceBand(safety({ typeOrder: TypeOrderEnum.dealGrid })),
      ).to.equal(true)
    })
    it('not add / reduce funds, a market order, a TP or a base order', () => {
      expect(repricesOnPriceBand(safety({ addFundsId: 'a' }))).to.equal(false)
      expect(repricesOnPriceBand(safety({ reduceFundsId: 'r' }))).to.equal(
        false,
      )
      expect(repricesOnPriceBand(safety({ type: 'MARKET' }))).to.equal(false)
      expect(
        repricesOnPriceBand(safety({ typeOrder: TypeOrderEnum.dealTP })),
      ).to.equal(false)
      expect(
        repricesOnPriceBand(safety({ typeOrder: TypeOrderEnum.dealStart })),
      ).to.equal(false)
      expect(repricesOnPriceBand(safety({ dealId: undefined }))).to.equal(
        false,
      )
    })
    it('a passed buy level goes to the market, never above its level', () => {
      expect(
        priceBandRepriceTarget({
          side: 'BUY',
          price: 152.88,
          market: 129.57,
          reason: BAND,
        }),
      ).to.equal(129.57)
      expect(
        priceBandRepriceTarget({
          side: 'BUY',
          price: 120,
          market: 129.57,
          reason: BAND,
        }),
      ).to.equal(null)
    })
  })

  describe('retry delay', () => {
    it('starts at the minimum and doubles up to the cap', () => {
      expect(marketClosedRetryDelay(0)).to.equal(MARKET_CLOSED_RETRY_MIN_MS)
      expect(marketClosedRetryDelay(1)).to.equal(2 * MARKET_CLOSED_RETRY_MIN_MS)
      expect(marketClosedRetryDelay(50)).to.equal(MARKET_CLOSED_RETRY_MAX_MS)
    })
    it('tracks a level, not a client order id', () => {
      expect(marketClosedLevelKey(safety())).to.equal(
        marketClosedLevelKey(safety({ clientOrderId: 'CMB-RO-retry' })),
      )
      expect(marketClosedLevelKey(safety())).to.not.equal(
        marketClosedLevelKey(safety({ dcaLevel: 3, origPrice: '143.63' })),
      )
    })
  })

  describe('MainBot closed-market queue', () => {
    const queueBot = (opts: { replaces?: boolean; status?: string } = {}) => {
      const handed: any[] = []
      const notices: string[] = []
      const delays: number[] = []
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
      }
      const proto = MainBot.prototype as any
      for (const m of [
        'noteMarketClosedRefusal',
        'flushMarketClosed',
        'replaceVenueCanceledBatch',
      ]) {
        bot[m] = proto[m].bind(bot)
      }
      return { bot, handed, notices, delays }
    }

    it('keeps the order and places it again on the retry pass', async () => {
      const { bot, handed, delays } = queueBot()
      bot.noteMarketClosedRefusal(safety())
      expect(delays).to.deep.equal([MARKET_CLOSED_RETRY_MIN_MS])
      await bot.flushMarketClosed()
      expect(handed).to.have.length(1)
      expect(handed[0].clientOrderId).to.equal('CMB-RO-level-2')
      await bot.flushMarketClosed()
      expect(handed).to.have.length(1)
    })

    it('backs off while the market stays closed', () => {
      const { bot, delays } = queueBot()
      bot.noteMarketClosedRefusal(safety())
      bot.noteMarketClosedRefusal(safety({ clientOrderId: 'CMB-RO-retry-1' }))
      bot.noteMarketClosedRefusal(safety({ clientOrderId: 'CMB-RO-retry-2' }))
      expect(delays).to.deep.equal([
        MARKET_CLOSED_RETRY_MIN_MS,
        2 * MARKET_CLOSED_RETRY_MIN_MS,
        4 * MARKET_CLOSED_RETRY_MIN_MS,
      ])
    })

    it('tells the user once per pair per closed spell', () => {
      const { bot, notices } = queueBot()
      bot.noteMarketClosedRefusal(safety())
      bot.noteMarketClosedRefusal(safety({ dcaLevel: 3, origPrice: '143.63' }))
      bot.noteMarketClosedRefusal(
        safety({ symbol: 'RABCUSDT', dealId: 'deal-b' }),
      )
      expect(notices).to.have.length(2)
      expect(notices[0]).to.contain('RXYZUSDT')
      expect(notices[0]).to.contain(
        'will place them automatically when trading reopens',
      )
      expect(notices[1]).to.contain('RABCUSDT')
    })

    it('tells the user again after a gap longer than a closed spell', () => {
      const { bot, notices, delays } = queueBot()
      bot.noteMarketClosedRefusal(safety())
      const past = Date.now() - MARKET_CLOSED_SPELL_GAP_MS - 1
      bot.marketClosedNoticedAt.set('RXYZUSDT', past)
      for (const v of bot.marketClosedAttempts.values()) {
        v.at = past
      }
      bot.noteMarketClosedRefusal(safety({ clientOrderId: 'CMB-RO-next' }))
      expect(notices).to.have.length(2)
      expect(delays).to.deep.equal([
        MARKET_CLOSED_RETRY_MIN_MS,
        MARKET_CLOSED_RETRY_MIN_MS,
      ])
    })

    it('skips an order type the engine does not place back', async () => {
      const { bot, handed, notices } = queueBot({ replaces: false })
      bot.noteMarketClosedRefusal(safety())
      await bot.flushMarketClosed()
      expect(handed).to.have.length(0)
      expect(notices).to.have.length(0)
    })

    it('places nothing for a bot that is not open', async () => {
      const { bot, handed } = queueBot({ status: BotStatusEnum.closed })
      bot.noteMarketClosedRefusal(safety())
      await bot.flushMarketClosed()
      expect(handed).to.have.length(0)
    })
  })
})
