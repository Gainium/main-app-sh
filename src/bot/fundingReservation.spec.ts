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
let filters: { coll: string; filter: any }[] = []
const dealsOf: Record<string, any[]> = { dca: [], combo: [] }

const answer = (coll: string) => async (filter: any) => {
  filters.push({ coll, filter })
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

  it('§4.3 without an owner it does not query and answers 0', async () => {
    const r = new FundingReservation()
    expect(await r.reservedQuote('', 'acc-1', 'USDT', true)).to.equal(0)
    expect(await r.reservedBase(undefined, 'acc-1', 'LDO', true)).to.equal(0)
    expect(filters).to.have.length(0)
  })
})
