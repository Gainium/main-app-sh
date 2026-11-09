import { describe, it } from 'mocha'
import { expect } from 'chai'
import { TypeOrderEnum } from '../../../types'
import { missedLadderLevels, resolveLadderLevels } from './missedLevels'

/** A long ladder 100, 99, …, one level per point. */
const ladder = (n: number, start = 99, step = 1) =>
  Array.from({ length: n }, (_, i) => ({
    levelNumber: i + 1,
    price: start - i * step,
    qty: 1,
    side: 'BUY',
    type: TypeOrderEnum.dealRegular,
  }))

const row = (origPrice: number, over: any = {}) => ({
  typeOrder: TypeOrderEnum.dealRegular,
  status: 'FILLED',
  side: 'BUY',
  origPrice: `${origPrice}`,
  orderId: 'venue',
  ...over,
})

const levels = (m: { level: number }[]) => m.map((x) => x.level)

describe('spec 233: missedLadderLevels', () => {
  it('a ladder filled in order skips nothing', () => {
    expect(
      missedLadderLevels(ladder(5), [row(99), row(98)], 98, true),
    ).to.deep.equal([])
  })

  it('names the levels between a fill and a deeper one', () => {
    // 1 and 2 filled, 3 moved to the market at 94.5, then 6 filled at its price.
    const l = ladder(8)
    l[2].price = 94.5
    const m = missedLadderLevels(
      l,
      [row(99), row(98), row(94.5), row(94)],
      94,
      true,
    )
    expect(levels(m)).to.deep.equal([4, 5])
  })

  it('identifies a fill by its stamp before its price', () => {
    const m = missedLadderLevels(
      ladder(4),
      [row(99), row(97, { ladderLevel: 3 })],
      97,
      true,
    )
    expect(levels(m)).to.deep.equal([2])
  })

  it('matches a fill sent at a breakpoint price to the moved level', () => {
    // Level 3 (97) moved to 95.5: its order carried 97, it filled at 95.5.
    const l = ladder(5)
    l[2].price = 95.5
    const r = resolveLadderLevels(
      l,
      [row(99), row(98), row(97)],
      [{ price: 97, displacedPrice: 95.5 }],
    )
    expect([...r.filled].sort()).to.deep.equal([1, 2, 3])
  })

  it('tolerates a price-precision change since the order was sent', () => {
    const l = ladder(2, 0.01765, 0.000396)
    // Level 2 is now 0.017254; its order was sent at 0.01725.
    expect(
      levels(missedLadderLevels(l, [row(0.01725)], 0.01725, true)),
    ).to.deep.equal([1])
  })

  it('books an unmatched fill on the shallowest free level (the count rule)', () => {
    const m = missedLadderLevels(ladder(4), [row(50)], 50, true)
    expect(levels(m)).to.deep.equal([2, 3, 4])
  })

  it('a resting order is not skipped; a write-off placeholder does not rest', () => {
    const rows = [
      row(99),
      row(97, { status: 'NEW' }),
      row(96, { status: 'NEW', orderId: '-1' }),
    ]
    const m = missedLadderLevels(ladder(4), rows, 95, true)
    expect(levels(m)).to.deep.equal([2, 4])
  })

  it('ignores add-funds rows', () => {
    const m = missedLadderLevels(
      ladder(3),
      [row(99), row(90, { addFundsId: 'x' })],
      99,
      true,
    )
    expect(levels(m)).to.deep.equal([])
  })

  it('keeps a recorded level until it fills, wherever the last fill is', () => {
    const prev = [{ level: 2, price: 98, qty: 1 }]
    expect(
      levels(missedLadderLevels(ladder(4), [row(99)], 99.5, true, prev)),
    ).to.deep.equal([2])
    expect(
      levels(
        missedLadderLevels(
          ladder(4),
          [row(99), row(98, { ladderLevel: 2 })],
          98,
          true,
          prev,
        ),
      ),
    ).to.deep.equal([])
  })

  it('works for a short ladder', () => {
    const l = ladder(4, 101, -1).map((x) => ({ ...x, side: 'SELL' }))
    const m = missedLadderLevels(
      l,
      [row(101, { side: 'SELL' }), row(104, { side: 'SELL' })],
      104,
      false,
    )
    expect(levels(m)).to.deep.equal([2, 3])
  })
})
