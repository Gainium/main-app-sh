process.env.NODE_ENV = 'testing'

/**
 * A start refused by max open deals / max deals per pair reaches the
 * notification hook (`sendMaxDealsReachedAlert`) — once per standing
 * condition, not once per start attempt. Indicator starts call `openNewDeal`
 * per candle per pair, so an unlatched hook would page the user every minute.
 *
 * Drives the REAL `checkMaxDeals` / `checkMaxDealsPerPair` on an
 * `Object.create`-d DCA helper; settings and open deals are stubbed.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StartConditionEnum } from '../../types'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'

const Helper: any = createDCABotHelper(MainBot as any)

type Sent = { scope: string; symbol: string; open: number; max: number }

function makeBot(opts: {
  max?: string
  perPair?: string
  open: Record<string, number>
  startCondition?: StartConditionEnum
  paper?: boolean
}) {
  const bot: any = Object.create(Helper.prototype)
  const sent: Sent[] = []
  const settings = {
    useMulti: !!opts.perPair,
    maxDealsPerPair: opts.perPair ?? '',
    maxNumberOfOpenDeals: opts.max ?? '',
    startCondition: opts.startCondition ?? StartConditionEnum.ti,
  }
  bot.botId = '000000000000000000004186'
  bot.data = { settings }
  bot.pendingDeals = 0
  bot.pendingDealsPerPair = new Map()
  bot.standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
  bot.asapMaxDealsLatch = new ConditionLatch(0)
  bot.allowedMethods = new Set([
    'checkMaxDeals',
    'checkMaxDealsPerPair',
    ...(opts.paper ? [] : ['sendMaxDealsReachedAlert']),
  ])
  bot.handleDebug = () => undefined
  bot.handleWarn = () => undefined
  bot.getAggregatedSettings = async () => settings
  bot.getOpenDeals = (_ignore: boolean, symbol?: string) => {
    const n = symbol
      ? (opts.open[symbol] ?? 0)
      : Object.values(opts.open).reduce((a, b) => a + b, 0)
    return Array.from({ length: n }, () => ({ deal: {} }))
  }
  bot.sendMaxDealsReachedAlert = async (
    scope: string,
    symbol: string,
    open: number,
    max: number,
  ) => {
    sent.push({ scope, symbol, open, max })
  }
  // `checkMaxDeals` holds a slot on success; release so repeats see the same count.
  const attempt = async (symbol: string) => {
    const ok = await bot.checkMaxDeals(bot.botId, symbol)
    bot.pendingDeals = 0
    bot.pendingDealsPerPair.clear()
    return ok
  }
  return { bot, sent, attempt }
}

describe('max deals reached alert', () => {
  it('reports a bot at max open deals once across repeated refusals', async () => {
    const { sent, attempt } = makeBot({ max: '3', open: { BTCUSDT: 3 } })
    for (let i = 0; i < 20; i++) {
      expect(await attempt('ETHUSDT')).to.equal(false)
    }
    expect(sent).to.deep.equal([
      { scope: 'bot', symbol: 'ETHUSDT', open: 3, max: 3 },
    ])
  })

  it('reports each pair at its per-pair limit once, keyed by pair', async () => {
    const { sent, attempt } = makeBot({
      max: '100',
      perPair: '2',
      open: { BTCUSDT: 2, ETHUSDT: 2, SOLUSDT: 1 },
    })
    for (let i = 0; i < 5; i++) {
      await attempt('BTCUSDT')
      await attempt('ETHUSDT')
      expect(await attempt('SOLUSDT')).to.equal(true)
    }
    expect(sent).to.deep.equal([
      { scope: 'pair', symbol: 'BTCUSDT', open: 2, max: 2 },
      { scope: 'pair', symbol: 'ETHUSDT', open: 2, max: 2 },
    ])
  })

  it('reports again when the limit is changed and the new one fills', async () => {
    const run = makeBot({ max: '3', open: { BTCUSDT: 3 } })
    await run.attempt('BTCUSDT')
    run.bot.data.settings.maxNumberOfOpenDeals = '2'
    await run.attempt('BTCUSDT')
    expect(run.sent.map((s) => s.max)).to.deep.equal([3, 2])
  })

  it('re-arms after the window for signal bots, never for ASAP bots', async () => {
    const realNow = Date.now
    try {
      for (const [startCondition, expected] of [
        [StartConditionEnum.ti, 2],
        [StartConditionEnum.asap, 1],
      ] as const) {
        const { sent, attempt } = makeBot({
          max: '1',
          open: { BTCUSDT: 1 },
          startCondition,
        })
        const t0 = realNow()
        Date.now = () => t0
        await attempt('BTCUSDT')
        Date.now = () => t0 + STANDING_CONDITION_REARM_MS + 1
        await attempt('BTCUSDT')
        expect(sent.length, startCondition).to.equal(expected)
      }
    } finally {
      Date.now = realNow
    }
  })

  it('stays silent where deal alerts are off (paper) and for a limit of 0', async () => {
    const paper = makeBot({ max: '1', open: { BTCUSDT: 1 }, paper: true })
    await paper.attempt('BTCUSDT')
    expect(paper.sent).to.deep.equal([])
    const zero = makeBot({ max: '0', open: {} })
    expect(await zero.attempt('BTCUSDT')).to.equal(false)
    expect(zero.sent).to.deep.equal([])
  })
})
