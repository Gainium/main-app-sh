process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `201.a-venue-cancel-all-leaves-a-grid-bot-trading-nothing`.
 *
 * Builds a grid bot on the REAL helper mixin over a stub base and drives its
 * cancel callback the way `processOrderQueue` does. The ladder is a Bybit
 * long grid whose 78 resting BUY levels the venue cancelled in one
 * millisecond, hours after they were placed (an account-wide cancel). The
 * bot's own-cancel ledger and `mapOrderToGrid` are borrowed from `MainBot`, so
 * the decisions under test are the engine's. Placement is recorded at
 * `sendGridToExchange`, never sent.
 *
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import {
  BotStatusEnum,
  BotType,
  ExchangeEnum,
  OrderSideEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

const SYMBOL = 'ABCUSDT'
const QTY = 12
const LEVELS = 78
/** Venue time the levels were placed. */
const PLACED_AT = 1792800000000
/** Venue time of the cancel-all, ~3 h later. */
const CANCELED_AT = PLACED_AT + 3 * 3600_000

const PRICES = Array.from({ length: LEVELS }, (_, i) =>
  Number((1 - i * 0.005).toFixed(4)),
)

let Helper: any
let botSeq = 0

const gridLevel = (price: number, side = OrderSideEnum.buy) =>
  ({
    number: 0,
    price,
    qty: QTY,
    side,
    type: TypeOrderEnum.regular,
    newClientOrderId: `GRID-RO-ladder-${side}-${price}`,
  }) as any

/** The cancel report as `processOrderQueue` hands it over. */
const canceled = (price: number, over: Record<string, unknown> = {}) =>
  ({
    clientOrderId: `GRID-RO-live-${price}`,
    orderId: `venue-${price}`,
    symbol: SYMBOL,
    side: 'BUY',
    status: 'CANCELED',
    type: 'LIMIT',
    typeOrder: TypeOrderEnum.regular,
    price: `${price}`,
    origPrice: `${price}`,
    origQty: `${QTY}`,
    executedQty: '0',
    cummulativeQuoteQty: '0',
    transactTime: PLACED_AT,
    updateTime: CANCELED_AT,
    exchange: ExchangeEnum.bybit,
    ...over,
  }) as any

const buildBot = (opts: { status?: BotStatusEnum; realDelay?: boolean } = {}) => {
  const sent: any[] = []
  const passes: number[] = []
  const filled: any[] = []
  const botId = `000000000000000000000b${(++botSeq).toString().padStart(2, '0')}`
  let nextId = 0

  class TestBot extends Helper {
    math = new MathHelper()
    botId = botId
    userId = 'test-user'
    botType = BotType.grid
    log = false
    blockLimit = false
    grids = PRICES.map((p) => gridLevel(p))
    ordersInProgress = new Set<string>()
    resting = new Set<string>()
    data: any = {
      _id: botId,
      status: opts.status ?? BotStatusEnum.open,
      exchange: ExchangeEnum.bybit,
      settings: { pair: SYMBOL, futures: false },
    }
    get futuresStrategy() {
      return 'LONG'
    }
    get hedge() {
      return false
    }
    // --- the engine's own, borrowed ---
    isOwnCancel(id?: string) {
      return (MainBot.prototype as any).isOwnCancel.call(this, id)
    }
    noteOwnCancel(id?: string) {
      return (MainBot.prototype as any).noteOwnCancel.call(this, id)
    }
    mapOrderToGrid(o: any, updateId = true) {
      return (MainBot.prototype as any).mapOrderToGrid.call(this, o, updateId)
    }
    // --- I/O, stubbed ---
    getOrderId(prefix: string) {
      return `${prefix}-fresh-${++nextId}`
    }
    isOrderExist(g: any) {
      return this.resting.has(`${g.side}@${g.price}`)
    }
    async getExchangeInfo() {
      return { pair: SYMBOL, priceAssetPrecision: 4 }
    }
    async sendGridToExchange(g: any) {
      sent.push(g)
      return { clientOrderId: g.newClientOrderId, status: 'NEW' }
    }
    processFilledOrder(o: any) {
      filled.push(o)
    }
    shouldProceed() {
      return true
    }
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
    async placeCanceledLevels(id: string) {
      passes.push(Date.now())
      return super.placeCanceledLevels(id)
    }
  }
  const bot = new (TestBot as any)()
  if (!opts.realDelay) {
    // Run the pass explicitly; the debounce itself is covered by its own test.
    bot.scheduleCanceledLevels = () => undefined
  }
  return { bot, sent, passes, filled, botId }
}

describe('a venue cancel-all leaves a grid bot trading nothing (spec 201)', () => {
  before(function () {
    // One ts-node compile of a 5k-line module over a 10k-line base.
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('registers a cancel callback (§1.2)', () => {
    const { bot } = buildBot()
    expect(bot.cbFunctions.onCanceled).to.be.a('function')
  })

  it('places a cancel-all back in one pass, every level once (§1.1, §4.1, §4.2)', async function () {
    this.timeout(10000)
    const { bot, sent, passes } = buildBot({ realDelay: true })
    for (const p of PRICES) {
      await bot.cbFunctions.onCanceled(canceled(p), CANCELED_AT, false)
    }
    expect(sent, 'nothing placed while the burst is arriving').to.have.length(0)
    await new Promise((r) => setTimeout(r, 2600))
    expect(passes, 'one pass for the whole burst').to.have.length(1)
    expect(sent).to.have.length(LEVELS)
    expect(sent.map((g) => g.price).sort()).to.deep.equal([...PRICES].sort())
    for (const g of sent) {
      expect(g.side).to.equal(OrderSideEnum.buy)
      expect(g.qty).to.equal(QTY)
      expect(g.type).to.equal(TypeOrderEnum.regular)
      // Never the id of the order the venue just cancelled.
      expect(g.newClientOrderId).to.match(/^GRID-RO-fresh-/)
    }
  })

  it("does not re-place the bot's own cancel (§4.3)", async () => {
    const { bot, sent, botId } = buildBot()
    const own = canceled(PRICES[0])
    bot.noteOwnCancel(own.clientOrderId)
    await bot.cbFunctions.onCanceled(own, CANCELED_AT, false)
    await bot.placeCanceledLevels(botId)
    expect(sent).to.have.length(0)
  })

  it('does not retry an order refused at placement (§4.3)', async () => {
    const { bot, sent, botId } = buildBot()
    // Acknowledged and cancelled in the same instant.
    await bot.cbFunctions.onCanceled(
      canceled(PRICES[0], { updateTime: PLACED_AT }),
      PLACED_AT,
      false,
    )
    // No placement time at all: no evidence it ever rested.
    await bot.cbFunctions.onCanceled(
      canceled(PRICES[1], { transactTime: undefined }),
      CANCELED_AT,
      false,
    )
    await bot.placeCanceledLevels(botId)
    expect(sent).to.have.length(0)
  })

  it('ignores non-grid orders (§4.3)', async () => {
    const { bot, sent, botId } = buildBot()
    for (const typeOrder of [
      TypeOrderEnum.stop,
      TypeOrderEnum.swap,
      TypeOrderEnum.fee,
    ]) {
      await bot.cbFunctions.onCanceled(
        canceled(PRICES[0], { typeOrder }),
        CANCELED_AT,
        false,
      )
    }
    await bot.placeCanceledLevels(botId)
    expect(sent).to.have.length(0)
  })

  it('skips a level the ladder no longer has, and one that already rests (§4.2)', async () => {
    const { bot, sent, botId } = buildBot()
    bot.grids = bot.grids.filter((g: any) => g.price !== PRICES[0])
    bot.resting.add(`${OrderSideEnum.buy}@${PRICES[1]}`)
    for (const p of PRICES.slice(0, 3)) {
      await bot.cbFunctions.onCanceled(canceled(p), CANCELED_AT, false)
    }
    await bot.placeCanceledLevels(botId)
    expect(sent.map((g) => g.price)).to.deep.equal([PRICES[2]])
  })

  it('places nothing on a bot that is not running (§4.2)', async () => {
    const closed = buildBot({ status: BotStatusEnum.closed })
    await closed.bot.cbFunctions.onCanceled(canceled(PRICES[0]), CANCELED_AT, false)
    await closed.bot.placeCanceledLevels(closed.botId)
    expect(closed.sent).to.have.length(0)

    const stopping = buildBot()
    await stopping.bot.cbFunctions.onCanceled(
      canceled(PRICES[0]),
      CANCELED_AT,
      false,
    )
    stopping.bot.blockLimit = true
    await stopping.bot.placeCanceledLevels(stopping.botId)
    expect(stopping.sent).to.have.length(0)

    const range = buildBot({ status: BotStatusEnum.range })
    await range.bot.cbFunctions.onCanceled(canceled(PRICES[0]), CANCELED_AT, false)
    await range.bot.placeCanceledLevels(range.botId)
    expect(range.sent).to.have.length(1)
  })

  it('leaves a part-filled cancel alone (§4.1)', async () => {
    const { bot, sent, botId } = buildBot()
    await bot.cbFunctions.onCanceled(
      canceled(PRICES[0], { executedQty: '3' }),
      CANCELED_AT,
      false,
    )
    await bot.placeCanceledLevels(botId)
    expect(sent).to.have.length(0)
  })
})
