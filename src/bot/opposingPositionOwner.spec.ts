process.env.NODE_ENV = 'testing'

/**
 * Spec 078 — a start refused for an opposing position must say WHO holds it,
 * and must only wait when waiting can change the answer.
 *
 * Run: `npm test` (mocha) from `core/`.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  OPPOSING_POSITION_PARK,
  OPPOSING_POSITION_SETTLE,
  opposingPositionRefusal,
  settleWindowFor,
  type OpposingHolder,
} from './opposingPositionOwner'

const SYMBOL = 'HYPE-USDC'
const running: OpposingHolder = {
  dealId: 'deal-1',
  botId: 'bot-1',
  botName: 'HYPE Short',
  botStopped: false,
}
const stopped: OpposingHolder = { ...running, botStopped: true }

const refusal = (holder: OpposingHolder) =>
  opposingPositionRefusal({
    side: 'SHORT',
    requiredSide: 'LONG',
    symbol: SYMBOL,
    holder,
  })

describe('spec 078 — opposing position owner', () => {
  describe('settleWindowFor', () => {
    it('waits the base window only when a RUNNING bot holds the position', () => {
      // Nothing is unwinding it, so a longer wait buys the same refusal later.
      expect(settleWindowFor(running)).to.deep.equal(OPPOSING_POSITION_SETTLE)
    })

    it('parks for the longer window when the holding bot is stopped', () => {
      const w = settleWindowFor(stopped)
      expect(w.attempts).to.equal(
        OPPOSING_POSITION_SETTLE.attempts + OPPOSING_POSITION_PARK.attempts,
      )
      expect(w.intervalMs).to.equal(OPPOSING_POSITION_PARK.intervalMs)
    })

    it('parks when no deal holds the position (close in flight, or leftover)', () => {
      expect(settleWindowFor(null).attempts).to.be.greaterThan(
        OPPOSING_POSITION_SETTLE.attempts,
      )
    })

    it('parks for at least a minute in total', () => {
      const w = settleWindowFor(null)
      expect(w.attempts * w.intervalMs).to.be.at.least(60_000)
    })
  })

  describe('opposingPositionRefusal', () => {
    it('keeps the original first sentence verbatim in every shape', () => {
      // The v2 terminal-deal API answers with this same sentence and the
      // bot-error rules classify on it.
      const first =
        'Cannot start when existing position not met bot settings. ' +
        'Side in active position is SHORT, but bot will open LONG. ' +
        `Symbol: ${SYMBOL}`
      for (const holder of [running, stopped, null]) {
        expect(refusal(holder)).to.have.string(first)
      }
    })

    it('names the holding bot and says it is still running', () => {
      const msg = refusal(running)
      expect(msg).to.have.string('"HYPE Short"')
      expect(msg).to.have.string('still running')
    })

    it('explains that a stopped bot can still hold its position', () => {
      const msg = refusal(stopped)
      expect(msg).to.have.string('"HYPE Short"')
      expect(msg).to.have.string('leave position open')
    })

    it('says the position is nobody’s when no deal holds it', () => {
      const msg = refusal(null)
      expect(msg).to.have.string('No open deal on this account')
      expect(msg).to.have.string('flatten it on the exchange')
    })

    it('omits the quotes when the holding bot has no name', () => {
      const msg = opposingPositionRefusal({
        side: 'LONG',
        requiredSide: 'SHORT',
        symbol: SYMBOL,
        holder: { dealId: 'd', botId: 'b', botStopped: false },
      })
      expect(msg).to.not.have.string('""')
      expect(msg).to.have.string('still running')
    })
  })
})
