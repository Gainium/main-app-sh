/**
 * Spec 061 — the `bots.grid` field presets must name paths that exist on a
 * stored grid bot document.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * The GET handler (`api.ts:1013`) turns a preset into a MongoDB projection
 * verbatim: `parseFieldsParam` -> `buildProjection` -> `botDb.readData`. A
 * projected path that does not exist on the document is simply absent from the
 * response. `filterFields` applies the same dot-path semantics to a plain
 * object, so driving the real preset through it over a production-shaped
 * document is an exact stand-in for the projection, with no DB.
 */
import { expect } from 'chai'
import { parseFieldsParam, filterFields } from './fieldUtils'
import { GRID_FORM_DEFAULTS } from './botDefaults'

/**
 * Verbatim field shape of a live production grid bot (paperBinanceUsdm,
 * futures). Values are the reported bot's; only the shape matters here.
 */
const PROD_GRID_BOT = {
  _id: '6aa36d6c2d3a9f803ca83c54',
  uuid: '2f512b83-b1aa-4366-98a9-fdcc0ac10c10',
  status: 'closed',
  statusReason: '',
  exchange: 'paperBinanceUsdm',
  exchangeUUID: '2f512b83-b1aa-4366-98a9-fdcc0ac10c10',
  paperContext: true,
  settings: {
    name: 'MARSCOIN Natural',
    pair: 'MARSCOINUSDT',
    profitCurrency: 'quote',
    orderFixedIn: 'base',
    topPrice: 0.13273,
    lowPrice: 0.094,
    levels: 9,
    gridStep: 0.0412,
    budget: 300,
    ordersInAdvance: 4,
    useOrderInAdvance: true,
    prioritize: 'level',
    sellDisplacement: 0.0004,
    gridType: 'geometric',
    tpSl: true,
    tpSlCondition: 'valueChanged',
    tpSlAction: 'stopAndSell',
    sl: true,
    slCondition: 'valueChanged',
    slAction: 'stopAndSell',
    tpPerc: 0.03,
    slPerc: -0.04,
    tpTopPrice: 0.4662,
    slLowPrice: 0.286,
    updatedBudget: true,
    useStartPrice: false,
    startPrice: '',
    marginType: 'isolated',
    leverage: 1,
    futures: true,
    coinm: false,
    newProfit: true,
    newBalance: true,
    strategy: 'LONG',
    futuresStrategy: 'NEUTRAL',
    slLimit: false,
    tpSlLimit: false,
    feeOrder: true,
    skipBalanceCheck: false,
  },
  symbol: {
    symbol: 'MARSCOINUSDT',
    baseAsset: 'MARSCOIN',
    quoteAsset: 'USDT',
  },
  profit: { total: 8.87, totalUsd: 8.83, freeTotal: 8.87, freeTotalUsd: 8.82 },
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

/** Paths named by a preset that resolve to nothing on the document. */
function unresolvedPaths(preset: 'minimal' | 'standard' | 'extended') {
  const fields = parseFieldsParam(preset, 'bots.grid') ?? []
  const projected = filterFields(PROD_GRID_BOT as any, fields)
  return fields.filter((path) => {
    let cursor: any = projected
    for (const part of path.split('.')) {
      if (cursor === null || cursor === undefined) return true
      cursor = cursor[part]
    }
    return cursor === undefined
  })
}

describe('spec 061 — bots.grid field presets', () => {
  describe('§1.1 every projected path resolves on a stored grid bot', () => {
    for (const preset of ['minimal', 'standard', 'extended'] as const) {
      it(`fields=${preset} names no path that is absent from the document`, () => {
        expect(unresolvedPaths(preset)).to.deep.equal([])
      })
    }
  })

  describe('§1.1 standard identifies the bot', () => {
    it('returns the trading pair', () => {
      const fields = parseFieldsParam('standard', 'bots.grid') ?? []
      const res: any = filterFields(PROD_GRID_BOT as any, fields)
      expect(res.settings?.pair).to.equal('MARSCOINUSDT')
    })

    it('returns the creation and update timestamps', () => {
      const fields = parseFieldsParam('standard', 'bots.grid') ?? []
      const res: any = filterFields(PROD_GRID_BOT as any, fields)
      expect(res.created).to.not.equal(undefined)
      expect(res.updated).to.not.equal(undefined)
    })
  })

  describe('§1.1 extended returns the grid definition', () => {
    it('returns the price range and the level count', () => {
      const fields = parseFieldsParam('extended', 'bots.grid') ?? []
      const res: any = filterFields(PROD_GRID_BOT as any, fields)
      expect(res.settings?.lowPrice).to.equal(0.094)
      expect(res.settings?.topPrice).to.equal(0.13273)
      expect(res.settings?.levels).to.equal(9)
    })

    it('returns the take profit and stop loss configuration', () => {
      const fields = parseFieldsParam('extended', 'bots.grid') ?? []
      const res: any = filterFields(PROD_GRID_BOT as any, fields)
      expect(res.settings?.tpSl).to.equal(true)
      expect(res.settings?.tpSlCondition).to.equal('valueChanged')
      expect(res.settings?.tpSlAction).to.equal('stopAndSell')
      expect(res.settings?.sl).to.equal(true)
      expect(res.settings?.slCondition).to.equal('valueChanged')
      expect(res.settings?.slAction).to.equal('stopAndSell')
    })
  })

  describe('§1.2 a read-modify-create round trip keeps the TP/SL actions', () => {
    it('does not fall back to the GRID_FORM_DEFAULTS stop action', () => {
      // What the caller reads back...
      const fields = parseFieldsParam('extended', 'bots.grid') ?? []
      const read: any = filterFields(PROD_GRID_BOT as any, fields)

      // ...adjusted the way the report describes (new pair, new range)...
      const body = {
        ...read.settings,
        pair: 'DRIFTUSDT',
        lowPrice: 0.013823,
        topPrice: 0.019787,
        levels: 19,
      }

      // ...and merged by POST /api/v2/bots/grid (api.ts:2576).
      const stored = { ...GRID_FORM_DEFAULTS, ...body }

      expect(GRID_FORM_DEFAULTS.tpSlAction).to.equal('stop')
      expect(GRID_FORM_DEFAULTS.slAction).to.equal('stop')
      expect(stored.tpSlAction).to.equal('stopAndSell')
      expect(stored.slAction).to.equal('stopAndSell')
      // the caller's own edits survive too
      expect(stored.pair).to.equal('DRIFTUSDT')
      expect(stored.levels).to.equal(19)
    })
  })
})
