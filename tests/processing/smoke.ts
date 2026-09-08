/**
 * Spec: specs/016.test-processing-harness.md §2 items 1-3.
 *
 * Not a fee-feature test. This is the harness's own proof of life: the three
 * ported pieces (in-memory Mongo, a `tests/processing/` integration tier, the
 * ExchangeChooser sinon-stub pattern) actually work together in `app-sh`,
 * mirroring `app`'s own `tests/processing/orderProcessing.ts` beforeEach —
 * before spec `015`'s two-stage TP retry test builds on top of this.
 *
 * Run: `npm run processing:test`.
 */
import { describe, it, before, after } from 'mocha'
import { expect } from 'chai'
import sinon from 'sinon'
import {
  ExchangeEnum,
  StatusEnum,
  StrategyEnum,
  OrderSizeTypeEnum,
  OrderTypeEnum,
  StartConditionEnum,
  CloseConditionEnum,
} from '../../types'
import { userDb, dcaBotDb, feeDb, pairDb } from '../../src/db/dbInit'
import resolvers from '../../src/graphql/resolvers'
import ExchangeChooser from '../../src/exchange/exchangeChooser'

const { Mutation } = resolvers()

const TOKEN = 'smoke test token'

describe('Integration-test harness smoke test', () => {
  before(async () => {
    // Proof-of-life stub — shape mirrors app's own precedent
    // (tests/processing/orderProcessing.ts). Typed `any`: matching
    // AbstractExchange's real return types exactly is not the point here.
    const fakeExchange = (): any => ({
      openOrder: () =>
        Promise.resolve({ status: StatusEnum.ok, reason: null, data: {} }),
      getBalance: () =>
        Promise.resolve({
          status: StatusEnum.ok,
          reason: null,
          data: [{ asset: 'USDT', free: 10000, locked: 0 }],
        }),
      latestPrice: () =>
        Promise.resolve({ status: StatusEnum.ok, reason: null, data: 1 }),
      getAllPrices: () =>
        Promise.resolve({ status: StatusEnum.ok, reason: null, data: [] }),
    })
    sinon
      .stub(ExchangeChooser, 'chooseExchangeFactory')
      // @ts-ignore -- stub return narrower than the real per-exchange factory union
      .returns(fakeExchange)
  })

  after(async () => {
    sinon.restore()
    await dcaBotDb.deleteManyData({})
    await userDb.deleteManyData({})
    await feeDb.deleteManyData({})
    await pairDb.deleteManyData({})
  })

  it('creates a user via the real DAO and a bot via the real resolver against in-memory Mongo', async () => {
    const user = await userDb.createData({
      tokens: [
        {
          token: TOKEN,
          expiredAt: Date.now() * 10,
          createdAt: Date.now(),
          source: 'email',
        },
      ],
      timezone: 'UTC',
      username: 'smoke test user',
      password: 'irrelevant',
      exchanges: [
        {
          provider: ExchangeEnum.binance,
          key: 'key',
          secret: 'secret',
          name: 'smoke exchange',
          uuid: 'smoke-uuid',
        },
      ],
      onboardingSteps: {
        signup: true,
        liveExchange: false,
        deployLiveBot: false,
        earnProfit: false,
      },
    })
    expect(user.status).to.equal(StatusEnum.ok)
    expect(user.data?._id).to.exist

    await feeDb.createData({
      userId: user.data!._id.toString(),
      exchange: ExchangeEnum.binance,
      exchangeUUID: 'smoke-uuid',
      pair: 'BNBUSDT',
      maker: 0.05,
      taker: 0.05,
    })
    await pairDb.createData({
      pair: 'BNBUSDT',
      exchange: ExchangeEnum.binance,
      baseAsset: {
        minAmount: 0.001,
        maxAmount: 1000,
        step: 0.001,
        name: 'BNB',
        maxMarketAmount: 1000,
      },
      quoteAsset: { minAmount: 0.001, name: 'USDT' },
      maxOrders: 100,
      priceAssetPrecision: 1,
      priceMultiplier: { up: 1, down: 1, decimals: 1 },
      assetCategory: 'crypto',
    })

    const created = await Mutation.createDCABot(
      undefined,
      {
        input: {
          vars: { list: [], paths: [] },
          name: 'smoke test bot',
          pair: ['BNBUSDT'],
          profitCurrency: 'quote' as const,
          orderFixedIn: 'quote' as const,
          strategy: StrategyEnum.long,
          baseOrderSize: '50',
          startOrderType: OrderTypeEnum.limit,
          startCondition: StartConditionEnum.asap,
          tpPerc: '10',
          orderSize: '50',
          step: '1',
          ordersCount: 5,
          activeOrdersCount: 5,
          volumeScale: '1',
          stepScale: '1',
          useTp: true,
          useSmartOrders: true,
          useDca: true,
          hodlDay: '0',
          hodlAt: '15:00:00',
          hodlNextBuy: 0,
          useSl: false,
          slPerc: '10',
          indicators: [],
          orderSizeType: OrderSizeTypeEnum.quote,
          exchange: ExchangeEnum.binance,
          exchangeUUID: 'smoke-uuid',
          dealCloseCondition: CloseConditionEnum.tp,
          maxNumberOfOpenDeals: '1',
          indicatorGroups: [],
        },
      },
      {
        token: TOKEN,
        req: {
          cookies: {},
          user: { authorized: true, username: 'smoke test user' },
        },
        paperContext: false,
      },
    )
    expect(created.status).to.equal(StatusEnum.ok)

    const stored = await dcaBotDb.readData(
      { userId: user.data!._id.toString() },
      undefined,
      {},
      true,
    )
    expect(stored.status).to.equal(StatusEnum.ok)
    expect(stored.data?.result?.length).to.equal(1)
    expect(stored.data?.result?.[0].settings.name).to.equal('smoke test bot')
  })
})
