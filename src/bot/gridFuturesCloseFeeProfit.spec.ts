process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec `276.futures-grid-close-fee-booked-as-pnl-fraction`.
 *
 * Closing a futures grid's position booked `grossPnl × (1 − maker)`: the fee
 * as a fraction of the PnL instead of the close fill's notional. On a losing
 * close the "fee" even raised the total.
 *
 * The fixture is the Bybit USDⓈ-M NEUTRAL close recorded in prod (spec §2): a
 * short of 5 entered at 0.06362, bought back by the GRID-TP at 0.06374 with a
 * venue fee of 0.00012748 quote. Before the close the bot's total (after the
 * spec 275 restatement) was 0.00171912; the cash result of the fills is
 * 0.00099164.
 *
 * Drives the REAL `profitAfterPositionClosed` and `processLiquidationOrder`
 * off the mixin with a fake base class. Harness shape from
 * `gridFuturesBuyFeeProfit.spec.ts` (spec 275).
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
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const BOT_ID = 'bbbbbbbbbbbbbbbbbbbb0276'
const USER_ID = 'aaaaaaaaaaaaaaaaaaaa0276'

const QTY = 5
const ENTRY = 0.06362
const CLOSE_PRICE = 0.06374
const CLOSE_FEE = 0.00012748
const MAKER = 0.0004
const TAKER = 0.001
const BEFORE_CLOSE = 0.00171912
/** (0.06362 − 0.06374) × 5 */
const GROSS = -0.0006
const CASH = 0.00099164
const USD_RATE = 0.9

let Helper: any

const closeFill: any = {
  clientOrderId: 'GRID-TP-close-0276',
  orderId: 'tp0276',
  botId: BOT_ID,
  symbol: 'ATUSDT',
  baseAsset: 'AT',
  quoteAsset: 'USDT',
  side: OrderSideEnum.buy,
  type: 'LIMIT',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.stop,
  price: `${CLOSE_PRICE}`,
  origPrice: `${CLOSE_PRICE}`,
  origQty: `${QTY}`,
  executedQty: `${QTY}`,
  updateTime: 1795649655349,
  feePaid: `${CLOSE_FEE}`,
  feeSide: 'quote',
}

const makeBot = (opts: { feeByAsset: boolean }) => {
  class TestBot extends Helper {
    public updates: any[] = []
    public saved: any[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public math = new MathHelper()
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.bybitUsdm,
      paperContext: false,
      flags: opts.feeByAsset ? ['feeByAsset'] : [],
      symbol: { symbol: 'ATUSDT', baseAsset: 'AT', quoteAsset: 'USDT' },
      settings: {
        pair: 'ATUSDT',
        futures: true,
        coinm: false,
        strategy: StrategyEnum.long,
        futuresStrategy: FuturesStrategyEnum.neutral,
        profitCurrency: 'quote',
      },
      position: { side: PositionSide.SHORT, qty: QTY, price: ENTRY },
      profit: {
        total: BEFORE_CLOSE,
        totalUsd: BEFORE_CLOSE * USD_RATE,
        freeTotal: BEFORE_CLOSE,
        freeTotalUsd: BEFORE_CLOSE * USD_RATE,
      },
    }
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get futuresStrategy() {
      return FuturesStrategyEnum.neutral
    }
    async closeEntryPrice() {
      return ENTRY
    }
    async getUserFee() {
      return { maker: MAKER, taker: TAKER }
    }
    async getUsdRate() {
      return USD_RATE
    }
    saveProfitToDb(usd: number, time: number, fiat?: number) {
      this.saved.push({ usd, time, fiat })
    }
    resetPosition() {
      this.data.position = { ...this.data.position, qty: 0 }
    }
    stop() {}
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

describe('futures grid close books the close fill fee (spec 276)', () => {
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
      it('§1.1 profit.total ends at the cash result of the fills', async () => {
        const bot = makeBot({ feeByAsset })
        await bot.profitAfterPositionClosed(closeFill)
        expect(bot.data.profit.total).to.be.closeTo(CASH, 1e-12)
        expect(bot.data.profit.freeTotal).to.be.closeTo(CASH, 1e-12)
        const persisted = bot.updates.filter((u: any) => u.profit).pop()
        expect(persisted.profit.total).to.be.closeTo(CASH, 1e-12)
      })

      it('§1.1 the USD figures and account statistics take the fee out', async () => {
        const bot = makeBot({ feeByAsset })
        await bot.profitAfterPositionClosed(closeFill)
        const closeUsd = (GROSS - CLOSE_FEE) * USD_RATE
        expect(bot.data.profit.totalUsd).to.be.closeTo(CASH * USD_RATE, 1e-12)
        expect(bot.data.profit.freeTotalUsd).to.be.closeTo(
          CASH * USD_RATE,
          1e-12,
        )
        expect(bot.saved).to.have.length(1)
        expect(bot.saved[0].usd).to.be.closeTo(closeUsd, 1e-12)
      })

      it('§1.1 a part close books the fee of the part it closed', async () => {
        const bot = makeBot({ feeByAsset })
        bot.data.position.qty = 2
        await bot.profitAfterPositionClosed(closeFill, 2)
        const gross = (ENTRY - CLOSE_PRICE) * 2
        expect(bot.data.profit.total).to.be.closeTo(
          BEFORE_CLOSE + gross - (CLOSE_FEE * 2) / QTY,
          1e-12,
        )
      })

      it('§1.1 a liquidation books its fee', async () => {
        const bot = makeBot({ feeByAsset })
        await bot.processLiquidationOrder({
          ...closeFill,
          clientOrderId: 'liq-0276',
          typeOrder: TypeOrderEnum.regular,
        })
        expect(bot.data.profit.total).to.be.closeTo(CASH, 1e-12)
      })
    })
  }

  it('§1.3 an observed fee wins over the stored rate', async () => {
    const bot = makeBot({ feeByAsset: true })
    bot.getUserFee = async () => ({ maker: 0.01, taker: 0.01 })
    await bot.profitAfterPositionClosed(closeFill)
    expect(bot.data.profit.total).to.be.closeTo(CASH, 1e-12)
  })

  it('§1.3 a close with no observed fee falls back to the estimate', async () => {
    const bot = makeBot({ feeByAsset: true })
    await bot.profitAfterPositionClosed({ ...closeFill, feePaid: undefined })
    expect(bot.data.profit.total).to.be.closeTo(
      BEFORE_CLOSE + GROSS - CLOSE_PRICE * QTY * MAKER,
      1e-12,
    )
  })
  describe('§304 the estimate uses the rate the close traded at', () => {
    const noFee = { ...closeFill, feePaid: undefined, feeSide: undefined }
    const callers: [string, (bot: any, order: any) => Promise<void>][] = [
      ['close', (bot, order) => bot.profitAfterPositionClosed(order)],
      [
        'liquidation',
        (bot, order) =>
          bot.processLiquidationOrder({
            ...order,
            clientOrderId: 'liq-0304',
            typeOrder: TypeOrderEnum.regular,
          }),
      ],
    ]
    for (const [name, run] of callers) {
      for (const feeByAsset of [false, true]) {
        const tag = `${name}, feeByAsset ${feeByAsset ? 'on' : 'off'}`
        it(`§1.1.1 a MARKET close with no observed fee books the taker rate (${tag})`, async () => {
          const bot = makeBot({ feeByAsset })
          await run(bot, { ...noFee, type: 'MARKET' })
          expect(bot.data.profit.total).to.be.closeTo(
            BEFORE_CLOSE + GROSS - CLOSE_PRICE * QTY * TAKER,
            1e-12,
          )
        })
        it(`§1.1.1 a LIMIT close that filled on arrival books the taker rate (${tag})`, async () => {
          const bot = makeBot({ feeByAsset })
          await run(bot, { ...noFee, type: 'LIMIT', filledOnArrival: true })
          expect(bot.data.profit.total).to.be.closeTo(
            BEFORE_CLOSE + GROSS - CLOSE_PRICE * QTY * TAKER,
            1e-12,
          )
        })
        it(`§1.1.2 a resting LIMIT close keeps the maker rate (${tag})`, async () => {
          const bot = makeBot({ feeByAsset })
          await run(bot, { ...noFee, type: 'LIMIT' })
          expect(bot.data.profit.total).to.be.closeTo(
            BEFORE_CLOSE + GROSS - CLOSE_PRICE * QTY * MAKER,
            1e-12,
          )
        })
      }
    }
    it('§1.3 a MARKET close with an observed fee keeps the observed fee', async () => {
      const bot = makeBot({ feeByAsset: true })
      await bot.profitAfterPositionClosed({ ...closeFill, type: 'MARKET' })
      expect(bot.data.profit.total).to.be.closeTo(CASH, 1e-12)
    })
  })
})
