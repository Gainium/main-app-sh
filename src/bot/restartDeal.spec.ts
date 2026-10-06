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
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'

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
