process.env.NODE_ENV = 'testing'

/**
 * `resetShowError` clears the bot error flag on the caller's own bots, routes
 * hedge types to their legs' collections, answers after the writes have been
 * made, and does not let one unusable id stop the rest.
 *
 * Drives the REAL `Mutation.resetShowError` with the real `findUser` against
 * in-memory Mongo (specs/016's harness), the same way `smoke.ts` does.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, before, after, afterEach } from 'mocha'
import { expect } from 'chai'
import { BotStatusEnum, BotType, ExchangeEnum, StatusEnum } from '../../types'
import { userDb, dcaBotDb, comboBotDb, botDb } from '../../src/db/dbInit'
import resolvers from '../../src/graphql/resolvers'

const { Mutation } = resolvers()

const TOKEN_A = 'reset-show-error token a'
const TOKEN_B = 'reset-show-error token b'

type Db = typeof dcaBotDb | typeof comboBotDb | typeof botDb

let botSeq = 0

const createUser = async (token: string, username: string) => {
  const res = await userDb.createData({
    tokens: [
      {
        token,
        expiredAt: Date.now() * 10,
        createdAt: Date.now(),
        source: 'email',
      },
    ],
    timezone: 'UTC',
    username,
    password: 'irrelevant',
    exchanges: [],
    onboardingSteps: {
      signup: true,
      liveExchange: false,
      deployLiveBot: false,
      earnProfit: false,
    },
  } as any)
  expect(res.status).to.equal(StatusEnum.ok)
  return `${res.data!._id}`
}

/** A bot document owned by `userId` whose error flag is set. */
const flaggedBot = async (db: Db, userId: string) => {
  const res = await (db as any).createData({
    userId,
    uuid: `reset-show-error-${++botSeq}`,
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'reset-show-error-exchange',
    status: BotStatusEnum.error,
    // Required by the grid-bot schema only; the other schemas ignore it.
    stats: {
      timeCountStart: 0,
      trackTime: 0,
      timeInLoss: 0,
      timeInProfit: 0,
      runUpPercent: 0,
      drawdownPercent: 0,
    },
    showErrorWarning: 'error',
  })
  expect(res.status, res.reason).to.equal(StatusEnum.ok)
  const id = `${res.data._id}`
  // Precondition: the flag really is stored, so "still 'error'" below cannot
  // pass merely because the field never existed.
  expect(await flagOf(db, id)).to.equal('error')
  return id
}

const flagOf = async (db: Db, id: string) => {
  const res = await (db as any).readData({ _id: id })
  return res.data?.result?.showErrorWarning as string | undefined
}

const reset = (token: string, data: { id: string; type: BotType }[]) =>
  (Mutation as any).resetShowError(
    undefined,
    { input: { data } },
    {
      token,
      req: { cookies: {}, user: { authorized: true, username: token } },
      paperContext: false,
    },
  )

/**
 * The writes were fire-and-forget before this spec, so an assertion that a
 * flag is STILL set would pass just by reading before the write lands. Wait
 * until the caller's own bot (named last) is cleared — every earlier write in
 * the batch has been dispatched by then — and only then check the others.
 */
const waitCleared = async (db: Db, id: string) => {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if ((await flagOf(db, id)) === 'none') return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(await flagOf(db, id), `own bot ${id} was never cleared`).to.equal(
    'none',
  )
}

describe('resetShowError is scoped to the caller', () => {
  let userA: string
  let userB: string

  before(async () => {
    userA = await createUser(TOKEN_A, 'reset-show-error user a')
    userB = await createUser(TOKEN_B, 'reset-show-error user b')
  })

  afterEach(async () => {
    await dcaBotDb.deleteManyData({})
    await comboBotDb.deleteManyData({})
    await botDb.deleteManyData({})
  })

  after(async () => {
    await userDb.deleteManyData({})
  })

  it("§5.1 naming another account's bots leaves their flags set", async () => {
    const otherDca = await flaggedBot(dcaBotDb, userB)
    const otherCombo = await flaggedBot(comboBotDb, userB)
    const otherGrid = await flaggedBot(botDb, userB)
    const ownDca = await flaggedBot(dcaBotDb, userA)

    const res = await reset(TOKEN_A, [
      { id: otherDca, type: BotType.dca },
      { id: otherCombo, type: BotType.combo },
      { id: otherGrid, type: BotType.grid },
      { id: ownDca, type: BotType.dca },
    ])
    expect(res.status).to.equal(StatusEnum.ok)
    await waitCleared(dcaBotDb, ownDca)

    expect(await flagOf(dcaBotDb, otherDca)).to.equal('error')
    expect(await flagOf(comboBotDb, otherCombo)).to.equal('error')
    expect(await flagOf(botDb, otherGrid)).to.equal('error')
  })

  it('§5.2 naming your own bots clears their flags', async () => {
    const dca = await flaggedBot(dcaBotDb, userA)
    const combo = await flaggedBot(comboBotDb, userA)
    const grid = await flaggedBot(botDb, userA)

    const res = await reset(TOKEN_A, [
      { id: dca, type: BotType.dca },
      { id: combo, type: BotType.combo },
      { id: grid, type: BotType.grid },
    ])
    expect(res.status).to.equal(StatusEnum.ok)

    await waitCleared(dcaBotDb, dca)
    await waitCleared(comboBotDb, combo)
    await waitCleared(botDb, grid)
  })

  it("§5.3 hedge types clear your own legs and not another account's", async () => {
    const ownComboLeg = await flaggedBot(comboBotDb, userA)
    const ownDcaLeg = await flaggedBot(dcaBotDb, userA)
    const otherComboLeg = await flaggedBot(comboBotDb, userB)
    const otherDcaLeg = await flaggedBot(dcaBotDb, userB)

    const res = await reset(TOKEN_A, [
      { id: otherComboLeg, type: BotType.hedgeCombo },
      { id: otherDcaLeg, type: BotType.hedgeDca },
      { id: ownComboLeg, type: BotType.hedgeCombo },
      { id: ownDcaLeg, type: BotType.hedgeDca },
    ])
    expect(res.status).to.equal(StatusEnum.ok)

    await waitCleared(comboBotDb, ownComboLeg)
    await waitCleared(dcaBotDb, ownDcaLeg)
    expect(await flagOf(comboBotDb, otherComboLeg)).to.equal('error')
    expect(await flagOf(dcaBotDb, otherDcaLeg)).to.equal('error')
  })

  it('§5.4 an unusable id does not stop the valid ones', async () => {
    const dca = await flaggedBot(dcaBotDb, userA)
    const combo = await flaggedBot(comboBotDb, userA)

    const res = await reset(TOKEN_A, [
      { id: '', type: BotType.dca },
      { id: dca, type: BotType.dca },
      { id: 'not-an-object-id', type: BotType.combo },
      { id: combo, type: BotType.combo },
    ])
    expect(res.status).to.equal(StatusEnum.ok)

    await waitCleared(dcaBotDb, dca)
    await waitCleared(comboBotDb, combo)
  })
})
