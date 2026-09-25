/**
 * Spec 107 — the restart reconcile never rests more safety orders than the
 * rebuilt ladder holds. Unit tests for `capLadderPlacements`; the end-to-end
 * case through `checkOrders` is in `dcaReloadLadderDuplicate.spec.ts`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { OrderSideEnum, TypeOrderEnum } from '../../types'
import { capLadderPlacements } from './ladderPlacementCap'

const grid = (
  price: number,
  side = OrderSideEnum.buy,
  type = TypeOrderEnum.dealRegular,
) => ({ price, qty: 1, side, type }) as any
const rest = (
  price: number,
  side = 'BUY',
  typeOrder = TypeOrderEnum.dealRegular,
) => ({
  price: `${price}`,
  side,
  typeOrder,
})

describe('capLadderPlacements (spec 107)', () => {
  it('§4.1 places everything when resting + new fits the ladder', () => {
    const ladder = [grid(100), grid(90), grid(80)]
    const { place, dropped } = capLadderPlacements(
      ladder,
      [rest(100)],
      [grid(90), grid(80)],
    )
    expect(place.map((g) => g.price)).to.deep.equal([90, 80])
    expect(dropped).to.deep.equal([])
  })

  it('§4.2 drops the excess closest to a resting order', () => {
    // Ladder shifted a tick; 80 is really missing.
    const ladder = [grid(100.1), grid(90.1), grid(80.1)]
    const { place, dropped } = capLadderPlacements(
      ladder,
      [rest(100), rest(90)],
      [grid(100.1), grid(90.1), grid(80.1)],
    )
    expect(place.map((g) => g.price)).to.deep.equal([80.1])
    expect(dropped.map((g) => g.price).sort()).to.deep.equal([100.1, 90.1])
  })

  it('§4.3 places nothing when the ladder is already fully resting', () => {
    const { place } = capLadderPlacements(
      [grid(100.1), grid(90.1)],
      [rest(100), rest(90)],
      [grid(100.1), grid(90.1)],
    )
    expect(place).to.deep.equal([])
  })

  it('§4.4 counts per side', () => {
    const ladder = [grid(100), grid(110, OrderSideEnum.sell)]
    const { place } = capLadderPlacements(
      ladder,
      [rest(100)],
      [grid(110, OrderSideEnum.sell)],
    )
    expect(place.map((g) => g.price)).to.deep.equal([110])
  })

  it('§4.5 leaves other order types alone', () => {
    const tp = grid(120, OrderSideEnum.sell, TypeOrderEnum.dealTP)
    const minigrid = grid(95, OrderSideEnum.buy, TypeOrderEnum.dealGrid)
    const { place } = capLadderPlacements(
      [grid(100)],
      [rest(100), rest(95, 'BUY', TypeOrderEnum.dealGrid)],
      [tp, minigrid],
    )
    expect(place).to.deep.equal([tp, minigrid])
  })
})
