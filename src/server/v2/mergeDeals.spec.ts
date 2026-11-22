/**
 * Spec 257 — merge DCA deals through the public API: the request checks the
 * route runs before anything reaches a bot worker, and the key-restriction
 * middleware seeing every merged deal id.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 */
import { expect } from 'chai'
import {
  parseMergeDealsBody,
  checkMergeCandidates,
  type MergeCandidate,
} from './mergeDeals'
import { apiKeyRestrictionsMiddleware } from './middleware'
import { dcaDealsDb, comboDealsDb, dcaBotDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'
import v2API from './api'

const A = '64b000000000000000000001'
const B = '64b000000000000000000002'
const C = '64b000000000000000000003'

const deal = (
  id: string,
  over: Partial<MergeCandidate> = {},
): MergeCandidate => ({
  _id: id,
  status: 'open',
  botId: `bot-${id.slice(-1)}`,
  symbol: { symbol: 'BTCUSDT' },
  strategy: 'LONG',
  exchangeUUID: 'acc-1',
  paperContext: false,
  ...over,
})

describe('spec 257 — merge DCA deals via API v2', () => {
  describe('§1.2.2 body shape', () => {
    it('accepts two ids and the dialog options', () => {
      const r = parseMergeDealsBody({
        dealIds: [A, B],
        useTp: true,
        useSl: false,
        useDca: true,
        dcaOrders: 3,
      })
      expect(r.ok).to.equal(true)
      if (!r.ok) return
      expect(r.value.dealIds).to.deep.equal([A, B])
      expect(r.value.targetDealId).to.equal(A)
      expect(r.value.options).to.deep.equal({
        useTp: true,
        useSl: false,
        useDca: true,
        dcaOrders: 3,
      })
    })
    it('omits options that were not sent (engine defaults apply)', () => {
      const r = parseMergeDealsBody({ dealIds: [A, B] })
      expect(r.ok && r.value.options).to.deep.equal({})
    })
    it('targetDealId picks the owning deal', () => {
      const r = parseMergeDealsBody({ dealIds: [A, B], targetDealId: B })
      expect(r.ok && r.value.targetDealId).to.equal(B)
    })
    for (const [name, body] of [
      ['missing dealIds', {}],
      ['dealIds not an array', { dealIds: A }],
      ['one deal', { dealIds: [A] }],
      ['the same deal twice', { dealIds: [A, A] }],
      ['an invalid id', { dealIds: [A, 'nope'] }],
      ['a non-string id', { dealIds: [A, 7] }],
      ['target outside dealIds', { dealIds: [A, B], targetDealId: C }],
      ['non-boolean useTp', { dealIds: [A, B], useTp: 'yes' }],
      ['zero dcaOrders', { dealIds: [A, B], dcaOrders: 0 }],
      ['fractional dcaOrders', { dealIds: [A, B], dcaOrders: 1.5 }],
    ] as const) {
      it(`refuses ${name} with 400`, () => {
        const r = parseMergeDealsBody(body as any)
        expect(r.ok).to.equal(false)
        if (r.ok) return
        expect(r.status).to.equal(400)
      })
    }
  })

  describe('§1.2.3–7 the deals themselves', () => {
    const ids = [A, B]
    it('passes same pair/side/account open deals and names the target bot', () => {
      const r = checkMergeCandidates(ids, B, [deal(A), deal(B)], false)
      expect(r).to.deep.equal({ ok: true, botId: 'bot-2' })
    })
    it('§1.2.3 a deal that is not the caller’s is 404 and named', () => {
      const r = checkMergeCandidates(ids, A, [deal(A)], false)
      expect(r.ok).to.equal(false)
      if (r.ok) return
      expect(r.status).to.equal(404)
      expect(r.reason).to.contain(B)
    })
    it('§1.2.4 an already merged deal is 409 naming its merged deal', () => {
      const r = checkMergeCandidates(
        ids,
        A,
        [deal(A), deal(B, { status: 'canceled', child: true, parentId: C })],
        false,
      )
      expect(r.ok).to.equal(false)
      if (r.ok) return
      expect(r.status).to.equal(409)
      expect(r.reason).to.contain(`already merged into ${C}`)
    })
    it('§1.2.5 a deal that is not open is 409', () => {
      const r = checkMergeCandidates(
        ids,
        A,
        [deal(A), deal(B, { status: 'start' })],
        false,
      )
      expect(r.ok).to.equal(false)
      if (r.ok) return
      expect(r.status).to.equal(409)
      expect(r.reason).to.contain('start')
    })
    it('§1.2.6 a deal in the other trading context is 400', () => {
      const r = checkMergeCandidates(
        ids,
        A,
        [deal(A), deal(B, { paperContext: true })],
        false,
      )
      expect(r.ok === false && r.status).to.equal(400)
      const paper = checkMergeCandidates(
        ids,
        A,
        [deal(A, { paperContext: true }), deal(B, { paperContext: true })],
        true,
      )
      expect(paper.ok).to.equal(true)
    })
    for (const [name, over] of [
      ['pair', { symbol: { symbol: 'ETHUSDT' } }],
      ['side', { strategy: 'SHORT' }],
      ['exchange account', { exchangeUUID: 'acc-2' }],
    ] as const) {
      it(`§1.2.7 mixed ${name} is 400`, () => {
        const r = checkMergeCandidates(
          ids,
          A,
          [deal(A), deal(B, over as any)],
          false,
        )
        expect(r.ok).to.equal(false)
        if (r.ok) return
        expect(r.status).to.equal(400)
      })
    }
  })

  describe('§1.4 key restrictions see every merged deal', () => {
    // Captured in before(), not at load: another spec may stub these at load
    // time, and restoring a load-time copy would undo that spec's stub.
    let originals: Record<'dca' | 'combo' | 'bot', any>
    const rows: Record<string, any> = {
      [A]: { botId: 'key-bot', paperContext: false },
      [B]: { botId: 'other-bot', paperContext: false },
    }
    before(() => {
      originals = {
        dca: dcaDealsDb.readData,
        combo: comboDealsDb.readData,
        bot: dcaBotDb.readData,
      }
      ;(dcaDealsDb as any).readData = async (q: any) => ({
        status: StatusEnum.ok,
        data: { result: rows[q._id] ?? null },
      })
      ;(comboDealsDb as any).readData = async () => ({
        status: StatusEnum.ok,
        data: { result: null },
      })
      ;(dcaBotDb as any).readData = async () => ({
        status: StatusEnum.ok,
        data: { result: { parentBotId: null } },
      })
    })
    after(() => {
      ;(dcaDealsDb as any).readData = originals.dca
      ;(comboDealsDb as any).readData = originals.combo
      ;(dcaBotDb as any).readData = originals.bot
    })
    const run = async (body: any) => {
      let status = 0
      let payload: any = null
      let passed = false
      const req: any = {
        userData: { id: 'u1', keyBotId: 'key-bot' },
        params: { dealType: 'dca' },
        query: {},
        body,
        method: 'POST',
        route: { path: '/api/v2/deals/:dealType/merge' },
        get: () => undefined,
      }
      const res: any = {
        status(s: number) {
          status = s
          return this
        },
        json(p: any) {
          payload = p
          return this
        },
      }
      await apiKeyRestrictionsMiddleware(req, res, () => {
        passed = true
      })
      return { status, payload, passed }
    }
    it('refuses a bot-restricted key merging another bot’s deal', async () => {
      const r = await run({ dealIds: [A, B] })
      expect(r.passed).to.equal(false)
      expect(r.status).to.equal(403)
      expect(r.payload.reason).to.contain(B)
    })
    it('lets it merge its own bot’s deals', async () => {
      rows[B] = { botId: 'key-bot', paperContext: false }
      const r = await run({ dealIds: [A, B], targetDealId: B })
      expect(r.passed).to.equal(true)
    })
  })
  describe('§1.2.1 / §1.3 the route', () => {
    const calls: any[][] = []
    const fakeBot: any = {
      mergeDeals: async (...args: any[]) => {
        calls.push(args)
        return {
          status: StatusEnum.ok,
          reason: null,
          data: 'Request to merge 2 deals sent',
        }
      },
    }
    const route = v2API(undefined, fakeBot).post.get(
      '/api/v2/deals/:dealType/merge',
    )!
    let original: any
    let stored: any[] = []
    let lastQuery: any = null
    before(() => {
      original = dcaDealsDb.readData
      ;(dcaDealsDb as any).readData = async (q: any) => {
        lastQuery = q
        return { status: StatusEnum.ok, data: { result: stored } }
      }
    })
    after(() => {
      ;(dcaDealsDb as any).readData = original
    })
    const call = async (dealType: string, body: any, paper = false) => {
      let status = 0
      let payload: any = null
      const req: any = {
        userData: { id: 'u1' },
        params: { dealType },
        body,
        paperContext: paper,
      }
      const res: any = {
        status(s: number) {
          status = s
          return this
        },
        json(p: any) {
          payload = p
          return this
        },
      }
      for (const mw of route.middlewares) {
        await new Promise<void>((next) =>
          mw({ ...req, get: () => String(paper) }, res, next),
        )
      }
      await route.handler(req, res)
      return { status, payload }
    }
    it('§1.2.1 combo is refused with a clear 400 and nothing is sent', async () => {
      calls.length = 0
      const r = await call('combo', { dealIds: [A, B] })
      expect(r.status).to.equal(400)
      expect(r.payload.reason).to.equal(
        'Merging deals is not supported for combo deals',
      )
      expect(calls).to.have.length(0)
    })
    it('§1.3 a valid request reaches Bot.mergeDeals with the target bot and options, 202', async () => {
      calls.length = 0
      stored = [deal(A), deal(B)]
      const r = await call('dca', {
        dealIds: [A, B],
        targetDealId: B,
        useTp: true,
        dcaOrders: 2,
      })
      expect(lastQuery).to.deep.include({ userId: 'u1' })
      expect(r.status).to.equal(202)
      expect(r.payload.data).to.include({ botId: 'bot-2', targetDealId: B })
      expect(calls).to.deep.equal([
        ['u1', 'bot-2', [A, B], false, { useTp: true, dcaOrders: 2 }],
      ])
    })
    it('§1.2 a refused check sends nothing', async () => {
      calls.length = 0
      stored = [deal(A), deal(B, { status: 'closed' })]
      const r = await call('dca', { dealIds: [A, B] })
      expect(r.status).to.equal(409)
      expect(calls).to.have.length(0)
    })
    it('§1.3 a refusal from Bot.mergeDeals is a 400', async () => {
      stored = [deal(A), deal(B)]
      fakeBot.mergeDeals = async () => ({
        status: StatusEnum.notok,
        reason: 'Bot not found',
        data: null,
      })
      const r = await call('dca', { dealIds: [A, B] })
      expect(r.status).to.equal(400)
      expect(r.payload.reason).to.equal('Bot not found')
    })
  })
})
