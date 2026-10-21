process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `189.a-grid-take-profit-close-sells-again-while-it-stops`.
 *
 * A spot grid's `stopAndSell` take profit queued fresh `closeBotByTp` calls
 * behind its mutex while the first close awaited the venue. Each one re-ran
 * `tpSl()` against in-memory balances the close never updated and sold the
 * whole grid amount again (spec §1.2, §2).
 *
 * These drive the REAL `closeBotByTp` off the mixin. Venue, Mongo and Redis
 * are stubbed. Harness copied from `gridStopAndSellFlatPosition.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import {
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  StatusEnum,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const BOT_ID = '6ac6abd920b6faff8240c2aa'
const USER_ID = '64c33715e3ee8daa34f19dbc'

let Helper: any

const filled = (qty: number, status = 'FILLED', type = 'MARKET') => ({
  clientOrderId: 'GRID-TP',
  orderId: '1',
  symbol: 'BTC-USDC',
  side: OrderSideEnum.sell,
  type,
  status,
  typeOrder: TypeOrderEnum.stop,
  price: '83758',
  origQty: `${qty}`,
  executedQty: status === 'FILLED' ? `${qty}` : '0',
  cummulativeQuoteQty: status === 'FILLED' ? `${qty * 83758}` : '0',
  updateTime: Date.UTC(2026, 9, 21, 13, 5, 7),
})

const makeBot = (answer: any, tpSlLimit = false) => {
  class TestBot extends Helper {
    public stopped = 0
    public sent: any[] = []
    public triggers = 0
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public log = false
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.hyperliquid,
      paperContext: false,
      symbol: { symbol: 'BTC-USDC', baseAsset: 'BTC', quoteAsset: 'USDC' },
      settings: {
        pair: 'BTC-USDC',
        futures: false,
        coinm: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
        feeOrder: false,
        tpSlAction: 'stopAndSell',
        slAction: 'stopAndSell',
        tpSlLimit,
        slLimit: false,
      },
      feeBalance: 0,
      initialPrice: 83000,
      initialBalances: { base: 0.02797, quote: 1690 },
      currentBalances: { base: 0.02797, quote: 1760 },
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    public botEventDb: any = {
      createData: () => Promise.resolve({ status: StatusEnum.ok, data: {} }),
    }
    public transactionDb: any = {
      createData: (doc: any) =>
        Promise.resolve({ status: StatusEnum.ok, data: { ...doc, _id: 't1' } }),
    }
    get futures() {
      return false
    }
    get coinm() {
      return false
    }
    get allOrders() {
      // `processFilledStop` has already deleted the filled stop (§1.2).
      return []
    }
    // The in-memory balances never change, as in prod: the trigger keeps
    // firing for as long as it is asked.
    tpSl() {
      this.triggers += 1
      return { value: 'tp', text: 'TP trigger' }
    }
    async stop() {
      this.stopped += 1
      this.blockLimit = true
    }
    async cancelAllOrder() {}
    async getExchangeInfo() {
      return {
        pair: 'BTC-USDC',
        priceAssetPrecision: 0,
        baseAsset: { minAmount: 0.00001, step: 0.00001, name: 'BTC' },
        quoteAsset: { minAmount: 10, step: 0.01, name: 'USDC' },
      }
    }
    async getLatestPrice() {
      return 83758
    }
    async sellBaseAmount() {
      return 0.02797
    }
    async sendGridToExchange(grid: any, additional: any) {
      this.sent.push({ grid, additional })
      return answer
    }
    saveProfitToDb() {}
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    getOrderId(prefix: string) {
      return prefix
    }
    updateData() {}
    emit() {}
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

const tick = { symbol: 'BTC-USDC', price: 83758, time: 0, volume: 0 }

describe('grid take-profit close is single-shot (spec 189)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§4.1 a queued fresh trigger after the close places no second sell', async () => {
    const bot = makeBot(filled(0.02797))
    // Two ticks reach closeBotByTp while the first close is in flight; the
    // mutex runs them back to back (prod 13:05:07.952Z → 13:05:07.962Z).
    await Promise.all([
      bot.closeBotByTp(BOT_ID, tick),
      bot.closeBotByTp(BOT_ID, tick),
      bot.closeBotByTp(BOT_ID, tick),
    ])
    expect(bot.sent).to.have.length(1)
    expect(bot.triggers).to.equal(1)
  })

  it('§4.1 a fresh trigger while a resting close is pending places nothing', async () => {
    const bot = makeBot(filled(0.02797, 'NEW', 'LIMIT'), true)
    bot.orderLimitRepositionTimeout = 60_000
    bot.enterMarketTimeout = 0
    await bot.closeBotByTp(BOT_ID, tick)
    clearTimeout(bot.limitTimer)
    await bot.closeBotByTp(BOT_ID, tick)
    clearTimeout(bot.limitTimer)
    expect(bot.sent).to.have.length(1)
  })

  it('§4.2 a timer re-entry after the stop filled places no order', async () => {
    const bot = makeBot(filled(0.02797))
    // The user stream delivered the fill: processFilledOrder latches it.
    bot.stopFilled = true
    await bot.closeBotByTp(BOT_ID, tick, { value: 'tp', text: 'x' })
    expect(bot.sent).to.have.length(0)
  })

  it('§4.3 the placement reply latches the close like the stream does', async () => {
    const bot = makeBot(filled(0.02797))
    await bot.closeBotByTp(BOT_ID, tick)
    expect(bot.stopFilled).to.equal(true)
    await bot.closeBotByTp(BOT_ID, tick, { value: 'tp', text: 'x' })
    expect(bot.sent).to.have.length(1)
  })

  it('§4.4 unchanged: a resting LIMIT close is repositioned by its timer', async () => {
    const bot = makeBot(filled(0.02797, 'NEW', 'LIMIT'), true)
    bot.orderLimitRepositionTimeout = 60_000
    bot.enterMarketTimeout = 0
    await bot.closeBotByTp(BOT_ID, tick)
    clearTimeout(bot.limitTimer)
    await bot.closeBotByTp(BOT_ID, tick, { value: 'tp', text: 'x' })
    clearTimeout(bot.limitTimer)
    expect(bot.sent).to.have.length(2)
    expect(bot.sent[1].additional).to.include({ type: 'LIMIT' })
  })
})
