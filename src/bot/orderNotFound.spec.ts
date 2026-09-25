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
import {
  isDefinitiveOrderNotFound,
  isKucoinOrderNotExist,
  isNotFoundUnreliableJustAfterPlacement,
  isRetirableNeverPlacedOrder,
  reconcileLookup,
} from './main'

const notok = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})

describe('isDefinitiveOrderNotFound', () => {
  it('does not treat an open-orders-list miss as a venue denial', () => {
    // A filled order is exactly what is absent from the open list.
    expect(isDefinitiveOrderNotFound(notok('Order not found in open orders')))
      .to.be.false
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
      isDefinitiveOrderNotFound({
        status: StatusEnum.ok,
        data: {},
        reason: null,
      }),
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

describe('KuCoin orderNotExist and never-placed orders (Spec 109)', () => {
  const KUCOIN = 'validation.queryOrder.orderNotExist | 400100'
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_790_000_000_000

  it('§1 reads KuCoin orderNotExist as a definitive not-found', () => {
    expect(isKucoinOrderNotExist(KUCOIN)).to.be.true
    expect(isDefinitiveOrderNotFound(notok(KUCOIN))).to.be.true
  })

  it('§2 does not trust it about an order placed seconds ago', () => {
    expect(isNotFoundUnreliableJustAfterPlacement(KUCOIN)).to.be.true
    // Hyperliquid's token keeps its existing treatment.
    expect(isNotFoundUnreliableJustAfterPlacement('unknownOid')).to.be.true
    // Other venues' definitive wording is still trusted right after placement.
    expect(isNotFoundUnreliableJustAfterPlacement('Order not found')).to.be
      .false
    expect(isNotFoundUnreliableJustAfterPlacement('Order does not exist')).to.be
      .false
  })

  it('§3 retires only a never-placed order past the age floor', () => {
    const old = now - DAY - 1
    expect(
      isRetirableNeverPlacedOrder(
        { orderId: '-1', transactTime: old, updateTime: old },
        now,
        DAY,
      ),
    ).to.be.true
    // Too young: the venue may just be slow.
    expect(
      isRetirableNeverPlacedOrder(
        { orderId: '-1', transactTime: now - 60_000 },
        now,
        DAY,
      ),
    ).to.be.false
    // It has an exchange id: it DID land somewhere — quarantine, never retire.
    expect(
      isRetirableNeverPlacedOrder(
        { orderId: '6a1b2c', transactTime: old },
        now,
        DAY,
      ),
    ).to.be.false
    // No timestamp at all: refuse to judge.
    expect(isRetirableNeverPlacedOrder({ orderId: '-1' }, now, DAY)).to.be.false
    // A recent update (e.g. a stream event) resets the clock.
    expect(
      isRetirableNeverPlacedOrder(
        { orderId: '-1', transactTime: old, updateTime: now - 1000 },
        now,
        DAY,
      ),
    ).to.be.false
  })
})
