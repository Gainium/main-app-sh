process.env.NODE_ENV = 'testing'

/**
 * A bot may hold an in / out Session (the clock filter) AND Price levels
 * Sessions: the clock timer takes only the in / out one, and the Price levels
 * ones are subscribed from candles like any other indicator.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import {
  ExchangeIntervals,
  IndicatorAction,
  IndicatorEnum,
  IndicatorStartConditionEnum,
  SessionLevelEnum,
  SessionRuleEnum,
  StartConditionEnum,
} from '../../types'
import type { SettingsIndicators } from '../../types'

const Helper: any = createDCABotHelper(MainBot as any)
const SYMBOL = 'BTCUSDT'

const session = (
  uuid: string,
  o: Partial<SettingsIndicators>,
): SettingsIndicators =>
  ({
    type: IndicatorEnum.session,
    uuid,
    groupId: 'g1',
    indicatorAction: IndicatorAction.startDeal,
    indicatorInterval: ExchangeIntervals.fifteenM,
    indicatorLength: 14,
    indicatorCondition: IndicatorStartConditionEnum.cu,
    sessionDays: [0, 1, 2, 3, 4, 5, 6],
    ...o,
  }) as SettingsIndicators

function makeBot(indicators: SettingsIndicators[]) {
  const settings = {
    startCondition: StartConditionEnum.ti,
    pair: [SYMBOL],
    indicators,
    indicatorGroups: [{ id: 'g1', action: IndicatorAction.startDeal }],
  }
  const subscribed: SettingsIndicators[] = []
  const bot: any = Object.create(Helper.prototype)
  Object.assign(bot, {
    botId: 'bot1',
    botType: 'dca',
    data: { exchange: 'binance', settings },
    indicators: new Map(),
    pairs: new Set([SYMBOL]),
    lastIndicatorsDataMap: new Map(),
    afterIndicatorsConnected: [],
    saveIndicators: false,
    scaleAr: false,
    getAggregatedSettings: async () => settings,
    getOpenDeals: () => [],
    getDealCloseIndicatorSymbols: async () => ({
      tp: new Set(),
      sl: new Set(),
    }),
    connectSettingsIndicator: async (i: SettingsIndicators) => {
      subscribed.push(i)
    },
    runAfterIndicatorsConnected: () => undefined,
    checkIndicatorStatus: () => undefined,
    startMethod: () => 'm',
    endMethod: () => undefined,
    handleDebug: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleErrors: () => undefined,
  })
  return { bot, subscribed }
}

describe('Session Price levels next to an in / out Session', () => {
  const levelsA = session('levelsA', {
    sessionRule: SessionRuleEnum.levels,
    sessionLevelA: SessionLevelEnum.price,
    sessionLevelB: SessionLevelEnum.prevHigh,
  })
  const levelsB = session('levelsB', {
    sessionRule: SessionRuleEnum.levels,
    sessionLevelA: SessionLevelEnum.price,
    sessionLevelB: SessionLevelEnum.prevLow,
    indicatorCondition: IndicatorStartConditionEnum.cd,
  })

  it('subscribes the Price levels Sessions and leaves in / out to the clock', async () => {
    for (const clock of [
      session('clock', { sessionRule: SessionRuleEnum.in }),
      session('clock', { sessionRule: SessionRuleEnum.out }),
      session('clock', {}),
    ]) {
      // the Price levels Session listed first must not be taken as the clock
      const { bot, subscribed } = makeBot([levelsA, clock, levelsB])
      await bot.openIndicators('bot1')
      bot.stopSessionCheckTimer()
      expect(subscribed.map((i) => i.uuid)).to.deep.equal([
        'levelsA',
        'levelsB',
      ])
      expect([...bot.indicators.keys()]).to.deep.equal([`clock@${SYMBOL}`])
      const status = bot.indicators.get(`clock@${SYMBOL}`).status
      expect(status, `${clock.sessionRule}`).to.equal(
        clock.sessionRule !== SessionRuleEnum.out,
      )
    }
  })

  it('runs no clock timer when every Session is Price levels', async () => {
    const { bot, subscribed } = makeBot([levelsA])
    await bot.openIndicators('bot1')
    expect(bot.sessionCheckTimer ?? null).to.equal(null)
    expect(subscribed.map((i) => i.uuid)).to.deep.equal(['levelsA'])
    expect(bot.indicators.size).to.equal(0)
  })
})
