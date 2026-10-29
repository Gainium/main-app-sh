process.env.NODE_ENV = 'testing'

/**
 * `mergeDeals` only dispatches to a bot the caller owns, and only with deals
 * the caller owns; `getBotEvents` only returns the caller's own events; a
 * saved backtest is owned by the caller whatever `userId` the input names.
 *
 * Drives the real `Bot.mergeDeals` (bot-service side, with a fake worker that
 * records what it is sent) and the real `Query.getBotEvents` with the real
 * `findUser`, against in-memory Mongo (specs/016's harness).
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, before, after, beforeEach } from 'mocha'
import { expect } from 'chai'
import {
  BotStatusEnum,
  BotType,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
} from '../../types'
import {
  userDb,
  dcaBotDb,
  dcaDealsDb,
  botEventDb,
  hedgeDCABotDb,
  backtestDb,
} from '../../src/db/dbInit'
import Bot from '../../src/bot'
import resolvers from '../../src/graphql/resolvers'

const { Query, Mutation } = resolvers()

const TOKEN_A = 'owner-scope token a'
const TOKEN_B = 'owner-scope token b'

let seq = 0

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

const stats = {
  timeCountStart: 0,
  trackTime: 0,
  timeInLoss: 0,
  timeInProfit: 0,
  runUpPercent: 0,
  drawdownPercent: 0,
}

const createDcaBot = async (userId: string) => {
  const res = await (dcaBotDb as any).createData({
    userId,
    uuid: `owner-scope-${++seq}`,
    exchange: ExchangeEnum.binance,
    exchangeUUID: 'owner-scope-exchange',
    status: BotStatusEnum.closed,
    stats,
  })
  expect(res.status, res.reason).to.equal(StatusEnum.ok)
  return `${res.data._id}`
}

const createOpenDeal = async (userId: string, botId: string) => {
  const res = await (dcaDealsDb as any).createData({
    userId,
    botId,
    status: DCADealStatusEnum.open,
    parent: false,
    child: false,
    stats,
  })
  expect(res.status, res.reason).to.equal(StatusEnum.ok)
  return `${res.data._id}`
}

const ctx = (token: string) => ({
  token,
  req: { cookies: {}, user: { authorized: true, username: token } },
  paperContext: false,
})

describe('mergeDeals is scoped to the caller', () => {
  let userA: string
  let userB: string
  let bot: Bot
  let sent: unknown[]

  before(async () => {
    userA = await createUser(TOKEN_A, 'merge-scope user a')
    userB = await createUser(TOKEN_B, 'merge-scope user b')
  })

  beforeEach(async () => {
    await dcaBotDb.deleteManyData({})
    await dcaDealsDb.deleteManyData({})
    sent = []
    bot = new Bot(true)
    ;(bot as any).workers = [
      { id: 1, worker: { postMessage: (m: unknown) => sent.push(m) } },
    ]
  })

  after(async () => {
    await dcaBotDb.deleteManyData({})
    await dcaDealsDb.deleteManyData({})
    await botEventDb.deleteManyData({})
    await userDb.deleteManyData({})
  })

  const runLocally = (botId: string, userId: string) => {
    bot.dcaBots.push({
      id: botId,
      worker: 1,
      userId,
      uuid: 'owner-scope-exchange',
      type: BotType.dca,
      paperContext: false,
    })
  }

  it("refuses another account's running bot and its deals", async () => {
    const botB = await createDcaBot(userB)
    const d1 = await createOpenDeal(userB, botB)
    const d2 = await createOpenDeal(userB, botB)
    runLocally(botB, userB)

    const res = await bot.mergeDeals(userA, botB, [d1, d2], false, {
      useTp: false,
      useSl: false,
    })
    expect(res?.status).to.equal(StatusEnum.notok)
    expect(sent).to.have.length(0)
  })

  it("refuses another account's running bot even with the caller's own deals", async () => {
    const botA = await createDcaBot(userA)
    const botB = await createDcaBot(userB)
    const d1 = await createOpenDeal(userA, botA)
    const d2 = await createOpenDeal(userA, botA)
    runLocally(botB, userB)

    const res = await bot.mergeDeals(userA, botB, [d1, d2], false)
    expect(res?.status).to.equal(StatusEnum.notok)
    expect(sent).to.have.length(0)
  })

  it("refuses the caller's own bot when a deal belongs to someone else", async () => {
    const botA = await createDcaBot(userA)
    const botB = await createDcaBot(userB)
    const own = await createOpenDeal(userA, botA)
    const other = await createOpenDeal(userB, botB)
    runLocally(botA, userA)

    const res = await bot.mergeDeals(userA, botA, [own, other], false)
    expect(res?.status).to.equal(StatusEnum.notok)
    expect(sent).to.have.length(0)
  })

  it("dispatches for the caller's own bot and deals", async () => {
    const botA = await createDcaBot(userA)
    const d1 = await createOpenDeal(userA, botA)
    const d2 = await createOpenDeal(userA, botA)
    runLocally(botA, userA)

    const res = await bot.mergeDeals(userA, botA, [d1, d2], false)
    expect(res?.status).to.equal(StatusEnum.ok)
    expect(sent).to.have.length(1)
    expect((sent[0] as any).method).to.equal('mergeDeals')
    expect((sent[0] as any).botId).to.equal(botA)
  })
})

describe('getBotEvents is scoped to the caller', () => {
  let userA: string
  let userB: string

  before(async () => {
    userA = await createUser(`${TOKEN_A} events`, 'events-scope user a')
    userB = await createUser(`${TOKEN_B} events`, 'events-scope user b')
  })

  after(async () => {
    await botEventDb.deleteManyData({})
    await hedgeDCABotDb.deleteManyData({})
    await userDb.deleteManyData({})
  })

  const event = (userId: string, botId: string) =>
    (botEventDb as any).createData({
      userId,
      botId,
      botType: BotType.dca,
      event: 'owner-scope event',
      deal: 'owner-scope-deal',
    })

  const events = (token: string, input: Record<string, unknown>) =>
    (Query as any).getBotEvents(
      undefined,
      { input: { pageSize: 100, ...input } },
      ctx(token),
    )

  it("returns nothing for another account's bot", async () => {
    const botId = 'owner-scope-bot-b'
    await event(userB, botId)
    await event(userB, botId)

    const res = await events(`${TOKEN_A} events`, {
      botId,
      category: 'recent',
    })
    expect(res.status).to.equal(StatusEnum.ok)
    expect(res.data).to.have.length(0)
    expect(res.counts).to.deep.equal({ recent: 0, deals: 0, alerts: 0 })

    const own = await events(`${TOKEN_B} events`, { botId })
    expect(own.status).to.equal(StatusEnum.ok)
    expect(own.data).to.have.length(2)
  })

  it("does not expand another account's hedge bot", async () => {
    const child = '64b0000000000000000000cc'
    await event(userB, child)
    const hedge = await (hedgeDCABotDb as any).createData({
      userId: userB,
      uuid: `owner-scope-${++seq}`,
      exchangeUUID: 'owner-scope-exchange',
      bots: [child],
      stats,
    })
    expect(hedge.status, hedge.reason).to.equal(StatusEnum.ok)
    const hedgeId = `${hedge.data._id}`

    const res = await events(`${TOKEN_A} events`, {
      botId: hedgeId,
      hedge: true,
    })
    expect(res.status).to.equal(StatusEnum.notok)

    const own = await events(`${TOKEN_B} events`, {
      botId: hedgeId,
      hedge: true,
    })
    expect(own.status, own.reason).to.equal(StatusEnum.ok)
    expect(own.data).to.have.length(1)
    expect(userA).to.be.a('string')
  })
})

describe('saveBacktest owns the result by the caller', () => {
  let userA: string
  let userB: string

  before(async () => {
    userA = await createUser(`${TOKEN_A} backtest`, 'backtest-scope user a')
    userB = await createUser(`${TOKEN_B} backtest`, 'backtest-scope user b')
  })

  after(async () => {
    await backtestDb.deleteManyData({})
    await userDb.deleteManyData({})
  })

  it('ignores a client-supplied userId and _id', async () => {
    const forgedId = '64b000000000000000000001'
    const res = await (Mutation as any).saveBacktest(
      undefined,
      { input: { userId: userB, _id: forgedId, savePermanent: false } },
      ctx(`${TOKEN_A} backtest`),
    )
    expect(res.status, res.reason).to.equal(StatusEnum.ok)
    expect(res.data).to.not.equal(forgedId)
    const saved = await (backtestDb as any).readData({ _id: res.data })
    expect(saved.data?.result?.userId).to.equal(userA)
    const forUserB = await (backtestDb as any).readData(
      { userId: userB },
      undefined,
      {},
      true,
    )
    expect(forUserB.data?.result).to.have.length(0)
  })
})
