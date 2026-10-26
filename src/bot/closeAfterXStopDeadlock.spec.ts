process.env.NODE_ENV = 'testing'

/**
 * A bot-controller auto-stop ("close after X deals") fired from inside a deal
 * close must not wait on the close lock its own call chain is holding.
 *
 * `checkClosedDeals` runs inside `processDealClose`, which is serialised on the
 * bot-wide `` `${botId}processDealClose` `` key of a non-reentrant `IdMutex`
 * with no lock timeout. When the limit is met it awaits `stop(leave)`, and
 * `stop` cancels every deal still in `start` through `closeDealById` →
 * `processDealClose` — the key the outer close holds. The stop never returns,
 * the outer close never returns, and every later close or stop of the bot
 * queues behind it until the worker restarts.
 *
 * Spec: `specs/202.close-after-x-auto-stop-deadlocks-on-the-deal-close-lock.md`.
 * Run: `npm test` (mocha) from core/.
 *
 * No network / DB needed. Drives the real `closeDealById`, `processDealClose`,
 * `checkClosedDeals`, `stop` and `openDealBySignal` on a DCA helper built over
 * the real MainBot, with real deal maps and the real module-level mutexes; only
 * I/O and unrelated bookkeeping are stubbed.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { DealStats } from './worker/statsService'
import {
  BotStatusEnum,
  CloseDCATypeEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StartConditionEnum,
  StatusEnum,
} from '../../types'

const HANG_MS = 3000

/** Resolves `'hung'` if `p` has not settled within `ms`. */
async function settleOrHang<T>(p: Promise<T>, ms = HANG_MS) {
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => resolve('hung'), ms)
  })
  const r = await Promise.race([p.then(() => 'settled' as const), hung])
  clearTimeout(timer)
  return r
}

let seq = 0
const nextBotId = () => `dddddddddddddddddddd${String(++seq).padStart(4, '0')}`

function deal(id: string, symbol: string, status: DCADealStatusEnum) {
  return {
    deal: {
      _id: id,
      status,
      symbol: { symbol, baseAsset: symbol.split('USDT')[0], quoteAsset: 'USDT' },
      profit: { total: 0, totalUsd: 0 },
      levels: { complete: 0, all: 3 },
      lastPrice: 1,
      avgPrice: 1,
      createTime: 1,
      updateTime: 1,
      strategy: 'LONG',
    },
    closeBySl: false,
    closeByTp: false,
    currentOrders: [],
    previousOrders: [],
    initialOrders: [],
  } as any
}

describe('spec 202 — close-after-X auto-stop inside a deal close', () => {
  let DCA: any

  before(function () {
    // One ts-node compile of a 30k-line module.
    this.timeout(240000)
    DCA = createRequire(__filename)('./dcaHelper').default(MainBot)
    // `processDealClose` flushes deal stats through the stats singleton.
    ;(DealStats as any).instance = { removeStats: async () => undefined }
  })

  /**
   * A live DCA bot whose bot controller stops it after `closeAfterX` closed
   * deals — a limit it has already met — holding `startIds` deals that never
   * started and `openIds` deals that are open.
   */
  function bot(startIds: string[], openIds: string[] = []) {
    const rec = {
      closes: [] as string[],
      opened: [] as string[],
      statusWrites: [] as string[],
      logs: [] as string[],
    }
    const b: any = Object.create(DCA.prototype)
    b.botId = nextBotId()
    b.userId = 'u'
    b.combo = false
    b.loadingComplete = true
    b.allowedMethods = new Set(['checkClosedDeals'])
    b.data = {
      _id: b.botId,
      status: BotStatusEnum.open,
      exchange: ExchangeEnum.binanceUsdm,
      paperContext: false,
      settings: {
        pair: [...startIds, ...openIds].map((_, i) => `P${i}USDT`),
      },
      profit: { total: 0, totalUsd: 0 },
      workingShift: [{ start: 1 }],
      dealsReduceForBot: [],
    }
    b.deals = new Map()
    b.dealStatusMap = new Map()
    b.dealSymbolMap = new Map()
    b.dealTimersMap = new Map()
    b.startTimeoutTime = new Map()
    b.openNewDealTimer = new Map()
    b.closeDealTimer = new Map()
    b.pendingClose = new Map()
    b.processedFilled = new Set()
    b.feeProcessed = new Set()
    b.partiallyFilledFilledSet = new Set()
    b.indicators = new Map()
    b.pairs = new Set()
    b.closeAfterTpFilled = false
    b.stopsInFlight = 0
    b.scheduleDcaIndicatorSync = () => undefined
    b.setDealToRedis = () => undefined
    startIds.forEach((id, i) =>
      b.setDeal(deal(id, `P${i}USDT`, DCADealStatusEnum.start), false),
    )
    openIds.forEach((id, i) =>
      b.setDeal(
        deal(id, `P${startIds.length + i}USDT`, DCADealStatusEnum.open),
        false,
      ),
    )

    // ── settings: bot controller, close after 1 closed deal, already met ──
    b.getAggregatedSettings = async () => ({
      useBotController: true,
      useCloseAfterX: true,
      closeAfterX: '1',
      startCondition: StartConditionEnum.tradingviewSignals,
      pair: b.data.settings.pair,
    })
    b.dealsDb = {
      countData: async () => ({ status: StatusEnum.ok, data: { result: 5 } }),
      readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
    }
    b.botEventDb = { createData: async () => undefined }

    // ── bookkeeping / I/O the close path touches, none of it under test ──
    b.startMethod = () => 1
    b.endMethod = () => undefined
    b.handleLog = (m: string) => rec.logs.push(m)
    b.handleDebug = () => undefined
    b.handleWarn = (m: string) => rec.logs.push(m)
    b.handleErrors = (m: string) => rec.logs.push(m)
    b.emit = () => undefined
    b.updateData = async (d: any) => {
      if (d?.status) rec.statusWrites.push(d.status)
    }
    b.saveDeal = (d: any, upd: any) => {
      Object.assign(d.deal, upd)
      if (b.getDeal(d.deal._id)) b.setDeal(d, false)
    }
    b.removeDealFromStopLossMethods = () => undefined
    b.clearTrailingRetryTimer = () => undefined
    b.recordDealCostFacts = () => undefined
    b.botUpdateStats = () => undefined
    b.resetAssets = () => undefined
    b.updateBotDeals = async () => undefined
    b.updateUsage = () => undefined
    b.checkDealsAllowedMethods = async () => undefined
    b.noteCloseSweep = async () => undefined
    b.finishCloseSweep = async () => undefined
    b.cancelAllOrder = async () => undefined
    b.getOrdersByStatusAndDealId = () => []
    b.removeOrdersByDeal = () => undefined
    b.updateDealLastTime = () => undefined
    b.updateDealLastPrices = () => undefined
    b.shouldProceed = () => false
    b.afterDealClose = async () => undefined
    b.reportUserRefusal = async () => undefined
    b.closeUserStream = () => undefined
    b.trimWorkingShift = (w: unknown) => w
    b.getWorkingTimeNumber = () => 0
    b.unsubscribeFromExchangeInfo = async () => undefined
    b.unsubscribeFromUserFee = async () => undefined
    b.unsubscribeFromUser = async () => undefined
    b.unsubscribeFromLastUsdData = async () => undefined
    b.unsubscribeFromLastStreamData = async () => undefined
    b.clearClassProperties = () => undefined
    b.sendBotClosed = () => undefined
    b.afterBotStop = async () => undefined
    b.retireStrandedStartDeal = async () => false
    b.reportUnactionedClose = async () => undefined
    b.reportIgnoredWebhookSignal = async (m: string) => rec.logs.push(m)

    // `processDealClose` and `closeDealById` record what actually closed.
    const pdc = b.processDealClose
    b.processDealClose = function (...args: any[]) {
      rec.closes.push(args[1])
      return pdc.apply(this, args)
    }

    // openDealBySignal → openNewDeal is what puts money on the venue.
    b.getSymbolsToOpenAsapDeals = async () => b.data.settings.pair
    b.openNewDeal = async (_bot: string, symbol: string) => {
      rec.opened.push(symbol)
    }
    return { b, rec }
  }

  // §1.2 / §4.1 — the production shape: a start deal is cancelled, the limit
  // is already met, and the bot holds further start deals.
  it('cancelling a start deal while more start deals remain returns, and the bot stops', async () => {
    const { b, rec } = bot(['s1', 's2', 's3'])
    const r = await settleOrHang(
      b.closeDealById(b.botId, 's1', CloseDCATypeEnum.cancel, false),
    )
    expect(r, 'closeDealById must not wait on its own close lock').to.equal(
      'settled',
    )
    expect(b.getOpenDeals().map((d: any) => d.deal._id)).to.deep.equal([])
    expect(rec.statusWrites).to.include(BotStatusEnum.closed)
    expect(b.data.status).to.equal(BotStatusEnum.closed)
  })

  // §4.2 — the jam outlives the call that caused it: a later user stop must
  // still go through.
  it('a later stop of the same bot goes through', async () => {
    const { b, rec } = bot(['s1', 's2', 's3'])
    await settleOrHang(
      b.closeDealById(b.botId, 's1', CloseDCATypeEnum.cancel, false),
    )
    rec.statusWrites.length = 0
    b.data.status = BotStatusEnum.open
    const r = await settleOrHang(b.stop(CloseDCATypeEnum.cancel))
    expect(r).to.equal('settled')
    expect(rec.statusWrites).to.include(BotStatusEnum.closed)
  })

  // §4.3 — a user stop that cancels start deals while the limit is met hits
  // the same nested auto-stop on its first cancel.
  it('a user stop that cancels several start deals returns', async () => {
    const { b, rec } = bot(['s1', 's2', 's3'], ['o1'])
    const r = await settleOrHang(b.stop(CloseDCATypeEnum.leave))
    expect(r).to.equal('settled')
    expect(b.getOpenDeals(false).map((d: any) => d.deal._id)).to.deep.equal([
      'o1',
    ])
    // Each start deal is closed exactly once — no recursive re-close.
    expect(rec.closes.filter((c) => c.startsWith('s')).sort()).to.deep.equal([
      's1',
      's2',
      's3',
    ])
  })

  // §4.4 — unchanged: with no start deal to cancel the auto-stop never needs
  // the close lock and runs inline as before.
  it('closing the last deal still stops the bot inline', async () => {
    const { b, rec } = bot(['s1'])
    const r = await settleOrHang(
      b.closeDealById(b.botId, 's1', CloseDCATypeEnum.cancel, false),
    )
    expect(r).to.equal('settled')
    expect(rec.statusWrites).to.include(BotStatusEnum.closed)
    expect(
      rec.logs.filter((l) => l.startsWith('Close deal after X trigger')),
    ).to.have.length(1)
  })

  // §4.5 — a bot that is stopping opens no deal from a signal.
  it('openDealBySignal opens nothing while the bot is stopping', async () => {
    const { b, rec } = bot(['s1', 's2'])
    let release: () => void = () => undefined
    let held = false
    // Hold the stop at its first await, before any deal is touched.
    b.clearDealTimer = () => {
      if (held) return Promise.resolve()
      held = true
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const stopping = b.stop(CloseDCATypeEnum.cancel)
    await new Promise((r) => setImmediate(r))
    await b.openDealBySignal(b.botId, undefined, true)
    expect(rec.opened, 'no deal opened mid-stop').to.deep.equal([])
    release()
    expect(await settleOrHang(stopping)).to.equal('settled')
  })

  // §4.5 — the production deals mid-stop came from the indicator start
  // condition, straight into `openNewDeal`, not through `openDealBySignal`.
  it('a start-condition open reaching openNewDeal opens nothing mid-stop', async () => {
    const { b } = bot(['s1', 's2'])
    const bodies: string[] = []
    const notOpened: string[] = []
    // The real entry; only the body that places the base order is stubbed.
    b.openNewDeal = DCA.prototype.openNewDeal
    b.openNewDealBody = async (_b: string, symbol: string) => {
      bodies.push(symbol)
    }
    let release: () => void = () => undefined
    let held = false
    b.clearDealTimer = () => {
      if (held) return Promise.resolve()
      held = true
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const stopping = b.stop(CloseDCATypeEnum.cancel)
    await new Promise((r) => setImmediate(r))
    await b.openNewDeal(b.botId, 'P9USDT', false, false, 0, () =>
      notOpened.push('P9USDT'),
    )
    expect(bodies, 'no deal body runs mid-stop').to.deep.equal([])
    expect(notOpened).to.deep.equal(['P9USDT'])
    release()
    expect(await settleOrHang(stopping)).to.equal('settled')
    await b.openNewDeal(b.botId, 'P9USDT')
    expect(bodies, 'opens again once no stop is running').to.deep.equal([
      'P9USDT',
    ])
  })

  // §4.5 — and a running bot still opens one.
  it('openDealBySignal still opens a deal on a running bot', async () => {
    const { b, rec } = bot([])
    b.data.settings.pair = ['P0USDT']
    await b.openDealBySignal(b.botId, undefined, true)
    expect(rec.opened).to.deep.equal(['P0USDT'])
  })
})
