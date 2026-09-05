process.env.NODE_ENV = 'testing'

/**
 * End-to-end check for spec 008 §1.1.1 / §1.1.2 / §1.1.4 / §3.
 *
 * Drives the REAL `dcaHelper.openNewDeal` and `comboHelper.openNewDeal` — not a
 * reimplementation — through the "cannot fund a base order" refusal branch, N
 * times over, with `checkBalance` stubbed so the account state is chosen. The
 * instance is built by `Object.create`-ing the prototype, so no stack, DB,
 * Redis or exchange connection is needed.
 *
 * What it measures is the one number the bug is about: how many times
 * `handleErrors` is called while ONE standing condition holds. Production says
 * "once per cycle" (734 times in 15 h for one bot+pair). The spec says once.
 *
 * `utils.sleep` is neutralised before `dcaHelper` is loaded, because the
 * refusal path sleeps 5 s per cycle before re-checking — 20 cycles of real
 * sleeping is 100 s of nothing. `dcaHelper` destructures `sleep` off the utils
 * default export at module-evaluation time, so the patch must happen first;
 * that is why the two helpers are loaded by dynamic `import()` inside `main()`
 * rather than by a static import, which would be hoisted above the patch.
 *
 * Run: npx ts-node -T src/bot/openNewDealRefusal.harness.ts
 */
import utils from '../utils'
import MainBot from './main'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from './conditionLatch'
import { ExchangeEnum } from '../../types'

// Must run before the two helpers are loaded. See the header note — hence the
// dynamic imports in `main()` rather than static ones up here.
;(utils as unknown as { sleep: (ms: number) => Promise<void> }).sleep =
  async () => undefined

const SYMBOL = 'CATIUSDT'
const CYCLES = 20

type Run = {
  /** One entry per `handleErrors` call — the message it was given. */
  reported: string[]
  /** One entry per cycle that released the pending slot. */
  pendingReleased: number
  /** One entry per cycle that invoked `cbIfNotOpened`. */
  calledBack: number
  /** One entry per `stop()` — the terminal-DCA branch. */
  stopped: number
}

/**
 * A bot whose balance check refuses. `available` is held CONSTANT and
 * `required` drifts, exactly as production does (spec §2.2) — a dedupe that
 * keyed on message text would not collapse these.
 */
function makeBot(Helper: any, opts: { terminal?: boolean; combo?: boolean }) {
  const bot: any = Object.create(Helper.prototype)
  const run: Run = {
    reported: [],
    pendingReleased: 0,
    calledBack: 0,
    stopped: 0,
  }

  bot.botId = '6834d1a3a5719569f13f00d5'
  bot.userId = '675af9d655835fd5f14338f9'
  bot.botType = opts.combo ? 'combo' : 'dca'
  bot.loadingComplete = true
  bot.runAfterLoadingQueue = []
  bot.openNewDealTimer = new Map()
  bot.pairs = new Set([SYMBOL])
  // A class field initializer, so `Object.create` does not run it — supplied
  // here exactly as `MainBot`'s constructor would, with the real class.
  bot.standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
  bot.data = {
    exchange: ExchangeEnum.binance,
    paperContext: false,
    status: 'open',
    previousStatus: 'open',
    settings: {
      name: 'harness',
      pair: [SYMBOL],
      type: opts.terminal ? 'terminal' : 'simple',
      // Combo order-count inputs; kept far below `ed.maxOrders`.
      comboActiveMinigrids: '0',
      gridLevel: '0',
      baseGridLevels: '0',
      ordersCount: 1,
      useSmartOrders: false,
      activeOrdersCount: 1,
    },
  }

  // `futures` / `coinm` / `isLong` are getters on MainBot — pin them.
  for (const [k, v] of [
    ['futures', false],
    ['coinm', false],
    // Short spot, so the refusal is denominated in the BASE asset — which is
    // what the production line this harness mirrors actually says ("required:
    // 412.8 CATI", not USDT).
    ['isLong', false],
    ['combo', !!opts.combo],
    ['useCompountReduce', false],
    ['scaleAr', false],
    ['tpAr', false],
    ['slAr', false],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }

  // I/O and bookkeeping the method reaches for, stubbed.
  bot.startMethod = () => 'x'
  bot.endMethod = () => undefined
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleDebug = () => undefined
  bot.getAggregatedSettings = async () => bot.data.settings
  bot.getExchangeInfo = async (s: string) => ({
    pair: s,
    maxOrders: 200,
    baseAsset: { name: 'CATI' },
    quoteAsset: { name: 'USDT' },
  })
  bot.checkMaxDeals = async () => true
  bot.checkInRange = async () => true
  bot.getActiveOrders = async () => 0
  bot.unsubscribeFromExchangeInfo = () => undefined
  bot.unsubscribeFromUserFee = () => undefined
  // The success branch — reached only when the balance check passes. Stopped at
  // `placeBaseOrder`: this harness is about reporting cadence, not order flow.
  bot.updateDealLastTime = () => undefined
  bot.calculateCompoundReduce = async () => undefined
  bot.checkCooldownStart = async () => ({ status: true })
  bot.checkCooldownStop = async () => ({ status: true })
  bot.placeBaseOrder = async () => undefined

  // The three things §1.1.4 says must keep happening every cycle.
  bot.resetPending = () => {
    run.pendingReleased++
  }
  bot.stop = () => {
    run.stopped++
  }

  // The one thing that must happen ONCE.
  bot.handleErrors = async (msg: string) => {
    run.reported.push(msg)
  }

  return { bot, run }
}

/** Sets the refusal: `available` constant, `required` drifting per cycle. */
function refuseBalance(bot: any, cycle: number) {
  bot.checkBalance = async () => ({
    status: false,
    required: 412.8 + cycle * 0.1,
    available: 151.0008,
    price: 0.05447 - cycle * 0.00001,
  })
}

function allowBalance(bot: any) {
  bot.checkBalance = async () => ({
    status: true,
    required: 412.8,
    available: 900,
    price: 0.05447,
  })
}

async function cycle(bot: any, run: Run) {
  await bot.openNewDeal(bot.botId, SYMBOL, true, false, 0, () => {
    run.calledBack++
  })
}

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}\n        expected ${JSON.stringify(
      expected,
    )}, got ${JSON.stringify(actual)}`,
  )
}

async function main() {
  const createDCABotHelper = (await import('./dcaHelper')).default
  const createComboBotHelper = (await import('./comboHelper')).default
  const DCA = createDCABotHelper(MainBot as any)
  const Combo = createComboBotHelper()

  // ── §1.1.1 / §3 — a standing condition reports once, not once per cycle ──
  {
    const { bot, run } = makeBot(DCA, {})
    for (let c = 0; c < CYCLES; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    check(
      `dca: ${CYCLES} cycles of one standing condition report once (§1.1.1)`,
      run.reported.length,
      1,
    )
    check(
      'dca: the one report carries the real numbers (§1.2.4)',
      run.reported[0]?.startsWith(
        'Not enough balance to start new deal required: 412.8 CATI, available: 151.0008 CATI',
      ),
      true,
    )
    // §1.1.4 — suppressing the REPORT must not suppress the WORK.
    check(
      'dca: the pending slot is released every cycle (§1.1.4)',
      run.pendingReleased,
      CYCLES,
    )
    check(
      'dca: cbIfNotOpened fires every cycle (§1.1.4)',
      run.calledBack,
      CYCLES,
    )
  }

  // ── §1.1.2 — clears and returns ⇒ reported again ──
  {
    const { bot, run } = makeBot(DCA, {})
    for (let c = 0; c < 5; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    allowBalance(bot)
    await cycle(bot, run) // the user funds the account; condition clears
    for (let c = 0; c < 5; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    check(
      'dca: clear-and-return is reported again (§1.1.2)',
      run.reported.length,
      2,
    )
  }

  // ── §1.1.1 — a second pair is never masked by the first ──
  {
    const { bot, run } = makeBot(DCA, {})
    bot.pairs = new Set([SYMBOL, 'ETHUSDT'])
    bot.data.settings.pair = [SYMBOL, 'ETHUSDT']
    for (let c = 0; c < 5; c++) {
      refuseBalance(bot, c)
      await bot.openNewDeal(bot.botId, SYMBOL, true, false, 0, () => undefined)
      await bot.openNewDeal(
        bot.botId,
        'ETHUSDT',
        true,
        false,
        0,
        () => undefined,
      )
    }
    check(
      'dca: each blocked pair reports once (§1.1.1)',
      run.reported.length,
      2,
    )
  }

  // ── §4.1 — terminal DCA always reports, and always stops ──
  {
    const { bot, run } = makeBot(DCA, { terminal: true })
    for (let c = 0; c < 5; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    check(
      'dca terminal: every refusal is reported (§4.1)',
      run.reported.length,
      5,
    )
    check('dca terminal: stop() runs every cycle (§1.1.4)', run.stopped, 5)
  }

  // ── the combo path — same defect, same fix ──
  {
    const { bot, run } = makeBot(Combo, { combo: true })
    for (let c = 0; c < CYCLES; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    check(
      `combo: ${CYCLES} cycles of one standing condition report once (§1.1.1)`,
      run.reported.length,
      1,
    )
    check(
      'combo: the pending slot is released every cycle (§1.1.4)',
      run.pendingReleased,
      CYCLES,
    )
    check(
      'combo: cbIfNotOpened fires every cycle (§1.1.4)',
      run.calledBack,
      CYCLES,
    )
  }

  {
    const { bot, run } = makeBot(Combo, { combo: true })
    for (let c = 0; c < 5; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    allowBalance(bot)
    await cycle(bot, run)
    for (let c = 0; c < 5; c++) {
      refuseBalance(bot, c)
      await cycle(bot, run)
    }
    check(
      'combo: clear-and-return is reported again (§1.1.2)',
      run.reported.length,
      2,
    )
  }

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('harness crashed:', e)
  process.exit(1)
})
