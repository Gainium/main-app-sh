process.env.NODE_ENV = 'testing'

/**
 * Change trail (main-app spec 021 §9): every deal settings change records who
 * made it and the before/after values, and a failed trail write never blocks
 * the change itself.
 *
 * The real API-layer methods are driven off the prototype with fake
 * collections and a fake worker: no Mongo, no worker threads. Fixture ids are
 * synthetic — this file is public.
 *
 * Run: `cd core && npm test`
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import Bot from './index'
import { settingsChanges, resolveChangeTrailActor } from './changeTrail'
import { DCADealStatusEnum, StatusEnum } from '../../types'

const USER_ID = 'user-021'
const BOT_ID = 'bot-021'
const DEAL_ID = 'deal-021'

const flush = () => new Promise((r) => setImmediate(r))

type Seen = { trail: any[]; posted: any[]; events: any[] }

const harness = (trailWrite: 'ok' | 'reject' | 'throw' = 'ok') => {
  const seen: Seen = { trail: [], posted: [], events: [] }
  const deal = {
    _id: DEAL_ID,
    userId: USER_ID,
    botId: BOT_ID,
    status: DCADealStatusEnum.open,
    paperContext: true,
    symbol: { symbol: 'ETH-USDC' },
    settings: { tpPerc: '2', useSl: false, slPerc: '-5' },
  }
  const dealsDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: deal },
    }),
  }
  const bot: any = Object.create((Bot as any).prototype)
  bot.useBots = true
  bot.dcaDealsDb = dealsDb
  bot.comboDealsDb = dealsDb
  bot.dcaBotDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: { result: { _id: BOT_ID } },
    }),
  }
  bot.comboBotDb = bot.dcaBotDb
  bot.dcaBots = [{ id: BOT_ID, userId: USER_ID, worker: 'w1' }]
  bot.comboBots = [{ id: BOT_ID, userId: USER_ID, worker: 'w1' }]
  bot.getWorkerById = () => ({
    postMessage: (m: any) => seen.posted.push(m),
  })
  bot.botEventDb = {
    createData: async (d: any) => {
      seen.events.push(d)
      return { status: StatusEnum.ok, reason: null, data: d }
    },
  }
  bot.changeTrailDb = {
    createData: (d: any) => {
      if (trailWrite === 'throw') {
        throw new Error('trail store down')
      }
      if (trailWrite === 'reject') {
        return Promise.reject(new Error('trail store down'))
      }
      seen.trail.push(d)
      return Promise.resolve({ status: StatusEnum.ok, reason: null, data: d })
    },
  }
  bot.seen = seen
  return bot
}

describe('change trail (spec 021 §9)', () => {
  describe('settingsChanges', () => {
    it('lists only the paths the patch changes, with their prior value', () => {
      expect(
        settingsChanges(
          { tpPerc: '2', useSl: false, slPerc: '-5' },
          { tpPerc: '1.2', useSl: false, trailingTp: true, slPerc: undefined },
        ),
      ).to.deep.equal([
        { path: 'tpPerc', before: '2', after: '1.2' },
        { path: 'trailingTp', before: null, after: true },
      ])
    })
    it('defaults the actor to the user', () => {
      expect(resolveChangeTrailActor()).to.deep.equal({ type: 'user' })
      expect(resolveChangeTrailActor({ type: 'api' })).to.deep.equal({
        type: 'api',
      })
    })
  })

  for (const method of [
    'updateDCADealSettings',
    'updateComboDealSettings',
  ] as const) {
    describe(`§9.2 Bot.${method}`, () => {
      it('writes a deal trail entry with before/after and the default user actor', async () => {
        const bot = harness()
        const res = await bot[method](USER_ID, '', DEAL_ID, { tpPerc: '1.2' })
        await flush()
        expect(res.status).to.equal(StatusEnum.ok)
        expect(bot.seen.trail).to.have.length(1)
        expect(bot.seen.trail[0]).to.deep.include({
          userId: USER_ID,
          botId: BOT_ID,
          dealId: DEAL_ID,
          scope: 'deal',
          action: 'update_settings',
          actor: { type: 'user' },
          changes: [{ path: 'tpPerc', before: '2', after: '1.2' }],
          paperContext: true,
        })
      })

      it('records the actor the caller passes', async () => {
        const bot = harness()
        await bot[method](
          USER_ID,
          '',
          DEAL_ID,
          { tpPerc: '1.2' },
          {
            type: 'ai',
            decisionId: 'd-1',
          },
        )
        await flush()
        expect(bot.seen.trail[0].actor).to.deep.equal({
          type: 'ai',
          decisionId: 'd-1',
        })
      })

      it('lets the caller override the action and set a reason (a revert)', async () => {
        const bot = harness()
        await bot[method](
          USER_ID,
          '',
          DEAL_ID,
          { tpPerc: '3' },
          { type: 'user', decisionId: 'd-2' },
          { action: 'revert', reason: 'Reverts change t-1' },
        )
        await flush()
        expect(bot.seen.trail[0]).to.deep.include({
          action: 'revert',
          actor: { type: 'user', decisionId: 'd-2' },
          reason: 'Reverts change t-1',
        })
      })

      it('forwards the override to the bot service when bots run elsewhere', async () => {
        const bot = harness()
        bot.useBots = false
        let payload: unknown[] = []
        bot.callExternalBotService = async (
          _t: unknown,
          _m: unknown,
          _i: unknown,
          ...p: unknown[]
        ) => {
          payload = p
          return { status: StatusEnum.ok, reason: null, data: '' }
        }
        const opts = { action: 'revert' as const }
        await bot[method](USER_ID, '', DEAL_ID, {}, { type: 'ai' }, opts)
        expect(payload[payload.length - 1]).to.equal(opts)
      })

      for (const failure of ['reject', 'throw'] as const) {
        it(`a trail write that fails (${failure}) does not block the change`, async () => {
          const bot = harness(failure)
          const res = await bot[method](USER_ID, '', DEAL_ID, { tpPerc: '1.2' })
          await flush()
          expect(res.status).to.equal(StatusEnum.ok)
          expect(
            bot.seen.posted.map((p: any) => p.method),
            'the change still reached the worker',
          ).to.include('updateDealSettings')
        })
      }
    })
  }

  it('§9.2 closeDCADeal records the close request', async () => {
    const bot = harness()
    await bot.closeDCADeal(
      USER_ID,
      '',
      DEAL_ID,
      undefined,
      true,
      true,
      undefined,
      { type: 'api' },
    )
    await flush()
    expect(bot.seen.trail).to.have.length(1)
    expect(bot.seen.trail[0]).to.deep.include({
      scope: 'deal',
      action: 'close_deal',
      dealId: DEAL_ID,
      actor: { type: 'api' },
    })
  })

  it('§9.2 the public REST v2 API labels its changes as api', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'v2', 'api.ts'),
      'utf8',
    )
    for (const call of [
      /Bot\.updateComboDealSettings\([^)]*apiActor/,
      /Bot\.updateDCADealSettings\([^)]*apiActor/,
    ]) {
      expect(src).to.match(call)
    }
  })
})
