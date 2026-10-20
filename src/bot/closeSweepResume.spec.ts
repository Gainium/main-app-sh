process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `182.a-restart-during-a-deal-close-sweep-leaves-its-orders-live`.
 *
 * A combo deal close cancels its grid ladder one venue call at a time. A
 * worker stop in the middle of that sweep left the rest of the ladder live on
 * the venue: the deal was already `closed`, and the restart restored a Redis
 * order snapshot older than the deal, so no restart path ever saw its orders.
 *
 * Drives the REAL `processDealClose`, `resumeCloseSweeps` (with the Combo
 * minigrid hook) and the REAL placement loop of `placeOrdersHoldingDealLock`
 * on helpers built over the real classes. Redis, Mongo and the venue are
 * recorded stubs.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  closeSweepMaxAgeMs,
  closeSweepsToResume,
  parseCloseSweeps,
} from './closeSweeps'
import { DealStats } from './worker/statsService'
import {
  ComboMinigridStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'

const BOT_ID = '000000000000000000000b82'
const DEAL_ID = '000000000000000000000d82'
const HELD_DEAL_ID = '000000000000000000000d83'
const SYMBOL = 'QQQ-USDT'
const NOW = 1792472900000

const gridRow = (n: number, status = 'NEW') =>
  ({
    _id: `row-${n}`,
    symbol: SYMBOL,
    clientOrderId: `CMB-GR-left-${n}`,
    orderId: `${9000 + n}`,
    botId: BOT_ID,
    dealId: DEAL_ID,
    minigridId: `m-${n % 2}`,
    typeOrder: TypeOrderEnum.dealGrid,
    side: 'BUY',
    price: `${0.09 - n * 0.001}`,
    origPrice: `${0.09 - n * 0.001}`,
    origQty: '10',
    executedQty: '0',
    status,
    updateTime: NOW - 120_000,
    transactTime: NOW - 120_000,
  }) as any

describe('spec 182 — a close sweep a restart interrupted is resumed', () => {
  let Combo: any

  before(function () {
    this.timeout(240000)
    Combo = createRequire(__filename)('./comboHelper').default()
  })

  describe('§4.3 which recorded sweeps a start resumes (pure)', () => {
    it('resumes a deal this process does not hold and drops expired entries', () => {
      const entries = new Map([
        [DEAL_ID, NOW - 60_000],
        [HELD_DEAL_ID, NOW - 60_000],
        ['000000000000000000000d84', NOW - closeSweepMaxAgeMs - 1],
        ['000000000000000000000d85', NOW - 1_000],
      ])
      const out = closeSweepsToResume(entries, NOW, (id) =>
        id === HELD_DEAL_ID ? 'held' : id === '000000000000000000000d85' ? 'inFlight' : null,
      )
      expect(out.resume).to.deep.equal([DEAL_ID])
      expect(out.expired).to.deep.equal(['000000000000000000000d84'])
    })

    it('reads only well-formed entries from Redis', () => {
      expect(
        [
          ...parseCloseSweeps([
            { dealId: DEAL_ID, at: NOW },
            { dealId: '', at: NOW },
            { dealId: HELD_DEAL_ID, at: 'x' },
            null,
          ] as any),
        ],
      ).to.deep.equal([[DEAL_ID, NOW]])
      expect([...parseCloseSweeps('nope' as any)]).to.deep.equal([])
    })
  })

  /** A combo helper as a fresh worker process holds it after loading. */
  const freshCombo = (opts: {
    redisSweeps: unknown
    dbRows: any[]
    dbFails?: boolean
    cancelAnswer?: (o: any) => any
  }) => {
    const rec = {
      cancels: [] as string[],
      redisWrites: [] as { key: string; data: any }[],
      minigridSweeps: [] as any[],
      orderReads: [] as any[],
      logs: [] as string[],
      filled: [] as string[],
    }
    const b: any = Object.create(Combo.prototype)
    b.botId = BOT_ID
    b.botType = 'combo'
    b.combo = true
    b.data = {
      exchange: ExchangeEnum.bybitUsdm,
      exchangeUUID: '',
      paperContext: false,
      settings: { pair: [SYMBOL] },
    }
    b.orders = new Map()
    b.orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    b.ordersKeys = new Set()
    b.orderStatusMap = new Map()
    b.orderDealMap = new Map()
    b.canceledMap = new Map()
    b.unknownOrderInFlight = new Map()
    b.partiallyFilledFilledSet = new Set()
    b.deals = new Map()
    b.dealStatusMap = new Map()
    b.dealSymbolMap = new Map()
    b.scheduleDcaIndicatorSync = () => undefined
    b.minigrids = new Map()
    b.minigridDealMap = new Map()
    b.closeSweeps = new Map()
    b.closeSweepsInFlight = new Set()
    b.blockPriceCheck = false
    b.cancelRetryJitter = () => 1
    b.scheduleCancelRetry = () => undefined
    b.refusedCancelRetryDelay = () => 0
    b.sleepBeforeCancelRetry = async () => undefined
    b.primeCancelBatch = async () => undefined
    b.clearCancelBatch = () => undefined
    b.awaitPlacementInFlight = async () => undefined
    b.resolveNeverPlacedOrder = async () => null
    b.noteOwnCancel = () => undefined
    b.sharedStream = { addOrder: () => undefined, removeOrder: () => undefined }
    b.setOrdersToRedis = () => undefined
    b.saveMinigridToRedis = () => undefined
    b.shouldProceed = () => true
    b.startMethod = () => 1
    b.endMethod = () => undefined
    b.handleLog = (m: string) => rec.logs.push(m)
    b.handleDebug = () => undefined
    b.handleWarn = (m: string) => rec.logs.push(m)
    b.handleErrors = (m: string) => rec.logs.push(m)
    b.emit = () => undefined
    b.updateOrderOnDb = () => undefined
    b.handleUnknownOrder = async (o: any) => {
      rec.filled.push(o.clientOrderId)
    }
    b.getFromRedis = async (key: string) =>
      key === 'closeSweeps' ? JSON.parse(JSON.stringify(opts.redisSweeps)) : null
    b.setToRedis = async (key: string, data: any) => {
      rec.redisWrites.push({ key, data: JSON.parse(JSON.stringify(data)) })
    }
    b.ordersDb = {
      readData: async (q: any) => {
        rec.orderReads.push(q)
        if (opts.dbFails) {
          return { status: StatusEnum.notok, reason: 'db down', data: null }
        }
        const result = opts.dbRows
          .filter(
            (r) =>
              r.botId === q.botId &&
              r.dealId === q.dealId &&
              q.status.$in.includes(r.status),
          )
          .map((r) => ({ ...r }))
        return { status: StatusEnum.ok, data: { result, count: result.length } }
      },
      updateData: async () => ({ status: StatusEnum.ok }),
    }
    b.minigridDb = {
      updateManyData: async (search: any, data: any) => {
        rec.minigridSweeps.push({ search, data })
        return { status: StatusEnum.ok, data: null, reason: 'Matched: 5' }
      },
      updateData: async () => ({ status: StatusEnum.ok }),
    }
    b.exchange = {
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
      returnGood: () => (d: unknown) => ({
        status: StatusEnum.ok,
        reason: null,
        data: d,
      }),
      async cancelOrder(q: { newClientOrderId: string }) {
        rec.cancels.push(q.newClientOrderId)
        const row = opts.dbRows.find(
          (r) => r.clientOrderId === q.newClientOrderId,
        )
        return (
          opts.cancelAnswer?.(row) ?? {
            status: StatusEnum.ok,
            reason: null,
            data: { ...row, status: 'CANCELED' },
          }
        )
      },
      async getOrder() {
        return { status: StatusEnum.notok, reason: 'unused', data: null }
      },
    }
    return { b, rec }
  }

  const lastSweepWrite = (rec: { redisWrites: { key: string; data: any }[] }) =>
    rec.redisWrites.filter((w) => w.key === 'closeSweeps').pop()?.data

  describe('§1.1.1 / §1.1.2 a start after the process stopped mid-sweep', () => {
    it('cancels the deal’s orders left open, closes its minigrids and clears the record', async () => {
      const rows = [gridRow(1), gridRow(2), gridRow(3, 'PARTIALLY_FILLED')]
      const { b, rec } = freshCombo({
        redisSweeps: [{ dealId: DEAL_ID, at: Date.now() - 60_000 }],
        dbRows: [...rows, gridRow(4, 'CANCELED')],
      })
      // The stale snapshot restored one of the deal's minigrids.
      b.setMinigrid(
        {
          schema: {
            _id: 'm-1',
            botId: BOT_ID,
            dealId: DEAL_ID,
            status: ComboMinigridStatusEnum.active,
            symbol: { symbol: SYMBOL },
          },
          initialGrids: [],
          currentOrders: [],
        },
        false,
      )
      await b.loadCloseSweeps()
      await b.resumeCloseSweeps()
      expect(rec.orderReads).to.have.length(1)
      expect(rec.orderReads[0].dealId).to.equal(DEAL_ID)
      expect(rec.cancels.sort()).to.deep.equal(
        rows.map((r) => r.clientOrderId).sort(),
      )
      for (const r of rows) {
        expect(b.getOrderFromMap(r.clientOrderId), 'retired locally').to.be
          .undefined
      }
      expect(rec.minigridSweeps).to.have.length(1)
      expect(rec.minigridSweeps[0].search).to.deep.equal({
        botId: BOT_ID,
        dealId: DEAL_ID,
        status: { $ne: ComboMinigridStatusEnum.closed },
      })
      expect(b.getMinigridByDealId({ dealId: DEAL_ID })).to.have.length(0)
      expect(lastSweepWrite(rec)).to.deep.equal([])
    })

    it('a FILLED answer goes to the late-fill path', async () => {
      const rows = [gridRow(1), gridRow(2)]
      const { b, rec } = freshCombo({
        redisSweeps: [{ dealId: DEAL_ID, at: Date.now() - 60_000 }],
        dbRows: rows,
        cancelAnswer: (row) =>
          row.clientOrderId === rows[1].clientOrderId
            ? {
                status: StatusEnum.ok,
                reason: null,
                data: { ...row, status: 'FILLED', executedQty: row.origQty },
              }
            : undefined,
      })
      await b.loadCloseSweeps()
      await b.resumeCloseSweeps()
      expect(rec.filled).to.deep.equal([rows[1].clientOrderId])
    })

    it('keeps the record when the open rows cannot be read', async () => {
      const { b, rec } = freshCombo({
        redisSweeps: [{ dealId: DEAL_ID, at: Date.now() - 60_000 }],
        dbRows: [gridRow(1)],
        dbFails: true,
      })
      await b.loadCloseSweeps()
      await b.resumeCloseSweeps()
      expect(rec.cancels).to.deep.equal([])
      expect(rec.minigridSweeps).to.deep.equal([])
      expect(lastSweepWrite(rec)?.map((e: any) => e.dealId) ?? [DEAL_ID]).to
        .deep.equal([DEAL_ID])
    })

    it('leaves a deal this process holds, and a sweep still running here, alone', async () => {
      const { b, rec } = freshCombo({
        redisSweeps: [
          { dealId: HELD_DEAL_ID, at: Date.now() - 60_000 },
          { dealId: DEAL_ID, at: Date.now() - 60_000 },
        ],
        dbRows: [gridRow(1)],
      })
      b.deals.set(HELD_DEAL_ID, {
        deal: { _id: HELD_DEAL_ID, symbol: { symbol: SYMBOL } },
      })
      await b.loadCloseSweeps()
      b.closeSweepsInFlight.add(DEAL_ID)
      await b.resumeCloseSweeps()
      expect(rec.orderReads).to.deep.equal([])
      expect(rec.cancels).to.deep.equal([])
    })

    it('§4.2 a load keeps what the previous process recorded alongside its own', async () => {
      const { b } = freshCombo({
        redisSweeps: [{ dealId: DEAL_ID, at: NOW }],
        dbRows: [],
      })
      b.closeSweeps.set(HELD_DEAL_ID, NOW + 1)
      await b.loadCloseSweeps()
      expect([...b.closeSweeps.keys()].sort()).to.deep.equal(
        [DEAL_ID, HELD_DEAL_ID].sort(),
      )
    })
  })

  describe('§4.1 processDealClose records the sweep before it cancels', () => {
    let original: any
    before(() => {
      original = DealStats.getInstance().removeStats
      ;(DealStats.getInstance() as any).removeStats = async () => undefined
    })
    after(() => {
      ;(DealStats.getInstance() as any).removeStats = original
    })

    const closingCombo = (leftOpen: boolean) => {
      const { b, rec } = freshCombo({ redisSweeps: [], dbRows: [] })
      const events: string[] = []
      b.setToRedis = async (key: string, data: any) => {
        if (key === 'closeSweeps') {
          events.push(`redis:${data.map((e: any) => e.dealId).join(',')}`)
        }
      }
      b.cancelAllOrder = async (_p: number, dealId: string) => {
        events.push(`cancel:${dealId}`)
        if (leftOpen) {
          // The venue refused one cancel; spec 180 keeps the order tracked.
          b.setOrder(gridRow(7), false)
        }
      }
      b.deals.set(DEAL_ID, {
        deal: {
          _id: DEAL_ID,
          status: DCADealStatusEnum.closed,
          symbol: { symbol: SYMBOL },
          lastPrice: 0.12,
          avgPrice: 0.12,
          strategy: 'LONG',
        },
      })
      b.removeDealFromStopLossMethods = () => undefined
      b.clearTrailingRetryTimer = () => undefined
      b.pendingClose = new Map()
      b.closeDealTimer = new Map()
      b.botUpdateStats = () => undefined
      b.resetAssets = () => undefined
      b.updateBotDeals = async () => undefined
      b.updateUsage = () => undefined
      b.checkDealsAllowedMethods = async () => undefined
      b.updateDealLastTime = () => undefined
      b.getAggregatedSettings = async () => ({})
      b.dealsDb = {
        readData: async () => ({ status: StatusEnum.notok, data: null }),
      }
      b.saveDeal = () => undefined
      b.shouldProceed = () => false
      b.sendDealClosedAlert = () => undefined
      b.updateDealLastPrices = () => undefined
      b.checkClosedDeals = async () => undefined
      b.afterDealClose = async (dealId: string) => {
        events.push(`afterDealClose:${dealId}`)
      }
      b.processedFilled = new Map()
      b.feeProcessed = new Map()
      b.updateData = () => undefined
      b.closeAfterTpFilled = true
      return { b, rec, events }
    }

    it('writes the record first and removes it once the sweep left nothing open', async () => {
      const { b, events } = closingCombo(false)
      await b.processDealClose(BOT_ID, DEAL_ID, { total: 0, totalUsd: 0 })
      expect(events).to.deep.equal([
        `redis:${DEAL_ID}`,
        `cancel:${DEAL_ID}`,
        `afterDealClose:${DEAL_ID}`,
        'redis:',
      ])
      expect(b.closeSweepsInFlight.has(DEAL_ID)).to.be.false
    })

    it('keeps the record while an order of the deal is still live', async () => {
      const { b, events } = closingCombo(true)
      await b.processDealClose(BOT_ID, DEAL_ID, { total: 0, totalUsd: 0 })
      // Recorded before the cancel, and no later write drops it.
      expect(events.filter((e) => e.startsWith('redis:'))).to.deep.equal([
        `redis:${DEAL_ID}`,
      ])
      expect(events[0]).to.equal(`redis:${DEAL_ID}`)
      expect(b.closeSweeps.has(DEAL_ID)).to.be.true
      expect(b.closeSweepsInFlight.has(DEAL_ID)).to.be.false
    })

    it('records nothing for a close that leaves the orders on purpose', async () => {
      const { b, events } = closingCombo(false)
      await b.processDealClose(
        BOT_ID,
        DEAL_ID,
        { total: 0, totalUsd: 0 },
        true,
        false,
      )
      expect(events.filter((e) => e.startsWith('redis:'))).to.deep.equal([])
    })
  })

  describe('§1.1.3 a placement stops when a close is requested mid-ladder', () => {
    const placingCombo = (
      afterTerminalCloseRefusal: boolean,
      flag: 'closeBySl' | 'closeByTp' = 'closeBySl',
      useMultiTp = false,
    ) => {
      const { b } = freshCombo({ redisSweeps: [], dbRows: [] })
      const sent: string[] = []
      const deal: any = {
        deal: {
          _id: DEAL_ID,
          status: DCADealStatusEnum.open,
          symbol: { symbol: SYMBOL, baseAsset: 'QQQ', quoteAsset: 'USDT' },
          lastPrice: 0.12,
          settings: {},
        },
        closeBySl: false,
        closeByTp: false,
        currentOrders: [],
      }
      b.deals.set(DEAL_ID, deal)
      b.data = {
        ...b.data,
        status: 'open',
        settings: { pair: [SYMBOL], type: 'regular' },
      }
      b.allowToPlaceOrders = new Map()
      b.stopList = new Set()
      b.pendingOrdersList = new Map()
      b.getExchangeInfo = async () => ({
        pair: SYMBOL,
        baseAsset: { name: 'QQQ' },
        quoteAsset: { name: 'USDT' },
      })
      b.getAggregatedSettings = async () => ({ useMultiTp })
      b.isDealForTPLevelCheck = async () => false
      b.isOrderExistInDeal = () => false
      b.reissueSpentLevelId = () => undefined
      b.batchablePlacements = () => []
      b.dealClosedByFilledTp = () => false
      b.underfilledTpQty = () => 0
      b.sendGridToExchange = async (order: any) => {
        sent.push(order.newClientOrderId)
        if (sent.length === 2) {
          // The take-profit triggers while the ladder is being placed.
          deal[flag] = true
        }
      }
      const ladder = [1, 2, 3, 4, 5].map((n) => ({
        newClientOrderId: `CMB-GR-new-${n}`,
        type: TypeOrderEnum.dealGrid,
        side: OrderSideEnum.buy,
        price: 0.12 - n * 0.001,
        qty: 10,
        minigridId: `m-${n}`,
      }))
      const run = () =>
        b.placeOrdersHoldingDealLock(
          BOT_ID,
          SYMBOL,
          DEAL_ID,
          { new: ladder, cancel: [] },
          afterTerminalCloseRefusal ? { afterTerminalCloseRefusal } : undefined,
        )
      return { run, sent }
    }

    it('drops the rest of the ladder once the close flag is set', async () => {
      const { run, sent } = placingCombo(false)
      await run()
      expect(sent).to.have.length(2)
    })

    it('a whole-deal closeByTp stops it the same way', async () => {
      const { run, sent } = placingCombo(false, 'closeByTp')
      await run()
      expect(sent).to.have.length(2)
    })

    it('a multi-TP target close (closeByTp) leaves the rest of the ladder placed', async () => {
      const { run, sent } = placingCombo(false, 'closeByTp', true)
      await run()
      expect(sent).to.have.length(5)
    })

    it('spec 083: the refused-close restore still places the whole ladder', async () => {
      const { run, sent } = placingCombo(true)
      await run()
      expect(sent).to.have.length(5)
    })
  })
})
