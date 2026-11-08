process.env.NODE_ENV = 'testing'

/**
 * A grid close on a key that may not cancel must say so, and must stop asking.
 *
 * Spec: `specs/232.grid-close-on-a-key-that-cannot-cancel-closes-silently.md`.
 *
 * The shape is a production close of a Kraken spot grid whose key could place
 * orders but not cancel them: the first cancel came back
 * `EGeneral:Permission denied`, every later one a lockout of the key, and the
 * bot closed with no message while its orders kept resting on the exchange.
 *
 * Drives the REAL grid `stop()` and `cancelAllOrder` (helper mixin) over the
 * REAL `MainBot` `cancelOrderOnExchange` and `reportUserRefusal`; transport,
 * Redis and DB are stubbed. Fixture ids are synthetic — this file is public.
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
  MessageTypeEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../types'
import MainBot from './main'
import { MathHelper } from '../utils/math'
import { isKeyPermissionRefusal } from './authGuard'

const SYMBOL = 'XBTUSD'
const PERMISSION = 'EGeneral:Permission denied'
const LOCKOUT =
  'EGeneral:Temporary lockout (balancer held this key off for another 1200s)'

let Helper: any

const buy = (i: number) => ({
  symbol: SYMBOL,
  orderId: `OTEST${i}-AAAAA-232${String(i).padStart(3, '0')}`,
  clientOrderId: `GRID-RO-test232order${i}`,
  typeOrder: TypeOrderEnum.regular,
  price: `${80000 + i}`,
  origPrice: `${80000 + i}`,
  origQty: '0.0001',
  executedQty: '0',
  cummulativeQuoteQty: '0',
  status: 'NEW',
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
const buildBot = (n: number, answer: (k: number) => string) => {
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
    botId = '00000000000000000000d232'
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
      _id: '00000000000000000000d232',
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
  for (let i = 0; i < n; i++) bot.setOrder(buy(i), false)
  return { bot, cancelCalls, notices, saved }
}

describe('a grid close on a key that may not cancel (spec 232)', () => {
  before(function () {
    this.timeout(180000)
    Helper = createRequire(__filename)('./helper').default
  })

  it('§4.1 permission and dead-credential refusals are key refusals; lockout and rate are not', () => {
    expect(isKeyPermissionRefusal(PERMISSION)).to.equal(true)
    expect(
      isKeyPermissionRefusal(
        'Permission denied, please check your API key permissions.',
      ),
    ).to.equal(true)
    expect(isKeyPermissionRefusal('EAPI:Invalid key')).to.equal(true)
    expect(isKeyPermissionRefusal(LOCKOUT)).to.equal(false)
    expect(isKeyPermissionRefusal('EAPI:Rate limit exceeded')).to.equal(false)
    expect(isKeyPermissionRefusal('EOrder:Unknown order')).to.equal(false)
    expect(isKeyPermissionRefusal(undefined)).to.equal(false)
  })

  it('§4.2 after the first key refusal the sweep sends no further cancel and the orders stay as they are', async () => {
    const { bot, cancelCalls, saved } = buildBot(5, (k) =>
      k === 0 ? PERMISSION : LOCKOUT,
    )
    await bot.cancelAllOrder(false, false)
    expect(cancelCalls, 'one cancel, then silence').to.have.length(1)
    expect(saved, 'no row written as cancelled').to.have.length(0)
    const resting = [...bot.orders.values()].filter(
      (o: any) => o.status === 'NEW',
    )
    expect(resting, 'all five still tracked').to.have.length(5)
  })

  it('§4.3 stop() closes the bot and tells the user which orders remain on the exchange', async () => {
    const { bot, notices } = buildBot(3, (k) =>
      k === 0 ? PERMISSION : LOCKOUT,
    )
    await bot.stop()
    expect(bot.data.status).to.equal(BotStatusEnum.closed)
    expect(notices, 'one bot message').to.have.length(1)
    const m = notices[0]
    expect(m.type).to.equal(MessageTypeEnum.error)
    expect(m.showUser).to.equal(true)
    for (let i = 0; i < 3; i++) {
      expect(m.message).to.contain(buy(i).orderId)
    }
    expect(m.message).to.contain(PERMISSION)
    // Must not be re-classified by the message-text error dictionary.
    expect(m.message).to.not.contain('was left open on the exchange')
    expect(m.message).to.not.contain('still open')
  })

  it('§4.3 a long list is capped', async () => {
    const { bot, notices } = buildBot(45, (k) =>
      k === 0 ? PERMISSION : LOCKOUT,
    )
    await bot.stop()
    expect(notices).to.have.length(1)
    expect(notices[0].message).to.contain(buy(39).orderId)
    expect(notices[0].message).to.not.contain(buy(40).orderId)
    expect(notices[0].message).to.contain('and 5 more')
  })

  it('§4.4 a close whose cancels all go through is unchanged: every cancel sent, no message', async () => {
    const { bot, cancelCalls, notices } = buildBot(4, () => 'ok')
    await bot.stop()
    expect(cancelCalls).to.have.length(4)
    expect(notices).to.have.length(0)
    expect(
      [...bot.orders.values()].filter((o: any) => o.status === 'NEW'),
    ).to.have.length(0)
    expect(bot.data.status).to.equal(BotStatusEnum.closed)
  })

  it('§1.3 a refusal that is not about the key (lockout) still sends every cancel and adds no message', async () => {
    const { bot, cancelCalls, notices } = buildBot(3, () => LOCKOUT)
    bot.scheduleCancelRetry = () => undefined
    await bot.stop()
    expect(cancelCalls).to.have.length(3)
    expect(notices).to.have.length(0)
  })
})
