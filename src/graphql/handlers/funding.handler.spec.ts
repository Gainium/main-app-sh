process.env.NODE_ENV = 'testing'

/**
 * `previewHedgeFunding` (main-app spec 044 §8) — the hedge start dialog's
 * joint plan. The handler's reads (pair, balances, fee, reservations) are
 * answered by stubs; the planner is real.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, after, afterEach } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { StatusEnum } from '../../../types'

const load = createRequire(__filename)
const dbInit = load('../../db/dbInit')
const balanceHandler = load('./balance.handler')
const { FundingReservation } = load('../../bot/fundingReservation')
const { previewHedgeFunding, previewFunding, baseFundingAccess } =
  load('./funding.handler')
const { BaseFundingGate } = load('../../bot/baseFundingGate')
const { createRoleReader } = load('../../utils/roleGate')
// Spec 044 beta gate: the session user holds the role unless a test says not.
let roles: Record<string, string[]> = { u1: ['BaseFundingBeta'] }

// Captured in `before`, not at load: other specs install root-level stubs
// (e.g. on `pairDb.readData`) that must be put back as they were.
let saved: Record<string, any> = {}

const user: any = { _id: 'u1', exchanges: [{ uuid: 'acc-1' }] }
let free = { SOL: 0, USDT: 0 }
let reserved = { quote: 0, base: 0 }

const legs = (over: any[] = [{}, {}]) => [
  {
    side: 'LONG',
    action: 'sellDiff',
    baseOrderQty: 1,
    safetyQty: 2,
    safetyQuote: 200,
    useDca: true,
    ...over[0],
  },
  {
    side: 'SHORT',
    action: 'buyDiff',
    baseOrderQty: 1,
    safetyQty: 2,
    safetyQuote: 200,
    useDca: true,
    ...over[1],
  },
]

const input = (l = legs()) => ({
  exchangeUUID: 'acc-1',
  exchange: 'binance',
  pair: 'SOLUSDT',
  price: 100,
  legs: l,
})

describe('previewHedgeFunding (main-app spec 044 §8)', () => {
  before(() => {
    saved = {
      pair: dbInit.pairDb.readData,
      fee: dbInit.feeDb.readData,
      balances: balanceHandler.getBalances,
      rq: FundingReservation.prototype.reservedQuote,
      rb: FundingReservation.prototype.reservedBase,
    }
    dbInit.pairDb.readData = async () => ({
      status: StatusEnum.ok,
      data: {
        result: {
          baseAsset: { name: 'SOL', minAmount: 0.001, step: 0.001 },
          quoteAsset: { name: 'USDT', minAmount: 5, step: 0.01 },
        },
      },
    })
    dbInit.feeDb.readData = async () => ({
      status: StatusEnum.ok,
      data: { result: { taker: 0 } },
    })
    balanceHandler.getBalances = async () => ({
      status: StatusEnum.ok,
      data: [
        { asset: 'SOL', free: `${free.SOL}` },
        { asset: 'USDT', free: `${free.USDT}` },
      ],
    })
    BaseFundingGate.getInstance().setRoleReader(
      createRoleReader(async (id: string) => roles[id], 0),
    )
    FundingReservation.prototype.reservedQuote = async () => reserved.quote
    FundingReservation.prototype.reservedBase = async () => reserved.base
  })
  after(() => {
    dbInit.pairDb.readData = saved.pair
    dbInit.feeDb.readData = saved.fee
    balanceHandler.getBalances = saved.balances
    FundingReservation.prototype.reservedQuote = saved.rq
    FundingReservation.prototype.reservedBase = saved.rb
  })

  it('plans both start orders; a funded short and a long on held quote', async () => {
    free = { SOL: 0, USDT: 1000 }
    reserved = { quote: 0, base: 0 }
    const r: any = await previewHedgeFunding(user, input())
    expect(r.status).to.equal(StatusEnum.ok)
    expect(r.data).to.deep.include({
      baseAsset: 'SOL',
      quoteAsset: 'USDT',
      freeBase: 0,
      freeQuote: 1000,
      reservedQuote: 0,
      reservedBase: 0,
    })
    const [short, long] = r.data.legs
    expect(short).to.deep.include({
      side: 'SHORT',
      action: 'buyDiff',
      kind: 'fund',
      tradeSide: 'BUY',
      tradeBaseQty: 2,
      tradeQuote: 200,
      required: 2,
      needAsset: 'SOL',
      reservedForEntry: 100,
    })
    // Its quote covers base order + safety orders in either order: no
    // funding trade, a real base order on held funds.
    expect(long).to.deep.include({
      side: 'LONG',
      kind: 'none',
      required: 300,
      needAsset: 'USDT',
    })
  })

  it('a leg refused in either start order says why', async () => {
    free = { SOL: 0, USDT: 400 }
    const r: any = await previewHedgeFunding(user, input())
    const long = r.data.legs.find((l: any) => l.side === 'LONG')
    expect(long.kind).to.equal('refuse')
    expect(long.message).to.match(/Not enough SOL for this leg/)
  })

  it('a combo short leg includes the engine’s per-level padding', async () => {
    free = { SOL: 0, USDT: 1000 }
    reserved = { quote: 0, base: 0 }
    const r: any = await previewHedgeFunding(
      user,
      input(legs([{}, { comboGridLevel: 5, safetyLevels: 2 }])),
    )
    const short = r.data.legs.find((l: any) => l.side === 'SHORT')
    // 2 + 2 levels × 0.001 step × gridLevel 5
    expect(short.required).to.equal(2.01)
    expect(short.tradeBaseQty).to.equal(2.01)
  })

  it('account reservations are reported and applied', async () => {
    free = { SOL: 0, USDT: 350 }
    reserved = { quote: 100, base: 0.5 }
    const r: any = await previewHedgeFunding(
      user,
      input(legs([{ useDca: false }, {}])),
    )
    expect(r.data.reservedQuote).to.equal(100)
    expect(r.data.reservedBase).to.equal(0.5)
    const [short, long] = r.data.legs
    // 300 needed (100 reserve + 200 buy), 250 left after the reservation.
    expect(short.kind).to.equal('refuse')
    expect(long.kind).to.equal('none')
  })

  it('rejects an unknown side or action, and an account not the user’s', async () => {
    expect(
      (
        (await previewHedgeFunding(
          user,
          input(legs([{ side: 'UP' }, {}])),
        )) as any
      ).status,
    ).to.equal(StatusEnum.notok)
    expect(
      (
        (await previewHedgeFunding(
          user,
          input(legs([{ action: 'buyAll' }, {}])),
        )) as any
      ).status,
    ).to.equal(StatusEnum.notok)
    expect(
      (
        (await previewHedgeFunding(user, {
          ...input(),
          exchangeUUID: 'other',
        })) as any
      ).status,
    ).to.equal(StatusEnum.notok)
  })

  describe('beta gate', () => {
    afterEach(() => {
      roles = { u1: ['BaseFundingBeta'] }
    })

    it('previews refuse a user without the role, with no data', async () => {
      roles = { u1: ['Alpha'] }
      const hedge: any = await previewHedgeFunding(user, input())
      expect(hedge).to.deep.equal({
        status: StatusEnum.notok,
        reason: 'Base funding is not available for your account yet.',
        data: null,
      })
      const single: any = await previewFunding(user, {
        exchangeUUID: 'acc-1',
        exchange: 'binance',
        pair: 'SOLUSDT',
        mode: 'auto',
        baseOrderQty: 1,
        safetyQty: 2,
        price: 100,
      })
      expect(single.status).to.equal(StatusEnum.notok)
      expect(single.data).to.equal(null)
    })

    it('baseFundingAccess answers per role and never fails', async () => {
      expect(await baseFundingAccess('u1')).to.deep.equal({ available: true })
      roles = { u1: [] }
      expect(await baseFundingAccess('u1')).to.deep.equal({ available: false })
      expect(await baseFundingAccess(undefined)).to.deep.equal({
        available: false,
      })
    })
  })
})
