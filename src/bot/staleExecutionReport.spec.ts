process.env.NODE_ENV = 'testing'

/**
 * Spec `090` §4.1 — the pure decision.
 *
 * The production sequence it is written from (Kraken spot, a DCA base entry,
 * 2026-09-20; identifiers dropped, this file is public):
 *
 *   PARTIALLY_FILLED  base 27.66356   updateTime 1789907750866
 *   NEW               base 0          updateTime 1789907750864   ← 2 ms older
 *   NEW               base 0          updateTime 1789907750864
 *
 * Run: `npm test` (mocha). No network / DB.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  executionReportRewindsOrder,
  executionReportUnfillsOrder,
} from './staleExecutionReport'

const FILLED_AT = 1789907750866
const ACK_AT = 1789907750864

const partFilled = { status: 'PARTIALLY_FILLED', updateTime: FILLED_AT }
const acknowledgement = { status: 'NEW', updateTime: ACK_AT }

describe('§4.1 a stale acknowledgement (spec 090)', () => {
  it('rewinds a part-filled row, so it is refused', () => {
    expect(executionReportRewindsOrder(partFilled, acknowledgement)).to.equal(
      true,
    )
  })

  it('is refused against every status a venue can have moved past', () => {
    for (const status of [
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELED',
      'EXPIRED',
    ]) {
      expect(
        executionReportRewindsOrder(
          { status, updateTime: FILLED_AT },
          {
            status: 'NEW',
            updateTime: ACK_AT,
          },
        ),
        status,
      ).to.equal(true)
    }
  })

  it('leaves the same acknowledgement alone when it is the newer report', () => {
    // The ordinary case: the ack arrives first, against a row that has only
    // ever been acknowledged, or against nothing dated at all.
    expect(
      executionReportRewindsOrder(
        { status: 'NEW', updateTime: ACK_AT },
        { status: 'NEW', updateTime: FILLED_AT },
      ),
    ).to.equal(false)
  })

  it('does not treat an equally dated report as a rewind', () => {
    // Several venues stamp every report of an order with the same order time.
    expect(
      executionReportRewindsOrder(partFilled, {
        status: 'NEW',
        updateTime: FILLED_AT,
      }),
    ).to.equal(false)
  })

  it('never refuses a report that moves the order forward', () => {
    for (const status of [
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELED',
      'EXPIRED',
    ]) {
      expect(
        executionReportRewindsOrder(partFilled, {
          status,
          updateTime: ACK_AT,
        }),
        status,
      ).to.equal(false)
    }
  })

  it('is disabled by a row or a report it cannot date', () => {
    // `updateTime: -1` is what a row written from a REST/cancel response
    // carries, and production holds them (specs 048 §4.1, 059).
    for (const updateTime of [-1, 0, null, undefined, NaN]) {
      expect(
        executionReportRewindsOrder(
          { ...partFilled, updateTime },
          acknowledgement,
        ),
        `held ${updateTime}`,
      ).to.equal(false)
      expect(
        executionReportRewindsOrder(partFilled, {
          ...acknowledgement,
          updateTime,
        }),
        `report ${updateTime}`,
      ).to.equal(false)
    }
  })

  it('answers false rather than throwing on a missing side', () => {
    expect(executionReportRewindsOrder(null, acknowledgement)).to.equal(false)
    expect(executionReportRewindsOrder(partFilled, undefined)).to.equal(false)
  })
})

describe('a part-fill report over a filled row (spec 114)', () => {
  // Kraken spot, a combo grid BUY, 2026-09-26: FILLED then PARTIALLY_FILLED
  // for the full quantity, both stamped 1790459402861.
  const AT = 1790459402861
  const filled = { status: 'FILLED', updateTime: AT }

  it('is refused whatever its timestamp says', () => {
    for (const status of ['NEW', 'PARTIALLY_FILLED']) {
      for (const updateTime of [AT - 1, AT, AT + 1, -1, undefined]) {
        expect(
          executionReportUnfillsOrder(filled, { status, updateTime }),
          `${status} @ ${updateTime}`,
        ).to.equal(true)
      }
    }
  })

  it('leaves terminal and repeated reports to their own paths', () => {
    for (const status of ['FILLED', 'CANCELED', 'EXPIRED']) {
      expect(
        executionReportUnfillsOrder(filled, { status, updateTime: AT }),
        status,
      ).to.equal(false)
    }
  })

  it('only guards a row held FILLED', () => {
    for (const status of ['NEW', 'PARTIALLY_FILLED', 'CANCELED', 'EXPIRED']) {
      expect(
        executionReportUnfillsOrder(
          { status, updateTime: AT },
          { status: 'PARTIALLY_FILLED', updateTime: AT },
        ),
        status,
      ).to.equal(false)
    }
  })

  it('answers false rather than throwing on a missing side', () => {
    expect(executionReportUnfillsOrder(null, filled)).to.equal(false)
    expect(executionReportUnfillsOrder(filled, undefined)).to.equal(false)
  })
})
