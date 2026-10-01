process.env.NODE_ENV = 'testing'

/**
 * Who may see a bot's webhook uuid and global variables. Only the owner — not
 * a share-link viewer and not the demo session, which reads the demo account's
 * public bots as that account. Everything else a shared bot shows must survive.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import {
  mustRedactBotCredentials,
  redactBotCredentials,
  redactBotListResult,
} from './redactBotCredentials'

const vars = { list: ['v1'], paths: [{ path: 'settings.tp', variable: 'v1' }] }
const bot = () => ({
  _id: 'b1',
  userId: 'owner',
  uuid: 'secret-uuid',
  vars,
  settings: { name: 'ETH Combo', pair: ['ETH-USDC'] },
  deals: { active: 1, all: 6 },
})

describe('redactBotCredentials — who is redacted', () => {
  it('the owner in a normal session is not', () => {
    expect(mustRedactBotCredentials('owner', 'owner')).to.be.false
  })

  it('a share-link viewer who is not the owner is', () => {
    expect(mustRedactBotCredentials('someone-else', 'owner')).to.be.true
    expect(mustRedactBotCredentials('', 'owner')).to.be.true
  })

  it('the demo session is, even though it reads as the owning account', () => {
    expect(mustRedactBotCredentials('owner', 'owner', true)).to.be.true
  })

  it('compares ids as strings (ObjectId vs string)', () => {
    const objectIdLike = { toString: () => 'owner' }
    expect(mustRedactBotCredentials('owner', objectIdLike)).to.be.false
  })
})

describe('redactBotCredentials — what is removed', () => {
  it('blanks uuid and vars and keeps every other field', () => {
    const original = bot()
    const out = redactBotCredentials(original)
    expect(out.uuid).to.equal('')
    expect(out.vars).to.deep.equal({ list: [], paths: [] })
    expect(out.settings).to.deep.equal(original.settings)
    expect(out.deals).to.deep.equal(original.deals)
    expect(out._id).to.equal('b1')
  })

  it('does not mutate the input', () => {
    const original = bot()
    redactBotCredentials(original)
    expect(original.uuid).to.equal('secret-uuid')
  })

  it('does not add fields a bot did not have', () => {
    const out = redactBotCredentials({ _id: 'x' }) as Record<string, unknown>
    expect(out).to.not.have.property('uuid')
    expect(out).to.not.have.property('vars')
  })
})

describe('redactBotListResult', () => {
  it('redacts every bot and both legs of a hedge bot', () => {
    const res = {
      status: 'OK',
      total: 2,
      data: [bot(), { ...bot(), _id: 'h1', bots: [bot(), bot()] }],
    }
    const out = redactBotListResult(res)
    expect(out.total).to.equal(2)
    for (const b of out.data) {
      expect(b.uuid).to.equal('')
      expect(b.settings.name).to.equal('ETH Combo')
    }
    const legs = (out.data[1] as { bots: { uuid: string }[] }).bots
    expect(legs.map((l) => l.uuid)).to.deep.equal(['', ''])
  })

  it('passes a NOTOK response through untouched', () => {
    const res = { status: 'NOTOK', reason: 'Cannot access', data: null }
    expect(redactBotListResult(res)).to.equal(res)
  })
})
