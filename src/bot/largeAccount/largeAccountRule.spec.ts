process.env.NODE_ENV = 'testing'

/**
 * Large account mode decision (main-app spec 019 §2): enter thresholds,
 * hysteresis on leave, the tri-state override, and what a user may change.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  LARGE_ACCOUNT_THRESHOLDS,
  decideLargeAccount,
  evaluateAutoLargeAccount,
  normalizeOverride,
  userCanEnable,
  userCanRevert,
  userModeChange,
} from './largeAccountRule'

const counts = (activeBots = 0, openDeals = 0, terminalBots = 0) => ({
  activeBots,
  openDeals,
  terminalBots,
})

describe('large account rule (spec 019 §2.1)', () => {
  it('thresholds are 400 / 1000 / 1000, leaving at 80 %', () => {
    expect(LARGE_ACCOUNT_THRESHOLDS).to.deep.equal({
      activeBots: { enter: 400, leave: 320 },
      openDeals: { enter: 1000, leave: 800 },
      terminalBots: { enter: 1000, leave: 800 },
    })
  })

  it('enters at >= 400 active bots, not at 399', () => {
    expect(evaluateAutoLargeAccount(counts(399), false).active).to.equal(false)
    expect(evaluateAutoLargeAccount(counts(400), false)).to.deep.equal({
      active: true,
      reason: 'bots',
    })
  })

  it('enters on open deals or terminal bots alone', () => {
    expect(evaluateAutoLargeAccount(counts(0, 1000), false).reason).to.equal(
      'openDeals',
    )
    expect(
      evaluateAutoLargeAccount(counts(0, 999, 1000), false).reason,
    ).to.equal('terminalBots')
    expect(
      evaluateAutoLargeAccount(counts(0, 999, 999), false).active,
    ).to.equal(false)
  })

  it('hysteresis: once active, stays active down to the leave value', () => {
    expect(evaluateAutoLargeAccount(counts(321), true).active).to.equal(true)
    expect(evaluateAutoLargeAccount(counts(320), true).active).to.equal(true)
    expect(evaluateAutoLargeAccount(counts(319), true).active).to.equal(false)
    // an inactive account at the same count stays inactive
    expect(evaluateAutoLargeAccount(counts(350), false).active).to.equal(false)
  })

  it('leaves only when EVERY signal is below its leave value', () => {
    expect(evaluateAutoLargeAccount(counts(10, 800), true)).to.deep.equal({
      active: true,
      reason: 'openDeals',
    })
    expect(
      evaluateAutoLargeAccount(counts(10, 799, 799), true).active,
    ).to.equal(false)
  })
})

describe('large account override (spec 019 §2.2)', () => {
  it('on forces active with reason override, keeping the auto memory', () => {
    expect(decideLargeAccount(counts(1), false, 'on')).to.deep.equal({
      active: true,
      source: 'override',
      reason: 'override',
      autoActive: false,
    })
  })

  it('off forces inactive even past every threshold', () => {
    expect(
      decideLargeAccount(counts(5000, 5000, 5000), false, 'off'),
    ).to.deep.equal({
      active: false,
      source: 'override',
      reason: null,
      autoActive: true,
    })
  })

  it('auto follows the rule', () => {
    expect(decideLargeAccount(counts(500), false, 'auto')).to.deep.equal({
      active: true,
      source: 'auto',
      reason: 'bots',
      autoActive: true,
    })
  })

  it('unknown or missing override values read as auto', () => {
    expect(normalizeOverride(undefined)).to.equal('auto')
    expect(normalizeOverride('garbage')).to.equal('auto')
    expect(normalizeOverride('on')).to.equal('on')
    expect(normalizeOverride('off')).to.equal('off')
  })
})

describe('what a user may change (spec 019 §2.3)', () => {
  it('may switch on from auto', () => {
    expect(userModeChange({ override: 'auto' }, 'on')).to.deep.equal({
      ok: true,
      override: 'on',
      by: 'user',
    })
  })

  it('may never switch off', () => {
    const r = userModeChange({ override: 'auto' }, 'off')
    expect(r.ok).to.equal(false)
    expect(userModeChange({ override: 'on', by: 'user' }, 'off').ok).to.equal(
      false,
    )
  })

  it('may undo their own on, but not an admin on', () => {
    expect(
      userModeChange({ override: 'on', by: 'user' }, 'auto'),
    ).to.deep.equal({ ok: true, override: 'auto', by: null })
    expect(userModeChange({ override: 'on', by: 'admin' }, 'auto').ok).to.equal(
      false,
    )
  })

  it('cannot override an admin off by switching on', () => {
    expect(userModeChange({ override: 'off', by: 'admin' }, 'on').ok).to.equal(
      false,
    )
  })

  it('re-sending on keeps an admin on attributed to the admin', () => {
    expect(userModeChange({ override: 'on', by: 'admin' }, 'on')).to.deep.equal(
      {
        ok: true,
        override: 'on',
        by: 'admin',
      },
    )
  })

  it('flags for the UI', () => {
    expect(userCanEnable('auto')).to.equal(true)
    expect(userCanEnable('on')).to.equal(false)
    expect(userCanRevert('on', 'user')).to.equal(true)
    expect(userCanRevert('on', 'admin')).to.equal(false)
    expect(userCanRevert('off', 'admin')).to.equal(false)
  })
})
