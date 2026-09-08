process.env.NODE_ENV = 'testing'

/**
 * The arming scope of the take-profit coverage correction.
 * Spec: `specs/016.tp-coverage-repair-per-deal-scope.md` (#696 follow-up).
 *
 * `BOT_TP_COVERAGE_REPAIR` gates a correction that cancels and places real
 * orders with real money. Before this it was a boolean: either nothing, or
 * every drifted deal in the fleet — 184 of them per issue #700 — so there was
 * no way to run it on one deal first. These tests pin the parse that makes a
 * first run possible, and pin just as hard that the two values already in use
 * (unset, `1`) keep meaning exactly what they mean today.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  describeTpRepairScope,
  parseTpRepairScope,
  tpRepairAllows,
} from './tpCoverageReconcile'

/** The deal the operator arms first: B3-USDC, 110,493 base uncovered (§1.2). */
const B3 = '6a90e161a76e7fe63ea3118f'
const CTSI = '6a978104aa99d06351d63e3a'
const DGB = '691de676b60a5e1cf2d420eb'

describe('tp-coverage repair scope (spec 016, issue #696)', () => {
  describe('§4.1 unset is off, and off is the fleet default', () => {
    it('parses an unset/empty value as off', () => {
      for (const raw of [undefined, '', '   ']) {
        expect(parseTpRepairScope(raw).kind, JSON.stringify(raw)).to.equal(
          'off',
        )
      }
    })

    it('allows no deal at all', () => {
      const scope = parseTpRepairScope(undefined)
      expect(tpRepairAllows(scope, B3)).to.equal(false)
      expect(tpRepairAllows(scope, CTSI)).to.equal(false)
    })
  })

  describe('§4.1 the existing fleet-wide value keeps its meaning', () => {
    it('keeps 1/true/yes fleet-wide, case-insensitively', () => {
      for (const raw of ['1', 'true', 'yes', 'TRUE', 'Yes', ' true ']) {
        expect(parseTpRepairScope(raw).kind, raw).to.equal('fleet')
      }
    })

    it('allows every deal, including one it has never heard of', () => {
      const scope = parseTpRepairScope('1')
      expect(tpRepairAllows(scope, B3)).to.equal(true)
      expect(tpRepairAllows(scope, DGB)).to.equal(true)
      expect(tpRepairAllows(scope, 'anything')).to.equal(true)
    })
  })

  describe('§4.1 a list of deal ids scopes the correction', () => {
    it('parses a single deal id', () => {
      const scope = parseTpRepairScope(B3)
      expect(scope.kind).to.equal('deals')
      expect(tpRepairAllows(scope, B3)).to.equal(true)
    })

    it('repairs only the named deal and leaves the others to detection', () => {
      const scope = parseTpRepairScope(B3)
      expect(tpRepairAllows(scope, CTSI)).to.equal(false)
      expect(tpRepairAllows(scope, DGB)).to.equal(false)
    })

    it('parses a comma-separated list, whitespace and duplicates tolerated', () => {
      const scope = parseTpRepairScope(` ${B3} , ${CTSI},${CTSI} `)
      expect(scope.kind).to.equal('deals')
      expect(scope.kind === 'deals' && scope.dealIds.size).to.equal(2)
      expect(tpRepairAllows(scope, B3)).to.equal(true)
      expect(tpRepairAllows(scope, CTSI)).to.equal(true)
      expect(tpRepairAllows(scope, DGB)).to.equal(false)
    })

    it('matches a deal id case-insensitively', () => {
      const scope = parseTpRepairScope(B3.toUpperCase())
      expect(scope.kind).to.equal('deals')
      expect(tpRepairAllows(scope, B3)).to.equal(true)
    })
  })

  describe('§4.1 / §4.3 a value it does not understand never repairs', () => {
    it('rejects it rather than falling back to fleet-wide', () => {
      for (const raw of ['on', 'B3-USDC', '0', 'false', `${B3},oops`]) {
        const scope = parseTpRepairScope(raw)
        expect(scope.kind, raw).to.equal('invalid')
        // The whole point: an unreadable value must not move money.
        expect(tpRepairAllows(scope, B3), raw).to.equal(false)
      }
    })

    it('names the tokens it rejected so the operator can see the typo', () => {
      const scope = parseTpRepairScope(`${B3},6a90e161a76e7fe63ea311`)
      expect(scope.kind === 'invalid' && scope.tokens).to.deep.equal([
        '6a90e161a76e7fe63ea311',
      ])
      expect(describeTpRepairScope(scope)).to.contain('6a90e161a76e7fe63ea311')
    })

    it('§4.2 does not accept a 12-character string as a deal id', () => {
      // `mongoose`'s isValidObjectId says yes to this; a truncated or typo'd
      // token must not silently scope the run to a deal that does not exist.
      for (const raw of ['hello world!', 'deal12345678']) {
        expect(parseTpRepairScope(raw).kind, raw).to.equal('invalid')
      }
    })
  })

  describe('§4.3 the scope says what it is, for the startup log', () => {
    it('describes each state in operator terms', () => {
      expect(describeTpRepairScope(parseTpRepairScope('1'))).to.contain(
        'every drifted deal',
      )
      const scoped = describeTpRepairScope(parseTpRepairScope(`${B3},${CTSI}`))
      expect(scoped).to.contain('2')
      expect(scoped).to.contain(B3)
      expect(describeTpRepairScope(parseTpRepairScope(undefined))).to.contain(
        'detect',
      )
    })
  })
})
