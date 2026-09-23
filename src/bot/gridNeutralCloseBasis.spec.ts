process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `099.a-neutral-grid-close-is-valued-against-the-whole-position-average`.
 *
 * A NEUTRAL futures grid books its round trips pairwise at grid-level prices
 * (`createTransaction`) but valued the residual still open at close against
 * `data.position.price` — the average of every fill that ever added to the
 * position, including the ones the round-trip ledger had already paired off.
 *
 * The fixture is the reported bot `6aa8d2fd4f67072ebb34903f` (paper
 * `AINUSDT`, NEUTRAL, lev 1): its 34 FILLED regular fills, its 14 paired
 * transactions and its closing BUY of 786 at 0.15807, as read from prod
 * (spec §2). The fills are folded through the REAL `calculatePosition` /
 * `calculateAbstractPosition`, and the close through the REAL
 * `profitAfterPositionClosed`. No Mongo, Redis, venue or bot stack is needed.
 * Harness shape copied from `gridPositionDoubleBook.spec.ts` /
 * `gridCloseProfitLedger.spec.ts`.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotMarginTypeEnum,
  ExchangeEnum,
  FuturesStrategyEnum,
  PositionSide,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import { MathHelper } from '../utils/math'
import MainBot from './main'

const BOT_ID = '6aa8d2fd4f67072ebb34903f'
const USER_ID = '64c33715e3ee8daa34f19dbb'
const QTY = 131

/** [clientOrderId, side, price, updateTime] — the bot's FILLED regular fills. */
const FILLS: [string, 'BUY' | 'SELL', number, number][] = [
  ['GRID-RO-CxjNhR7qVNoSvFITcvOxk9zI91V', 'SELL', 0.13873, 1789449254330],
  ['GRID-RO-Mc9W41bypwCe0BupZASAzmKghBK', 'SELL', 0.14242, 1789449629994],
  ['GRID-RO-tTuxnbTHM641iuaFkycuZbYsPeA', 'BUY', 0.13868, 1789450003211],
  ['GRID-RO-oHkXxijy2NgOQD28UK8tRsvXU18', 'SELL', 0.14242, 1789451064092],
  ['GRID-RO-2Ve4ZxOZ3s5RcsrHEBzP5iKTSJQ', 'SELL', 0.14621, 1789451111276],
  ['GRID-RO-KvY99eeNtSvz0SD9hPCNnTvY41h', 'SELL', 0.1501, 1789451127254],
  ['GRID-RO-Kapia9RhTA2efDwnnqmlCyUFsgv', 'SELL', 0.15409, 1789451133262],
  ['GRID-RO-mqzSb1KOwPbwP6rozJl5XOQZtCy', 'SELL', 0.15819, 1789451241566],
  ['GRID-RO-wrkaaOHthuFz8Dw44cfOyEBFiWl', 'BUY', 0.15403, 1789451321693],
  ['GRID-RO-r4bT6PJFsASVY8tAcojIo6ccK9w', 'SELL', 0.15819, 1789451422993],
  ['GRID-RO-FMLGTyTdrbHX1lTvXiEXfIjcQfv', 'SELL', 0.16239, 1789451742715],
  ['GRID-RO-PgKWHIO9Az8Zre5QEkHtnLPBynu', 'SELL', 0.16671, 1789451763786],
  ['GRID-RO-Kkxfv4XF19a7TQvObEhlyR3CDCl', 'BUY', 0.16233, 1789451856974],
  ['GRID-RO-7XurJxIAoN17NkVIHNWebFRREHV', 'SELL', 0.16671, 1789452208935],
  ['GRID-RO-l6FbwAleBCBlOs7afWtw2NLTGau', 'BUY', 0.16233, 1789452309145],
  ['GRID-RO-9cXDS2Qecqaz25NB2oaSIe1D6nY', 'SELL', 0.16671, 1789452640940],
  ['GRID-RO-vll9x9qqlBz49RHlJTCpSSvZGyY', 'BUY', 0.16233, 1789452998974],
  ['GRID-RO-vXrbPnoc3Ukkg1zRN8QixsjIOLP', 'SELL', 0.16671, 1789453032061],
  ['GRID-RO-OuUsyr0BlMpYRqqh9t7SjFNefbj', 'BUY', 0.16233, 1789453263682],
  ['GRID-RO-ZRROAJWf4UkghyyGAqcHbZSCbJi', 'BUY', 0.15812, 1789454549512],
  ['GRID-RO-74B5mHMdpAu4Ax8eUfaBFJYCpyf', 'BUY', 0.15403, 1789455071869],
  ['GRID-RO-6s0fRXT2OvcJGLiXGA90bKrkxg6', 'SELL', 0.15819, 1789455216190],
  ['GRID-RO-NGsapxPfupwSASCGC5q5LZRf840', 'SELL', 0.16239, 1789455216190],
  ['GRID-RO-uz3jgrVDqRMI3R35tjH3cleSx6k', 'BUY', 0.15812, 1789455596238],
  ['GRID-RO-CdwgweZTtGwS78aA1B0dJEk5oM9', 'SELL', 0.16239, 1789456445723],
  ['GRID-RO-4zLpB9kJpvOSfEpKF2QyZdDM0NK', 'BUY', 0.15812, 1789458733921],
  ['GRID-RO-mSSp67y8t4hWvDFg5cMml8DWUIa', 'SELL', 0.16239, 1789459258465],
  ['GRID-RO-z5uSdTUpmA7VU9bd8xCVlv7j4zi', 'SELL', 0.16671, 1789462595577],
  ['GRID-RO-SU9JeHMQOe0lrecm7lWYM1vBO6g', 'BUY', 0.16233, 1789463099941],
  ['GRID-RO-k7XscHo3nagZcE7fg2ZcHrxJSJd', 'SELL', 0.16671, 1789466129959],
  ['GRID-RO-pFUGyMAhseVsFLDfJ8WyNVvjcBu', 'BUY', 0.16233, 1789466769647],
  ['GRID-RO-MW9BjvSktE5IF5FZWheOflHBXii', 'SELL', 0.16671, 1789467578866],
  ['GRID-RO-jjcR0dEhWo9ZABUr4bOLo9wMWxR', 'BUY', 0.16233, 1789468163421],
  ['GRID-RO-lZDaZg9Tudb6H3hCW9x2xthMV6i', 'BUY', 0.15812, 1789468365939],
]

/** [idBuy, idSell] — the transactions the round-trip ledger paired (spec §2.2). */
const PAIRS: [string, string][] = [
  ['GRID-RO-tTuxnbTHM641iuaFkycuZbYsPeA', 'GRID-RO-Mc9W41bypwCe0BupZASAzmKghBK'],
  ['GRID-RO-wrkaaOHthuFz8Dw44cfOyEBFiWl', 'GRID-RO-mqzSb1KOwPbwP6rozJl5XOQZtCy'],
  ['GRID-RO-Kkxfv4XF19a7TQvObEhlyR3CDCl', 'GRID-RO-PgKWHIO9Az8Zre5QEkHtnLPBynu'],
  ['GRID-RO-l6FbwAleBCBlOs7afWtw2NLTGau', 'GRID-RO-7XurJxIAoN17NkVIHNWebFRREHV'],
  ['GRID-RO-vll9x9qqlBz49RHlJTCpSSvZGyY', 'GRID-RO-9cXDS2Qecqaz25NB2oaSIe1D6nY'],
  ['GRID-RO-OuUsyr0BlMpYRqqh9t7SjFNefbj', 'GRID-RO-vXrbPnoc3Ukkg1zRN8QixsjIOLP'],
  ['GRID-RO-ZRROAJWf4UkghyyGAqcHbZSCbJi', 'GRID-RO-FMLGTyTdrbHX1lTvXiEXfIjcQfv'],
  ['GRID-RO-74B5mHMdpAu4Ax8eUfaBFJYCpyf', 'GRID-RO-r4bT6PJFsASVY8tAcojIo6ccK9w'],
  ['GRID-RO-uz3jgrVDqRMI3R35tjH3cleSx6k', 'GRID-RO-NGsapxPfupwSASCGC5q5LZRf840'],
  ['GRID-RO-4zLpB9kJpvOSfEpKF2QyZdDM0NK', 'GRID-RO-CdwgweZTtGwS78aA1B0dJEk5oM9'],
  ['GRID-RO-SU9JeHMQOe0lrecm7lWYM1vBO6g', 'GRID-RO-z5uSdTUpmA7VU9bd8xCVlv7j4zi'],
  ['GRID-RO-pFUGyMAhseVsFLDfJ8WyNVvjcBu', 'GRID-RO-k7XscHo3nagZcE7fg2ZcHrxJSJd'],
  ['GRID-RO-jjcR0dEhWo9ZABUr4bOLo9wMWxR', 'GRID-RO-MW9BjvSktE5IF5FZWheOflHBXii'],
  ['GRID-RO-lZDaZg9Tudb6H3hCW9x2xthMV6i', 'GRID-RO-mSSp67y8t4hWvDFg5cMml8DWUIa'],
]

const CLOSE = {
  clientOrderId: 'GRID-TP-7UOnIGefDcBi8c9IBrnP8kFSVXy',
  symbol: 'AINUSDT',
  side: 'BUY',
  status: 'FILLED',
  typeOrder: TypeOrderEnum.stop,
  price: '0.15807',
  origQty: '786',
  executedQty: '786',
  cummulativeQuoteQty: '124.24302',
  updateTime: 1789468569475,
}

const order = ([clientOrderId, side, price, updateTime]: (typeof FILLS)[0]) => ({
  clientOrderId,
  symbol: 'AINUSDT',
  side,
  status: 'FILLED',
  typeOrder: TypeOrderEnum.regular,
  price: `${price}`,
  origQty: `${QTY}`,
  executedQty: `${QTY}`,
  updateTime,
})

/** Σ sells − Σ buys over the bot's life, the close included (spec §2.4). */
const CASH_NET =
  FILLS.reduce((s, [, side, p]) => s + (side === 'SELL' ? 1 : -1) * p * QTY, 0) -
  +CLOSE.price * +CLOSE.executedQty
/** What `createTransaction` booked for the paired round trips. */
const PAIRED_PNL = PAIRS.reduce((s, [b, sl]) => {
  const price = (id: string) => FILLS.find((f) => f[0] === id)![2]
  return s + QTY * (price(sl) - price(b))
}, 0)

let Helper: any

const makeBot = (opts: {
  futuresStrategy?: FuturesStrategyEnum
  dropFill?: string
  ordersDbFails?: boolean
} = {}) => {
  class TestBot extends (Helper as any) {
    public botId = BOT_ID
    public userId = USER_ID
    public math = new MathHelper()
    public ordersRead = 0
    public data: any = {
      _id: BOT_ID,
      userId: USER_ID,
      exchange: ExchangeEnum.paperBinanceUsdm,
      paperContext: true,
      symbol: { symbol: 'AINUSDT', baseAsset: 'AIN', quoteAsset: 'USDT' },
      settings: {
        pair: 'AINUSDT',
        futures: true,
        coinm: false,
        futuresStrategy: opts.futuresStrategy ?? FuturesStrategyEnum.neutral,
        marginType: BotMarginTypeEnum.cross,
        leverage: 1,
        profitCurrency: 'quote',
      },
      position: { side: PositionSide.LONG, qty: 0, price: 0 },
      positionHistory: [],
      profit: { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 },
    }
    public ordersDb: any = {
      readData: () => {
        this.ordersRead += 1
        if (opts.ordersDbFails) {
          return Promise.resolve({ status: StatusEnum.notok, reason: 'down' })
        }
        return Promise.resolve({
          status: StatusEnum.ok,
          data: {
            result: [
              ...FILLS.filter((f) => f[0] !== opts.dropFill).map(order),
              CLOSE,
            ],
          },
        })
      },
    }
    public transactionDb: any = {
      readData: () =>
        Promise.resolve({
          status: StatusEnum.ok,
          data: {
            result: PAIRS.map(([idBuy, idSell]) => ({
              idBuy,
              idSell,
            })),
          },
        }),
    }
    get futures() {
      return true
    }
    get coinm() {
      return false
    }
    get isBitget() {
      return false
    }
    calculateAbstractPosition = MainBot.prototype.calculateAbstractPosition
    async getExchangeInfo() {
      return {
        pair: 'AINUSDT',
        priceAssetPrecision: 5,
        baseAsset: { minAmount: 1, step: 1, name: 'AIN' },
        quoteAsset: { minAmount: 5, step: 0.00001, name: 'USDT' },
      }
    }
    async baseAssetPrecision() {
      return 0
    }
    async getUserFee() {
      return { maker: 0, taker: 0 }
    }
    async getUsdRate() {
      return 1
    }
    saveProfitToDb() {}
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

/** Fold the fills through the real `calculatePosition`, then close. */
const run = async (bot: any) => {
  for (const f of FILLS) {
    await bot.calculatePosition(order(f))
  }
  const position = { ...bot.data.position }
  await bot.profitAfterPositionClosed(CLOSE)
  return { position, closeLeg: bot.data.profit.total }
}

describe('a neutral futures grid close is valued against the whole-position average (spec 099)', () => {
  before(function () {
    // One ts-node compile of a 5k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  describe('§2 the fixture is the reported bot', () => {
    it('folds to SHORT 786 at the 0.162 the engine closed against', async () => {
      const { position } = await run(makeBot())
      expect(position.side).to.equal(PositionSide.SHORT)
      expect(position.qty).to.equal(786)
      expect(position.price).to.be.closeTo(0.162, 1e-9)
    })

    it('nets to the reported cash result', () => {
      expect(CASH_NET).to.be.closeTo(414.62417 - 414.47745, 1e-6)
    })
  })

  describe('§1.1 round trips + close leg == cash flow', () => {
    it('books the close leg against the unpaired fills', async () => {
      const { closeLeg } = await run(makeBot())
      expect(closeLeg).to.be.closeTo(-7.68708, 1e-6)
      expect(PAIRED_PNL + closeLeg).to.be.closeTo(CASH_NET, 1e-9)
    })
  })

  describe('§4.2 falls back to position.price when the ledger does not reconcile', () => {
    it('when the unpaired set does not net to the position', async () => {
      // An unpaired fill the orders read does not return (not saved yet):
      // the rest nets to 655 short against a position of 786.
      const { closeLeg } = await run(
        makeBot({ dropFill: 'GRID-RO-CxjNhR7qVNoSvFITcvOxk9zI91V' }),
      )
      expect(closeLeg).to.be.closeTo(786 * (0.162 - 0.15807), 1e-9)
    })

    it('when the orders read fails', async () => {
      const { closeLeg } = await run(makeBot({ ordersDbFails: true }))
      expect(closeLeg).to.be.closeTo(786 * (0.162 - 0.15807), 1e-9)
    })
  })

  describe('§4.3 LONG/SHORT grids are untouched', () => {
    it('a SHORT-strategy grid still closes against position.price', async () => {
      const bot = makeBot({ futuresStrategy: FuturesStrategyEnum.short })
      const { closeLeg } = await run(bot)
      expect(closeLeg).to.be.closeTo(786 * (0.162 - 0.15807), 1e-9)
      expect(bot.ordersRead).to.equal(0)
    })
  })
})
