process.env.NODE_ENV = 'testing'

/**
 * Call-site regression for the stats reset that a settings change triggers.
 * Spec: main-app `specs/013.sizing-edit-wipes-the-equity-chart.md` §1.2.
 *
 * `botStatsReset.spec.ts` pins the *decision* in isolation. This one pins the
 * *wiring*: that `changeDCABot` actually routes its `stats` write through that
 * decision, with the scope the branch it took implies. The two reset causes
 * share one `if`, so a sizing edit reaching the `'all'` scope — or the write
 * going back to a bare `stats: null` — is invisible to a pure unit test and is
 * exactly the defect reported.
 *
 * The real method is driven off the prototype with fake collaborators: no
 * Mongo, no worker threads, no running stack.
 *
 * Run: `cd core && npm test`
 */
import { describe, it, beforeEach } from 'mocha'
import { expect } from 'chai'
import Bot from '../index'
import { StatusEnum } from '../../../types'

const USER_ID = 'user-778'
const BOT_ID = 'bot-778'

/** Three days of equity history, as a bot that has been running carries it. */
const chart = () => [
  { time: 1789084800000, equity: 1000, buyAndHold: 1000, realizedProfit: 1000 },
  { time: 1789171200000, equity: 1020, buyAndHold: 1010, realizedProfit: 1015 },
  { time: 1789257600000, equity: 1042, buyAndHold: 1005, realizedProfit: 1042 },
]

const botDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: BOT_ID,
  userId: USER_ID,
  settings: {
    name: 'Multi Mfi30M Long',
    status: 'closed',
    useMulti: false,
    useDca: true,
    pair: ['ETHUSDT'],
    baseOrderSize: '50',
    orderSize: '50',
    ordersCount: '5',
    activeOrdersCount: '5',
    volumeScale: '1',
    orderSizeType: 'quote',
    maxNumberOfOpenDeals: '5',
    profitCurrency: 'quote',
    indicators: [],
  },
  stats: {
    numerical: {
      general: { startBalance: { usd: 1000, asset: 1000 } },
      ratios: { buyAndHold: { symbol: 'ETHUSDT', startPrice: 2500 } },
    },
    chart: chart(),
  },
  ...overrides,
})

/**
 * `changeDCABot` on the prototype, with every collaborator it reaches on the
 * settings-change path replaced by a fake. `writes` collects each
 * `dcaBotDb.updateData` call so the test can read the reset `$set` — the
 * second write, after the settings save itself.
 */
const harness = (doc: ReturnType<typeof botDoc>) => {
  const writes: Array<Record<string, unknown>> = []
  // Same shape as this repo's other prototype harnesses (see
  // `evidenceFreeFilledPromotion.spec.ts`): the real method, fake collaborators.
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaBots = []
  bot.getWorkerById = () => undefined
  // Only builds `changeDCABot`'s return value, after the reset write this test
  // reads; faked so the assertions do not depend on the read-back projection.
  bot.getBot = async () => ({
    status: StatusEnum.ok,
    reason: '',
    data: { result: doc },
  })
  bot.botEventDb = { createData: async () => ({ status: StatusEnum.ok }) }
  bot.pairsDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: '',
      data: { result: [] },
    }),
  }
  bot.dcaBotDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: '',
      data: { result: doc },
    }),
    updateData: async (_filter: unknown, update: Record<string, unknown>) => {
      writes.push(update)
      return { status: StatusEnum.ok, reason: '', data: { result: doc } }
    },
  }
  return { bot, writes }
}

/** The `$set` of the write that carries the reset (it stamps `resetStatsAfter`). */
const resetWrite = (writes: Array<Record<string, unknown>>) => {
  const found = writes
    .map((w) => (w as { $set?: Record<string, unknown> }).$set)
    .find((set) => set && 'resetStatsAfter' in set)
  return found as Record<string, unknown> | undefined
}

describe('§1.2 changeDCABot routes its stats reset through statsAfterReset', () => {
  let doc: ReturnType<typeof botDoc>

  beforeEach(() => {
    doc = botDoc()
  })

  it('an order-sizing edit keeps the equity series it had', async () => {
    // The reporter's `…2112fa`: "Base order size: 50 -> 150", a stopped bot.
    // Nothing ever re-runs the chart writers for it, so whatever this write
    // leaves behind is what its card plots for good.
    const { bot, writes } = harness(doc)
    await bot.changeDCABot({ id: BOT_ID, baseOrderSize: '150' }, USER_ID, false)

    const set = resetWrite(writes)
    expect(set, 'the sizing edit must still reset the bot stats').to.exist
    expect(set!.stats, 'the sizing edit must not null the whole document').to
      .not.be.null
    expect((set!.stats as { chart: unknown[] }).chart).to.deep.equal(chart())
  })

  it('and still resets the aggregates the sizing change invalidated', async () => {
    const { bot, writes } = harness(doc)
    await bot.changeDCABot({ id: BOT_ID, baseOrderSize: '150' }, USER_ID, false)

    const stats = resetWrite(writes)!.stats as {
      numerical: {
        deals: unknown
        general: { netProfitPerc: number; startBalance: unknown }
      }
    }
    expect(stats.numerical.deals).to.deep.equal({ profit: 0, loss: 0 })
    expect(stats.numerical.general.netProfitPerc).to.equal(0)
    expect(resetWrite(writes)!.symbolStats).to.equal(null)
    // …but the baseline the preserved series is denominated against comes
    // across with it, or the equity line steps and the drawer's realized
    // profit is off by the whole difference between the two balances.
    expect(stats.numerical.general.startBalance).to.deep.equal({
      usd: 1000,
      asset: 1000,
    })
  })

  it('a profit-currency change is still a full wipe', async () => {
    // `resetStats`, the other cause sharing this `if`. It re-denominates the
    // whole document, series included, so it must keep clearing it.
    const { bot, writes } = harness(doc)
    await bot.changeDCABot(
      { id: BOT_ID, profitCurrency: 'base' },
      USER_ID,
      false,
    )

    const set = resetWrite(writes)
    expect(set, 'a profit-currency change must still reset').to.exist
    expect(set!.stats).to.equal(null)
  })

  it('a bot with no series yet still writes null', async () => {
    const { bot, writes } = harness(botDoc({ stats: { chart: [] } }))
    await bot.changeDCABot({ id: BOT_ID, baseOrderSize: '150' }, USER_ID, false)

    expect(resetWrite(writes)!.stats).to.equal(null)
  })

  it('a settings change that is not sizing does not reset at all', async () => {
    // The guard is unchanged: only sizing or profit currency resets. A name or
    // condition edit must leave both `stats` and `resetStatsAfter` alone.
    const { bot, writes } = harness(doc)
    await bot.changeDCABot({ id: BOT_ID, name: 'renamed' }, USER_ID, false)

    expect(resetWrite(writes)).to.be.undefined
  })
})
