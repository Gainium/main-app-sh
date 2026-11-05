process.env.NODE_ENV = 'testing'

/**
 * Spec `224.entry-fill-close-floor-reads-a-stale-zero-size`.
 *
 * Drives the REAL `dcaHelper.getTPOrder` over the state it sees when a base
 * order fills: the order rows show the fill, but `deal.size` is still 0 because
 * `updateUsage` writes it only after the take-profit has been sized. Recorded
 * shape: binance, step 0.01, 5 USDT floor, 0.09 bought with the fee taken in
 * base, so the fee-netted close floors to 0.08 and enters the below-minimum
 * branch.
 *
 * Built on a minimal base class (see `tpDustClose.harness.spec.ts`, whose
 * `FakeBase`/`buildBot` this copies). Nothing here places or cancels anything.
 *
 * Run: `npm test` (mocha).
 */
import { describe, it, before } from 'mocha'
import { expect } from 'chai'
import { MathHelper } from '../../utils/math'
import { ExchangeEnum, StatusEnum } from '../../../types'
import { createRequire } from 'module'
import RedisClient from '../../db/redis'

const backoffStore = new Map<string, string>()
;(RedisClient as any).getInstance = async () => ({
  get: async (k: string) => backoffStore.get(k) ?? null,
  set: async (k: string, v: string) => {
    backoffStore.set(k, v)
  },
  del: async (k: string) => {
    backoffStore.delete(k)
  },
})

const settings: any = {
  useTp: true,
  useMultiTp: false,
  useMultiSl: false,
  trailingTp: false,
  dealCloseCondition: 'tp',
  dealCloseConditionSL: 'tp',
  multiTp: [],
  tpPerc: '2',
  slPerc: '0',
  baseOrderSize: '5.6',
  orderSizeType: 'quote',
  indicators: [],
}

/** binance: whole-cent base steps against a 5 USDT floor. */
const PAIR: any = {
  pair: 'XYZUSDT',
  baseAsset: { minAmount: 0.01, step: 0.01, name: 'XYZ' },
  quoteAsset: { minAmount: 5, step: 0.01, name: 'USDT' },
  priceAssetPrecision: 2,
}

const DEAL_ID = '000000000000000000000224'
const FEE = { maker: 0.001, taker: 0.001 }
const FILL_PRICE = 59.94

type Reported = {
  message: string
  setError: boolean
  sendError: boolean
  setEvent: boolean
}

class FakeBase {
  math = new MathHelper()
  // Synthetic — nothing here reads them, and this file is public.
  botId = '000000000000000000000001'
  userId = '000000000000000000000002'
  isLong = true
  futures = false
  coinm = false
  combo = false
  kucoinSpot = false
  zeroFee = false
  isBitget = false
  tpAr = false
  slAr = false
  scaleAr = false
  botType = 'dca'
  data: any = {
    settings,
    exchange: ExchangeEnum.hyperliquid,
    flags: [],
    paperContext: false,
  }
  constructor(..._a: any[]) {}
}

const loadModule = createRequire(__filename)
let Helper: any

const buildBot = (
  deal: any,
  orders: any[],
  info: any,
  market: number,
  isLong: boolean,
  fee: { maker: number; taker: number },
  /**
   * Spec `047` §4.3. What `getBalancesFromExchange()` answers. `undefined`
   * leaves the bot without an exchange at all, which is every case written
   * before `047` and keeps them on the pre-`047` path.
   */
  balances?: { asset: string; free: number; locked: number }[] | 'unavailable',
) => {
  class TestBot extends Helper {
    public reported: Reported[] = []
    public debugs: string[] = []
    public isLong = isLong
    public closed: string[] = []
    public events: string[] = []
    public balanceCalls = 0
    public exchange: any = balances === undefined ? undefined : {}
    public hedge = false
    public botEventDb: any = {
      createData: (d: any) => {
        this.events.push(`${d.description}`)
      },
    }

    shouldProceed() {
      return true
    }
    async getBalancesFromExchange() {
      this.balanceCalls++
      if (balances === 'unavailable') {
        return { status: StatusEnum.notok, reason: 'timeout', data: null }
      }
      return { status: StatusEnum.ok, data: balances ?? [] }
    }
    async closeDeal(_botId: string, dealId: string) {
      this.closed.push(dealId)
    }

    getDeal(id: string) {
      return deal && id === DEAL_ID
        ? { deal, initialOrders: [], currentOrders: [] }
        : undefined
    }
    /** The real index lookup, over the fixture's map rather than a live one. */
    getOrdersByStatusAndDealId({
      status,
      dealId,
    }: {
      status?: string | string[]
      dealId?: string
    }) {
      const wanted = status ? [status].flat() : undefined
      return orders.filter(
        (o) =>
          (!dealId || o.dealId === dealId) &&
          (!wanted || wanted.includes(o.status)),
      )
    }
    findBaseOrderByDeal(id: string) {
      return orders.find(
        (o) =>
          o.dealId === id && o.typeOrder === 'dealStart' && +o.executedQty > 0,
      )
    }
    async getAggregatedSettings() {
      return settings
    }
    async getExchangeInfo() {
      return info
    }
    async getUserFee() {
      return fee
    }
    async baseAssetPrecision() {
      return this.math.countDecimals(info.baseAsset.step)
    }
    async getUsdRate() {
      return 1
    }
    async getLatestPrice() {
      return market
    }
    async profitBase() {
      return false
    }
    getPendingReduceFunds() {
      return { base: 0, quote: 0 }
    }
    currentDealFeeIsThirdAssetOnly() {
      return false
    }
    updateDealBalances() {}
    getOrderId(prefix: string) {
      return `${prefix}-entryFillCloseFloor`
    }
    handleLog() {}
    handleWarn() {}
    handleDebug(m: string) {
      this.debugs.push(m)
    }
    handleErrors(
      message: string,
      _method?: string,
      _step?: string,
      setError = true,
      sendError = true,
      setEvent = true,
    ) {
      this.reported.push({ message, setError, sendError, setEvent })
    }
    startMethod() {
      return '1'
    }
    endMethod() {}
  }
  return new TestBot()
}


/** The deal as the base-fill handler holds it when it sizes the close. */
const dealAt = (size: number, updateTime: number, extra: any = {}): any => ({
  _id: DEAL_ID,
  symbol: { symbol: 'XYZUSDT', baseAsset: 'XYZ', quoteAsset: 'USDT' },
  status: 'open',
  size,
  tpHistory: [],
  reduceFunds: [],
  funds: [],
  lastPrice: FILL_PRICE,
  avgPrice: FILL_PRICE,
  initialPrice: FILL_PRICE,
  currentBalances: { base: size, quote: 100 },
  initialBalances: { base: 0, quote: 106.75 },
  updateTime,
  ...extra,
})

/** Base order: 0.09 bought, the venue kept 0.00009 of it as the fee. */
const baseOrder = (executedQty: string, updateTime: number): any => ({
  dealId: DEAL_ID,
  typeOrder: 'dealStart',
  status: executedQty === '0' ? 'NEW' : 'FILLED',
  side: 'BUY',
  executedQty,
  origQty: '0.09',
  price: `${FILL_PRICE}`,
  cummulativeQuoteQty: `${+executedQty * FILL_PRICE}`,
  orderId: '1',
  clientOrderId: 'D-BO-entryFillCloseFloor',
  fills:
    executedQty === '0'
      ? []
      : [
          {
            price: `${FILL_PRICE}`,
            qty: executedQty,
            commission: `${+executedQty * 0.001}`,
            commissionAsset: 'XYZ',
          },
        ],
  updateTime,
})

const closeOrder = (qty: string, updateTime: number): any => ({
  dealId: DEAL_ID,
  typeOrder: 'dealTP',
  status: 'FILLED',
  side: 'SELL',
  executedQty: qty,
  origQty: qty,
  price: '61.26',
  cummulativeQuoteQty: `${+qty * 61.26}`,
  orderId: '2',
  clientOrderId: 'D-TP-entryFillCloseFloor',
  updateTime,
})

const run = async (deal: any, orders: any[]) => {
  const bot: any = buildBot(deal, orders, PAIR, FILL_PRICE, true, FEE)
  bot.data.exchange = ExchangeEnum.binance
  const tps = (await bot.getTPOrder(
    PAIR.pair,
    FILL_PRICE,
    [],
    FILL_PRICE,
    FILL_PRICE,
    DEAL_ID,
    deal,
  )) as { qty: number; price: number }[]
  return { tps, bot }
}

describe('getTPOrder at base-order fill (spec 224)', () => {
  before(function () {
    this.timeout(180000)
    Helper = loadModule('../dcaHelper').default(FakeBase as any)
  })

  it('§4.1 arms the close when deal.size has not caught up with the fill', async () => {
    const now = Date.now()
    const { tps, bot } = await run(
      dealAt(0, now, { currentBalances: { base: 0, quote: 106.75 } }),
      [baseOrder('0.09000000', now)],
    )
    expect(bot.reported, 'nothing to report').to.deep.equal([])
    expect(tps.map((t) => ({ qty: t.qty, price: t.price }))).to.deep.equal([
      { qty: 0.08, price: 62.5 },
    ])
  })

  it('§2.3/§4.4 the same close once deal.size has caught up (unchanged)', async () => {
    const now = Date.now()
    const { tps } = await run(dealAt(0.08999999999999996, now), [
      baseOrder('0.09000000', now),
    ])
    expect(tps.map((t) => ({ qty: t.qty, price: t.price }))).to.deep.equal([
      { qty: 0.08, price: 62.5 },
    ])
  })

  it('§4.2/§4.3 an entry that has executed nothing still reads as a transition', async () => {
    const now = Date.now()
    const { tps, bot } = await run(
      dealAt(0, now, { currentBalances: { base: 0, quote: 106.75 } }),
      [baseOrder('0', now)],
    )
    expect(tps).to.deep.equal([])
    expect(bot.reported).to.deep.equal([])
  })

  it('§4.3 a deal its close already exited keeps the settle window', async () => {
    const now = Date.now()
    const { tps, bot } = await run(
      dealAt(0, now, { currentBalances: { base: 0, quote: 106.75 } }),
      [baseOrder('0.09000000', now), closeOrder('0.09', now)],
    )
    expect(tps).to.deep.equal([])
    expect(bot.reported).to.deep.equal([])
    expect(bot.debugs.join('\n')).to.include('(deal orders just changed)')
  })
})
