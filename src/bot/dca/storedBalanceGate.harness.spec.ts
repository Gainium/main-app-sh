process.env.NODE_ENV = 'testing'

/**
 * The open-new-deal balance gate decides from stored balances first.
 *
 * A bot that cannot fund its next deal retries every cycle, and each try used
 * to read the whole account balance from the exchange — twice, with the 5 s
 * re-check. An account running hundreds of underfunded bots therefore spent
 * hundreds of full-account reads a minute of a rate budget shared with every
 * other user. The gate now answers a shortfall the stored, stream-maintained
 * balances already show without calling the exchange, and confirms a pass
 * with a live read before anything opens.
 *
 * Two layers, each driving the REAL engine code:
 *
 *  - `MainBot.checkAssets(…, missingAsZero)` over `Object.create(…)`: an asset
 *    with no stored row counts as zero once the connection has stored rows;
 *  - `dcaHelper.checkBalanceGate` / `comboHelper` over the mixin with a minimal
 *    base: which balance source each outcome is decided from.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import MainBot from '../main'
import { MathHelper } from '../../utils/math'
import { ConditionLatch, STANDING_CONDITION_REARM_MS } from '../conditionLatch'
import { ExchangeEnum, StatusEnum } from '../../../types'

const BOT_ID = '000000000000000000000c71'
const USER_ID = '000000000000000000000c72'
const PAIR = 'SUI-USDC'

const EXCHANGE_INFO = {
  pair: PAIR,
  priceAssetPrecision: 4,
  baseAsset: { name: 'SUI', minAmount: 0.1, step: 0.1 },
  quoteAsset: { name: 'USDC', minAmount: 1 },
  maxOrders: 200,
}

// ---------------------------------------------------------------------------
// checkAssets(…, missingAsZero)
// ---------------------------------------------------------------------------

const buildAssetsBot = (
  dbRows: { asset: string; free: number; locked: number }[],
) => {
  const venue = { calls: 0 }
  const bot: any = Object.create(MainBot.prototype)
  bot.botId = BOT_ID
  bot.userId = USER_ID
  bot.data = { exchange: ExchangeEnum.binance, exchangeUUID: '' }
  bot.pairs = new Set([PAIR])
  bot.exchange = {
    getBalance: async () => {
      venue.calls++
      return {
        status: StatusEnum.ok,
        data: [{ asset: 'USDC', free: 50, locked: 0 }],
      }
    },
  }
  bot.balancesDb = {
    readData: async () => ({
      status: StatusEnum.ok,
      data: { result: dbRows },
    }),
  }
  bot.isBNFCR = async () => false
  bot.getUser = async () => ({ exchanges: [] })
  bot.getExchangeInfo = async () => EXCHANGE_INFO
  bot.handleLog = () => undefined
  bot.handleDebug = () => undefined
  bot.handleErrors = () => undefined
  return { bot, venue }
}

// ---------------------------------------------------------------------------
// checkBalanceGate
// ---------------------------------------------------------------------------

class FakeBase {
  math = new MathHelper()
  botId = BOT_ID
  userId = USER_ID
  botType = 'dca'
  loadingComplete = true
  isLong = true
  isShort = false
  futures = false
  coinm = false
  combo = false
  hedge = false
  exchange: any = {}
  orders = new Map()
  standingConditionLatch = new ConditionLatch(STANDING_CONDITION_REARM_MS)
  data: any = {}
  shouldProceed() {
    return true
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let DcaHelper: any

type GateOpts = {
  stored: number
  live: number
  exchange?: ExchangeEnum
  reduceToAvailableBalance?: boolean
}

const buildGateBot = (o: GateOpts) => {
  const reads: string[] = []
  class TestBot extends DcaHelper {
    data: any = {
      settings: { type: 'regular', pair: [PAIR] },
      status: 'open',
      exchange: o.exchange ?? ExchangeEnum.binance,
      exchangeUUID: 'uuid-c7',
      flags: [],
    }
    pairs = new Set([PAIR])
    async checkAssets(_r: boolean, direct: boolean, missingAsZero = false) {
      const source = direct ? 'live' : missingAsZero ? 'stored' : 'other'
      reads.push(source)
      const free = source === 'live' ? o.live : o.stored
      return new Map([['USDC', { asset: 'USDC', free, locked: 0 }]])
    }
    async getAggregatedSettings() {
      return {
        type: 'regular',
        pair: [PAIR],
        skipBalanceCheck: false,
        orderSizeType: 'quote',
        baseOrderSize: '100',
        gridLevel: '1',
        ordersCount: 5,
        reduceToAvailableBalance: !!o.reduceToAvailableBalance,
      }
    }
    async getExchangeInfo() {
      return EXCHANGE_INFO
    }
    async getLeverageMultipler() {
      return 1
    }
    async getLatestPrice() {
      return 0.5
    }
    async getBaseOrder() {
      return { origQty: '200', price: '0.5' }
    }
    async createInitialDealOrders() {
      return []
    }
    async createCurrentDealOrders() {
      return []
    }
    async pooledMarginOrKeep(_a: string, available: number) {
      return available
    }
    handleLog(m: string) {
      return m
    }
    handleDebug(m: string) {
      return m
    }
  }
  return { bot: new TestBot(), reads }
}

describe('stored-balance gate for opening deals', () => {
  before(function () {
    this.timeout(180000)
    DcaHelper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  describe('checkAssets(…, missingAsZero)', () => {
    it('answers from stored rows when a pair asset has none, without the exchange', async () => {
      const { bot, venue } = buildAssetsBot([
        { asset: 'USDC', free: 10, locked: 0 },
      ])
      const res = await bot.checkAssets(true, false, true)
      expect(venue.calls).to.equal(0)
      expect(res.get('USDC').free).to.equal(10)
      expect(res.get('SUI')?.free ?? 0).to.equal(0)
    })

    it('still falls through to the exchange without the flag', async () => {
      const { bot, venue } = buildAssetsBot([
        { asset: 'USDC', free: 10, locked: 0 },
      ])
      await bot.checkAssets(true, false)
      expect(venue.calls).to.equal(1)
    })

    it('reads the exchange when the connection has no stored rows at all', async () => {
      const { bot, venue } = buildAssetsBot([])
      const res = await bot.checkAssets(true, false, true)
      expect(venue.calls).to.equal(1)
      expect(res.get('USDC').free).to.equal(50)
    })
  })

  describe('checkBalanceGate', () => {
    it('reports a shortfall the stored balances show without a live read', async () => {
      const { bot, reads } = buildGateBot({ stored: 10, live: 10_000 })
      const r = await bot.checkBalanceGate(PAIR)
      expect(r.status).to.equal(false)
      expect(reads).to.deep.equal(['stored'])
    })

    it('confirms a stored pass with a live read before a deal opens', async () => {
      const { bot, reads } = buildGateBot({ stored: 10_000, live: 10 })
      const r = await bot.checkBalanceGate(PAIR)
      // The live figure decides: a stale-high stored balance cannot open a deal.
      expect(r.status).to.equal(false)
      expect(reads).to.deep.equal(['stored', 'live'])
    })

    it('opens on a live pass', async () => {
      const { bot, reads } = buildGateBot({ stored: 10_000, live: 10_000 })
      const r = await bot.checkBalanceGate(PAIR)
      expect(r.status).to.equal(true)
      expect(reads).to.deep.equal(['stored', 'live'])
    })

    it('reads live only when the shortfall sizes a reduced deal', async () => {
      const { bot, reads } = buildGateBot({
        stored: 10,
        live: 10,
        reduceToAvailableBalance: true,
      })
      await bot.checkBalanceGate(PAIR)
      expect(reads).to.deep.equal(['live'])
    })

    for (const exchange of [ExchangeEnum.kraken, ExchangeEnum.coinbase]) {
      it(`reads live only on ${exchange}, whose stored balances are incomplete`, async () => {
        const { bot, reads } = buildGateBot({ stored: 10, live: 10, exchange })
        await bot.checkBalanceGate(PAIR)
        expect(reads).to.deep.equal(['live'])
      })
    }
  })
})
