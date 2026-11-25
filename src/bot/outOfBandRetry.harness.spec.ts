process.env.NODE_ENV = 'testing'

/**
 * Spec 250: an order the venue refused for sitting too far ahead of the price
 * is placed once a price tick brings it within the venue's band.
 *
 * Fixture: a Combo deal's base grid on a tokenized-stock pair. Its five sells
 * sit 164.31–177.20 while the market is near 128; the venue refuses each with
 * `the trade price of rxyz/usdt cannot exceed the current price, 20%.`. The
 * price later spikes through 164 and 167, where nothing rested. Synthetic ids.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { BotStatusEnum, TypeOrderEnum } from '../../types'
import MainBot from './main'
import {
  bandFractionFromReason,
  isAheadOfMarket,
  isWithinBand,
} from './outOfBandRetry'

const BAND_20 =
  'the trade price of rxyz/usdt cannot exceed the current price, 20%.'
const BAND_10 = 'rxyz/usdt trading price cannot exceed 10%'

const sell = (price: number, over: Record<string, unknown> = {}): any => ({
  clientOrderId: `CMB-GR-${price}`,
  symbol: 'RXYZUSDT',
  dealId: 'deal-a',
  minigridId: 'grid-base',
  typeOrder: TypeOrderEnum.dealGrid,
  side: 'SELL',
  type: 'LIMIT',
  price: `${price}`,
  origPrice: `${price}`,
  origQty: '0.1231',
  ...over,
})

describe('orders held out of the price band (spec 250)', () => {
  describe('helpers', () => {
    it('reads the band from either venue wording', () => {
      expect(bandFractionFromReason(BAND_20)).to.equal(0.2)
      expect(bandFractionFromReason(BAND_10)).to.equal(0.1)
      expect(
        bandFractionFromReason('buy-in price cannot be higher than 0.1516'),
      ).to.equal(null)
      expect(bandFractionFromReason('')).to.equal(null)
    })
    it('a sell above or a buy below the market is ahead of it', () => {
      expect(isAheadOfMarket('SELL', 164.31, 128)).to.equal(true)
      expect(isAheadOfMarket('BUY', 100, 128)).to.equal(true)
      expect(isAheadOfMarket('SELL', 120, 128)).to.equal(false)
      expect(isAheadOfMarket('BUY', 152.88, 128)).to.equal(false)
    })
    it('within the band, with a margin off its edge', () => {
      expect(isWithinBand(164.31, 128, 0.2)).to.equal(false)
      expect(isWithinBand(164.31, 150, 0.2)).to.equal(true)
      // 19% away: inside 20% but outside the 18% margin
      expect(isWithinBand(119, 100, 0.2)).to.equal(false)
    })
  })

  describe('MainBot hold and release', () => {
    const build = (opts: { replaces?: boolean; status?: string } = {}) => {
      const handed: any[] = []
      let market = 128
      const bot: any = {
        botId: 'bot',
        data: { status: opts.status ?? BotStatusEnum.open },
        outOfBandFlushing: false,
        logs: [] as string[],
        handleLog(m: string) {
          this.logs.push(m)
        },
        handleWarn() {},
        shouldProceed: () => true,
        replacesVenueCancel: () => opts.replaces ?? true,
        getLatestPrice: async () => market,
        async replaceVenueCanceled(o: any) {
          handed.push(o)
          return true
        },
        scheduleHeldOutOfBandPublish() {},
      }
      const proto = MainBot.prototype as any
      for (const m of [
        'noteOutOfBandRefusal',
        'holdOutOfBand',
        'markHeldOutOfBandDirty',
        'checkOutOfBandOrders',
        'flushOutOfBand',
        'replaceVenueCanceledBatch',
      ]) {
        bot[m] = proto[m].bind(bot)
      }
      return {
        bot,
        handed,
        setMarket: (p: number) => {
          market = p
        },
      }
    }
    const settle = () => new Promise((r) => setTimeout(r, 0))

    it('holds the refused sells and places those a tick brings into range', async () => {
      const { bot, handed } = build()
      for (const p of [164.31, 167.54, 170.76, 173.97, 177.2]) {
        await bot.noteOutOfBandRefusal(sell(p), BAND_20)
      }
      expect(bot.outOfBandOrders.size).to.equal(5)
      bot.checkOutOfBandOrders('RXYZUSDT', 130)
      await settle()
      expect(handed).to.have.length(0)
      // the spike: 143 puts 164.31 and 167.54 inside 18%, not 170.76 up
      bot.checkOutOfBandOrders('RXYZUSDT', 143)
      await settle()
      expect(handed.map((o) => +o.price)).to.deep.equal([164.31, 167.54])
      expect(bot.outOfBandOrders.size).to.equal(3)
      bot.checkOutOfBandOrders('RXYZUSDT', 166)
      await settle()
      expect(handed).to.have.length(5)
      expect(bot.outOfBandOrders.size).to.equal(0)
    })

    it('a tick for another pair places nothing', async () => {
      const { bot, handed } = build()
      await bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      bot.checkOutOfBandOrders('ROTHERUSDT', 166)
      await settle()
      expect(handed).to.have.length(0)
    })

    it('not an order the price already passed (the re-price handles those)', async () => {
      const { bot } = build()
      await bot.noteOutOfBandRefusal(sell(120), BAND_20)
      expect(bot.outOfBandOrders?.size ?? 0).to.equal(0)
    })

    it('not without a band in the refusal, nor for an order type left alone', async () => {
      const a = build()
      await a.bot.noteOutOfBandRefusal(
        sell(164.31),
        'buy-in price cannot be higher than 0.1516',
      )
      expect(a.bot.outOfBandOrders?.size ?? 0).to.equal(0)
      const b = build({ replaces: false })
      await b.bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      expect(b.bot.outOfBandOrders?.size ?? 0).to.equal(0)
    })

    it('a repeated refusal of the same level is held once', async () => {
      const { bot } = build()
      await bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      await bot.noteOutOfBandRefusal(
        sell(164.31, { clientOrderId: 'CMB-GR-retry' }),
        BAND_20,
      )
      expect(bot.outOfBandOrders.size).to.equal(1)
    })

    it('places nothing for a bot that is not open', async () => {
      const { bot, handed } = build({ status: BotStatusEnum.closed })
      await bot.noteOutOfBandRefusal(sell(164.31), BAND_20)
      bot.checkOutOfBandOrders('RXYZUSDT', 166)
      await settle()
      expect(handed).to.have.length(0)
    })
  })
})
