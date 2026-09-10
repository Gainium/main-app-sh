process.env.NODE_ENV = 'testing'

/**
 * Spec `031` — an add-funds order is not a configured DCA level.
 *
 * The rows below are the reproduction's own, read back from the paper stack on
 * 2026-09-10 for deal `6aa24882fd81bdd118c8e91f` (ETH-USDT, `ordersCount: 4`,
 * `volumeScale: 2`): one filled base order, one filled add-funds order, one
 * safety order the defect cancelled, three still resting.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { isLadderOrder, nextLadderLevel } from './ladderLevels'
import { TypeOrderEnum } from '../../../types'

const baseOrder = {
  typeOrder: TypeOrderEnum.dealStart,
}
const safetyOrder = {
  typeOrder: TypeOrderEnum.dealRegular,
}
/** `D-ROA-sJLvFco…` — `dealRegular`, FILLED, tagged with its `addFundsId`. */
const addFundsOrder = {
  typeOrder: TypeOrderEnum.dealRegular,
  addFundsId: 'ad1d4f0c-cc15-42e9-8f30-a4603844d08e',
}
/** `reduceDealFunds` books a `dealTP` — it has never entered this count. */
const reduceFundsOrder = {
  typeOrder: TypeOrderEnum.dealTP,
  addFundsId: '0a5c1b2e-0000-4000-8000-000000000000',
}

describe('ladderLevels (spec 031)', () => {
  describe('isLadderOrder — §4.1 / §4.3', () => {
    it('§4.3 a safety order is a ladder level', () => {
      expect(isLadderOrder(safetyOrder)).to.equal(true)
    })

    it('§4.1 an add-funds order is NOT, though it is also dealRegular', () => {
      expect(isLadderOrder(addFundsOrder)).to.equal(false)
    })

    it('the base order is not a ladder level either', () => {
      expect(isLadderOrder(baseOrder)).to.equal(false)
    })

    it('a take profit is not, add-funds tagged or otherwise', () => {
      expect(isLadderOrder(reduceFundsOrder)).to.equal(false)
      expect(isLadderOrder({ typeOrder: TypeOrderEnum.dealTP })).to.equal(false)
    })

    it('an empty string addFundsId does not disqualify a real safety order', () => {
      // Defensive: a persisted `String` field can come back as ''. That is the
      // absence of an id, so the row is still a ladder level.
      expect(isLadderOrder({ ...safetyOrder, addFundsId: '' })).to.equal(true)
    })
  })

  describe('nextLadderLevel — §5.1', () => {
    it('a deal whose base order has filled is at safety level 1', () => {
      expect(nextLadderLevel({ levels: { complete: 1 } })).to.equal(1)
    })

    it('§5.2 one add-funds fill does not move it off level 1', () => {
      // The reproduction's state: `levels.complete` 2, one entry in `funds`,
      // and every configured safety order still unfilled.
      expect(
        nextLadderLevel({
          levels: { complete: 2 },
          funds: [{ price: 2480.02, qty: 0.004 }],
        }),
      ).to.equal(1)
    })

    it('two additions and one safety fill leaves level 2 next', () => {
      expect(
        nextLadderLevel({
          levels: { complete: 4 },
          funds: [
            { price: 2480.02, qty: 0.004 },
            { price: 2470.0, qty: 0.004 },
          ],
        }),
      ).to.equal(2)
    })

    it('a deal that has taken no add funds is unchanged by the correction', () => {
      expect(nextLadderLevel({ levels: { complete: 3 }, funds: [] })).to.equal(
        3,
      )
      expect(nextLadderLevel({ levels: { complete: 3 } })).to.equal(3)
      expect(
        nextLadderLevel({ levels: { complete: 3 }, funds: null }),
      ).to.equal(3)
    })
  })
})
