process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `305` — a spot DCA/combo bot started or saved
 * while another bot of the same user, on the same exchange account and pair,
 * trades the OPPOSITE direction (running, or holding an open deal) must tell
 * the user once per pair that both bots buy and sell one wallet balance. It
 * is a warning only: nothing is refused.
 *
 * Shape of the reported case: a running LONG and a SHORT on Coinbase
 * XRP-USDC on one account. Fixture ids are synthetic — this file is public.
 *
 * Drives the pure decision (`opposingSpotPairs`, `opposingSpotBotWarning`)
 * and the REAL `warnOpposingSpotBots` of the DCA helper and of the Combo
 * helper (which inherits it), with the four Mongo reads stubbed and
 * `processError` captured.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, afterEach } from 'mocha'
import sinon from 'sinon'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  opposingSpotBotSubType,
  opposingSpotBotWarning,
  opposingSpotPairs,
} from './opposingSpotBot'
import { isPerSymbolSubType } from './errorRulesCache'
import {
  comboBotDb,
  comboDealsDb,
  dcaBotDb,
  dcaDealsDb,
} from '../db/dbInit'
import { BotType, StatusEnum, StrategyEnum } from '../../types'

const LONG_ID = '00000000000000000000a305'
const SHORT_ID = '00000000000000000000b305'
const ACCOUNT = '00000000-0000-0000-0000-000000000305'
const PAIR = 'XRP-USDC'

const loadModule = createRequire(__filename)
let Dca: any
let Combo: any

class FakeBase {
  constructor(..._a: any[]) {}
}

const ok = (result: any[]) => ({ status: StatusEnum.ok, data: { result } })

type World = {
  dcaBots?: any[]
  comboBots?: any[]
  dcaDeals?: any[]
  comboDeals?: any[]
}

/** Stub the four reads; return the filters each was called with. */
const stubDb = (w: World) => {
  const calls: { db: string; filter: any }[] = []
  for (const [name, db, rows] of [
    ['dcaBot', dcaBotDb, w.dcaBots ?? []],
    ['comboBot', comboBotDb, w.comboBots ?? []],
    ['dcaDeal', dcaDealsDb, w.dcaDeals ?? []],
    ['comboDeal', comboDealsDb, w.comboDeals ?? []],
  ] as const) {
    sinon.stub(db as any, 'readData').callsFake(async (filter: any) => {
      calls.push({ db: name, filter })
      // Honour the filter the code sends, so a wrong filter fails the test.
      return ok(
        (rows as any[]).filter((r) => {
          if (filter._id?.$ne && `${r._id}` === filter._id.$ne) return false
          if (filter.exchangeUUID && r.exchangeUUID !== filter.exchangeUUID)
            return false
          if (filter.userId && r.userId !== filter.userId) return false
          if (
            filter['settings.strategy'] &&
            r.settings?.strategy !== filter['settings.strategy']
          )
            return false
          if (filter.strategy && r.strategy !== filter.strategy) return false
          if (filter.status && r.status !== filter.status) return false
          if (
            filter.botId?.$in &&
            !filter.botId.$in.includes(`${r.botId}`)
          )
            return false
          return true
        }),
      )
    })
  }
  return calls
}

const buildBot = (
  Cls: any,
  opts: {
    strategy?: StrategyEnum
    futures?: boolean
    botType?: BotType
    pair?: string[]
  } = {},
) => {
  const reports: { subType: string; symbol: string; message: string }[] = []
  const bot: any = Object.create(Cls.prototype)
  Object.assign(bot, {
    botId: LONG_ID,
    userId: 'u',
    botType: opts.botType ?? BotType.dca,
    data: {
      status: 'open',
      exchange: 'coinbase',
      exchangeUUID: ACCOUNT,
      settings: {
        pair: opts.pair ?? [PAIR],
        strategy: opts.strategy ?? StrategyEnum.long,
        name: 'Daytrader',
        futures: !!opts.futures,
      },
    },
    reports,
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleWarn: (m: string) => {
      throw new Error(`unexpected warn: ${m}`)
    },
    botEventDb: { createData: () => undefined },
    processError: async (
      _b: string,
      subType: string,
      _t: boolean,
      setError: boolean,
      sendError: boolean,
      message: string,
      _time: number,
      _m: string,
      _force: boolean,
      symbol: string,
    ) => {
      expect(setError, 'a warning, never an error status').to.equal(false)
      expect(sendError, 'shown to the user').to.equal(true)
      reports.push({ subType, symbol, message })
    },
  })
  // `futures` is a getter on MainBot (combo); pin both per instance.
  for (const [k, v] of [
    ['futures', !!opts.futures],
    ['isLong', (opts.strategy ?? StrategyEnum.long) === StrategyEnum.long],
  ] as const) {
    Object.defineProperty(bot, k, { value: v, configurable: true })
  }
  return bot
}

const shortBot = (over: any = {}) => ({
  _id: SHORT_ID,
  userId: 'u',
  exchangeUUID: ACCOUNT,
  status: 'closed',
  settings: {
    name: 'Daytrader Short',
    pair: [PAIR],
    strategy: StrategyEnum.short,
  },
  ...over,
})

const shortDeal = (over: any = {}) => ({
  botId: SHORT_ID,
  userId: 'u',
  status: 'open',
  strategy: StrategyEnum.short,
  symbol: { symbol: PAIR },
  ...over,
})

describe('opposite-direction spot bot decision (spec 305)', () => {
  it('§4.1 a running opposite bot on the pair is reported', () => {
    expect(
      opposingSpotPairs(
        [PAIR, 'BTC-USDC'],
        [{ botId: 's', name: 'S', pairs: [PAIR], running: true }],
        [],
      ),
    ).to.deep.equal([{ symbol: PAIR, bots: [{ name: 'S', openDeal: false }] }])
  })

  it('§4.1 a stopped opposite bot still holding an open deal is reported', () => {
    expect(
      opposingSpotPairs(
        [PAIR],
        [{ botId: 's', name: 'S', pairs: [PAIR], running: false }],
        [{ botId: 's', symbol: PAIR }],
      ),
    ).to.deep.equal([{ symbol: PAIR, bots: [{ name: 'S', openDeal: true }] }])
  })

  it('§4.3 a stopped opposite bot with no open deal is not reported', () => {
    expect(
      opposingSpotPairs(
        [PAIR],
        [{ botId: 's', pairs: [PAIR], running: false }],
        [],
      ),
    ).to.deep.equal([])
  })

  it('§4.2 the message names the other direction, the bot and the risk', () => {
    const m = opposingSpotBotWarning({
      symbol: PAIR,
      strategy: StrategyEnum.long,
      bots: [{ name: 'Daytrader Short', openDeal: true }],
    })
    expect(m).to.match(/^XRP-USDC: a SHORT spot bot on this exchange account/)
    expect(m).to.contain('"Daytrader Short" (open deal)')
    expect(m).to.contain('unable to close its deal in full')
    expect(m).to.contain('This bot keeps running')
  })

  it('§4.5 the subType is a per-pair subType', () => {
    expect(isPerSymbolSubType(opposingSpotBotSubType)).to.equal(true)
  })
})

for (const [name, get] of [
  ['DCA', () => Dca],
  ['Combo', () => Combo],
] as const) {
  describe(`${name}: warnOpposingSpotBots (spec 305)`, () => {
    before(function () {
      this.timeout(300000)
      Dca ??= loadModule('./dcaHelper').default(FakeBase as any)
      Combo ??= loadModule('./comboHelper').default()
    })
    afterEach(() => sinon.restore())

    const botType = name === 'DCA' ? BotType.dca : BotType.combo

    it('§4.1 LONG started while a SHORT on the same account+pair holds an open deal warns once for the pair', async () => {
      stubDb({ dcaBots: [shortBot()], dcaDeals: [shortDeal()] })
      const bot = buildBot(get(), { botType })
      expect(await bot.warnOpposingSpotBots()).to.deep.equal([PAIR])
      expect(bot.reports).to.have.length(1)
      expect(bot.reports[0].subType).to.equal(opposingSpotBotSubType)
      expect(bot.reports[0].symbol).to.equal(PAIR)
      expect(bot.reports[0].message).to.contain('"Daytrader Short" (open deal)')
    })

    it('§4.1 SHORT saved while a LONG combo runs on the pair warns', async () => {
      stubDb({
        comboBots: [
          shortBot({
            _id: SHORT_ID,
            status: 'open',
            settings: { name: 'L', pair: [PAIR], strategy: StrategyEnum.long },
          }),
        ],
      })
      const bot = buildBot(get(), { botType, strategy: StrategyEnum.short })
      expect(await bot.warnOpposingSpotBots()).to.deep.equal([PAIR])
      expect(bot.reports[0].message).to.match(/a LONG spot bot/)
    })

    it('§4.3 no warning for a same-direction bot, another account, or a stopped bot with no deal', async () => {
      stubDb({
        dcaBots: [
          shortBot({ _id: 'x1', settings: { pair: [PAIR], strategy: StrategyEnum.long }, status: 'open' }),
          shortBot({ _id: 'x2', exchangeUUID: 'other', status: 'open' }),
          shortBot({ _id: 'x3', status: 'closed' }),
        ],
        dcaDeals: [shortDeal({ botId: 'x2' })],
      })
      const bot = buildBot(get(), { botType })
      expect(await bot.warnOpposingSpotBots()).to.deep.equal([])
      expect(bot.reports).to.have.length(0)
    })

    it('§4.4 a futures bot is never checked (one-way futures has its own guard)', async () => {
      const calls = stubDb({ dcaBots: [shortBot({ status: 'open' })] })
      const bot = buildBot(get(), { botType, futures: true })
      expect(await bot.warnOpposingSpotBots()).to.deep.equal([])
      expect(calls).to.have.length(0)
    })

    it('§4.6 the reads are scoped to this user, account, opposite direction, other bots and not deleted', async () => {
      const calls = stubDb({ dcaBots: [shortBot({ status: 'open' })] })
      const bot = buildBot(get(), { botType })
      await bot.warnOpposingSpotBots()
      const f = calls.find((c) => c.db === 'dcaBot')!.filter
      expect(f.userId).to.equal('u')
      expect(f.exchangeUUID).to.equal(ACCOUNT)
      expect(f._id).to.deep.equal({ $ne: LONG_ID })
      expect(f['settings.strategy']).to.equal(StrategyEnum.short)
      expect(f['settings.pair']).to.deep.equal({ $in: [PAIR] })
      expect(f.isDeleted).to.deep.equal({ $ne: true })
      expect(f.paperContext).to.deep.equal({ $ne: true })
    })

    it('§4.7 a failed read is silence, never an error', async () => {
      sinon.stub(dcaBotDb as any, 'readData').rejects(new Error('down'))
      const bot = buildBot(get(), { botType })
      const warns: string[] = []
      bot.handleWarn = (m: string) => warns.push(m)
      expect(await bot.warnOpposingSpotBots()).to.deep.equal([])
      expect(bot.reports).to.have.length(0)
      expect(warns).to.have.length(1)
    })
  })
}
