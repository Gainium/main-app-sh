process.env.NODE_ENV = 'testing'

/**
 * A cancel the venue refuses for RATE while the bot is being stopped must be
 * sent again, so the order's row ends up recording what the venue did with it.
 *
 * Bybit answered `Too many visits. Exceeded the API Rate Limit.` to the
 * teardown cancels of a mass bot deletion. `cancelOrderOnExchange` logged the
 * refusal and moved on, `stop()` then closed the user stream, and the venue's
 * own `Cancelled` event for the order arrived with nobody listening — the row
 * stayed `NEW` on a deleted bot for good.
 *
 * Spec: `specs/134.teardown-cancel-refused-for-rate-is-never-resent.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB needed — the real method is driven off the prototype against
 * a scripted transport.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const RATE_LIMIT = 'Too many visits. Exceeded the API Rate Limit.'
const NOT_FOUND = 'Order does not exist.'

function order() {
  return {
    symbol: 'BERAUSDT',
    orderId: '2071834507890081536',
    clientOrderId: 'CMB-GR-KFseU1J3Y7kXTGe2zyBa8NWeIsPb',
    price: '0.2327',
    origQty: '31.57',
    executedQty: '0',
    status: 'NEW',
    side: 'BUY',
    updateTime: -1,
    transactTime: -1,
  } as any
}

type Answer = { status: StatusEnum; reason: string; data: any }

const bad = (reason: string): Answer => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})
const cancelled = (): Answer => ({
  status: StatusEnum.ok,
  reason: '',
  data: { ...order(), status: 'CANCELED', updateTime: 1791289531963 },
})

/**
 * @param answers what the venue answers to each successive cancel; the last
 * one repeats.
 * @param stopping whether the bot is inside `stop()` (`blockPriceCheck`).
 */
function bot(answers: Answer[], stopping: boolean) {
  const rec = {
    cancels: 0,
    errors: [] as string[],
    unknown: [] as string[],
    saved: [] as any[],
    waits: [] as number[],
  }
  const b: any = Object.create((MainBot as any).prototype)
  b.data = { exchange: ExchangeEnum.bybit, exchangeUUID: '', paperContext: false }
  b.orders = new Map()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.blockPriceCheck = stopping
  b.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => (d: unknown) => ({ status: StatusEnum.ok, data: d }),
    async cancelOrder() {
      const a = answers[Math.min(rec.cancels, answers.length - 1)]
      rec.cancels++
      return a
    },
  }
  b.teardownCancelRetryDelays = () => [11, 22, 33]
  b.sleepBeforeCancelRetry = async (ms: number) => {
    rec.waits.push(ms)
  }
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
  return { b, rec }
}

describe('teardown cancel refused for rate (spec 134)', () => {
  it('§4.1 re-sends the cancel and records the venue CANCELED', async () => {
    const { b, rec } = bot([bad(RATE_LIMIT), cancelled()], true)
    const o = order()
    b.orders.set(o.clientOrderId, o)
    await b.cancelOrderOnExchange(o)
    expect(rec.cancels, 'cancel requests').to.equal(2)
    expect(rec.waits, 'backed off before re-sending').to.deep.equal([11])
    expect(rec.saved.map((s) => s.status)).to.deep.equal(['CANCELED'])
    expect(rec.errors, 'a resolved refusal raises nothing').to.deep.equal([])
  })

  it('§4.2 an order someone else already cancelled is reconciled, not left NEW', async () => {
    const { b, rec } = bot([bad(RATE_LIMIT), bad(NOT_FOUND)], true)
    const o = order()
    b.orders.set(o.clientOrderId, o)
    await b.cancelOrderOnExchange(o)
    expect(rec.unknown).to.deep.equal([o.clientOrderId])
    expect(rec.errors).to.deep.equal([])
  })

  it('§4.3 gives up after the bounded ladder and reports as before', async () => {
    const { b, rec } = bot([bad(RATE_LIMIT)], true)
    const o = order()
    b.orders.set(o.clientOrderId, o)
    await b.cancelOrderOnExchange(o)
    expect(rec.cancels).to.equal(4)
    expect(rec.waits).to.deep.equal([11, 22, 33])
    expect(rec.errors).to.deep.equal([RATE_LIMIT])
  })

  it('§4.4 a running bot is untouched: one request, reported as before', async () => {
    const { b, rec } = bot([bad(RATE_LIMIT), cancelled()], false)
    const o = order()
    b.orders.set(o.clientOrderId, o)
    await b.cancelOrderOnExchange(o)
    expect(rec.cancels).to.equal(1)
    expect(rec.waits).to.deep.equal([])
    expect(rec.errors).to.deep.equal([RATE_LIMIT])
  })

  it('§4.5 any other refusal during stop is not re-sent', async () => {
    const { b, rec } = bot([bad('Insufficient balance'), cancelled()], true)
    const o = order()
    b.orders.set(o.clientOrderId, o)
    await b.cancelOrderOnExchange(o)
    expect(rec.cancels).to.equal(1)
    expect(rec.errors).to.deep.equal(['Insufficient balance'])
  })
})
