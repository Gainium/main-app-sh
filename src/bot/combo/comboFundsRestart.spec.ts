process.env.NODE_ENV = 'testing'

/**
 * Main-app spec 047 §2.3.7: which copy of a Combo deal a cold restart loads,
 * and which funds changes it finishes. The engine path is covered in
 * `comboDealFunds.harness.spec.ts`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  comboFundsRestartFilter,
  comboFundsSnapshotStale,
  settledPendingFundsOrders,
} from './comboFundsRestart'

const scale = (...ids: string[]) => ids.map((id) => ({ id, k: 1.5, time: 1 }))

describe('combo funds restart (spec 047 §2.3.7)', () => {
  describe('comboFundsSnapshotStale', () => {
    it('keeps a snapshot that holds every change of the stored deal', () => {
      expect(
        comboFundsSnapshotStale(
          { fundsScale: scale('a', 'b') },
          { fundsScale: scale('a', 'b') },
        ),
      ).to.equal(null)
      expect(comboFundsSnapshotStale({}, {})).to.equal(null)
    })

    it('loads the stored deal while a change is marked unfinished', () => {
      expect(
        comboFundsSnapshotStale(
          { fundsScale: scale('a') },
          { fundsScale: scale('a'), comboFundsRebuild: 'a' },
        ),
      ).to.contain('a not finished')
    })

    it('loads the stored deal when it holds a change the snapshot lacks', () => {
      expect(
        comboFundsSnapshotStale(
          { fundsScale: scale('a') },
          { fundsScale: scale('a', 'b'), comboFundsRebuild: null },
        ),
      ).to.contain('b booked after the snapshot')
    })

    it('loads the stored deal while an order is in flight', () => {
      expect(
        comboFundsSnapshotStale(
          { pendingReduceFunds: [{ id: 'r' }] },
          { pendingReduceFunds: [{ id: 'r' }] },
        ),
      ).to.contain('r in flight')
    })
  })

  it('comboFundsRestartFilter selects marked deals and deals with orders in flight', () => {
    expect(comboFundsRestartFilter()).to.deep.equal([
      { comboFundsRebuild: { $type: 'string' } },
      { 'pendingAddFunds.0': { $exists: true } },
      { 'pendingReduceFunds.0': { $exists: true } },
    ])
  })

  describe('settledPendingFundsOrders', () => {
    const row = (
      status: string,
      executedQty: string,
      ids: { addFundsId?: string; reduceFundsId?: string },
    ) => ({ status, executedQty, ...ids })

    it('books an order that filled before the stop, pending entry or marker', () => {
      const pending = row('FILLED', '2', { addFundsId: 'p' })
      const marked = row('FILLED', '1', { reduceFundsId: 'm' })
      const r = settledPendingFundsOrders(
        { pendingAddFunds: [{ id: 'p' }], comboFundsRebuild: 'm' },
        [pending, marked],
      )
      expect(r.book).to.deep.equal([pending, marked])
      expect(r.drop).to.deep.equal([])
      expect(r.open).to.equal(false)
    })

    it('books the executed part of a cancelled order, drops one that executed nothing', () => {
      const part = row('CANCELED', '0.5', { addFundsId: 'p' })
      const none = row('EXPIRED', '0', { reduceFundsId: 'q' })
      const r = settledPendingFundsOrders(
        { pendingAddFunds: [{ id: 'p' }], pendingReduceFunds: [{ id: 'q' }] },
        [part, none],
      )
      expect(r.book).to.deep.equal([part])
      expect(r.drop).to.deep.equal([none])
    })

    it('leaves a booked change and an open order alone', () => {
      const r = settledPendingFundsOrders(
        {
          fundsScale: scale('b'),
          comboFundsRebuild: 'm',
          pendingAddFunds: [{ id: 'm' }],
        },
        [
          row('FILLED', '1', { addFundsId: 'b' }),
          row('NEW', '0', { addFundsId: 'm' }),
        ],
      )
      expect(r.book).to.deep.equal([])
      expect(r.drop).to.deep.equal([])
      expect(r.open).to.equal(true)
    })

    it('a marked change with no order at all is neither booked nor dropped', () => {
      const r = settledPendingFundsOrders({ comboFundsRebuild: 'm' }, [])
      expect(r).to.deep.equal({ book: [], drop: [], open: false })
    })
  })
})
