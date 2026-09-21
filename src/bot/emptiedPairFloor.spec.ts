process.env.NODE_ENV = 'testing'

/**
 * A delisted pair must never be pruned down to NO pair, and a bot that has
 * already been emptied must be repairable.
 *
 * Production: 220 single-pair DCA bots (plus 15 combo) across 24 users read
 * `settings.pair: []` with a fully-populated `symbol` map — configured bots
 * whose only pair was pruned when its contract dropped off a venue's symbol
 * list. None of them can be given a pair back: `changeDCABot` refuses every
 * pair change on a `useMulti:false` bot, whatever the stored pair is.
 *
 * Both halves are driven on the REAL methods — `checkSettingsPairs` off the
 * real DCA helper prototype, `changeDCABot`/`changeComboBot` off the real
 * `Bot` prototype — with only the I/O they reach stubbed. No stack, DB, Redis
 * or exchange connection.
 *
 * Enforces specs/072 §2.1 and §2.2.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum } from '../../types'
import Bot from './index'
import MainBot from './main'
import createDCABotHelper from './dcaHelper'

const Helper: any = createDCABotHelper(MainBot as any)

type PruneRun = {
  /** What `updateData` was asked to persist, one entry per call. */
  persisted: string[][]
  /** Pairs the bot decided are gone. */
  notFound: () => string[]
  /** The bot's `settings.pair` after the run. */
  pair: () => string[]
  /**
   * The predicate both `start()` implementations use to choose between
   * "prune this pair and keep trading" and "stop the bot" — core's
   * `dcaHelper.start()` and main-app's override, verbatim. Retaining pairs
   * must not flip a bot that should stop into one that keeps running.
   */
  callerWouldStop: () => boolean
}

/**
 * A DCA bot whose exchange info is missing for `missing`, built by
 * `Object.create`-ing the real helper prototype.
 *
 * `openDealOn` names a pair that still holds a live deal — the pre-existing
 * guard (§2.1.5) that keeps such a pair out of the candidate set entirely.
 */
function makePruneBot(opts: {
  pair: string[]
  useMulti: boolean
  missing: string[]
  openDealOn?: string
}): { bot: any; run: PruneRun } {
  const bot: any = Object.create(Helper.prototype)
  const persisted: string[][] = []

  bot.botId = '69931b72eedf3d7447c9fa97'
  bot.userId = '63ad5b6805f8ea2ea471b644'
  bot.botType = 'dca'
  bot.pairsNotFound = new Set<string>()
  bot.data = {
    settings: {
      name: 'harness',
      pair: [...opts.pair],
      useMulti: opts.useMulti,
    },
  }

  bot.shouldContinueLoad = () => true
  bot.shouldProceed = () => true
  bot.handleLog = () => undefined
  bot.handleWarn = () => undefined
  bot.handleDebug = () => undefined
  bot.calculateUsage = () => undefined
  bot.confirmPairMissing = async (p: string) => opts.missing.includes(p)
  bot.getOpenDeals = (_all: boolean, p: string) =>
    opts.openDealOn === p ? [{ _id: 'deal' }] : []
  bot.updateData = (patch: any) => {
    persisted.push([...patch.settings.pair])
    return Promise.resolve()
  }

  return {
    bot,
    run: {
      persisted,
      notFound: () => [...bot.pairsNotFound].sort(),
      pair: () => [...bot.data.settings.pair],
      callerWouldStop: () =>
        bot.pairsNotFound.size > 0 &&
        !(
          bot.data?.settings.useMulti &&
          bot.data.settings.pair.length > 1 &&
          bot.pairsNotFound.size < bot.data.settings.pair.length
        ),
    },
  }
}

const SENTINEL = 'reached-the-save'

/**
 * A `Bot` whose `changeDCABot` / `changeComboBot` reads `stored` and throws
 * SENTINEL at the point it would persist — so a run that gets past the pair
 * guards is distinguishable from one that is refused, and the payload it built
 * is captured either way.
 */
function makeChangeBot(stored: {
  useMulti: boolean
  pair: string[]
  knownPairs?: string[]
}) {
  const api: any = Object.create(Bot.prototype)
  const captured: { set?: any } = {}
  const known = stored.knownPairs ?? ['BTCUSD', 'ETHUSD']

  const botDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: {
          _id: 'bot',
          userId: 'user',
          status: 'closed',
          vars: null,
          settings: {
            name: 'The Big Long Timer',
            pair: [...stored.pair],
            useMulti: stored.useMulti,
            profitCurrency: 'base',
            // combo's change path reads this before the pair guards.
            indicators: [],
          },
        },
      },
    }),
    updateData: async (_filter: any, set: any) => {
      captured.set = set
      throw new Error(SENTINEL)
    },
  }

  api.useBots = true
  api.dcaBotDb = botDb
  api.comboBotDb = botDb
  api.dcaBots = []
  api.comboBots = []
  api.getWorkerById = () => undefined
  api.pairsDb = {
    readData: async (filter: any) => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: (filter.pair?.$in ?? [])
          .filter((p: string) => known.includes(p))
          .map((p: string) => ({
            pair: p,
            baseAsset: { name: p.slice(0, 3) },
            quoteAsset: { name: p.slice(3) },
          })),
      },
    }),
  }

  return { api, captured }
}

/** Runs a change call, turning the SENTINEL throw into a recognisable result. */
async function callChange(
  api: any,
  method: 'changeDCABot' | 'changeComboBot',
  pair: string[],
): Promise<{ saved: boolean; reason: string | null }> {
  try {
    const res = await api[method]({ id: 'bot', pair }, 'user', false)
    return { saved: false, reason: res?.reason ?? null }
  } catch (e) {
    if ((e as Error).message === SENTINEL) {
      return { saved: true, reason: null }
    }
    throw e
  }
}

describe('emptied-pair floor (spec 072)', () => {
  describe('§2.1 — checkSettingsPairs never prunes a bot down to no pair', () => {
    it('§2.1.1 multi bot loses one of three: that one is pruned and persisted', async () => {
      const { bot, run } = makePruneBot({
        pair: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        useMulti: true,
        missing: ['ETHUSDT'],
      })
      await bot.checkSettingsPairs()
      expect(run.pair()).to.deep.equal(['BTCUSDT', 'SOLUSDT'])
      expect(run.persisted).to.deep.equal([['BTCUSDT', 'SOLUSDT']])
      expect(run.notFound()).to.deep.equal(['ETHUSDT'])
      // One of three gone: the caller prunes and keeps the bot running.
      expect(run.callerWouldStop()).to.equal(false)
    })

    it('§2.1.2 multi bot loses all three: nothing is pruned, all three are reported', async () => {
      const { bot, run } = makePruneBot({
        pair: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        useMulti: true,
        missing: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      })
      await bot.checkSettingsPairs()
      expect(run.pair()).to.deep.equal(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
      expect(run.persisted).to.deep.equal([])
      // The caller stops the bot off this set — it must be populated even
      // though nothing was pruned.
      expect(run.notFound()).to.deep.equal(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
      expect(run.callerWouldStop()).to.equal(true)
    })

    it('§2.1.3 single-pair bot loses its only pair: the pair survives, the bot is still reported', async () => {
      const { bot, run } = makePruneBot({
        pair: ['BTCUSD'],
        useMulti: false,
        missing: ['BTCUSD'],
      })
      await bot.checkSettingsPairs()
      expect(run.pair()).to.deep.equal(['BTCUSD'])
      expect(run.persisted).to.deep.equal([])
      expect(run.notFound()).to.deep.equal(['BTCUSD'])
      // Retaining the pair must not keep a pairless bot running.
      expect(run.callerWouldStop()).to.equal(true)
    })

    it('§2.1.4 nothing missing: no prune, no persist, nothing reported', async () => {
      const { bot, run } = makePruneBot({
        pair: ['BTCUSD'],
        useMulti: false,
        missing: [],
      })
      await bot.checkSettingsPairs()
      expect(run.pair()).to.deep.equal(['BTCUSD'])
      expect(run.persisted).to.deep.equal([])
      expect(run.notFound()).to.deep.equal([])
    })

    it('§2.1.5 a missing pair with an open deal is not a candidate at all', async () => {
      const { bot, run } = makePruneBot({
        pair: ['BTCUSD'],
        useMulti: false,
        missing: ['BTCUSD'],
        openDealOn: 'BTCUSD',
      })
      await bot.checkSettingsPairs()
      expect(run.pair()).to.deep.equal(['BTCUSD'])
      expect(run.persisted).to.deep.equal([])
      expect(run.notFound()).to.deep.equal([])
    })
  })

  describe('§2.2 — a pair change is refused only while the bot still has a pair', () => {
    for (const method of ['changeDCABot', 'changeComboBot'] as const) {
      describe(method, () => {
        it('§2.2.1 a configured single-pair bot still refuses a pair change', async () => {
          const { api } = makeChangeBot({ useMulti: false, pair: ['BTCUSD'] })
          const res = await callChange(api, method, ['ETHUSD'])
          expect(res.saved).to.equal(false)
          expect(res.reason).to.equal(
            'Cannot change pair for non-multi pairs bot',
          )
        })

        it('§2.2.2 an emptied single-pair bot accepts one pair, and its symbol map is rebuilt', async () => {
          const { api, captured } = makeChangeBot({
            useMulti: false,
            pair: [],
          })
          const res = await callChange(api, method, ['BTCUSD'])
          expect(res.saved).to.equal(true)
          expect(captured.set.$set.settings.pair).to.deep.equal(['BTCUSD'])
          const symbol = captured.set.$set.symbol as Map<string, any>
          expect(symbol).to.be.instanceOf(Map)
          expect(symbol.get('BTCUSD')).to.deep.equal({
            symbol: 'BTCUSD',
            baseAsset: 'BTC',
            quoteAsset: 'USD',
          })
        })

        it('§2.2.3 an emptied single-pair bot still refuses an empty pair list', async () => {
          const { api } = makeChangeBot({ useMulti: false, pair: [] })
          const res = await callChange(api, method, [])
          expect(res.saved).to.equal(false)
          expect(res.reason).to.equal('Need to specify at least one pair')
        })

        it('§2.2.4 an emptied single-pair bot refuses more than one pair', async () => {
          const { api } = makeChangeBot({ useMulti: false, pair: [] })
          const res = await callChange(api, method, ['BTCUSD', 'ETHUSD'])
          expect(res.saved).to.equal(false)
          expect(res.reason).to.equal(
            'Cannot change pair for non-multi pairs bot',
          )
        })

        it('§2.2.5 a multi-pair bot is unaffected', async () => {
          const { api, captured } = makeChangeBot({
            useMulti: true,
            pair: ['BTCUSD'],
          })
          const res = await callChange(api, method, ['BTCUSD', 'ETHUSD'])
          expect(res.saved).to.equal(true)
          expect(captured.set.$set.settings.pair).to.deep.equal([
            'BTCUSD',
            'ETHUSD',
          ])
          expect((captured.set.$set.symbol as Map<string, any>).size).to.equal(
            2,
          )
        })

        it('§2.2.5 a multi-pair bot still refuses an empty pair list', async () => {
          const { api } = makeChangeBot({ useMulti: true, pair: ['BTCUSD'] })
          const res = await callChange(api, method, [])
          expect(res.saved).to.equal(false)
          expect(res.reason).to.equal('Need to specify at least one pair')
        })
      })
    }
  })
})
