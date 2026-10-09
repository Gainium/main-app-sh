process.env.NODE_ENV = 'testing'

/**
 * Spec `143` — a futures deal whose resting take-profit the venue refuses
 * because it holds no position for it stops re-sending the take-profit on every
 * pass and tells the user once, and the deal is never closed for it.
 *
 * Drives the REAL `placeOrdersHoldingDealLock` (and through it the real
 * `sendFuturesRestingTp` / `checkRefusedRestingTpPosition`) over a fake base,
 * with `sendGridToExchange` and `futures_getPositions` standing in for the
 * venue. The classifier is the real `getErrorSubType`, so the
 * `wouldNotReducePosition` → `Futures position` mapping is the shipped one.
 *
 * The fixture is the production shape (spec §2): a LONG BTC-USD deal on a
 * Kraken futures account holding 0.003, its take-profit SELL 0.003 @ 70577
 * refused `wouldNotReducePosition` on every pass while Kraken reports no
 * position at all. Ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before, beforeEach, after } from 'mocha'
import { expect } from 'chai'
import { createRequire } from 'module'
import RedisClient from '../../db/redis'
import MainBot from '../main'
import { getErrorSubType } from '../utils'
import { restingTpPositionGoneMessage } from './positionReconcile'
import {
  BotStatusEnum,
  DCADealStatusEnum,
  ExchangeEnum,
  MessageTypeEnum,
  OrderSideEnum,
  StatusEnum,
  TypeOrderEnum,
} from '../../../types'

const DEAL_ID = '000000000000000000000d43'
const BOT_ID = '000000000000000000000b43'
const SYMBOL = 'BTC-USD'
const TP_ID = 'D-TP-00000000000000000000000000143'
const REFUSAL = 'wouldNotReducePosition'

/** Backoff state lives in Redis; back it with a Map (see refusedCloseRestore). */
const backoffStore = new Map<string, string>()
let previousGetInstance: unknown
/** Every open window falls into the past. */
const passWindow = () => {
  for (const [k, v] of backoffStore) {
    backoffStore.set(k, JSON.stringify({ ...JSON.parse(v), until: 0 }))
  }
}

const plannedTp = () => ({
  number: 0,
  price: 70577,
  qty: 0.003,
  side: OrderSideEnum.sell,
  newClientOrderId: TP_ID,
  type: TypeOrderEnum.dealTP,
  dealId: DEAL_ID,
})

class FakeBase {
  botId = BOT_ID
  userId = '000000000000000000000443'
  botType = 'dca'
  hyperliquid = false
  data: any = {
    status: BotStatusEnum.open,
    settings: { type: 'regular', pair: [SYMBOL] },
    exchange: ExchangeEnum.krakenUsdm,
    exchangeUUID: '',
    paperContext: false,
  }
  shouldProceed() {
    return true
  }
  getErrorSubType(e: string) {
    return getErrorSubType(e)
  }
  convertGridToOrder = (MainBot.prototype as any).convertGridToOrder
  needToSendOrder = (MainBot.prototype as any).needToSendOrder
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

type Venue = {
  /** What the venue answers the take-profit with. */
  answer: () => any
  /** What `futures_getPositions` returns. */
  positions: () => any
}

const buildBot = (venue: Venue, over: { futures?: boolean } = {}) => {
  const deal: any = {
    deal: {
      _id: DEAL_ID,
      botId: BOT_ID,
      status: DCADealStatusEnum.open,
      symbol: { symbol: SYMBOL },
      settings: {},
      tpSlTargetFilled: [],
    },
    closeBySl: false,
    closeByTp: false,
    currentOrders: [plannedTp()],
  }
  class TestBot extends Helper {
    math = { round: (v: number) => v }
    sent: any[] = []
    events: any[] = []
    reported: any[] = []
    positionReads = 0
    closed: string[] = []
    logs: string[] = []
    resting: any[] = []
    stopList = new Set<string>()
    allowToPlaceOrders = new Map()
    ordersInBetweenUpdates = new Set<string>()
    futures = over.futures ?? true
    hedge = false
    isLong = true
    exchange: any = {
      futures_getPositions: async () => {
        this.positionReads += 1
        return venue.positions()
      },
    }
    botEventDb = {
      createData: (e: any) => {
        this.events.push(e)
      },
    }
    getDeal(id?: string) {
      return id === DEAL_ID ? deal : undefined
    }
    getOrdersByStatusAndDealId() {
      return this.resting
    }
    getOrderFromMap(id: string) {
      return this.resting.find((o) => o.clientOrderId === id)
    }
    async isDealForTPLevelCheck() {
      return false
    }
    async getExchangeInfo() {
      return {
        pair: SYMBOL,
        baseAsset: { name: 'BTC', minAmount: 0.0001, step: 0.0001 },
        quoteAsset: { name: 'USD', minAmount: 1 },
        priceAssetPrecision: 0,
      }
    }
    async getAggregatedSettings() {
      return { useMultiTp: false }
    }
    batchablePlacements() {
      return []
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    async sendGridToExchange(
      order: any,
      options: any,
      _ed: any,
      returnError?: boolean,
    ) {
      this.sent.push({ order, options, returnError })
      return venue.answer()
    }
    handleOrderErrors(reason: string, order: any, method: string) {
      this.reported.push({ reason, order, method })
    }
    async closeDeal(_b: string, id: string) {
      this.closed.push(id)
    }
    handleLog(m: string) {
      this.logs.push(m)
    }
    handleDebug(m: string) {
      this.logs.push(m)
    }
    handleWarn(m: string) {
      this.logs.push(m)
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  const bot: any = new TestBot()
  bot.deal = deal
  return bot
}

/** One `placeOrders` pass over the deal — a worker start, reconnect or check. */
const pass = (bot: any) =>
  bot.placeOrdersHoldingDealLock(BOT_ID, SYMBOL, DEAL_ID, {
    new: [plannedTp()],
    cancel: [],
  })

const refused = () => REFUSAL
const accepted = () => ({ clientOrderId: TP_ID, status: 'NEW' })
const flat = () => ({ status: StatusEnum.ok, data: [] })
const holding = () => ({
  status: StatusEnum.ok,
  data: [{ symbol: SYMBOL, positionAmt: '0.0053', positionSide: 'BOTH' }],
})

describe('a futures resting TP refused for a position the venue does not hold (spec 143)', () => {
  before(function () {
    // One ts-node compile of a 25k-line module.
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
    previousGetInstance = (RedisClient as any).getInstance
    ;(RedisClient as any).getInstance = async () => ({
      get: async (k: string) => backoffStore.get(k) ?? null,
      set: async (k: string, v: string) => {
        backoffStore.set(k, v)
      },
      del: async (k: string) => {
        backoffStore.delete(k)
      },
    })
  })
  after(() => {
    ;(RedisClient as any).getInstance = previousGetInstance
  })
  beforeEach(() => backoffStore.clear())

  it('§4.3 §4.4 warns the user once, on the deal, and never closes it', async () => {
    const bot = buildBot({ answer: refused, positions: flat })
    await pass(bot)
    expect(bot.sent).to.have.length(1)
    expect(bot.sent[0].options.reduceOnly).to.equal(true)
    expect(bot.positionReads).to.equal(1)
    expect(bot.events, bot.logs.join('\n')).to.have.length(1)
    const [e] = bot.events
    expect(e.event).to.equal('Deal')
    expect(e.type).to.equal(MessageTypeEnum.warning)
    expect(e.deal).to.equal(DEAL_ID)
    expect(e.symbol).to.equal(SYMBOL)
    expect(e.description).to.equal(
      restingTpPositionGoneMessage({
        dealId: DEAL_ID,
        symbol: SYMBOL,
        exchange: ExchangeEnum.krakenUsdm,
        reason: REFUSAL,
      }),
    )
    expect(bot.closed).to.deep.equal([])
    expect(bot.deal.deal.status).to.equal(DCADealStatusEnum.open)
  })

  it('§4.5 the refusal still goes through the same (hidden) error report', async () => {
    const bot = buildBot({ answer: refused, positions: flat })
    await pass(bot)
    expect(bot.reported).to.have.length(1)
    expect(bot.reported[0].reason).to.equal(REFUSAL)
    expect(bot.reported[0].method).to.equal('limitOrders()')
    expect(bot.reported[0].order.clientOrderId).to.equal(TP_ID)
  })

  it('§4.3 the next passes inside the window send nothing and say nothing', async () => {
    const bot = buildBot({ answer: refused, positions: flat })
    await pass(bot)
    await pass(bot)
    await pass(bot)
    expect(bot.sent).to.have.length(1)
    expect(bot.positionReads).to.equal(1)
    expect(bot.events).to.have.length(1)
    expect(bot.reported).to.have.length(1)
  })

  it('§4.3 once the window passes it retries, widens the window, and does not warn again', async () => {
    const bot = buildBot({ answer: refused, positions: flat })
    await pass(bot)
    const first = JSON.parse([...backoffStore.values()][0])
    passWindow()
    await pass(bot)
    expect(bot.sent).to.have.length(2)
    expect(bot.events).to.have.length(1)
    const second = JSON.parse([...backoffStore.values()][0])
    expect(second.attempt).to.equal(2)
    expect(second.interval).to.be.greaterThan(first.interval)
    expect(bot.closed).to.deep.equal([])
  })

  it('§4.2 a position the venue still holds changes nothing', async () => {
    const bot = buildBot({ answer: refused, positions: holding })
    await pass(bot)
    await pass(bot)
    expect(bot.sent).to.have.length(2)
    expect(bot.events).to.have.length(0)
    expect(backoffStore.size).to.equal(0)
  })

  it('§4.2 a venue that does not answer the position read changes nothing', async () => {
    const bot = buildBot({
      answer: refused,
      positions: () => ({ status: StatusEnum.notok, reason: 'timeout' }),
    })
    await pass(bot)
    await pass(bot)
    expect(bot.sent).to.have.length(2)
    expect(bot.events).to.have.length(0)
  })

  it('§4.1 other refusals are not probed', async () => {
    for (const reason of [
      'insufficientAvailableFunds',
      'Leverage cannot exceed 5x',
    ]) {
      const bot = buildBot({ answer: () => reason, positions: flat })
      await pass(bot)
      await pass(bot)
      expect(bot.positionReads, reason).to.equal(0)
      expect(bot.sent, reason).to.have.length(2)
      expect(bot.events, reason).to.have.length(0)
      expect(bot.reported, reason).to.have.length(2)
    }
  })

  it('§4.6 an accepted take-profit ends the episode; a later one warns again', async () => {
    let answer: () => any = refused
    const bot = buildBot({ answer: () => answer(), positions: flat })
    await pass(bot)
    passWindow()
    answer = accepted
    await pass(bot)
    expect(backoffStore.size).to.equal(0)
    answer = refused
    await pass(bot)
    expect(bot.events).to.have.length(2)
  })

  it('§1.3 a spot deal keeps the plain send', async () => {
    const bot = buildBot({ answer: refused, positions: flat }, { futures: false })
    await pass(bot)
    expect(bot.sent).to.have.length(1)
    expect(bot.sent[0].returnError).to.equal(undefined)
    expect(bot.positionReads).to.equal(0)
    expect(bot.events).to.have.length(0)
  })
})
