process.env.NODE_ENV = 'testing'

/**
 * Pins the per-pair `newDeal` mutex of the DCA engine to the method that opens
 * the deal. A decorator binds to the declaration right below it, so a method
 * inserted between `@IdMute(...)` and `openNewDealBody` would silently move the
 * lock onto the new method — no compile error, no runtime error. That happened
 * once: the lock sat on `refuseDealBelowExchangeMin` and two triggers for the
 * same pair could pass the max-deals / balance gates together.
 *
 * Drives the REAL `dcaHelper.openNewDeal` over a minimal base class. The first
 * await of the body (`getAggregatedSettings`) is held open, so a second call
 * that reaches it while the first is still inside proves the lock is missing.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MathHelper } from '../utils/math'

const BOT_ID = '000000000000000000000201'
const PAIR = 'ALT-USDT'
const OTHER = 'OTH-USDT'

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  loadingComplete = true
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any

const buildBot = (single = false) => {
  const gate: { entered: string[]; release: Array<() => void> } = {
    entered: [],
    release: [],
  }
  class TestBot extends DcaHelper {
    gate = gate
    data: any = { settings: { pair: [PAIR, OTHER] }, status: 'open' }
    // No pair is configured, so the body leaves right after the held await.
    pairs = new Set<string>()
    openNewDealTimer = new Map()
    get singlePositionActive() {
      return single
    }
    getOpenDeals() {
      return []
    }
    async getAggregatedSettings() {
      gate.entered.push('settings')
      await new Promise<void>((r) => gate.release.push(r))
      return { ...this.data.settings }
    }
    async allowsRaiseToExchangeMin() {
      return true
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
  }
  return new TestBot()
}

const tick = () => new Promise((r) => setImmediate(r))

const drain = async (bot: any) => {
  while (bot.gate.release.length) {
    bot.gate.release.shift()()
    await tick()
  }
}

describe('openNewDeal per-pair mutex binding', () => {
  before(function () {
    this.timeout(180000)
    DcaHelper = loadModule('./dcaHelper').default(FakeBase as any)
  })

  it('the newDeal@ decorator sits directly on openNewDealBody', () => {
    const src = readFileSync(join(__dirname, 'dcaHelper.ts'), 'utf8')
    const at = src.indexOf('}newDeal@${symbol}`')
    expect(at, 'newDeal@ mutex key').to.be.greaterThan(-1)
    expect(src.indexOf('}newDeal@${symbol}`', at + 1), 'one binding').to.equal(
      -1,
    )
    const next = src.slice(at).match(/\n\s*\)\n\s*([^\n]*)/)
    expect(next?.[1]).to.match(/^protected async openNewDealBody\(/)
  })

  it('serialises two attempts for the same pair', async () => {
    const bot = buildBot()
    const a = bot.openNewDeal(BOT_ID, PAIR)
    const b = bot.openNewDeal(BOT_ID, PAIR)
    await tick()
    expect(
      bot.gate.entered,
      'second attempt waits for the first',
    ).to.have.length(1)
    await drain(bot)
    await Promise.all([a, b])
    expect(bot.gate.entered).to.have.length(2)
  })

  it('runs attempts for different pairs in parallel', async () => {
    const bot = buildBot()
    const a = bot.openNewDeal(BOT_ID, PAIR)
    const b = bot.openNewDeal(BOT_ID, OTHER)
    await tick()
    expect(bot.gate.entered).to.have.length(2)
    await drain(bot)
    await Promise.all([a, b])
  })

  it('does not lock refuseDealBelowExchangeMin (called inside the lock)', async () => {
    const bot = buildBot()
    const a = bot.refuseDealBelowExchangeMin(PAIR)
    const b = bot.refuseDealBelowExchangeMin(PAIR)
    await tick()
    expect(bot.gate.entered).to.have.length(2)
    await drain(bot)
    expect(await a).to.equal(false)
    expect(await b).to.equal(false)
  })

  it('single position: a second start signal is still skipped, not queued', async () => {
    const bot = buildBot(true)
    let skipped = 0
    const a = bot.openNewDeal(BOT_ID, PAIR)
    const b = bot.openNewDeal(BOT_ID, PAIR, false, false, 0, () => skipped++)
    await tick()
    await b
    expect(skipped, 'second signal skipped').to.equal(1)
    expect(bot.gate.entered).to.have.length(1)
    await drain(bot)
    await a
    expect(bot.gate.entered).to.have.length(1)
  })
})
