process.env.NODE_ENV = 'testing'
// `graphql/handlers/user` refuses to load without one; nothing here signs a token.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'spec-131-test-secret'

/**
 * Spec `131` — the Ignore Fees toggle must reach bots that are already running.
 *
 * Two halves of one path, both driven over the real code:
 *
 *   setZeroFee (resolver)           → publishes `updateuserStore`
 *   BotSharedData.updateUserStore   → refreshes the cache, publishes
 *                                     `botUpdateUserExchange<thread>`
 *   MainBot.updateExchangeCredentials (each bot on that connection)
 *                                   → must re-derive `zeroFee`
 *
 * No network, no Mongo, no Redis: the user read/write and the publisher are
 * fakes.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import { ExchangeEnum, StatusEnum } from '../../types'

const BOT_ID = '000000000000000000000b31'
const USER_ID = '000000000000000000000431'
const UUID = '00000000-0000-4000-8000-000000000131'
const OTHER_UUID = '00000000-0000-4000-8000-000000000132'

const loadModule = createRequire(__filename)
const MainBot = loadModule('./main').default

type Connection = {
  uuid: string
  provider: ExchangeEnum
  zeroFee?: boolean
}

const buildBot = (opts: {
  provider?: ExchangeEnum
  paperContext?: boolean
  /** What the bot was loaded with. */
  loadedZeroFee: boolean
}) => {
  const connections: Connection[] = [
    {
      uuid: UUID,
      provider: opts.provider ?? ExchangeEnum.coinbase,
      zeroFee: opts.loadedZeroFee,
    },
    { uuid: OTHER_UUID, provider: ExchangeEnum.coinbase, zeroFee: false },
  ]
  const bot: any = Object.create(MainBot.prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.zeroFee = opts.loadedZeroFee
  bot.data = {
    _id: BOT_ID,
    userId: USER_ID,
    exchange: opts.provider ?? ExchangeEnum.coinbase,
    exchangeUUID: UUID,
    paperContext: !!opts.paperContext,
  }
  bot.handleLog = () => undefined
  bot.handleErrors = () => undefined
  bot.getUser = async () => ({
    timezone: 'UTC',
    onboardingSteps: {},
    exchanges: connections.map((c) => ({ ...c, key: 'k', secret: 's' })),
  })
  bot.setExchangeCredentials = async () => undefined
  /** Flip the stored switch, the way setZeroFee writes it. */
  const setStored = (uuid: string, value: boolean) => {
    const c = connections.find((e) => e.uuid === uuid)
    if (c) c.zeroFee = value
  }
  const notify = (uuid: string) => bot.updateExchangeCredentials(uuid)
  return { bot, setStored, notify }
}

describe('spec 131 — Ignore Fees reaches running bots', () => {
  it('§3.2 turns zero fee on for a running bot', async () => {
    const { bot, setStored, notify } = buildBot({ loadedZeroFee: false })
    setStored(UUID, true)
    await notify(UUID)
    expect(bot.zeroFee).to.equal(true)
    expect(await bot.getUserFee('CRO-USDC')).to.deep.equal({
      maker: 0,
      taker: 0,
    })
  })

  it('§4.2 turns zero fee off for a running bot', async () => {
    const { bot, setStored, notify } = buildBot({ loadedZeroFee: true })
    setStored(UUID, false)
    await notify(UUID)
    expect(bot.zeroFee).to.equal(false)
  })

  it('§4.1 keeps the provider and paper exclusions', async () => {
    for (const provider of [
      ExchangeEnum.okx,
      ExchangeEnum.okxInverse,
      ExchangeEnum.okxLinear,
      ExchangeEnum.bybit,
      ExchangeEnum.bybitCoinm,
      ExchangeEnum.bybitUsdm,
    ]) {
      const { bot, setStored, notify } = buildBot({
        provider,
        loadedZeroFee: false,
      })
      setStored(UUID, true)
      await notify(UUID)
      expect(bot.zeroFee, provider).to.equal(false)
    }
    const paper = buildBot({ paperContext: true, loadedZeroFee: false })
    paper.setStored(UUID, true)
    await paper.notify(UUID)
    expect(paper.bot.zeroFee).to.equal(false)
  })

  it('§4.3 ignores another connection', async () => {
    const { bot, setStored, notify } = buildBot({ loadedZeroFee: false })
    setStored(UUID, true)
    await notify(OTHER_UUID)
    expect(bot.zeroFee).to.equal(false)
  })

  it('§3.1 setZeroFee tells running bots', async () => {
    // Under the full suite `config` is already loaded, so the env var set
    // above arrives too late; `graphql/handlers/user` reads it from here.
    const config = loadModule('../config')
    config.JWT_SECRET = config.JWT_SECRET || process.env.JWT_SECRET
    const RedisClient = loadModule('../db/redis').default
    const published: { channel: string; msg: string }[] = []
    const original = RedisClient.getInstance
    RedisClient.getInstance = async () => ({
      publish: (channel: string, msg: string) => {
        published.push({ channel, msg })
      },
    })
    try {
      const user = {
        _id: USER_ID,
        exchanges: [
          { uuid: UUID, provider: ExchangeEnum.coinbase, zeroFee: false },
        ],
      }
      const writes: any[] = []
      const fakeUserDb = {
        updateData: async (search: any, update: any) => {
          writes.push({ search, update })
          return { status: StatusEnum.ok, data: user, reason: null }
        },
      }
      const resolvers = loadModule('../graphql/resolvers').default(
        async () => ({ status: StatusEnum.ok, data: user, reason: null }),
        fakeUserDb,
        {},
      )
      const res = await resolvers.Mutation.setZeroFee(
        null,
        { input: { value: true, uuid: UUID } },
        { token: 't', req: { user: { authorized: true } } },
      )
      expect(res.status).to.equal(StatusEnum.ok)
      expect(writes).to.have.length(1)
      expect(published).to.deep.equal([
        {
          channel: 'updateuserStore',
          msg: JSON.stringify({ userId: USER_ID, uuid: UUID }),
        },
      ])
    } finally {
      RedisClient.getInstance = original
    }
  })
})
