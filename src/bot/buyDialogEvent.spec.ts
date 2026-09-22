process.env.NODE_ENV = 'testing'

/**
 * Spec 081 — a status change must not be logged as a manual buy.
 *
 * The `Buy dialog` event (rendered "Manual buy") is written at the tail of
 * `changeStatus`. It may only be written for the one branch that actually
 * forwards the chosen mode to a worker: a grid bot moving to `open`.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { BotStatusEnum, BotType, BuyTypeEnum } from '../../types'
import { buyDialogEventsFor, isManualBuyStatusChange } from './buyDialogEvent'

const OTHER_STATUSES = [
  BotStatusEnum.closed,
  BotStatusEnum.error,
  BotStatusEnum.archive,
  BotStatusEnum.range,
  BotStatusEnum.monitoring,
]

const OTHER_TYPES = [
  BotType.dca,
  BotType.combo,
  BotType.hedgeCombo,
  BotType.hedgeDca,
]

describe('spec 081 — a status change is logged as a manual buy', () => {
  it('§5.1 records a grid start — the one branch that applies the mode', () => {
    expect(isManualBuyStatusChange(BotType.grid, BotStatusEnum.open)).to.equal(
      true,
    )
  })

  it('§5.2 records nothing when a grid bot is stopped', () => {
    // The grid `closed` branch hard-codes buyType/buyCount/buyAmount to
    // `undefined`, so the mode the caller sent was discarded. This is the
    // reported symptom: a "Manual buy / Buy type: all" row on a plain Stop.
    expect(
      isManualBuyStatusChange(BotType.grid, BotStatusEnum.closed),
    ).to.equal(false)
  })

  it('§5.2 records nothing for any other grid target status', () => {
    for (const status of OTHER_STATUSES) {
      expect(
        isManualBuyStatusChange(BotType.grid, status),
        `grid -> ${status}`,
      ).to.equal(false)
    }
  })

  it('§5.3 records nothing for a non-grid bot, at any status', () => {
    // No non-grid branch of `changeStatus` posts the buy mode to its worker,
    // so the entry can never be true for them.
    for (const type of OTHER_TYPES) {
      for (const status of [BotStatusEnum.open, ...OTHER_STATUSES]) {
        expect(
          isManualBuyStatusChange(type, status),
          `${type} -> ${status}`,
        ).to.equal(false)
      }
    }
  })

  describe('the rows a request leaves behind', () => {
    const request = (type: BotType, status: BotStatusEnum) =>
      buyDialogEventsFor({
        userId: 'user-1',
        botId: 'bot-1',
        type,
        status,
        buyType: BuyTypeEnum.all,
        buyCount: '3',
        paperContext: false,
      })

    it('§5.1 writes both rows on a grid start, count before type', () => {
      const rows = request(BotType.grid, BotStatusEnum.open)
      expect(rows.map((r) => r.description)).to.deep.equal([
        'Buy count: 3',
        'Buy type: all',
      ])
      expect(rows[0]).to.include({
        userId: 'user-1',
        botId: 'bot-1',
        botType: BotType.grid,
        event: 'Buy dialog',
        paperContext: false,
      })
    })

    it('§4.1 writes NEITHER row when a grid bot is stopped', () => {
      // The reported symptom. Both writes had the same unguarded shape, so a
      // guard on only one of them would have left "Buy count: N" behind.
      expect(request(BotType.grid, BotStatusEnum.closed)).to.deep.equal([])
    })

    it('§5.3 writes nothing for a combo bot that is started', () => {
      expect(request(BotType.combo, BotStatusEnum.open)).to.deep.equal([])
    })

    it('§5.4 writes nothing when the request carries no buy input', () => {
      expect(
        buyDialogEventsFor({
          userId: 'user-1',
          botId: 'bot-1',
          type: BotType.grid,
          status: BotStatusEnum.open,
          paperContext: false,
        }),
      ).to.deep.equal([])
    })

    it('§5.5 the two writes can never disagree about origin', () => {
      // One predicate, one producer — asking for either row asks once.
      for (const status of OTHER_STATUSES) {
        expect(
          request(BotType.grid, status),
          `grid -> ${status}`,
        ).to.have.length(0)
      }
    })
  })
})
