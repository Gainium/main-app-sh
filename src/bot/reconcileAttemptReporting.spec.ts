process.env.NODE_ENV = 'testing'

/**
 * Regression tests for bug #676 — the reconcile pass's unresolved-order WARN
 * printed the attempt BUDGET (`reconcileLookupAttempts`, default 3) as if it
 * were the attempts actually spent.
 *
 * Prod, 2026-09-05: 853 grid warns, order counts 1 to 45, every one of them
 * "after 3 attempts" — and two consecutive passes 545ms apart, which is less
 * than the minimum sleep ONE order spending three attempts would incur. The
 * ladder had not run; the log said it had, and a triage session read the line
 * as a retry storm and filed a defect against working code.
 *
 * Enforces specs/012 §5.1, §5.2 and §5.4.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum } from '../../types'
import { reconcileLookup, reconcileUnresolvedWarn } from './main'

const notok = (reason: string) => ({
  status: StatusEnum.notok,
  reason,
  data: null,
})
const ok = { status: StatusEnum.ok, reason: null, data: { status: 'FILLED' } }

const opts = (onAttempts?: (n: number) => void) => ({
  attempts: 3,
  backoffMs: 1,
  sleep: async () => undefined,
  onAttempts,
})

describe('reconcileLookup attempt reporting (spec 012 §5.1)', () => {
  it('reports ONE attempt when the venue answers definitively', async () => {
    // The prod shape: an order the venue denies outright (or one with no
    // exchange order id, which is answered locally with the same wording)
    // exits the ladder at attempt 1.
    let spent: number | undefined
    let calls = 0
    await reconcileLookup(
      async () => {
        calls++
        return notok('Order not found in active orders')
      },
      opts((n) => (spent = n)),
    )
    expect(calls).to.equal(1)
    expect(spent).to.equal(1)
  })

  it('reports ONE attempt when the first lookup succeeds', async () => {
    let spent: number | undefined
    await reconcileLookup(
      async () => ok,
      opts((n) => (spent = n)),
    )
    expect(spent).to.equal(1)
  })

  it('reports ONE attempt when the transport ladder is already exhausted', async () => {
    // `isTransportRetryExhausted` keys off the connector's own marker —
    // `apiCall` has already spent six round trips by the time this is emitted.
    let spent: number | undefined
    let calls = 0
    await reconcileLookup(
      async () => {
        calls++
        return notok('Exchange connector | Response timeout')
      },
      opts((n) => (spent = n)),
    )
    expect(calls).to.equal(1)
    expect(spent).to.equal(1)
  })

  it('reports the full ladder when it actually runs', async () => {
    // An ambiguous miss is the one answer that IS re-asked.
    let spent: number | undefined
    let calls = 0
    await reconcileLookup(
      async () => {
        calls++
        return notok('Order not found in open orders')
      },
      opts((n) => (spent = n)),
    )
    expect(calls).to.equal(3)
    expect(spent).to.equal(3)
  })

  it('reports the attempt the answer arrived on, not the budget', async () => {
    const answers = [notok('Order not found in open orders'), ok]
    let spent: number | undefined
    let calls = 0
    await reconcileLookup(
      async () => answers[calls++],
      opts((n) => (spent = n)),
    )
    expect(spent).to.equal(2)
  })
})

describe('reconcileLookup is unchanged by the reporting (spec 012 §5.2)', () => {
  it('returns the same result and spends the same calls with no callback', async () => {
    const answers = [
      notok('Order not found in open orders'),
      notok('Order not found in open orders'),
      ok,
    ]
    let calls = 0
    const res = await reconcileLookup(async () => answers[calls++], {
      attempts: 3,
      backoffMs: 1,
      sleep: async () => undefined,
    })
    expect(calls).to.equal(3)
    expect(res?.data).to.deep.equal({ status: 'FILLED' })
  })

  it('still floors the budget at one attempt', async () => {
    let spent: number | undefined
    let calls = 0
    await reconcileLookup(
      async () => {
        calls++
        return notok('Order not found in open orders')
      },
      {
        attempts: 0,
        backoffMs: 1,
        sleep: async () => undefined,
        onAttempts: (n) => (spent = n),
      },
    )
    expect(calls).to.equal(1)
    expect(spent).to.equal(1)
  })
})

describe('reconcileUnresolvedWarn (spec 012 §5.4)', () => {
  it('names the spend and the budget separately', () => {
    // The prod line that caused the misreading: 39 orders, one attempt each.
    const ids = Array.from({ length: 39 }, (_, i) => `GRID-RO-${i}`)
    const msg = reconcileUnresolvedWarn(ids, 39, 3)
    expect(msg).to.contain('could not read 39 order(s)')
    expect(msg).to.contain('after 39 lookup attempt(s)')
    expect(msg).to.contain('budget 3/order')
    // The defect verbatim: the budget must never stand in for the spend.
    expect(msg).to.not.match(/after 3 attempts/)
  })

  it('shows a ladder that really ran as a larger number', () => {
    expect(reconcileUnresolvedWarn(['a', 'b'], 6, 3)).to.contain(
      'after 6 lookup attempt(s)',
    )
  })

  it('truncates past ten ids, as both call sites did', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `o${i}`)
    const msg = reconcileUnresolvedWarn(ids, 12, 3)
    expect(msg).to.contain('o9')
    expect(msg).to.not.contain('o10')
    expect(msg.endsWith(' …')).to.be.true
  })

  it('does not truncate at exactly ten', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `o${i}`)
    expect(reconcileUnresolvedWarn(ids, 10, 3).endsWith('…')).to.be.false
  })
})
