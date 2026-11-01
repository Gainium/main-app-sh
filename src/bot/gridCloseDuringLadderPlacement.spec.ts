process.env.NODE_ENV = 'testing'

/**
 * Regression tests for spec
 * `215.grid-close-during-ladder-placement-leaves-orders-behind`.
 *
 * Drives the REAL `limitOrders` of the grid helper mixin over a stub base. A
 * long perp grid places its starting sell ladder, and the stop-loss closes the
 * bot partway through, the way prod's timeline did. Placement is recorded at
 * `sendGridToExchange` and never sent. The close is simulated by setting the
 * latches the stop path sets (`blockLimit` in `closeBotByTp`/`stop()`,
 * `stopFilled` when the stop fills, status `closed` when `stop()` ends).
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

const SYMBOL = 'ABC-USDC'
const LAST_PRICE = 700
const PRICES = Array.from({ length: 14 }, (_, i) => 711 + i * 6)

let Helper: any
let botSeq = 0

const level = (price: number) =>
  ({
    number: 0,
    price,
    qty: 0.019,
    side: OrderSideEnum.sell,
    type: TypeOrderEnum.regular,
    newClientOrderId: `GRID-ladder-${price}`,
  }) as any

type Close = 'blockLimit' | 'stopFilled' | 'closed'

const buildBot = (
  opts: {
    /** Close the bot while the Nth placement (1-based) is in flight. */
    closeDuring?: number
    close?: Close
    /** The stop's snapshot already claimed the in-flight order. */
    snapshotClaims?: boolean
    batched?: boolean
  } = {},
) => {
  const sent: number[] = []
  const cancelled: string[] = []
  const botId = `00000000000000000000c${(++botSeq).toString().padStart(3, '0')}`

  class TestBot extends Helper {
    math = new MathHelper()
    botId = botId
    userId = 'test-user'
    botType = BotType.grid
    log = false
    blockLimit = false
    stopFilled = false
    firstRun = true
    grids = PRICES.map(level)
    prevGrids: any[] = []
    ordersInProgress = new Set<string>()
    orders = new Map<string, any>()
    exchange = {}
    data: any = {
      _id: botId,
      status: BotStatusEnum.open,
      exchange: ExchangeEnum.hyperliquidLinear,
      settings: { pair: SYMBOL, futures: true },
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
    findDiff(a: any, b: any, c?: boolean) {
      return (MainBot.prototype as any).findDiff.call(this, a, b, c)
    }
    // --- I/O and side computations, stubbed ---
    async getExchangeInfo() {
      return { pair: SYMBOL, priceAssetPrecision: 2 }
    }
    async generateCurrentBalances() {}
    async generateCurrentGrids() {}
    async primeCancelBatch() {}
    clearCancelBatch() {}
    async countBalances() {}
    getOrderFromMap(id: string) {
      return this.orders.get(id)
    }
    isOrderExist() {
      return false
    }
    batchablePlacements(orders: any[]) {
      return opts.batched ? orders.slice(0, 4) : []
    }
    installOpenBatcher() {
      return { settled() {} }
    }
    removeOpenBatcher() {}
    async sendGridToExchange(g: any) {
      sent.push(g.price)
      if (sent.length === opts.closeDuring) {
        // The close starts while this placement waits for the venue.
        if (opts.close === 'stopFilled') this.stopFilled = true
        else if (opts.close === 'closed')
          this.data.status = BotStatusEnum.closed
        else this.blockLimit = true
        if (opts.snapshotClaims) this.noteOwnCancel(g.newClientOrderId)
      }
      await new Promise((r) => setImmediate(r))
      const o = {
        clientOrderId: g.newClientOrderId,
        orderId: `venue-${g.price}`,
        symbol: SYMBOL,
        side: 'SELL',
        status: 'NEW',
        origPrice: `${g.price}`,
        price: `${g.price}`,
        origQty: '0.019',
        executedQty: '0',
        typeOrder: TypeOrderEnum.regular,
      }
      this.orders.set(o.clientOrderId, o)
      return o
    }
    async cancelOrderOnExchange(o: any) {
      cancelled.push(o.clientOrderId)
      return { ...o, status: 'CANCELED' }
    }
    processFilledOrder() {}
    restoreFromRangeOrError() {}
    updateProgress() {}
    sendEndProcess() {}
    avgPrice() {}
    updateLevels() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot = new (TestBot as any)()
  return { bot, sent, cancelled, botId }
}

describe('a grid closing during its ladder placement leaves nothing behind (spec 215)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default(
      class {
        math = new MathHelper()
        constructor(..._a: any[]) {}
      } as any,
    )
  })

  it('§4.3 control: an open grid places its whole ladder and cancels nothing', async () => {
    const { bot, sent, cancelled, botId } = buildBot()
    await bot.limitOrders(botId, OrderSideEnum.buy, LAST_PRICE)
    expect(sent).to.have.length(PRICES.length)
    expect(cancelled).to.have.length(0)
  })

  for (const close of ['blockLimit', 'stopFilled', 'closed'] as Close[]) {
    it(`§4.1/§4.2 ${close}: no level placed after the close, the in-flight one is cancelled`, async () => {
      const { bot, sent, cancelled, botId } = buildBot({
        closeDuring: 3,
        close,
      })
      await bot.limitOrders(botId, OrderSideEnum.buy, LAST_PRICE)
      expect(sent, 'placements after the close started').to.deep.equal(
        PRICES.slice(0, 3),
      )
      expect(cancelled).to.deep.equal([`GRID-ladder-${PRICES[2]}`])
    })
  }

  it('§4.2 an in-flight order the stop snapshot already claimed is not cancelled twice', async () => {
    const { bot, sent, cancelled, botId } = buildBot({
      closeDuring: 3,
      close: 'stopFilled',
      snapshotClaims: true,
    })
    await bot.limitOrders(botId, OrderSideEnum.buy, LAST_PRICE)
    expect(sent).to.have.length(3)
    expect(cancelled).to.have.length(0)
  })

  it('§4.1/§4.2 batched path: the burst in flight is cancelled, the rest never sent', async () => {
    const { bot, sent, cancelled, botId } = buildBot({
      closeDuring: 2,
      close: 'stopFilled',
      batched: true,
    })
    await bot.limitOrders(botId, OrderSideEnum.buy, LAST_PRICE)
    // The batched bodies run up to the send site in turn: the two that sent
    // before the close are cancelled, the two after it bail (the batcher
    // reads a body that never sent as a bail), and the sequential rest never
    // starts.
    expect(sent).to.deep.equal(PRICES.slice(0, 2))
    expect(cancelled.sort()).to.deep.equal(
      sent.map((p) => `GRID-ladder-${p}`).sort(),
    )
  })
})
