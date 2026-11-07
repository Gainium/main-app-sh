process.env.NODE_ENV = 'testing'

/**
 * Spec 230 §1.1.2 / §1.1.3: after a bot loads, the price timer gives every
 * open deal one stats sample, priced from the latest price the bot already
 * holds, so a deal on a pair that has not traded since the restart does not
 * keep the uPnL stored before it. A deal already sampled since the load is not
 * seeded again; a deal with no held price is left to the REST poll.
 *
 * Runs the real `priceTimerFn` / `seedDealStats` / `sendDealStats` off the DCA
 * and combo helper prototypes with `DealStats.updateStats` captured. No stack,
 * DB, Redis or network.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { BotType, DCADealStatusEnum, ExchangeEnum } from '../../types'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import createComboBotHelper from './comboHelper'
import { DealStats } from './worker/statsService'

const DcaHelper: any = createDCABotHelper(MainBot as any)
// as prod builds it (botService): combo on top of the DCA helper
const ComboHelper: any = createComboBotHelper()

const deal = (id: string, symbol: string) => ({
  deal: {
    _id: id,
    symbol: { symbol },
    status: DCADealStatusEnum.open,
    settings: {
      futures: false,
      coinm: false,
      leverage: 1,
      profitCurrency: 'quote',
    },
    currentBalances: { base: 10, quote: 0 },
    initialBalances: { base: 0, quote: 1000 },
    profit: { total: 1, pureBase: 2, pureQuote: 3 },
    feePaid: { base: 0, quote: 0 },
    avgPrice: 100,
    strategy: 'LONG',
    usage: {},
    stats: {},
    flags: [],
    tpFilledHistory: [],
    reduceFunds: [],
  },
})

function makeBot(
  Helper: any,
  deals: ReturnType<typeof deal>[],
  held: Record<string, { price: number; time: number }>,
  over: Record<string, unknown> = {},
) {
  const bot: any = Object.create(Helper.prototype)
  bot.botId = 'bot-230'
  bot.combo = false
  bot.botType = BotType.dca
  bot.priceTimeout = 150_000
  bot.data = { exchange: ExchangeEnum.paperKraken, settings: {} }
  bot.dealsStatsSampled = new Set()
  bot.lastStreamData = new Map(Object.entries(held))
  bot.getOpenDeals = () => deals
  bot.getDealsByStatusAndSymbol = () => deals
  bot.getUserFee = async () => ({ maker: 0.0026 })
  bot.getUsdRate = async () => 1
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  bot.trackPriceStreamHealth = () => undefined
  bot.exchange = undefined // no REST poll: §1.1.2 adds no exchange request
  Object.assign(bot, over)
  return bot
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('open deals are sampled once at load from the held price (spec 230)', () => {
  let sent: any[] = []
  let original: any
  before(() => {
    original = DealStats.prototype.updateStats
    ;(DealStats.prototype as any).updateStats = function (data: any) {
      sent.push(data)
    }
    // the singleton may already exist with the original bound method
    ;(DealStats.getInstance() as any).updateStats = (data: any) =>
      sent.push(data)
  })
  after(() => {
    ;(DealStats.prototype as any).updateStats = original
    delete (DealStats.getInstance() as any).updateStats
  })
  beforeEach(() => {
    sent = []
  })

  it('§1.1.2 the price timer seeds a quiet deal at the price the bot holds', async () => {
    const bot = makeBot(DcaHelper, [deal('d1', 'VFY-USD')], {
      // held since load, fresh: the REST poll skips this symbol
      'VFY-USD': { price: 0.00521, time: +new Date() },
    })
    await bot.priceTimerFn(ExchangeEnum.paperKraken)
    await settle()
    expect(sent).to.have.length(1)
    expect(sent[0].payload.deal._id).to.equal('d1')
    expect(sent[0].payload.data.price).to.equal(0.00521)
    expect(sent[0].payload.data.symbol).to.equal('VFY-USD')
    expect(sent[0].botType).to.equal(BotType.dca)
    // DCA payload unchanged (§1.1.4)
    expect(sent[0].payload.deal.profit).to.deep.equal({
      total: 1,
      pureBase: 0,
      pureQuote: 0,
    })
  })

  it('§1.1.3 a deal is seeded once per load', async () => {
    const bot = makeBot(DcaHelper, [deal('d1', 'VFY-USD')], {
      'VFY-USD': { price: 0.00521, time: +new Date() },
    })
    await bot.priceTimerFn(ExchangeEnum.paperKraken)
    await settle()
    await bot.priceTimerFn(ExchangeEnum.paperKraken)
    await settle()
    expect(sent).to.have.length(1)
  })

  it('§1.1.3 a deal already sampled by a price tick is not seeded', async () => {
    const bot = makeBot(DcaHelper, [deal('d1', 'VFY-USD')], {
      'VFY-USD': { price: 0.00521, time: +new Date() },
    })
    await bot.sendDealStats(bot.getOpenDeals()[0], {
      symbol: 'VFY-USD',
      price: 0.0052,
      time: +new Date(),
      volume: 0,
    })
    sent = []
    await bot.priceTimerFn(ExchangeEnum.paperKraken)
    await settle()
    expect(sent).to.have.length(0)
  })

  it('§1.1.2 a deal with no held price is left to the REST poll', async () => {
    const bot = makeBot(DcaHelper, [deal('d1', 'VFY-USD')], {})
    await bot.seedDealStats()
    expect(sent).to.have.length(0)
    expect(bot.dealsStatsSampled.has('d1')).to.equal(false)
  })

  it('§1.1.3 closed deals are dropped from the sampled set', async () => {
    const open = [deal('d1', 'VFY-USD')]
    const bot = makeBot(DcaHelper, open, {
      'VFY-USD': { price: 0.00521, time: +new Date() },
    })
    bot.dealsStatsSampled.add('gone')
    await bot.seedDealStats()
    expect([...bot.dealsStatsSampled]).to.deep.equal(['d1'])
  })

  it('§1.1.4 combo seeds with the combo payload', async () => {
    const bot = makeBot(
      ComboHelper,
      [deal('c1', 'OP-USD')],
      {
        'OP-USD': { price: 1.5, time: +new Date() },
      },
      { combo: true, botType: BotType.combo },
    )
    await bot.seedDealStats()
    expect(sent).to.have.length(1)
    expect(sent[0].botType).to.equal(BotType.combo)
    expect(sent[0].payload.combo).to.equal(true)
    expect(sent[0].payload.deal.profit).to.deep.equal({
      total: 1,
      pureBase: 2,
      pureQuote: 3,
    })
  })
})
