process.env.NODE_ENV = 'testing'

/**
 * Spec `204.close-by-timer-for-combo-bots`.
 *
 * Drives the REAL `closeByTimer` (DCA and Combo), Combo `startDeal` and the
 * settings-key checks of the public API. Only what the methods call out to is
 * recorded instead of run. `restoreWork` (§1.5) is covered in
 * `startReconcilesBook.harness.spec.ts`, which already drives the real one.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  CloseDCATypeEnum,
  CooldownUnits,
  DCACloseTriggerEnum,
  DCADealStatusEnum,
  StatusEnum,
} from '../../../types'
import { checkDCABotSettings, checkDCADealSettings } from '../utils'

const DEAL_ID = '000000000000000000000d04'
const BOT_ID = '000000000000000000000b04'

let Combo: any
let Dca: any

const timerOn = {
  useTp: true,
  closeByTimer: true,
  closeByTimerValue: 2,
  closeByTimerUnits: CooldownUnits.hours,
}

const recorder = (Helper: any, settings: Record<string, unknown>) => {
  const bot: any = Object.create(Helper.prototype)
  bot.botId = BOT_ID
  bot.closeDealTimer = new Map()
  bot.closes = [] as unknown[][]
  bot.getAggregatedSettings = async () => settings
  bot.closeDealById = (...args: unknown[]) => {
    bot.closes.push(args)
  }
  bot.handleDebug = () => undefined
  bot.handleLog = () => undefined
  return bot
}

describe('close by timer for combo bots (spec 204)', function () {
  this.timeout(30_000)

  before(function () {
    this.timeout(240000)
    const req = createRequire(__filename)
    Dca = req('../dcaHelper').default()
    Combo = req('../comboHelper').default()
  })

  describe('§1.4 / §2.1 the timer closes with the deal close type', () => {
    it('combo, limit close type: closes by limit without forcing market', async () => {
      const bot = recorder(Combo, { ...timerOn, comboTpLimit: true })
      await bot.closeByTimer({ _id: DEAL_ID })
      expect(bot.closes).to.have.length(1)
      const [botId, dealId, closeType, , forceMarket] = bot.closes[0]
      expect([botId, dealId]).to.deep.equal([BOT_ID, DEAL_ID])
      expect(closeType).to.equal(CloseDCATypeEnum.closeByLimit)
      expect(forceMarket).to.equal(false)
      expect(bot.closes[0][10]).to.equal(DCACloseTriggerEnum.timer)
    })

    it('combo, market close type: closes by market', async () => {
      const bot = recorder(Combo, {
        ...timerOn,
        comboTpLimit: false,
        // DCA's own field never steers a combo close.
        closeDealType: CloseDCATypeEnum.leave,
      })
      await bot.closeByTimer({ _id: DEAL_ID })
      expect(bot.closes[0][2]).to.equal(CloseDCATypeEnum.closeByMarket)
      expect(bot.closes[0][4]).to.equal(true)
      expect(bot.closes[0][10]).to.equal(DCACloseTriggerEnum.timer)
    })

    it('§1.2 combo with take profit off is never closed by the timer', async () => {
      const bot = recorder(Combo, { ...timerOn, useTp: false })
      await bot.closeByTimer({ _id: DEAL_ID })
      expect(bot.closes).to.have.length(0)
    })

    it('DCA is unchanged: its own close type, forced to market', async () => {
      const bot = recorder(Dca, {
        ...timerOn,
        closeDealType: CloseDCATypeEnum.closeByLimit,
        comboTpLimit: false,
      })
      await bot.closeByTimer({ _id: DEAL_ID })
      expect(bot.closes[0][2]).to.equal(CloseDCATypeEnum.closeByLimit)
      expect(bot.closes[0][4]).to.equal(true)
      expect(bot.closes[0][10]).to.equal(DCACloseTriggerEnum.timer)
    })
  })

  describe('§1.5 / §2.2 the timer is armed when a combo deal opens', () => {
    const openDeal = async () => {
      const deal: any = {
        deal: {
          _id: DEAL_ID,
          botId: BOT_ID,
          status: DCADealStatusEnum.start,
          symbol: { symbol: 'AAA-USDT', baseAsset: 'AAA', quoteAsset: 'USDT' },
          levels: { complete: 0, all: 1 },
          settings: {},
        },
        initialOrders: [],
        currentOrders: [],
        previousOrders: [],
      }
      const bot: any = Object.create(Combo.prototype)
      const armed: string[] = []
      bot.botId = BOT_ID
      bot.data = { settings: {}, status: 'open' }
      bot.getDeal = () => deal
      bot.startMethod = () => '1'
      bot.endMethod = () => undefined
      bot.handleLog = () => undefined
      bot.handleWarn = () => undefined
      bot.handleDebug = () => undefined
      bot.clearDealTimer = async () => undefined
      bot.createInitialDealOrders = async () => []
      bot.createCurrentDealOrders = async () => []
      bot.getUserFee = async () => ({ maker: 0, taker: 0 })
      bot.getCommDeal = async () => 0
      bot.saveDeal = () => undefined
      bot.createMinigrid = async () => []
      bot.updateUsage = async () => undefined
      bot.checkDealsAllowedMethods = async () => undefined
      bot.checkDealSlMethods = async () => undefined
      bot.placeFeeOrder = async () => undefined
      bot.updateAssets = () => undefined
      bot.placeOrders = async () => undefined
      bot.findDiffCombo = async () => ({ new: [], cancel: [] })
      bot.checkOpenedDeals = async () => undefined
      bot.updateDealLastPrices = () => undefined
      bot.sendDealOpenedAlert = () => undefined
      bot.updateDealBalances = () => undefined
      bot.calculateBotBalances = () => undefined
      bot.updateBotDealStats = () => undefined
      bot.setCloseByTimer = async (d: any) => {
        armed.push(`${d._id} ${d.status}`)
      }
      await bot.startDeal({
        dealId: DEAL_ID,
        symbol: 'AAA-USDT',
        price: '10',
        executedQty: '1',
        updateTime: 1790000000000,
        clientOrderId: 'CMB-BO-1',
      })
      await new Promise((r) => setTimeout(r, 20))
      return armed
    }

    it('arms one timer for the deal, once it is open', async () => {
      expect(await openDeal()).to.deep.equal([`${DEAL_ID} open`])
    })
  })

  describe('§1.7 / §2.4 the public API accepts the timer on combo', () => {
    const patch = {
      closeByTimer: true,
      closeByTimerValue: 3,
      closeByTimerUnits: CooldownUnits.days,
    }

    it('combo bot settings update', () => {
      expect(checkDCABotSettings({} as any, patch as any, true).status).to.equal(
        StatusEnum.ok,
      )
    })

    it('combo deal settings update', () => {
      expect(
        checkDCADealSettings({} as any, patch as any, true).status,
      ).to.equal(StatusEnum.ok)
    })

    it('DCA bot settings update still accepts it', () => {
      expect(
        checkDCABotSettings({} as any, patch as any, false).status,
      ).to.equal(StatusEnum.ok)
    })
  })
})
