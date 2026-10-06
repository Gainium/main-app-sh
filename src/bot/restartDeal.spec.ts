process.env.NODE_ENV = 'testing'

/**
 * `restartDeal` — rebuild one deal's orders without reloading the bot.
 * https://community.gainium.io/t/restart-option-for-individual-deals/5302
 *
 * The rebuild itself is the one a deal settings save already runs
 * (`rebuildDealOrders`), so it is recorded here, not run. What is under test
 * is which deals get it: only an open (or errored) deal, and never a deal that
 * is closed or still opening — a restart there would cancel and re-place
 * orders the deal no longer owns, or race its base order.
 *
 * The API layer (`Bot.restartDeal`) routes by the bot that owns the deal, so
 * a hedge deal reaches its long / short child even when the hedge parent's id
 * is sent.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import Bot from './index'
import { StatusEnum } from '../../types'

const DEAL_ID = '000000000000000000000d07'
const BOT_ID = '000000000000000000000b07'

let Helper: any

const buildBot = (status?: string) => {
  const rebuilt: string[] = []
  const errors: string[] = []
  const deal = status
    ? { deal: { _id: DEAL_ID, botId: BOT_ID, status } }
    : undefined
  class TestBot extends (Helper as any) {
    rebuilt = rebuilt
    errors = errors
    botId = BOT_ID
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    async rebuildDealOrders(_d: any, dealId: string) {
      rebuilt.push(dealId)
    }
    handleLog() {}
    handleDebug() {}
    handleErrors(msg: string) {
      errors.push(msg)
    }
  }
  return new (TestBot as any)()
}

describe('restartDeal', () => {
  before(function () {
    this.timeout(240000)
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  for (const status of ['open', 'error']) {
    it(`rebuilds the orders of an ${status} deal`, async () => {
      const bot = buildBot(status)
      await bot.restartDeal(BOT_ID, DEAL_ID)
      expect(bot.rebuilt).to.deep.equal([DEAL_ID])
      expect(bot.errors).to.deep.equal([])
    })
  }

  for (const status of ['closed', 'start', 'canceled']) {
    it(`refuses a ${status} deal and touches no orders`, async () => {
      const bot = buildBot(status)
      await bot.restartDeal(BOT_ID, DEAL_ID)
      expect(bot.rebuilt).to.deep.equal([])
      expect(bot.errors).to.have.length(1)
    })
  }

  it('refuses a deal the bot does not hold', async () => {
    const bot = buildBot()
    await bot.restartDeal(BOT_ID, DEAL_ID)
    expect(bot.rebuilt).to.deep.equal([])
    expect(bot.errors).to.have.length(1)
  })
})

describe('Bot.restartDeal routing', () => {
  const USER_ID = 'user-restart'
  const PARENT_ID = 'hedge-parent'
  const CHILD_ID = 'hedge-child-short'

  const harness = (owner: string | undefined) => {
    const posted: any[] = []
    const dealsDb = {
      readData: async () => ({
        status: StatusEnum.ok,
        reason: null,
        data: { result: owner ? { _id: DEAL_ID, botId: owner } : null },
      }),
    }
    const bot: any = Object.create((Bot as any).prototype)
    bot.useBots = true
    bot.dcaDealsDb = dealsDb
    bot.comboDealsDb = dealsDb
    bot.dcaBots = [{ id: CHILD_ID, userId: USER_ID, worker: 'w1' }]
    bot.comboBots = [{ id: CHILD_ID, userId: USER_ID, worker: 'w2' }]
    bot.getWorkerById = () => ({ postMessage: (m: any) => posted.push(m) })
    bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
    bot.handleDebug = () => {}
    bot.posted = posted
    return bot
  }

  for (const combo of [false, true]) {
    it(`a hedge ${combo ? 'Combo' : 'DCA'} deal is sent to its child bot`, async () => {
      const bot = harness(CHILD_ID)
      const res = await bot.restartDeal(PARENT_ID, DEAL_ID, USER_ID, false, combo)
      expect(res.status).to.equal(StatusEnum.ok)
      expect(bot.posted).to.have.length(1)
      expect(bot.posted[0]).to.deep.include({
        botType: combo ? 'combo' : 'dca',
        botId: CHILD_ID,
        method: 'restartDeal',
        args: [CHILD_ID, DEAL_ID],
      })
    })
  }

  it('a deal the user does not own is not found and nothing is sent', async () => {
    const bot = harness(undefined)
    const res = await bot.restartDeal(PARENT_ID, DEAL_ID, USER_ID, false)
    expect(res.status).to.equal(StatusEnum.notok)
    expect(bot.posted).to.deep.equal([])
  })
})
