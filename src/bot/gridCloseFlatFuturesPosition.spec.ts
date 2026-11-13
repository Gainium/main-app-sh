process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `240.closing-a-flat-futures-grid-leaves-it-open-with-nothing-resting`.
 *
 * `processSellAtStop` (the manual "close at market / limit" path) cancels the
 * grid, then for a futures bot sends a reduce-only close for
 * `position.qty` — even when that is 0. `sendOrderToExchange` refuses a
 * zero-size order and answers nothing, and the method only cleared the
 * progress bar: the bot stayed `open` with every grid order cancelled
 * (spec §1.2, §2).
 *
 * These drive the REAL `processSellAtStop` off the mixin. Venue, Mongo and
 * Redis are stubbed. Harness shape copied from
 * `gridStopAndSellFlatPosition.spec.ts` (spec 127).
 *
 * Run: `npm test` (mocha) from core/, or
 *   env NODE_NO_WARNINGS=1 NODE_ENV=testing TS_NODE_TRANSPILE_ONLY=true \
 *   npx mocha --timeout 200000 --exit -r ts-node/register \
 *   src/bot/gridCloseFlatFuturesPosition.spec.ts
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import {
  BotType,
  CloseGRIDTypeEnum,
  ExchangeEnum,
  OrderSideEnum,
  PositionSide,
  StrategyEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import { createRequire } from 'module'

const BOT_ID = '6af602e4593d12b640e4212b'
const USER_ID = '64c33715e3ee8daa34f19dbc'

let Helper: any

const makeBot = (opts: {
  futures: boolean
  position?: { side: PositionSide; qty: number; price: number }
  /** What the venue answers to the closing order. */
  answer?: any
}) => {
  class TestBot extends Helper {
    public stopped: any[] = []
    public cancelled = 0
    public filledStops = 0
    public sent: any[] = []
    public progress: any[] = []
    public botId = BOT_ID
    public userId = USER_ID
    public botType = BotType.grid
    public log = false
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.paperBybitUsdm,
      paperContext: true,
      status: 'open',
      symbol: { symbol: 'ENAUSDT', baseAsset: 'ENA', quoteAsset: 'USDT' },
      settings: {
        pair: 'ENAUSDT',
        futures: opts.futures,
        coinm: false,
        strategy: StrategyEnum.long,
        profitCurrency: 'quote',
      },
      position: opts.position ?? { side: PositionSide.LONG, qty: 0, price: 0 },
    }
    get futures() {
      return !!this.data?.settings.futures
    }
    get isShort() {
      return false
    }
    getOrdersByStatusAndDealId() {
      return []
    }
    async stop(...args: any[]) {
      this.stopped.push(args)
    }
    async cancelAllOrder() {
      this.cancelled += 1
      return []
    }
    async reportCloseCancelRefused() {}
    async getExchangeInfo() {
      return {
        pair: 'ENAUSDT',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 1, name: 'ENA' },
        quoteAsset: { minAmount: 5, step: 0.00001, name: 'USDT' },
      }
    }
    async getLatestPrice() {
      return 0.13929
    }
    async sellBaseAmount() {
      return 76
    }
    async sendGridToExchange(grid: any, additional: any) {
      this.sent.push({ grid, additional })
      return opts.answer
    }
    async processFilledStop() {
      this.filledStops += 1
    }
    updateProgress(p?: any) {
      this.progress.push(p)
    }
    getOrderId(prefix: string) {
      return prefix
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
  }
  return new (TestBot as any)()
}

const filled = (qty: number) => ({
  clientOrderId: 'GRID-TP',
  orderId: '1',
  symbol: 'ENAUSDT',
  side: OrderSideEnum.sell,
  type: 'MARKET',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.stop,
  price: '0.13929',
  origQty: `${qty}`,
  executedQty: `${qty}`,
})

const close = (bot: any, type = CloseGRIDTypeEnum.closeByMarket) =>
  bot.processSellAtStop(type)

describe('closing a flat futures grid stops it (spec 240)', () => {
  before(function () {
    // One ts-node compile of a 6k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§4.1 a flat futures position places no order and stops', () => {
    for (const type of [
      CloseGRIDTypeEnum.closeByMarket,
      CloseGRIDTypeEnum.closeByLimit,
    ]) {
      it(`${type}: cancels the grid, sends nothing, stops once`, async () => {
        const bot = makeBot({ futures: true })
        await close(bot, type)
        expect(bot.cancelled).to.equal(1)
        expect(bot.sent).to.have.length(0)
        expect(bot.stopped).to.have.length(1)
        expect(bot.stopped[0][0]).to.equal(true)
        expect(bot.closeOrderTimer ?? null).to.equal(null)
      })
    }
  })

  describe('§4.2 an open futures position is still closed reduce-only', () => {
    it('sends one reduce-only MARKET close for the whole position', async () => {
      const bot = makeBot({
        futures: true,
        position: { side: PositionSide.LONG, qty: 76, price: 0.138 },
        answer: filled(76),
      })
      await close(bot)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid).to.include({
        side: OrderSideEnum.sell,
        qty: 76,
        type: TypeOrderEnum.stop,
      })
      expect(bot.sent[0].additional).to.include({
        type: 'MARKET',
        reduceOnly: true,
      })
      expect(bot.filledStops).to.equal(1)
      expect(bot.stopped).to.have.length(0)
    })
    it('a LIMIT close that rests is repositioned as before', async () => {
      const bot = makeBot({
        futures: true,
        position: { side: PositionSide.SHORT, qty: 76, price: 0.138 },
        answer: { ...filled(76), status: 'NEW', side: OrderSideEnum.buy },
      })
      await close(bot, CloseGRIDTypeEnum.closeByLimit)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid).to.include({ side: OrderSideEnum.buy, qty: 76 })
      expect(bot.sent[0].additional).to.include({
        type: 'LIMIT',
        reduceOnly: true,
      })
      expect(bot.closeOrderTimer).to.not.equal(null)
      clearTimeout(bot.closeOrderTimer)
      expect(bot.stopped).to.have.length(0)
    })
  })

  describe('§4.3 a refused close is retried, not abandoned', () => {
    it('re-arms the close timer when the venue answers nothing', async () => {
      const bot = makeBot({
        futures: true,
        position: { side: PositionSide.LONG, qty: 76, price: 0.138 },
        answer: undefined,
      })
      await close(bot)
      expect(bot.sent).to.have.length(1)
      expect(bot.closeOrderTimer ?? null).to.not.equal(null)
      clearTimeout(bot.closeOrderTimer)
      expect(bot.stopped).to.have.length(0)
    })
  })

  describe('§4.5 spot is unchanged', () => {
    it('sells sellBaseAmount()', async () => {
      const bot = makeBot({ futures: false, answer: filled(76) })
      await close(bot)
      expect(bot.sent).to.have.length(1)
      expect(bot.sent[0].grid).to.include({ qty: 76 })
      expect(bot.filledStops).to.equal(1)
    })
  })
})
