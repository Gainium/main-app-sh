process.env.NODE_ENV = 'testing'

/**
 * Bot answer to the user-stream balancer's re-open request.
 *
 * Spec: websocket-connector `specs/002.hl-assignment-holds-no-credentials.md` §4.5.
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { wantsUserStreamOpen } from './userStreamReopen'

const UUID = '3f1a2b3c-4d5e-6f70-819a-2b3c4d5e6f70'
const OTHER = '9a8b7c6d-5e4f-3a2b-1c0d-ef0123456789'

describe('wantsUserStreamOpen (ws spec 002 §4.5)', () => {
  it('keeps the boot broadcast: every bot re-opens', () => {
    expect(wantsUserStreamOpen({ restart: 'userStream' }, UUID)).to.equal(true)
  })

  it('re-opens only the bots whose connection was named', () => {
    const msg = { reopen: 'userStream', uuids: [OTHER, UUID] }
    expect(wantsUserStreamOpen(msg, UUID)).to.equal(true)
    expect(
      wantsUserStreamOpen({ reopen: 'userStream', uuids: [OTHER] }, UUID),
    ).to.equal(false)
  })

  it('ignores a reopen when the bot has no connection yet', () => {
    const msg = { reopen: 'userStream', uuids: [UUID] }
    expect(wantsUserStreamOpen(msg, undefined)).to.equal(false)
    expect(wantsUserStreamOpen(msg, '')).to.equal(false)
  })

  it('ignores other services and malformed messages', () => {
    for (const msg of [
      null,
      'userStream',
      { restart: 'metricsService' },
      { reopen: 'userStream' },
      { reopen: 'userStream', uuids: UUID },
      { reopen: 'priceStream', uuids: [UUID] },
    ]) {
      expect(wantsUserStreamOpen(msg, UUID), JSON.stringify(msg)).to.equal(
        false,
      )
    }
  })
})
