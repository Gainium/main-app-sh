process.env.NODE_ENV = 'testing'

/**
 * DCA by indicators subscribes only the indicator of each open deal's NEXT
 * level, not every `startDca` indicator on every pair.
 *
 * Each `startDca` indicator is one ladder level and `addDCAOrderByIndicator`
 * drops a signal for any level the deal is not on, so the other subscriptions
 * only cost indicator streams. A level subscribed because the deal just
 * reached it is armed: the candle that had already closed is not its signal.
 *
 * Drives the REAL `dueDcaIndicatorKeys`, `syncDcaIndicatorLevels`,
 * `openIndicators` and `checkIndicatorConditions`. The indicator service is a
 * recorder; no stack, DB, Redis or exchange connection.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum } from '../../../types'
import { createRequire } from 'module'

const MINUTE = 60_000

const indicators: any[] = [0, 1, 2].map((i) => ({
  type: 'RSI',
  indicatorLength: 14,
  indicatorValue: '30',
  indicatorCondition: 'lt',
  indicatorInterval: '1m',
  uuid: `uuid-${i}`,
  indicatorAction: 'startDca',
  section: 'dca',
  minPercFromLast: '1',
}))

const INDICATORS: any = {
  strategy: 'LONG',
  pair: ['SOLUSDT', 'ETHUSDT', 'BTCUSDT'],
  indicators,
  indicatorGroups: [],
  useDca: true,
  dcaCondition: 'indicators',
  startCondition: 'asap',
}

class FakeBase {
  math = new MathHelper()
  botId = 'bot'
  userId = 'user'
  isLong = true
  futures = false
  combo = false
  hedge = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  data: any = { exchange: ExchangeEnum.binance, flags: [], status: 'open' }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

/** An open deal on `symbol` that has filled `filled` safety orders. */
const deal = (symbol: string, filled: number) => ({
  deal: {
    _id: `deal-${symbol}`,
    symbol: { symbol },
    status: 'open',
    levels: { all: 4, complete: 1 + filled },
    funds: [],
  },
})

const buildBot = (settings: any, deals: any[]) => {
  class TestBot extends Helper {
    subscribed: { key: string; arm?: boolean }[] = []
    unsubscribed: string[] = []
    statusChecks: any[] = []
    getDealsByStatusAndSymbol() {
      return deals
    }
    getOpenDeals() {
      return deals
    }
    async getAggregatedSettings() {
      return settings
    }
    async connectSettingsIndicator(i: any, symbol: string, ctx: any) {
      const key = `${i.uuid}@${symbol}`
      this.subscribed.push({ key, arm: ctx.armDcaLevel })
      if (ctx.armDcaLevel) {
        this.dcaIndicatorArmedAt.set(key, Date.now())
      }
      this.indicators.set(key, {
        uuid: i.uuid,
        id: `id-${key}`,
        room: 'room',
        status: false,
        symbol,
        key,
        action: i.indicatorAction,
        interval: i.indicatorInterval,
        section: i.section,
        parentIndicator: '',
        childIndicator: '',
        maCross: false,
        data: true,
        history: [],
      })
    }
    async sendIndicatorUnsubscribeEvent(id: string) {
      this.unsubscribed.push(id)
      return true
    }
    async runAfterIndicatorsConnected() {}
    startSessionCheckTimer() {}
    checkIndicatorStatus(...args: any[]) {
      this.statusChecks.push(args)
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
  const bot: any = new TestBot()
  bot.data.settings = settings
  bot.redisSubIndicators = {}
  bot.pairs = new Set(settings.pair)
  return bot
}

describe('DCA by indicators: subscribe only the next level', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('dueDcaIndicatorKeys', () => {
    it("one key per open deal: its next level's indicator", () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 0), deal('ETHUSDT', 2)])
      expect([...bot.dueDcaIndicatorKeys(INDICATORS)]).to.have.members([
        'uuid-0@SOLUSDT',
        'uuid-2@ETHUSDT',
      ])
    })

    it('nothing for a deal whose ladder is spent, or a pair with no deal', () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 3)])
      expect([...bot.dueDcaIndicatorKeys(INDICATORS)]).to.deep.equal([])
    })

    it('an add-funds top-up does not move the level', () => {
      const d: any = deal('SOLUSDT', 1)
      d.deal.levels.complete += 1
      d.deal.funds = [{ qty: '1' }]
      const bot = buildBot(INDICATORS, [d])
      expect([...bot.dueDcaIndicatorKeys(INDICATORS)]).to.deep.equal([
        'uuid-1@SOLUSDT',
      ])
    })

    it('not gated unless DCA is by indicators', () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 0)])
      expect(
        bot.dueDcaIndicatorKeys({ ...INDICATORS, dcaCondition: 'percentage' }),
      ).to.equal(null)
      expect(
        bot.dueDcaIndicatorKeys({ ...INDICATORS, useDca: false }),
      ).to.equal(null)
    })

    it('not gated for scale-AR, which reads every startDca indicator', () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 0)])
      bot.scaleAr = true
      expect(bot.dueDcaIndicatorKeys(INDICATORS)).to.equal(null)
    })
  })

  describe('openIndicators', () => {
    it('subscribes the due level only, on the deal pair only', async () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 1)])
      await bot.openIndicators('bot')
      expect(bot.subscribed.map((s: any) => s.key)).to.deep.equal([
        'uuid-1@SOLUSDT',
      ])
      expect(bot.subscribed[0].arm).to.equal(undefined)
    })

    it('other indicators are still subscribed on every pair', async () => {
      const settings = {
        ...INDICATORS,
        startCondition: 'ti',
        indicators: [
          ...indicators,
          { ...indicators[0], uuid: 'open', indicatorAction: 'startDeal' },
        ],
      }
      const bot = buildBot(settings, [])
      await bot.openIndicators('bot')
      expect(bot.subscribed.map((s: any) => s.key)).to.have.members([
        'open@SOLUSDT',
        'open@ETHUSDT',
        'open@BTCUSDT',
      ])
    })
  })

  describe('syncDcaIndicatorLevels', () => {
    it('moves the subscription to the level the deal reached, armed', async () => {
      const deals = [deal('SOLUSDT', 0)]
      const bot = buildBot(INDICATORS, deals)
      await bot.openIndicators('bot')
      deals[0].deal.levels.complete = 2
      bot.subscribed = []
      await bot.syncDcaIndicatorLevels('bot')
      expect(bot.unsubscribed).to.deep.equal(['id-uuid-0@SOLUSDT'])
      expect(bot.subscribed).to.deep.equal([
        { key: 'uuid-1@SOLUSDT', arm: true },
      ])
      expect([...bot.indicators.keys()]).to.deep.equal(['uuid-1@SOLUSDT'])
    })

    it('drops the subscription when the deal closes', async () => {
      const deals = [deal('SOLUSDT', 0)]
      const bot = buildBot(INDICATORS, deals)
      await bot.openIndicators('bot')
      deals.pop()
      await bot.syncDcaIndicatorLevels('bot')
      expect(bot.unsubscribed).to.deep.equal(['id-uuid-0@SOLUSDT'])
      expect(bot.indicators.size).to.equal(0)
    })

    it('no-op when the subscriptions already match', async () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 0)])
      await bot.openIndicators('bot')
      bot.subscribed = []
      await bot.syncDcaIndicatorLevels('bot')
      expect(bot.unsubscribed).to.deep.equal([])
      expect(bot.subscribed).to.deep.equal([])
    })
  })

  describe('armed level', () => {
    const rsi = (time: number, value: number) => [
      { time: time - MINUTE, value: { value: 50 }, type: 'RSI' },
      { time, value: { value }, type: 'RSI' },
    ]

    it('ignores the candle that closed before the level was armed', async () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 1)])
      await bot.connectSettingsIndicator(indicators[1], 'SOLUSDT', {
        armDcaLevel: true,
      })
      const armedAt = bot.dcaIndicatorArmedAt.get('uuid-1@SOLUSDT')
      // Opened a minute before arming, closed at or before it.
      const closed = armedAt - MINUTE
      await bot.checkIndicatorConditions(
        'bot',
        'uuid-1',
        rsi(closed, 20),
        'SOLUSDT',
      )
      expect(bot.statusChecks).to.have.length(0)
      expect(bot.indicators.get('uuid-1@SOLUSDT').status).to.equal(false)
    })

    it('fires on the first candle that closes after arming', async () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 1)])
      await bot.connectSettingsIndicator(indicators[1], 'SOLUSDT', {
        armDcaLevel: true,
      })
      const armedAt = bot.dcaIndicatorArmedAt.get('uuid-1@SOLUSDT')
      const next = armedAt - MINUTE + 1
      await bot.checkIndicatorConditions(
        'bot',
        'uuid-1',
        rsi(next, 20),
        'SOLUSDT',
      )
      expect(bot.statusChecks).to.have.length(1)
      expect(bot.indicators.get('uuid-1@SOLUSDT').status).to.equal(true)
      expect(bot.dcaIndicatorArmedAt.has('uuid-1@SOLUSDT')).to.equal(false)
    })

    it('a level subscribed by openIndicators is not armed (restart keeps today)', async () => {
      const bot = buildBot(INDICATORS, [deal('SOLUSDT', 1)])
      await bot.openIndicators('bot')
      expect(bot.dcaIndicatorArmedAt.size).to.equal(0)
    })
  })
})
