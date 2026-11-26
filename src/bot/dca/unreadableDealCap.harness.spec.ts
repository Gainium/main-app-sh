process.env.NODE_ENV = 'testing'

/**
 * A deal cap (`maxNumberOfOpenDeals`, `maxDealsPerPair`) whose stored text does
 * not read as a number must not lift the cap. Before, `checkMaxDeals` applied
 * the cap only when `+value` was a number, so "3,5" let every signal open a
 * deal with nothing logged. Now no new deal opens and the bot reports why.
 *
 * Runs the REAL `checkMaxDeals` / `checkMaxDealsPerPair` over a minimal base
 * class — no stack, DB, Redis or venue. Fixture ids are synthetic — this file
 * is public.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { MathHelper } from '../../utils/math'

const BOT_ID = '000000000000000000000b78'
const PAIR = 'SYN-USDT'

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = '000000000000000000000478'
  data: any = { settings: { pair: [PAIR] }, status: 'open', flags: [] }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (settings: Record<string, unknown>, openDeals = 0) => {
  const raised = { errors: [] as any[][], reached: [] as any[][] }
  class TestBot extends Helper {
    raised = raised
    allowedMethods = new Set(['checkMaxDeals', 'checkMaxDealsPerPair'])
    pendingDeals = 0
    pendingDealsPerPair = new Map<string, number>()
    get singlePositionActive() {
      return false
    }
    get useMaxDealsOverAndUnder() {
      return false
    }
    get useMaxDealsPerSymbolOverAndUnder() {
      return false
    }
    getOpenDeals() {
      return Array.from({ length: openDeals }, (_, i) => ({
        deal: { _id: `d${i}`, symbol: PAIR },
      }))
    }
    async getAggregatedSettings() {
      return { pair: [PAIR], useMulti: true, ...settings }
    }
    reportMaxDealsReached(...args: any[]) {
      raised.reached.push(args)
    }
    handleErrors(...args: any[]) {
      raised.errors.push(args)
    }
    handleDebug() {}
    handleLog() {}
  }
  return new TestBot()
}

describe('unreadable deal cap — checkMaxDeals fails closed', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('refuses a new deal and reports when maxNumberOfOpenDeals is "3,5"', async () => {
    const bot = buildBot({ maxNumberOfOpenDeals: '3,5' })
    expect(await bot.checkMaxDeals(BOT_ID, PAIR)).to.equal(false)
    expect(bot.raised.errors).to.have.length(1)
    expect(`${bot.raised.errors[0][0]}`).to.contain('maxNumberOfOpenDeals')
  })

  it('refuses a new deal when maxDealsPerPair is "2abc"', async () => {
    const bot = buildBot({ maxNumberOfOpenDeals: '3', maxDealsPerPair: '2abc' })
    expect(await bot.checkMaxDeals(BOT_ID, PAIR)).to.equal(false)
    expect(`${bot.raised.errors[0][0]}`).to.contain('maxDealsPerPair')
  })

  it('still opens under a readable cap and stops at it', async () => {
    const under = buildBot({ maxNumberOfOpenDeals: '3' }, 2)
    expect(await under.checkMaxDeals(BOT_ID, PAIR)).to.equal(true)
    const at = buildBot({ maxNumberOfOpenDeals: '3' }, 3)
    expect(await at.checkMaxDeals(BOT_ID, PAIR)).to.equal(false)
    expect(at.raised.errors).to.have.length(0)
    expect(at.raised.reached).to.have.length(1)
  })

  it('leaves an empty cap as before (no cap)', async () => {
    const bot = buildBot({ maxNumberOfOpenDeals: '' }, 50)
    expect(await bot.checkMaxDeals(BOT_ID, PAIR)).to.equal(true)
    expect(bot.raised.errors).to.have.length(0)
  })
})
