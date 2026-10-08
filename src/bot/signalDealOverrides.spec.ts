process.env.NODE_ENV = 'testing'

/**
 * `startDeal` webhook overrides: a deal opened with its own base order, take
 * profit and stop loss.
 *
 * The parsing / settings rules are tested directly; the engine half drives the
 * REAL `dcaHelper` / `comboHelper` `openNewDeal` and `getAggregatedSettings`
 * over a minimal base class — no stack, DB, Redis or venue. Fixture ids are
 * synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import {
  applySignalDealOverrides,
  parseSignalDealOverrides,
  signalPriceError,
} from './signalDealOverrides'
import { newDealSizeDescription } from './newDealApproval'
import {
  BotType,
  CloseConditionEnum,
  ExchangeEnum,
  OrderSizeTypeEnum,
  StartConditionEnum,
} from '../../types'

const BOT_ID = '0000000000000000000a0141'
const USER_ID = '0000000000000000000b0141'
const PAIR = 'ETH-USDC'
const PRICE = 2500

describe('signal deal overrides — parsing', () => {
  it('no override fields is no overrides', () => {
    expect(
      parseSignalDealOverrides({ action: 'startDeal' }, BotType.dca),
    ).to.deep.equal({ overrides: null })
  })

  it('accepts numbers and numeric strings, stores strings', () => {
    const r = parseSignalDealOverrides(
      { baseOrderSize: 25, tpPerc: '2.5', slPrice: ' 2400 ' },
      BotType.dca,
    )
    expect(r.error).to.equal(undefined)
    expect(r.overrides).to.deep.equal({
      baseOrderSize: '25',
      tpPerc: '2.5',
      slPrice: '2400',
    })
  })

  it('a stop loss percentage is a distance: either sign, stored negative', () => {
    expect(
      parseSignalDealOverrides({ slPerc: 3 }, BotType.dca).overrides,
    ).to.deep.equal({ slPerc: '-3' })
    expect(
      parseSignalDealOverrides({ slPerc: '-3' }, BotType.combo).overrides,
    ).to.deep.equal({ slPerc: '-3' })
  })

  for (const bad of ['', 'NaN', '{{plot_0}}', 0, -1, 'abc', true, {}]) {
    it(`rejects ${JSON.stringify(bad)} instead of opening without it`, () => {
      const r = parseSignalDealOverrides({ tpPrice: bad }, BotType.dca)
      expect(r.overrides).to.equal(null)
      expect(r.error).to.match(/Invalid "tpPrice"/)
    })
  }

  it('rejects a percentage and a price for the same exit', () => {
    expect(
      parseSignalDealOverrides({ tpPerc: 2, tpPrice: 2600 }, BotType.dca).error,
    ).to.match(/either "tpPerc" or "tpPrice"/)
    expect(
      parseSignalDealOverrides({ slPerc: 2, slPrice: 2400 }, BotType.dca).error,
    ).to.match(/either "slPerc" or "slPrice"/)
  })

  for (const type of [BotType.combo, BotType.hedgeCombo, BotType.hedgeDca]) {
    it(`prices are DCA only — refused for ${type}, percentages are not`, () => {
      expect(parseSignalDealOverrides({ slPrice: 2400 }, type).error).to.match(
        /only available for DCA bots/,
      )
      expect(
        parseSignalDealOverrides({ tpPerc: 2, slPerc: 1 }, type).error,
      ).to.equal(undefined)
    })
  }
})

describe('signal deal overrides — prices against the market', () => {
  it('long: TP above, SL below', () => {
    expect(signalPriceError({ tpPrice: '2600', slPrice: '2400' }, PRICE, true))
      .to.be.undefined
    expect(signalPriceError({ tpPrice: '2400' }, PRICE, true)).to.match(
      /take profit price 2400 is not above/,
    )
    expect(signalPriceError({ slPrice: '2600' }, PRICE, true)).to.match(
      /stop loss price 2600 is not below/,
    )
  })
  it('short: TP below, SL above', () => {
    expect(signalPriceError({ tpPrice: '2400', slPrice: '2600' }, PRICE, false))
      .to.be.undefined
    expect(signalPriceError({ tpPrice: '2600' }, PRICE, false)).to.match(
      /not below/,
    )
    expect(signalPriceError({ slPrice: '2400' }, PRICE, false)).to.match(
      /not above/,
    )
  })
})

describe('signal deal overrides — deal settings', () => {
  const bot = {
    tpPerc: '1',
    slPerc: '-5',
    useTp: false,
    useSl: false,
    useMultiTp: true,
    useMultiSl: true,
    trailingSl: true,
    moveSL: true,
    dealCloseCondition: CloseConditionEnum.webhook,
    dealCloseConditionSL: CloseConditionEnum.webhook,
    baseOrderSize: '10',
  }

  it('no overrides leaves the settings as they are', () => {
    expect(applySignalDealOverrides(bot, null)).to.equal(bot)
  })

  it('a TP % replaces the whole TP setup with one target closed by price', () => {
    const s = applySignalDealOverrides(bot, { tpPerc: '3' })
    expect(s).to.include({
      tpPerc: '3',
      useTp: true,
      useMultiTp: false,
      useFixedTPPrices: false,
      dealCloseCondition: CloseConditionEnum.tp,
    })
    // the SL side is untouched
    expect(s).to.include({
      useSl: false,
      dealCloseConditionSL: CloseConditionEnum.webhook,
    })
  })

  it('a SL price is fixed, so trailing and move-SL are off for it', () => {
    const s = applySignalDealOverrides(bot, { slPrice: '2400' })
    expect(s).to.include({
      useSl: true,
      useMultiSl: false,
      useFixedSLPrices: true,
      fixedSlPrice: '2400',
      trailingSl: false,
      moveSL: false,
      dealCloseConditionSL: CloseConditionEnum.tp,
      slPerc: '-5',
    })
  })

  it('a SL % keeps trailing / move-SL, which work from a percentage', () => {
    const s = applySignalDealOverrides(bot, { slPerc: '-2' })
    expect(s).to.include({ slPerc: '-2', trailingSl: true, moveSL: true })
  })

  it('never writes baseOrderSize: TP sizing reads the nominal base order', () => {
    expect(
      applySignalDealOverrides(bot, { baseOrderSize: '50' }).baseOrderSize,
    ).to.equal('10')
  })

  it('the size event names the webhook as the source', () => {
    expect(
      newDealSizeDescription({
        requested: 5,
        applied: 5,
        scope: 'base',
        source: 'webhook',
      }),
    ).to.equal(
      'Deal opened at 5× the configured base order (requested by webhook)',
    )
  })
})

// ---- engine -----------------------------------------------------------------

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 2,
  baseAsset: { name: 'ETH', minAmount: 0.001, step: 0.001 },
  quoteAsset: { name: 'USDC', minAmount: 1 },
  maxOrders: 200,
}

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  isLong = true
  isShort = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  useCompountReduce = false
  scaleAr = false
  tpAr = false
  slAr = false
  closeAfterTpFilled = false
  exchange: any = {}
  orders = new Map()
  standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
  data: any = {}
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any
let ComboHelper: any

const botSettings = (extra: Record<string, unknown> = {}) => ({
  type: 'regular',
  pair: [PAIR],
  startCondition: StartConditionEnum.tradingviewSignals,
  gridLevel: '1',
  ordersCount: 5,
  baseOrderSize: '10',
  orderSizeType: OrderSizeTypeEnum.quote,
  ...extra,
})

type Seen = {
  placed: any[][]
  errors: string[]
  cbNotOpened: number
  events: any[]
}

const buildBot = (Helper: any, settings = botSettings()) => {
  const seen: Seen = { placed: [], errors: [], cbNotOpened: 0, events: [] }
  class TestBot extends Helper {
    seen = seen
    data: any = {
      settings,
      status: 'open',
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'uuid-141',
      profit: { total: 0 },
      flags: [],
      paperContext: true,
    }
    pairs = new Set([PAIR])
    openNewDealTimer = new Map()
    botEventDb = {
      createData: async (d: any) => {
        seen.events.push(d)
        return { status: 'OK', data: d }
      },
    }
    async approveNewDeal() {
      return true
    }
    async getAggregatedSettings() {
      return { ...this.data.settings }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async checkBalance() {
      return { status: true }
    }
    async checkBalanceGate() {
      return { status: true }
    }
    async checkMaxDeals() {
      return true
    }
    async checkInRange() {
      return true
    }
    async getActiveOrders() {
      return 0
    }
    async refuseDealBelowExchangeMin() {
      return false
    }
    async refuseDealBelowMinimumBudget() {
      return false
    }
    async getLatestPrice() {
      return PRICE
    }
    async checkCooldownStart() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async checkCooldownStop() {
      return { status: true, time: 0, last: 0, diff: 0, cooldown: 0 }
    }
    async checkRiskRewardCondition() {
      return { sl: 2400, tp: 2700, size: 10 }
    }
    resetPending() {}
    updateDealLastTime() {}
    releaseReduceToAvailableClaim() {}
    async placeBaseOrder(...args: any[]) {
      seen.placed.push(args)
    }
    async scaleDealSizes(_s: string, m: number) {
      return { base: m - 1, dca: [], origBase: 1, origDca: [] }
    }
    getOpenDeals() {
      return []
    }
    async onNewDealSize() {}
    handleErrors(m: string) {
      seen.errors.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
    handleLog(m: string) {
      return m
    }
    handleWarn(m: string) {
      return m
    }
    handleDebug(m: string) {
      return m
    }
    stop() {}
  }
  return new TestBot()
}

const open = async (bot: any, overrides: any) =>
  bot.openNewDeal(
    BOT_ID,
    PAIR,
    false,
    false,
    0,
    () => {
      bot.seen.cbNotOpened++
    },
    'webhook',
    overrides,
  )

/** placeBaseOrder(_botId, symbol, …, sizes[10], orderSizeType, forceLimit, signalOverrides[13]) */
const SIZES_ARG = 10
const OVERRIDES_ARG = 13

describe('signal deal overrides — engine', () => {
  before(function () {
    // Loading the helpers pulls the whole engine graph in through ts-node.
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
    ComboHelper = loadModule('./comboHelper').default(
      loadModule('./dcaHelper').default(FakeBase as any),
    )
  })

  for (const [name, get] of [
    ['DCA', () => DcaHelper],
    ['Combo', () => ComboHelper],
  ] as const) {
    describe(name, () => {
      it('hands the overrides to the deal being created', async () => {
        const bot = buildBot(get())
        await open(bot, { tpPerc: '3', slPerc: '-2' })
        expect(bot.seen.placed).to.have.length(1)
        expect(bot.seen.placed[0][OVERRIDES_ARG]).to.deep.equal({
          tpPerc: '3',
          slPerc: '-2',
        })
      })

      it('baseOrderSize opens the base order at that size, beyond the hook bounds', async () => {
        const bot = buildBot(get())
        await open(bot, { baseOrderSize: '50' })
        expect(bot.seen.placed).to.have.length(1)
        expect(bot.seen.placed[0][SIZES_ARG]).to.include({
          multiplier: 5,
          multiplierScope: 'base',
        })
        expect(bot.seen.events.map((e) => e.description)).to.include(
          'Deal opened at 5× the configured base order (requested by webhook)',
        )
      })

      it('without overrides nothing changes', async () => {
        const bot = buildBot(get())
        await open(bot, undefined)
        expect(bot.seen.placed).to.have.length(1)
        expect(bot.seen.placed[0][OVERRIDES_ARG]).to.equal(undefined)
      })
    })
  }

  describe('DCA prices', () => {
    it('opens with prices on the right side of the market', async () => {
      const bot = buildBot(DcaHelper)
      await open(bot, { tpPrice: '2600', slPrice: '2400' })
      expect(bot.seen.placed).to.have.length(1)
      expect(bot.seen.errors).to.deep.equal([])
    })

    it('does not open with a stop loss the market has already passed', async () => {
      const bot = buildBot(DcaHelper)
      await open(bot, { slPrice: '2600' })
      expect(bot.seen.placed).to.have.length(0)
      expect(bot.seen.cbNotOpened).to.equal(1)
      expect(bot.seen.errors[0]).to.match(
        /not opened: stop loss price 2600 is not below the current price 2500/,
      )
    })

    it('does not open with TP / SL on a risk/reward bot', async () => {
      const bot = buildBot(DcaHelper, botSettings({ useRiskReward: true }))
      await open(bot, { tpPerc: '3' })
      expect(bot.seen.placed).to.have.length(0)
      expect(bot.seen.errors[0]).to.match(/risk\/reward/)
    })
  })

  describe('DCA getAggregatedSettings', () => {
    const aggregate = async (deal: any) => {
      const Helper = DcaHelper
      class AggBot extends Helper {
        data: any = { settings: botSettings({ useTp: true, useSl: true }) }
        async replaceBotSettings(s: any) {
          return s
        }
      }
      return new (AggBot as any)().getAggregatedSettings(deal)
    }
    const dealSettings = {
      useTp: true,
      useSl: true,
      useFixedTPPrices: true,
      useFixedSLPrices: true,
      fixedTpPrice: '2600',
      fixedSlPrice: '2400',
    }

    it('a deal opened with signal prices uses them', async () => {
      const s = await aggregate({
        settings: dealSettings,
        signalOverrides: { tpPrice: '2600', slPrice: '2400' },
      })
      expect(s.useFixedTPPrices).to.equal(true)
      expect(s.useFixedSLPrices).to.equal(true)
    })

    it('a regular deal carrying the flags without a signal still does not', async () => {
      const s = await aggregate({ settings: dealSettings })
      expect(s.useFixedTPPrices).to.equal(false)
      expect(s.useFixedSLPrices).to.equal(false)
    })
  })
})
