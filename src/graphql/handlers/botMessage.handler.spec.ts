process.env.NODE_ENV = 'testing'

/**
 * spec 137 — read bot messages stay in a searchable history.
 *
 * Spec: `specs/137.bot-message-read-history.md`. Run: `npm test` (mocha).
 *
 * The feed filter is a pure function and is asserted directly. Mark-read runs
 * the real handler against `botMessageDb` with its update methods replaced by
 * recorders, so no database is needed.
 */
import { describe, it, before, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { parse, validate } from 'graphql'
import {
  botMessageFeedFilter,
  getBotMessage,
  markBotMessageRead,
} from './botMessage.handler'
import { botMessageDb } from '../../db/dbInit'
import dbSchema, { registerIndexes } from '../../db/schema'
import Schema from '../schema'
import { StatusEnum } from '../../../types'

const USER = 'user-1'
const UNREAD = { $in: [false, null] }
const NOT_DELETED = { $in: [false, null] }

describe('spec 137 — feed filter per view', () => {
  it('§2.2 unread: not deleted, not read (absent isRead counts as unread)', () => {
    const f = botMessageFeedFilter(USER, false, { view: 'unread' })
    expect(f).to.not.equal(null)
    expect(f!.isDeleted).to.deep.equal(NOT_DELETED)
    expect(f!.isRead).to.deep.equal(UNREAD)
    expect(f!.showUser).to.equal(true)
    expect(f!.paperContext).to.deep.equal({ $in: [false, null] })
  })

  it('§2.2 read: not deleted, read only', () => {
    const f = botMessageFeedFilter(USER, true, { view: 'read' })
    expect(f!.isDeleted).to.deep.equal(NOT_DELETED)
    expect(f!.isRead).to.deep.equal({ $in: [true] })
    expect(f!.paperContext).to.equal(true)
  })

  it('§2.2 all: not deleted, read or unread', () => {
    const f = botMessageFeedFilter(USER, false, { view: 'all' })
    expect(f!.isDeleted).to.deep.equal(NOT_DELETED)
    expect(f!.isRead).to.deep.equal({ $in: [true, false, null] })
  })

  it('§2.3 no view + unreadOnly default/true is the unread view', () => {
    expect(botMessageFeedFilter(USER, false, {})).to.deep.equal(
      botMessageFeedFilter(USER, false, { view: 'unread' }),
    )
    expect(
      botMessageFeedFilter(USER, false, { unreadOnly: true }),
    ).to.deep.equal(botMessageFeedFilter(USER, false, { view: 'unread' }))
  })

  it('§2.3 legacy unreadOnly:false keeps matching every visible row', () => {
    const f = botMessageFeedFilter(USER, false, { unreadOnly: false })
    expect(f!.isDeleted).to.deep.equal({ $in: [true, false, null] })
    expect(f!.isRead).to.deep.equal({ $in: [true, false, null] })
  })

  it('§3.1 view wins over unreadOnly', () => {
    expect(
      botMessageFeedFilter(USER, false, { view: 'read', unreadOnly: true }),
    ).to.deep.equal(botMessageFeedFilter(USER, false, { view: 'read' }))
  })

  it('§2.2 search applies to every view', () => {
    const f = botMessageFeedFilter(USER, false, { view: 'read', search: 'okx' })
    expect(f!.$or).to.be.an('array').with.length.greaterThan(0)
  })

  it('§3.4 severity and bot narrow any view', () => {
    const f = botMessageFeedFilter(USER, false, {
      view: 'all',
      type: 'error',
      botId: 'bot-9',
    })
    expect(f!.type).to.equal('error')
    expect(f!.botId).to.equal('bot-9')
    const plain = botMessageFeedFilter(USER, false, { view: 'all' })
    expect(plain).to.not.have.property('type')
    expect(plain).to.not.have.property('botId')
  })

  it('§3.1 unknown view is rejected', async () => {
    expect(botMessageFeedFilter(USER, false, { view: 'archived' })).to.equal(
      null,
    )
    const res = await getBotMessage(USER, false, {
      view: 'archived',
    })
    expect(res.status).to.equal(StatusEnum.notok)
  })
})

describe('spec 137 — markBotMessageRead', () => {
  const db = botMessageDb as any
  const original = {
    updateData: db.updateData,
    updateManyData: db.updateManyData,
  }
  let calls: { method: string; filter: any; update: any }[] = []

  beforeEach(() => {
    calls = []
    db.updateData = async (filter: any, update: any) => {
      calls.push({ method: 'updateData', filter, update })
      return { status: StatusEnum.ok, reason: null, data: 'ok' }
    }
    db.updateManyData = async (filter: any, update: any) => {
      calls.push({ method: 'updateManyData', filter, update })
      return { status: StatusEnum.ok, reason: null, data: 'ok' }
    }
  })
  afterEach(() => {
    db.updateData = original.updateData
    db.updateManyData = original.updateManyData
  })

  it('§2.1 §2.4 §2.5 one message: read, not deleted, out of the coalescing key', async () => {
    const before = Date.now()
    const res = await markBotMessageRead(USER, 'msg-1')
    expect(res.status).to.equal(StatusEnum.ok)
    expect(calls).to.have.length(1)
    const { filter, update } = calls[0]
    expect(filter).to.deep.equal({
      userId: USER,
      _id: 'msg-1',
      isDeleted: NOT_DELETED,
      isRead: UNREAD,
    })
    expect(update.$set.isRead).to.equal(true)
    expect(update.$set.readAt).to.be.instanceOf(Date)
    expect(update.$set.readAt.getTime()).to.be.at.least(before)
    expect(update.$set).to.not.have.property('isDeleted')
    expect(update.$unset).to.deep.equal({ bucket: '' })
  })

  it('§2.4 no id: every unread, non-deleted message of the user', async () => {
    await markBotMessageRead(USER)
    expect(calls).to.have.length(1)
    expect(calls[0].method).to.equal('updateManyData')
    expect(calls[0].filter).to.deep.equal({
      userId: USER,
      isDeleted: NOT_DELETED,
      isRead: UNREAD,
    })
    expect(calls[0].update.$set.isRead).to.equal(true)
    expect(calls[0].update.$unset).to.deep.equal({ bucket: '' })
  })
})

describe('spec 137 — indexes', () => {
  type Idx = [Record<string, unknown>, Record<string, unknown>]
  let indexes: Idx[] = []
  before(() => {
    // Same idiom as db/globalVarIndex.spec.ts: idempotent registration.
    registerIndexes()
    indexes = (dbSchema.botMessage as any).indexes() as Idx[]
  })

  it('§2.6 read rows expire 90 days after readAt', () => {
    const ttl = indexes.find(([, o]) => o.name === 'botMessageReadHistoryTtl')
    expect(ttl, 'botMessageReadHistoryTtl').to.not.equal(undefined)
    expect(ttl![0]).to.deep.equal({ readAt: 1 })
    expect(ttl![1].expireAfterSeconds).to.equal(90 * 24 * 60 * 60)
  })

  it('§4.2 feed index carries isRead before created', () => {
    const idx = indexes.find(([, o]) => o.name === 'botMessageFeedByRead')
    expect(idx, 'botMessageFeedByRead').to.not.equal(undefined)
    expect(Object.keys(idx![0])).to.deep.equal([
      'userId',
      'showUser',
      'paperContext',
      'isDeleted',
      'isRead',
      'created',
    ])
  })
})

describe('spec 137 — GraphQL contract', () => {
  const schema = makeExecutableSchema({ typeDefs: Schema })
  const errors = (doc: string) =>
    validate(schema, parse(doc)).map((e) => e.message)

  it('§3.1 §3.2 feed takes a view and returns read state', () => {
    expect(
      errors(`query { getMessageBot(input: { view: "read", page: 1, pageSize: 20, search: "x", type: "error", botId: "b" }) {
        status reason total data { result { _id message isRead readAt } } } }`),
    ).to.deep.equal([])
  })

  it('§3.3 markBotMessageRead, with and without id', () => {
    expect(
      errors(`mutation { markBotMessageRead(input: { id: "a" }) { status reason } }`),
    ).to.deep.equal([])
    expect(
      errors(`mutation { markBotMessageRead(input: {}) { status reason } }`),
    ).to.deep.equal([])
  })
})
