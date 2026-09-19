process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `060.a-merged-remainder-is-counted-twice-in-the-deal-average`.
 *
 * Drives the REAL `dcaHelper.getAvgPrice` off the mixin, over the production
 * state recorded on 2026-09-19 behind DCA deal `6aaeb84fa54072cab53e993a`
 * (`OP-USDC`, coinbase) — the same deal as specs `057`/`058`.
 *
 * `buyRemainder` (`main.ts`) merges a successful remainder MARKET order back
 * INTO the row it is completing, so the remainder's own `typeOrder: 'br'` row
 * is a duplicate of quantity that already lives in its parent. Both branches
 * of `getAvgPrice` folded it a second time (§4.1 spot, §4.2 futures), pulling
 * the deal's average toward the remainder's market price. §4.3 pins the one
 * exclusion that must NOT be added: `rebalance` is a real, un-merged trade.
 *
 * Importing the module opens no connections; instance properties shadow
 * prototype methods. No Mongo, Redis, venue or bot stack is needed and nothing
 * here places or cancels anything. Harness shape copied from
 * `evidenceFreeFilledPromotion.spec.ts` (spec 028).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { TypeOrderEnum } from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const DEAL_ID = '6aaeb84fa54072cab53e993a'

/** `priceAssetPrecision` 5 — coinbase OP-USDC. */
const PRICE_PRECISION = 5

/**
 * The deal's BUY rows as they stood in the in-memory order map the moment
 * `getAvgPrice` last ran.
 *
 * `dealStart` is the MERGED row: the engine logged
 * `Total order …, 0.12273, base: 815.51, quote: 100.0894586 BUY` after
 * `buyRemainder` folded the remainder into it (34.66 filled on the book +
 * 780.85 bought at market). The `br` row below is that same 780.85 units.
 */
const MERGED_BASE_ORDER: any = {
  clientOrderId: 'D-BO-Z4WJSYyWSRtfSAPdmeKObPBpbSJsUV',
  dealId: DEAL_ID,
  symbol: 'OP-USDC',
  side: 'BUY',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.dealStart,
  price: '0.12273',
  origQty: '816.74',
  executedQty: '815.51',
  cummulativeQuoteQty: '100.0894586',
  updateTime: 1789835379801,
}

const REMAINDER_ROW: any = {
  clientOrderId: 'GA-BR-1w299fO0C47K0vaGS1PyXBCYJeod4',
  dealId: DEAL_ID,
  symbol: 'OP-USDC',
  side: 'BUY',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.br,
  price: '0.12273999999999999',
  origQty: '782.08',
  executedQty: '780.85',
  cummulativeQuoteQty: '95.841529',
  updateTime: 1789835380588,
}

const SAFETY_ORDER: any = {
  clientOrderId: 'D-RO-BcI4udnwpAA86vgTXCo20RA60MBc2e',
  dealId: DEAL_ID,
  symbol: 'OP-USDC',
  side: 'BUY',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.dealRegular,
  price: '0.1215',
  origQty: '271.6',
  executedQty: '271.6',
  cummulativeQuoteQty: '32.9994',
  updateTime: 1789838847300,
}

/** The take-profit that later sold the position — a SELL, never in the fold. */
const TAKE_PROFIT: any = {
  clientOrderId: 'D-TP-MCjaPpDgZ52bPDn3d0JRgwRFlybqde',
  dealId: DEAL_ID,
  symbol: 'OP-USDC',
  side: 'SELL',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.dealTP,
  price: '0.12403',
  origQty: '1086.02',
  executedQty: '1086.02',
  cummulativeQuoteQty: '134.6989',
  updateTime: 1789846376388,
}

/** A combo balance-diff correction — real quantity, no parent to merge into. */
const REBALANCE_ROW: any = {
  clientOrderId: 'GA-BAL-rEbAl4nCe000000000000000000000',
  dealId: DEAL_ID,
  symbol: 'OP-USDC',
  side: 'BUY',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.rebalance,
  price: '0.121',
  origQty: '100',
  executedQty: '100',
  cummulativeQuoteQty: '12.1',
  updateTime: 1789840000000,
}

/** What the deal recorded — `avgPrice` is the double-counted value. */
const STORED_AVG_PRICE = 0.12255533914002442
/** Each unit folded once: (815.51 × 0.12273 + 271.6 × 0.1215) / 1087.11. */
const CORRECT_AVG_PRICE = 0.1224227008306427

let Helper: any

function makeBot(orders: any[], futures = false) {
  class TestBot extends (Helper as any) {
    math = new MathHelper()
    futures = futures
    isLong = true
    coinm = false
    isBitget = false
    constructor() {
      super()
    }
    getOrdersByStatusAndDealId({ dealId }: { dealId?: string }) {
      return orders.filter((o) => o.dealId === dealId)
    }
    // Borrow the real position fold the futures branch depends on.
    calculateAbstractPosition = MainBot.prototype.calculateAbstractPosition
    async getExchangeInfo() {
      return {
        pair: 'OP-USDC',
        priceAssetPrecision: PRICE_PRECISION,
        baseAsset: { minAmount: 0.1, step: 0.01, name: 'OP' },
        quoteAsset: { minAmount: 1, step: 0.000001, name: 'USDC' },
      }
    }
    async baseAssetPrecision() {
      return 2
    }
    // No deal in the map -> `display` falls through to `avg` (spec 060 §5).
    getDeal() {
      return undefined
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new (TestBot as any)()
}

describe('a merged remainder counted twice in the deal average (spec 060)', () => {
  before(function () {
    // One ts-node compile of a 22k-line module.
    this.timeout(180000)
    Helper = createRequire(__filename)('./dcaHelper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.1 spot', () => {
    it('folds each unit of the entry exactly once', async () => {
      const bot = makeBot([
        MERGED_BASE_ORDER,
        REMAINDER_ROW,
        SAFETY_ORDER,
        TAKE_PROFIT,
      ])
      const { avg } = await bot.getAvgPrice(DEAL_ID)
      expect(avg).to.equal(CORRECT_AVG_PRICE)
    })

    it('no longer returns the average this deal actually stored', async () => {
      const bot = makeBot([MERGED_BASE_ORDER, REMAINDER_ROW, SAFETY_ORDER])
      const { avg } = await bot.getAvgPrice(DEAL_ID)
      expect(avg).to.not.equal(STORED_AVG_PRICE)
    })

    it('is unchanged on a deal that never sent a remainder', async () => {
      const bot = makeBot([MERGED_BASE_ORDER, SAFETY_ORDER, TAKE_PROFIT])
      const { avg } = await bot.getAvgPrice(DEAL_ID)
      expect(avg).to.equal(CORRECT_AVG_PRICE)
    })

    it('§5 carries the same correction into `display` when no deal is loaded', async () => {
      const bot = makeBot([MERGED_BASE_ORDER, REMAINDER_ROW, SAFETY_ORDER])
      const { display } = await bot.getAvgPrice(DEAL_ID)
      expect(display).to.equal(CORRECT_AVG_PRICE)
    })
  })

  describe('§4.2 futures', () => {
    it('does not fold the remainder into the position a second time', async () => {
      const withBr = makeBot(
        [MERGED_BASE_ORDER, REMAINDER_ROW, SAFETY_ORDER],
        true,
      )
      const withoutBr = makeBot([MERGED_BASE_ORDER, SAFETY_ORDER], true)
      const a = await withBr.getAvgPrice(DEAL_ID)
      const b = await withoutBr.getAvgPrice(DEAL_ID)
      expect(a.avg).to.equal(b.avg)
    })

    it('reaches the entry average, not one pulled toward the market fill', async () => {
      const bot = makeBot([MERGED_BASE_ORDER, REMAINDER_ROW, SAFETY_ORDER], true)
      const { avg } = await bot.getAvgPrice(DEAL_ID)
      // `calculateAbstractPosition` rounds to `priceAssetPrecision` per step.
      expect(avg).to.equal(
        new MathHelper().round(CORRECT_AVG_PRICE, PRICE_PRECISION),
      )
    })
  })

  describe('§4.3 `rebalance` stays in the fold', () => {
    it('spot counts a balance-diff correction — it has no parent to duplicate', async () => {
      const without = makeBot([MERGED_BASE_ORDER, SAFETY_ORDER])
      const withRebalance = makeBot([
        MERGED_BASE_ORDER,
        SAFETY_ORDER,
        REBALANCE_ROW,
      ])
      const a = await without.getAvgPrice(DEAL_ID)
      const b = await withRebalance.getAvgPrice(DEAL_ID)
      expect(b.avg).to.not.equal(a.avg)
      expect(b.avg).to.equal(
        (815.51 * 0.12273 + 271.6 * 0.1215 + 100 * 0.121) /
          (815.51 + 271.6 + 100),
      )
    })

    it('futures counts it too', async () => {
      const without = makeBot([MERGED_BASE_ORDER, SAFETY_ORDER], true)
      const withRebalance = makeBot(
        [MERGED_BASE_ORDER, SAFETY_ORDER, REBALANCE_ROW],
        true,
      )
      const a = await without.getAvgPrice(DEAL_ID)
      const b = await withRebalance.getAvgPrice(DEAL_ID)
      expect(b.avg).to.not.equal(a.avg)
    })
  })
})
