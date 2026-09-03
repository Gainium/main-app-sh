process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the reconcile path's reading of "order not found".
 *
 * On a bot-worker restart, three filled Kraken spot safety orders were
 * reported as "Order not found in open orders" — the connector's fallback
 * wording after its exact QueryOrders lookup had failed transiently — and the
 * restart probe, having no retry, read that as the venue denying the orders
 * and skipped them. The deal stayed one level deep while the venue held the
 * full position, until the next reconnect pass (which DOES retry) re-asked and
 * booked the fills.
 *
 * Two properties pin the fix: that wording is ambiguous, not definitive; and
 * the retry policy therefore re-asks through it while still stopping on a
 * genuine venue denial.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum } from '../../types'
import { isDefinitiveOrderNotFound, reconcileLookup } from './main'

const notok = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

describe('isDefinitiveOrderNotFound', () => {
  it('does not treat an open-orders-list miss as a venue denial', () => {
    // A filled order is exactly what is absent from the open list.
    expect(isDefinitiveOrderNotFound(notok('Order not found in open orders'))).to
      .be.false
  })

  it('still trusts the venue answers that are definitive', () => {
    for (const reason of [
      'Order not found in active orders',
      'Order not found in history',
      'Order not found',
      'Order not found: no exchange order id',
      'Coinbase order not found after execution.',
      'Order does not exist',
      'unknownOid',
    ]) {
      expect(isDefinitiveOrderNotFound(notok(reason)), reason).to.be.true
    }
  })

  it('never reads a successful or unrelated failure as a denial', () => {
    expect(
      isDefinitiveOrderNotFound({ status: StatusEnum.ok, data: {}, reason: null }),
    ).to.be.false
    for (const reason of ['Response timeout', 'Symbol not found', '']) {
      expect(isDefinitiveOrderNotFound(notok(reason)), reason).to.be.false
    }
  })
})

describe('reconcileLookup', () => {
  const opts = { attempts: 3, backoffMs: 1, sleep: async () => undefined }

  it('re-asks through an open-orders-list miss and returns the answer', async () => {
    const answers = [
      notok('Order not found in open orders'),
      notok('Order not found in open orders'),
      { status: StatusEnum.ok, reason: null, data: { status: 'FILLED' } },
    ]
    let calls = 0
    const res = await reconcileLookup(async () => answers[calls++], opts)
    expect(calls).to.equal(3)
    expect(res?.data).to.deep.equal({ status: 'FILLED' })
  })

  it('stops on the first definitive denial', async () => {
    let calls = 0
    const res = await reconcileLookup(async () => {
      calls++
      return notok('Order not found in active orders')
    }, opts)
    expect(calls).to.equal(1)
    expect(res?.reason).to.equal('Order not found in active orders')
  })
})
