process.env.NODE_ENV = 'testing'

/**
 * An automatic grid stop must cancel a part-filled level too.
 *
 * Spec: `specs/236.an-automatic-grid-stop-leaves-a-part-filled-order-resting.md`.
 *
 * Shape from production: a futures grid closed on take profit with the action
 * `stop`. The close sweep cancelled the NEW levels only; a level part-filled
 * an hour earlier was never asked to cancel and kept resting for a closed bot.
 *
 * Drives the REAL grid `closeBotByTp`, `stop()` and `cancelAllOrder` (helper
 * mixin) over the REAL `MainBot` `cancelOrderOnExchange`; transport, Redis and
 * DB are stubbed. Harness copied from `gridCloseKeyCannotCancel.spec.ts`.
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
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'

const SYMBOL = 'XBTUSD'

let Helper: any

const buy = (i: number, status = 'NEW', executedQty = '0') => ({
  symbol: SYMBOL,
  orderId: `OTEST${i}-AAAAA-236${String(i).padStart(3, '0')}`,
  clientOrderId: `GRID-RO-test236order${i}`,
  typeOrder: TypeOrderEnum.regular,
  price: `${80000 + i}`,
  origPrice: `${80000 + i}`,
  origQty: '0.0001',
  executedQty,
  cummulativeQuoteQty: '0',
  status,
  side: 'BUY',
  type: 'LIMIT',
  updateTime: 1793900000000 + i,
  transactTime: 1793900000000 + i,
  exchange: ExchangeEnum.kraken,
})

/**
 * @param n how many resting orders the bot has.
 * @param answer what the venue answers the k-th cancel call (0-based):
 *   `ok`, or a refusal reason.
 */
const buildBot = (orders: any[], answer: (k: number) => string = () => 'ok') => {
  const cancelCalls: string[] = []
  const notices: any[] = []
  const saved: any[] = []

  class Base {
    math = new MathHelper()
    constructor(..._a: any[]) {}
  }
  Object.setPrototypeOf(Base.prototype, (MainBot as any).prototype)
  const Grid = Helper(Base as any)

  class TestBot extends Grid {
    math = new MathHelper()
    botId = '00000000000000000000d236'
    userId = 'test-user'
    botType = BotType.grid
    firstRun = true
    blockLimit = false
    ignoreErrors = false
    orderStatuses = ['NEW', 'PARTIALLY_FILLED']
    orders = new Map<string, any>()
    ordersKeys = new Set<string>()
    orderStatusMap = new Map()
    orderDealMap = new Map()
    canceledMap = new Map()
    unknownOrderInFlight = new Map()
    orderQueue: any[] = []
    cbFunctions = { sort: () => 0 }
    sharedStream = { addOrder() {}, removeOrder() {} }
    pairs = new Set<string>()
    data: any = {
      _id: '00000000000000000000d236',
      status: BotStatusEnum.open,
      exchange: ExchangeEnum.kraken,
      exchangeUUID: '',
      paperContext: false,
      workingShift: [],
      settings: { pair: SYMBOL, name: 'test grid' },
    }
    exchange = {
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
      cancelOrder: async ({ newClientOrderId }: any) => {
        const k = cancelCalls.length
        cancelCalls.push(newClientOrderId)
        const a = answer(k)
        if (a !== 'ok') {
          return { status: StatusEnum.notok, reason: a, data: null }
        }
        const o =
          [...this.orders.values()].find(
            (x: any) => `${x.orderId}` === `${newClientOrderId}`,
          ) ?? {}
        return {
          status: StatusEnum.ok,
          reason: '',
          data: { ...o, status: 'CANCELED', executedQty: '0' },
        }
      },
    }
    messagesDb = {
      createData: async (row: any) => {
        notices.push(row)
        return { status: StatusEnum.ok, data: { _id: 'm1' } }
      },
    }
    botEventDb = { createData: () => undefined }
    // --- I/O, stubbed ---
    setOrdersToRedis() {}
    async getLatestPrice() {
      return 80000
    }
    async getUsdRate() {
      return 1
    }
    async countBalances() {}
    async primeCancelBatch() {}
    clearCancelBatch() {}
    sendEndProcess() {}
    updateProgress() {}
    async afterBotStop() {}
    closeUserStream() {}
    async updateData() {}
    async unsubscribeFromExchangeInfo() {}
    async unsubscribeFromUserFee() {}
    async unsubscribeFromUser() {}
    async unsubscribeFromLastUsdData() {}
    async unsubscribeFromLastStreamData() {}
    async unsubscribeFromGlobalVars() {}
    clearClassProperties() {}
    sendBotClosed() {}
    getWorkingTimeNumber() {
      return 0
    }
    trimWorkingShift(w: any) {
      return w
    }
    updateOrderOnDb(o: any) {
      saved.push({ ...o })
    }
    async convertOrderExecutedQty(o: any) {
      return o.executedQty
    }
    async _handleUnknownOrder() {
      return null
    }
    processOrderQueue() {}
    emit() {}
    pushLogs() {}
    handleLog() {}
    handleDebug() {}
    handleWarn() {}
    handleErrors() {}
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new (TestBot as any)()
  for (const o of orders) bot.setOrder(o, false)
  return { bot, cancelCalls, notices, saved }
}


const resting = () => [buy(0), buy(1, 'PARTIALLY_FILLED', '0.00003')]

// What closeBotByTp needs beyond the sweep: a trigger and the pair's info.
const armTpSl = (bot: any, side: 'tp' | 'sl') => {
  bot.data.settings = {
    ...bot.data.settings,
    futures: false,
    coinm: false,
    strategy: 'long',
    tpSlAction: 'stop',
    slAction: 'stop',
  }
  bot.tpSl = () => ({ value: side, text: `${side} trigger` })
  bot.getExchangeInfo = async () => ({
    pair: SYMBOL,
    priceAssetPrecision: 1,
    baseAsset: { minAmount: 0.00001, step: 0.00001, name: 'XBT' },
    quoteAsset: { minAmount: 1, step: 0.01, name: 'USD' },
  })
}

const tick = { symbol: SYMBOL, price: 80100, time: 0, volume: 0 }

describe('an automatic grid stop cancels part-filled levels (spec 236)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default
  })

  for (const side of ['tp', 'sl'] as const) {
    it(`§4.1 ${side} with action stop sends a cancel for the part-filled level`, async () => {
      const { bot, cancelCalls } = buildBot(resting())
      armTpSl(bot, side)
      await bot.closeBotByTp(bot.botId, tick)
      // The branch does not await stop(); let the sweep finish.
      await new Promise((r) => setTimeout(r, 50))
      expect(bot.data.status).to.equal(BotStatusEnum.closed)
      expect(cancelCalls).to.have.members([buy(0).orderId, buy(1).orderId])
    })
  }

  it('§4.2 a liquidation stops with cancelPartiallyFilled', async () => {
    const { bot } = buildBot(resting())
    const args: any[] = []
    bot.stop = async (...a: any[]) => {
      args.push(a)
    }
    Object.defineProperty(bot, 'futures', { get: () => true })
    bot.data.settings.strategy = 'long'
    bot.data.symbol = { symbol: SYMBOL }
    bot.data.position = { side: 'LONG', qty: 1, price: 80000 }
    bot.data.profit = { total: 0, totalUsd: 0, freeTotal: 0, freeTotalUsd: 0 }
    bot.closeEntryPrice = async () => 80000
    bot.transactionDb = {
      createData: async (d: any) => ({
        status: StatusEnum.ok,
        data: { ...d, _id: 't' },
      }),
    }
    bot.saveProfitToDb = () => undefined
    bot.resetPosition = () => undefined
    await bot.processLiquidationOrder({
      ...buy(9, 'FILLED', '1'),
      side: 'SELL',
      price: '70000',
      clientOrderId: 'liquidation-test236',
      updateTime: 1793900001000,
    })
    expect(args, 'stop() was reached').to.have.length(1)
    expect(args[0][0]).to.equal(true)
  })

  it('§4.3 unchanged: a manual stop without the flag leaves the part-filled level', async () => {
    const { bot, cancelCalls } = buildBot(resting())
    await bot.stop()
    expect(cancelCalls).to.deep.equal([buy(0).orderId])
  })

  it('§4.3 unchanged: a manual stop with the flag cancels both', async () => {
    const { bot, cancelCalls } = buildBot(resting())
    await bot.stop(true)
    expect(cancelCalls).to.have.members([buy(0).orderId, buy(1).orderId])
  })
})
