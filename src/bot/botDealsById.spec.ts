process.env.NODE_ENV = 'testing'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'spec-050-test-secret'

/**
 * `getDCABotDealsById` / `getComboBotDealsById` (main-app spec 050 §4.5): the
 * dashboard loads a deal's costs through them. They return full deal
 * documents, and only the caller's own: the bot must be theirs, and every
 * deal read carries their userId as well as the bot id.
 *
 * Run: `npm test` (mocha). No DB — the real methods run off the `Bot`
 * prototype against an in-memory deal store that applies the filter.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../types'
import Bot from './index'

const loadModule = createRequire(__filename)

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const BOT = 'cccccccccccccccccccccccc'
const MY_DEAL = 'dddddddddddddddddddddd01'
const OTHER_DEAL = 'dddddddddddddddddddddd02'

const STORE = [
  { _id: MY_DEAL, botId: BOT, userId: ME, status: 'closed' },
  // Same bot id, a deal that belongs to someone else.
  { _id: OTHER_DEAL, botId: BOT, userId: OTHER, status: 'closed' },
]

const KINDS = [
  {
    name: 'getDCABotDealsById',
    method: 'getDCABotDealsById',
    lookup: 'getDCABotFromDb',
    store: 'dcaDealsDb',
  },
  {
    name: 'getComboBotDealsById',
    method: 'getComboBotDealsById',
    lookup: 'getComboBotFromDb',
    store: 'comboDealsDb',
  },
] as const

function api(
  kind: (typeof KINDS)[number],
  botLookup: 'ok' | 'notFound' = 'ok',
) {
  const reads: any[] = []
  const b: any = Object.create(Bot.prototype)
  b[kind.lookup] = async () =>
    botLookup === 'ok'
      ? { status: StatusEnum.ok, data: { _id: BOT, userId: OTHER } }
      : { status: StatusEnum.notok, reason: 'Bot not found', data: null }
  b[kind.store] = {
    readData: async (filter: any) => {
      reads.push(filter)
      const ids = new Set((filter._id?.$in ?? []).map((i: unknown) => `${i}`))
      const result = STORE.filter(
        (d) =>
          d.botId === filter.botId &&
          (filter.userId === undefined || d.userId === filter.userId) &&
          ids.has(d._id),
      )
      return { status: StatusEnum.ok, data: { result, count: result.length } }
    },
  }
  return { b, reads, call: (...a: any[]) => b[kind.method](...a) }
}

for (const kind of KINDS) {
  describe(`${kind.name} (spec 050 §4.5)`, () => {
    it('returns the caller’s own deal', async () => {
      const { call } = api(kind)
      const res = await call(ME, BOT, [MY_DEAL], false)
      expect(res.status).to.equal(StatusEnum.ok)
      expect(res.data.deals.map((d: any) => d._id)).to.deep.equal([MY_DEAL])
    })

    it('never returns another user’s deal under a matching bot', async () => {
      const { call, reads } = api(kind)
      const res = await call(ME, BOT, [OTHER_DEAL, MY_DEAL], false)
      expect(res.data.deals.map((d: any) => d._id)).to.deep.equal([MY_DEAL])
      expect(reads[0].userId).to.equal(ME)
      const only = await call(ME, BOT, [OTHER_DEAL], false)
      expect(only.data.deals).to.deep.equal([])
    })

    it('reads nothing when the bot is not the caller’s', async () => {
      const { call, reads } = api(kind, 'notFound')
      const res = await call(ME, BOT, [MY_DEAL], false)
      expect(res.status).to.equal(StatusEnum.notok)
      expect(reads).to.have.length(0)
    })

    it('malformed ids match nothing, with no deal read', async () => {
      const { call, reads } = api(kind)
      const res = await call(ME, BOT, ['nope', { $ne: 1 }], false)
      expect(res).to.deep.equal({ status: StatusEnum.ok, data: { deals: [] } })
      expect(reads).to.have.length(0)
    })

    it('the resolver needs auth and passes the CALLER’s id', async () => {
      const calls: any[] = []
      const fakeBot = {
        [kind.method]: async (...args: any[]) => {
          calls.push(args)
          return { status: StatusEnum.ok, data: { deals: [] } }
        },
      }
      // Under the full suite `config` is already loaded, so the env var set
      // above arrives too late; `graphql/handlers/user` reads it from here.
      const config = loadModule('../config')
      config.JWT_SECRET = config.JWT_SECRET || process.env.JWT_SECRET
      const resolvers = loadModule('../graphql/resolvers').default(
        async () => ({
          status: StatusEnum.ok,
          data: { _id: ME },
          reason: null,
        }),
        {},
        fakeBot,
      )
      const q = resolvers.Query[kind.name]
      expect(q, 'resolver registered').to.be.a('function')

      const denied = await q(
        null,
        { input: { botId: BOT, id: [MY_DEAL] } },
        { token: 't', req: { user: { authorized: false } } },
      )
      expect(denied.status).to.equal(StatusEnum.notok)
      expect(calls).to.have.length(0)

      const ok = await q(
        null,
        { input: { botId: BOT, id: [MY_DEAL] } },
        {
          token: 't',
          req: { user: { authorized: true } },
          paperContext: false,
        },
      )
      expect(ok.status).to.equal(StatusEnum.ok)
      expect(calls[0]).to.deep.equal([ME, BOT, [MY_DEAL], false])
    })
  })
}
