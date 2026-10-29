process.env.NODE_ENV = 'testing'

/**
 * Spec 171 — the funding-reservation read must be scoped to the account
 * owner, so it is served by the deals collections' `userId` indexes instead
 * of a full collection scan on every new-deal balance check.
 *
 * Run: `npm test` (mocha), or this file alone:
 * `NODE_ENV=testing npx mocha --timeout 20000 --exit -r ts-node/register src/bot/fundingReservation.spec.ts`
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../types'

const load = createRequire(__filename)
const dbInit = load('../db/dbInit')
const { FundingReservation } = load('./fundingReservation')

let saved: Record<string, any> = {}
let filters: { coll: string; filter: any; options: any }[] = []
let probes: { coll: string; filter: any; options: any }[] = []
const dealsOf: Record<string, any[]> = { dca: [], combo: [] }
/** Whether the stamped-deal probe finds one, per collection. */
const stampedIn: Record<string, boolean> = { dca: true, combo: false }
let probeFails = false
/** Collections whose full reservation read fails. */
let readFails = new Set<string>()

const answer =
  (coll: string) =>
  async (filter: any, _fields: any, options: any, isArray?: boolean) => {
    if (!isArray) {
      probes.push({ coll, filter, options })
      if (probeFails) {
        return {
          status: StatusEnum.notok,
          reason: 'operation exceeded time limit',
        }
      }
      return {
        status: StatusEnum.ok,
        data: { result: stampedIn[coll] ? { _id: `${coll}-1` } : undefined },
      }
    }
    filters.push({ coll, filter, options })
    if (readFails.has(coll)) {
      return {
        status: StatusEnum.notok,
        reason: 'operation exceeded time limit',
      }
    }
    return { status: StatusEnum.ok, data: { result: dealsOf[coll] } }
  }

describe('FundingReservation read (spec 171)', () => {
  before(() => {
    saved = {
      dca: dbInit.dcaDealsDb.readData,
      combo: dbInit.comboDealsDb.readData,
      order: dbInit.orderDb.readData,
    }
    dbInit.dcaDealsDb.readData = answer('dca')
    dbInit.comboDealsDb.readData = answer('combo')
    dbInit.orderDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: [] },
    })
  })
  after(() => {
    dbInit.dcaDealsDb.readData = saved.dca
    dbInit.comboDealsDb.readData = saved.combo
    dbInit.orderDb.readData = saved.order
  })
  beforeEach(() => {
    filters = []
    probes = []
    stampedIn.dca = true
    stampedIn.combo = false
    probeFails = false
    readFails = new Set()
    dealsOf.dca = []
    dealsOf.combo = []
  })

  it('§4.1 scopes both deal reads to the account owner (quote side)', async () => {
    await new FundingReservation().reservedQuote('u1', 'acc-1', 'USDT', true)
    expect(filters.map((f) => f.coll).sort()).to.deep.equal(['combo', 'dca'])
    for (const { filter } of filters) {
      expect(filter.userId).to.equal('u1')
      expect(filter.exchangeUUID).to.equal('acc-1')
      expect(filter['symbol.quoteAsset']).to.equal('USDT')
      expect(filter.status).to.have.property('$in')
    }
  })

  it('reads only stamped deals, bounded by maxTimeMS (2026-10-18 incident)', async () => {
    await new FundingReservation().reservedQuote('u1', 'acc-1', 'USDT', true)
    expect(filters).to.have.length(2)
    for (const { filter, options } of filters) {
      expect(filter.baseFundingBeta).to.equal(true)
      expect(options.maxTimeMS).to.be.a('number').and.to.be.at.most(5000)
    }
    for (const { filter, options } of probes) {
      expect(filter).to.deep.include({
        exchangeUUID: 'acc-1',
        userId: 'u1',
        baseFundingBeta: true,
      })
      expect(options.maxTimeMS).to.be.a('number')
    }
  })

  it('a user with no stamped deal answers 0 without the full read', async () => {
    stampedIn.dca = false
    stampedIn.combo = false
    const r = new FundingReservation()
    expect(await r.reservedQuote('u2', 'acc-2', 'USDT')).to.equal(0)
    expect(await r.reservedBase('u2', 'acc-2', 'BTC')).to.equal(0)
    expect(filters).to.have.length(0)
    // The "no stamped deals" answer is cached: the second side did not probe.
    expect(probes).to.have.length(2)
  })

  it('a failed probe falls through to the bounded full read', async () => {
    probeFails = true
    dealsOf.dca = [
      { _id: 'd1', botFunding: { virtualEntry: { quoteReserved: 12 } } },
    ]
    const v = await new FundingReservation().reservedQuote(
      'u1',
      'acc-1',
      'USDT',
      true,
    )
    expect(v).to.equal(12)
    expect(filters).to.have.length(2)
  })

  it('invalidate() forgets the cached "no stamped deals" answer', async () => {
    stampedIn.dca = false
    const r = new FundingReservation()
    expect(await r.reservedQuote('u3', 'acc-3', 'USDT')).to.equal(0)
    stampedIn.dca = true
    dealsOf.dca = [
      { _id: 'd1', botFunding: { virtualEntry: { quoteReserved: 5 } } },
    ]
    r.invalidate('acc-3', 'USDT')
    expect(await r.reservedQuote('u3', 'acc-3', 'USDT')).to.equal(5)
  })

  it('§4.1 scopes both deal reads to the account owner (base side)', async () => {
    await new FundingReservation().reservedBase('u1', 'acc-1', 'LDO', true)
    expect(filters).to.have.length(2)
    for (const { filter } of filters) {
      expect(filter.userId).to.equal('u1')
      expect(filter['symbol.baseAsset']).to.equal('LDO')
    }
  })

  it('§4.2 the reserved figure is unchanged', async () => {
    dealsOf.dca = [
      { _id: 'd1', botFunding: { virtualEntry: { baseReserved: 30 } } },
      { _id: 'd2', fundingHold: { asset: 'base', remaining: 5 } },
    ]
    dealsOf.combo = [
      { _id: 'c1', botFunding: { virtualEntry: { baseReserved: 7 } } },
    ]
    const v = await new FundingReservation().reservedBase(
      'u1',
      'acc-1',
      'LDO',
      true,
    )
    expect(v).to.equal(42)
  })

  it('a failed read answers unknown (null), not 0', async () => {
    dealsOf.dca = [
      { _id: 'd1', botFunding: { virtualEntry: { quoteReserved: 800 } } },
    ]
    readFails = new Set(['dca', 'combo'])
    const r = new FundingReservation()
    expect(await r.reservedQuote('u1', 'acc-1', 'USDT')).to.equal(null)
    expect(await r.reservedQuote('u1', 'acc-1', 'USDT', true)).to.equal(null)
  })

  it('one failed collection is not a partial sum', async () => {
    dealsOf.dca = [
      { _id: 'd1', botFunding: { virtualEntry: { quoteReserved: 800 } } },
    ]
    dealsOf.combo = [
      { _id: 'c1', botFunding: { virtualEntry: { quoteReserved: 300 } } },
    ]
    stampedIn.combo = true
    readFails = new Set(['combo'])
    const v = await new FundingReservation().reservedQuote(
      'u1',
      'acc-1',
      'USDT',
      true,
    )
    expect(v).to.equal(null)
  })

  it('an unknown answer is not cached', async () => {
    dealsOf.dca = [
      { _id: 'd1', botFunding: { virtualEntry: { quoteReserved: 800 } } },
    ]
    readFails = new Set(['dca'])
    const r = new FundingReservation()
    expect(await r.reservedQuote('u1', 'acc-1', 'USDT')).to.equal(null)
    readFails = new Set()
    // Inside the TTL, not fresh: read again, not served from the cache.
    expect(await r.reservedQuote('u1', 'acc-1', 'USDT')).to.equal(800)
  })

  it('§4.3 without an owner it does not query and answers 0', async () => {
    const r = new FundingReservation()
    expect(await r.reservedQuote('', 'acc-1', 'USDT', true)).to.equal(0)
    expect(await r.reservedBase(undefined, 'acc-1', 'LDO', true)).to.equal(0)
    expect(filters).to.have.length(0)
  })
})
