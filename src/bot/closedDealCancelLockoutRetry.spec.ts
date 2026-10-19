process.env.NODE_ENV = 'testing'

/**
 * A cancel the venue refuses as transient (rate limit, temporary lockout)
 * while a deal closes must be sent again once the hold lifts, so a closed
 * deal does not leave its safety / take-profit orders live on the venue.
 *
 * Kraken ETHEUR: the take profit filled, both safety-order cancels were
 * answered `EGeneral:Temporary lockout (balancer held this key off for another
 * 405s …)`, the deal closed, and both orders stayed NEW on the venue with
 * nothing managing them.
 *
 * Spec: `specs/178.a-cancel-refused-during-a-lockout-leaves-a-closed-deals-order-live.md`.
 * Run: `npm test` (mocha).
 *
 * No network / DB needed — the real method is driven off the prototype against
 * a scripted transport and a captured scheduler.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from './main'
import { ExchangeEnum, StatusEnum } from '../../types'

const LOCKOUT =
  'EGeneral:Temporary lockout (balancer held this key off for another 405s; requests during a Kraken lockout extend it)'
const VENUE_LOCKOUT = 'EGeneral:Temporary lockout'
const RATE_LIMIT = 'Too many visits. Exceeded the API Rate Limit.'
const NOT_FOUND = 'EOrder:Unknown order'
const DEAL_ID = '6ad206d8f29e37f1b0e4d337'

function so(id: string, orderId: string, price: string, qty: string) {
  return {
    symbol: 'ETHEUR',
    orderId,
    clientOrderId: id,
    dealId: DEAL_ID,
    typeOrder: 'dealRegular',
    price,
    origQty: qty,
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
const cancelled = (o: any): Answer => ({
  status: StatusEnum.ok,
  reason: '',
  data: { ...o, status: 'CANCELED', updateTime: 1792379000000 },
})

/**
 * @param answer what the venue answers to the n-th cancel of an order.
 * @param proto the prototype to drive (MainBot, or the DCA helper's).
 */
function bot(
  answer: (o: any, n: number) => Answer,
  proto: any = (MainBot as any).prototype,
) {
  const rec = {
    sent: [] as string[],
    errors: [] as string[],
    unknown: [] as string[],
    saved: [] as any[],
    timers: [] as { ms: number; fn: () => unknown }[],
  }
  const b: any = Object.create(proto)
  b.botId = 'bot'
  b.data = { exchange: ExchangeEnum.kraken, exchangeUUID: '', paperContext: false }
  b.orders = new Map()
  b.canceledMap = new Map()
  b.unknownOrderInFlight = new Map()
  b.deals = new Map()
  b.blockPriceCheck = false
  b.exchange = {
    returnBad: () => (e: Error) => bad(e.message),
    returnGood: () => (d: unknown) => ({ status: StatusEnum.ok, data: d }),
    async cancelOrder({ newClientOrderId }: { newClientOrderId: string }) {
      const o = [...b.orders.values()].find(
        (x: any) => x.orderId === newClientOrderId,
      )
      const n = rec.sent.filter((s) => s === o.clientOrderId).length
      rec.sent.push(o.clientOrderId)
      return answer(o, n)
    },
  }
  b.scheduleCancelRetry = (fn: () => unknown, ms: number) => {
    rec.timers.push({ ms, fn })
  }
  b.cancelRetryJitter = () => 1
  b.startMethod = () => 1
  b.endMethod = () => undefined
  b.handleLog = () => undefined
  b.handleDebug = () => undefined
  b.handleWarn = () => undefined
  b.handleErrors = (reason: string) => rec.errors.push(reason)
  b.emit = () => undefined
  b.setOrder = (o: any) => b.orders.set(o.clientOrderId, o)
  b.deleteOrder = (id: string) => b.orders.delete(id)
  b.updateOrderOnDb = (o: any) => rec.saved.push({ ...o })
  b.convertOrderExecutedQty = async (o: any) => o.executedQty
  b.ordersDb = {
    readData: async () => ({ status: StatusEnum.ok, data: { result: null } }),
  }
  b._handleUnknownOrder = async (id: string) => {
    rec.unknown.push(id)
    const o = b.orders.get(id)
    if (o) {
      o.status = 'CANCELED'
    }
    return null
  }
  return { b, rec }
}

/** Fire every timer scheduled so far (and only those), in order. */
async function fireAll(rec: { timers: { fn: () => unknown }[] }) {
  const due = rec.timers.splice(0)
  for (const t of due) {
    await t.fn()
  }
}

describe('closed-deal cancel refused as transient (spec 178)', () => {
  let Helper: any
  before(() => {
    Helper = createRequire(__filename)('./dcaHelper').default()
  })

  it('§4.1–§4.4 deal 6ad206d8: both lockout-refused safety orders are cancelled after the hold', async () => {
    const { b, rec } = bot((o, n) => (n === 0 ? bad(LOCKOUT) : cancelled(o)), Helper.prototype)
    const a = so('D-RO-Nbfxyfm9q5r0e', 'OYHLTP-RN3V5-RUNZ4X', '2059.39', '0.2097')
    const c = so('D-RO-pofpeHpz7Yd2m', 'ONR4GJ-XV7UB-JR7M3Z', '2024.15', '0.2986')
    b.orders.set(a.clientOrderId, a)
    b.orders.set(c.clientOrderId, c)
    b.deals.set(DEAL_ID, { deal: { _id: DEAL_ID } })
    // the take profit filled: the close cancels the ladder
    await b.cancelOrderOnExchange(a, false)
    await b.cancelOrderOnExchange(c, false)
    expect(rec.errors, 'reported as before').to.deep.equal([LOCKOUT, LOCKOUT])
    expect(rec.timers.map((t) => t.ms), 'waits out the 405s hold').to.have.length(2)
    for (const t of rec.timers) {
      expect(t.ms).to.be.at.least(405_000)
    }
    // the deal closes before the hold lifts
    b.deals.delete(DEAL_ID)
    await fireAll(rec)
    expect(rec.sent).to.deep.equal([
      a.clientOrderId,
      c.clientOrderId,
      a.clientOrderId,
      c.clientOrderId,
    ])
    expect(rec.saved.map((s) => [s.clientOrderId, s.status])).to.deep.equal([
      [a.clientOrderId, 'CANCELED'],
      [c.clientOrderId, 'CANCELED'],
    ])
    expect(rec.timers).to.deep.equal([])
  })

  it('§4.3 an open deal\'s order is left to the engine', async () => {
    const { b, rec } = bot((o, n) => (n === 0 ? bad(LOCKOUT) : cancelled(o)), Helper.prototype)
    const a = so('D-RO-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    b.deals.set(DEAL_ID, { deal: { _id: DEAL_ID } })
    await b.cancelOrderOnExchange(a)
    await fireAll(rec)
    expect(rec.sent).to.deep.equal([a.clientOrderId])
    expect(rec.timers).to.deep.equal([])
  })

  it('§4.3 an order already settled (stream said CANCELED) is not re-sent', async () => {
    const { b, rec } = bot((o, n) => (n === 0 ? bad(VENUE_LOCKOUT) : cancelled(o)), Helper.prototype)
    const a = so('D-RO-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    await b.cancelOrderOnExchange(a)
    b.orders.set(a.clientOrderId, { ...a, status: 'CANCELED' })
    await fireAll(rec)
    expect(rec.sent).to.deep.equal([a.clientOrderId])
  })

  it('§4.4 "not found" on the re-send goes to the unknown-order ladder', async () => {
    const { b, rec } = bot((_o, n) => (n === 0 ? bad(LOCKOUT) : bad(NOT_FOUND)), Helper.prototype)
    const a = so('D-RO-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    await b.cancelOrderOnExchange(a)
    await fireAll(rec)
    expect(rec.unknown).to.deep.equal([a.clientOrderId])
    expect(rec.timers).to.deep.equal([])
  })

  it('§4.2 bounded: four deferred re-sends, back-off when no hold is stated', async () => {
    const { b, rec } = bot(() => bad(RATE_LIMIT), Helper.prototype)
    const a = so('D-RO-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    await b.cancelOrderOnExchange(a)
    const waits: number[] = []
    while (rec.timers.length) {
      waits.push(rec.timers[0].ms)
      await fireAll(rec)
    }
    expect(waits).to.deep.equal([30_000, 120_000, 600_000, 1_800_000])
    expect(rec.sent).to.have.length(5)
  })

  it('§4.2 one pending re-send per order', async () => {
    const { b, rec } = bot(() => bad(LOCKOUT), Helper.prototype)
    const a = so('D-RO-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    await b.cancelOrderOnExchange(a)
    await b.cancelOrderOnExchange(a)
    expect(rec.timers).to.have.length(1)
  })

  // Narrowed by spec 180: on a closed deal a non-transient refusal is re-sent
  // once inline and then looked up; it reaches this ladder only if the order
  // is still resting after the lookup (here the lookup retires it).
  it('§4.5 a non-transient refusal is not put on the transient ladder', async () => {
    const { b, rec } = bot(() => bad('EGeneral:Invalid arguments'), Helper.prototype)
    b.sleepBeforeCancelRetry = async () => undefined
    const a = so('D-RO-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    await b.cancelOrderOnExchange(a)
    expect(rec.sent).to.deep.equal([a.clientOrderId, a.clientOrderId])
    expect(rec.unknown).to.deep.equal([a.clientOrderId])
    expect(rec.timers).to.deep.equal([])
  })

  it('§5 a bot without deals (base class) never re-sends', async () => {
    const { b, rec } = bot((o, n) => (n === 0 ? bad(LOCKOUT) : cancelled(o)))
    const a = so('GR-a', 'OAAAAA-AAAAA-AAAAAA', '2059.39', '0.2097')
    b.orders.set(a.clientOrderId, a)
    await b.cancelOrderOnExchange(a)
    await fireAll(rec)
    expect(rec.sent).to.deep.equal([a.clientOrderId])
  })
})
