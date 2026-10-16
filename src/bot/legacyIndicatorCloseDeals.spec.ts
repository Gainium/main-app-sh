process.env.NODE_ENV = 'testing'

/**
 * Spec 167: deals opened under "close by indicator" keep closing by their own
 * indicator and minimum profit after the bot moves to a percentage take
 * profit. Real engine methods off the DCA helper prototype, no stack.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import {
  BotStatusEnum,
  CloseConditionEnum,
  CloseDCATypeEnum,
  DCADealStatusEnum,
  IndicatorAction,
  IndicatorEnum,
  IndicatorsLogicEnum,
  IndicatorStartConditionEnum,
  StartConditionEnum,
  StrategyEnum,
} from '../../types'

const Helper: any = createDCABotHelper(MainBot as any)
const SYMBOL = 'URNMUSDT'
const GROUP = 'g-close'

const closeIndicator = {
  uuid: 'rsi-close',
  type: IndicatorEnum.rsi,
  indicatorAction: IndicatorAction.closeDeal,
  indicatorInterval: '1m',
  indicatorLength: 14,
  indicatorValue: '1',
  indicatorCondition: IndicatorStartConditionEnum.gt,
  groupId: GROUP,
}

/** the bot after the switch: percentage TP, minimum profit off */
const botSettings = {
  pair: [SYMBOL],
  strategy: StrategyEnum.long,
  startCondition: StartConditionEnum.asap,
  useTp: true,
  useSl: false,
  dealCloseCondition: CloseConditionEnum.tp,
  dealCloseConditionSL: CloseConditionEnum.tp,
  useMinTP: false,
  minTp: '1',
  tpPerc: '2',
  indicators: [closeIndicator],
  indicatorGroups: [
    {
      id: GROUP,
      action: IndicatorAction.closeDeal,
      logic: IndicatorsLogicEnum.and,
    },
  ],
}

const deal = (id: string, settings: Record<string, unknown>) => ({
  deal: {
    _id: id,
    status: DCADealStatusEnum.open,
    avgPrice: 100,
    symbol: { symbol: SYMBOL },
    settings,
  },
})

/** opened before the switch: indicator close with a 1% minimum profit */
const legacy = deal('legacy', {
  useTp: true,
  dealCloseCondition: CloseConditionEnum.techInd,
  dealCloseConditionSL: CloseConditionEnum.tp,
  useMinTP: true,
  minTp: '1',
  tpPerc: '1',
})
/** opened after the switch: percentage TP with a resting limit order */
const fresh = deal('fresh', {
  useTp: true,
  dealCloseCondition: CloseConditionEnum.tp,
  dealCloseConditionSL: CloseConditionEnum.tp,
  useMinTP: false,
  minTp: '1',
  tpPerc: '2',
})

function makeBot(deals: any[], price: number) {
  const subscribed: string[] = []
  const closed: string[] = []
  const bot: any = Object.create(Helper.prototype)
  Object.assign(bot, {
    botId: 'bot1',
    botType: 'dca',
    data: {
      exchange: 'binanceUsdm',
      status: BotStatusEnum.open,
      settings: botSettings,
    },
    loadingComplete: true,
    isLong: true,
    combo: false,
    allowedMethods: new Set<string>(),
    indicators: new Map(),
    indicatorsIntervalActionMap: new Map(),
    lastIndicatorsDataMap: new Map(),
    dcaIndicatorArmedAt: new Map(),
    afterIndicatorsConnected: [],
    scaleAr: false,
    tpAr: false,
    slAr: false,
    saveIndicators: false,
    openAtStartTriggered: true,
    getOpenDeals: () => deals,
    // the per-deal price-watch sweep; not what is under test here
    checkDealsAllowedMethods: async () => undefined,
    getDealsByStatusAndSymbol: () => deals,
    getLatestPrice: async () => price,
    getUserFee: async () => ({ maker: 0, taker: 0 }),
    startMethod: () => 'm',
    endMethod: () => undefined,
    runAfterIndicatorsConnected: () => undefined,
    startSessionCheckTimer: () => undefined,
    showIndicatorLogs: () => false,
    handleDebug: () => undefined,
    handleLog: () => undefined,
    handleWarn: () => undefined,
    handleErrors: () => undefined,
    sendIndicatorSubscribeEvent: async (dto: any) => {
      subscribed.push(`${dto.responseParams.uuid}@${dto.data.symbol}`)
      return { id: 'id', room: 'room', data: [], cb: () => undefined }
    },
    closeDealById: async (_botId: string, id: string) => {
      closed.push(id)
    },
  })
  return { bot, subscribed, closed }
}

describe('spec 167: indicator-close deals after a switch to percentage TP', () => {
  it('§4.1 the bot still needs indicators while such a deal is open', async () => {
    const { bot } = makeBot([legacy, fresh], 100)
    expect(await bot.isIndicator(false, 2)).to.equal(true)
  })

  it('§4.1 no deal on indicator close → no indicators needed (unchanged)', async () => {
    const { bot } = makeBot([fresh], 100)
    expect(await bot.isIndicator(false, 1)).to.equal(false)
  })

  it('§4.2 the close indicator is subscribed on the deal symbol', async () => {
    const { bot, subscribed } = makeBot([legacy, fresh], 100)
    await bot.openIndicators('bot1', false)
    expect(subscribed).to.deep.equal([`rsi-close@${SYMBOL}`])
  })

  it('§4.2 not subscribed when only percentage-TP deals are open (unchanged)', async () => {
    const { bot, subscribed } = makeBot([fresh], 100)
    await bot.openIndicators('bot1', false)
    expect(subscribed).to.deep.equal([])
  })

  it('§4.3 below the deal minimum profit the signal does not close it', async () => {
    const { bot, closed } = makeBot([legacy, fresh], 100.5)
    await bot.checkAllowedMethods()
    await bot.closeAllDeals(
      CloseDCATypeEnum.closeByMarket,
      SYMBOL,
      true,
      true,
    )
    expect(closed).to.deep.equal([])
  })

  it('§4.3/§4.4 above the minimum the signal closes the indicator deal only', async () => {
    const { bot, closed } = makeBot([legacy, fresh], 101.5)
    await bot.checkAllowedMethods()
    await bot.closeAllDeals(
      CloseDCATypeEnum.closeByMarket,
      SYMBOL,
      true,
      true,
    )
    expect(closed).to.deep.equal(['legacy'])
  })
})
