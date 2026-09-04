process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the market take-profit close classifier.
 * Spec: `specs/004.tp-level-close-terminal-rejection.md` (issue #627).
 *
 * Replays the 2026-09-04 production loop: DCA bot `69de6e9e10716872ece23ce8`,
 * deal `69f1b27faeba7a4880365abb` (XAUTUSDT, open since April). Its take-profit
 * level was reached, the close was refused `Reduce order is rejected`, and
 * `checkTPLevel` re-armed on the next price tick — 1031 sends of one client
 * order id in ~2 h, 1046 `left nothing in flight (not placed)` lines, and not a
 * word to the user because the `Futures position` subType is `showUser: false`.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  classifyTpCloseAttempt,
  tpCloseBlockedMessage,
} from './tpCloseOutcome'
import { getErrorSubType } from '../utils'

// The engine's own classifier, so these tests break if `errorDict` stops
// mapping these strings to `Futures position`.
const subTypeOf = (reason: string) => getErrorSubType(reason)

describe('tpCloseOutcome', () => {
  describe('§1.1.1 the venue keeps its words', () => {
    it('a refusal reports the reason, not the `not placed` placeholder', () => {
      const d = classifyTpCloseAttempt(
        { kind: 'refused', reason: 'Reduce order is rejected' },
        subTypeOf,
      )
      expect(d.outcome).to.contain('Reduce order is rejected')
      expect(d.outcome).to.not.equal('not placed')
    })
    it('nothing sent is still `not placed` — there is no venue answer', () => {
      const d = classifyTpCloseAttempt({ kind: 'nothing' }, subTypeOf)
      expect(d.outcome).to.equal('not placed')
      expect(d.terminal).to.equal(false)
    })
  })

  describe('§1.1.2 terminal vs transient', () => {
    // Every `futuresPosition` string a reduce-only close can come back with,
    // taken from the production window (§2.3 of the spec).
    const terminal = [
      'Reduce order is rejected',
      'ReduceOnly Order is rejected.',
      'current position is zero, cannot fix reduce-only order qty',
      'ReduceOnly Order Failed. Please check your existing position and open orders.',
      'No open positions to close.',
    ]
    for (const reason of terminal) {
      it(`terminal: ${reason}`, () => {
        const d = classifyTpCloseAttempt({ kind: 'refused', reason }, subTypeOf)
        expect(d.terminal).to.equal(true)
        expect(d.inFlight).to.equal(false)
      })
    }

    // A refusal that says nothing about the position may well succeed on the
    // next tick — those keep the #617 immediate re-arm (§1.1.5).
    const transient = [
      'Timeout',
      'Order price is out of permissible range',
      'EService:Busy',
    ]
    for (const reason of transient) {
      it(`transient: ${reason}`, () => {
        const d = classifyTpCloseAttempt({ kind: 'refused', reason }, subTypeOf)
        expect(d.terminal).to.equal(false)
      })
    }
  })

  describe('§1.1.5 the outcomes #617 fixed must keep re-arming', () => {
    it('FILLED books the fill and holds the close in flight', () => {
      const d = classifyTpCloseAttempt(
        { kind: 'order', status: 'FILLED', alreadyProcessed: false },
        subTypeOf,
      )
      expect(d).to.deep.equal({
        inFlight: true,
        bookFill: true,
        outcome: 'FILLED',
        terminal: false,
      })
    })
    it('a re-echoed already-booked FILLED leaves nothing in flight', () => {
      const d = classifyTpCloseAttempt(
        { kind: 'order', status: 'FILLED', alreadyProcessed: true },
        subTypeOf,
      )
      expect(d.inFlight).to.equal(false)
      expect(d.bookFill).to.equal(false)
      expect(d.outcome).to.equal('already processed')
      expect(d.terminal).to.equal(false)
    })
    for (const status of ['NEW', 'PARTIALLY_FILLED']) {
      it(`${status} is in flight`, () => {
        const d = classifyTpCloseAttempt(
          { kind: 'order', status, alreadyProcessed: false },
          subTypeOf,
        )
        expect(d.inFlight).to.equal(true)
        expect(d.bookFill).to.equal(false)
      })
    }
    it('a dead status (CANCELED) leaves nothing in flight and re-arms', () => {
      const d = classifyTpCloseAttempt(
        { kind: 'order', status: 'CANCELED', alreadyProcessed: false },
        subTypeOf,
      )
      expect(d.inFlight).to.equal(false)
      expect(d.terminal).to.equal(false)
    })
  })

  describe('§1.1.4 the deal says why', () => {
    // The whole defect the user experiences is silence, and a sentence is
    // exactly the kind of thing that gets "tidied" back into being useless.
    const msg = tpCloseBlockedMessage({
      dealId: '69f1b27faeba7a4880365abb',
      symbol: 'XAUTUSDT',
      reason: 'Reduce order is rejected',
      retryAfter: 1757000000000,
    })
    it('names the deal, the symbol and the venue reason', () => {
      expect(msg).to.contain('69f1b27faeba7a4880365abb')
      expect(msg).to.contain('XAUTUSDT')
      expect(msg).to.contain('Reduce order is rejected')
    })
    it('says the take profit did not execute, in plain words', () => {
      expect(msg.toLowerCase()).to.contain('take profit')
    })
    it('says when it will be retried', () => {
      expect(msg).to.contain(new Date(1757000000000).toISOString())
    })
  })
})
