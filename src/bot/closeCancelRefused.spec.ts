process.env.NODE_ENV = 'testing'

/**
 * A cancel the venue refuses while a deal is closing (or the bot is stopping)
 * must not leave a live order that nothing tracks.
 *
 * Coinbase refused two close-sweep cancels, with `COMMANDER_REJECTED_CANCEL_ORDER`
 * and `RFQ_ORDERS_CANNOT_BE_CANCELLED`. `cancelOrderOnExchange` only reported
 * them, and `processDealClose` then dropped both orders from memory and from
 * the user stream. One row is still `NEW` and the other still
 * `PARTIALLY_FILLED`, each on a closed deal.
 *
 * Spec: `specs/180.a-close-cancel-the-venue-refuses-is-dropped-while-the-order-is-live.md`.
 * Run: `npm test` (mocha) from core/.
 *
 * No network / DB needed. Part A drives the real `cancelOrderOnExchange` off
 * the MainBot prototype. Part B drives the real close sweep — the two calls
 * `processDealClose` makes after dropping the deal, `cancelAllOrder` then
 * `removeOrdersByDeal` — plus the real unknown-order ladder and spec 178's
 * deferred re-send, on a DCA helper built over the real MainBot, with real
 * order maps.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const COMMANDER = 'COMMANDER_REJECTED_CANCEL_ORDER'
const RFQ = 'RFQ_ORDERS_CANNOT_BE_CANCELLED'
const NOT_FOUND = 'Order not found'
const RATE_LIMIT = 'Too many requests'

const HONEY_DEAL = 'aaaaaaaaaaaaaaaaaaaa0170'
const POND_DEAL = 'bbbbbbbbbbbbbbbbbbbb0170'

/** §2.1 — the HONEY-USDC safety order the close sweep could not cancel. */
function honeyOrder(over: Record<string, unknown> = {}) {
  return {
    symbol: 'HONEY-USDC',
    orderId: '5f0c1d6e-0000-4000-8000-000000000170',
    clientOrderId: 'D-RO-a68FnlwOoHpZiXb0ledSXn87Xk1Moc',
    dealId: HONEY_DEAL,
    typeOrder: 'dealRegular',
    price: '0.003527',
    origQty: '4252.9',
    executedQty: '0',
    status: 'NEW',
    side: 'BUY',
    updateTime: 1791472403399,
    transactTime: 1791472403399,
    ...over,
  } as any
}

/** §2.2 — the POND-USDC order Coinbase turned into an RFQ, part filled. */
function pondOrder(over: Record<string, unknown> = {}) {
  return {
    symbol: 'POND-USDC',
    orderId: '7a9e2b41-0000-4000-8000-000000000170',
    clientOrderId: 'D-ROA-jyxMv8yl3vhZfwQarzo4jy7pLOa7j',
    dealId: POND_DEAL,
    typeOrder: 'dealRegular',
    price: '0.0015104',
    origQty: '5241',
    executedQty: '739',
    status: 'PARTIALLY_FILLED',
    side: 'BUY',
    updateTime: 1792088303597,
    transactTime: 1792088303597,
    ...over,
  } as any
}

type Answer = { status: StatusEnum; reason: string; data: any }
const bad = (reason: string): Answer => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})
const good = (data: any): Answer => ({ status: StatusEnum.ok, reason: '', data })

// ─── Part A: cancelOrderOnExchange routing ──────────────────────────────────

/**
 * @param answers successive cancel answers; the last one repeats.
 * @param teardown what `cancelIsTeardown` says for this cancel.
 */
function mainBot(answers: Answer[], teardown: boolean) {
  const rec = {
    cancels: 0,
    errors: [] as string[],
    unknown: [] as string[],
    saved: [] as any[],
    waits: [] as number[],
    scheduled: [] as number[],
  }
  const b: any = Object.create((MainBot as any).prototype)
  b.data = {
    exchange: ExchangeEnum.coinbase,
    exchangeUUID: '',
    paperContext: false,
  }
  b.orders = new Map()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  // Stop is `blockPriceCheck`; a deal close is the DCA override. Either way
  // the routing reads only this hook.
  b.blockPriceCheck = false
  b.cancelIsTeardown = () => teardown
  b.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => (d: unknown) => good(d),
    async cancelOrder() {
      const a = answers[Math.min(rec.cancels, answers.length - 1)]
      rec.cancels++
      return a
    },
  }
  b.refusedCancelRetryDelay = () => 7
  b.sleepBeforeCancelRetry = async (ms: number) => {
    rec.waits.push(ms)
  }
  b.awaitPlacementInFlight = async () => undefined
  b.resolveNeverPlacedOrder = async () => null
  b.noteOwnCancel = () => undefined
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = () => undefined
  b.handleDebug = () => undefined
  b.handleWarn = () => undefined
  b.handleErrors = (reason: string) => rec.errors.push(reason)
  b.emit = () => undefined
  b.setOrder = () => undefined
  b.deleteOrder = () => undefined
  b.updateOrderOnDb = (o: any) => rec.saved.push({ ...o })
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b._handleUnknownOrder = async (id: string) => {
    rec.unknown.push(id)
    return null
  }
  // What the venue lookup left behind: still resting, so it is tracked.
  b.findOwnOrder = async () => liveAfterLookup
  b.cancelRetryJitter = () => 1
  b.scheduleCancelRetry = (_fn: unknown, ms: number) => rec.scheduled.push(ms)
  return { b, rec }
}
let liveAfterLookup: any = undefined

describe('close / stop cancel refused by the venue (spec 180)', () => {
  describe('A — cancelOrderOnExchange', () => {
    it('§1.1.1 §1.1.2 re-sends a COMMANDER refusal once, then asks the venue', async () => {
      const { b, rec } = mainBot([bad(COMMANDER)], true)
      const o = honeyOrder()
      await b.cancelOrderOnExchange(o)
      expect(rec.cancels, 'cancel requests').to.equal(2)
      expect(rec.waits, 'one short back-off').to.deep.equal([7])
      expect(rec.unknown, 'venue asked for the real state').to.deep.equal([
        o.clientOrderId,
      ])
      expect(rec.errors, 'no bot error for a tracked order').to.deep.equal([])
    })

    it('§1.1.4 an order still resting after the lookup goes on the deferred ladder', async () => {
      liveAfterLookup = honeyOrder()
      try {
        const { b, rec } = mainBot([bad(COMMANDER)], true)
        await b.cancelOrderOnExchange(honeyOrder())
        expect(rec.scheduled, 'spec 178 first step').to.deep.equal([30_000])
      } finally {
        liveAfterLookup = undefined
      }
    })

    it('§1.1.1 a re-send the venue accepts is recorded as CANCELED', async () => {
      const { b, rec } = mainBot(
        [bad(COMMANDER), good({ ...honeyOrder(), status: 'CANCELED' })],
        true,
      )
      await b.cancelOrderOnExchange(honeyOrder())
      expect(rec.cancels).to.equal(2)
      expect(rec.saved.map((s) => s.status)).to.deep.equal(['CANCELED'])
      expect(rec.unknown).to.deep.equal([])
      expect(rec.errors).to.deep.equal([])
    })

    it('§1.1.1 a re-send answered "not found" takes the existing unknown-order route', async () => {
      const { b, rec } = mainBot([bad(COMMANDER), bad(NOT_FOUND)], true)
      const o = honeyOrder()
      await b.cancelOrderOnExchange(o)
      expect(rec.cancels).to.equal(2)
      expect(rec.unknown).to.deep.equal([o.clientOrderId])
      expect(rec.errors).to.deep.equal([])
    })

    it('§1.1.3 an RFQ refusal is not re-sent; it is looked up straight away', async () => {
      const { b, rec } = mainBot([bad(RFQ)], true)
      const o = pondOrder()
      await b.cancelOrderOnExchange(o)
      expect(rec.cancels).to.equal(1)
      expect(rec.waits).to.deep.equal([])
      expect(rec.unknown).to.deep.equal([o.clientOrderId])
      expect(rec.errors).to.deep.equal([])
    })

    it('§1.1.6 a running deal is untouched: one request, reported as before', async () => {
      for (const reason of [COMMANDER, RFQ]) {
        const { b, rec } = mainBot([bad(reason), good(honeyOrder())], false)
        await b.cancelOrderOnExchange(honeyOrder())
        expect(rec.cancels, reason).to.equal(1)
        expect(rec.waits, reason).to.deep.equal([])
        expect(rec.unknown, reason).to.deep.equal([])
        expect(rec.errors, reason).to.deep.equal([reason])
      }
    })

    it('§1.1.6 a rate refusal at a deal close keeps its old handling', async () => {
      const { b, rec } = mainBot([bad(RATE_LIMIT)], true)
      await b.cancelOrderOnExchange(honeyOrder())
      expect(rec.cancels).to.equal(1)
      expect(rec.unknown).to.deep.equal([])
      expect(rec.errors).to.deep.equal([RATE_LIMIT])
    })
  })

  // ─── Part B: the DCA close sweep ──────────────────────────────────────────

  describe('B — DCA close sweep', () => {
    let DCA: any

    /** What `processDealClose` does once the deal is dropped. */
    async function closeSweep(b: any, dealId: string, price: number) {
      await b.cancelAllOrder(price, dealId, true)
      b.removeOrdersByDeal(dealId)
    }

    before(function () {
      // One ts-node compile of a 25k-line module.
      this.timeout(180000)
      DCA = createRequire(__filename)('./dcaHelper').default(MainBot)
    })

    /**
     * @param cancelAnswer what every cancel of this order gets.
     * @param venueState what `getOrder` says the order is now.
     */
    function dcaBot(cancelAnswer: Answer, venueState: any) {
      const rec = {
        cancels: 0,
        getOrder: 0,
        stream: new Set<string>(),
        filled: [] as any[],
        errors: [] as string[],
        scheduled: [] as number[],
      }
      const b: any = Object.create(DCA.prototype)
      b.botId = 'cccccccccccccccccccc0170'
      b.data = {
        exchange: ExchangeEnum.coinbase,
        exchangeUUID: '',
        paperContext: false,
      }
      b.orders = new Map()
      b.orderStatuses = ['NEW', 'PARTIALLY_FILLED']
      b.ordersKeys = new Set()
      b.orderStatusMap = new Map()
      b.orderDealMap = new Map()
      b.canceledMap = new Map()
      b.unknownOrderInFlight = new Map()
      b.partiallyFilledFilledSet = new Set()
      // The deal is already gone: `processDealClose` drops it before the sweep.
      b.deals = new Map()
      b.blockPriceCheck = false
      b.cancelRetryJitter = () => 1
      b.scheduleCancelRetry = (_fn: unknown, ms: number) =>
        rec.scheduled.push(ms)
      b.sharedStream = {
        addOrder: (_bot: string, id: string) => rec.stream.add(id),
        removeOrder: (_bot: string, id: string) => rec.stream.delete(id),
      }
      b.setOrdersToRedis = () => undefined
      b.exchange = {
        returnBad: () => (e: Error) => bad(e.message),
        returnGood: () => (d: unknown) => good(d),
        async cancelOrder() {
          rec.cancels++
          return cancelAnswer
        },
        async getOrder() {
          rec.getOrder++
          return good(venueState)
        },
      }
      b.refusedCancelRetryDelay = () => 0
      b.sleepBeforeCancelRetry = async () => undefined
      b.primeCancelBatch = async () => undefined
      b.clearCancelBatch = () => undefined
      b.awaitPlacementInFlight = async () => undefined
      b.resolveNeverPlacedOrder = async () => null
      b.noteOwnCancel = () => undefined
      b.startMethod = () => 1
      b.endMethod = () => undefined
      b.handleLog = () => undefined
      b.handleDebug = () => undefined
      b.handleWarn = () => undefined
      b.handleErrors = (reason: string) => rec.errors.push(reason)
      b.emit = () => undefined
      b.ordersDb = {
        readData: async () => ({ data: { result: undefined } }),
        updateData: async () => ({ status: StatusEnum.ok }),
      }
      b.updateOrderOnDb = () => undefined
      b.convertOrderExecutedQty = async (o: any) => o.executedQty
      b.processFilledOrder = async (o: any) => {
        rec.filled.push({ ...o })
      }
      return { b, rec }
    }

    it('§1.1.5 the HONEY order the venue still holds NEW stays tracked after close', async () => {
      const o = honeyOrder()
      const { b, rec } = dcaBot(bad(COMMANDER), { ...o })
      b.setOrder(o)
      await closeSweep(b, HONEY_DEAL, 0.003)
      expect(rec.cancels, 're-sent once').to.equal(2)
      expect(rec.getOrder, 'venue asked').to.equal(1)
      expect(b.getOrderFromMap(o.clientOrderId)?.status).to.equal('NEW')
      expect(rec.stream.has(o.clientOrderId), 'still on the user stream').to
        .be.true
      expect(rec.errors).to.deep.equal([])
      expect(rec.scheduled, 'deferred re-send queued').to.deep.equal([30_000])
    })

    it('§1.1.5 the POND RFQ order still PARTIALLY_FILLED stays tracked after close', async () => {
      const o = pondOrder()
      const { b, rec } = dcaBot(bad(RFQ), { ...o })
      b.setOrder(o)
      await closeSweep(b, POND_DEAL, 0.0015)
      expect(rec.cancels, 'RFQ is never re-sent').to.equal(1)
      expect(rec.getOrder).to.equal(1)
      expect(b.getOrderFromMap(o.clientOrderId)?.status).to.equal(
        'PARTIALLY_FILLED',
      )
      expect(rec.stream.has(o.clientOrderId)).to.be.true
    })

    it('§1.1.4 an order the venue reports FILLED goes to the late-fill path', async () => {
      const o = honeyOrder()
      const { b, rec } = dcaBot(bad(COMMANDER), {
        ...o,
        status: 'FILLED',
        executedQty: o.origQty,
      })
      b.setOrder(o)
      await closeSweep(b, HONEY_DEAL, 0.003)
      expect(rec.filled.map((f) => [f.clientOrderId, f.status])).to.deep.equal(
        [[o.clientOrderId, 'FILLED']],
      )
      expect(b.getOrderFromMap(o.clientOrderId), 'processed, then dropped').to
        .be.undefined
    })

    it('§1.1.4 an order the venue reports CANCELED is retired', async () => {
      const o = honeyOrder()
      const { b, rec } = dcaBot(bad(COMMANDER), { ...o, status: 'CANCELED' })
      b.setOrder(o)
      await closeSweep(b, HONEY_DEAL, 0.003)
      expect(b.getOrderFromMap(o.clientOrderId)).to.be.undefined
      expect(rec.stream.has(o.clientOrderId)).to.be.false
      expect(rec.filled).to.deep.equal([])
    })

    it('§1.1.4 a deferred re-send that finds the order FILLED sells it as a late fill', async () => {
      const o = honeyOrder()
      const { b, rec } = dcaBot(bad(COMMANDER), {
        ...o,
        status: 'FILLED',
        executedQty: o.origQty,
      })
      b.setOrder(o)
      b.cancelRetries = new Map([[o.clientOrderId, { attempt: 1, pending: true }]])
      await b.runCancelRetry(o.clientOrderId, [true, true, true])
      expect(rec.filled.map((f) => [f.clientOrderId, f.status])).to.deep.equal(
        [[o.clientOrderId, 'FILLED']],
      )
    })

    it('§1.1.6 an open deal is not torn down: refusal reported, nothing re-sent', async () => {
      const o = honeyOrder()
      const { b, rec } = dcaBot(bad(COMMANDER), { ...o })
      b.deals.set(HONEY_DEAL, { deal: { _id: HONEY_DEAL } })
      b.setOrder(o)
      await b.cancelOrderOnExchange(o)
      expect(rec.cancels).to.equal(1)
      expect(rec.getOrder).to.equal(0)
      expect(rec.errors).to.deep.equal([COMMANDER])
    })

    it('§1.1.5 removeOrdersByDeal drops finished orders and keeps live ones', () => {
      const { b, rec } = dcaBot(bad(COMMANDER), {})
      const live = honeyOrder()
      const done = honeyOrder({
        clientOrderId: 'D-RO-done',
        status: 'CANCELED',
      })
      b.setOrder(live)
      b.setOrder(done)
      b.removeOrdersByDeal(HONEY_DEAL)
      expect(b.getOrderFromMap(done.clientOrderId)).to.be.undefined
      expect(b.getOrderFromMap(live.clientOrderId)?.status).to.equal('NEW')
      expect(rec.stream.has(live.clientOrderId)).to.be.true
    })
  })
})
