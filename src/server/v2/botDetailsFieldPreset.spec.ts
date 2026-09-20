/**
 * Spec 063 — `GET /api/v2/bots/:botType/details` must read each bot type with
 * its own field preset.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * The handler turns a preset into a MongoDB projection verbatim
 * (`endpointForBotType` -> `parseFieldsParam` -> `buildProjection` ->
 * `<db>.readData`, `api.ts:1327-1341`). `filterFields` applies the same
 * dot-path semantics to a plain object, so driving the resolved preset through
 * it over a production-shaped document is an exact stand-in for the
 * projection, with no DB — the same technique specs 061 / 062 use.
 */
import { expect } from 'chai'
import { parseFieldsParam, filterFields } from './fieldUtils'
import { endpointForBotType, type EndpointType } from './fieldConfig'

/** Field shape of a live production grid bot (see spec 061). */
const GRID_BOT = {
  _id: '6aa36d6c2d3a9f803ca83c54',
  uuid: '2f512b83-b1aa-4366-98a9-fdcc0ac10c10',
  status: 'open',
  statusReason: '',
  exchange: 'binance',
  exchangeUUID: '2f512b83-b1aa-4366-98a9-fdcc0ac10c10',
  paperContext: false,
  settings: {
    name: 'MARSCOIN Natural',
    pair: 'MARSCOINUSDT',
    topPrice: 0.13273,
    lowPrice: 0.094,
    levels: 9,
    gridType: 'geometric',
    tpSl: true,
    tpSlCondition: 'valueChanged',
    tpSlAction: 'stopAndSell',
    sl: true,
    slCondition: 'valueChanged',
    slAction: 'stopAndSell',
    slPerc: -0.04,
  },
  symbol: { symbol: 'MARSCOINUSDT', baseAsset: 'MARSCOIN', quoteAsset: 'USDT' },
  profit: { total: 8.87, totalUsd: 8.83 },
  levels: { active: { buy: 7, sell: 2 }, all: { buy: 7, sell: 2 } },
  cost: 250,
  initialPrice: 0.11656935,
  avgPrice: 0.1089068288,
  workingTimeNumber: 124638841,
  profitToday: { start: 0, end: 0, totalToday: 0, totalTodayUsd: 0 },
  flags: [],
  feePaid: 0,
  feeByAsset: [],
  created: new Date('2026-09-11T02:54:36.973Z'),
  updated: new Date('2026-09-20T12:31:23.518Z'),
} as const

/** Field shape of a live production combo bot (see spec 062). */
const COMBO_BOT = {
  _id: '6aa36d6c2d3a9f803ca83c55',
  uuid: '77c0d6a2-1f44-4d0a-8f8e-2a1c9b7d3e55',
  status: 'open',
  statusReason: '',
  exchange: 'binance',
  exchangeUUID: '77c0d6a2-1f44-4d0a-8f8e-2a1c9b7d3e55',
  paperContext: false,
  settings: {
    name: 'SOL combo',
    pair: ['SOL_USDT'],
    baseOrderSize: '500',
    useSl: true,
    slPerc: '-25',
    trailingTp: true,
    trailingTpPerc: '1.2',
    trailingSl: false,
    ordersCount: 6,
    activeOrdersCount: 2,
  },
  profit: { total: 12.4, totalUsd: 12.4 },
  deals: { all: 31, active: 2 },
  dealsStatsForBot: { closed: 12, won: 9 },
  cost: 400,
  workingTimeNumber: 9_912_304,
  profitToday: { start: 0, end: 0, totalToday: 0, totalTodayUsd: 0 },
  created: new Date('2026-04-02T09:12:41.001Z'),
  updated: new Date('2026-09-20T11:02:08.244Z'),
} as const

/** Same shape as the combo bot, minus the combo-only deal statistics. */
const DCA_BOT = (() => {
  const { dealsStatsForBot: _drop, ...rest } = COMBO_BOT as any
  return { ...rest, settings: { ...COMBO_BOT.settings, name: 'ETH ladder' } }
})()

/** What `/details` hands back for a bot read with `endpoint`'s preset. */
function read(
  doc: Record<string, any>,
  endpoint: EndpointType,
  preset: 'minimal' | 'standard' | 'extended',
): any {
  return filterFields(doc, parseFieldsParam(preset, endpoint) ?? [])
}

/** What `/details` hands back once the preset follows the `:botType`. */
function details(
  doc: Record<string, any>,
  botType: string,
  preset: 'minimal' | 'standard' | 'extended',
): any {
  return read(doc, endpointForBotType(botType), preset)
}

describe('spec 063 — the bot details endpoint reads each type with its own preset', () => {
  describe('§1.1 a grid bot is read with the grid preset', () => {
    it('returns the price range, the level count and the grid type', () => {
      const res = details(GRID_BOT as any, 'grid', 'extended')
      expect(res.settings?.lowPrice).to.equal(0.094)
      expect(res.settings?.topPrice).to.equal(0.13273)
      expect(res.settings?.levels).to.equal(9)
      expect(res.settings?.gridType).to.equal('geometric')
    })

    it('returns the take profit and stop loss configuration', () => {
      const res = details(GRID_BOT as any, 'grid', 'extended')
      expect(res.settings?.tpSl).to.equal(true)
      expect(res.settings?.tpSlCondition).to.equal('valueChanged')
      expect(res.settings?.tpSlAction).to.equal('stopAndSell')
      expect(res.settings?.sl).to.equal(true)
      expect(res.settings?.slAction).to.equal('stopAndSell')
    })

    it('returns the stored symbol and the level counts at standard', () => {
      const res = details(GRID_BOT as any, 'grid', 'standard')
      expect(res.symbol?.baseAsset).to.equal('MARSCOIN')
      expect(res.levels?.all).to.deep.equal({ buy: 7, sell: 2 })
    })
  })

  describe('§1.1 a combo bot is read with the combo preset', () => {
    it('returns the combo-only deal statistics', () => {
      const res = details(COMBO_BOT as any, 'combo', 'extended')
      expect(res.dealsStatsForBot).to.deep.equal({ closed: 12, won: 9 })
    })
  })

  describe('§1.1 a dca bot is read with the dca preset', () => {
    it('returns exactly what it returns today', () => {
      const before = read(DCA_BOT, 'bots.dca', 'extended')
      const after = details(DCA_BOT, 'dca', 'extended')
      expect(after).to.deep.equal(before)
    })
  })

  describe('§1.2 the dca preset returns none of the grid definition', () => {
    it('is why the endpoint has to follow the bot type', () => {
      const res = read(GRID_BOT as any, 'bots.dca', 'extended')
      expect(res.settings?.lowPrice).to.equal(undefined)
      expect(res.settings?.topPrice).to.equal(undefined)
      expect(res.settings?.levels).to.equal(undefined)
      expect(res.settings?.gridType).to.equal(undefined)
      expect(res.settings?.tpSlAction).to.equal(undefined)
      expect(res.symbol).to.equal(undefined)
      expect(res.levels).to.equal(undefined)
      expect(res.initialPrice).to.equal(undefined)
      expect(res.avgPrice).to.equal(undefined)
    })
  })

  describe('§1.3 the response metadata names the preset that was used', () => {
    it('advertises the grid fields for a grid bot, not the dca fields', () => {
      // `responseMetadataMiddleware` reports `req.fieldSelection`, which the
      // handler now sets from the bot type.
      const fields = parseFieldsParam('extended', endpointForBotType('grid'))
      expect(fields).to.include('settings.levels')
      expect(fields).to.not.include('settings.baseOrderSize')
    })
  })

  describe('§4.1 every accepted bot type maps to its own preset', () => {
    const cases: Array<[string, EndpointType]> = [
      ['dca', 'bots.dca'],
      ['combo', 'bots.combo'],
      ['grid', 'bots.grid'],
      ['hedgeCombo', 'bots.hedgeCombo'],
      ['hedgeDca', 'bots.hedgeDca'],
    ]
    for (const [botType, endpoint] of cases) {
      it(`${botType} -> ${endpoint}`, () => {
        expect(endpointForBotType(botType)).to.equal(endpoint)
      })
    }

    it('falls back to the dca preset for an unrecognised type', () => {
      // The details handler rejects those with a 400 before it gets here; the
      // fallback keeps the helper total without widening anything.
      expect(endpointForBotType('nonsense')).to.equal('bots.dca')
    })
  })

  describe('§4.3 the fix removes no field the caller gets today', () => {
    for (const preset of ['minimal', 'standard', 'extended'] as const) {
      it(`grid fields=${preset} still returns everything the dca preset resolved`, () => {
        const today = read(GRID_BOT as any, 'bots.dca', preset)
        const fixed = details(GRID_BOT as any, 'grid', preset)
        const walk = (a: any, b: any, path: string[] = []) => {
          for (const key of Object.keys(a)) {
            const at = a[key]
            const bt = b?.[key]
            if (at && typeof at === 'object' && !(at instanceof Date)) {
              walk(at, bt, [...path, key])
            } else {
              expect(bt, [...path, key].join('.')).to.deep.equal(at)
            }
          }
        }
        walk(today, fixed)
      })
    }
  })

  describe('§4.3 fields=full and a custom list ignore the bot type', () => {
    it('full returns the whole document whichever preset is resolved', () => {
      expect(parseFieldsParam('full', endpointForBotType('grid'))).to.equal(
        null,
      )
      expect(parseFieldsParam('full', 'bots.dca')).to.equal(null)
    })

    it('a custom list is taken verbatim', () => {
      expect(
        parseFieldsParam('id,settings.levels', endpointForBotType('grid')),
      ).to.deep.equal(['_id', 'settings.levels'])
      expect(
        parseFieldsParam('id,settings.levels', 'bots.dca'),
      ).to.deep.equal(['_id', 'settings.levels'])
    })
  })
})
