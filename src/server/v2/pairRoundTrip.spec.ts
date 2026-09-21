/**
 * Spec 067 — the v2 create endpoints must accept the pair format the v2 reads
 * return, and must resolve it to the instrument the bot actually trades.
 *
 * Run: npm test  (mocha, src/**\/*.spec.ts)
 *
 * No DB: `pairDb` is a singleton instance on `db/dbInit`, so replacing its
 * `readData` with a matcher over verbatim production `pairs` rows drives the
 * real validators end to end. The read side is the real preset projection
 * (`parseFieldsParam` -> `filterFields`), exactly as the GET handlers build it.
 */
import { expect } from 'chai'
import { pairDb } from '../../db/dbInit'
import { StatusEnum } from '../../../types'

/**
 * Verbatim production `pairs` rows (2026-09-20). The BTC/USDT trio on
 * binanceUsdm is the ambiguity spec 067 §2.3 measures: one perpetual and two
 * dated delivery contracts sharing a base and a quote.
 */
const PROD_PAIRS: any[] = [
  {
    exchange: 'binanceUsdm',
    pair: 'ARBUSDT',
    baseAsset: { name: 'ARB' },
    quoteAsset: { name: 'USDT' },
  },
  {
    exchange: 'binanceUsdm',
    pair: 'BTCUSDT',
    baseAsset: { name: 'BTC' },
    quoteAsset: { name: 'USDT' },
  },
  {
    exchange: 'binanceUsdm',
    pair: 'BTCUSDT_260925',
    baseAsset: { name: 'BTC' },
    quoteAsset: { name: 'USDT' },
  },
  {
    exchange: 'binanceUsdm',
    pair: 'BTCUSDT_261225',
    baseAsset: { name: 'BTC' },
    quoteAsset: { name: 'USDT' },
  },
  {
    exchange: 'binanceCoinm',
    pair: 'BTCUSD_PERP',
    baseAsset: { name: 'BTC' },
    quoteAsset: { name: 'USD' },
  },
  {
    exchange: 'binance',
    pair: 'ARBUSDT',
    baseAsset: { name: 'ARB' },
    quoteAsset: { name: 'USDT' },
  },
]

const matchesFilter = (row: any, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, expected]) => {
    const actual = key
      .split('.')
      .reduce((o: any, seg) => (o == null ? o : o[seg]), row)
    return actual === expected
  })

const originalReadData = (pairDb as any).readData

before(() => {
  ;(pairDb as any).readData = async (
    filter: Record<string, unknown>,
    _projection?: unknown,
    _options?: unknown,
    returnArray?: boolean,
  ) => {
    const found = PROD_PAIRS.filter((p) => matchesFilter(p, filter))
    return {
      status: StatusEnum.ok,
      reason: null,
      data: { result: returnArray ? found : (found[0] ?? null) },
    }
  }
})

after(() => {
  ;(pairDb as any).readData = originalReadData
})

/* eslint-disable @typescript-eslint/no-require-imports */
const { parseFieldsParam, filterFields } = require('./fieldUtils')
const { endpointForBotType } = require('./fieldConfig')
const { GRID_FORM_DEFAULTS, DCA_FORM_DEFAULTS } = require('./botDefaults')
const {
  validateCreateGridBotInput,
  validateCreateDCABotInput,
} = require('./validators/bots')
const { applyGridFuturesConstraints, clonedBotPair } = require('./helpers')
/* eslint-enable @typescript-eslint/no-require-imports */

const EXCHANGE_UUID = 'e0000000-0000-0000-0000-000000000000'

/** Verbatim production grid bot 6571fe5b599f7886f62d5017 (binanceUsdm). */
const prodGridBot = (pair: string, symbol: any) => ({
  _id: '6571fe5b599f7886f62d5017',
  uuid: 'a0b1c2d3-0000-0000-0000-000000000000',
  status: 'archive',
  exchange: 'binanceUsdm',
  exchangeUUID: EXCHANGE_UUID,
  paperContext: false,
  symbol,
  settings: {
    name: '',
    pair,
    profitCurrency: 'quote',
    orderFixedIn: 'base',
    topPrice: 1.5,
    lowPrice: 0.9,
    levels: 146,
    gridStep: 0.0035,
    budget: 2500,
    ordersInAdvance: 9,
    useOrderInAdvance: false,
    prioritize: 'level',
    sellDisplacement: 0.0004,
    gridType: 'geometric',
    tpSl: true,
    tpSlCondition: 'priceReached',
    tpSlAction: 'stopAndSell',
    slCondition: 'valueChanged',
    slAction: 'stop',
    tpPerc: 0.2,
    slPerc: -0.2,
    tpTopPrice: 1.51,
    slLowPrice: 1.0653,
    updatedBudget: true,
    useStartPrice: false,
    startPrice: '1.18364367',
    marginType: 'cross',
    leverage: 5,
    futures: true,
    coinm: false,
    strategy: 'LONG',
    futuresStrategy: 'LONG',
  },
  profit: { total: 0, totalUsd: 0 },
  levels: { active: { buy: 0, sell: 0 }, all: { buy: 0, sell: 0 } },
  created: 1701860955000,
  updated: 1701860955000,
})

/** Verbatim production DCA bot: `settings.pair` is an array of native symbols. */
const prodDcaBot = (pair: string[]) => ({
  _id: '65302eaef5888d829ec72b08',
  uuid: 'b0b1c2d3-0000-0000-0000-000000000000',
  status: 'open',
  exchange: 'binance',
  exchangeUUID: EXCHANGE_UUID,
  paperContext: false,
  settings: {
    name: 'round trip',
    pair,
    strategy: 'LONG',
    baseOrderSize: '5',
    startCondition: 'asap',
    slPerc: '-10',
    ordersCount: 5,
    activeOrdersCount: 1,
    useSl: false,
    trailingSl: false,
    trailingTp: false,
    trailingTpPerc: '0.3',
  },
  profit: { total: 0, totalUsd: 0 },
  deals: { all: 0, active: 0 },
  created: 1695400000000,
  updated: 1695400000000,
})

/** What `GET /api/v2/bots/:botType?fields=extended` hands a caller back. */
const readExtended = (bot: any, botType: 'grid' | 'dca') =>
  filterFields(bot, parseFieldsParam('extended', endpointForBotType(botType)))

/** What `POST /api/v2/bots/grid` does with that body (`api.ts:2576`). */
const postGrid = async (readBack: any, exchange: string) => {
  const body = { ...readBack.settings, exchangeUUID: EXCHANGE_UUID }
  const settings = applyGridFuturesConstraints({
    ...GRID_FORM_DEFAULTS,
    ...body,
    futures: true,
    coinm: false,
    exchange,
    exchangeUUID: EXCHANGE_UUID,
  })
  delete (settings as any).vars
  return validateCreateGridBotInput(settings, body)
}

/** What `POST /api/v2/bots/dca` does with that body (`api.ts:2228`). */
const postDca = async (readBack: any) => {
  const body = { ...readBack.settings, exchangeUUID: EXCHANGE_UUID }
  const settings = {
    ...DCA_FORM_DEFAULTS,
    ...body,
    type: 'regular',
    futures: false,
    coinm: false,
    exchange: 'binance',
    exchangeUUID: EXCHANGE_UUID,
    vars: { list: [], paths: [] },
  }
  return validateCreateDCABotInput(settings, body, '650da8e761845af24b76e600')
}

describe('spec 067 — v2 pair round trip', () => {
  describe('§1.2 the create endpoint accepts what the read returned', () => {
    it('grid: the stored native symbol round trips', async () => {
      const bot = prodGridBot('ARBUSDT', {
        symbol: 'ARBUSDT',
        baseAsset: 'ARB',
        quoteAsset: 'USDT',
      })
      const read: any = readExtended(bot, 'grid')
      expect(read.settings.pair).to.equal('ARBUSDT')

      const result = await postGrid(read, 'binanceUsdm')
      expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      expect(result.valid).to.equal(true)
      expect(result.data.pair).to.equal('ARBUSDT')
    })

    it('dca: the stored native symbols round trip', async () => {
      const read: any = readExtended(prodDcaBot(['ARBUSDT']), 'dca')
      expect(read.settings.pair).to.deep.equal(['ARBUSDT'])

      const result = await postDca(read)
      expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      expect(result.valid).to.equal(true)
      expect(result.data.pair).to.deep.equal(['ARBUSDT'])
    })
  })

  describe('§2.3 resolution picks the instrument the bot trades', () => {
    it('a dated delivery contract does not collapse onto the perpetual', async () => {
      const bot = prodGridBot('BTCUSDT_260925', {
        symbol: 'BTCUSDT_260925',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
      })
      const read: any = readExtended(bot, 'grid')
      expect(read.settings.pair).to.equal('BTCUSDT_260925')

      const result = await postGrid(read, 'binanceUsdm')
      expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      expect(result.data.pair).to.equal('BTCUSDT_260925')
    })

    it('a `*_PERP` symbol resolves to itself, not to base/quote', async () => {
      const bot = prodGridBot('BTCUSD_PERP', {
        symbol: 'BTCUSD_PERP',
        baseAsset: 'BTC',
        quoteAsset: 'USD',
      })
      const read: any = readExtended(bot, 'grid')
      const result = await postGrid(read, 'binanceCoinm')
      expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      expect(result.data.pair).to.equal('BTCUSD_PERP')
    })

    it('the documented BASE_QUOTE input keeps resolving as before', async () => {
      const bot = prodGridBot('ARB_USDT', {
        symbol: 'ARBUSDT',
        baseAsset: 'ARB',
        quoteAsset: 'USDT',
      })
      const read: any = readExtended(bot, 'grid')
      const result = await postGrid(read, 'binanceUsdm')
      expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      expect(result.data.pair).to.equal('ARBUSDT')
    })

    it('dca still accepts BASE_QUOTE and still stores the native symbol', async () => {
      const read: any = readExtended(prodDcaBot(['ARB_USDT']), 'dca')
      const result = await postDca(read)
      expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      expect(result.data.pair).to.deep.equal(['ARBUSDT'])
    })
  })

  describe('§2.1 an unknown pair is still refused', () => {
    it('grid: a symbol the exchange does not list is rejected', async () => {
      const bot = prodGridBot('NOSUCHUSDT', {
        symbol: 'NOSUCHUSDT',
        baseAsset: 'NOSUCH',
        quoteAsset: 'USDT',
      })
      const read: any = readExtended(bot, 'grid')
      const result = await postGrid(read, 'binanceUsdm')
      expect(result.valid).to.equal(false)
      expect(result.errors.map((e: string[]) => e[0])).to.include('pair')
    })

    it('grid: a blank pair is still rejected by the format gate', async () => {
      const bot = prodGridBot('   ', {
        symbol: '',
        baseAsset: '',
        quoteAsset: '',
      })
      const read: any = readExtended(bot, 'grid')
      const result = await postGrid(read, 'binanceUsdm')
      expect(result.valid).to.equal(false)
      expect(result.errors.map((e: string[]) => e[0])).to.include('pair')
    })

    it('dca: a non-string entry is still rejected by the format gate', async () => {
      const read: any = readExtended(prodDcaBot([42 as any]), 'dca')
      const result = await postDca(read)
      expect(result.valid).to.equal(false)
      expect(result.errors.map((e: string[]) => e[0])).to.include('pair')
    })
  })

  describe('§3 the shared resolution rule', () => {
    // `findPairBySymbol` is the rule every v2 pair lookup now shares,
    // including `submitBacktestRequest`, whose own copy lives inside a route
    // closure and cannot be driven directly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { findPairBySymbol } = require('../../bot/utils')
    const usdm = PROD_PAIRS.filter((p) => p.exchange === 'binanceUsdm')

    it('prefers the exchange-native symbol over a base/quote split', () => {
      expect(findPairBySymbol(usdm, 'BTCUSDT_260925').pair).to.equal(
        'BTCUSDT_260925',
      )
      expect(findPairBySymbol(usdm, 'BTCUSDT').pair).to.equal('BTCUSDT')
    })

    it('falls back to the documented BASE_QUOTE format', () => {
      expect(findPairBySymbol(usdm, 'ARB_USDT').pair).to.equal('ARBUSDT')
      expect(findPairBySymbol(usdm, ' ARB _ USDT ').pair).to.equal('ARBUSDT')
    })

    it('resolves nothing for an unlisted or unparseable input', () => {
      expect(findPairBySymbol(usdm, 'NOSUCHUSDT')).to.equal(undefined)
      expect(findPairBySymbol(usdm, 'ARB_')).to.equal(undefined)
      expect(findPairBySymbol(usdm, '')).to.equal(undefined)
    })
  })

  describe('§1.3 clone reuses the source bot pair as stored', () => {
    it('a grid clone without an override keeps the native symbol', () => {
      expect(clonedBotPair('BTCUSDT_260925', undefined)).to.equal(
        'BTCUSDT_260925',
      )
      expect(clonedBotPair('ARBUSDT', [])).to.equal('ARBUSDT')
    })

    it('an explicit pair override still wins', () => {
      expect(clonedBotPair('ARBUSDT', ['BTCUSDT'])).to.deep.equal(['BTCUSDT'])
    })
  })
})
