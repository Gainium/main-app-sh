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
import {
  isAddFundsOrder,
  isLadderOrder,
  nextLadderLevel,
  remainingLadderLevels,
} from './ladderLevels'
import { TypeOrderEnum } from '../../../types'
import utils from '../../utils'

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

  // §6 — the seam a "replace the next available DCA level" opt-in needs. The
  // flag decides in BOTH directions, and nothing sets it today, so every case
  // above is what the engine actually does right now.
  describe('consumesLadderLevel overrides the default — §6', () => {
    it('an addition flagged as consuming a level IS one', () => {
      expect(
        isLadderOrder({ ...addFundsOrder, consumesLadderLevel: true }),
      ).to.equal(true)
    })

    it('and a safety order flagged as not consuming one is NOT', () => {
      expect(
        isLadderOrder({ ...safetyOrder, consumesLadderLevel: false }),
      ).to.equal(false)
    })

    it('the flag cannot promote a row that is not dealRegular at all', () => {
      // A take profit is not a ladder level whatever it claims: the ladder is
      // built from `dealRegular` rows and nothing else is a candidate.
      expect(
        isLadderOrder({
          typeOrder: TypeOrderEnum.dealTP,
          consumesLadderLevel: true,
        }),
      ).to.equal(false)
      expect(
        isLadderOrder({
          typeOrder: TypeOrderEnum.dealStart,
          consumesLadderLevel: true,
        }),
      ).to.equal(false)
    })

    it('executeNextDcaLevel keeps counting: neither field set', () => {
      // It deliberately sets no `addFundsId` and keeps the `D-RO` prefix so its
      // early fill spends the slot. That must survive the seam.
      expect(isLadderOrder({ typeOrder: TypeOrderEnum.dealRegular })).to.equal(
        true,
      )
    })
  })

  // Spec `033` — `updateDeal` routes on this, and used to route on the client
  // order id, which on OKX cannot answer the question at all.
  describe('isAddFundsOrder — spec 033', () => {
    it('§4.3 an addition is one', () => {
      expect(isAddFundsOrder(addFundsOrder)).to.equal(true)
    })

    it('§4.2 an ordinary safety order is not', () => {
      expect(isAddFundsOrder(safetyOrder)).to.equal(false)
    })

    it('§4.2 nor is a Grid-synthesised order, which has no such field', () => {
      // `checkDCALevel` builds one of these from `deal.currentOrders`; a Grid
      // is a ladder or take-profit row and never an addition.
      expect(
        isAddFundsOrder({ typeOrder: TypeOrderEnum.dealRegular }),
      ).to.equal(false)
    })

    it('§4.1 the two answers are complementary for a dealRegular row', () => {
      for (const o of [safetyOrder, addFundsOrder]) {
        expect(isLadderOrder(o)).to.equal(!isAddFundsOrder(o))
      }
    })
  })

  /**
   * Spec `033` §2.1/§2.2. Drives the REAL `utils.id` through the REAL id shape
   * `getOrderId` produces for OKX, and pins both the defect's rate and the
   * fix's immunity. Not a statistical flake: the assertions are one-sided
   * bounds around a ~1.6% rate over 20k samples, and the fix's arm is exact.
   */
  describe('the OKX client order id cannot carry this distinction — spec 033', () => {
    const BROKER = 'GAINIU'
    const N = 20000
    /** `${broker}D-RO-${id(...)}` with every dash stripped, as OKX gets it. */
    const okxSafetyOrderId = () =>
      `${BROKER}D-RO-${utils.id(32 - BROKER.length - 5 - 1)}`.replace(/-/g, '')

    it('§2.1 the old substring test misreads roughly one in sixty', () => {
      let misread = 0
      for (let i = 0; i < N; i++) {
        if (okxSafetyOrderId().indexOf('ROA') !== -1) misread++
      }
      const rate = misread / N
      // ~1/62 by construction: the tail's first character decides it.
      expect(rate).to.be.greaterThan(0.008)
      expect(rate).to.be.lessThan(0.03)
    })

    it('§2.2 an anchored test is no better — same characters, same length', () => {
      let misread = 0
      for (let i = 0; i < N; i++) {
        const id = okxSafetyOrderId()
        const withoutBroker = id.startsWith(BROKER)
          ? id.slice(BROKER.length)
          : id
        if (withoutBroker.startsWith('DROA')) misread++
      }
      expect(misread / N).to.be.greaterThan(0.008)
    })

    it('§4.2 keying on addFundsId misreads none of them', () => {
      let misread = 0
      for (let i = 0; i < N; i++) {
        const order = {
          typeOrder: TypeOrderEnum.dealRegular,
          clientOrderId: okxSafetyOrderId(),
        }
        if (isAddFundsOrder(order)) misread++
      }
      expect(misread).to.equal(0)
    })

    it('§4.3 and still reads every addition as one, id notwithstanding', () => {
      for (let i = 0; i < N / 100; i++) {
        expect(
          isAddFundsOrder({
            typeOrder: TypeOrderEnum.dealRegular,
            clientOrderId: okxSafetyOrderId(),
            addFundsId: `ad1d4f0c-${i}`,
          }),
        ).to.equal(true)
      }
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

    it('§6 an addition that consumed a level is left in the count', () => {
      // The opt-in case: `levels.complete` 2, one addition, and that addition
      // took ladder level 1 — so the next level is 2, not 1.
      expect(
        nextLadderLevel({
          levels: { complete: 2 },
          funds: [{ price: 2480.02, qty: 0.004, consumesLadderLevel: true }],
        }),
      ).to.equal(2)
    })

    it('§6 a mixed deal subtracts only the additions outside the ladder', () => {
      expect(
        nextLadderLevel({
          levels: { complete: 4 },
          funds: [
            { price: 2480.02, qty: 0.004 },
            { price: 2470.0, qty: 0.004, consumesLadderLevel: true },
          ],
        }),
      ).to.equal(3)
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

  /**
   * Spec `034`. The numbers are the reproduction's: LINK/USDT,
   * `dcaCondition: indicators`, three `startDca` indicators, three additions of
   * 10 USDT and no safety order fired at any point.
   */
  describe('remainingLadderLevels — spec 034', () => {
    const LADDER = 3

    it('§4.4 an untouched deal has its whole ladder to place', () => {
      expect(
        remainingLadderLevels({ levels: { complete: 1 } }, LADDER),
      ).to.equal(3)
    })

    it('§4.2 three additions do not spend a single level of it', () => {
      // levels went 1/4 -> 2/4 -> 3/4 -> 4/4 across the three additions, and
      // `complete === all` at the end is what fired the cap. The ladder was
      // untouched the whole way.
      const funds = [] as { price: number; qty: number }[]
      for (let n = 1; n <= 3; n++) {
        funds.push({ price: 20, qty: 1 })
        expect(
          remainingLadderLevels({ levels: { complete: 1 + n }, funds }, LADDER),
          `after addition ${n}`,
        ).to.equal(3)
      }
    })

    it('§4.1 a consumed level does spend one, additions notwithstanding', () => {
      expect(
        remainingLadderLevels(
          {
            levels: { complete: 4 },
            funds: [
              { price: 20, qty: 1 },
              { price: 20, qty: 1 },
            ],
          },
          LADDER,
        ),
      ).to.equal(2)
    })

    it('§4.1 a spent ladder reports nothing left, and never less than that matters', () => {
      expect(
        remainingLadderLevels({ levels: { complete: 4 } }, LADDER),
      ).to.equal(0)
      // Past the end — `executeNextDcaLevel` and an indicator firing late can
      // both push `complete` beyond the configured size. Still <= 0.
      expect(
        remainingLadderLevels({ levels: { complete: 5 } }, LADDER),
      ).to.be.lessThan(0)
    })

    it('§4.3 a deal with DCA off has nothing to place from the start', () => {
      expect(remainingLadderLevels({ levels: { complete: 1 } }, 0)).to.equal(0)
    })

    it('§4.4 parity with the old test across a whole ladder, no additions', () => {
      // Old: `complete > 0 && complete === all`, with `all = ladderSize + 1`.
      // New: `remaining <= 0`. They must agree at every point.
      for (let complete = 1; complete <= LADDER + 1; complete++) {
        const deal = { levels: { complete } }
        const oldFires = complete > 0 && complete === LADDER + 1
        const newFires = remainingLadderLevels(deal, LADDER) <= 0
        expect(newFires, `complete ${complete}`).to.equal(oldFires)
      }
    })

    it('§6 an addition flagged as consuming a level does spend one', () => {
      expect(
        remainingLadderLevels(
          {
            levels: { complete: 2 },
            funds: [{ price: 20, qty: 1, consumesLadderLevel: true }],
          },
          LADDER,
        ),
      ).to.equal(2)
    })
  })
})
