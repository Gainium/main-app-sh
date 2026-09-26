process.env.NODE_ENV = 'testing'

/**
 * Large account service (main-app spec 019 §2.4): counts per context, TTL
 * cache + persisted hysteresis memory, invalidation, and the user switch.
 * Collections are stubbed; no Mongo.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import {
  botDb,
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
  hedgeComboBotDb,
  hedgeDCABotDb,
  userDb,
} from '../../db/dbInit'
import {
  LARGE_ACCOUNT_TTL_MS,
  LargeAccountService,
} from './largeAccountService'

const dbs: Record<string, any> = {
  dcaBotDb,
  comboBotDb,
  botDb,
  hedgeDCABotDb,
  hedgeComboBotDb,
  dcaDealsDb,
  comboDealsDb,
}

describe('large account service (spec 019 §2.4)', () => {
  const svc = LargeAccountService.getInstance()
  const originals: Record<string, any> = {}
  let countCalls: { db: string; filter: any }[] = []
  let countsByDb: Record<string, number> = {}
  let user: any
  let userWrites: any[] = []

  before(() => {
    for (const [name, db] of Object.entries(dbs)) {
      originals[name] = db.countData
      db.countData = (filter: any) => {
        countCalls.push({ db: name, filter })
        const isTerminal = filter['settings.type'] === 'terminal'
        const key = isTerminal ? 'terminal' : name
        return Promise.resolve({
          status: 'OK',
          data: { result: countsByDb[key] ?? 0 },
        })
      }
    }
    originals.userRead = (userDb as any).readData
    originals.userUpdate = (userDb as any).updateData
    ;(userDb as any).readData = () =>
      Promise.resolve({ status: 'OK', data: { result: user } })
    ;(userDb as any).updateData = (_f: any, update: any) => {
      userWrites.push(update)
      const set = update.$set
      for (const [k, v] of Object.entries(set)) {
        if (k.startsWith('largeAccountStats.')) {
          user.largeAccountStats = {
            ...(user.largeAccountStats ?? {}),
            [k.split('.')[1]]: v,
          }
        } else {
          user[k] = v
        }
      }
      return Promise.resolve({ status: 'OK', data: {} })
    }
  })
  after(() => {
    for (const [name, db] of Object.entries(dbs)) db.countData = originals[name]
    ;(userDb as any).readData = originals.userRead
    ;(userDb as any).updateData = originals.userUpdate
  })
  beforeEach(() => {
    countCalls = []
    userWrites = []
    countsByDb = {}
    user = { _id: 'u' }
    svc.invalidate('u')
  })

  it('sums active bots across all bot types and open deals across DCA + combo', async () => {
    countsByDb = {
      dcaBotDb: 300,
      comboBotDb: 50,
      botDb: 40,
      hedgeDCABotDb: 5,
      hedgeComboBotDb: 5,
      dcaDealsDb: 700,
      comboDealsDb: 10,
      terminal: 12,
    }
    const view = await svc.getLargeAccount('u', false, 1_000_000)
    expect(view?.counts).to.deep.equal({
      activeBots: 400,
      openDeals: 710,
      terminalBots: 12,
    })
    expect(view?.active).to.equal(true)
    expect(view?.reason).to.equal('bots')
    expect(view?.source).to.equal('auto')
    expect(view?.canUserEnable).to.equal(true)
    expect(
      countCalls.every((c) => c.filter.paperContext.$ne === true),
    ).to.equal(true)
  })

  it('counts open deals with status open exactly (partial-index shape)', async () => {
    await svc.getLargeAccount('u', true, 1_000_000)
    const deal = countCalls.find((c) => c.db === 'dcaDealsDb')
    expect(deal?.filter.status).to.equal('open')
    expect(deal?.filter.paperContext).to.deep.equal({ $eq: true })
  })

  it('serves a fresh persisted value without counting, recounts after the TTL', async () => {
    user.largeAccountStats = {
      live: {
        activeBots: 350,
        openDeals: 0,
        terminalBots: 0,
        autoActive: true,
        computedAt: new Date(1_000_000),
      },
    }
    ;(svc as any).dirty.clear()
    const view = await svc.getLargeAccount('u', false, 1_000_000 + 1000)
    expect(countCalls).to.have.length(0)
    expect(view?.active, 'hysteresis keeps 350 active').to.equal(true)

    countsByDb = { dcaBotDb: 330 }
    const later = await svc.getLargeAccount(
      'u',
      false,
      1_000_000 + LARGE_ACCOUNT_TTL_MS + 1,
    )
    expect(countCalls.length).to.be.greaterThan(0)
    expect(later?.active, '330 ≥ leave 320 while previously active').to.equal(
      true,
    )
    countsByDb = { dcaBotDb: 300 }
    const leaving = await svc.getLargeAccount(
      'u',
      false,
      1_000_000 + 2 * LARGE_ACCOUNT_TTL_MS + 2,
    )
    expect(leaving?.active).to.equal(false)
  })

  it('invalidate forces a recount even when the persisted value is fresh', async () => {
    await svc.getLargeAccount('u', false, 1_000_000)
    const before = countCalls.length
    await svc.getLargeAccount('u', false, 1_000_001)
    expect(countCalls.length, 'cached').to.equal(before)
    svc.invalidate('u')
    await svc.getLargeAccount('u', false, 1_000_002)
    expect(countCalls.length).to.be.greaterThan(before)
  })

  it('override on/off wins over the counts', async () => {
    user.largeAccountOverride = 'on'
    user.largeAccountOverrideBy = 'admin'
    const on = await svc.getLargeAccount('u', false, 1_000_000)
    expect(on).to.include({
      active: true,
      source: 'override',
      reason: 'override',
      overrideBy: 'admin',
      canUserEnable: false,
      canUserRevert: false,
    })
    user.largeAccountOverride = 'off'
    countsByDb = { dcaBotDb: 5000 }
    svc.invalidate('u')
    const off = await svc.getLargeAccount('u', false, 1_000_000)
    expect(off?.active).to.equal(false)
  })

  it('a user may switch on and back to auto, never off', async () => {
    const on = await svc.setUserMode('u', 'on', false)
    expect(on.status).to.equal('OK')
    expect(user.largeAccountOverride).to.equal('on')
    expect(user.largeAccountOverrideBy).to.equal('user')
    expect(on.data?.canUserRevert).to.equal(true)

    const off = await svc.setUserMode('u', 'off', false)
    expect(off.status).to.equal('NOTOK')
    expect(user.largeAccountOverride).to.equal('on')

    const auto = await svc.setUserMode('u', 'auto', false)
    expect(auto.status).to.equal('OK')
    expect(user.largeAccountOverride).to.equal('auto')
  })
})
