process.env.NODE_ENV = 'testing'

/**
 * A user's Restart deal must not be answered by the not-enough-balance
 * cooldown that earlier automatic refusals armed (spec 150).
 *
 * Drives the REAL `sendOrderToExchange` off the prototype, with the cooldown's
 * Redis replaced by an in-memory map — no Mongo, Redis, venue or bot stack.
 * Fixture ids are synthetic — this file is public.
 *
 * Run: `npm test` (mocha) from core/.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import { StatusEnum, ExchangeEnum, BotMarginTypeEnum } from '../../types'
import MainBot from './main'
import RedisClient from '../db/redis'
import { MathHelper } from '../utils/math'

const BOT_ID = '000000000000000000000b50'
const SYMBOL = 'BLUR-USDC'
const KEY = `${SYMBOL}@BUY`
const COOLDOWN_KEY = `nb:cd:${BOT_ID}:${KEY}`

const store = new Map<string, string>()
const fakeRedis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v)
  },
  del: async (k: string) => {
    store.delete(k)
  },
}

let clientSeq = 0
const makeOrder = () => ({
  clientOrderId: `D-RO-test${++clientSeq}`,
  symbol: SYMBOL,
  baseAsset: 'BLUR',
  quoteAsset: 'USDC',
  side: 'BUY',
  type: 'LIMIT',
  status: 'NEW',
  orderId: '-1',
  origQty: '9587',
  price: '0.014877',
  origPrice: '0.014877',
  exchange: ExchangeEnum.coinbase,
  typeOrder: 'dealRegular',
  dealId: '000000000000000000000d50',
  botId: BOT_ID,
  reduceOnly: false,
})

/** A bot whose guard for BLUR-USDC@BUY is armed and inside its cooldown. */
const makeBot = (openOrder: () => Promise<any>) => {
  const bot: any = Object.create(MainBot.prototype)
  const venueCalls: any[] = []
  const logs: string[] = []
  Object.assign(bot, {
    botId: BOT_ID,
    userId: '000000000000000000000a50',
    orders: new Map(),
    ordersKeys: new Set(),
    canceledMap: new Map(),
    unknownOrderInFlight: new Map(),
    math: new MathHelper(),
    venueCalls,
    logs,
    notEnoughBalanceThreshold: 10,
    notEnoughBalanceLogPrefix: 'NOB |',
    data: {
      exchange: ExchangeEnum.coinbase,
      exchangeUUID: '',
      paperContext: false,
      settings: { leverage: 1, marginType: BotMarginTypeEnum.cross },
      flags: [],
      notEnoughBalance: {
        keyVersion: 2,
        thresholdPassed: true,
        thresholdPassedTime: Date.now() - 60_000,
        orders: { [KEY]: 11 },
        refusedRequired: { [KEY]: 140 },
        refusedRequiredMax: { [KEY]: 145 },
      },
    },
    exchange: {
      openOrder: async (req: any) => {
        venueCalls.push(req)
        return openOrder()
      },
      getOrder: async () => ({
        status: StatusEnum.notok,
        reason: 'Order not found',
        data: null,
      }),
      returnBad: () => (e: Error) => ({
        status: StatusEnum.notok,
        reason: e.message,
        data: null,
      }),
    },
    ordersDb: {
      createData: async () => ({ status: StatusEnum.ok }),
      updateData: async () => ({ status: StatusEnum.ok }),
      deleteManyData: async () => ({ status: StatusEnum.ok }),
    },
    sharedStream: { addOrder: () => undefined, removeOrder: () => undefined },
    botEventDb: { createData: async () => ({ status: StatusEnum.ok }) },
    startMethod: () => 'id',
    endMethod: () => undefined,
    handleLog: (m: string) => logs.push(m),
    handleWarn: () => undefined,
    handleDebug: () => undefined,
    handleErrors: () => undefined,
    handleOrderErrors: () => undefined,
    updateData: () => undefined,
    emit: () => undefined,
    setOrdersToRedis: () => undefined,
    setOrderByStatus: () => undefined,
    removeOrderByStatus: () => undefined,
    setOrderByDeal: () => undefined,
    removeOrderByDeal: () => undefined,
    markDealStartBlocked: async () => undefined,
    needToSendOrder: () => true,
    isComplianceGateable: () => false,
    getErrorSubType: () => null,
    // The user has added funds: the cached balance covers the order.
    getAssetBalanceAndRequiredByOrder: async () => ({
      asset: 'USDC',
      balance: { free: 9826.24, locked: 0 },
      required: 142.62,
    }),
    spendableForNotEnoughBalance: async (_a: string, free: number) => free,
    convertOrderExecutedQty: async (o: any) => o.executedQty,
    getUserFee: async () => ({ maker: 0.001, taker: 0.001 }),
    getExchangeInfo: async () => ({
      priceAssetPrecision: 6,
      baseAsset: { maxMarketAmount: 1e12, precision: 0 },
      quoteAsset: { minAmount: 1, precision: 2 },
    }),
  })
  for (const [name, value] of Object.entries({
    isBitget: false,
    futures: false,
    coinm: false,
    sizedInContracts: false,
    isRealBinanceFutures: false,
    kucoinFutures: false,
    kucoinFullFutures: false,
    currentLeverage: 1,
    serviceRestart: false,
    secondRestart: false,
    ignoreErrors: false,
  })) {
    Object.defineProperty(bot, name, { value, configurable: true })
  }
  return bot
}

/** The cooldown as earlier automatic refusals left it: open for an hour. */
const armCooldown = () =>
  store.set(
    COOLDOWN_KEY,
    JSON.stringify({
      until: Date.now() + 60 * 60 * 1000,
      reason: 'Insufficient balance in source account',
      interval: 60 * 60 * 1000,
      attempt: 4,
    }),
  )

const accepted = async () => ({
  status: StatusEnum.ok,
  reason: null,
  data: {
    ...makeOrder(),
    orderId: 'venue-1',
    status: 'NEW',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    fills: [],
  },
})

const refused = async () => ({
  status: StatusEnum.notok,
  reason: 'Insufficient balance in source account',
  data: null,
})

const originalGetInstance = RedisClient.getInstance

describe('restart deal vs the not-enough-balance cooldown (spec 150)', () => {
  before(() => {
    ;(RedisClient as any).getInstance = async () => fakeRedis
  })
  after(() => {
    ;(RedisClient as any).getInstance = originalGetInstance
  })

  it('§1.1.3 without a restart the armed cooldown still answers', async () => {
    store.clear()
    armCooldown()
    const bot = makeBot(accepted)
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(0)
    expect(store.has(COOLDOWN_KEY)).to.equal(true)
  })

  it('§1.1.4 a suppressed attempt is not retried by the venue loop', async () => {
    store.clear()
    armCooldown()
    const bot = makeBot(accepted)
    const t0 = Date.now()
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(0)
    expect(
      bot.logs.filter((l: string) => l.includes('not enough balance, retry')),
    ).to.deep.equal([])
    expect(Date.now() - t0).to.be.below(900)
  })

  it('§1.1.1 a restart lets the order reach the venue', async () => {
    store.clear()
    armCooldown()
    const bot = makeBot(accepted)
    await bot.clearNotEnoughBalanceForSymbol(SYMBOL)
    expect(store.has(COOLDOWN_KEY)).to.equal(false)
    expect(bot.data.notEnoughBalance.orders[KEY]).to.equal(undefined)
    expect(bot.data.notEnoughBalance.refusedRequired[KEY]).to.equal(undefined)
    expect(bot.data.notEnoughBalance.refusedRequiredMax[KEY]).to.equal(
      undefined,
    )
    await bot.sendOrderToExchange(makeOrder())
    expect(bot.venueCalls).to.have.length(1)
  })

  it('§1.1.2 a venue refusal after the restart is recorded again', async () => {
    store.clear()
    armCooldown()
    const bot = makeBot(refused)
    bot.data.exchange = ExchangeEnum.binance
    await bot.clearNotEnoughBalanceForSymbol(SYMBOL)
    const order = { ...makeOrder(), exchange: ExchangeEnum.binance }
    await bot.sendOrderToExchange(order)
    expect(bot.venueCalls).to.have.length(1)
    // The venue's refusal is evidence again: its size is remembered.
    expect(bot.data.notEnoughBalance.refusedRequired[KEY]).to.be.closeTo(
      142.62,
      0.01,
    )
  })
})
