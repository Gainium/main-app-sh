process.env.NODE_ENV = 'testing'

/**
 * A restricted API key is held to the bot or deal a request acts on, not only
 * to what the request headers and route params say.
 *
 * Drives the real `apiKeyRestrictionsMiddleware` with stored bots and deals in
 * in-memory Mongo (specs/016's harness).
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  StatusEnum,
} from '../../types'
import { dcaBotDb, dcaDealsDb } from '../../src/db/dbInit'
import { apiKeyRestrictionsMiddleware } from '../../src/server/v2/middleware'
// Brings in the `req.userData` typing the middleware reads.
import type {} from '../../src/server/api'

const USER = '64b0000000000000000000aa'
const OTHER_USER = '64b0000000000000000000bb'

let seq = 0

const stats = {
  timeCountStart: 0,
  trackTime: 0,
  timeInLoss: 0,
  timeInProfit: 0,
  runUpPercent: 0,
  drawdownPercent: 0,
}

const createBot = async (userId: string, paper: boolean) => {
  const res = await (dcaBotDb as any).createData({
    userId,
    uuid: `key-restrictions-${++seq}`,
    exchange: paper ? ExchangeEnum.paperBinance : ExchangeEnum.binance,
    exchangeUUID: 'key-restrictions-exchange',
    paperContext: paper,
    status: BotStatusEnum.closed,
    stats,
  })
  expect(res.status, res.reason).to.equal(StatusEnum.ok)
  return `${res.data._id}`
}

const createDeal = async (userId: string, botId: string, paper: boolean) => {
  const res = await (dcaDealsDb as any).createData({
    userId,
    botId,
    status: DCADealStatusEnum.open,
    exchange: paper ? ExchangeEnum.paperBinance : ExchangeEnum.binance,
    paperContext: paper,
    parent: false,
    child: false,
    stats,
  })
  expect(res.status, res.reason).to.equal(StatusEnum.ok)
  return `${res.data._id}`
}

type Key = { keyPaperContext?: boolean; keyBotId?: string }

const run = async (
  key: Key,
  request: {
    method?: string
    routePath?: string
    params?: Record<string, unknown>
    query?: Record<string, unknown>
    body?: Record<string, unknown>
    paperHeader?: boolean
  },
) => {
  let nextCalled = false
  let status = 200
  const req: any = {
    method: request.method ?? 'POST',
    route: { path: request.routePath ?? '/api/v2/test' },
    params: request.params ?? {},
    query: request.query ?? {},
    body: request.body ?? {},
    userData: { id: USER, secret: '', permission: 'write', ...key },
    get: (name: string) =>
      name === 'paper-context' && request.paperHeader ? 'true' : undefined,
  }
  const res: any = {
    status: (s: number) => {
      status = s
      return res
    },
    json: () => res,
  }
  await apiKeyRestrictionsMiddleware(req, res, () => {
    nextCalled = true
  })
  return { allowed: nextCalled, status }
}

describe('API key restrictions are enforced on the target', () => {
  let paperBot: string
  let realBot: string
  let otherBot: string
  let paperDeal: string
  let realDeal: string
  let otherBotDeal: string
  let foreignDeal: string

  before(async () => {
    paperBot = await createBot(USER, true)
    realBot = await createBot(USER, false)
    otherBot = await createBot(USER, true)
    paperDeal = await createDeal(USER, paperBot, true)
    realDeal = await createDeal(USER, realBot, false)
    otherBotDeal = await createDeal(USER, otherBot, true)
    const foreignBot = await createBot(OTHER_USER, true)
    foreignDeal = await createDeal(OTHER_USER, foreignBot, true)
  })

  after(async () => {
    await dcaBotDb.deleteManyData({})
    await dcaDealsDb.deleteManyData({})
  })

  it('lets an unrestricted key through', async () => {
    const r = await run({}, { params: { dealId: realDeal } })
    expect(r.allowed).to.equal(true)
  })

  it('refuses a paper-only key on a real deal even with the paper header', async () => {
    const r = await run(
      { keyPaperContext: true },
      {
        method: 'DELETE',
        routePath: '/api/v2/deals/:dealType/:dealId',
        params: { dealType: 'dca', dealId: realDeal },
        paperHeader: true,
      },
    )
    expect(r.allowed).to.equal(false)
    expect(r.status).to.equal(403)
  })

  it('refuses a paper-only key on a real bot named in the body', async () => {
    const r = await run(
      { keyPaperContext: true },
      { body: { botId: realBot, paperContext: true }, paperHeader: true },
    )
    expect(r.allowed).to.equal(false)
  })

  it('refuses a paper-only key that declares a real paperContext', async () => {
    const r = await run(
      { keyPaperContext: true },
      { body: { botId: paperBot, paperContext: false }, paperHeader: true },
    )
    expect(r.allowed).to.equal(false)
  })

  it('allows a paper-only key on a paper deal', async () => {
    const r = await run(
      { keyPaperContext: true },
      { query: { dealId: paperDeal }, paperHeader: true },
    )
    expect(r.allowed).to.equal(true)
  })

  it("refuses a bot-only key on another bot's deal", async () => {
    const r = await run(
      { keyBotId: paperBot },
      {
        routePath: '/api/v2/deals/dca/add-funds',
        query: { dealId: otherBotDeal },
      },
    )
    expect(r.allowed).to.equal(false)
    expect(r.status).to.equal(403)
  })

  it("refuses a bot-only key on another account's deal", async () => {
    const r = await run(
      { keyBotId: paperBot },
      { query: { dealId: foreignDeal } },
    )
    expect(r.allowed).to.equal(false)
  })

  it("allows a bot-only key on its own bot's deal", async () => {
    const r = await run(
      { keyBotId: paperBot },
      {
        method: 'DELETE',
        routePath: '/api/v2/deals/:dealType/:dealId',
        params: { dealType: 'dca', dealId: paperDeal },
      },
    )
    expect(r.allowed).to.equal(true)
  })

  it('treats the deal-start segment as a bot id', async () => {
    const routePath = '/api/v2/deals/:dealType/:dealId/start'
    const own = await run(
      { keyBotId: paperBot },
      { routePath, params: { dealType: 'dca', dealId: paperBot } },
    )
    expect(own.allowed).to.equal(true)
    const other = await run(
      { keyBotId: paperBot },
      { routePath, params: { dealType: 'dca', dealId: otherBot } },
    )
    expect(other.allowed).to.equal(false)
  })

  it('refuses a bot-only key on creation and clone routes', async () => {
    for (const routePath of [
      '/api/v2/bots/dca',
      '/api/v2/deals/terminal',
      '/api/v2/bots/:botType/:botId/clone',
    ]) {
      const r = await run(
        { keyBotId: paperBot },
        { routePath, params: { botType: 'dca', botId: paperBot } },
      )
      expect(r.allowed, routePath).to.equal(false)
    }
  })

  it('refuses targeting by bot name with a restricted key', async () => {
    const r = await run({ keyBotId: paperBot }, { body: { botName: 'x' } })
    expect(r.allowed).to.equal(false)
  })

  it('refuses a non-string id with a restricted key', async () => {
    const r = await run(
      { keyBotId: paperBot },
      { query: { dealId: { $ne: null } } },
    )
    expect(r.allowed).to.equal(false)
    expect(r.status).to.equal(400)
  })
})
