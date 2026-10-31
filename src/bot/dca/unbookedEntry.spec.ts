process.env.NODE_ENV = 'testing'

/**
 * A deal cancelled while still in `start` must report what its base order
 * already executed on the venue.
 *
 * Replays a Kraken linear-futures DCA deal: the base order executed in full on
 * the venue, but the fill never reached the books, so the deal stayed in
 * `start` with size 0. Stopping the bot with `leave` cancelled it and the log
 * said only `Deal cancelled, id: …` — no warning that a position was left with
 * no take profit and no stop loss.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { dealCloseEventDescription, unbookedEntryQty } from './dealOutcome'
import { writeOffStatus } from '../main'
import { DCADealStatusEnum } from '../../../types'

const row = (over: Record<string, unknown> = {}) => ({
  typeOrder: 'dealStart',
  orderId: 'a31b34b5-1bfe-4d73-9797-176b6c4b5c67',
  executedQty: '0.1264',
  ...over,
})

describe('unbookedEntryQty', () => {
  it('counts an executed base order the books never took in', () => {
    expect(unbookedEntryQty(0, [row()])).to.equal(0.1264)
  })
  it('sums replaced base orders that each executed', () => {
    expect(
      unbookedEntryQty(0, [
        row({ executedQty: '0.0042' }),
        row({ orderId: 'b2', executedQty: '0.1320' }),
      ]),
    ).to.equal(0.1362)
  })
  it('ignores rows the venue never acknowledged', () => {
    expect(unbookedEntryQty(0, [row({ orderId: '-1' })])).to.equal(0)
  })
  it('ignores non-entry orders', () => {
    expect(unbookedEntryQty(0, [row({ typeOrder: 'dealTP' })])).to.equal(0)
  })
  it('defers to the books once a level is booked', () => {
    expect(unbookedEntryQty(1, [row()])).to.equal(0)
  })
  it('turns the cancel event into a left-open warning', () => {
    const text = dealCloseEventDescription({
      _id: '000000000000000000000002',
      status: DCADealStatusEnum.canceled,
      size: unbookedEntryQty(0, [row()]),
      profit: { totalUsd: 0 },
      symbol: { symbol: 'BTC-USD', baseAsset: 'BTC' },
    })
    expect(text).to.contain('position left open on the exchange: 0.1264 BTC')
  })
})

describe('writeOffStatus', () => {
  it('a fully executed, acknowledged order is written off as FILLED', () => {
    expect(
      writeOffStatus({
        status: 'PARTIALLY_FILLED',
        orderId: 'a31b34b5',
        executedQty: '0.1264',
        origQty: '0.1264',
      }),
    ).to.equal('FILLED')
  })
  it('never downgrades a FILLED row', () => {
    expect(writeOffStatus({ status: 'FILLED', orderId: '-1' })).to.equal(
      'FILLED',
    )
  })
  it('a part-filled order is still written off as CANCELED', () => {
    expect(
      writeOffStatus({
        status: 'PARTIALLY_FILLED',
        orderId: 'a31b327f',
        executedQty: '0.0042',
        origQty: '0.1362',
      }),
    ).to.equal('CANCELED')
  })
  it('an unacknowledged row is CANCELED whatever it carries', () => {
    expect(
      writeOffStatus({
        status: 'NEW',
        orderId: '-1',
        executedQty: '1.836',
        origQty: '1.836',
      }),
    ).to.equal('CANCELED')
  })
})
