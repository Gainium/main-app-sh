process.env.NODE_ENV = 'testing'

/**
 * Stats reset when a global variable bound to a bot changes
 * (`MainBot.botUpdateGlobalVars`, the non-reloading branch).
 *
 * Only a variable bound to an order-sizing field may reset the statistics —
 * the same rule the settings API applies to a sizing edit. A variable bound to
 * anything else (a price filter, a deal-start condition value) changes nothing
 * the aggregates are denominated against, so the stats must survive it.
 *
 * And when a reset does happen it has to reach the running bot's in-memory
 * copy: this branch deliberately does not reload the bot, and the next deal
 * close folds into `this.data.stats` and writes it back. Resetting only Mongo
 * left the old aggregates to be restored on the next close.
 *
 * The real method is driven off the prototype with a fake `this`.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { BotType } from '../../types'

const BOT_ID = 'bot-1'
const SIZE_VAR = 'var-size'
const FILTER_VAR = 'var-filter'

const chart = () => [
  { time: 1789084800000, equity: 1000, buyAndHold: 1000, realizedProfit: 1000 },
  { time: 1789171200000, equity: 1020, buyAndHold: 1010, realizedProfit: 1015 },
]

const stats = () => ({
  numerical: {
    general: { startBalance: { usd: 1000, asset: 1000 }, netProfitPerc: 4.2 },
    ratios: { buyAndHold: { symbol: 'ETHUSDT', startPrice: 2500 } },
    profit: { grossProfit: { usd: 42, asset: 42 } },
  },
  chart: chart(),
})

type Fake = {
  botId: string
  botType: BotType
  data: any
  reloadTimer: NodeJS.Timeout | null
  writes: Record<string, unknown>[]
  handleLog: () => void
  handleErrors: (...args: unknown[]) => void
  updateData: (data: Record<string, unknown>) => void
}

const makeBot = (botType = BotType.dca): Fake => ({
  botId: BOT_ID,
  botType,
  data: {
    _id: BOT_ID,
    stats: stats(),
    symbolStats: [{ symbol: 'ETHUSDT' }],
    vars: {
      list: [SIZE_VAR, FILTER_VAR],
      paths: [
        { variable: SIZE_VAR, path: 'settings.baseOrderSize' },
        { variable: FILTER_VAR, path: 'settings.dynamicPriceFilterOverValue' },
      ],
    },
  },
  reloadTimer: null,
  writes: [],
  handleLog() {},
  handleErrors(...args: unknown[]) {
    throw new Error(`handleErrors: ${args[0]}`)
  },
  updateData(data) {
    this.writes.push(data)
  },
})

const change = (bot: Fake, variable: string) =>
  (MainBot.prototype as any).botUpdateGlobalVars.call(
    bot,
    JSON.stringify({ _id: variable }),
  )

describe('global variable change → bot stats reset', () => {
  let bot: Fake
  beforeEach(() => {
    bot = makeBot()
  })

  it('leaves stats alone when the variable is not bound to a sizing field', () => {
    change(bot, FILTER_VAR)
    expect(bot.writes).to.deep.equal([])
    expect(bot.data.stats.numerical.profit.grossProfit.usd).to.equal(42)
    expect(bot.data.resetStatsAfter).to.equal(undefined)
  })

  it('resets Mongo and the in-memory copy on a sizing variable, keeping the chart', () => {
    change(bot, SIZE_VAR)
    expect(bot.writes).to.have.length(1)
    const [write] = bot.writes as any[]
    expect(write.symbolStats).to.equal(null)
    expect(write.resetStatsAfter).to.be.a('number')
    expect(write.stats.chart).to.deep.equal(chart())
    expect(write.stats.numerical.general.startBalance).to.deep.equal({
      usd: 1000,
      asset: 1000,
    })
    expect(write.stats.numerical.profit.grossProfit.usd).to.equal(0)

    // What the next deal close folds into.
    expect(bot.data.stats).to.deep.equal(write.stats)
    expect(bot.data.symbolStats).to.equal(undefined)
    expect(bot.data.resetStatsAfter).to.equal(write.resetStatsAfter)
  })

  it('does not stamp a reset on a bot that has no stats yet', () => {
    bot.data.stats = undefined
    change(bot, SIZE_VAR)
    expect(bot.writes).to.deep.equal([])
  })

  it('applies to combo bots too, but not grid', () => {
    const combo = makeBot(BotType.combo)
    change(combo, SIZE_VAR)
    expect(combo.writes).to.have.length(1)

    const grid = makeBot(BotType.grid)
    change(grid, SIZE_VAR)
    expect(grid.writes).to.deep.equal([])
  })
})
