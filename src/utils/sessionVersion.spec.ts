import { describe, it } from 'mocha'
import { expect } from 'chai'
import jwt from 'jsonwebtoken'

import {
  isSessionCurrent,
  keepSessions,
  sessionVersionClaim,
  userSessionVersion,
} from './sessionVersion'

const SECRET = 'session-version-unit-test-secret'
const sign = (extra: Record<string, unknown> = {}) =>
  jwt.sign({ username: 'u@example.com', authorized: true, ...extra }, SECRET, {
    expiresIn: 60,
  })

describe('session version', () => {
  it('reads an absent or malformed counter as 0', () => {
    expect(userSessionVersion(undefined)).to.equal(0)
    expect(userSessionVersion({})).to.equal(0)
    expect(userSessionVersion({ tokenVersion: 3 })).to.equal(3)
    for (const bad of [-1, 1.5, NaN, '2', null]) {
      expect(userSessionVersion({ tokenVersion: bad as never })).to.equal(0)
    }
  })

  it('signs the current counter, or the value a pending raise will give it', () => {
    expect(sessionVersionClaim(null)).to.deep.equal({ tv: 0 })
    expect(sessionVersionClaim({ tokenVersion: 4 })).to.deep.equal({ tv: 4 })
    expect(sessionVersionClaim({ tokenVersion: 4 }, 1)).to.deep.equal({ tv: 5 })
  })

  it('keeps a session without the claim alive until the counter is raised', () => {
    const legacy = sign()
    const row = { token: legacy, source: 'web' }
    expect(isSessionCurrent(legacy, { tokens: [row] })).to.equal(true)
    expect(
      isSessionCurrent(legacy, { tokenVersion: 0, tokens: [row] }),
    ).to.equal(true)
    expect(
      isSessionCurrent(legacy, { tokenVersion: 1, tokens: [row] }),
    ).to.equal(false)
  })

  it('treats a token that is not a JWT like one without the claim', () => {
    const row = { token: 'opaque', source: 'web' }
    expect(isSessionCurrent('opaque', { tokens: [row] })).to.equal(true)
    expect(
      isSessionCurrent('opaque', { tokenVersion: 1, tokens: [row] }),
    ).to.equal(false)
  })

  it('honours a claim only while it equals the counter', () => {
    const token = sign({ tv: 2 })
    const tokens = [{ token, source: 'web' }]
    expect(isSessionCurrent(token, { tokenVersion: 2, tokens })).to.equal(true)
    expect(isSessionCurrent(token, { tokenVersion: 3, tokens })).to.equal(false)
    // A counter that went backwards (restored data) does not revive it either.
    expect(isSessionCurrent(token, { tokenVersion: 1, tokens })).to.equal(false)
    expect(isSessionCurrent(token, { tokens })).to.equal(false)
  })

  it('lets the stamp on the row override the claim', () => {
    const token = sign({ tv: 2 })
    expect(
      isSessionCurrent(token, { tokenVersion: 3, tokens: [{ token, tv: 3 }] }),
    ).to.equal(true)
    expect(
      isSessionCurrent(token, { tokenVersion: 4, tokens: [{ token, tv: 3 }] }),
    ).to.equal(false)
    // The stamp of another row does not count.
    expect(
      isSessionCurrent(token, {
        tokenVersion: 3,
        tokens: [{ token }, { token: 'other', tv: 3 }],
      }),
    ).to.equal(false)
  })

  it('leaves admin-issued sessions without claim or stamp to the presence check', () => {
    const token = sign()
    const admin = { token, source: 'admin' }
    expect(
      isSessionCurrent(token, { tokenVersion: 7, tokens: [admin] }),
    ).to.equal(true)
    // Once such a session carries a claim or a stamp it is checked like any other.
    const claimed = sign({ tv: 6 })
    expect(
      isSessionCurrent(claimed, {
        tokenVersion: 7,
        tokens: [{ token: claimed, source: 'admin' }],
      }),
    ).to.equal(false)
    expect(
      isSessionCurrent(token, {
        tokenVersion: 7,
        tokens: [{ ...admin, tv: 6 }],
      }),
    ).to.equal(false)
  })

  it('keepSessions stamps the survivors with the raised counter and keeps their fields', () => {
    const user = {
      tokenVersion: 2,
      tokens: [
        { _id: 'a', token: 'one', source: 'web', tv: 1 },
        { _id: 'b', token: 'two', source: 'admin' },
        { _id: 'c', token: 'three', source: 'web' },
      ],
    }
    const kept = keepSessions(user, (t) => t.token !== 'three')
    expect(kept).to.deep.equal([
      { _id: 'a', token: 'one', source: 'web', tv: 3 },
      { _id: 'b', token: 'two', source: 'admin', tv: 3 },
    ])
    // After `$inc` the survivors are current and the dropped one is not.
    const after = { tokenVersion: 3, tokens: kept }
    expect(isSessionCurrent('one', after)).to.equal(true)
    expect(isSessionCurrent('three', after)).to.equal(false)
    expect(keepSessions({}, () => true)).to.deep.equal([])
  })
})
