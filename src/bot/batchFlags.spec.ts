process.env.NODE_ENV = 'testing'

/**
 * Arming for the two bulk venue calls.
 *
 * Spec: `specs/076.kraken-spot-bulk-cancel-and-bulk-place.md` §5.
 * Run: `npm test` (mocha).
 *
 * The parser is tested through its arguments rather than through the
 * environment on purpose: the two flags are read once, at module load, so a
 * test that set `process.env` would be testing whichever spec file mocha
 * happened to load first.
 *
 * What matters here is the default and the failure mode. Both flags gate code
 * that cancels and places real orders on a live venue, so every value that is
 * not an unambiguous arming instruction — unset, empty, a typo, a truncated id
 * — has to answer "do not batch", and a typo has to SAY so rather than look
 * like a success that did nothing.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  batchScopeAllows,
  describeBatchScope,
  parseBatchScope,
} from './batchFlags'

const BOT = '652f1a2b3c4d5e6f70819a2b'
const UUID_BOT = '3f1a2b3c-4d5e-6f70-819a-2b3c4d5e6f70'
const OTHER = '652f1a2b3c4d5e6f70819a2c'

describe('parseBatchScope (spec 076 §5)', () => {
  it('is off unless somebody arms it', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(parseBatchScope(raw).kind, `"${raw}"`).to.equal('off')
    }
  })

  it('arms the fleet on 1/true/yes', () => {
    for (const raw of ['1', 'true', 'YES', ' true ']) {
      expect(parseBatchScope(raw).kind, raw).to.equal('fleet')
    }
  })

  it('arms a named list of bots, in either id spelling', () => {
    const scope = parseBatchScope(` ${BOT}, ${UUID_BOT} `)
    expect(scope.kind).to.equal('bots')
    expect(batchScopeAllows(scope, BOT)).to.equal(true)
    expect(batchScopeAllows(scope, BOT.toUpperCase())).to.equal(true)
    expect(batchScopeAllows(scope, UUID_BOT)).to.equal(true)
    expect(batchScopeAllows(scope, OTHER)).to.equal(false)
  })

  it('refuses to guess at anything that is not a bot id', () => {
    for (const raw of ['all', `${BOT},oops`, BOT.slice(0, 12), '0']) {
      const scope = parseBatchScope(raw)
      expect(scope.kind, raw).to.equal('invalid')
      expect(batchScopeAllows(scope, BOT), raw).to.equal(false)
    }
  })

  it('arms nothing when it is off or invalid', () => {
    expect(batchScopeAllows(parseBatchScope(undefined), BOT)).to.equal(false)
    expect(batchScopeAllows(parseBatchScope('nope'), BOT)).to.equal(false)
    expect(batchScopeAllows(parseBatchScope('1'), BOT)).to.equal(true)
  })
})

describe('describeBatchScope (spec 076 §5)', () => {
  it('names the bots it read, so an operator can check them', () => {
    expect(describeBatchScope(parseBatchScope(BOT))).to.contain(BOT)
  })

  it('says a typo is a typo rather than reporting silence as success', () => {
    const line = describeBatchScope(parseBatchScope('1,oops'))
    expect(line).to.contain('not understood')
    expect(line).to.contain('oops')
  })

  it('says plainly when nothing is armed', () => {
    expect(describeBatchScope(parseBatchScope(''))).to.equal('not armed')
  })
})
