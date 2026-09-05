process.env.NODE_ENV = 'testing'

/**
 * Spec 008 — a standing, user-caused condition must be reported once when it
 * starts holding, not once per evaluation of it.
 *
 * Run: `npm test` (mocha) from `core/`.
 *
 * The property under test is the one production violates 8.3 million times a
 * month: `openNewDeal` re-evaluates "can this account fund a base order?" about
 * once a minute, and every refusal was reported as if it were news. The account
 * balance behind those refusals never moved — only the `required`/`price`
 * numbers embedded in the message did, which is exactly why nothing keyed on
 * message text could collapse them (spec §1.2.4).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { ConditionLatch, standingConditionKey } from './conditionLatch'

const DAY = 24 * 60 * 60 * 1000

describe('ConditionLatch (spec 008)', () => {
  describe('§1.1.1 — report once when the condition first holds', () => {
    it('reports the first occurrence', () => {
      const latch = new ConditionLatch(DAY)
      expect(latch.shouldReport('k', 0)).to.equal(true)
    })

    it('suppresses every later occurrence while it holds', () => {
      const latch = new ConditionLatch(DAY)
      const reported: number[] = []
      // 900 cycles ~= one bot-pair for 15 hours at prod cadence.
      for (let cycle = 0; cycle < 900; cycle++) {
        if (latch.shouldReport('k', cycle * 60_000)) {
          reported.push(cycle)
        }
      }
      expect(reported).to.deep.equal([0])
    })

    it('keys independently, so one blocked pair never masks another', () => {
      const latch = new ConditionLatch(DAY)
      expect(latch.shouldReport('nob|CATIUSDT', 0)).to.equal(true)
      expect(latch.shouldReport('nob|ETHUSDT', 0)).to.equal(true)
      expect(latch.shouldReport('nob|CATIUSDT', 60_000)).to.equal(false)
      expect(latch.shouldReport('nob|ETHUSDT', 60_000)).to.equal(false)
    })
  })

  describe('§1.1.2 — report again after the condition clears and returns', () => {
    it('re-arms after clear', () => {
      const latch = new ConditionLatch(DAY)
      expect(latch.shouldReport('k', 0)).to.equal(true)
      expect(latch.shouldReport('k', 60_000)).to.equal(false)
      latch.clear('k')
      expect(latch.shouldReport('k', 120_000)).to.equal(true)
    })

    it('clearing a key that never fired is a no-op, not a throw', () => {
      const latch = new ConditionLatch(DAY)
      latch.clear('never-seen')
      expect(latch.shouldReport('never-seen', 0)).to.equal(true)
    })

    it('clearing one key does not re-arm another', () => {
      const latch = new ConditionLatch(DAY)
      latch.shouldReport('a', 0)
      latch.shouldReport('b', 0)
      latch.clear('a')
      expect(latch.shouldReport('a', 1)).to.equal(true)
      expect(latch.shouldReport('b', 1)).to.equal(false)
    })
  })

  describe('§1.1.3 — the existing daily reminder survives', () => {
    it('does not re-arm before the window', () => {
      const latch = new ConditionLatch(DAY)
      expect(latch.shouldReport('k', 0)).to.equal(true)
      expect(latch.shouldReport('k', DAY - 1)).to.equal(false)
    })

    it('re-arms once the window elapses, then latches again', () => {
      const latch = new ConditionLatch(DAY)
      expect(latch.shouldReport('k', 0)).to.equal(true)
      expect(latch.shouldReport('k', DAY)).to.equal(true)
      expect(latch.shouldReport('k', DAY + 60_000)).to.equal(false)
      expect(latch.shouldReport('k', 2 * DAY)).to.equal(true)
    })

    it('a condition held for 30 days reports about once a day, not 43,200 times', () => {
      const latch = new ConditionLatch(DAY)
      let reported = 0
      // One evaluation per minute for 30 days.
      for (let m = 0; m < 30 * 24 * 60; m++) {
        if (latch.shouldReport('k', m * 60_000)) {
          reported++
        }
      }
      expect(reported).to.equal(30)
    })

    it('a zero window disables the periodic re-arm entirely', () => {
      const latch = new ConditionLatch(0)
      expect(latch.shouldReport('k', 0)).to.equal(true)
      expect(latch.shouldReport('k', 10 * DAY)).to.equal(false)
    })
  })

  describe('§1.2.4 — a drifting message must not defeat the latch', () => {
    it('the key is the reason and the pair, never the rendered text', () => {
      const latch = new ConditionLatch(DAY)
      // The real production texts: `available` is constant, `required` and
      // `price` move every cycle.
      const cycles = [
        'Not enough balance to start new deal required: 412.8 CATI, available: 151.0008 CATI, price: 0.05447 USDT',
        'Not enough balance to start new deal required: 413.3 CATI, available: 151.0008 CATI, price: 0.0544 USDT',
        'Not enough balance to start new deal required: 413.4 CATI, available: 151.0008 CATI, price: 0.05439 USDT',
      ]
      const reported = cycles.filter((_msg, i) =>
        latch.shouldReport(
          standingConditionKey('notEnoughBalanceNewDeal', 'CATIUSDT'),
          i * 60_000,
        ),
      )
      expect(reported).to.have.length(1)
    })

    it('builds a key that separates reason from pair', () => {
      expect(
        standingConditionKey('notEnoughBalanceNewDeal', 'CATIUSDT'),
      ).to.not.equal(standingConditionKey('notEnoughBalanceNewDeal', 'ETHUSDT'))
      expect(standingConditionKey('reasonA', 'PAIR')).to.not.equal(
        standingConditionKey('reasonB', 'PAIR'),
      )
    })

    it('an absent symbol still produces a usable, bot-level key', () => {
      const latch = new ConditionLatch(DAY)
      const key = standingConditionKey('someReason', undefined)
      expect(latch.shouldReport(key, 0)).to.equal(true)
      expect(latch.shouldReport(key, 60_000)).to.equal(false)
    })
  })

  describe('bounded memory', () => {
    it('forgets a key once cleared, so a long-lived bot does not accumulate', () => {
      const latch = new ConditionLatch(DAY)
      for (let i = 0; i < 100; i++) {
        latch.shouldReport(`k${i}`, 0)
      }
      expect(latch.size).to.equal(100)
      for (let i = 0; i < 100; i++) {
        latch.clear(`k${i}`)
      }
      expect(latch.size).to.equal(0)
    })
  })
})
