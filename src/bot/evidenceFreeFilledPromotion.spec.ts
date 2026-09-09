process.env.NODE_ENV = 'testing'

/**
 * End-to-end regression tests for spec
 * `028.venue-filled-with-no-fill-evidence` (issue #719).
 *
 * Drives the REAL `MainBot.mergeCommonOrderWithOrder` off the prototype and the
 * REAL `dcaHelper.closeDeal` off the mixin, over the production state recorded
 * on 2026-09-08 behind `D-TP-137EO6y5r2vznkgosxjmnnvoYkEeSR` (ZRX-USDC,
 * coinbase, deal `6a9ca65ce93810e4ab166d77`).
 *
 * Coinbase answered the reconcile lookup with an order that claimed
 * `status FILLED` while stating no executed quantity, no executed value, no
 * fill time and no fills. Three things followed, and each is asserted here:
 *
 *   1. the merge copied `FILLED` verbatim and `updateOrderOnDb` made the
 *      resting take-profit terminal (§4.2);
 *   2. `+quote !== 0 && base !== 0` is TRUE for NaN, so the merged price was
 *      `round(NaN/NaN)` -> NaN -> `0`, written over the real limit price
 *      (§4.4);
 *   3. `parseFloat(undefined)` reached `closeDeal` as the close quantity, so
 *      the deal was closed on nothing and its save was refused with
 *      `CastError … at path "size"` — leaving the order terminal, the deal
 *      open and the position with zero live orders (§4.5).
 *
 * Importing either module opens no connections; instance properties shadow
 * prototype methods. No Mongo, Redis, venue or bot stack is needed and nothing
 * here places or cancels anything. Harness shape copied from
 * `nanOrderRefusal.spec.ts` (spec 025) and `dca/tpNanRefusal.harness.spec.ts`
 * (spec 023).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { ExchangeEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = '6a9ca65ce93810e4ab166d77'
const TP_ID = 'D-TP-137EO6y5r2vznkgosxjmnnvoYkEeSR'

/** The take-profit as it rested on the venue and in our `orders` collection. */
const RESTING_TP: any = {
  _id: '6a9fed49d7caeff1c5aa8c98',
  clientOrderId: TP_ID,
  orderId: '861fed88-0d0e-444c-b4be-2fe03a759172',
  symbol: 'ZRX-USDC',
  baseAsset: 'ZRX',
  quoteAsset: 'USDC',
  side: 'SELL',
  type: 'LIMIT',
  status: 'NEW',
  price: '0.105085',
  origPrice: '0.105085',
  origQty: '237.37538',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  fills: [],
  transactTime: 1788865865697,
  updateTime: 1788865865697,
  exchange: ExchangeEnum.coinbase,
  exchangeUUID: 'be79d28a-28b9-448a-b2b3-31e5be28d5ad',
  typeOrder: 'dealTP',
  dealId: DEAL_ID,
  botId: '6a9456d3cb09e28f98a19344',
  userId: '6a8b1db88e06bef801d752bd',
}

/**
 * What the venue answered, as it reached main-app.
 *
 * `convertOrder` builds `updateTime`/`transactTime` from `+new Date(...)` of an
 * absent field — NaN, which JSON renders as `null` — and passes the absent
 * `filled_size`/`filled_value` straight through, so those keys do not survive
 * the wire at all. `price` is the connector's own `'0'` for a MARKET order with
 * no average fill price; `side`/`type` are its fallbacks for fields the payload
 * did not carry.
 */
const EVIDENCE_FREE_ANSWER: any = {
  symbol: 'ZRX-USDC',
  orderId: '861fed88-0d0e-444c-b4be-2fe03a759172',
  clientOrderId: TP_ID,
  transactTime: null,
  updateTime: null,
  price: '0',
  origQty: undefined,
  executedQty: undefined,
  cummulativeQuoteQty: undefined,
  status: 'FILLED',
  type: 'MARKET',
  side: 'BUY',
  fills: [],
}

/** The same lookup once the venue answers properly: must be unaffected. */
const REAL_FILL_ANSWER: any = {
  symbol: 'ZRX-USDC',
  orderId: '861fed88-0d0e-444c-b4be-2fe03a759172',
  clientOrderId: TP_ID,
  transactTime: 1788873357668,
  updateTime: 1788873400000,
  price: '0.105085',
  origQty: '237.37538',
  executedQty: '237.37538',
  cummulativeQuoteQty: '24.944592',
  status: 'FILLED',
  type: 'LIMIT',
  side: 'SELL',
  fills: [],
}

const makeMergeBot = () => {
  const bot: any = Object.create(MainBot.prototype)
  const warnings: string[] = []
  Object.assign(bot, {
    botId: RESTING_TP.botId,
    userId: RESTING_TP.userId,
    math: new MathHelper(),
    warnings,
    data: {
      exchange: ExchangeEnum.coinbase,
      exchangeUUID: RESTING_TP.exchangeUUID,
      paperContext: false,
      settings: {},
      flags: [],
    },
    handleLog: () => undefined,
    handleDebug: () => undefined,
    handleWarn: (m: string) => {
      warnings.push(m)
    },
    handleErrors: (m: string) => {
      warnings.push(m)
    },
    getExchangeInfo: async () => ({
      pair: 'ZRX-USDC',
      priceAssetPrecision: 6,
      baseAsset: { minAmount: 0.1, step: 0.00001, name: 'ZRX' },
      quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
    }),
  })
  for (const [name, value] of Object.entries({
    coinm: false,
    futures: false,
    sizedInContracts: false,
    isBitget: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

/** The deal as Mongo still holds it: open, holding the whole position. */
const makeDeal = () => ({
  _id: DEAL_ID,
  botId: RESTING_TP.botId,
  userId: RESTING_TP.userId,
  status: 'open',
  symbol: { symbol: 'ZRX-USDC', baseAsset: 'ZRX', quoteAsset: 'USDC' },
  size: 239.28970000000012,
  avgPrice: 0.10240633813728714,
  lastPrice: 0.10240633813728714,
  initialPrice: 0.105085,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  levels: { all: 36, complete: 4 },
  commission: 0,
  profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
  currentBalances: { base: 239.2897, quote: 208.79598640779997 },
  initialBalances: { base: 0, quote: 233.30070325 },
  assets: {
    used: { base: 0, quote: 0 },
    required: { base: 0, quote: 0 },
  },
  usage: {
    max: { base: 0, quote: 233.3 },
    current: { base: 0, quote: 24.5 },
    maxUsd: 233.3,
    currentUsd: 24.5,
    relative: 0.1,
  },
  updateTime: 1788865863948,
})

let Helper: any

const makeCloseBot = (deal: any) => {
  const saves: any[] = []
  const errors: string[] = []
  class TestBot extends Helper {
    public saves = saves
    public errors = errors
    public pendingClose = new Set<string>()
    public orders = new Map()
    public deals = new Map()
    public isLong = true
    public futures = false
    public coinm = false
    public combo = false
    public botType = 'dca'
    public data: any = {
      exchange: ExchangeEnum.coinbase,
      settings: { name: 'bot', pair: ['ZRX-USDC'] },
      flags: [],
      profit: { total: 0, totalUsd: 0, pureBase: 0, pureQuote: 0 },
    }
    getDeal(id: string) {
      return id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    saveDeal(_full: any, changed: any) {
      saves.push(changed)
      return Promise.resolve()
    }
    async finishDealFunding() {}
    async profitBase() {
      return false
    }
    async getUserFee() {
      return { maker: 0.006, taker: 0.012 }
    }
    async getCommDeal() {
      return 0
    }
    async getUsdRate() {
      return 1
    }
    async getExchangeInfo() {
      return {
        pair: 'ZRX-USDC',
        priceAssetPrecision: 6,
        baseAsset: { minAmount: 0.1, step: 0.00001, name: 'ZRX' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
      }
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    async processDealClose() {
      return false
    }
    saveProfitToDb() {}
    updateUserProfitStep() {}
    updateData() {}
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn(m: string) {
      errors.push(m)
    }
    handleErrors(m: string) {
      errors.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

describe('evidence-free FILLED promotion (spec 028, issue #719)', () => {
  before(function () {
    // One ts-node compile of a 21k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.2 the merge refuses a FILLED that states no fill', () => {
    it('keeps the local status instead of making the order terminal', async () => {
      const bot = makeMergeBot()
      const merged = await bot.mergeCommonOrderWithOrder(
        EVIDENCE_FREE_ANSWER,
        RESTING_TP,
      )
      expect(merged.status).to.equal('NEW')
    })

    it('says so once, naming the order and what the venue stated', async () => {
      const bot = makeMergeBot()
      await bot.mergeCommonOrderWithOrder(EVIDENCE_FREE_ANSWER, RESTING_TP)
      expect(bot.warnings.join('\n')).to.contain(TP_ID)
      expect(bot.warnings.join('\n').toLowerCase()).to.contain('no fill')
    })

    it('§4.3 does not erase the local executed quantity with a value the venue never stated', async () => {
      const bot = makeMergeBot()
      const merged = await bot.mergeCommonOrderWithOrder(
        EVIDENCE_FREE_ANSWER,
        RESTING_TP,
      )
      // `parseFloat(undefined)` is what reached `closeDeal` as the close
      // quantity and became `deal.size = NaN`.
      expect(Number.isFinite(parseFloat(merged.executedQty))).to.equal(
        true,
        `executedQty ${merged.executedQty}`,
      )
      expect(merged.executedQty).to.equal('0')
      expect(merged.cummulativeQuoteQty).to.equal('0')
    })

    it('§4.4 keeps the real limit price instead of collapsing NaN/NaN to 0', async () => {
      const bot = makeMergeBot()
      const merged = await bot.mergeCommonOrderWithOrder(
        EVIDENCE_FREE_ANSWER,
        RESTING_TP,
      )
      expect(+merged.price).to.equal(0.105085)
    })

    it('still prices a payload that states a quantity but no executed value from the payload', async () => {
      // The fallbacks introduced for §4.3 decide what the ORDER carries; they
      // must NOT reach the price derivation, or our stale `'0'` would silence
      // `co.price * co.executedQty` and the venue's own fill price would be
      // replaced by the resting limit price.
      const bot = makeMergeBot()
      const merged = await bot.mergeCommonOrderWithOrder(
        {
          ...REAL_FILL_ANSWER,
          price: '0.11',
          cummulativeQuoteQty: undefined,
        },
        RESTING_TP,
      )
      expect(+merged.price).to.equal(0.11)
      expect(merged.status).to.equal('FILLED')
      expect(bot.warnings).to.have.length(0)
    })

    it('leaves a genuine fill answer completely untouched', async () => {
      const bot = makeMergeBot()
      const merged = await bot.mergeCommonOrderWithOrder(
        REAL_FILL_ANSWER,
        RESTING_TP,
      )
      expect(merged.status).to.equal('FILLED')
      expect(merged.executedQty).to.equal('237.37538')
      expect(merged.cummulativeQuoteQty).to.equal('24.944592')
      expect(merged.updateTime).to.equal(1788873400000)
      // quote/base = 24.94355 / 237.37538, rounded to the pair's 6 dp.
      expect(+merged.price).to.equal(0.105085)
      expect(bot.warnings).to.have.length(0)
    })
  })

  describe('§4.5 closeDeal refuses a take-profit that closed nothing', () => {
    /**
     * The promoted row exactly as production persisted it, and as
     * `processFilledOrder` handed it to `closeDeal`: `executedQty` is absent
     * in memory even though the DB row reads `'0'`, because mongoose strips an
     * `undefined` from a `$set` and left the previous value standing.
     */
    const PROMOTED_TP: any = {
      ...RESTING_TP,
      status: 'FILLED',
      type: 'MARKET',
      side: 'BUY',
      price: '0',
      executedQty: undefined,
      cummulativeQuoteQty: undefined,
      updateTime: null,
      transactTime: null,
      fills: [],
    }

    const drive = async (tpOrder: any) => {
      const deal = makeDeal()
      const bot = makeCloseBot(deal)
      let threw: unknown = null
      try {
        await bot.closeDeal(bot.data.botId, DEAL_ID, tpOrder)
      } catch (e) {
        threw = e
      }
      return { deal, bot, threw }
    }

    it('does not mark the deal closed on a NaN close quantity', async () => {
      const { deal } = await drive(PROMOTED_TP)
      expect(deal.status).to.equal('open')
    })

    it('does not mark the deal closed on a zero close quantity either', async () => {
      const { deal } = await drive({ ...PROMOTED_TP, executedQty: '0' })
      expect(deal.status).to.equal('open')
    })

    it('never writes a non-finite size or balance to the deal', async () => {
      const { bot } = await drive(PROMOTED_TP)
      for (const save of bot.saves) {
        if ('size' in save) {
          expect(Number.isFinite(save.size)).to.equal(
            true,
            `saveDeal({ size: ${save.size} })`,
          )
        }
        if (save.currentBalances) {
          expect(Number.isFinite(save.currentBalances.base)).to.equal(true)
          expect(Number.isFinite(save.currentBalances.quote)).to.equal(true)
        }
      }
    })

    it('reports the refusal naming the take-profit, so the deal is findable', async () => {
      const { bot } = await drive(PROMOTED_TP)
      expect(bot.errors.join('\n')).to.contain(TP_ID)
    })

    it('leaves the deal out of pendingClose so a later close can still run', async () => {
      const { bot } = await drive(PROMOTED_TP)
      expect(bot.pendingClose.has(DEAL_ID)).to.equal(false)
    })
  })
})
