import { describe, it } from 'mocha'
import { expect } from 'chai'
import crypto from 'crypto'

import {
  hashSessionToken,
  isSessionRow,
  sessionLookup,
  sessionRowPull,
  sessionRowToken,
} from './sessionTokenHash'

const TOKEN = 'header.payload.signature'
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex')

describe('session token hash', () => {
  it('hashes to hex SHA-256', () => {
    expect(hashSessionToken(TOKEN)).to.equal(HASH)
    expect(HASH).to.match(/^[a-f0-9]{64}$/)
  })

  it('writes both fields and looks up by either, hash first', () => {
    expect(sessionRowToken(TOKEN)).to.deep.equal({
      token: TOKEN,
      tokenHash: HASH,
    })
    expect(sessionLookup(TOKEN)).to.deep.equal({
      $or: [
        { tokens: { $elemMatch: { tokenHash: HASH } } },
        { tokens: { $elemMatch: { token: TOKEN } } },
      ],
    })
  })

  it('matches a row by its hash, and a row without one by its token', () => {
    expect(isSessionRow({ token: TOKEN, tokenHash: HASH }, TOKEN)).to.equal(
      true,
    )
    expect(isSessionRow({ tokenHash: HASH }, TOKEN)).to.equal(true)
    expect(isSessionRow({ token: TOKEN }, TOKEN)).to.equal(true)
    expect(isSessionRow({ token: 'other' }, TOKEN)).to.equal(false)
    expect(isSessionRow({}, TOKEN)).to.equal(false)
    // A row that has a hash is identified by it alone.
    expect(
      isSessionRow({ token: TOKEN, tokenHash: 'x'.repeat(64) }, TOKEN),
    ).to.equal(false)
  })

  it('pulls a row by whichever field identifies it', () => {
    expect(
      sessionRowPull({ token: TOKEN, tokenHash: HASH }, TOKEN),
    ).to.deep.equal({
      tokenHash: HASH,
    })
    expect(sessionRowPull({ token: TOKEN }, TOKEN)).to.deep.equal({
      token: TOKEN,
    })
    expect(sessionRowPull({}, TOKEN)).to.deep.equal({ token: TOKEN })
  })

  it('does not throw on a credential that is not a string', () => {
    const odd = ['a', 'b'] as unknown as string
    expect(() => sessionLookup(odd)).to.not.throw()
    expect(isSessionRow({ token: TOKEN }, odd)).to.equal(false)
  })
})
