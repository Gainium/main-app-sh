/**
 * Spec 061 (`bots.grid`), spec 062 (`bots.dca`, `bots.combo`, `deals.dca`) and
 * spec 066 (`bots.grid` extended covers the settings the create endpoint
 * merges against) — a field preset must name paths that exist on the stored
 * document, and `extended` must name enough of them that a read-modify-create
 * round trip does not fall back to the form defaults.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * The GET handlers (`api.ts:1013`, `:251`, `:355`, `:459`) turn a preset into a
 * MongoDB projection verbatim: `parseFieldsParam` -> `buildProjection` ->
 * `<db>.readData`. A projected path that does not exist on the document is
 * simply absent from the response. `filterFields` applies the same dot-path
 * semantics to a plain object, so driving the real preset through it over a
 * production-shaped document is an exact stand-in for the projection, with no
 * DB.
 */
import { expect } from 'chai'
import { parseFieldsParam, filterFields } from './fieldUtils'
import { endpointForBotType } from './fieldConfig'
import {
  GRID_FORM_DEFAULTS,
  DCA_FORM_DEFAULTS,
  COMBO_FORM_DEFAULTS,
} from './botDefaults'
import { GRID_EXCLUDED_FIELDS } from './validators/bots/config'

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

/**
 * Field shape of a live production DCA bot. The settings are
 * `DCA_FORM_DEFAULTS` — every bot created through the platform carries them —
 * with the stop loss, trailing exits and safety-order ladder set away from the
 * defaults, because the point of `extended` is that those survive a
 * read-modify-create round trip.
 */
const PROD_DCA_BOT = {
  _id: '6aa36d6c2d3a9f803ca83c55',
  uuid: '4c1ab0e3-9d64-4e61-bd52-0e0a1a0b9a11',
  status: 'open',
  statusReason: '',
  exchange: 'binance',
  exchangeUUID: '4c1ab0e3-9d64-4e61-bd52-0e0a1a0b9a11',
  paperContext: false,
  settings: {
    ...DCA_FORM_DEFAULTS,
    name: 'ETH ladder',
    pair: ['ETH_USDT'],
    baseOrderSize: '50',
    useSl: true,
    slPerc: '-7',
    trailingTp: true,
    trailingTpPerc: '0.9',
    trailingSl: true,
    ordersCount: 8,
    activeOrdersCount: 3,
  },
  profit: { total: 12.4, totalUsd: 12.4, freeTotal: 12.4, freeTotalUsd: 12.4 },
  deals: { all: 31, active: 2 },
  cost: 400,
  workingTimeNumber: 9_912_304,
  profitToday: { start: 0, end: 0, totalToday: 0, totalTodayUsd: 0 },
  created: new Date('2026-04-02T09:12:41.001Z'),
  updated: new Date('2026-09-20T11:02:08.244Z'),
} as const

/** Same, for a combo bot — its own preset repeats the DCA settings paths. */
const PROD_COMBO_BOT = {
  ...PROD_DCA_BOT,
  uuid: '77c0d6a2-1f44-4d0a-8f8e-2a1c9b7d3e55',
  settings: {
    ...COMBO_FORM_DEFAULTS,
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
  dealsStatsForBot: { closed: 12, won: 9 },
} as const

/**
 * Field shape of a live production DCA deal. A deal's `settings` is the
 * snapshot of the bot settings taken when it opened, so it uses the same
 * names. `startBlocked` and `trailingClose` are deliberately absent: they are
 * event markers written only when the venue refuses an order (specs 048 /
 * 050) and cleared again once it is resolved, so they are missing from most
 * stored deals. An optional path that is absent because nothing went wrong is
 * a correctly spelled name, not the defect this spec is about — which is why
 * they are skipped rather than added to the fixture.
 */
const PROD_DCA_DEAL = {
  _id: '6aa36d6c2d3a9f803ca83c56',
  botId: '6aa36d6c2d3a9f803ca83c55',
  status: 'closed',
  symbol: { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
  profit: { total: 1.22, totalUsd: 1.22 },
  createTime: 1_757_000_000_000,
  updateTime: 1_757_100_000_000,
  closeTime: 1_757_100_000_000,
  exchange: 'binance',
  exchangeUUID: '4c1ab0e3-9d64-4e61-bd52-0e0a1a0b9a11',
  paperContext: false,
  avgPrice: 2431.11,
  lastPrice: 2455.02,
  levels: { all: 8, complete: 2 },
  cost: 150,
  value: 151.22,
  startBlocked: undefined,
  trailingClose: undefined,
  settings: {
    ...DCA_FORM_DEFAULTS,
    baseOrderSize: '50',
    orderSize: '25',
    ordersCount: 8,
    activeOrdersCount: 3,
  },
  initialBalances: { ETH: 0, USDT: 1000 },
  currentBalances: { ETH: 0.06, USDT: 850 },
  feePaid: { base: 0, quote: 0.15 },
  feeByAsset: [],
  usage: { credits: 0 },
  stats: { drawdownPercent: 0, runUpPercent: 0.8 },
  strategy: 'LONG',
} as const

/**
 * Paths named by a preset that resolve to nothing on the document.
 * Preset-agnostic: `skip` lets a fixture exclude paths that are legitimately
 * optional on a stored document (see `PROD_DCA_DEAL`).
 */
function unresolvedPathsFor(
  doc: Record<string, any>,
  endpoint: Parameters<typeof parseFieldsParam>[1],
  preset: 'minimal' | 'standard' | 'extended',
  skip: string[] = [],
) {
  const fields = parseFieldsParam(preset, endpoint) ?? []
  const projected = filterFields(doc, fields)
  return fields.filter((path) => {
    if (skip.includes(path)) return false
    let cursor: any = projected
    for (const part of path.split('.')) {
      if (cursor === null || cursor === undefined) return true
      cursor = cursor[part]
    }
    return cursor === undefined
  })
}

function unresolvedPaths(preset: 'minimal' | 'standard' | 'extended') {
  return unresolvedPathsFor(PROD_GRID_BOT as any, 'bots.grid', preset)
}

/** What a preset actually hands the caller back. */
function read(
  doc: Record<string, any>,
  endpoint: Parameters<typeof parseFieldsParam>[1],
  preset: 'minimal' | 'standard' | 'extended',
): any {
  return filterFields(doc, parseFieldsParam(preset, endpoint) ?? [])
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

describe('spec 066 — bots.grid extended covers the settings POST merges against', () => {
  /** The settings `extended` names, without the `settings.` prefix. */
  const named = new Set(
    (parseFieldsParam('extended', 'bots.grid') ?? [])
      .filter((f) => f.startsWith('settings.'))
      .map((f) => f.slice('settings.'.length)),
  )
  const declared = Object.keys(GRID_FORM_DEFAULTS)
  const excluded = GRID_EXCLUDED_FIELDS as string[]

  describe('§1.1 the preset covers GRID_FORM_DEFAULTS', () => {
    it('names every setting the create endpoint merges against', () => {
      const unreadable = declared.filter(
        (k) => !excluded.includes(k) && !named.has(k),
      )
      expect(unreadable).to.deep.equal([])
    })

    it('names no setting GRID_FORM_DEFAULTS does not declare', () => {
      expect([...named].filter((k) => !declared.includes(k))).to.deep.equal([])
    })
  })

  describe('§2.4 the preset never returns a field create refuses', () => {
    // `validateCommonSchema` answers an excluded field with
    // `Field <name> is not supported`, so returning one at `fields=extended`
    // would turn the naive read-modify-create body into a 400.
    it('omits GRID_EXCLUDED_FIELDS', () => {
      expect(excluded.filter((k) => named.has(k))).to.deep.equal([])
    })
  })

  describe('§1.2 a read-modify-create round trip keeps every stored setting', () => {
    const read: any = filterFields(
      PROD_GRID_BOT as any,
      parseFieldsParam('extended', 'bots.grid') ?? [],
    )
    const stored: any = { ...GRID_FORM_DEFAULTS, ...read.settings }
    const source = PROD_GRID_BOT.settings as Record<string, any>

    it('resets none of the settings the bot actually carries', () => {
      const lost = declared.filter(
        (k) =>
          !excluded.includes(k) &&
          source[k] !== undefined &&
          JSON.stringify(source[k]) !== JSON.stringify(stored[k]),
      )
      expect(lost).to.deep.equal([])
    })

    it('keeps the take profit and stop loss thresholds, not just their flags', () => {
      // What the caller would silently get instead.
      expect(GRID_FORM_DEFAULTS.tpPerc).to.equal(20)
      expect(GRID_FORM_DEFAULTS.tpTopPrice).to.equal(0)
      expect(GRID_FORM_DEFAULTS.slLowPrice).to.equal(0)

      expect(stored.tpPerc).to.equal(0.03)
      expect(stored.slPerc).to.equal(-0.04)
      expect(stored.tpTopPrice).to.equal(0.4662)
      expect(stored.slLowPrice).to.equal(0.286)
    })

    it('keeps the futures configuration', () => {
      expect(GRID_FORM_DEFAULTS.futures).to.equal(false)
      expect(GRID_FORM_DEFAULTS.leverage).to.equal(1)

      expect(stored.futures).to.equal(true)
      expect(stored.coinm).to.equal(false)
      expect(stored.marginType).to.equal('isolated')
      expect(stored.leverage).to.equal(1)
      expect(stored.strategy).to.equal('LONG')
      expect(stored.futuresStrategy).to.equal('NEUTRAL')
    })

    it('keeps the budget and the grid geometry', () => {
      expect(GRID_FORM_DEFAULTS.budget).to.equal(0)
      expect(GRID_FORM_DEFAULTS.gridStep).to.equal(1)

      expect(stored.budget).to.equal(300)
      expect(stored.gridStep).to.equal(0.0412)
      expect(stored.ordersInAdvance).to.equal(4)
      expect(stored.sellDisplacement).to.equal(0.0004)
      expect(stored.orderFixedIn).to.equal('base')
      expect(stored.profitCurrency).to.equal('quote')
    })
  })

  describe('§4.1 both grid surfaces resolve the same preset', () => {
    // `GET /api/v2/bots/grid` binds `bots.grid` at registration;
    // `GET /api/v2/bots/:botType/details` re-resolves it per request through
    // `endpointForBotType`. Same preset table, so the widening reaches both.
    it('the details endpoint resolves bots.grid for botType=grid', () => {
      expect(endpointForBotType('grid')).to.equal('bots.grid')
    })

    it('returns the same field list on both surfaces', () => {
      expect(parseFieldsParam('extended', endpointForBotType('grid'))).to.deep.equal(
        parseFieldsParam('extended', 'bots.grid'),
      )
    })
  })
})

describe('spec 062 — bots.dca / bots.combo / deals.dca field presets', () => {
  // A deal's optional event markers: absent because nothing went wrong, not
  // because the preset misnamed them. See PROD_DCA_DEAL.
  const DEAL_OPTIONAL = ['startBlocked', 'trailingClose']

  describe('§1.1 every projected path resolves on a stored document', () => {
    const cases = [
      { label: 'bots.dca', doc: PROD_DCA_BOT, endpoint: 'bots.dca' },
      { label: 'bots.combo', doc: PROD_COMBO_BOT, endpoint: 'bots.combo' },
    ] as const
    for (const { label, doc, endpoint } of cases) {
      for (const preset of ['minimal', 'standard', 'extended'] as const) {
        it(`${label} fields=${preset} names no path that is absent from the document`, () => {
          expect(
            unresolvedPathsFor(doc as any, endpoint, preset),
          ).to.deep.equal([])
        })
      }
    }
    for (const preset of ['minimal', 'standard', 'extended'] as const) {
      it(`deals.dca fields=${preset} names no path that is absent from the document`, () => {
        expect(
          unresolvedPathsFor(
            PROD_DCA_DEAL as any,
            'deals.dca',
            preset,
            DEAL_OPTIONAL,
          ),
        ).to.deep.equal([])
      })
    }
  })

  describe('§1.1 standard returns the timestamps', () => {
    it('dca returns the creation and update timestamps', () => {
      const res = read(PROD_DCA_BOT as any, 'bots.dca', 'standard')
      expect(res.created).to.not.equal(undefined)
      expect(res.updated).to.not.equal(undefined)
    })

    it('combo returns the creation and update timestamps', () => {
      const res = read(PROD_COMBO_BOT as any, 'bots.combo', 'standard')
      expect(res.created).to.not.equal(undefined)
      expect(res.updated).to.not.equal(undefined)
    })
  })

  describe('§1.1 extended returns the DCA settings it names', () => {
    it('returns the stop loss, the trailing exits and the safety-order ladder', () => {
      const res = read(PROD_DCA_BOT as any, 'bots.dca', 'extended')
      expect(res.settings?.useSl).to.equal(true)
      expect(res.settings?.slPerc).to.equal('-7')
      expect(res.settings?.trailingTp).to.equal(true)
      expect(res.settings?.trailingTpPerc).to.equal('0.9')
      expect(res.settings?.trailingSl).to.equal(true)
      expect(res.settings?.ordersCount).to.equal(8)
      expect(res.settings?.activeOrdersCount).to.equal(3)
    })

    it('combo returns them too', () => {
      const res = read(PROD_COMBO_BOT as any, 'bots.combo', 'extended')
      expect(res.settings?.useSl).to.equal(true)
      expect(res.settings?.slPerc).to.equal('-25')
      expect(res.settings?.trailingTpPerc).to.equal('1.2')
      expect(res.settings?.ordersCount).to.equal(6)
      expect(res.settings?.activeOrdersCount).to.equal(2)
    })
  })

  describe("§1.1 extended returns the deal's order ladder", () => {
    it('returns the safety order size and count', () => {
      const res = read(PROD_DCA_DEAL as any, 'deals.dca', 'extended')
      expect(res.settings?.baseOrderSize).to.equal('50')
      expect(res.settings?.orderSize).to.equal('25')
      expect(res.settings?.ordersCount).to.equal(8)
    })
  })

  describe('§1.2 a read-modify-create round trip keeps the settings', () => {
    it('does not fall back to the DCA_FORM_DEFAULTS stop loss, trailing and ladder', () => {
      // What the caller reads back...
      const read_ = read(PROD_DCA_BOT as any, 'bots.dca', 'extended')

      // ...adjusted (new pair, bigger base order)...
      const body = {
        ...read_.settings,
        pair: ['ARB_USDT'],
        baseOrderSize: '75',
      }

      // ...and merged by POST /api/v2/bots/dca (api.ts:2229).
      const stored = { ...DCA_FORM_DEFAULTS, ...body }

      // the defaults that would silently win if the field were unreadable
      expect(DCA_FORM_DEFAULTS.useSl).to.equal(false)
      expect(DCA_FORM_DEFAULTS.trailingTp).to.equal(false)
      expect(DCA_FORM_DEFAULTS.ordersCount).to.equal(5)
      expect(DCA_FORM_DEFAULTS.activeOrdersCount).to.equal(1)

      expect(stored.useSl).to.equal(true)
      expect(stored.slPerc).to.equal('-7')
      expect(stored.trailingTp).to.equal(true)
      expect(stored.trailingTpPerc).to.equal('0.9')
      expect(stored.trailingSl).to.equal(true)
      expect(stored.ordersCount).to.equal(8)
      expect(stored.activeOrdersCount).to.equal(3)
      // the caller's own edits survive too
      expect(stored.pair).to.deep.equal(['ARB_USDT'])
      expect(stored.baseOrderSize).to.equal('75')
    })
  })

  describe('§2.3 the preset names exist on DCABotSettings', () => {
    it('names only settings paths that DCA_FORM_DEFAULTS declares', () => {
      const declared = new Set(Object.keys(DCA_FORM_DEFAULTS))
      const unknown = (parseFieldsParam('extended', 'bots.dca') ?? [])
        .filter((f) => f.startsWith('settings.'))
        .map((f) => f.slice('settings.'.length))
        .filter((k) => !declared.has(k))
      expect(unknown).to.deep.equal([])
    })
  })
})
