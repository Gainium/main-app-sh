process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `140.combo-tp-sl-reads-each-deals-own-price`.
 *
 * Drives the REAL `comboHelper.unrealizedProfit` and the REAL
 * `dcaHelper.checkDealsPriceExtremum` (combo branch) off the mixin. Only
 * `triggerStopLossCombo` — the close itself — is recorded rather than run.
 * Two deals on symbols whose prices are an order of magnitude apart, the
 * shape of a long multi-coin combo bot.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../types'

const BOT_ID = '000000000000000000000b40'
// pair[0] trades around 0.31, the second coin around 0.0092.
const HIGH = 'HIGHUSDT'
const LOW = 'LOWUSDT'
const DEAL_HIGH = '000000000000000000000d41'
const DEAL_LOW = '000000000000000000000d42'

let Helper: any

type Levels = { tp: number; sl: number }

const buildBot = (opts: {
  pair: string[]
  isLong?: boolean
  deals: { id: string; symbol: string; levels: Levels }[]
  prices: Record<string, number>
}) => {
  const { pair, isLong = true, deals, prices } = opts
  const closed: { id: string; sl: boolean; tp: boolean }[] = []
  const dealMap = new Map(
    deals.map((d) => [
      d.id,
      {
        deal: {
          _id: d.id,
          botId: BOT_ID,
          status: 'open',
          symbol: { symbol: d.symbol },
          settings: {},
          profit: {},
        },
        closeBySl: false,
        initialOrders: [],
        currentOrders: [],
        previousOrders: [],
      },
    ]),
  )
  class TestBot extends (Helper as any) {
    closed = closed
    botId = BOT_ID
    userId = '000000000000000000000a40'
    botType = 'combo'
    combo = true
    data: any = {
      settings: { name: 'bot', pair },
      status: 'open',
      flags: [],
      paperContext: false,
    }
    lastFilledOrderMap = new Map<string, any>()
    botEventDb = {
      createData: async () => ({ status: StatusEnum.ok }),
    }
    getDeal(id?: string) {
      return id ? dealMap.get(id) : undefined
    }
    async getAggregatedSettings() {
      return { useSl: true, useTp: true }
    }
    async triggerStopLossCombo(id: string, sl: boolean, tp: boolean) {
      closed.push({ id, sl, tp })
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  const bot = new (TestBot as any)()
  bot.isLong = isLong
  bot.allowedMethods.add('checkDealsStopLoss')
  bot.dealsForStopLossCombo = new Map(deals.map((d) => [d.id, d.levels]))
  for (const [symbol, price] of Object.entries(prices)) {
    bot.setLastStreamData(symbol, { price, time: 1 })
  }
  return bot
}

describe('combo take profit / stop loss reads each deal its own price (spec 140)', () => {
  before(function () {
    // One ts-node compile of the combo mixin and everything under it.
    this.timeout(240000)
    Helper = createRequire(__filename)('./comboHelper').default()
  })

  // Both deals sit inside their own TP/SL band.
  const twoDeals = [
    { id: DEAL_HIGH, symbol: HIGH, levels: { tp: 0.33, sl: 0.28 } },
    { id: DEAL_LOW, symbol: LOW, levels: { tp: 0.0095, sl: 0.0085 } },
  ]

  describe('§4.1 unrealizedProfit', () => {
    it('§1.1 a deal on a cheaper coin is not closed by pair[0]’s price', async () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: { [HIGH]: 0.3115, [LOW]: 0.0092 },
      })
      await bot.unrealizedProfit()
      expect(bot.closed, 'no deal crossed its own level').to.deep.equal([])
    })

    it('§1.1 a deal on a dearer coin is not stopped out by pair[0]’s price', async () => {
      const bot = buildBot({
        pair: [LOW, HIGH],
        deals: twoDeals,
        prices: { [HIGH]: 0.3115, [LOW]: 0.0092 },
      })
      await bot.unrealizedProfit()
      expect(bot.closed, 'no deal crossed its own level').to.deep.equal([])
    })

    it('§1.1 each deal still closes when its own coin crosses its level', async () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: { [HIGH]: 0.3115, [LOW]: 0.0096 },
      })
      await bot.unrealizedProfit()
      expect(bot.closed).to.deep.equal([{ id: DEAL_LOW, sl: false, tp: true }])

      const bot2 = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: { [HIGH]: 0.27, [LOW]: 0.0092 },
      })
      await bot2.unrealizedProfit()
      expect(bot2.closed).to.deep.equal([
        { id: DEAL_HIGH, sl: true, tp: false },
      ])
    })

    it('§4.1 a deal whose coin has no price yet is skipped', async () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: { [HIGH]: 0.34 },
      })
      await bot.unrealizedProfit()
      expect(bot.closed).to.deep.equal([{ id: DEAL_HIGH, sl: false, tp: true }])
    })

    it('§4.1 a newer filled order refreshes that deal’s own symbol', async () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: { [HIGH]: 0.3115, [LOW]: 0.0092 },
      })
      bot.lastFilledOrderMap.set(LOW, { price: '0.0084', updateTime: 2 })
      await bot.unrealizedProfit()
      expect(bot.closed).to.deep.equal([{ id: DEAL_LOW, sl: true, tp: false }])
    })

    it('§1.5 single-coin combo bot: unchanged', async () => {
      const bot = buildBot({
        pair: [LOW],
        deals: [
          { id: DEAL_LOW, symbol: LOW, levels: { tp: 0.0095, sl: 0.0085 } },
        ],
        prices: { [LOW]: 0.0096 },
      })
      await bot.unrealizedProfit()
      expect(bot.closed).to.deep.equal([{ id: DEAL_LOW, sl: false, tp: true }])
    })

    it('§1.1 short: neither deal crosses on the other coin’s price', async () => {
      const bot = buildBot({
        pair: [LOW, HIGH],
        isLong: false,
        deals: [
          { id: DEAL_HIGH, symbol: HIGH, levels: { tp: 0.28, sl: 0.33 } },
          { id: DEAL_LOW, symbol: LOW, levels: { tp: 0.0085, sl: 0.0095 } },
        ],
        prices: { [HIGH]: 0.3115, [LOW]: 0.0092 },
      })
      await bot.unrealizedProfit()
      expect(bot.closed).to.deep.equal([])
    })
  })

  describe('§4.2 checkDealsPriceExtremum (combo branch)', () => {
    it('§1.3 long: each symbol gets the gate of its own deals', () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: {},
      })
      bot.checkDealsPriceExtremum()
      expect(bot.lowestHigh.get(HIGH)).to.equal(0.33)
      expect(bot.highestLow.get(HIGH)).to.equal(0.28)
      expect(bot.lowestHigh.get(LOW)).to.equal(0.0095)
      expect(bot.highestLow.get(LOW)).to.equal(0.0085)
    })

    it('§1.3 short: each symbol gets the gate of its own deals', () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        isLong: false,
        deals: [
          { id: DEAL_HIGH, symbol: HIGH, levels: { tp: 0.28, sl: 0.33 } },
          { id: DEAL_LOW, symbol: LOW, levels: { tp: 0.0085, sl: 0.0095 } },
        ],
        prices: {},
      })
      bot.checkDealsPriceExtremum()
      expect(bot.highestLow.get(HIGH)).to.equal(0.28)
      expect(bot.lowestHigh.get(HIGH)).to.equal(0.33)
      expect(bot.highestLow.get(LOW)).to.equal(0.0085)
      expect(bot.lowestHigh.get(LOW)).to.equal(0.0095)
    })

    it('§4.2 a symbol whose deals are gone loses its gate', () => {
      const bot = buildBot({
        pair: [HIGH, LOW],
        deals: twoDeals,
        prices: {},
      })
      bot.checkDealsPriceExtremum()
      bot.dealsForStopLossCombo.delete(DEAL_LOW)
      bot.checkDealsPriceExtremum()
      expect(bot.lowestHigh.has(LOW)).to.equal(false)
      expect(bot.highestLow.has(LOW)).to.equal(false)
      expect(bot.lowestHigh.get(HIGH)).to.equal(0.33)
    })

    it('§1.5 single-coin combo bot: gate unchanged', () => {
      const bot = buildBot({
        pair: [LOW],
        deals: [
          { id: DEAL_LOW, symbol: LOW, levels: { tp: 0.0095, sl: 0.0085 } },
        ],
        prices: {},
      })
      bot.checkDealsPriceExtremum()
      expect(bot.lowestHigh.get(LOW)).to.equal(0.0095)
      expect(bot.highestLow.get(LOW)).to.equal(0.0085)
    })
  })
})
