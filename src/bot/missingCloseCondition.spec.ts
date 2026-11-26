process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `272.missing-close-condition-places-no-take-profit`.
 *
 * A bot saved with `useTp: true` but no `dealCloseCondition` (the field is
 * optional on every create path) used to get no take-profit order at all: the
 * engine compares the field `=== tp`, and `undefined` matched no branch. The
 * dashboard and the notification cards already read a missing value as `tp`.
 *
 * Drives the REAL `getAggregatedSettings` and the REAL
 * `createCurrentDealOrders`; `getTPOrder` and the exchange lookups are stubbed.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { CloseConditionEnum, OrderSideEnum, TypeOrderEnum } from '../../types'

const DEAL_ID = '000000000000000000000d72'
const BOT_ID = '000000000000000000000b72'
const SYMBOL = 'BTCUSDT'
const BO_PRICE = 100

let Helper: any

const grid = (price: number, type: TypeOrderEnum, side: OrderSideEnum) =>
  ({
    number: 0,
    price,
    qty: 1,
    side,
    newClientOrderId: `D-${type}-${price}`,
    type,
    dealId: DEAL_ID,
  }) as any

const buildBot = (settings: Record<string, unknown>) => {
  const deal = {
    _id: DEAL_ID,
    botId: BOT_ID,
    status: 'open',
    symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
    settings: {},
    lastPrice: BO_PRICE,
    initialPrice: BO_PRICE,
    levels: { all: 2, complete: 1 },
  }
  class TestBot extends (Helper as any) {
    botId = BOT_ID
    botType = 'dca'
    data: any = {
      settings: {
        name: 'bot',
        pair: [SYMBOL],
        strategy: 'LONG',
        type: 'regular',
        ordersCount: 1,
        activeOrdersCount: 1,
        useDca: true,
        ...settings,
      },
      status: 'open',
      exchange: 'binance',
      flags: [],
      paperContext: false,
    }
    orders = new Map<string, any>()
    get isLong() {
      return true
    }
    async replaceBotSettings(s: any) {
      return s
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async getTPOrder() {
      return [grid(101, TypeOrderEnum.dealTP, OrderSideEnum.sell)]
    }
    async getExchangeInfo() {
      return { priceAssetPrecision: 2 }
    }
    async baseSlOn() {
      return 'start'
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  const bot = new (TestBot as any)()
  const ladder = [grid(95, TypeOrderEnum.dealRegular, OrderSideEnum.buy)]
  return {
    bot,
    current: () =>
      bot.createCurrentDealOrders(
        SYMBOL,
        BO_PRICE,
        ladder,
        BO_PRICE,
        BO_PRICE,
        DEAL_ID,
        false,
        deal,
      ) as Promise<any[]>,
  }
}

describe('a bot saved without a close condition (spec 272)', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§1.1 useTp with no dealCloseCondition places a take-profit order', async () => {
    const { current } = buildBot({ useTp: true, tpPerc: '1' })
    const orders = await current()
    expect(orders.map((o) => o.type)).to.include(TypeOrderEnum.dealTP)
  })

  it('§1.1 control: an explicit tp places the same take-profit order', async () => {
    const { current } = buildBot({
      useTp: true,
      tpPerc: '1',
      dealCloseCondition: CloseConditionEnum.tp,
    })
    const orders = await current()
    expect(orders.map((o) => o.type)).to.include(TypeOrderEnum.dealTP)
  })

  it('§1.2 useSl with no dealCloseConditionSL arms the stop loss level', async () => {
    // SL at -3% of 100 = 97: the safety order at 95 lies beyond it and must
    // not be placed, exactly as for a bot saved with `tp`.
    const { current } = buildBot({ useTp: false, useSl: true, slPerc: '-3' })
    const orders = await current()
    expect(orders.map((o) => o.price)).to.not.include(95)
  })

  it('§1.3 the aggregated settings read a missing condition as tp', async () => {
    const { bot } = buildBot({ useTp: true, useSl: true })
    const s = await bot.getAggregatedSettings()
    expect(s.dealCloseCondition).to.equal(CloseConditionEnum.tp)
    expect(s.dealCloseConditionSL).to.equal(CloseConditionEnum.tp)
  })

  for (const explicit of [
    CloseConditionEnum.techInd,
    CloseConditionEnum.webhook,
    CloseConditionEnum.manual,
    CloseConditionEnum.dynamicAr,
  ]) {
    it(`§1.4 an explicit "${explicit}" is kept as it is`, async () => {
      const { bot, current } = buildBot({
        useTp: true,
        tpPerc: '1',
        dealCloseCondition: explicit,
        dealCloseConditionSL: explicit,
      })
      const s = await bot.getAggregatedSettings()
      expect(s.dealCloseCondition).to.equal(explicit)
      expect(s.dealCloseConditionSL).to.equal(explicit)
      if (explicit !== CloseConditionEnum.dynamicAr) {
        const orders = await current()
        expect(orders.map((o) => o.type)).to.not.include(TypeOrderEnum.dealTP)
      }
    })
  }

  it('§1.4 a deal saved without the field inherits the bot condition', async () => {
    const { bot } = buildBot({
      useTp: true,
      dealCloseCondition: CloseConditionEnum.webhook,
    })
    const s = await bot.getAggregatedSettings({
      settings: { useTp: true, tpPerc: '1' },
    })
    expect(s.dealCloseCondition).to.equal(CloseConditionEnum.webhook)
  })

  it('§1.4 a deal-level condition still overrides the bot', async () => {
    const { bot } = buildBot({ useTp: true })
    const s = await bot.getAggregatedSettings({
      settings: { dealCloseCondition: CloseConditionEnum.manual },
    })
    expect(s.dealCloseCondition).to.equal(CloseConditionEnum.manual)
  })

  it('§1.5 a bot created without either field is stored with tp', () => {
    const models = createRequire(__filename)('../db/model').default
    for (const M of [models.dcaBot, models.comboBot]) {
      const created = new M({ settings: { useTp: true, useSl: true } })
      expect(created.settings.dealCloseCondition).to.equal('tp')
      expect(created.settings.dealCloseConditionSL).to.equal('tp')
      const kept = new M({
        settings: {
          dealCloseCondition: 'techInd',
          dealCloseConditionSL: 'webhook',
        },
      })
      expect(kept.settings.dealCloseCondition).to.equal('techInd')
      expect(kept.settings.dealCloseConditionSL).to.equal('webhook')
    }
  })

  it('§1.7 a bot created without useTp keeps it off and places no take profit', async () => {
    const models = createRequire(__filename)('../db/model').default
    for (const M of [models.dcaBot, models.comboBot]) {
      const created = new M({ settings: {} })
      expect(created.settings.useTp).to.not.equal(true)
      expect(created.settings.useSl).to.not.equal(true)
    }
    const { bot, current } = buildBot({ tpPerc: '1' })
    const s = await bot.getAggregatedSettings()
    expect(s.useTp).to.not.equal(true)
    const orders = await current()
    expect(orders.map((o) => o.type)).to.not.include(TypeOrderEnum.dealTP)
  })

  describe('§1.6 a defaulted stop loss is armed by a safe-side tick', () => {
    const SL_LEVEL = 90
    const setup = (
      botSettings: Record<string, unknown>,
      dealSettings: Record<string, unknown> = {},
    ) => {
      const { bot } = buildBot({ useSl: true, slPerc: '-10', ...botSettings })
      const deal = {
        _id: DEAL_ID,
        botId: BOT_ID,
        status: 'open',
        symbol: { symbol: SYMBOL, baseAsset: 'BTC', quoteAsset: 'USDT' },
        settings: { useSl: true, slPerc: '-10', ...dealSettings },
        avgPrice: BO_PRICE,
      }
      const fired: string[] = []
      const logs: string[] = []
      const saved: Record<string, unknown>[] = []
      let price = 0
      bot.handleLog = (m: string) => logs.push(m)
      bot.saveDeal = async (_d: unknown, patch: Record<string, unknown>) => {
        saved.push(patch)
      }
      // The stored documents, read lean by the hold (§1.6). By default they
      // are what the test built; `stored` overrides them to model an
      // in-memory view (a Redis snapshot) that Mongo never had.
      const stored = {
        deal: (): Record<string, unknown> => ({
          _id: DEAL_ID,
          settings: deal.settings,
          defaultSlArmed: (deal as any).defaultSlArmed,
        }),
        bot: (): Record<string, unknown> => ({
          _id: BOT_ID,
          settings: bot.data.settings,
        }),
      }
      const reads: string[] = []
      bot.dealsDb = {
        readData: async () => {
          reads.push('deal')
          return { status: 'OK', data: { result: stored.deal() } }
        },
      }
      bot.db = {
        readData: async () => {
          reads.push('bot')
          return { status: 'OK', data: { result: stored.bot() } }
        },
      }
      bot.allowedMethods = new Set(['checkDealsStopLoss'])
      bot.dealsForStopLoss = new Map([[DEAL_ID, SL_LEVEL]])
      bot.getDeal = () => ({ deal })
      bot.getLastStreamData = () => ({ price })
      bot.isTrailingCloseInFlight = () => false
      bot.triggerStopLoss = (id: string) => fired.push(id)
      const tick = async (p: number) => {
        price = p
        await bot.checkDealsStopLoss(BOT_ID, SYMBOL)
      }
      return { fired, tick, logs, saved, deal, bot, stored, reads }
    }

    it('does not close a deal already past its level on the first tick', async () => {
      const { fired, tick, logs, saved } = setup({})
      await tick(55)
      await tick(54)
      await tick(53)
      expect(fired).to.deep.equal([])
      expect(saved).to.deep.equal([])
      // Logged once per held deal, so the held deals can be counted.
      const held = logs.filter((m) => m.includes('stop loss not armed'))
      expect(held).to.have.length(1)
      expect(held[0]).to.include(DEAL_ID)
    })

    it('a safe-side tick is persisted on the deal, so a restart keeps it armed', async () => {
      const first = setup({})
      await first.tick(100)
      expect(first.saved).to.deep.equal([{ defaultSlArmed: true }])
      expect(first.deal).to.have.property('defaultSlArmed', true)
      // A fresh worker loads the deal with the flag and is already past the
      // level: the stop loss still closes it on the first tick.
      const restarted = setup({})
      ;(restarted.deal as any).defaultSlArmed = true
      await restarted.tick(55)
      expect(restarted.fired).to.deep.equal([DEAL_ID])
    })

    it('closes it once the price came back above the level and fell through', async () => {
      const { fired, tick } = setup({})
      await tick(55)
      await tick(95)
      expect(fired).to.deep.equal([])
      await tick(89)
      expect(fired).to.deep.equal([DEAL_ID])
    })

    it('a new deal (first tick on the safe side) is protected as before', async () => {
      const { fired, tick } = setup({})
      await tick(100)
      await tick(89)
      expect(fired).to.deep.equal([DEAL_ID])
    })

    it('an explicit tp on the bot closes on the first tick, unchanged', async () => {
      const { fired, tick } = setup({
        dealCloseConditionSL: CloseConditionEnum.tp,
      })
      await tick(55)
      expect(fired).to.deep.equal([DEAL_ID])
    })

    it('an explicit tp on the deal closes on the first tick, unchanged', async () => {
      const { fired, tick } = setup(
        {},
        { dealCloseConditionSL: CloseConditionEnum.tp },
      )
      await tick(55)
      expect(fired).to.deep.equal([DEAL_ID])
    })

    it('holds on the STORED state when the in-memory bot carries a condition Mongo never saved', async () => {
      // The prod shape: the worker restored the bot from its Redis snapshot
      // with `dealCloseConditionSL: tp`, while neither stored document has it.
      const { fired, tick, logs, stored } = setup({
        dealCloseConditionSL: CloseConditionEnum.tp,
      })
      stored.bot = () => ({ _id: BOT_ID, settings: { useSl: true } })
      await tick(55)
      await tick(54)
      expect(fired).to.deep.equal([])
      expect(logs.filter((m) => m.includes('stop loss not armed'))).to.have.length(1)
    })

    it('holds when only the in-memory deal claims it was armed', async () => {
      const { fired, tick, deal, stored } = setup({})
      ;(deal as any).defaultSlArmed = true
      stored.deal = () => ({ _id: DEAL_ID, settings: deal.settings })
      await tick(55)
      expect(fired).to.deep.equal([])
    })

    it('a held deal is released by a safe-side tick and closes on the next crossing', async () => {
      const { fired, tick, stored } = setup({
        dealCloseConditionSL: CloseConditionEnum.tp,
      })
      stored.bot = () => ({ _id: BOT_ID, settings: { useSl: true } })
      await tick(55)
      await tick(95)
      await tick(89)
      expect(fired).to.deep.equal([DEAL_ID])
    })

    it('reads the stored documents once per minute, not once per tick', async () => {
      const { tick, reads } = setup({})
      await tick(55)
      await tick(54)
      await tick(53)
      expect(reads.sort()).to.deep.equal(['bot', 'deal'])
    })

    it('a deal not yet past its level reads nothing from the database', async () => {
      const { tick, reads } = setup({})
      await tick(100)
      await tick(99)
      expect(reads).to.deep.equal([])
    })

    it('the stored read only adds a hold: an in-memory default stays held', async () => {
      const { fired, tick, stored } = setup({})
      stored.bot = () => ({
        _id: BOT_ID,
        settings: { useSl: true, dealCloseConditionSL: CloseConditionEnum.tp },
      })
      // In memory the deal is defaulted, so the in-memory hold still applies:
      // the stored read only ever ADDS a hold, it never removes one.
      await tick(55)
      expect(fired).to.deep.equal([])
    })
  })
})
