process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `228` — a pair whose base orders the venue keeps
 * cancelling with nothing filled must stop re-opening deals forever in
 * silence: after `refusedBaseEntryPauseAfter` refusals in a row the user is
 * told once, and automatic new deals on that pair are paused.
 *
 * Drives the REAL `cancelDealOfCanceledBaseEntry`, `noteRefusedBaseEntry`,
 * `refuseNewDealAfterRefusedEntries`, `clearRefusedBaseEntries` and
 * `reportPerPairWarning` of the DCA helper and of the Combo helper (which
 * inherits them). The Redis run counter is replaced by an in-memory one with
 * the same record/clear contract; `processError` and the DB are stubbed.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import sinon from 'sinon'
import { expect } from 'chai'
import { createRequire } from 'module'
import { refusedBaseEntryPauseAfter } from './dca/partialBaseEntry'
import { ConditionLatch } from './conditionLatch'
import { refusedBaseEntrySubType } from './utils'
import { DCADealStatusEnum, DCATypeEnum, StartConditionEnum } from '../../types'

const BOT_ID = '000000000000000000000b28'
const SYMBOL = 'IAGUSDT'
const OTHER = 'BTCUSDT'

const loadModule = createRequire(__filename)
let Dca: any
let Combo: any

class FakeBase {
  constructor(..._a: any[]) {}
}

/** Same contract as `RetryBackoff.record/clear`: 5 min doubling, 1 h cap. */
const memoryLedger = (
  runs = new Map<
    string,
    { attempt: number; interval: number; until: number; reason: string }
  >(),
) => {
  return {
    runs,
    async record(parts: string[], reason: string) {
      const k = parts.join(':')
      const prev = runs.get(k)
      const interval = prev ? Math.min(prev.interval * 2, 3_600_000) : 300_000
      const attempt = (prev?.attempt ?? 0) + 1
      const state = { until: Date.now() + interval, reason, interval, attempt }
      runs.set(k, state)
      return state
    },
    /** Same contract as `RetryBackoff.peek`: the stored state, even if past. */
    async peek(parts: string[]) {
      return runs.get(parts.join(':')) ?? null
    },
    async clear(parts: string[]) {
      runs.delete(parts.join(':'))
    },
  }
}

type Opts = {
  type?: DCATypeEnum
  /** The Redis ledger survives a worker restart; pass the old bot's here. */
  ledger?: ReturnType<typeof memoryLedger>
  startCondition?: StartConditionEnum
}

const buildBot = (Cls: any, opts: Opts = {}) => {
  const reports: { subType: string; symbol: string; message: string }[] = []
  const closed: string[] = []
  const deals = new Map<string, any>()
  const ledger = opts.ledger ?? memoryLedger()
  /** When the ASAP start loop was asked to run again (fake-clock ms). */
  const starts: number[] = []
  /** Run inside `closeDealById`, like the post-close start of an ASAP bot. */
  const onClose: ((symbol: string) => Promise<void>)[] = []
  const bot: any = Object.create(Cls.prototype)
  Object.assign(bot, {
    botId: BOT_ID,
    userId: 'u',
    botType: 'dca',
    data: {
      status: 'open',
      settings: { pair: [SYMBOL, OTHER] },
      flags: [],
    },
    standingConditionLatch: new ConditionLatch(24 * 60 * 60 * 1000),
    orders: new Map(),
    dealTimersMap: new Map(),
    reports,
    closed,
    deals,
    ledger,
    starts,
    onClose,
    openNewDealTimer: new Map(),
    openDealAfterTimer: async () => {
      starts.push(Date.now())
    },
  })
  Object.assign(bot, {
    shouldProceed: () => true,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleWarn: (m: string) => {
      throw new Error(`unexpected warn: ${m}`)
    },
    refusedBaseEntryLedger: () => ledger,
    getAggregatedSettings: async () => ({
      startCondition: opts.startCondition ?? StartConditionEnum.asap,
      type: opts.type ?? DCATypeEnum.regular,
    }),
    getDeal: (id: string) => deals.get(id),
    isOwnCancel: () => false,
    getOrdersByStatusAndDealId: () => [],
    closeDealById: async (_b: string, dealId: string) => {
      closed.push(dealId)
      deals.get(dealId).deal.status = DCADealStatusEnum.canceled
      for (const cb of onClose) await cb(deals.get(dealId).deal.symbol.symbol)
    },
    botEventDb: { createData: () => undefined },
    processError: async (
      _b: string,
      subType: string,
      _t: boolean,
      setError: boolean,
      sendError: boolean,
      message: string,
      _time: number,
      _m: string,
      _force: boolean,
      symbol: string,
    ) => {
      expect(setError, 'a warning, never an error status').to.equal(false)
      expect(sendError, 'shown to the user').to.equal(true)
      reports.push({ subType, symbol, message })
    },
  })
  return bot
}

let seq = 0
/** One deal the venue refused: created in `start`, then the check runs. */
const refuse = async (bot: any, symbol = SYMBOL) => {
  const id = `d${++seq}`
  bot.deals.set(id, {
    deal: { _id: id, status: DCADealStatusEnum.start, symbol: { symbol } },
  })
  await bot.cancelDealOfCanceledBaseEntry(id, `D-BO-${id}`)
}

/** Would the automatic start loop open a deal on `symbol` now? */
const autoRefused = (bot: any, symbol = SYMBOL) =>
  bot.refuseNewDealAfterRefusedEntries(symbol, false, false, undefined)

for (const [name, get] of [
  ['DCA', () => Dca],
  ['Combo', () => Combo],
] as const) {
  describe(`${name}: repeated unfilled base-entry cancels pause the pair (spec 228)`, () => {
    before(function () {
      this.timeout(300000)
      Dca ??= loadModule('./dcaHelper').default(FakeBase as any)
      Combo ??= loadModule('./comboHelper').default()
    })
    afterEach(() => undefined)

    it('§4.1 the threshold-th refusal reports once and pauses automatic deals', async () => {
      const bot = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      expect(bot.closed, 'every deal still cancelled').to.have.length(
        refusedBaseEntryPauseAfter,
      )
      expect(bot.reports, 'one report').to.have.length(1)
      expect(bot.reports[0].subType).to.equal(refusedBaseEntrySubType)
      expect(bot.reports[0].symbol).to.equal(SYMBOL)
      expect(bot.reports[0].message).to.match(/IAGUSDT: the exchange cancelled the last 3 base orders/)
      expect(bot.reports[0].message).to.match(/paused until .* UTC/)
      expect(await autoRefused(bot), 'paused').to.equal(true)
      // A refusal later in the same run widens the pause but does not report.
      await refuse(bot)
      expect(bot.reports, 'still one report').to.have.length(1)
      expect(await autoRefused(bot)).to.equal(true)
    })

    it('§4.2 fewer refusals than the threshold pause and report nothing', async () => {
      const bot = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter - 1; i++) await refuse(bot)
      expect(bot.reports).to.have.length(0)
      expect(await autoRefused(bot)).to.equal(false)
    })

    it('§4.3 a manual open and a terminal deal are not paused', async () => {
      const bot = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      expect(
        await bot.refuseNewDealAfterRefusedEntries(SYMBOL, false, false, 'manual'),
        'manual',
      ).to.equal(false)
      const terminal = buildBot(get(), { type: DCATypeEnum.terminal })
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(terminal)
      expect(await autoRefused(terminal), 'terminal').to.equal(false)
    })

    it('§4.4 a filled base order ends the run', async () => {
      const bot = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      expect(await autoRefused(bot)).to.equal(true)
      bot.clearRefusedBaseEntries(SYMBOL)
      await Promise.resolve()
      expect(await autoRefused(bot), 'pause lifted').to.equal(false)
      expect(bot.ledger.runs.size, 'count reset').to.equal(0)
      // A new run starts from one and reports again when it reaches the threshold.
      for (let i = 0; i < refusedBaseEntryPauseAfter - 1; i++) await refuse(bot)
      expect(await autoRefused(bot)).to.equal(false)
      await refuse(bot)
      expect(bot.reports, 'second run reported').to.have.length(2)
    })

    it('§4.5 other pairs of the bot are not paused', async () => {
      const bot = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      expect(await autoRefused(bot, OTHER)).to.equal(false)
    })
  })
}

for (const [name, get] of [
  ['DCA', () => Dca],
  ['Combo', () => Combo],
] as const) {
  describe(`${name}: the refused-entry pause survives a restart and ends by itself (spec 228 §4.6-§4.8)`, () => {
    let clock: sinon.SinonFakeTimers | undefined
    before(function () {
      this.timeout(300000)
      Dca ??= loadModule('./dcaHelper').default(FakeBase as any)
      Combo ??= loadModule('./comboHelper').default()
    })
    afterEach(() => {
      clock?.restore()
      clock = undefined
    })

    it('§4.6 a restart between refusal 3 and 4 keeps the pause and does not warn again', async () => {
      const before = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(before)
      expect(before.reports, 'warned once before the restart').to.have.length(1)
      // The worker restarts: memory is gone, the Redis ledger is not.
      const after = buildBot(get(), { ledger: before.ledger })
      expect(await autoRefused(after), 'still paused after the restart').to.equal(
        true,
      )
      // Even if a deal gets through (a manual open the venue refuses too), the
      // run continues at attempt 4 and the user is not told a second time.
      await refuse(after)
      expect(
        before.ledger.runs.get(`${BOT_ID}:${SYMBOL}`)?.attempt,
        'one run across the restart',
      ).to.equal(refusedBaseEntryPauseAfter + 1)
      expect(after.reports, 'no repeat warning').to.have.length(0)
      expect(await autoRefused(after, OTHER), 'other pair unaffected').to.equal(
        false,
      )
    })

    it('§4.6 a restart after the window ended: the next refusal pauses again, silently', async () => {
      const before = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(before)
      const k = `${BOT_ID}:${SYMBOL}`
      before.ledger.runs.get(k)!.until = Date.now() - 1
      const after = buildBot(get(), { ledger: before.ledger })
      expect(await autoRefused(after), 'window over: the pair is tried').to.equal(
        false,
      )
      await refuse(after)
      expect(await autoRefused(after), 'one more refusal re-pauses').to.equal(true)
      expect(after.reports, 'same run, no repeat warning').to.have.length(0)
    })

    it('§4.7 an automatic deal refused by the pause re-arms the start at the end of the window', async () => {
      clock = sinon.useFakeTimers({
        now: 1_800_000_000_000,
        toFake: ['setTimeout', 'clearTimeout', 'Date'],
      })
      const bot = buildBot(get())
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      const until = bot.refusedBaseEntryPausedUntil.get(SYMBOL)
      expect(await autoRefused(bot)).to.equal(true)
      await clock.tickAsync(until - Date.now() - 1)
      expect(bot.starts, 'nothing before the window ends').to.have.length(0)
      await clock.tickAsync(5_000)
      expect(bot.starts, 'the start loop runs once the window ends').to.have.length(1)
      expect(await autoRefused(bot), 'and the pair is no longer paused').to.equal(
        false,
      )
    })

    it('§4.7 a non-ASAP bot arms nothing (its own signal starts the next deal)', async () => {
      clock = sinon.useFakeTimers({
        now: 1_800_000_000_000,
        toFake: ['setTimeout', 'clearTimeout', 'Date'],
      })
      const bot = buildBot(get(), {
        startCondition: StartConditionEnum.tradingviewSignals,
      })
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      expect(await autoRefused(bot)).to.equal(true)
      await clock.tickAsync(2 * 60 * 60 * 1000)
      expect(bot.starts).to.have.length(0)
    })

    it('§4.8 the start that follows the pausing cancel is already refused and re-armed', async () => {
      clock = sinon.useFakeTimers({
        now: 1_800_000_000_000,
        toFake: ['setTimeout', 'clearTimeout', 'Date'],
      })
      const bot = buildBot(get())
      const postClose: boolean[] = []
      // An ASAP bot asks for the next deal while the cancel is still closing.
      bot.onClose.push(async (symbol: string) => {
        postClose.push(await autoRefused(bot, symbol))
      })
      for (let i = 0; i < refusedBaseEntryPauseAfter; i++) await refuse(bot)
      expect(
        postClose,
        'the start right after the pausing cancel does not send a 4th order',
      ).to.deep.equal([false, false, true])
      await clock.tickAsync(60 * 60 * 1000)
      expect(bot.starts, 'and it re-arms the start').to.have.length(1)
    })
  })
}
