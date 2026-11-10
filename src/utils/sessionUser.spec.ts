import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import sinon from 'sinon'
import jwt from 'jsonwebtoken'

import { StatusEnum } from '../../types'
import logger from './logger'
import {
  resolveSessionUser,
  SessionRejection,
  SESSION_EXPIRED_REASON,
  SESSION_USER_NOT_FOUND_REASON,
} from './sessionUser'

const SECRET = 'session-user-unit-test-secret'
const USER_ID = '64f0c0ffee64f0c0ffee64f0'
const OTHER_ID = '64f0c0ffee64f0c0ffee64f1'

type Row = { _id: string; username: string; tokens: Record<string, unknown>[] }
type Filter = {
  tokens?: { $elemMatch: { token: string } }
  $and?: [{ tokens: { $elemMatch: { token: string } } }, { _id: string }]
}

/** The two filter shapes the helper sends, over an in-memory user list. */
const fakeDb = (rows: Row[], fail = false) => {
  const calls: Filter[] = []
  const db = {
    readData: async (filter: Filter) => {
      calls.push(filter)
      if (fail) {
        return { status: StatusEnum.notok, reason: 'db down', data: null }
      }
      const token = (filter.$and?.[0] ?? filter).tokens?.$elemMatch.token
      const id = filter.$and?.[1]._id
      const result =
        rows.find(
          (r) =>
            r.tokens.some((t) => t.token === token) &&
            (id === undefined || r._id === id),
        ) ?? null
      return { status: StatusEnum.ok, reason: null, data: { result } }
    },
  }
  return { db: db as never, calls }
}

const sign = (ttl: number | null) =>
  jwt.sign(
    { username: 'u@example.com', authorized: true },
    SECRET,
    ttl === null ? {} : { expiresIn: ttl },
  )

const opts = { source: 'test', secret: SECRET }

describe('resolveSessionUser', () => {
  afterEach(() => sinon.restore())

  it('resolves a signed, unexpired token that is in tokens[]', async () => {
    const token = sign(60)
    const { db } = fakeDb([
      { _id: USER_ID, username: 'u', tokens: [{ token, source: 'email' }] },
    ])
    const res = await resolveSessionUser(token, db, opts)
    expect(res.ok).to.equal(true)
    expect(res.user?._id).to.equal(USER_ID)
    expect(res.rejection).to.equal(undefined)
  })

  it('rejects an expired token even though it is still in tokens[]', async () => {
    const token = sign(-10)
    const warn = sinon.stub(logger, 'warn')
    const { db, calls } = fakeDb([
      { _id: USER_ID, username: 'u', tokens: [{ token }] },
    ])
    const res = await resolveSessionUser(token, db, {
      ...opts,
      source: 'stream user connect',
      userId: USER_ID,
    })
    expect(res.ok).to.equal(false)
    expect(res.rejection).to.equal(SessionRejection.expired)
    expect(res.reason).to.equal(SESSION_EXPIRED_REASON)
    expect(calls, 'no user lookup for an expired token').to.have.length(0)
    const line = warn.firstCall.args.join(' ')
    expect(line).to.equal(
      `Session rejected | stream user connect | expired | user ${USER_ID}`,
    )
    expect(line).to.not.contain(token)
  })

  it('rejects a valid token that is no longer in tokens[] (logged out)', async () => {
    sinon.stub(logger, 'warn')
    const { db } = fakeDb([{ _id: USER_ID, username: 'u', tokens: [] }])
    const res = await resolveSessionUser(sign(60), db, opts)
    expect(res.rejection).to.equal(SessionRejection.unknown)
    expect(res.reason).to.equal(SESSION_USER_NOT_FOUND_REASON)
  })

  it("rejects a session issued before the user's session version was raised", async () => {
    const warn = sinon.stub(logger, 'warn')
    const token = sign(60)
    const row = { _id: USER_ID, username: 'u', tokens: [{ token }] }
    const { db } = fakeDb([{ ...row, tokenVersion: 1 } as Row])
    const res = await resolveSessionUser(token, db, {
      ...opts,
      source: 'stream user connect',
      userId: USER_ID,
    })
    expect(res.rejection).to.equal(SessionRejection.revoked)
    expect(res.reason).to.equal(SESSION_USER_NOT_FOUND_REASON)
    expect(warn.firstCall.args.join(' ')).to.equal(
      `Session rejected | stream user connect | revoked | user ${USER_ID}`,
    )
    // Same token, counter never raised: still a session.
    const before = await resolveSessionUser(token, fakeDb([row]).db, opts)
    expect(before.ok).to.equal(true)
    // Kept by a "sign out the others" write: the row carries the new version.
    const kept = fakeDb([
      { ...row, tokenVersion: 1, tokens: [{ token, tv: 1 }] } as Row,
    ])
    expect((await resolveSessionUser(token, kept.db, opts)).ok).to.equal(true)
  })

  it('rejects a token signed with another secret, without a lookup', async () => {
    sinon.stub(logger, 'warn')
    const token = jwt.sign({ username: 'u' }, 'someone-elses-secret')
    const { db, calls } = fakeDb([
      { _id: USER_ID, username: 'u', tokens: [{ token }] },
    ])
    const res = await resolveSessionUser(token, db, opts)
    expect(res.rejection).to.equal(SessionRejection.invalid)
    expect(calls).to.have.length(0)
  })

  it('accepts a legacy row without expiredAt and a token without exp', async () => {
    // Mirrors the HTTP gate: jwt.verify passes a token that carries no `exp`,
    // and the stored `expiredAt` is never consulted.
    const noExp = sign(null)
    const withExp = sign(60)
    const { db } = fakeDb([
      {
        _id: USER_ID,
        username: 'u',
        tokens: [{ token: noExp }, { token: withExp, expiredAt: new Date(0) }],
      },
    ])
    expect((await resolveSessionUser(noExp, db, opts)).ok).to.equal(true)
    expect((await resolveSessionUser(withExp, db, opts)).ok).to.equal(true)
  })

  it('never resolves the public demo token', async () => {
    sinon.stub(logger, 'warn')
    const { db, calls } = fakeDb([
      { _id: USER_ID, username: 'demo', tokens: [{ token: 'demo' }] },
    ])
    const res = await resolveSessionUser('demo', db, opts)
    expect(res.rejection).to.equal(SessionRejection.demo)
    expect(calls).to.have.length(0)
  })

  it('rejects non-string and empty credentials before any query', async () => {
    sinon.stub(logger, 'warn')
    const { db, calls } = fakeDb([])
    for (const bad of [undefined, null, '', 0, { $gt: '' }, ['a']]) {
      const res = await resolveSessionUser(bad, db, opts)
      expect(res.rejection, String(bad)).to.equal(SessionRejection.malformed)
    }
    for (const bad of [undefined, '', { $gt: '' }]) {
      const res = await resolveSessionUser(sign(60), db, {
        ...opts,
        userId: bad,
      })
      expect(res.rejection, String(bad)).to.equal(SessionRejection.malformed)
    }
    expect(calls).to.have.length(0)
  })

  it('with userId, the token must belong to that user', async () => {
    sinon.stub(logger, 'warn')
    const token = sign(60)
    const { db, calls } = fakeDb([
      { _id: USER_ID, username: 'u', tokens: [{ token }] },
    ])
    const own = await resolveSessionUser(token, db, {
      ...opts,
      userId: USER_ID,
    })
    expect(own.ok).to.equal(true)
    expect(calls[0]).to.deep.equal({
      $and: [{ tokens: { $elemMatch: { token } } }, { _id: USER_ID }],
    })
    const other = await resolveSessionUser(token, db, {
      ...opts,
      userId: OTHER_ID,
    })
    expect(other.rejection).to.equal(SessionRejection.unknown)
  })

  it('reports a failed user lookup with its reason', async () => {
    sinon.stub(logger, 'warn')
    const { db } = fakeDb([], true)
    const res = await resolveSessionUser(sign(60), db, opts)
    expect(res.rejection).to.equal(SessionRejection.unreadable)
    expect(res.reason).to.equal('db down')
  })

  it('without a signing secret, falls back to the presence check and says so once', async () => {
    const error = sinon.stub(logger, 'error')
    sinon.stub(logger, 'warn')
    const token = sign(-10)
    const { db } = fakeDb([
      { _id: USER_ID, username: 'u', tokens: [{ token }] },
    ])
    const noSecret = { source: 'test', secret: '' }
    expect((await resolveSessionUser(token, db, noSecret)).ok).to.equal(true)
    expect((await resolveSessionUser(token, db, noSecret)).ok).to.equal(true)
    expect(error.callCount).to.equal(1)
    const gone = await resolveSessionUser(sign(60), db, noSecret)
    expect(gone.rejection).to.equal(SessionRejection.unknown)
  })
})
