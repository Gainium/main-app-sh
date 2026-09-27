import { describe, it } from 'mocha'
import { expect } from 'chai'
import { OrderSideEnum, TypeOrderEnum, type Grid } from '../../../types'
import { levelOf, reanchorLevelAfterFill } from './reanchorAfterFill'

/** Spec `116` §4 — the pure rule; the engine path is in the whipsaw harness. */
const levels = [100, 102, 104, 106, 108, 110].map((buy, number) => ({
  number,
  price: { buy, sell: buy + 0.5 },
  type: TypeOrderEnum.regular,
}))
const B = OrderSideEnum.buy
const S = OrderSideEnum.sell
/** A rebuilt ladder with its empty level at `gap`. */
const ladder = (gap: number): Grid[] =>
  levels
    .filter((l) => l.number !== gap)
    .map(
      (l) =>
        ({
          number: l.number,
          side: l.number < gap ? B : S,
          price: l.number < gap ? l.price.buy : l.price.sell,
          qty: 1,
          newClientOrderId: `${l.number}`,
          type: TypeOrderEnum.dealGrid,
        }) as Grid,
    )

describe('reanchorLevelAfterFill (spec 116)', () => {
  it('§4.1 a buy fill: one later buy the rebuild would sell moves the empty level up one', () => {
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(2),
        levels,
        resting: [{ side: B, price: 106, placedAt: 2000 }],
        side: B,
        filledAt: 1000,
      }),
    ).to.equal(3)
  })

  it('§4.1 a sell fill: two later sells the rebuild would buy move it down two', () => {
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(4),
        levels,
        resting: [
          { side: S, price: 104.5, placedAt: 2000 },
          { side: S, price: 106.5, placedAt: 2001 },
        ],
        side: S,
        filledAt: 1000,
      }),
    ).to.equal(2)
  })

  it('§1.3.1 orders resting since before the fill are counted as filled, as today', () => {
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(2),
        levels,
        resting: [{ side: B, price: 104, placedAt: 1000 }],
        side: B,
        filledAt: 1000,
      }),
    ).to.equal(null)
  })

  it('a later order the rebuild keeps on its side changes nothing', () => {
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(2),
        levels,
        resting: [
          { side: B, price: 102, placedAt: 2000 },
          { side: S, price: 110.5, placedAt: 2000 },
        ],
        side: B,
        filledAt: 1000,
      }),
    ).to.equal(null)
  })

  it('§4.2 no placement time or no fill time: no re-anchor', () => {
    const resting = [{ side: B, price: 104 }]
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(2),
        levels,
        resting,
        side: B,
        filledAt: 1000,
      }),
    ).to.equal(null)
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(2),
        levels,
        resting: [{ side: B, price: 104, placedAt: 5 }],
        side: B,
        filledAt: 0,
      }),
    ).to.equal(null)
  })

  it('never empties a whole side of the ladder', () => {
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(4),
        levels,
        resting: [{ side: B, price: 110, placedAt: 2000 }],
        side: B,
        filledAt: 1000,
      }),
    ).to.equal(null)
  })

  it('no single empty level in the rebuild: no re-anchor', () => {
    expect(
      reanchorLevelAfterFill({
        rebuilt: ladder(2).slice(1),
        levels,
        resting: [{ side: B, price: 104, placedAt: 2000 }],
        side: B,
        filledAt: 1000,
      }),
    ).to.equal(null)
  })

  it('levelOf maps an order to the nearest level on its own side', () => {
    expect(levelOf(levels, B, 104.1)?.number).to.equal(2)
    expect(levelOf(levels, S, 104.4)?.number).to.equal(2)
  })
})
