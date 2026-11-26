process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `275.futures-grid-quote-profit-omits-the-buy-fee`.
 *
 * A futures grid books the fee of a BUY fill in base (`comBase`, the shape
 * `orderFee.ts` documents) and leaves `comQuote` at 0. The running
 * `profit.total` / `freeTotal` of a quote-profit bot subtracted `comQuote`
 * only, so every buy leg's fee was left in the total, while the USD figure
 * (`totalQuote`) already converted it.
 *
 * The fixture is one NEUTRAL Bybit USDⓈ-M round trip recorded in prod
 * (spec §2): a SELL of 15 at 0.07581 (fee 0.00022743 quote) matched by a BUY
 * of 15 at 0.07498 (fee 0.00022494 quote, booked as 0.003 base).
 *
 * Drives the REAL `createTransaction` off the mixin with a fake base class.
 * Harness shape copied from `gridTransactionProfitRace.spec.ts` (spec 073).
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import {
  BotType,
  ExchangeEnum,
  FuturesStrategyEnum,
  OrderSideEnum,
  PositionSide,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0275'
const USER_ID = 'aaaaaaaaaaaaaaaaaaaa0275'

const QTY = 15
const SELL_PRICE = 0.07581
const BUY_PRICE = 0.07498
const SELL_FEE_QUOTE = 0.00022743
const BUY_FEE_QUOTE = 0.00022494
/** (0.07581 − 0.07498) × 15 */
const GROSS = 0.01245

let Helper: any

const sellFill: any = {
  clientOrderId: 'GRID-RO-sell-0275',
  orderId: 's0275',
  botId: BOT_ID,
  symbol: 'CCUSDT',
  baseAsset: 'CC',
  quoteAsset: 'USDT',
  side: OrderSideEnum.sell,
  type: 'LIMIT',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.regular,
  price: `${SELL_PRICE}`,
  origPrice: `${SELL_PRICE}`,
  origQty: `${QTY}`,
  executedQty: `${QTY}`,
  updateTime: 1795543296258,
  feePaid: `${SELL_FEE_QUOTE}`,
  feeSide: 'quote',
}
const buyFill: any = {
  ...sellFill,
  clientOrderId: 'GRID-RO-buy-0275',
  orderId: 'b0275',
  side: OrderSideEnum.buy,
  price: `${BUY_PRICE}`,
  origPrice: `${BUY_PRICE}`,
  updateTime: 1795545781725,
  feePaid: `${BUY_FEE_QUOTE}`,
}

const makeBot = (opts: { feeByAsset: boolean; futures?: boolean }) => {
  const transactions: any[] = []
  const filled: any[] = []
  const futures = opts.futures ?? true
  class TestBot extends Helper {
    public transactions = transactions
    public filled = filled
    public updates: any[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public math = new MathHelper()
    public orderQueue: any[] = []
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.bybitUsdm,
      paperContext: false,
      flags: opts.feeByAsset ? ['feeByAsset'] : [],
      symbol: { symbol: 'CCUSDT', baseAsset: 'CC', quoteAsset: 'USDT' },
      settings: {
        name: 'buy fee',
        pair: 'CCUSDT',
        futures,
        coinm: false,
        strategy: StrategyEnum.long,
        futuresStrategy: FuturesStrategyEnum.neutral,
        profitCurrency: 'quote',
        newProfit: true,
        feeOrder: false,
        topPrice: 0.0754,
      },
      transactionsCount: { buy: 0, sell: 0 },
      initialPrice: 0.0754,
      initialPriceStart: 0.0754,
      initialBalances: { base: 0, quote: 100 },
      currentBalances: { base: 0, quote: 100 },
      position: { side: PositionSide.BOTH, qty: 0, price: 0 },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    /** BUY at 0.07498 (level 0) is matched against the SELL at level 1. */
    public initialGrid: any[] = [
      { price: { buy: BUY_PRICE, sell: 0.0754 } },
      { price: { buy: 0.0754, sell: SELL_PRICE } },
    ]
    public exchange: any = {}
    public transactionDb: any = {
      countData: async () => ({ status: StatusEnum.ok, data: { result: 0 } }),
      createData: async (doc: any) => {
        transactions.push(doc)
        return {
          status: StatusEnum.ok,
          data: { ...doc, _id: `t${transactions.length}`, updateTime: 0 },
        }
      },
    }
    get futures() {
      return futures
    }
    get coinm() {
      return false
    }
    get futuresStrategy() {
      return FuturesStrategyEnum.neutral
    }
    get isShort() {
      return false
    }
    async getExchangeInfo() {
      return {
        pair: 'CCUSDT',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 1, name: 'CC' },
        quoteAsset: { minAmount: 1, step: 0.00001, name: 'USDT' },
      }
    }
    async generateCurrentGrids() {
      return []
    }
    /** 15 × 0.0002 = 0.003 base on the buy; 15 × 0.07581 × 0.0002 on the sell. */
    async getUserFee() {
      return { maker: 0.0002, taker: 0.00055 }
    }
    async getUsdRate() {
      return 1
    }
    getOrdersByStatusAndDealId() {
      return filled
    }
    updateUserProfitStep() {}
    saveProfitToDb() {}
    deleteOrder() {}
    updateData(data: any) {
      this.updates.push(data)
    }
    emit() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
  }
  return new (TestBot as any)()
}

const roundTrip = async (bot: any) => {
  await bot.createTransaction(sellFill)
  bot.filled.push(sellFill)
  await bot.createTransaction(buyFill)
}

describe('futures grid quote profit subtracts the buy fee (spec 275)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  for (const feeByAsset of [false, true]) {
    describe(`feeByAsset ${feeByAsset ? 'on (observed fee)' : 'off (rate estimate)'}`, () => {
      it("§1.1 profit.total and freeTotal take out both legs' fees", async () => {
        const bot = makeBot({ feeByAsset })
        await roundTrip(bot)
        const expected = GROSS - SELL_FEE_QUOTE - BUY_FEE_QUOTE
        expect(bot.transactions).to.have.length(2)
        expect(bot.transactions[1].profitQuote).to.be.closeTo(GROSS, 1e-12)
        expect(bot.data.profit.total).to.be.closeTo(expected, 1e-12)
        expect(bot.data.profit.freeTotal).to.be.closeTo(expected, 1e-12)
        const persisted = bot.updates.filter((u: any) => u.profit).pop()
        expect(persisted.profit.total).to.be.closeTo(expected, 1e-12)
      })

      it("§1.1 the BUY row's running cumulative includes its fee", async () => {
        const bot = makeBot({ feeByAsset })
        await roundTrip(bot)
        expect(bot.transactions[1].cummulativeProfitQuote).to.be.closeTo(
          GROSS - SELL_FEE_QUOTE - BUY_FEE_QUOTE,
          1e-12,
        )
      })

      it("§1.3 the USD figure and the row's fee fields are unchanged", async () => {
        const bot = makeBot({ feeByAsset })
        await roundTrip(bot)
        expect(bot.data.profit.totalUsd).to.be.closeTo(
          GROSS - SELL_FEE_QUOTE - BUY_FEE_QUOTE,
          1e-12,
        )
        const buyRow = bot.transactions[1]
        expect(buyRow.feeQuote, 'a buy keeps its fee in base').to.equal(0)
        expect(buyRow.feeBase).to.be.closeTo(0.003, 1e-12)
        if (feeByAsset) {
          // The fee ledger counts the fee once, as the row records it.
          expect(bot.data.feePaid.quote).to.be.closeTo(SELL_FEE_QUOTE, 1e-12)
        }
      })
    })
  }
})
