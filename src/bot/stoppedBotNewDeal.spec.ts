process.env.NODE_ENV = 'testing'

/**
 * A manual "+ New deal" on a bot stopped with "leave open deals" is refused
 * with a message, not reported as scheduled and then dropped by the worker.
 *
 * Such a bot keeps its worker for the deals it left open, so the API found it
 * among the running bots, answered "Deal scheduled to start" and logged "DCA
 * deal opened manually" — and the worker's deal-opening gates then skipped it
 * without a word.
 *
 * The real methods are driven off the prototype: no Mongo, no worker threads.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import Bot from './index'
import { BotStatusEnum, BotType, StatusEnum } from '../../types'
import { stoppedBotNewDealMessage } from './stoppedBotNewDeal'

const USER_ID = 'user-1'
const BOT_ID = '000000000000000000000144'

const apiHarness = (status: BotStatusEnum, previousStatus?: BotStatusEnum) => {
  const posted: any[] = []
  const events: any[] = []
  const botDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: { _id: BOT_ID, status, previousStatus } },
    }),
  }
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaBots = [{ id: BOT_ID, userId: USER_ID, worker: 1 }]
  bot.comboBots = [{ id: BOT_ID, userId: USER_ID, worker: 1 }]
  bot.dcaBotDb = botDb
  bot.comboBotDb = botDb
  bot.getWorkerById = () => ({ postMessage: (m: any) => posted.push(m) })
  bot.botEventDb = { createData: (e: any) => events.push(e) }
  return { bot, posted, events }
}

for (const method of ['openDCADeal', 'openComboDeal'] as const) {
  describe(`Bot.${method} on a stopped bot`, () => {
    it('refuses a bot stopped with deals left open', async () => {
      const { bot, posted, events } = apiHarness(BotStatusEnum.closed)
      const res = await bot[method](USER_ID, BOT_ID, 'BTCUSDT')
      expect(res).to.deep.equal({
        status: StatusEnum.notok,
        reason: stoppedBotNewDealMessage,
        data: null,
      })
      expect(posted).to.have.length(0)
      expect(events).to.have.length(0)
    })

    it('refuses a stopped bot that has since errored', async () => {
      const { bot, posted } = apiHarness(
        BotStatusEnum.error,
        BotStatusEnum.closed,
      )
      const res = await bot[method](USER_ID, BOT_ID, 'BTCUSDT')
      expect(res.status).to.equal(StatusEnum.notok)
      expect(posted).to.have.length(0)
    })

    it('still schedules the deal on a running bot', async () => {
      for (const status of [BotStatusEnum.open, BotStatusEnum.monitoring]) {
        const { bot, posted } = apiHarness(status)
        const res = await bot[method](USER_ID, BOT_ID, 'BTCUSDT')
        expect(res.status, status).to.equal(StatusEnum.ok)
        expect(posted, status).to.have.length(1)
      }
    })
  })
}

describe('DCA worker openNewDealMan on a stopped bot', () => {
  let DCA: any
  before(function () {
    this.timeout(240000)
    DCA = createRequire(__filename)('./dcaHelper').default()
  })

  const workerHarness = (status: BotStatusEnum) => {
    const bot: any = Object.create(DCA.prototype)
    bot.botType = BotType.dca
    bot.data = { status, settings: { pair: ['BTCUSDT', 'ETHUSDT'] } }
    bot.reported = [] as string[]
    bot.opened = [] as string[]
    bot.handleLog = () => undefined
    bot.reportUserRefusal = async (m: string) => bot.reported.push(m)
    bot.getAggregatedSettings = async () => bot.data.settings
    bot.openNewDeal = async (_b: string, symbol: string) =>
      bot.opened.push(symbol)
    return bot
  }

  it('reports the refusal instead of dropping it, on every click', async () => {
    const bot = workerHarness(BotStatusEnum.closed)
    await bot.openNewDealMan()
    await bot.openNewDealMan()
    expect(bot.reported).to.deep.equal([
      stoppedBotNewDealMessage,
      stoppedBotNewDealMessage,
    ])
    expect(bot.opened).to.have.length(0)
  })

  it('opens on every pair of a running bot', async () => {
    const bot = workerHarness(BotStatusEnum.open)
    await bot.openNewDealMan()
    expect(bot.reported).to.have.length(0)
    expect(bot.opened).to.deep.equal(['BTCUSDT', 'ETHUSDT'])
  })
})
