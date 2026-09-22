process.env.NODE_ENV = 'testing'

/**
 * Spec 079 — booking a reduce-funds fill must not leave the same quantity in
 * both `deal.size` and `deal.reduceFunds`.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { bookReduceFundsFill, grossEntryOf } from './reduceFundsFill'
import { grossEntryVolume, resolveBaseOrderQty } from './baseOrderQty'

/** The live case: entered 60.3 short, withdrew 25.63, no safety fills. */
const ENTERED = 60.3
const WITHDRAWN = 25.63

describe('spec 079 — booking a reduce-funds fill', () => {
  it('takes the withdrawal out of size as it goes into reduceFunds', () => {
    const booked = bookReduceFundsFill(
      { size: -ENTERED, reduceFunds: [] },
      { price: 87.693, qty: WITHDRAWN },
    )
    expect(Math.abs(booked.size)).to.be.closeTo(ENTERED - WITHDRAWN, 1e-9)
    expect(booked.reduceFunds).to.have.length(1)
  })

  it('keeps the gross entry volume unchanged across the booking', () => {
    const before = { size: -ENTERED, reduceFunds: [] }
    const after = bookReduceFundsFill(before, { price: 87.693, qty: WITHDRAWN })
    expect(grossEntryOf(after)).to.be.closeTo(grossEntryOf(before), 1e-9)
    expect(grossEntryOf(after)).to.be.closeTo(ENTERED, 1e-9)
  })

  it('preserves the sign of a short position', () => {
    const booked = bookReduceFundsFill({ size: -ENTERED }, { price: 1, qty: 1 })
    expect(booked.size).to.be.lessThan(0)
  })

  it('never takes the magnitude past zero', () => {
    // A withdrawal bigger than the recorded position means the position was
    // already stale; flipping the sign would turn a short into a long.
    const booked = bookReduceFundsFill(
      { size: -10, reduceFunds: [] },
      { price: 1, qty: 25 },
    )
    expect(booked.size).to.equal(-0)
    expect(Math.abs(booked.size)).to.equal(0)
  })

  it('ignores a fill with no usable quantity but still records it', () => {
    const booked = bookReduceFundsFill(
      { size: -ENTERED, reduceFunds: [] },
      { price: 1, qty: Number.NaN },
    )
    expect(booked.size).to.equal(-ENTERED)
    expect(booked.reduceFunds).to.have.length(1)
  })

  it('stops the take-profit being sized for the pre-withdrawal position', () => {
    // What the TP sizer does with the deal's books, before and after booking.
    const sized = (deal: { size: number; reduceFunds: { qty: number }[] }) => {
      const dealSize = Math.abs(deal.size)
      const reduceFundsBase = deal.reduceFunds.reduce((a, v) => a + v.qty, 0)
      return resolveBaseOrderQty({
        boFromOrder: ENTERED, // the base order row, still on record
        filledQty: 0, // no safety order ever filled
        dealSize,
        grossEntry: grossEntryVolume(dealSize, reduceFundsBase),
      })
    }

    // The window this spec closes: reduceFunds appended, size not yet net.
    const stale = sized({
      size: -ENTERED,
      reduceFunds: [{ qty: WITHDRAWN }],
    })
    expect(stale.qty).to.be.closeTo(ENTERED + WITHDRAWN, 1e-9)
    expect(stale.source).to.equal('position')

    // Booked as one move, the sizer sees the position that is really held.
    const booked = bookReduceFundsFill(
      { size: -ENTERED, reduceFunds: [] },
      { price: 87.693, qty: WITHDRAWN },
    )
    const fresh = sized({
      size: booked.size,
      reduceFunds: booked.reduceFunds,
    })
    expect(fresh.qty).to.be.closeTo(ENTERED, 1e-9)
    expect(fresh.source).to.equal('order')
  })
})
