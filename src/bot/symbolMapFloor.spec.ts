process.env.NODE_ENV = 'testing'

/**
 * Saving a bot must never shrink its `symbol` map below `settings.pair` just
 * because the pairs collection is momentarily missing some of those pairs,
 * and must never persist an EMPTY map — the dashboard reads `symbol[0]` on
 * every bot and a single empty map takes down the whole bot list.
 *
 * Drives the real `changeDCABot` / `changeComboBot` off the `Bot` prototype
 * with only the DB reads/writes stubbed.
 *
 * Enforces specs/119 §2.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { StatusEnum } from '../../types'
import Bot from './index'

const SENTINEL = 'reached-the-save'

const entry = (pair: string) => ({
  symbol: pair,
  baseAsset: pair.split('-')[0],
  quoteAsset: 'USDC',
})

function makeChangeBot(opts: {
  pair: string[]
  storedSymbol: Record<string, ReturnType<typeof entry>> | Map<string, any>
  known: string[]
}) {
  const api: any = Object.create(Bot.prototype)
  const captured: { set?: any } = {}
  const botDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      reason: null,
      data: {
        result: {
          _id: 'bot',
          userId: 'user',
          status: 'open',
          vars: null,
          symbol: opts.storedSymbol,
          settings: {
            name: 'xperp',
            pair: [...opts.pair],
            useMulti: true,
            profitCurrency: 'quote',
            indicators: [],
          },
        },
      },
    }),
    updateData: async (_f: any, set: any) => {
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
          .filter((p: string) => opts.known.includes(p))
          .map((p: string) => ({
            pair: p,
            baseAsset: { name: p.split('-')[0] },
            quoteAsset: { name: 'USDC' },
          })),
      },
    }),
  }
  return { api, captured }
}

async function save(api: any, method: string, pair: string[]) {
  try {
    await api[method]({ id: 'bot', pair }, 'user', false)
  } catch (e) {
    if ((e as Error).message !== SENTINEL) throw e
  }
}

const A = 'AAPL-USD_UM_XPERP'
const B = 'BTC-USD_UM_XPERP'
const N = 'NVDA-USD_UM_XPERP'

describe('symbol-map floor on save (spec 119)', () => {
  for (const method of ['changeDCABot', 'changeComboBot']) {
    describe(method, () => {
      it('§2.1 pairs missing from the pairs collection keep their stored entry', async () => {
        const { api, captured } = makeChangeBot({
          pair: [A, B],
          storedSymbol: { [A]: entry(A), [B]: entry(B) },
          known: [A],
        })
        await save(api, method, [A, B])
        const symbol = captured.set.$set.symbol as Map<string, any>
        expect([...symbol.keys()].sort()).to.deep.equal([A, B])
        expect(symbol.get(B)).to.deep.equal(entry(B))
      })

      it('§2.1 a stored map that arrives as a Map is read too', async () => {
        const { api, captured } = makeChangeBot({
          pair: [A, B],
          storedSymbol: new Map([[B, entry(B)]]),
          known: [A],
        })
        await save(api, method, [A, B])
        expect(
          [...(captured.set.$set.symbol as Map<string, any>).keys()].sort(),
        ).to.deep.equal([A, B])
      })

      it('§2.2 with nothing found and nothing stored, no empty map is written', async () => {
        const { api, captured } = makeChangeBot({
          pair: [A, B],
          storedSymbol: {},
          known: [],
        })
        await save(api, method, [A, B])
        expect(captured.set.$set).to.not.have.property('symbol')
        expect(captured.set.$set.settings.pair).to.deep.equal([A, B])
      })

      it('§2.3 a pair removed from the bot is still dropped from the map', async () => {
        const { api, captured } = makeChangeBot({
          pair: [A, B],
          storedSymbol: { [A]: entry(A), [B]: entry(B) },
          known: [A, B],
        })
        await save(api, method, [A])
        expect([
          ...(captured.set.$set.symbol as Map<string, any>).keys(),
        ]).to.deep.equal([A])
      })

      it('§2.3 a newly added pair unknown everywhere is not invented', async () => {
        const { api, captured } = makeChangeBot({
          pair: [A],
          storedSymbol: { [A]: entry(A) },
          known: [A],
        })
        await save(api, method, [A, N])
        expect([
          ...(captured.set.$set.symbol as Map<string, any>).keys(),
        ]).to.deep.equal([A])
      })
    })
  }
})
