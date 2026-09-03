process.env.NODE_ENV = 'testing'

/**
 * Regression tests for how a deal's ending is reported.
 *
 * Replays the deal that produced the bug: a DCA short on Kraken linear futures,
 * deal cancelled while still holding 125 of the base asset, zero realized
 * profit. The event log said `Deal closed, id: …, profit: 0$`. The position was
 * still on the venue with no TP and no SL; it went unwatched for three days and
 * the venue liquidated into it.
 *
 * The defect was a sentence, so a sentence is what these pin. In particular the
 * `leave`-path message must keep the phrase "was left open on the exchange" —
 * `errorDict` maps exactly that substring to the `Position left open` subType,
 * and rewording it without updating the dict silently reclassifies the message.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  dealCloseEventDescription,
  dealLeftOpenSize,
  leftOpenPositionMessage,
  type DealOutcome,
} from './dealOutcome'
import { errorDict, getErrorSubType, positionLeftOpen } from '../utils'
import { DCADealStatusEnum } from '../../../types'

// The abandoned deal, as recorded: 125 short, nothing realized.
const abandoned: DealOutcome = {
  _id: '000000000000000000000001',
  status: DCADealStatusEnum.canceled,
  size: 125,
  profit: { totalUsd: 0 },
  symbol: { symbol: 'XRP-USD', baseAsset: 'XRP' },
}

describe('dealOutcome', () => {
  describe('dealLeftOpenSize — only a real, positive size is a position', () => {
    it('a held position reports its size', () => {
      expect(dealLeftOpenSize(125)).to.equal(125)
    })
    it('a short recorded negative still counts', () => {
      expect(dealLeftOpenSize(-125)).to.equal(125)
    })
    it('an empty deal holds nothing', () => {
      expect(dealLeftOpenSize(0)).to.equal(0)
    })
    it('an absent size holds nothing', () => {
      expect(dealLeftOpenSize(undefined)).to.equal(0)
    })
    it('NaN holds nothing', () => {
      expect(dealLeftOpenSize(NaN)).to.equal(0)
    })
  })

  describe('the event text', () => {
    // The regression itself: this exact deal must no longer say "Deal closed".
    const abandonedText = dealCloseEventDescription(abandoned)
    it('an abandoned deal is not reported as closed', () => {
      expect(abandonedText.indexOf('Deal closed') === -1).to.equal(true)
    })
    it('an abandoned deal names size, asset and consequence', () => {
      expect(abandonedText).to.equal(
        'Deal cancelled, id: 000000000000000000000001, position left open on the exchange: 125 XRP. This bot no longer manages it - no take profit and no stop loss will be applied. Close it on the exchange if you do not want to keep it.',
      )
    })

    // A cancel that left nothing behind is not a warning — say the plain thing.
    it('a cancelled deal holding nothing stays terse', () => {
      expect(dealCloseEventDescription({ ...abandoned, size: 0 })).to.equal(
        'Deal cancelled, id: 000000000000000000000001',
      )
    })

    // A genuinely closed deal is untouched, including one that closed at a loss.
    it('a closed deal still reports profit', () => {
      expect(
        dealCloseEventDescription({
          ...abandoned,
          status: DCADealStatusEnum.closed,
          profit: { totalUsd: 12.5 },
        }),
      ).to.equal('Deal closed, id: 000000000000000000000001, profit: 12.5$')
    })
    it('a closed deal that still shows size is not treated as abandoned', () => {
      expect(
        dealCloseEventDescription({
          ...abandoned,
          status: DCADealStatusEnum.closed,
          profit: { totalUsd: -9.99 },
        }),
      ).to.equal('Deal closed, id: 000000000000000000000001, profit: -9.99$')
    })
  })

  describe('the leave-path message and its classification', () => {
    const leaveText = leftOpenPositionMessage(abandoned)
    it('the leave message carries the phrase errorDict keys on', () => {
      expect(leaveText.indexOf('was left open on the exchange') !== -1).to.equal(
        true,
      )
    })
    it('the leave message names the pair', () => {
      expect(leaveText.indexOf('on XRP-USD') !== -1).to.equal(true)
    })
    it('the phrase is still the errorDict key', () => {
      expect(
        errorDict['was left open on the exchange' as keyof typeof errorDict],
      ).to.equal(positionLeftOpen)
    })
    // The end-to-end guarantee: this message classifies as its own subType and is
    // never mistaken for one of the real error families.
    it('the leave message classifies as Position left open', () => {
      expect(getErrorSubType(leaveText)).to.equal(positionLeftOpen)
    })
  })
})
